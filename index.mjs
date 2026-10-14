// natbag-user – חשבונות משתמשים (מאחורי API Gateway עם JWT Authorizer של Cognito)
//
// API Gateway כבר אימת את הטוקן (חתימה, תוקף, issuer, client) לפני שהבקשה מגיעה לכאן –
// הפונקציה רק קוראת את ה-claims. שום נתיב כאן לא נגיש בלי התחברות.
//
//   GET    /me                    → פרופיל, הגדרות, התרעות וטיסות במעקב (נוצר בכניסה הראשונה)
//   PUT    /me/settings           → { radius, deviation, source }
//   PUT    /me/alerts             → { anomaly: off|unusual|major, flights: bool }
//   PUT    /me/flights/{num}      → הוספת טיסה למעקב (עד 10)
//   DELETE /me/flights/{num}      → הסרה
//   DELETE /me                    → מחיקת כל המידע של המשתמש (הזכות להישכח)
//   GET    /admin/users           → רק לקבוצת admin ב-Cognito
//
// הנתונים בטבלה natbag-watch, ברשומות pk = user#<sub>. ההרשאות של הפונקציה מוגבלות לרשומות האלה בלבד
// (מלבד Scan של המנהל, שגם הוא מסנן ל-user#).

import { BadRequest, normFlight, validateSettings, validateAlerts, groupsOf, mergeDoc, adminRow, MAX_FLIGHTS } from "./users.mjs";

const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
const log = (msg, extra = {}) => console.log(JSON.stringify({ msg, ...extra }));

export function createHandler(db, now = () => Date.now()) {
  async function load(sub, email) {
    const item = await db.get(`user#${sub}`);
    if (item) {
      // עדכון "נראה לאחרונה" פעם בשעה לכל היותר – בלי לכתוב בכל בקשה
      if (!item.lastSeen || now() - item.lastSeen > 3600e3 || (email && email !== item.email)) {
        item.lastSeen = now(); if (email) item.email = email;
        await db.put(item);
      }
      return item;
    }
    const fresh = { pk: `user#${sub}`, email: email || "", created: now(), lastSeen: now(), doc: mergeDoc() };
    await db.put(fresh, { onlyIfNew: true });
    log("משתמש חדש");
    return fresh;
  }

  const view = (item, groups) => ({ email: item.email, admin: groups.includes("admin"), created: item.created, ...mergeDoc(item.doc), maxFlights: MAX_FLIGHTS });

  return async (event) => {
    const claims = event?.requestContext?.authorizer?.jwt?.claims;
    if (!claims?.sub) return json(401, { error: "לא מחובר" });     // לא אמור לקרות – ה-Authorizer חוסם קודם
    const sub = String(claims.sub), email = claims.email ? String(claims.email) : "", groups = groupsOf(claims);
    const route = event.routeKey || "";
    let body = null;
    try {
      if (event.body) body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body);
    } catch { return json(400, { error: "JSON לא תקין" }); }

    try {
      if (route === "GET /admin/users") {
        if (!groups.includes("admin")) return json(403, { error: "רק למנהל" });
        const items = await db.scanUsers();
        const users = items.map(adminRow).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
        return json(200, { count: users.length, trackedFlights: users.reduce((s, u) => s + u.flights, 0), users });
      }

      const item = await load(sub, email);
      const doc = mergeDoc(item.doc);
      const save = async () => { item.doc = doc; await db.put(item); return json(200, view(item, groups)); };

      switch (route) {
        case "GET /me": return json(200, view(item, groups));
        case "PUT /me/settings": doc.settings = validateSettings(body); return save();
        case "PUT /me/alerts": doc.alerts = validateAlerts(body); return save();
        case "PUT /me/flights/{num}": {
          const f = normFlight(event.pathParameters?.num);
          if (!doc.flights.includes(f)) {
            if (doc.flights.length >= MAX_FLIGHTS) throw new BadRequest(`אפשר לעקוב אחרי עד ${MAX_FLIGHTS} טיסות`);
            doc.flights.push(f);
          }
          return save();
        }
        case "DELETE /me/flights/{num}": {
          const f = normFlight(event.pathParameters?.num);
          doc.flights = doc.flights.filter(x => x !== f);
          return save();
        }
        case "DELETE /me":
          await db.del(`user#${sub}`);
          log("משתמש מחק את המידע שלו");
          return json(200, { deleted: true });
        default:
          return json(404, { error: "לא נמצא" });
      }
    } catch (e) {
      if (e instanceof BadRequest) return json(400, { error: e.message });
      console.error(JSON.stringify({ level: "error", route, details: [String(e?.message || e)] }));
      return json(500, { error: "שגיאה בשרת" });
    }
  };
}

// ---------- DynamoDB (רק ברשומות user#) ----------
function dynamo(table) {
  let ddb, cmds;
  const client = async () => {
    if (!ddb) {
      const m = await import("@aws-sdk/client-dynamodb");
      ddb = new m.DynamoDBClient({}); cmds = m;
    }
    return ddb;
  };
  const toItem = (it) => ({
    pk: { S: it.pk }, email: { S: it.email || "" }, created: { N: String(it.created || 0) },
    lastSeen: { N: String(it.lastSeen || 0) }, doc: { S: JSON.stringify(it.doc || {}) },
  });
  const fromItem = (r) => r && ({
    pk: r.pk.S, email: r.email?.S || "", created: Number(r.created?.N || 0), lastSeen: Number(r.lastSeen?.N || 0),
    doc: (() => { try { return JSON.parse(r.doc?.S || "{}"); } catch { return {}; } })(),
  });
  return {
    async get(pk) {
      const c = await client();
      const out = await c.send(new cmds.GetItemCommand({ TableName: table, Key: { pk: { S: pk } }, ConsistentRead: true }));
      return fromItem(out.Item);
    },
    async put(it, { onlyIfNew = false } = {}) {
      const c = await client();
      try {
        await c.send(new cmds.PutItemCommand({ TableName: table, Item: toItem(it), ...(onlyIfNew ? { ConditionExpression: "attribute_not_exists(pk)" } : {}) }));
      } catch (e) { if (!(onlyIfNew && e.name === "ConditionalCheckFailedException")) throw e; }
    },
    async del(pk) {
      const c = await client();
      await c.send(new cmds.DeleteItemCommand({ TableName: table, Key: { pk: { S: pk } } }));
    },
    async scanUsers() {
      const c = await client();
      const items = [];
      let start;
      do {
        const out = await c.send(new cmds.ScanCommand({
          TableName: table, FilterExpression: "begins_with(pk, :p)", ExpressionAttributeValues: { ":p": { S: "user#" } },
          ProjectionExpression: "pk, email, created, lastSeen, doc", ExclusiveStartKey: start,
        }));
        items.push(...(out.Items || []).map(fromItem));
        start = out.LastEvaluatedKey;
      } while (start && items.length < 5000);
      return items;
    },
  };
}

export const handler = createHandler(dynamo(process.env.TABLE || "natbag-watch"));
