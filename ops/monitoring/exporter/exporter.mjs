// natbag-exporter – הופך את נתוני מוניטור נתב"ג למדדים של Prometheus.
// בלי תלויות חיצוניות: Node 22 בלבד. אותו סיווג נחיתה/המראה בדיוק כמו בקו הטלפוני (planesNear מ-flights.mjs).
//
//   GET /metrics  → מדדים בפורמט Prometheus
//   GET /healthz  → ok
//
// משתני סביבה:
//   PROXY_URL      כתובת שרת הביניים ב-AWS (חובה)
//   PORT           ברירת מחדל 9877
//   CACHE_SECONDS  כמה זמן לשמור תשובה (ברירת מחדל 30), כדי לא להעמיס על השרת
//   FLIGHTS_MODULE הנתיב ל-flights.mjs (בקונטיינר: /app/flights.mjs)
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const flightsPath = process.env.FLIGHTS_MODULE || path.join(here, "../../../natbag-aws/src/proxy/flights.mjs");
const { planesNear } = await import(pathToFileURL(flightsPath).href);

const PROXY = String(process.env.PROXY_URL || "").replace(/\/+$/, "");
const PORT = Number(process.env.PORT || 9877);
const CACHE_MS = Number(process.env.CACHE_SECONDS || 30) * 1000;
const TLV = { lat: 32.0055, lon: 34.8854 };

// ---------- כתיבת פורמט Prometheus ----------
export function render(metrics) {
  const out = [];
  for (const m of metrics) {
    out.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} ${m.type || "gauge"}`);
    for (const s of m.samples) {
      if (s.value == null || Number.isNaN(s.value)) continue;
      const labels = Object.entries(s.labels || {}).map(([k, v]) => `${k}="${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`);
      out.push(`${m.name}${labels.length ? `{${labels.join(",")}}` : ""} ${Number(s.value)}`);
    }
  }
  return out.join("\n") + "\n";
}
const g = (name, help, value, labels) => ({ name, help, samples: [{ value, labels }] });

// ---------- מדדי תנועה מ-/aircraft ----------
export function aircraftMetrics(data) {
  const ac = Array.isArray(data?.ac) ? data.ac : [];
  const planes = planesNear(ac);
  const byMove = { arr: 0, dep: 0, other: 0 };
  for (const p of planes) byMove[p.move || "other"]++;
  const kinds = {};
  for (const a of ac) {
    if (a.alt_baro === "ground") continue;
    const k = a.category === "A7" ? "helicopter" : (a.category === "A1" || a.category === "A2") ? "light" : (a.dbFlags & 1) ? "military" : "airliner";
    kinds[k] = (kinds[k] || 0) + 1;
  }
  const onGround = ac.filter(a => a.alt_baro === "ground").length;
  return [
    { name: "natbag_aircraft", help: "כלי טיס באוויר בטווח 100 ק\"מ מנתב\"ג, לפי מה שהרדאר זיהה שהם עושים", samples:
      Object.entries(byMove).map(([move, value]) => ({ labels: { move }, value })) },
    { name: "natbag_aircraft_by_kind", help: "כלי טיס באוויר בתחום הנתונים, לפי סוג", samples:
      ["airliner", "light", "helicopter", "military"].map(kind => ({ labels: { kind }, value: kinds[kind] || 0 })) },
    g("natbag_aircraft_on_ground", "מטוסים על הקרקע בנתב\"ג ובסביבה", onGround),
    g("natbag_data_source_info", "איזה מקור ADS-B ענה (1 = המקור הנוכחי)", 1, { source: data?._source || "unknown" }),
  ];
}

// ---------- מדדי היום ומצב המערכת מ-/stats ----------
export function statsMetrics(s, now = Date.now()) {
  const t = s?.today, st = s?.status || {};
  const out = [];
  if (t) out.push(
    g("natbag_landings_today", "נחיתות היום (נאסף כל דקה בשרת)", t.landings),
    g("natbag_departures_today", "המראות היום", t.departures),
    g("natbag_deviation_alerts_today", "התרעות סטייה היום", t.alerts),
    g("natbag_max_airborne_today", "שיא מטוסי נוסעים באוויר היום", t.maxAirborne),
    { name: "natbag_anomaly_seconds_today", help: "כמה זמן היום הייתה חריגה בתנועה האווירית", samples: [
      { labels: { level: "unusual" }, value: (t.anomalyMinutes?.unusual ?? 0) * 60 },
      { labels: { level: "major" }, value: (t.anomalyMinutes?.major ?? 0) * 60 }] },
  );
  out.push(
    g("natbag_uptime_30d_percent", "זמינות ב-30 הימים האחרונים, לפי בדיקת הזמינות ב-AWS", st.uptime30),
    g("natbag_uptime_today_percent", "זמינות היום", st.uptimeToday),
    g("natbag_healthcheck_latency_avg_seconds", "זמן תגובה ממוצע היום של בדיקת הזמינות", st.avgLatencyToday == null ? null : st.avgLatencyToday / 1000),
    g("natbag_last_healthcheck_age_seconds", "כמה זמן עבר מבדיקת הזמינות האחרונה", st.lastCheck ? Math.max(0, (now - st.lastCheck.t) / 1000) : null),
    g("natbag_last_healthcheck_passed", "האם בדיקת הזמינות האחרונה עברה (1/0)", st.lastCheck ? (st.lastCheck.pass ? 1 : 0) : null),
  );
  // קו הטלפון (ימות המשיח)
  const ph = s?.phone?.today;
  if (ph) out.push(
    g("natbag_phone_calls_today", "שיחות לקו הטלפון היום", ph.calls),
    g("natbag_phone_callers_today", "מתקשרים שונים היום", ph.callers),
    g("natbag_phone_requests_today", "פניות לשרת מהקו היום (כל הקשה בתפריט)", ph.requests),
    { name: "natbag_phone_ext_calls_today", help: "שיחות שהגיעו לכל שלוחה היום", samples:
      Object.entries(ph.byExt || {}).map(([ext, v]) => ({ labels: { ext }, value: v })) },
  );
  return out;
}

// ---------- משיכה עם מטמון קצר ----------
const cache = new Map();
const counters = { requests: {}, errors: {} };
async function fetchJson(endpoint) {
  const hit = cache.get(endpoint);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit;
  counters.requests[endpoint] = (counters.requests[endpoint] || 0) + 1;
  const t0 = performance.now();
  try {
    const r = await fetch(`${PROXY}${endpoint}`, { headers: { "User-Agent": "natbag-exporter/1.0" }, signal: AbortSignal.timeout(10000) });
    const v = { t: Date.now(), ok: r.ok, status: r.status, ms: performance.now() - t0, data: r.ok ? await r.json() : null };
    if (!r.ok) counters.errors[endpoint] = (counters.errors[endpoint] || 0) + 1;
    cache.set(endpoint, v);
    return v;
  } catch (e) {
    counters.errors[endpoint] = (counters.errors[endpoint] || 0) + 1;
    const v = { t: Date.now(), ok: false, status: 0, ms: performance.now() - t0, data: null };
    cache.set(endpoint, v);
    return v;
  }
}

export async function collect() {
  const eps = { aircraft: `/aircraft?lat=${TLV.lat}&lon=${TLV.lon}&dist=54`, stats: "/stats" };
  const [a, s] = await Promise.all([fetchJson(eps.aircraft), fetchJson(eps.stats)]);
  const metrics = [
    { name: "natbag_api_up", help: "האם נקודת הקצה בשרת ב-AWS ענתה (1/0)", samples: [
      { labels: { endpoint: "aircraft" }, value: a.ok ? 1 : 0 }, { labels: { endpoint: "stats" }, value: s.ok ? 1 : 0 }] },
    { name: "natbag_api_response_seconds", help: "זמן התגובה של השרת ב-AWS", samples: [
      { labels: { endpoint: "aircraft" }, value: a.ms / 1000 }, { labels: { endpoint: "stats" }, value: s.ms / 1000 }] },
    { name: "natbag_exporter_requests_total", type: "counter", help: "כמה פעמים ה-exporter פנה לשרת", samples:
      Object.entries(counters.requests).map(([e, v]) => ({ labels: { endpoint: e.split("?")[0].slice(1) }, value: v })) },
    { name: "natbag_exporter_errors_total", type: "counter", help: "כמה פניות לשרת נכשלו", samples:
      Object.entries(counters.errors).map(([e, v]) => ({ labels: { endpoint: e.split("?")[0].slice(1) }, value: v })) },
  ];
  if (a.ok) metrics.push(...aircraftMetrics(a.data));
  if (s.ok) metrics.push(...statsMetrics(s.data));
  return render(metrics);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (!PROXY) { console.error("חסר PROXY_URL"); process.exit(1); }
  http.createServer(async (req, res) => {
    if (req.url === "/healthz") { res.writeHead(200).end("ok\n"); return; }
    if (req.url !== "/metrics") { res.writeHead(404).end("not found\n"); return; }
    try { res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" }).end(await collect()); }
    catch (e) { res.writeHead(500).end(`error: ${e.message}\n`); }
  }).listen(PORT, () => console.log(`natbag-exporter על פורט ${PORT}, מול ${PROXY}`));
}
