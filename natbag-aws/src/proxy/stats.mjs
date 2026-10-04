// stats.mjs – סיכום הסטטיסטיקה היומית ומצב המערכת לדף stats.html
// הנתונים נאספים ב-DynamoDB:
//   stats#YYYY-MM-DD  – natbag-watcher (כל דקה): נחיתות, המראות, התרעות, מטוסים באוויר, חריגות
//   health#YYYY-MM-DD – natbag-healthcheck (כל 5 דקות): בדיקות זמינות, כשלונות, זמני תגובה
// כאן רק מחשבים – בלי רשת – כדי שאפשר יהיה לבדוק (tests/stats.test.mjs).

import { AIRLINE_NAME_BY_ICAO } from "./flights.mjs";

// "YYYY-MM-DD" של היום ו-n ימים אחורה, לפי שעון ישראל
export function israelDates(now, n) {
  const today = new Date(now).toLocaleString("sv-SE", { timeZone: "Asia/Jerusalem" }).slice(0, 10);
  const base = Date.parse(today + "T12:00:00Z");
  return Array.from({ length: n }, (_, i) => new Date(base - (n - 1 - i) * 864e5).toISOString().slice(0, 10));
}

// רשומת DynamoDB (מ-BatchGetItem) → אובייקט פשוט
export function fromDynamo(item) {
  if (!item) return null;
  if (item.data?.S) return JSON.parse(item.data.S);
  const o = {};
  for (const [k, v] of Object.entries(item)) {
    if (v.N != null) o[k] = Number(v.N);
    else if (v.S != null) o[k] = k === "lastCheck" ? JSON.parse(v.S) : v.S;
  }
  return o;
}

const byHour = (recs) => {
  const h = Array(24).fill(0);
  for (const r of Object.values(recs || {})) if (r && r[0] >= 0 && r[0] < 24) h[r[0]]++;
  return h;
};
const pct = (ok, all) => (all ? Math.round((ok / all) * 10000) / 100 : null);

/**
 * statsByDate: { "2026-10-01": dayObj|null, ... }   healthByDate: { date: healthObj|null }
 * מחזיר את מה שהדף מציג.
 */
export function summarizeStats({ statsByDate, healthByDate, now, statsDays = 7, healthDays = 30 }) {
  const sDates = israelDates(now, statsDays), hDates = israelDates(now, healthDays);
  const todayDate = sDates[sDates.length - 1];
  const t = statsByDate[todayDate] || null;

  let today = null;
  if (t) {
    const landingsByHour = byHour(t.landings), departuresByHour = byHour(t.departures);
    const total = landingsByHour.map((v, i) => v + departuresByHour[i]);
    const busiest = total.reduce((b, v, i) => (v > total[b] ? i : b), 0);
    const counts = {};
    for (const r of [...Object.values(t.landings || {}), ...Object.values(t.departures || {})]) if (r[1]) counts[r[1]] = (counts[r[1]] || 0) + 1;
    const topAirlines = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([code, count]) => ({ code, name: AIRLINE_NAME_BY_ICAO[code] || code, count }));
    today = {
      date: todayDate,
      landings: landingsByHour.reduce((a, b) => a + b, 0),
      departures: departuresByHour.reduce((a, b) => a + b, 0),
      alerts: Object.keys(t.alerts || {}).length,
      busiestHour: total[busiest] ? busiest : null,
      landingsByHour, departuresByHour,
      airborneAvgByHour: (t.air || []).map(a => (a && a.n ? Math.round((a.s / a.n) * 10) / 10 : null)),
      maxAirborne: Math.max(0, ...(t.air || []).map(a => (a ? a.m : 0))),
      topAirlines,
      anomalyMinutes: { unusual: t.levelMin?.unusual || 0, major: t.levelMin?.major || 0 },
      events: (t.events || []).slice(-10),
    };
  }

  const week = sDates.map(d => {
    const x = statsByDate[d];
    return x ? { date: d, landings: Object.keys(x.landings || {}).length, departures: Object.keys(x.departures || {}).length,
                 alerts: Object.keys(x.alerts || {}).length, anomalyMinutes: (x.levelMin?.unusual || 0) + (x.levelMin?.major || 0) }
             : { date: d, landings: null, departures: null, alerts: null, anomalyMinutes: null };
  });

  // ממוצע נחיתות לפי שעה בימים הקודמים (בלי היום) – להשוואה בגרף
  const prev = sDates.slice(0, -1).map(d => statsByDate[d]).filter(Boolean);
  const avgLandingsByHour = prev.length
    ? Array.from({ length: 24 }, (_, h) => Math.round((prev.reduce((s, x) => s + byHour(x.landings)[h], 0) / prev.length) * 10) / 10)
    : null;

  // מצב המערכת
  const days = hDates.map(d => {
    const h = healthByDate[d];
    return h && h.checks ? { date: d, uptime: pct(h.checks - (h.failed || 0), h.checks), checks: h.checks } : { date: d, uptime: null, checks: 0 };
  });
  const all = hDates.map(d => healthByDate[d]).filter(h => h && h.checks);
  const checks = all.reduce((s, h) => s + h.checks, 0), failed = all.reduce((s, h) => s + (h.failed || 0), 0);
  const th = healthByDate[hDates[hDates.length - 1]];
  const last = [...hDates].reverse().map(d => healthByDate[d]?.lastCheck).find(Boolean) || null;
  const status = {
    uptime30: pct(checks - failed, checks),
    uptimeToday: th && th.checks ? pct(th.checks - (th.failed || 0), th.checks) : null,
    checks30: checks,
    avgLatencyToday: th && th.checks ? Math.round(th.latSum / th.checks) : null,
    lastCheck: last,
    // תקין = הבדיקה האחרונה עברה ולא עברו יותר מ-15 דקות מאז
    state: !last ? "unknown" : (now - last.t > 15 * 60e3) ? "stale" : last.pass ? "ok" : "down",
    days,
  };

  return { generated: now, today, week, avgLandingsByHour, status };
}
