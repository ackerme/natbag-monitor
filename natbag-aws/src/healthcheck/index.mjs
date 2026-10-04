// natbag-healthcheck — בדיקת זמינות כל 5 דקות (Synthetic check)
// בודק את המערכת מבחוץ, כמו משתמש: הכתובת הציבורית של השרת, נתוני מטוסים, והאתר ב-GitHub Pages.
// התוצאה נשלחת כמדד ל-CloudWatch (Embedded Metric Format), ו-Alarm שולח מייל אם שתי בדיקות ברצף נכשלו.

const TIMEOUT_MS = 8000;

export function buildChecks(proxyUrl, siteUrl) {
  const base = String(proxyUrl || "").replace(/\/?$/, "/");
  const checks = [
    { name: "health", url: `${base}health`, ok: (r, body) => r.ok && JSON.parse(body).ok === true },
    { name: "aircraft", url: `${base}aircraft?lat=32.0055&lon=34.8854&dist=43`, ok: (r, body) => r.ok && Array.isArray(JSON.parse(body).ac),
      info: body => ({ source: JSON.parse(body)._source || null }) },
  ];
  if (siteUrl) checks.push({ name: "site", url: siteUrl, ok: (r, body) => r.ok && body.includes("נתב") });
  return checks;
}

export async function runChecks(checks, fetchImpl = fetch) {
  return Promise.all(checks.map(async (c) => {
    const t0 = Date.now();
    try {
      const r = await fetchImpl(c.url, { headers: { "User-Agent": "natbag-healthcheck/1.0" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const body = await r.text();
      const pass = !!c.ok(r, body);
      let info = {};
      try { info = (pass && c.info) ? c.info(body) : {}; } catch { info = {}; }
      return { name: c.name, pass, status: r.status, ms: Date.now() - t0, ...info };
    } catch (e) {
      return { name: c.name, pass: false, error: e.message, ms: Date.now() - t0 };
    }
  }));
}

// שורת EMF אחת: HealthCheckFailed (0/1) ו-HealthCheckLatency (הבדיקה האיטית ביותר)
export function metricLine(results, now = Date.now()) {
  const failed = results.some(r => !r.pass) ? 1 : 0;
  return {
    _aws: { Timestamp: now, CloudWatchMetrics: [{ Namespace: "Natbag", Dimensions: [[]],
      Metrics: [{ Name: "HealthCheckFailed", Unit: "Count" }, { Name: "HealthCheckLatency", Unit: "Milliseconds" }] }] },
    HealthCheckFailed: failed,
    HealthCheckLatency: Math.max(0, ...results.map(r => r.ms || 0)),
    results,
  };
}

// מונים יומיים לדף "מצב המערכת" (health#YYYY-MM-DD): כמה בדיקות, כמה נכשלו, זמנים, ופירוט לפי שעה
export function healthUpdate(table, results, now = Date.now()) {
  const s = new Date(now).toLocaleString("sv-SE", { timeZone: "Asia/Jerusalem" });
  const date = s.slice(0, 10), hh = s.slice(11, 13);
  const failed = results.some(r => !r.pass) ? 1 : 0;
  const ms = Math.max(0, ...results.map(r => r.ms || 0));
  const last = { t: now, pass: !failed, ms, source: results.find(r => r.source)?.source || null,
                 failedChecks: results.filter(r => !r.pass).map(r => r.name) };
  return {
    TableName: table,
    Key: { pk: { S: `health#${date}` } },
    UpdateExpression: "ADD checks :one, failed :f, latSum :ms, #hc :one, #hf :f SET lastCheck = :last",
    ExpressionAttributeNames: { "#hc": `c${hh}`, "#hf": `f${hh}` },
    ExpressionAttributeValues: { ":one": { N: "1" }, ":f": { N: String(failed) }, ":ms": { N: String(ms) }, ":last": { S: JSON.stringify(last) } },
  };
}

export const handler = async () => {
  const results = await runChecks(buildChecks(process.env.PROXY_URL, process.env.SITE_URL));
  const line = metricLine(results);
  process.stdout.write(JSON.stringify(line) + "\n");   // ישר ל-stdout, כדי ש-CloudWatch יזהה את שורת המדד
  if (process.env.TABLE) {
    try {
      const { DynamoDBClient, UpdateItemCommand } = await import("@aws-sdk/client-dynamodb");
      await new DynamoDBClient({}).send(new UpdateItemCommand(healthUpdate(process.env.TABLE, results)));
    } catch (e) { console.error(JSON.stringify({ level: "error", route: "healthcheck-store", details: [e.message] })); }
  }
  return { failed: line.HealthCheckFailed, results };
};
