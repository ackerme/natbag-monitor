// natbag-watcher — זיהוי חריגה בתנועה האווירית בצד השרת, כל דקה, גם כשאף דף לא פתוח.
// משתמש באותה לוגיקה בדיוק כמו הדף (detect.cjs = עותק של detect.js; בדיקה ב-tests מוודאת שהם זהים).
// כשהמדד עובר ל"חריגה משמעותית" – מתקשר לטלפון שהוגדר, דרך ימות המשיח (קמפיין עם הקראה).
// לכל היותר שיחה אחת בחצי שעה. זה מדד לתנועה אווירית בלבד, לא מערכת התרעה ביטחונית.
//
// מצב (היסטוריה, שובלים) נשמר ב-DynamoDB, כי כל הרצה של Lambda מתחילה בלי זיכרון.
// פרטי ימות המשיח נקראים מ-SSM: /natbag/yemot/username, /natbag/yemot/password, /natbag/yemot/phone

import { createRequire } from "node:module";
const D = createRequire(import.meta.url)("./detect.cjs");

export const TLV = { lat: 32.0055, lon: 34.8854 };
const RADIUS_KM = 80, DEV_THRESH = 18, FINAL_KM = 25, FINAL_ALT = 1800;
const TRAIL_MS = 10 * 60e3, HISTORY_MS = 60 * 60e3, APPROACH_MS = 10 * 60e3;
export const CALL_GAP_MS = 30 * 60e3;

export const emptyState = () => ({ history: [], trails: {}, approachSeen: {}, lastDist: {}, planeHist: {}, lastLevel: "normal", lastCallAt: 0 });

/**
 * צעד אחד: רשימת ADS-B → מצב חדש + סטטוס המדד. פונקציה טהורה (בלי רשת), כדי שאפשר לבדוק אותה.
 * זה אותו סדר כמו בדף: recordTrails ואז updateAirspace.
 */
export function step(prev, acList, now) {
  const st = { ...emptyState(), ...prev };
  // planeHist = היסטוריית הסטייה לכל מטוס (כמו בדף), כדי שגם התרעת הסטייה תיספר בסטטיסטיקה
  const ctx = { lat: TLV.lat, lon: TLV.lon, radius: RADIUS_KM, devThresh: DEV_THRESH, finalKm: FINAL_KM, finalAlt: FINAL_ALT, history: st.planeHist };
  const planes = [];
  for (const a of acList || []) {
    const n = D.normalize(a, true); if (!n) continue;
    const c = D.classify(n, ctx); if (c) planes.push(c);
  }

  // שובלים (10 דקות אחרונות)
  for (const p of planes) {
    if (p.onGround) continue;
    const tr = st.trails[p.icao24] || (st.trails[p.icao24] = []);
    const l = tr[tr.length - 1];
    if (!l || l.lat !== p.lat || l.lon !== p.lon) tr.push({ lat: p.lat, lon: p.lon, t: now });
    while (tr.length && now - tr[0].t > TRAIL_MS) tr.shift();
    if (tr.length > 30) tr.shift();
  }
  for (const id of Object.keys(st.trails)) {
    const tr = st.trails[id];
    if (!tr.length || now - tr[tr.length - 1].t > TRAIL_MS) delete st.trails[id];
  }

  // אותו חישוב כמו updateAirspace בדף
  let holding = 0, turnBacks = 0, emergencies = 0;
  for (const p of planes) {
    const isHolding = !p.onGround && D.isHolding(st.trails[p.icao24]);
    if (p.isApproach) st.approachSeen[p.icao24] = now;
    const isTurnBack = D.isTurnBack({
      wasApproaching: st.approachSeen[p.icao24] && now - st.approachSeen[p.icao24] <= APPROACH_MS,
      onGround: p.onGround, isApproach: p.isApproach, dev: p.dev, prevDist: st.lastDist[p.icao24], dist: p.dist });
    st.lastDist[p.icao24] = p.dist;
    if (p.cls !== "passenger") continue;
    if (isHolding) holding++;
    if (isTurnBack) turnBacks++;
    if (p.squawk === "7700" || p.squawk === "7600") emergencies++;
  }
  // ניקוי מטוסים שכבר לא נראו (שלא יגדל לנצח)
  const seen = new Set(planes.map(p => p.icao24));
  for (const m of [st.approachSeen, st.lastDist, st.planeHist]) for (const id of Object.keys(m)) if (!seen.has(id) && !st.trails[id]) delete m[id];

  const pax = planes.filter(p => p.cls === "passenger");
  st.history = [...st.history, { t: now, airborne: pax.filter(p => !p.onGround).length, finals: pax.filter(p => p.isFinal).length, holding, turnBacks, emergencies }]
    .filter(h => now - h.t <= HISTORY_MS);
  const status = D.airspaceStatus(st.history, now);
  return { state: st, status, planes };
}

// ───────── סטטיסטיקה יומית (לדף הסטטיסטיקות) ─────────
// תאריך ושעה לפי שעון ישראל
export function israelParts(now) {
  const s = new Date(now).toLocaleString("sv-SE", { timeZone: "Asia/Jerusalem" });   // "2026-10-01 22:15:00"
  return { date: s.slice(0, 10), hour: parseInt(s.slice(11, 13), 10) };
}
export const emptyDay = date => ({ date, landings: {}, departures: {}, alerts: {},
  air: Array.from({ length: 24 }, () => ({ s: 0, n: 0, m: 0 })), levelMin: { unusual: 0, major: 0 }, events: [], lastLevel: "normal" });
const airlineCode = cs => (/^([A-Z]{3})\d/.exec(String(cs || "").trim().toUpperCase()) || [])[1] || "";

/**
 * מעדכן את הסטטיסטיקה של היום לפי סריקה אחת. כל מטוס נספר פעם אחת ביום:
 *  נחיתה = מטוס נוסעים שזוהה בגישה סופית; המראה = מטוס נוסעים שמטפס עד 25 ק"מ מהשדה.
 */
export function recordStats(prevDay, planes, status, now) {
  const { date, hour } = israelParts(now);
  const day = prevDay && prevDay.date === date ? prevDay : emptyDay(date);
  const pax = planes.filter(p => p.cls === "passenger");
  for (const p of pax) {
    const rec = [hour, airlineCode(p.callsign)];
    if (p.isFinal && !day.landings[p.icao24]) day.landings[p.icao24] = rec;
    if (p.isDeparting && p.dist < 25 && !day.departures[p.icao24]) day.departures[p.icao24] = rec;
    if (p.isAlert && !day.alerts[p.icao24]) day.alerts[p.icao24] = [hour, String(p.callsign || "").trim()];
  }
  const airborne = pax.filter(p => !p.onGround).length, a = day.air[hour];
  a.s += airborne; a.n += 1; a.m = Math.max(a.m, airborne);
  if (status.level !== "normal") day.levelMin[status.level] = (day.levelMin[status.level] || 0) + 1;
  if (status.level !== day.lastLevel) {
    day.events.push({ t: now, level: status.level });
    if (day.events.length > 40) day.events.shift();
    day.lastLevel = status.level;
  }
  return day;
}

// מתקשרים רק במעבר ל"חריגה משמעותית", ולא יותר מפעם בחצי שעה
export function shouldCall(prevLevel, status, lastCallAt, now) {
  return status.level === "major" && prevLevel !== "major" && now - (lastCallAt || 0) >= CALL_GAP_MS;
}

// טקסט להקראה בטלפון. ימות המשיח לא מקבלת חלק מהתווים, אז מנקים אותם
export function sayClean(t) {
  return String(t ?? "").replace(/נתב"ג/g, "נמל התעופה").replace(/[-–]/g, " ").replace(/[."'&|׳״`()~/]/g, " ")
    .replace(/[,=]/g, " ").replace(/\s+/g, " ").trim();
}
export function callText(status) {
  return sayClean(["התרעה מקו מידע הטיסות",
    "זוהתה חריגה משמעותית בתנועה האווירית סביב נמל התעופה בן גוריון",
    ...(status.reasons || []),
    "זו התרעה על תנועה אווירית בלבד ואינה התרעה של פיקוד העורף"].join(" , "));
}

// ───────── ימות המשיח ─────────
const YEMOT = "https://www.call2all.co.il/ym/api/";
export async function yemotCall({ username, password, phone }, text, fetchImpl = fetch) {
  const get = async (method, params) => {
    const r = await fetchImpl(`${YEMOT}${method}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    if (j.responseStatus !== "OK") throw new Error(`${method}: ${j.message || j.responseStatus || r.status}`);
    return j;
  };
  const { token } = await get("Login", { username, password });
  const res = await get("RunCampaign", { token, ttsMode: "1", phones: JSON.stringify({ [phone]: { text } }) });
  return { campaignId: res.campaignId, estimatedPrice: res.estimatedPrice, customerUnits: res.customerUnits };
}

// ───────── AWS ─────────
async function loadJson(table, pk) {
  const { DynamoDBClient, GetItemCommand } = await import("@aws-sdk/client-dynamodb");
  const out = await new DynamoDBClient({}).send(new GetItemCommand({ TableName: table, Key: { pk: { S: pk } } }));
  return out.Item?.data?.S ? JSON.parse(out.Item.data.S) : null;
}
async function saveJson(table, pk, obj) {
  const { DynamoDBClient, PutItemCommand } = await import("@aws-sdk/client-dynamodb");
  await new DynamoDBClient({}).send(new PutItemCommand({ TableName: table, Item: { pk: { S: pk }, data: { S: JSON.stringify(obj) } } }));
}
async function loadYemot() {
  const { SSMClient, GetParametersCommand } = await import("@aws-sdk/client-ssm");
  const out = await new SSMClient({}).send(new GetParametersCommand({
    Names: ["/natbag/yemot/username", "/natbag/yemot/password", "/natbag/yemot/phone"], WithDecryption: true }));
  const v = Object.fromEntries((out.Parameters || []).map(p => [p.Name.split("/").pop(), p.Value]));
  return v.username && v.password && v.phone ? v : null;
}
const log = obj => process.stdout.write(JSON.stringify(obj) + "\n");

export const handler = async (event = {}) => {
  // בדיקה ידנית: aws lambda invoke --function-name natbag-watcher --payload '{"testCall":true}' ...
  if (event.testCall) {
    const creds = await loadYemot();
    if (!creds) return { ok: false, error: "חסרים פרמטרים של ימות המשיח ב-SSM (/natbag/yemot/*)" };
    const res = await yemotCall(creds, sayClean("זו שיחת בדיקה מקו מידע הטיסות של נמל התעופה בן גוריון. ההתרעות הטלפוניות פועלות"));
    log({ level: "info", testCall: true, ...res });
    return { ok: true, ...res };
  }

  const now = Date.now();
  const r = await fetch(`${String(process.env.PROXY_URL).replace(/\/?$/, "/")}aircraft?lat=${TLV.lat}&lon=${TLV.lon}&dist=43`,
    { headers: { "User-Agent": "natbag-watcher/1.0" }, signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error(`aircraft HTTP ${r.status}`);
  const { ac } = await r.json();

  const prev = (await loadJson(process.env.TABLE, "state")) || emptyState();
  const { state, status, planes } = step(prev, ac, now);
  let call = null;
  if (shouldCall(prev.lastLevel, status, prev.lastCallAt, now)) {
    try {
      const creds = await loadYemot();
      if (creds) { call = await yemotCall(creds, callText(status)); state.lastCallAt = now; }
      else call = { skipped: "אין פרטי ימות המשיח ב-SSM" };
    } catch (e) { call = { error: e.message }; }
  }
  state.lastLevel = status.level;
  await saveJson(process.env.TABLE, "state", state);

  // סטטיסטיקה יומית – רשומה לכל יום (stats#YYYY-MM-DD)
  const { date } = israelParts(now);
  const day = recordStats(await loadJson(process.env.TABLE, `stats#${date}`), planes, status, now);
  await saveJson(process.env.TABLE, `stats#${date}`, day);

  // מדד למעקב בלוח הבקרה: ציון המדד (0 = שגרה, 2+ = חריגה, 4+ = משמעותית)
  log({ _aws: { Timestamp: now, CloudWatchMetrics: [{ Namespace: "Natbag", Dimensions: [[]], Metrics: [{ Name: "AirspaceScore", Unit: "Count" }] }] },
        AirspaceScore: status.score, level: status.level, reasons: status.reasons, baselineReady: status.baselineReady, call });
  return { level: status.level, score: status.score, call };
};
