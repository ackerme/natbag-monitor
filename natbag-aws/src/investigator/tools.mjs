// tools.mjs – הכלים שהסוכן יכול להפעיל. כולם לקריאה בלבד.
// כל כלי מחזיר טקסט קצר ודחוס (טוקנים עולים כסף), לא את הנתונים הגולמיים.

const TLV = { lat: 32.0055, lon: 34.8854 };
const R = 6371;
const rad = d => (d * Math.PI) / 180;
export function haversine(lat1, lon1, lat2, lon2) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export const ilTime = t => new Date(t).toLocaleTimeString("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit" });
const minutesArg = m => Math.min(360, Math.max(5, Number.isFinite(+m) && +m > 0 ? Math.round(+m) : 90));

/**
 * שורות יומן של natbag-watcher → טווחים: "03:35–04:21 unusual ציון 2 ×47 | סיבות".
 * דקות שגרה רצופות מקובצות גם הן, כדי שהמודל יראה מתי החריגה התחילה ונגמרה.
 */
export function summarizeWatcher(events) {
  const rows = [];
  for (const e of events) {
    let j; try { j = JSON.parse(e.message); } catch { continue; }
    if (j.level == null) continue;
    const em = (j.emergency || []).map(x => `${x.cs || x.id} ${x.code || ""}`.trim()).join(", ");
    const key = `${j.level}|${j.AirspaceScore}|${(j.reasons || []).join(" ; ")}|${em}`;
    const t = e.timestamp ?? j._aws?.Timestamp;
    const last = rows[rows.length - 1];
    if (last && last.key === key) { last.to = t; last.n++; continue; }
    rows.push({ key, from: t, to: t, n: 1, level: j.level, raw: j.rawLevel, score: j.AirspaceScore, reasons: j.reasons || [], em,
                alert: j.call?.sent || j.emergencyAlert?.sent });
  }
  if (!rows.length) return "אין רשומות ביומן בטווח הזה.";
  return rows.slice(-40).map(r =>
    `${ilTime(r.from)}${r.n > 1 ? `–${ilTime(r.to)} ×${r.n}` : ""} ${r.level} ציון ${r.score ?? "?"}` +
    `${r.raw && r.raw !== r.level ? ` (גולמי ${r.raw})` : ""}${r.reasons.length ? ` | ${r.reasons.join(" ; ")}` : ""}` +
    `${r.em ? ` | חירום: ${r.em}` : ""}${r.alert ? " | נשלחה התרעה" : ""}`).join("\n");
}

export function summarizeErrors(events) {
  const groups = new Map();
  for (const e of events) {
    let j; try { j = JSON.parse(e.message); } catch { continue; }
    if (j.level !== "error") continue;
    const k = `${j.route}|${(j.details || []).join(" ; ").slice(0, 160)}`;
    const g = groups.get(k) || { route: j.route, details: (j.details || []).join(" ; ").slice(0, 160), n: 0, first: e.timestamp, last: e.timestamp };
    g.n++; g.last = e.timestamp; groups.set(k, g);
  }
  if (!groups.size) return "אין שגיאות בשרת הביניים בטווח הזה.";
  return [...groups.values()].sort((a, b) => b.n - a.n).slice(0, 15)
    .map(g => `${g.route} ×${g.n} (${ilTime(g.first)}–${ilTime(g.last)}): ${g.details}`).join("\n");
}

/** רשימת ADS-B → שורה לכל מטוס, הקרובים קודם */
export function summarizeAircraft(ac, id) {
  const want = String(id || "").trim().toLowerCase();
  const list = (ac || []).filter(a => a && a.lat != null && a.lon != null).map(a => ({
    cs: String(a.flight || "").trim(), hex: String(a.hex || "").toLowerCase(), t: a.t || "",
    dist: Math.round(haversine(TLV.lat, TLV.lon, a.lat, a.lon)),
    alt: a.alt_baro === "ground" ? "קרקע" : a.alt_baro != null ? `${Math.round(a.alt_baro * 0.3048)}מ'` : "?",
    rate: a.baro_rate ?? a.geom_rate, gs: a.gs, track: a.track, sq: a.squawk, em: a.emergency && a.emergency !== "none" ? a.emergency : "",
  })).filter(p => !want || p.cs.toLowerCase() === want || p.hex === want)
    .sort((a, b) => a.dist - b.dist);
  if (!list.length) return want ? `לא נמצא מטוס ${id} ברדיוס 100 ק"מ כרגע.` : "אין מטוסים בנתונים כרגע.";
  const fmt = p => `${p.cs || p.hex} ${p.t} ${p.dist}ק"מ ${p.alt}` +
    `${p.rate != null ? ` ${p.rate > 0 ? "+" : ""}${Math.round(p.rate * 0.3048 / 60 * 10) / 10}מ'/ש'` : ""}` +
    `${p.gs != null ? ` ${Math.round(p.gs * 1.852)}קמ"ש` : ""}${p.track != null ? ` כיוון ${Math.round(p.track)}°` : ""}` +
    `${p.sq ? ` squawk ${p.sq}` : ""}${p.em ? ` emergency=${p.em}` : ""}`;
  return `${list.length} מטוסים (${ilTime(Date.now())}):\n` + list.slice(0, 35).map(fmt).join("\n");
}

/**
 * deps: { fetch, filterLogs(group, startMs, pattern) → events[], alarmsInAlarm() → names[], proxyUrl, now }
 */
export function makeTools(deps) {
  const proxy = String(deps.proxyUrl || "").replace(/\/?$/, "/");
  const get = async path => {
    const t0 = Date.now();
    const r = await deps.fetch(proxy + path, { headers: { "User-Agent": "natbag-investigator/1.0" }, signal: AbortSignal.timeout(9000) });
    const ms = Date.now() - t0;
    if (!r.ok) throw new Error(`${path.split("?")[0]} HTTP ${r.status} (${ms}ms)`);
    return { j: await r.json(), ms, source: r.headers?.get?.("x-source") || "" };
  };
  const since = m => (deps.now ?? Date.now()) - minutesArg(m) * 60e3;

  return {
    async watcher_log({ minutes }) {
      return summarizeWatcher(await deps.filterLogs("/aws/lambda/natbag-watcher", since(minutes), '{ $.AirspaceScore >= 0 }'));
    },
    async proxy_errors({ minutes }) {
      return summarizeErrors(await deps.filterLogs("/aws/lambda/natbag-proxy", since(minutes), '{ $.level = "error" }'));
    },
    async aircraft_now({ id }) {
      const { j } = await get(`aircraft?lat=${TLV.lat}&lon=${TLV.lon}&dist=54`);
      return summarizeAircraft(j.ac, id);
    },
    async today_stats() {
      const { j } = await get("stats");
      const t = j.today;
      if (!t) return "אין עדיין סטטיסטיקה להיום.";
      return JSON.stringify({ date: t.date, landings: t.landings, departures: t.departures, alerts: t.alerts,
        anomalyMinutes: t.anomalyMinutes, maxAirborne: t.maxAirborne, airborneAvgByHour: t.airborneAvgByHour,
        landingsByHour: t.landingsByHour, avgLandingsByHour: j.avgLandingsByHour, events: t.events,
        uptimeToday: j.status?.uptimeToday, healthState: j.status?.state });
    },
    async system_health() {
      const out = [];
      try { const a = await get(`aircraft?lat=${TLV.lat}&lon=${TLV.lon}&dist=54`);
            out.push(`ADS-B: עונה, ${a.ms}ms, מקור ${a.source || a.j._source || "?"}, ${(a.j.ac || []).length} מטוסים`); }
      catch (e) { out.push(`ADS-B: נכשל – ${e.message}`); }
      try { const s = await get("stats"); out.push(`בדיקת זמינות: ${s.j.status?.state ?? "?"}, היום ${s.j.status?.uptimeToday ?? "?"}%`); }
      catch (e) { out.push(`סטטיסטיקה: נכשל – ${e.message}`); }
      try { const al = await deps.alarmsInAlarm(); out.push(`CloudWatch Alarms במצב ALARM: ${al.length ? al.join(", ") : "אין"}`); }
      catch (e) { out.push(`Alarms: לא נקרא – ${e.message}`); }
      return out.join("\n");
    },
  };
}
