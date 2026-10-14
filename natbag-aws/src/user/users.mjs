// users.mjs – כללים ובדיקות קלט לחשבונות משתמשים (בלי רשת – נבדק ב-tests/user.test.mjs)

export const MAX_FLIGHTS = 10;
export const DEFAULT_DOC = Object.freeze({
  settings: { radius: 80, deviation: 18, source: "auto" },
  alerts: { anomaly: "off", flights: true },
  flights: [],
});

const LEVELS = ["off", "unusual", "major"];
const SOURCES = ["auto", "opensky"];

export class BadRequest extends Error {}

const int = (v, lo, hi, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new BadRequest(`${name}: מספר שלם בין ${lo} ל-${hi}`);
  return n;
};

/** מספר טיסה: "LY001", "ly 1", "580" → קנוני. קוד חברה (2 תווים) + 1–4 ספרות, או 1–5 ספרות בלבד. */
export function normFlight(raw) {
  const s = String(raw ?? "").toUpperCase().replace(/[\s-]/g, "");
  // קוד חברה = 2 תווים שלפחות אחד מהם אות (LY, 6H, W6) – כדי ש-"580" לא ייקרא כ-"58" + "0"
  const m = s.match(/^([A-Z][A-Z0-9]|[0-9][A-Z])?(\d{1,5})$/);
  if (!m || (m[1] && m[2].length > 4)) throw new BadRequest("מספר טיסה לא תקין (למשל LY001 או 580)");
  return (m[1] || "") + String(Number(m[2]));
}

export function validateSettings(b) {
  if (!b || typeof b !== "object") throw new BadRequest("חסר גוף בקשה");
  const source = String(b.source ?? "auto");
  if (!SOURCES.includes(source)) throw new BadRequest("source: auto או opensky");
  return { radius: int(b.radius, 20, 300, "radius"), deviation: int(b.deviation, 5, 60, "deviation"), source };
}

export function validateAlerts(b) {
  if (!b || typeof b !== "object") throw new BadRequest("חסר גוף בקשה");
  const anomaly = String(b.anomaly ?? "off");
  if (!LEVELS.includes(anomaly)) throw new BadRequest("anomaly: off / unusual / major");
  return { anomaly, flights: b.flights !== false };
}

/** קבוצות מה-JWT: ב-HTTP API מערך מגיע כמחרוזת "[admin other]" */
export function groupsOf(claims) {
  const g = claims?.["cognito:groups"];
  if (Array.isArray(g)) return g;
  return String(g ?? "").replace(/^\[|\]$/g, "").split(/[\s,]+/).filter(Boolean);
}

export function mergeDoc(doc) {
  const d = doc || {};
  return {
    settings: { ...DEFAULT_DOC.settings, ...(d.settings || {}) },
    alerts: { ...DEFAULT_DOC.alerts, ...(d.alerts || {}) },
    flights: Array.isArray(d.flights) ? d.flights.slice(0, MAX_FLIGHTS) : [],
  };
}

/** לרשימת המנהל: בלי מזהים פנימיים, ומייל חלקי בלוגים (המלא רק בתשובה למנהל) */
export function adminRow(item) {
  const doc = mergeDoc(item.doc);
  return {
    email: item.email || "",
    created: item.created || null,
    lastSeen: item.lastSeen || null,
    flights: doc.flights.length,
    anomalyAlerts: doc.alerts.anomaly,
  };
}
