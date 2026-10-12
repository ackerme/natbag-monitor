// בדיקות לממסר השמע (ops/relay). בלי רשת: "LiveATC" מדומה על המחשב.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelay } from '../ops/relay/relay.mjs';

const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// שידור מדומה: /redirect מפנה ל-/stream, שמשדר חתיכה כל 20ms
function fakeUpstream() {
  const state = { connections: 0, open: 0 };
  const srv = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/stream' }).end(); return; }
    state.connections++; state.open++;
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    const t = setInterval(() => res.write(Buffer.from('MP3DATA')), 20);
    req.on('close', () => { clearInterval(t); state.open--; });
  });
  return { srv, state };
}

function readSome(port, path, bytes) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, res => {
      let got = Buffer.alloc(0);
      res.on('data', c => { got = Buffer.concat([got, c]); if (got.length >= bytes) { req.destroy(); resolve({ status: res.statusCode, type: res.headers['content-type'], got }); } });
    });
    req.on('error', e => { if (e.code !== 'ECONNRESET') reject(e); });
  });
}

test('ממסר: עוקב אחרי הפניה, מאזינים רבים על חיבור אחד, מתנתק כשאין מאזינים', async () => {
  const up = fakeUpstream();
  const upPort = await listen(up.srv);
  const { server, stats } = createRelay({ upstream: `http://127.0.0.1:${upPort}/redirect`, idleMs: 100, retryMs: 50, log: () => {} });
  const port = await listen(server);
  try {
    const [a, b] = await Promise.all([readSome(port, '/llbg.mp3', 21), readSome(port, '/llbg.mp3', 21)]);
    assert.equal(a.status, 200);
    assert.equal(a.type, 'audio/mpeg');
    assert.match(a.got.toString(), /MP3DATA/);
    assert.match(b.got.toString(), /MP3DATA/);
    assert.equal(up.state.connections, 1);                 // חיבור אחד ל-LiveATC בשביל שני המאזינים
    assert.match(stats.upstreamUrl, /\/stream$/);           // אחרי ההפניה
    await sleep(300);
    assert.equal(up.state.open, 0);                         // אין מאזינים → התנתק מהשידור

    const h = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    assert.equal(h.listeners, 0);
    const m = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    assert.match(m, /atc_relay_listeners_total 2/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404);
  } finally {
    server.close(); up.srv.close(); up.srv.closeAllConnections();
  }
});

test('ממסר: כשהשידור נופל – מתחבר מחדש', async () => {
  let n = 0;
  const up = http.createServer((req, res) => {
    n++;
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    res.write(Buffer.from(`PART${n}`));
    if (n === 1) res.end();                                   // החיבור הראשון נסגר מיד
    else { const t = setInterval(() => res.write(Buffer.from(`PART${n}`)), 20); req.on('close', () => clearInterval(t)); }
  });
  const upPort = await listen(up);
  const { server, stats } = createRelay({ upstream: `http://127.0.0.1:${upPort}/`, idleMs: 50, retryMs: 30, log: () => {} });
  const port = await listen(server);
  try {
    const r = await readSome(port, '/llbg.mp3', 20);
    assert.match(r.got.toString(), /PART2/);
    assert.ok(stats.errors >= 1);
  } finally {
    server.close(); up.close(); up.closeAllConnections();
  }
});

test('ממסר: alwaysOn – מחובר לפני שיש מאזין, ומאזין חדש מקבל מיד את השניות האחרונות', async () => {
  const up = fakeUpstream();
  const upPort = await listen(up.srv);
  const { server, stats } = createRelay({ upstream: `http://127.0.0.1:${upPort}/stream`, alwaysOn: true, burstBytes: 70, idleMs: 50, log: () => {} });
  const port = await listen(server);
  try {
    await sleep(250);
    assert.equal(up.state.open, 1);                       // מחובר בלי מאזינים
    assert.ok(stats.bytes >= 70);
    const t0 = Date.now();
    const r = await readSome(port, '/llbg.mp3', 70);       // מגיע מיד מהזיכרון, בלי לחכות לשידור
    assert.ok(Date.now() - t0 < 15, `burst took ${Date.now() - t0}ms`);
    assert.match(r.got.toString(), /^(MP3DATA)+/);
    await sleep(150);
    assert.equal(up.state.open, 1);                       // נשאר מחובר גם אחרי שהמאזין יצא
  } finally {
    server.close(); up.srv.close(); up.srv.closeAllConnections();
  }
});
