// natbag-atc – קולות הקשר של נתב"ג לשלוחה 5 בימות המשיח (באישור LiveATC.net)
//
// רץ רק כשמישהו מתקשר: ימות המשיח פונה לכתובת → Lambda מתעוררת, מתחברת לשידור של LiveATC
// ומזרימה אותו (Response Streaming) עד שהשיחה נגמרת או עד MAX_MS (Lambda מוגבלת ל-15 דקות).
// אין שרת שרץ כל הזמן, ובתוך ה-Free Tier של Lambda זה בחינם.
//
//   GET  <url>/<ATC_KEY>.mp3         → audio/mpeg   (הכתובת לימות המשיח – בלי סימנים מיוחדים)
//   GET  <url>/llbg.mp3?token=<IVR_TOKEN> → אותו דבר
//   ATC_KEY = 24 התווים הראשונים של sha256("atc:" + IVR_TOKEN) – רק אותיות ומספרים, נגזר מסיסמת הקו

import { createHash } from "node:crypto";

const UA = "natbag-monitor-atc/1.0 (+https://ackerme.github.io/natbag-monitor/)";

// פריים MP3 שקט (MPEG-1 Layer III, 32kbps, 44.1kHz, מונו – 104 בתים, 26ms).
// נשלח מיד עם החיבור ובזמן ההמתנה ל-LiveATC, כדי שימות המשיח תקבל שמע תוך אלפיות שנייה.
export const SILENT_FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x10, 0xc0]), Buffer.alloc(100)]);
const FRAME_MS = 26;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function atcKey(token) {
  return createHash("sha256").update(`atc:${token}`).digest("hex").slice(0, 24);
}

export function authorized(query, token, path = "") {
  if (!token) return true;
  if (query && query.token === token) return true;
  const key = atcKey(token);
  return (!!query && query.key === key) || path === `/${key}.mp3`;
}

/**
 * מזרים את השידור אל out (Writable) עד שהמאזין מתנתק או עד maxMs.
 * אם השידור של LiveATC נופל באמצע – מתחבר מחדש.
 */
export async function pump({ out, upstream, maxMs, fetchImpl = fetch, retryMs = 2000, stallMs = 15_000, prefill = true, log = () => {} }) {
  const ctrl = new AbortController();      // כל השיחה
  let closed = false;
  const stop = () => { closed = true; ctrl.abort(); };
  out.on?.("close", stop);
  out.on?.("error", stop);
  const timer = setTimeout(() => ctrl.abort(), maxMs);
  let bytes = 0, connects = 0;
  try {
    while (!closed && !ctrl.signal.aborted) {
      // ניסיון חיבור אחד: אם LiveATC לא עונה או לא שולח מידע stallMs – מוותרים ומנסים שוב
      const attempt = new AbortController();
      const onAbort = () => attempt.abort();
      ctrl.signal.addEventListener("abort", onAbort, { once: true });
      let stall = setTimeout(() => attempt.abort(), stallMs);
      // עד שמגיע שמע אמיתי – שקט, כדי שהקו לא יחשוב שאין שידור
      let filler = null;
      if (prefill) {
        if (connects === 0) for (let i = 0; i < 20; i++) out.write(SILENT_FRAME);   // ~half a second מיד
        filler = setInterval(() => { if (!closed) out.write(SILENT_FRAME); }, FRAME_MS);
      }
      const stopFiller = () => { if (filler) { clearInterval(filler); filler = null; } };
      try {
        connects++;
        const r = await fetchImpl(upstream, { redirect: "follow", headers: { "User-Agent": UA }, signal: attempt.signal });
        log("תשובה מ-LiveATC", { status: r.status, url: r.url, type: r.headers?.get?.("content-type") });
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
        let first = true;
        for await (const chunk of r.body) {
          if (closed) break;
          clearTimeout(stall); stall = setTimeout(() => attempt.abort(), stallMs);
          if (first) { stopFiller(); log("מתחיל להזרים"); first = false; }
          bytes += chunk.length;
          out.write(chunk);
        }
        if (!closed && !ctrl.signal.aborted) throw new Error("השידור נסגר");
      } catch (e) {
        if (closed || ctrl.signal.aborted) break;
        log("השידור נפל – מתחברים שוב", { error: attempt.signal.aborted ? `אין מידע ${stallMs / 1000} שניות` : String(e?.message || e) });
        await sleep(retryMs);
      } finally {
        stopFiller();
        clearTimeout(stall);
        ctrl.signal.removeEventListener("abort", onAbort);
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
  const path = event?.rawPath || "/";
  const query = event?.queryStringParameters || {};
  const ok = authorized(query, process.env.IVR_TOKEN || "", path);
  const http = event?.requestContext?.http || {};
  log("בקשה", { method, path: ok ? "(מורשה)" : path.slice(0, 12), token: query.token || query.key ? "יש" : "אין", authorized: ok,
                ip: http.sourceIp, ua: String(http.userAgent || "").slice(0, 80) });
  try {
    if (!ok) {
      const s = awslambda.HttpResponseStream.from(responseStream, { statusCode: 403, headers: { "Content-Type": "text/plain" } });
      s.write("forbidden");
      s.end();
      return;
    }
    const s = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-cache, no-store" },
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
  } catch (e) {
    // שגיאות בפונקציית streaming לא תמיד נרשמות לבד – רושמים בעצמנו
    console.error(JSON.stringify({ msg: "שגיאה", error: String(e?.stack || e) }));
    throw e;
  }
}

// awslambda קיים רק בסביבת Lambda (לא בבדיקות)
if (process.env.AWS_LAMBDA_FUNCTION_NAME) log("init", { streaming: typeof awslambda !== "undefined" });
export const handler = typeof awslambda !== "undefined" ? awslambda.streamifyResponse(main) : main;
