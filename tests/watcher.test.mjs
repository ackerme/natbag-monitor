// בדיקות למעקב בצד השרת (natbag-watcher) ולהתרעה הטלפונית. הרצה: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { step, shouldCall, callText, yemotCall, emptyState, CALL_GAP_MS } from '../natbag-aws/src/watcher/index.mjs';

test('watcher: detect.cjs זהה ל-detect.js (אותה לוגיקה בדף ובשרת)', () => {
  const a = readFileSync(new URL('../detect.js', import.meta.url), 'utf8');
  const b = readFileSync(new URL('../natbag-aws/src/watcher/detect.cjs', import.meta.url), 'utf8');
  assert.equal(b, a, 'הרץ: cp detect.js natbag-aws/src/watcher/detect.cjs');
});

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const pax = (hex, extra = {}) => ({ hex, flight: 'ELY0' + hex.slice(-2), category: 'A5', t: 'B789', lat: 32.5, lon: 34.6, alt_baro: 30000, gs: 450, track: 90, ...extra });

test('watcher step: שגרה → normal; קוד חירום + נחיתות שנעצרו (מול בסיס) → major', () => {
  let r = step(emptyState(), [pax('738001'), pax('738002')], NOW);
  assert.equal(r.status.level, 'normal');
  assert.equal(r.state.history.length, 1);

  // היסטוריה: בשעה האחרונה היו בממוצע 2 מטוסים בגישה סופית
  const base = Array.from({ length: 15 }, (_, i) => ({ t: NOW - (60 - i * 3) * 60e3, airborne: 10, finals: 2, holding: 0, turnBacks: 0, emergencies: 0 }));
  r = step({ ...emptyState(), history: base }, [pax('738001', { squawk: '7700' }), ...Array.from({ length: 9 }, (_, i) => pax('73810' + i))], NOW);
  assert.equal(r.status.level, 'major');
  assert.ok(r.status.reasons.some(x => x.includes('קוד חירום')));
  assert.ok(r.status.reasons.some(x => x.includes('גישה סופית')));
  assert.ok(r.state.history.every(h => NOW - h.t <= 60 * 60e3));
});

test('watcher step: שובלים נשמרים בין הרצות ונמחקים אחרי 10 דקות', () => {
  let s = emptyState();
  s = step(s, [pax('738001')], NOW).state;
  s = step(s, [pax('738001', { lat: 32.52 })], NOW + 60e3).state;
  assert.equal(s.trails['738001'].length, 2);
  s = step(s, [], NOW + 12 * 60e3).state;
  assert.equal(s.trails['738001'], undefined);
});

test('shouldCall: רק במעבר ל-major, ולא יותר מפעם בחצי שעה', () => {
  const major = { level: 'major' };
  assert.equal(shouldCall('normal', major, 0, NOW), true);
  assert.equal(shouldCall('unusual', major, 0, NOW), true);
  assert.equal(shouldCall('major', major, 0, NOW), false, 'כבר במצב משמעותי – לא מתקשרים שוב');
  assert.equal(shouldCall('normal', major, NOW - 10 * 60e3, NOW), false, 'שיחה לפני 10 דקות');
  assert.equal(shouldCall('normal', major, NOW - CALL_GAP_MS, NOW), true);
  assert.equal(shouldCall('normal', { level: 'unusual' }, 0, NOW), false);
});

test('callText: בלי תווים שימות המשיח לא מקבלת, ועם הסתייגות', () => {
  const t = callText({ reasons: ['אין מטוסים בגישה סופית ב-10 הדקות האחרונות (בדרך כלל ~2.0)', 'מטוס משדר קוד חירום (7700/7600)', '2 מטוסים שהיו בגישה לנתב"ג הסתובבו'] });
  assert.doesNotMatch(t, /[."'&|()~/-]/);
  assert.match(t, /חריגה משמעותית/);
  assert.match(t, /אינה התרעה של פיקוד העורף/);
  assert.match(t, /לנמל התעופה הסתובבו/);
});

test('yemotCall: Login ואז RunCampaign עם הקראה לטלפון', async () => {
  const calls = [];
  const fake = async (url) => {
    calls.push(new URL(url));
    const u = calls.at(-1);
    if (u.pathname.endsWith('/Login')) return new Response(JSON.stringify({ responseStatus: 'OK', token: 'TKN' }));
    return new Response(JSON.stringify({ responseStatus: 'OK', campaignId: 'c1', estimatedPrice: 1, customerUnits: 9 }));
  };
  const r = await yemotCall({ username: '0772292885', password: 'pw', phone: '0501234567' }, 'בדיקה', fake);
  assert.deepEqual(r, { campaignId: 'c1', estimatedPrice: 1, customerUnits: 9 });
  assert.equal(calls[0].searchParams.get('username'), '0772292885');
  assert.equal(calls[1].pathname, '/ym/api/RunCampaign');
  assert.equal(calls[1].searchParams.get('token'), 'TKN');
  assert.equal(calls[1].searchParams.get('ttsMode'), '1');
  assert.deepEqual(JSON.parse(calls[1].searchParams.get('phones')), { '0501234567': { text: 'בדיקה' } });

  const bad = async () => new Response(JSON.stringify({ responseStatus: 'ERROR', message: 'not enough units' }));
  await assert.rejects(yemotCall({ username: 'a', password: 'b', phone: 'c' }, 'x', bad), /not enough units/);
});
