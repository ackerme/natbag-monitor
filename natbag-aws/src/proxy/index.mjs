// natbag-proxy — AWS Lambda (Function URL)
// שרת ביניים בשביל מוניטור נתב"ג:
//   • פונה רק לאתרי הטיסות שברשימה (לא שרת ביניים פתוח)
//   • עובר אוטומטית למקור הבא אם אחד נופל
//   • שומר תשובה במטמון 10 שניות ודוחס אותה ב-gzip (פחות תעבורה = פחות עלות)
//   • מפתח OpenSky נקרא מ-SSM Parameter Store, לא מהקוד
//
// נתיבים:
//   GET /health
//   GET /aircraft?lat=32.0055&lon=34.8854&dist=43   (dist במייל ימי, עד 250)
//   GET /opensky?lat=32.0055&lon=34.8854&dist=43
//   GET /mil                                         → מטוסים צבאיים באזור (מזרח הים התיכון–עיראק)
//   GET /stats                                       → סטטיסטיקה יומית ומצב המערכת (לדף stats.html)
//   GET /tracked                                     → הטיסות הכי נעקבות ב-Flightradar24 (לא רשמי)
//   GET /flight?num=580                            → מידע על טיסה (JSON, לבדיקה)
//   GET|POST /ivr                                    → קו טלפוני דרך "ימות המשיח"

import { gzipSync } from "node:zlib";
import { summarizeStats, israelDates, fromDynamo, ivrUsage } from "./stats.mjs";
import { parseBoardRecord, findFlights, callsignCandidates, flightAnswer, handleIvr, israelNowMs, routeIndex } from "./flights.mjs";

const UA = "natbag-monitor/1.0";
const CACHE_MS = 10_000;
const UPSTREAM_TIMEOUT_MS = 7_000;
const SSM_PREFIX = process.env.SSM_PREFIX || "/natbag/opensky";

const ADSB_SOURCES = [
  { name: "adsb.lol",       url: (lat, lon, nm) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${nm}` },
  { name: "airplanes.live", url: (lat, lon, nm) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}` },
  { name: "adsb.fi",        url: (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}` },
];

// מטמון בזיכרון: נשמר כל עוד אותו מופע של Lambda "חם"
const cache = new Map();

function respond(status, body, event, extraHeaders = {}) {
  const text = JSON.stringify(body);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": `max-age=${CACHE_MS / 1000}`,
    ...extraHeaders,
  };
  const acceptEnc = (event?.headers?.["accept-encoding"] || "").toLowerCase();
  if (acceptEnc.includes("gzip") && text.length > 512) {
    return {
      statusCode: status,
      headers: { ...headers, "Content-Encoding": "gzip" },
      body: gzipSync(text).toString("base64"),
      isBase64Encoded: true,
    };
  }
  return { statusCode: status, headers, body: text };
}

export function parseArea(q = {}) {
  const lat = parseFloat(q.lat);
  const lon = parseFloat(q.lon);
  const dist = parseInt(q.dist, 10);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { error: "lat לא תקין" };
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return { error: "lon לא תקין" };
  const nm = Math.min(250, Math.max(1, Number.isFinite(dist) ? dist : 43));
  return { lat: lat.toFixed(4), lon: lon.toFixed(4), nm };
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": UA, Accept: "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function cached(key, producer) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;
  const v = await producer();
  cache.set(key, { t: Date.now(), v });
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  return v;
}

// ───────── מדדים ל-CloudWatch (Embedded Metric Format) ─────────
// שורת JSON בלוג שמכילה _aws → CloudWatch הופך אותה למדד, בלי קריאת API ובלי הרשאות נוספות.
// כותבים ישר ל-stdout ולא ב-console.log, כי ב-Lambda ‏console.log מוסיף לשורה תחילית (זמן, requestId) שמונעת את הזיהוי.
// מדדים: SourceUsed{Source} – איזה מקור ADS-B ענה; UpstreamFailure{Route} – מקור חיצוני נכשל.
export function emitMetric(name, dimName, dimValue, value = 1) {
  const ns = process.env.METRICS_NAMESPACE ?? "Natbag";   // ריק (ב-staging) = לא שולחים מדדים
  if (!ns) return;
  process.stdout.write(JSON.stringify({
    _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: ns, Dimensions: [[dimName]], Metrics: [{ Name: name, Unit: "Count" }] }] },
    [dimName]: dimValue, [name]: value,
  }) + "\n");
}
const upstreamFailed = (route, details) => {
  emitMetric("UpstreamFailure", "Route", route);
  console.error(JSON.stringify({ level: "error", route, details }));
};

async function getAircraft(area) {
  const errors = [];
  for (const src of ADSB_SOURCES) {
    try {
      const data = await fetchJson(src.url(area.lat, area.lon, area.nm));
      if (!data || !Array.isArray(data.ac)) throw new Error("תשובה בלי ac");
      data._source = src.name;
      emitMetric("SourceUsed", "Source", src.name);
      return { ok: true, data };
    } catch (e) {
      errors.push(`${src.name}: ${e.message}`);
    }
  }
  upstreamFailed("aircraft", errors);
  return { ok: false, data: { error: "כל מקורות ADS-B נכשלו", details: errors } };
}

// ---- OpenSky: פרטי ההתחברות נשמרים ב-SSM Parameter Store (SecureString) ----
let osCreds;            // undefined = עוד לא נבדק, null = אין מפתח
let osCredsAt = 0;      // מתי נבדק לאחרונה – בודקים שוב כל 5 דקות אם אין מפתח
let osToken = null, osTokenExp = 0;

async function loadOpenSkyCreds() {
  if (osCreds && osCreds !== undefined) return osCreds;
  if (osCreds === null && Date.now() - osCredsAt < 300_000) return null;
  osCredsAt = Date.now();
  try {
    const { SSMClient, GetParametersCommand } = await import("@aws-sdk/client-ssm");
    const ssm = new SSMClient({});
    const out = await ssm.send(new GetParametersCommand({
      Names: [`${SSM_PREFIX}/client_id`, `${SSM_PREFIX}/client_secret`],
      WithDecryption: true,
    }));
    const byName = Object.fromEntries((out.Parameters || []).map(p => [p.Name.split("/").pop(), p.Value]));
    osCreds = byName.client_id && byName.client_secret ? byName : null;
  } catch (e) {
    console.warn("SSM read failed:", e.message);
    osCreds = null;
  }
  return osCreds;
}

async function getOpenSkyToken() {
  const creds = await loadOpenSkyCreds();
  if (!creds) return null;
  if (osToken && Date.now() < osTokenExp) return osToken;
  const res = await fetch(
    "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: creds.client_id,
        client_secret: creds.client_secret,
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    }
  );
  if (!res.ok) throw new Error(`token HTTP ${res.status}`);
  const j = await res.json();
  osToken = j.access_token;
  osTokenExp = Date.now() + ((j.expires_in || 1800) - 60) * 1000;
  return osToken;
}

async function getOpenSky(area) {
  const deg = (area.nm * 1.852) / 111;
  const lat = +area.lat, lon = +area.lon;
  const url = `https://opensky-network.org/api/states/all?lamin=${(lat - deg).toFixed(4)}&lamax=${(lat + deg).toFixed(4)}&lomin=${(lon - deg).toFixed(4)}&lomax=${(lon + deg).toFixed(4)}`;
  try {
    const tok = await getOpenSkyToken();
    const data = await fetchJson(url, tok ? { headers: { Authorization: `Bearer ${tok}` } } : {});
    data._source = tok ? "OpenSky (עם מפתח)" : "OpenSky (בלי מפתח)";
    return { ok: true, data };
  } catch (e) {
    return { ok: false, data: { error: "OpenSky נכשל", details: [e.message] } };
  }
}

// ───────── מטוסים צבאיים באזור ─────────
// adsb.lol מחזיר את כל המטוסים הצבאיים בעולם; משאירים רק את האזור שלנו ורק את השדות שהדף צריך
export const REGION = { latMin: 26, latMax: 40, lonMin: 24, lonMax: 50 };
const MIL_FIELDS = ["hex", "flight", "r", "t", "desc", "dbFlags", "category", "lat", "lon", "alt_baro", "gs", "track"];
async function getMil() {
  const errors = [];
  for (const [name, url] of [["adsb.lol", "https://api.adsb.lol/v2/mil"], ["airplanes.live", "https://api.airplanes.live/v2/mil"]]) {
    try {
      const data = await fetchJson(url);
      if (!Array.isArray(data?.ac)) throw new Error("תשובה בלי ac");
      const ac = data.ac
        .filter(a => a.lat >= REGION.latMin && a.lat <= REGION.latMax && a.lon >= REGION.lonMin && a.lon <= REGION.lonMax)
        .map(a => Object.fromEntries(MIL_FIELDS.filter(k => a[k] != null).map(k => [k, a[k]])));
      return { ok: true, data: { ac, _source: name, region: REGION } };
    } catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  upstreamFailed("mil", errors);
  return { ok: false, data: { error: "מקורות המטוסים הצבאיים לא זמינים", details: errors } };
}

// ───────── הטיסות הכי נעקבות ב-Flightradar24 ─────────
// מקור לא רשמי (אותה כתובת שהאתר שלהם משתמש בה) – לשימוש לימודי בלבד.
// נמשך לכל היותר פעם ב-2 דקות; אם נכשל – לא מנסים שוב 5 דקות, כדי לא להעמיס.
const TRACKED_URL = "https://www.flightradar24.com/flights/most-tracked";
const TRACKED_OK_MS = 120_000, TRACKED_FAIL_MS = 300_000;
let trackedCache = { t: 0, ok: false, v: null };
export function parseTracked(j) {
  if (!j || !Array.isArray(j.data)) throw new Error("תשובה בלי data");
  return j.data.map(o => ({
    id: o.flight_id || null, flight: o.flight || "", callsign: o.callsign || "",
    clicks: Number(o.clicks) || 0, squawk: o.squawk || "",
    from: o.from_iata || "", fromCity: o.from_city || "", to: o.to_iata || "", toCity: o.to_city || "",
    model: o.model || "", type: o.type || "", onGround: !!o.on_ground,
  }));
}
async function getTracked() {
  const age = Date.now() - trackedCache.t;
  if (trackedCache.t && age < (trackedCache.ok ? TRACKED_OK_MS : TRACKED_FAIL_MS)) return trackedCache.v;
  let v;
  try {
    const res = await fetch(TRACKED_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
                 Accept: "application/json", Referer: "https://www.flightradar24.com/" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    v = { ok: true, data: { flights: parseTracked(await res.json()), _source: "flightradar24", updated: new Date().toISOString() } };
  } catch (e) {
    upstreamFailed("tracked", [e.message]);
    v = { ok: false, data: { error: "Flightradar24 לא זמין", details: [e.message], flights: [] } };
  }
  trackedCache = { t: Date.now(), ok: v.ok, v };
  return v;
}

// ───────── סטטיסטיקה ומצב המערכת (לדף stats.html) ─────────
// קריאה אחת (BatchGetItem) של 7 ימי סטטיסטיקה + 30 ימי זמינות מטבלת natbag-watch. מטמון של דקה.
const STATS_TABLE = process.env.STATS_TABLE || "";
let statsCache = { t: 0, v: null };
async function getStats() {
  if (!STATS_TABLE) return { ok: false, data: { error: "אין טבלת סטטיסטיקה בסביבה הזו" } };
  if (statsCache.v && Date.now() - statsCache.t < 60_000) return statsCache.v;
  const now = Date.now();
  const sDates = israelDates(now, 7), hDates = israelDates(now, 30);
  const keys = [...sDates.map(d => `stats#${d}`), ...hDates.map(d => `health#${d}`), ...sDates.map(d => `ivr#${d}`)];
  const { DynamoDBClient, BatchGetItemCommand } = await import("@aws-sdk/client-dynamodb");
  const ddb = new DynamoDBClient({});
  const items = {};
  let req = { [STATS_TABLE]: { Keys: keys.map(k => ({ pk: { S: k } })) } };
  for (let i = 0; i < 3 && req && Object.keys(req).length; i++) {      // UnprocessedKeys – עד 3 ניסיונות
    const out = await ddb.send(new BatchGetItemCommand({ RequestItems: req }));
    for (const it of out.Responses?.[STATS_TABLE] || []) items[it.pk.S] = fromDynamo(it);
    req = out.UnprocessedKeys;
  }
  const statsByDate = Object.fromEntries(sDates.map(d => [d, items[`stats#${d}`] || null]));
  const healthByDate = Object.fromEntries(hDates.map(d => [d, items[`health#${d}`] || null]));
  const ivrByDate = Object.fromEntries(sDates.map(d => [d, items[`ivr#${d}`] || null]));
  const v = { ok: true, data: summarizeStats({ statsByDate, healthByDate, ivrByDate, now }) };
  statsCache = { t: Date.now(), v };
  return v;
}

// ───────── לוח הטיסות של רשות שדות התעופה (data.gov.il) ─────────
const IAA_RESOURCE_ID = process.env.IAA_RESOURCE_ID || "e83f763b-b7d7-479e-b172-ae981ddc6de5";
const BOARD_CACHE_MS = 120_000;
let boardCache = { t: 0, v: null };
export async function getBoard() {
  if (boardCache.v && Date.now() - boardCache.t < BOARD_CACHE_MS) return boardCache.v;
  const url = `https://data.gov.il/api/3/action/datastore_search?resource_id=${IAA_RESOURCE_ID}&limit=2000`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (natbag-monitor)", Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`data.gov.il HTTP ${res.status}`);
    const j = await res.json();
    const records = j?.result?.records;
    if (!Array.isArray(records)) throw new Error("data.gov.il: תשובה בלי records");
    boardCache = { t: Date.now(), v: records.map(parseBoardRecord) };
    return boardCache.v;
  } catch (e) {
    upstreamFailed("board", [e.message]);
    throw e;
  }
}

// מיקום חי לפי callsign – כל האפשרויות במקביל, כדי לענות מהר בטלפון
export async function getLive(f) {
  const cands = callsignCandidates(f);
  if (!cands.length) return null;
  const tryOne = async (url) => {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(3500) });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j.ac) && j.ac.length ? j.ac[0] : null;
  };
  const results = await Promise.allSettled([
    ...cands.map(cs => tryOne(`https://api.adsb.lol/v2/callsign/${cs}`)),
    ...cands.map(cs => tryOne(`https://api.airplanes.live/v2/callsign/${cs}`)),
  ]);
  return results.map(r => (r.status === "fulfilled" ? r.value : null)).find(Boolean) || null;
}

// כלי הטיס ברדיוס ~100 ק"מ (54 מייל ימי) מנתב"ג – בשביל שלוחת "המטוסים סביב נמל התעופה"
async function getNear() {
  // קודם 54 מייל ימי (100 ק"מ); אם נכשל – אותה שאילתה שהאתר משתמש בה (43 מייל ימי, ~80 ק"מ)
  const errors = [];
  for (const nm of [54, 43]) {
    const area = { lat: "32.0055", lon: "34.8854", nm };
    const key = `/aircraft|${area.lat}|${area.lon}|${area.nm}`;
    const r = await cached(key, () => getAircraft(area));
    if (r.ok) return r.data.ac;
    cache.delete(key);
    errors.push(...(r.data.details || [r.data.error]));
  }
  throw new Error("ADS-B לא זמין: " + errors.join(" | "));
}

function parseParams(event) {
  const q = { ...(event.queryStringParameters || {}) };
  if (event.body) {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    for (const [k, v] of new URLSearchParams(raw)) q[k] = q[k] != null ? `${q[k]},${v}` : v;
  }
  return q;
}

// סטטיסטיקת הקו: מוסיפים את השיחה לרשומה של היום (ADD לקבוצה לא סופר פעמיים את אותה שיחה)
async function recordIvr(params) {
  const u = STATS_TABLE && ivrUsage(params);
  if (!u) return;
  try {
    const { DynamoDBClient, UpdateItemCommand } = await import("@aws-sdk/client-dynamodb");
    await new DynamoDBClient({}).send(new UpdateItemCommand({
      TableName: STATS_TABLE,
      Key: { pk: { S: `ivr#${u.date}` } },
      UpdateExpression: "ADD calls :c, callers :p, #ext :c, requests :one",
      ExpressionAttributeNames: { "#ext": `ext_${u.ext}` },
      ExpressionAttributeValues: { ":c": { SS: [u.callId] }, ":p": { SS: [u.caller] }, ":one": { N: "1" } },
    }));
  } catch (e) {   // סטטיסטיקה לא מפילה את הקו
    console.error(JSON.stringify({ level: "error", route: "ivr-stats", details: [String(e?.message || e)] }));
  }
}

async function ivrResponse(event) {
  const params = parseParams(event);
  const authorized = !(process.env.IVR_TOKEN && params.token !== process.env.IVR_TOKEN);
  const [text] = await Promise.all([
    authorized
      ? handleIvr(params, { getBoard, getLive, getNear, onError: (where, e) =>
          console.error(JSON.stringify({ level: "error", route: `ivr-${where}`, details: [String(e?.message || e)] })) })
      : "id_list_message=t-גישה לא מורשית&go_to_folder=hangup",
    authorized ? recordIvr(params) : null,
  ]);
  return { statusCode: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, body: text };
}

export const handler = async (event) => {
  const method = event?.requestContext?.http?.method || "GET";
  const path = event?.rawPath || "/";
  if (method === "OPTIONS") return { statusCode: 204, headers: {} };
  if (path === "/ivr" && (method === "GET" || method === "POST")) return ivrResponse(event);
  if (method !== "GET") return respond(405, { error: "רק GET" }, event);

  if (path === "/mil") {
    const result = await cached("/mil", getMil);
    if (!result.ok) cache.delete("/mil");
    return respond(result.ok ? 200 : 502, result.data, event, { "X-Source": result.data._source || "none" });
  }

  if (path === "/stats") {
    try {
      const result = await getStats();
      return respond(result.ok ? 200 : 404, result.data, event, { "Cache-Control": "max-age=60" });
    } catch (e) {
      console.error(JSON.stringify({ level: "error", route: "stats", details: [e.message] }));
      return respond(502, { error: "הסטטיסטיקה לא זמינה כרגע" }, event);
    }
  }

  if (path === "/tracked") {
    const result = await getTracked();
    return respond(result.ok ? 200 : 502, result.data, event, { "Cache-Control": "max-age=60" });
  }

  if (path === "/flight") {
    const num = String((event.queryStringParameters || {}).num || "").replace(/\D/g, "").slice(0, 5);
    if (!num) return respond(400, { error: "חסר num, למשל /flight?num=580" }, event);
    try {
      const nowIl = israelNowMs();
      const matches = findFlights(await getBoard(), num, nowIl);
      const first = matches[0] || null;
      const live = first ? await getLive(first) : null;
      return respond(200, { num, matches, live: live && { callsign: live.flight, lat: live.lat, lon: live.lon, alt_baro: live.alt_baro, gs: live.gs },
                            speech: first ? flightAnswer(first, live, nowIl) : [] }, event, { "Cache-Control": "no-store" });
    } catch (e) {
      return respond(502, { error: "לוח הטיסות לא זמין", details: [e.message] }, event);
    }
  }

  // מאיפה / לאן לכל אות קריאה (לפי לוח הטיסות) – בשביל הרשימה והחלון של כל מטוס באתר
  if (path === "/routes") {
    try {
      return respond(200, { routes: routeIndex(await getBoard(), israelNowMs()) }, event);
    } catch (e) { return respond(502, { error: "לוח הטיסות לא זמין" }, event); }
  }
  if (path === "/health") return respond(200, { ok: true, stage: process.env.STAGE || "prod", time: new Date().toISOString() }, event);

  if (path === "/aircraft" || path === "/opensky") {
    const area = parseArea(event.queryStringParameters || {});
    if (area.error) return respond(400, { error: area.error }, event);
    const key = `${path}|${area.lat}|${area.lon}|${area.nm}`;
    const result = await cached(key, () => (path === "/aircraft" ? getAircraft(area) : getOpenSky(area)));
    if (!result.ok) cache.delete(key);   // לא שומרים שגיאות במטמון
    return respond(result.ok ? 200 : 502, result.data, event, { "X-Source": result.data._source || "none" });
  }
  return respond(404, { error: "לא נמצא", routes: ["/health", "/aircraft", "/opensky", "/mil", "/tracked", "/stats", "/flight", "/routes", "/ivr"] }, event);
};
