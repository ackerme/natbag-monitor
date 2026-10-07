// בדיקות לשרת ב-AWS Lambda ולמתג הכיבוי, עם fetch מדומה (בלי רשת). הרצה: npm test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let mode = 'ok', calls = 0;
globalThis.fetch = async (url) => {
  calls++;
  const u = String(url);
  if (mode === 'lolfail' && u.includes('adsb.lol')) return new Response('down', { status: 503 });
  if (mode === 'allfail') return new Response('down', { status: 500 });
  if (u.includes('flightradar24.com')) return new Response(JSON.stringify({ data: [
    { flight_id: '3a1', flight: 'LY1', callsign: 'ELY001', clicks: 4300, from_iata: 'JFK', from_city: 'New York', to_iata: 'TLV', to_city: 'Tel Aviv', model: 'B789', on_ground: 0 },
    { flight_id: '3a2', flight: 'BA175', callsign: 'BAW175', clicks: 900, from_iata: 'LHR', to_iata: 'JFK' }] }));
  if (u.includes('opensky-network.org/api')) return new Response(JSON.stringify({ states: [] }));
  const ac = Array.from({ length: 20 }, (_, i) => ({ hex: 'a' + i, flight: 'T' + i, lat: 32, lon: 34.9, alt_baro: 3000, gs: 200 }));
  return new Response(JSON.stringify({ ac }));
};

const { handler, parseArea, parseTracked } = await import('../natbag-aws/src/proxy/index.mjs');
const { shouldDisable } = require('../natbag-aws/src/killswitch/index.js');

const ev = (path, q = {}, method = 'GET', gzip = false) => ({
  rawPath: path, queryStringParameters: q,
  requestContext: { http: { method } },
  headers: gzip ? { 'accept-encoding': 'gzip' } : {},
});
const body = r => JSON.parse(r.isBase64Encoded ? gunzipSync(Buffer.from(r.body, 'base64')).toString() : r.body);
let n = 0;
const Q = () => ({ lat: '32.0055', lon: '34.8854', dist: String(40 + (++n)) });   // מרחק שונה בכל בדיקה → בלי מטמון משותף

beforeEach(() => { mode = 'ok'; });

test('parseArea: קלט לא תקין נדחה, dist מוגבל ל-1–250', () => {
  assert.ok(parseArea({ lat: 'abc', lon: '1' }).error);
  assert.ok(parseArea({ lat: '91', lon: '1' }).error);
  assert.equal(parseArea({ lat: '32', lon: '35', dist: '9999' }).nm, 250);
  assert.equal(parseArea({ lat: '32', lon: '35' }).nm, 43);
});

test('/health מחזיר ok', async () => {
  const r = await handler(ev('/health'));
  assert.equal(r.statusCode, 200);
  assert.equal(body(r).ok, true);
});

test('/aircraft מחזיר מטוסים מ-adsb.lol', async () => {
  const r = await handler(ev('/aircraft', Q()));
  assert.equal(r.statusCode, 200);
  assert.equal(body(r)._source, 'adsb.lol');
  assert.equal(body(r).ac.length, 20);
});

test('מעבר אוטומטי: adsb.lol נופל → airplanes.live', async () => {
  mode = 'lolfail';
  const r = await handler(ev('/aircraft', Q()));
  assert.equal(r.statusCode, 200);
  assert.equal(body(r)._source, 'airplanes.live');
});

test('כל המקורות נופלים → 502, והשגיאה לא נשמרת במטמון', async () => {
  const q = Q();
  mode = 'allfail';
  assert.equal((await handler(ev('/aircraft', q))).statusCode, 502);
  mode = 'ok';
  assert.equal((await handler(ev('/aircraft', q))).statusCode, 200);
});

test('מטמון: אותה בקשה פעמיים → פנייה אחת למקור', async () => {
  const q = Q();
  await handler(ev('/aircraft', q));
  const before = calls;
  await handler(ev('/aircraft', q));
  assert.equal(calls, before);
});

test('gzip: תשובה דחוסה כשהדפדפן מבקש', async () => {
  const r = await handler(ev('/aircraft', Q(), 'GET', true));
  assert.equal(r.isBase64Encoded, true);
  assert.equal(r.headers['Content-Encoding'], 'gzip');
  assert.equal(body(r).ac.length, 20);
});

test('רק GET, ונתיב לא קיים → 404', async () => {
  assert.equal((await handler(ev('/aircraft', Q(), 'POST'))).statusCode, 405);
  assert.equal((await handler(ev('/https://evil.example'))).statusCode, 404);
  assert.equal((await handler(ev('/aircraft', { lat: 'x', lon: '1' }))).statusCode, 400);
});

test('מתג כיבוי: מגיב רק להתרעת תקציב אמיתית', () => {
  const real = 'AWS Budget Notification\nYou requested that we alert you when the ACTUAL Cost associated with your natbag-monthly budget is greater than $1.00';
  assert.equal(shouldDisable(real), true);
  assert.equal(shouldDisable('This is a test message'), false);
  assert.equal(shouldDisable(''), false);
});

test('/mil מחזיר רק מטוסים באזור ורק את השדות הדרושים', async () => {
  const r = await handler(ev('/mil'));
  assert.equal(r.statusCode, 200);
  const j = body(r);
  assert.equal(j._source, 'adsb.lol');
  assert.ok(j.ac.length > 0);
  assert.deepEqual(Object.keys(j.ac[0]).sort(), ['alt_baro', 'flight', 'gs', 'hex', 'lat', 'lon']);
  assert.ok(j.ac.every(a => a.lat >= 26 && a.lat <= 40 && a.lon >= 24 && a.lon <= 50));
});

test('/tracked מחזיר את רשימת Most tracked בפורמט מקוצר', async () => {
  const r = await handler(ev('/tracked'));
  assert.equal(r.statusCode, 200);
  const j = body(r);
  assert.equal(j._source, 'flightradar24');
  assert.equal(j.flights.length, 2);
  assert.deepEqual({ ...j.flights[0] }, { id: '3a1', flight: 'LY1', callsign: 'ELY001', clicks: 4300, squawk: '',
    from: 'JFK', fromCity: 'New York', to: 'TLV', toCity: 'Tel Aviv', model: 'B789', type: '', onGround: false });
});

test('parseTracked: תשובה בלי data נזרקת כשגיאה', () => {
  assert.throws(() => parseTracked({}));
  assert.throws(() => parseTracked(null));
  assert.deepEqual(parseTracked({ data: [] }), []);
});

test('/stats בלי טבלה (staging / בדיקות) → 404 עם הסבר', async () => {
  const r = await handler(ev('/stats'));
  assert.equal(r.statusCode, 404);
  assert.match(body(r).error, /אין טבלת סטטיסטיקה/);
});
