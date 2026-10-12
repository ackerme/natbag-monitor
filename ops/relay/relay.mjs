// relay.mjs – ממסר שמע: מושך את שידור LiveATC של נתב"ג ומשדר אותו מחדש בכתובת קבועה,
// כדי שימות המשיח (שלוחה 5) תוכל להתחבר. משמש בהרשאת LiveATC.net.
//
//   GET /llbg.mp3  → השידור (audio/mpeg), לכמה מאזינים במקביל
//   GET /healthz   → מצב הממסר (JSON)
//   GET /metrics   → מדדים ל-Prometheus
//
// חיבור אחד בלבד ל-LiveATC (כמו מאזין אחד), גם כשיש הרבה מאזינים. ALWAYS_ON=false: מתחברים רק כשיש מאזין.
// עוקב אחרי הפניות (d.liveatc.net → s1-xxx.liveatc.net), כך שהחלפת שרת אצלם לא שוברת את הקו.

import http from "node:http";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const UA = "natbag-monitor-relay/1.0 (+https://ackerme.github.io/natbag-monitor/)";

export function createRelay({
  upstream,
  mount = "/llbg.mp3",
  idleMs = 30_000,          // כמה זמן להמשיך למשוך אחרי שהמאזין האחרון ניתק
  stallMs = 30_000,         // אם לא הגיע מידע זמן כזה – מתחברים מחדש
  retryMs = 5_000,
  maxClients = 50,
  maxBufferBytes = 1_000_000, // מאזין איטי שנתקע מאחור – מנתקים אותו, כדי לא לצבור זיכרון
  burstBytes = 32_000,       // כמה שניות אחרונות (~8 שניות ב-32kbps) שנשלחות מיד למאזין חדש – כדי שלא יחכה בשקט
  alwaysOn = false,          // true = מחובר לשידור תמיד, כך שמאזין חדש (וגם בדיקת הקישור של ימות המשיח) מקבל שמע מיד
  log = (msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra })),
} = {}) {
  if (!upstream) throw new Error("חסר UPSTREAM_URL");
  const clients = new Set();
  const stats = { bytes: 0, connects: 0, errors: 0, listenersTotal: 0, connected: false, lastDataAt: 0, upstreamUrl: null };
  let pulling = null;   // { abort }
  let idleTimer = null;
  let burst = [], burstLen = 0;   // השניות האחרונות של השידור

  function remember(chunk) {
    burst.push(chunk); burstLen += chunk.length;
    while (burst.length > 1 && burstLen - burst[0].length >= burstBytes) burstLen -= burst.shift().length;
  }

  function broadcast(chunk) {
    for (const res of clients) {
      if (res.writableLength > maxBufferBytes) { res.destroy(); clients.delete(res); continue; }
      res.write(chunk);
    }
  }

  async function pullLoop(signal) {
    while (!signal.aborted) {
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      let stallTimer;
      try {
        stats.connects++;
        const r = await fetch(upstream, { redirect: "follow", headers: { "User-Agent": UA, "Icy-MetaData": "0" }, signal: ctrl.signal });
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
        stats.connected = true;
        stats.upstreamUrl = r.url;
        log("מחובר לשידור", { url: r.url });
        const resetStall = () => { clearTimeout(stallTimer); stallTimer = setTimeout(() => ctrl.abort(), stallMs); };
        resetStall();
        for await (const chunk of r.body) {
          resetStall();
          stats.bytes += chunk.length;
          stats.lastDataAt = Date.now();
          remember(chunk);
          broadcast(chunk);
        }
        throw new Error("השידור נסגר");
      } catch (e) {
        if (signal.aborted) break;
        stats.errors++;
        log("השידור נפל – מתחברים שוב", { error: String(e?.message || e) });
      } finally {
        clearTimeout(stallTimer);
        signal.removeEventListener("abort", onAbort);
        stats.connected = false;
        burst = []; burstLen = 0;     // לא שולחים שמע ישן אחרי ניתוק
      }
      await new Promise(res => { const t = setTimeout(res, retryMs); signal.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true }); });
    }
  }

  function ensurePulling() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (pulling) return;
    const ctrl = new AbortController();
    pulling = ctrl;
    pullLoop(ctrl.signal).finally(() => { if (pulling === ctrl) pulling = null; });
  }

  function maybeStop() {
    if (alwaysOn || clients.size || idleTimer || !pulling) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (clients.size || !pulling) return;
      log("אין מאזינים – מתנתקים מהשידור");
      pulling.abort();
      pulling = null;
    }, idleMs);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, listeners: clients.size, upstream: stats.connected, upstreamUrl: stats.upstreamUrl, bytes: stats.bytes }));
      return;
    }
    if (url.pathname === "/metrics") {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end([
        "# HELP atc_relay_listeners מאזינים מחוברים כרגע", "# TYPE atc_relay_listeners gauge", `atc_relay_listeners ${clients.size}`,
        "# HELP atc_relay_upstream_connected האם מחובר לשידור (1/0)", "# TYPE atc_relay_upstream_connected gauge", `atc_relay_upstream_connected ${stats.connected ? 1 : 0}`,
        "# HELP atc_relay_bytes_total בייטים שהתקבלו מהשידור", "# TYPE atc_relay_bytes_total counter", `atc_relay_bytes_total ${stats.bytes}`,
        "# HELP atc_relay_listeners_total מאזינים שהתחברו מאז ההפעלה", "# TYPE atc_relay_listeners_total counter", `atc_relay_listeners_total ${stats.listenersTotal}`,
        "# HELP atc_relay_upstream_errors_total ניתוקים מהשידור", "# TYPE atc_relay_upstream_errors_total counter", `atc_relay_upstream_errors_total ${stats.errors}`,
        "",
      ].join("\n"));
      return;
    }
    if (url.pathname !== mount) { res.writeHead(404).end("not found\n"); return; }
    if (req.method === "HEAD") { res.writeHead(200, { "Content-Type": "audio/mpeg" }).end(); return; }
    if (clients.size >= maxClients) { res.writeHead(503).end("too many listeners\n"); return; }

    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-cache, no-store",
      "Connection": "close",
      "icy-name": "LLBG Gnd/Twr/App - audio courtesy of LiveATC.net",
    });
    res.socket?.setNoDelay(true);
    for (const c of burst) res.write(c);   // השניות האחרונות – מיד
    clients.add(res);
    stats.listenersTotal++;
    ensurePulling();
    const done = () => { clients.delete(res); maybeStop(); };
    req.on("close", done);
    res.on("error", done);
  });

  server.on("close", () => { clearTimeout(idleTimer); pulling?.abort(); pulling = null; });
  if (alwaysOn) server.on("listening", ensurePulling);
  return { server, stats, clients };
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const { server } = createRelay({
    upstream: process.env.UPSTREAM_URL || "http://d.liveatc.net/llbg2",
    mount: process.env.MOUNT || "/llbg.mp3",
    alwaysOn: process.env.ALWAYS_ON !== "false",
  });
  const port = Number(process.env.PORT || 8000);
  server.listen(port, () => console.log(`atc-relay על פורט ${port}`));
  // עצירה מסודרת: מנתקים מאזינים (חיבור שמע לא נגמר לבד) ויוצאים
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
