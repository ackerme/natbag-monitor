// בדיקות ל-natbag-atc (שלוחה 5, רק כשמתקשרים). בלי רשת: LiveATC מדומה.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pump, authorized, atcKey, siteAllowed, SILENT_FRAME, INTRO, HISS } from '../natbag-aws/src/atc/index.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// "LiveATC": מחזיר זרם שמשדר חתיכה כל 10ms עד שמבטלים
function fakeFetch({ failFirst = false } = {}) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    if (failFirst && calls.length === 1) return { ok: false, status: 503, body: null };
    const body = new ReadableStream({
      start(c) {
        const t = setInterval(() => c.enqueue(new TextEncoder().encode('MP3')), 10);
        opts.signal.addEventListener('abort', () => { clearInterval(t); try { c.error(new Error('aborted')); } catch {} });
      },
    });
    return { ok: true, status: 200, body };
  };
  return { impl, calls };
}

// היציאה של Lambda (Writable מדומה)
function fakeOut() {
  const out = new EventEmitter();
  out.chunks = []; out.ended = false;
  out.write = c => { out.chunks.push(Buffer.from(c)); return true; };
  out.end = () => { out.ended = true; };
  return out;
}

test('authorized: בלי טוקן מוגדר – פתוח; עם טוקן – רק token נכון', () => {
  assert.equal(authorized({}, ''), true);
  assert.equal(authorized({ token: 'x' }, 'x'), true);
  assert.equal(authorized({ token: 'y' }, 'x'), false);
  assert.equal(authorized(null, 'x'), false);
});

test('siteAllowed: /live.mp3 רק מהאתר שלנו (או בלי Referer), ורק בנתיב הזה', () => {
  const O = ['https://ackerme.github.io'];
  assert.equal(siteAllowed('/live.mp3', { referer: 'https://ackerme.github.io/natbag-monitor/monitor.html' }, O), true);
  assert.equal(siteAllowed('/live.mp3', { referer: 'https://ackerme.github.io/' }, O), true);
  assert.equal(siteAllowed('/live.mp3', {}, O), true);                                              // בלי Referer
  assert.equal(siteAllowed('/live.mp3', { referer: 'https://evil.example/page' }, O), false);       // אתר אחר
  assert.equal(siteAllowed('/live.mp3', { referer: 'https://ackerme.github.io.evil.example/' }, O), false);
  assert.equal(siteAllowed('/llbg.mp3', { referer: 'https://ackerme.github.io/' }, O), false);      // נתיב הטלפון – רק עם סיסמה
  assert.equal(siteAllowed('/live.mp3', {}, []), false);                                            // לא מוגדר – סגור
});

test('pump: מזרים עד maxMs, עוקב אחרי הפניות, ומסיים את התשובה', async () => {
  const f = fakeFetch(), out = fakeOut();
  const res = await pump({ out, upstream: 'http://d.liveatc.net/llbg2', maxMs: 250, fetchImpl: f.impl });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].opts.redirect, 'follow');
  assert.ok(out.chunks.length >= 2, `chunks=${out.chunks.length}`);
  assert.ok(res.bytes >= 6);
  assert.equal(out.ended, true);
});

test('pump: המתקשר ניתק – מפסיקים מיד את החיבור ל-LiveATC', async () => {
  const f = fakeFetch(), out = fakeOut();
  const p = pump({ out, upstream: 'u', maxMs: 60_000, fetchImpl: f.impl });
  await sleep(50);
  out.emit('close');
  const t0 = Date.now();
  await p;
  assert.ok(Date.now() - t0 < 100);
  assert.equal(f.calls[0].opts.signal.aborted, true);
});

test('pump: LiveATC לא זמין בהתחלה – מנסה שוב ומזרים', async () => {
  const f = fakeFetch({ failFirst: true }), out = fakeOut();
  const res = await pump({ out, upstream: 'u', maxMs: 150, retryMs: 20, fetchImpl: f.impl });
  assert.equal(res.connects, 2);
  assert.ok(out.chunks.length > 0);
});

test('pump: LiveATC לא שולח כלום – מוותר אחרי stallMs ומנסה שוב (לא נתקע 14 דקות)', async () => {
  let n = 0;
  const hang = async (url, opts) => {
    n++;
    return await new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  };
  const out = fakeOut(), logs = [];
  await pump({ out, upstream: 'u', maxMs: 200, stallMs: 50, retryMs: 10, fetchImpl: hang, log: (m, x) => logs.push([m, x]) });
  assert.ok(n >= 2, `attempts=${n}`);
  assert.ok(logs.some(([m, x]) => /נפל/.test(m) && /אין מידע/.test(x.error)));
});

test('atcKey: 24 תווים, רק אותיות ומספרים, נגזר מהסיסמה; מאשר בנתיב /<key>.mp3', () => {
  const k = atcKey('a+b&c#d=e!');
  assert.match(k, /^[0-9a-f]{24}$/);
  assert.equal(k, atcKey('a+b&c#d=e!'));
  assert.notEqual(k, atcKey('other'));
  assert.equal(authorized({}, 'a+b&c#d=e!', `/${k}.mp3`), true);
  assert.equal(authorized({ key: k }, 'a+b&c#d=e!', '/llbg.mp3'), true);
  assert.equal(authorized({}, 'a+b&c#d=e!', '/llbg.mp3'), false);
  assert.equal(authorized({}, 'a+b&c#d=e!', `/${k.slice(1)}.mp3`), false);
});

test('pump: פתיחה מיידית ורחש עד שמגיע שמע מ-LiveATC (כדי שימות המשיח תזהה שידור)', async () => {
  assert.deepEqual([...SILENT_FRAME.subarray(0, 4)], [0xff, 0xfb, 0x10, 0xc0]);
  // קובצי הפתיחה: MP3 אמיתי (מתחיל בסנכרון פריים), ~8 שניות ו-~1 שנייה ב-32kbps
  assert.equal(INTRO[0], 0xff); assert.equal(INTRO[1] & 0xe0, 0xe0);
  assert.ok(INTRO.length > 28_000 && INTRO.length < 40_000, `intro=${INTRO.length}`);
  assert.ok(HISS.length > 3_000 && HISS.length < 5_000, `hiss=${HISS.length}`);
  const intro = Buffer.from('INTRO'), filler = Buffer.from('HISS');
  const slow = async (url, opts) => { await sleep(120); return fakeFetch().impl(url, opts); };   // LiveATC עונה אחרי 120ms
  const out = fakeOut();
  const p = pump({ out, upstream: 'u', maxMs: 300, fetchImpl: slow, intro, filler, fillerMs: 20 });
  await sleep(5);
  assert.ok(out.chunks[0].equals(intro), 'הפתיחה נשלחה מיד');
  await p;
  const firstReal = out.chunks.findIndex(c => c.toString() === 'MP3');
  assert.ok(firstReal > 1, 'רחש בזמן ההמתנה');
  assert.ok(out.chunks.slice(1, firstReal).every(c => c.equals(filler)));
  assert.ok(out.chunks.slice(firstReal).every(c => c.toString() === 'MP3'), 'הרחש נפסק כשהשמע מתחיל');
});
