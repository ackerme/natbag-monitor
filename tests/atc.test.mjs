// בדיקות ל-natbag-atc (שלוחה 5, רק כשמתקשרים). בלי רשת: LiveATC מדומה.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pump, authorized } from '../natbag-aws/src/atc/index.mjs';

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
