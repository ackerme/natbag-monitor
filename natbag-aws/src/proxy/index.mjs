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

import { gzipSync } from "node:zlib";

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

async function getAircraft(area) {
  const errors = [];
  for (const src of ADSB_SOURCES) {
    try {
      const data = await fetchJson(src.url(area.lat, area.lon, area.nm));
      if (!data || !Array.isArray(data.ac)) throw new Error("תשובה בלי ac");
      data._source = src.name;
      return { ok: true, data };
    } catch (e) {
      errors.push(`${src.name}: ${e.message}`);
    }
  }
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

export const handler = async (event) => {
  const method = event?.requestContext?.http?.method || "GET";
  const path = event?.rawPath || "/";
  if (method === "OPTIONS") return { statusCode: 204, headers: {} };
  if (method !== "GET") return respond(405, { error: "רק GET" }, event);

  if (path === "/health") return respond(200, { ok: true, time: new Date().toISOString() }, event);

  if (path === "/aircraft" || path === "/opensky") {
    const area = parseArea(event.queryStringParameters || {});
    if (area.error) return respond(400, { error: area.error }, event);
    const key = `${path}|${area.lat}|${area.lon}|${area.nm}`;
    const result = await cached(key, () => (path === "/aircraft" ? getAircraft(area) : getOpenSky(area)));
    if (!result.ok) cache.delete(key);   // לא שומרים שגיאות במטמון
    return respond(result.ok ? 200 : 502, result.data, event, { "X-Source": result.data._source || "none" });
  }
  return respond(404, { error: "לא נמצא", routes: ["/health", "/aircraft", "/opensky"] }, event);
};
