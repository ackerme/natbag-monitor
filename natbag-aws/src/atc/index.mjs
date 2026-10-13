// natbag-atc – קולות הקשר של נתב"ג לשלוחה 5 בימות המשיח (באישור LiveATC.net)
//
// רץ רק כשמישהו מתקשר: ימות המשיח פונה לכתובת → Lambda מתעוררת, מתחברת לשידור של LiveATC
// ומזרימה אותו (Response Streaming) עד שהשיחה נגמרת או עד MAX_MS (Lambda מוגבלת ל-15 דקות).
// אין שרת שרץ כל הזמן, ובתוך ה-Free Tier של Lambda זה בחינם.
//
//   GET  <url>?token=<IVR_TOKEN>   → audio/mpeg
//   HEAD <url>?token=<IVR_TOKEN>   → 200 בלי גוף (לבדיקת הקישור)

const UA = "natbag-monitor-atc/1.0 (+https://ackerme.github.io/natbag-monitor/)";
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function authorized(query, token) {
  return !token || (!!query && query.token === token);
}

/**
 * מזרים את השידור אל out (Writable) עד שהמאזין מתנתק או עד maxMs.
 * אם השידור של LiveATC נופל באמצע – מתחבר מחדש.
 */
export async function pump({ out, upstream, maxMs, fetchImpl = fetch, retryMs = 2000, log = () => {} }) {
  const ctrl = new AbortController();
  let closed = false;
  const stop = () => { closed = true; ctrl.abort(); };
  out.on?.("close", stop);
  out.on?.("error", stop);
  const timer = setTimeout(() => ctrl.abort(), maxMs);
  let bytes = 0, connects = 0;
  try {
    while (!closed && !ctrl.signal.aborted) {
      try {
        connects++;
        const r = await fetchImpl(upstream, { redirect: "follow", headers: { "User-Agent": UA }, signal: ctrl.signal });
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
        for await (const chunk of r.body) {
          if (closed) break;
          bytes += chunk.length;
          out.write(chunk);
        }
        if (!closed && !ctrl.signal.aborted) throw new Error("השידור נסגר");
      } catch (e) {
        if (closed || ctrl.signal.aborted) break;
        log("השידור נפל – מתחברים שוב", { error: String(e?.message || e) });
        await sleep(retryMs);
      }
    }
  } finally {
    clearTimeout(timer);
    if (!closed) out.end();
  }
  return { bytes, connects };
}

const log = (msg, extra = {}) => console.log(JSON.stringify({ msg, ...extra }));

async function main(event, responseStream) {
  const method = event?.requestContext?.http?.method || "GET";
  const query = event?.queryStringParameters || {};
  if (!authorized(query, process.env.IVR_TOKEN || "")) {
    const s = awslambda.HttpResponseStream.from(responseStream, { statusCode: 403, headers: { "Content-Type": "text/plain" } });
    s.end("forbidden");
    return;
  }
  const s = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-cache, no-store",
      "icy-name": "LLBG Gnd/Twr/App - audio courtesy of LiveATC.net",
    },
  });
  if (method === "HEAD") { s.end(); return; }
  const t0 = Date.now();
  const res = await pump({
    out: s,
    upstream: process.env.UPSTREAM_URL || "http://d.liveatc.net/llbg2",
    maxMs: Number(process.env.MAX_MS || 14 * 60_000),
    log,
  });
  log("שיחה הסתיימה", { seconds: Math.round((Date.now() - t0) / 1000), ...res });
}

// awslambda קיים רק בסביבת Lambda (לא בבדיקות)
export const handler = typeof awslambda !== "undefined" ? awslambda.streamifyResponse(main) : main;
