// בדיקות ללוגיקת הזיהוי (detect.js). הרצה: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const D = require('../detect.js');

const TLV = { lat: 32.0055, lon: 34.8854 };
const ctx = (history = {}) => ({ ...TLV, radius: 80, devThresh: 18, finalKm: 25, finalAlt: 1800, history });
// נקודה במרחק km ממזרח לנתב"ג
const eastOf = km => ({ lat: TLV.lat, lon: TLV.lon + km / (111.32 * Math.cos(TLV.lat * Math.PI / 180)) });

test('haversine: מעלת רוחב אחת ≈ 111 ק"מ', () => {
  const d = D.haversine(32, 35, 33, 35);
  assert.ok(Math.abs(d - 111.2) < 0.5, `got ${d}`);
});

test('bearingTo: צפון = 0°, מזרח ≈ 90°', () => {
  assert.ok(D.bearingTo(32, 35, 33, 35) < 0.01);
  assert.ok(Math.abs(D.bearingTo(32, 35, 32, 36) - 90) < 1);
});

test('angDiff: עובר נכון את 360°', () => {
  assert.equal(D.angDiff(350, 10), 20);
  assert.equal(D.angDiff(10, 350), 20);
  assert.equal(D.angDiff(90, 270), 180);
});

test('normalize (ADS-B): המרת רגל/קשרים למטר/קמ"ש', () => {
  const n = D.normalize({ hex: 'abc', flight: 'ELY1  ', lat: 32, lon: 35, alt_baro: 1000, baro_rate: -1000, gs: 100, track: 90 }, true);
  assert.equal(n.cs, 'ELY1');
  assert.ok(Math.abs(n.alt - 304.8) < 0.01);
  assert.ok(Math.abs(n.vrate - -5.08) < 0.01);
  assert.ok(Math.abs(n.speed - 185.2) < 0.01);
  assert.equal(n.og, false);
});

test('normalize (ADS-B): על הקרקע + שם משובש נופל לרישום', () => {
  const n = D.normalize({ hex: 'x', flight: '@@@@@@@@', r: '4X-EKP', lat: 32, lon: 35, alt_baro: 'ground', gs: 14 }, true);
  assert.equal(n.og, true);
  assert.equal(n.alt, 0);
  assert.equal(n.cs, '4X-EKP');
});

test('normalize (OpenSky): מערך state vector, מהירות מ\'/ש\' → קמ"ש', () => {
  const n = D.normalize(['4x1', 'ELY5 ', 'Israel', 0, 0, 35, 32, 1500, false, 100, 270, -3], false);
  assert.equal(n.cs, 'ELY5');
  assert.equal(n.alt, 1500);
  assert.equal(n.speed, 360);
  assert.equal(n.track, 270);
  assert.equal(n.vrate, -3);
});

test('normalize + classify: סוג מטוס, רישום ו-squawk עוברים הלאה', () => {
  const n = D.normalize({ hex: '738102', flight: 'ELY017', r: '4X-ERC', t: 'B788', squawk: '1173', lat: 32.03, lon: 34.61, alt_baro: 6975, baro_rate: 1728, gs: 252, track: 285 }, true);
  assert.deepEqual([n.type, n.reg, n.squawk], ['B788', '4X-ERC', '1173']);
  const c = D.classify(n, ctx());
  assert.deepEqual([c.type, c.reg, c.squawk], ['B788', '4X-ERC', '1173']);
  const o = D.normalize(['4x1', 'ELY5', 'Israel', 0, 0, 35, 32, 1500, false, 100, 270, -3, null, 1600, '7700'], false);
  assert.equal(o.squawk, '7700');
});

test('normalize: בלי מיקום → null', () => {
  assert.equal(D.normalize({ hex: 'x', alt_baro: 1000 }, true), null);
});

test('classify: מחוץ לטווח → null', () => {
  const n = { id: 'far', cs: 'FAR', ...eastOf(200), alt: 10000, vrate: 0, speed: 800, og: false, track: 270 };
  assert.equal(D.classify(n, ctx()), null);
});

test('נתונים אמיתיים: קרקע, המראה וגישה סופית מזוהים נכון, בלי התרעות שווא', () => {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/tlv-sample.json', import.meta.url)));
  const history = {};
  let planes;
  for (let i = 0; i < 3; i++) {
    planes = raw.ac.map(p => D.normalize(p, true)).filter(Boolean).map(n => D.classify(n, ctx(history))).filter(Boolean);
  }
  const by = Object.fromEntries(planes.map(p => [p.callsign, p]));
  for (const cs of ['ELY027', 'BBG695', '4X-EKP', 'ISR971', 'AIZ991']) {
    assert.equal(by[cs].onGround, true, `${cs} should be on ground`);
    assert.equal(by[cs].isApproach, false);
  }
  assert.equal(by.ELY017.isDeparting, true, 'ELY017 climbs → departure');
  assert.equal(by.ELY017.isApproach, false);
  assert.equal(by.ISR580.isFinal, true, 'ISR580 on final');
  assert.equal(planes.filter(p => p.isAlert).length, 0, 'no false alerts');
});

test('התרעה: מטוס בגישה סופית שפונה מהשדה → התרעה רק בקריאה השלישית', () => {
  const history = {};
  const n = { id: 'bad', cs: 'BAD1', ...eastOf(15), alt: 1200, vrate: -3.5, speed: 280, og: false, track: 200 };
  const r1 = D.classify(n, ctx(history));
  const r2 = D.classify(n, ctx(history));
  const r3 = D.classify(n, ctx(history));
  assert.equal(r1.isFinal, true);
  assert.equal(r1.isAlert, false);
  assert.equal(r2.isAlert, false);
  assert.equal(r3.isAlert, true);
});

test('בלי התרעה: מטוס בגישה סופית שמכוון לשדה', () => {
  const history = {};
  const n = { id: 'good', cs: 'GOOD1', ...eastOf(15), alt: 1200, vrate: -3.5, speed: 280, og: false, track: 268 };
  for (let i = 0; i < 5; i++) assert.equal(D.classify(n, ctx(history)).isAlert, false);
});

test('בלי התרעה: מטוס שמתקן את הכיוון (מגמת שיפור)', () => {
  const history = {};
  const base = { id: 'fix', cs: 'FIX1', ...eastOf(15), alt: 1200, vrate: -3.5, speed: 280, og: false };
  const tracks = [190, 205, 225];            // הסטייה קטנה בכל קריאה
  const results = tracks.map(track => D.classify({ ...base, track }, ctx(history)));
  assert.equal(results[2].trend, 'i');
  assert.equal(results[2].isAlert, false);
});

// ───────────── מדד חריגה בתנועה האווירית ─────────────
const circle = (n, rKm = 5) => Array.from({ length: n }, (_, i) => {
  const a = i / (n - 1) * 2 * Math.PI * 1.05;                      // קצת יותר מסיבוב מלא
  return { lat: 32.2 + Math.cos(a) * rKm / 111, lon: 35.1 + Math.sin(a) * rKm / 94 };
});
const straight = n => Array.from({ length: n }, (_, i) => ({ lat: 32.2 + i * 0.05, lon: 35.1 }));

test('isHolding: מעגל = המתנה, קו ישר = לא', () => {
  assert.equal(D.isHolding(circle(12)), true);
  assert.equal(D.isHolding(straight(12)), false);
  assert.equal(D.isHolding(circle(3)), false, 'מעט מדי נקודות');
  // קו ישר, קפיצה (נקודה שגויה), וקו ישר חזרה – לא המתנה
  const jump = [...straight(5), { lat: 31.5, lon: 34.2 }, ...straight(5).map(p => ({ lat: p.lat - 0.7, lon: p.lon - 0.9 })).reverse()];
  assert.equal(D.isHolding(jump), false, 'קפיצה במיקום לא נחשבת סיבוב');
});

test('isTurnBack: היה בגישה, פונה מהשדה ומתרחק', () => {
  const base = { wasApproaching: true, onGround: false, isApproach: false, dev: 170, prevDist: 20, dist: 23 };
  assert.equal(D.isTurnBack(base), true);
  assert.equal(D.isTurnBack({ ...base, wasApproaching: false }), false);
  assert.equal(D.isTurnBack({ ...base, dist: 19 }), false, 'מתקרב – לא הסתובב');
  assert.equal(D.isTurnBack({ ...base, dev: 40 }), false);
});

const T0 = Date.UTC(2026, 8, 28, 10, 0);
const series = (mins, fn) => Array.from({ length: mins + 1 }, (_, m) => ({ t: T0 + m * 60e3, ...fn(m) }));
const normal = () => ({ airborne: 12, finals: 2, holding: 0, turnBacks: 0, emergencies: 0 });

test('airspaceStatus: תנועה רגילה → normal', () => {
  const h = series(40, normal);
  const s = D.airspaceStatus(h, h.at(-1).t);
  assert.equal(s.level, 'normal');
  assert.equal(s.baselineReady, true);
  assert.equal(s.reasons.length, 0);
});

test('airspaceStatus: 3 מטוסים בהמתנה → unusual', () => {
  const h = series(40, m => m >= 38 ? { ...normal(), holding: 3 } : normal());
  assert.equal(D.airspaceStatus(h, h.at(-1).t).level, 'unusual');
});

test('airspaceStatus: נחיתות נעצרו + המתנות → major', () => {
  const h = series(40, m => m >= 28 ? { airborne: 11, finals: 0, holding: 3, turnBacks: 0, emergencies: 0 } : normal());
  const s = D.airspaceStatus(h, h.at(-1).t);
  assert.equal(s.level, 'major');
  assert.ok(s.reasons.some(r => r.includes('גישה סופית')));
});

test('airspaceStatus: בלילה (מעט תנועה) אין נחיתות – לא נחשב חריגה', () => {
  const h = series(40, () => ({ airborne: 2, finals: 0, holding: 0, turnBacks: 0, emergencies: 0 }));
  assert.equal(D.airspaceStatus(h, h.at(-1).t).level, 'normal');
});

test('airspaceStatus: לפני שנאסף בסיס – לא בודק נחיתות/ירידה', () => {
  const h = series(5, m => ({ ...normal(), finals: 0, airborne: 1 }));
  const s = D.airspaceStatus(h, h.at(-1).t);
  assert.equal(s.baselineReady, false);
  assert.equal(s.level, 'normal');
});

// ───────────── סוג כלי הטיס ומטוסי תדלוק ─────────────
const cls = p => D.aircraftClass(D.normalize({ lat: 32.1, lon: 34.9, ...p }, true)).cls;

test('aircraftClass: נוסעים מול מטוס קל, מסוק וצבאי', () => {
  assert.equal(cls({ hex: '7380c6', flight: 'ELY027', t: 'B789', category: 'A5' }), 'passenger');
  assert.equal(cls({ hex: '501c55', flight: 'ISR580', t: 'A320', category: 'A3' }), 'passenger');
  assert.equal(cls({ hex: '4a0481', flight: 'AIZ723', t: 'AT76', category: 'A2' }), 'passenger', 'ATR של חברת תעופה');
  assert.equal(cls({ hex: '7395af', flight: '4XHSG', r: '4X-HSG', t: 'EV97', category: 'A1' }), 'light', 'המקרה מהצילום');
  assert.equal(cls({ hex: '738aaa', flight: 'LAHAV1', t: 'EC45', category: 'A7' }), 'helicopter');
  assert.equal(cls({ hex: 'ae1234', flight: 'RCH123', t: 'C17', category: 'A5', dbFlags: 1 }), 'military');
  assert.equal(cls({ hex: '4b1234', flight: 'HBJFK', t: 'C68A', category: 'A2' }), 'light', 'מטוס מנהלים פרטי');
  assert.equal(cls({ hex: '73806a', flight: '@@@@@@@@', r: '4X-EKP', t: 'B738', category: 'A3' }), 'passenger', '737 עם callsign משובש');
});

test('מטוס קל עם סטייה בגישה סופית (4XHSG) – בלי התרעה', () => {
  const history = {};
  const n = D.normalize({ hex: '7395af', flight: '4XHSG', r: '4X-HSG', t: 'EV97', category: 'A1', ...eastOf(15),
    alt_baro: 1350, baro_rate: -300, gs: 103, track: 155 }, true);
  let r; for (let i = 0; i < 4; i++) r = D.classify(n, ctx(history));
  assert.equal(r.cls, 'light');
  assert.equal(r.isFinal, true);
  assert.ok(r.dev > 100);
  assert.equal(r.isAlert, false);
});

test('countryOf: טווחי ICAO של ארה"ב וישראל', () => {
  assert.equal(D.countryOf('ae07f1'), 'US');
  assert.equal(D.countryOf('738102'), 'IL');
  assert.equal(D.countryOf('4a0481'), null);
});

test('מטוסי תדלוק: KC-135 אמריקאי, 707 ישראלי צבאי, ו-707/DC10 אזרחי לא נחשב', () => {
  assert.equal(cls({ hex: 'ae04c5', flight: 'QID21', t: 'K35R', category: 'A5', dbFlags: 1 }), 'tanker');
  assert.equal(cls({ hex: '738c01', flight: 'IAF707', t: 'B703', dbFlags: 1 }), 'tanker');
  assert.equal(cls({ hex: 'ae5555', flight: 'NCHO44', desc: 'BOEING KC-46A Pegasus', dbFlags: 1 }), 'tanker');
  assert.equal(cls({ hex: 'a12345', flight: 'FDX12', t: 'DC10', category: 'A5' }), 'passenger', 'DC10 אזרחי (מטען)');
});

test('tankerStatus: 2 מטוסי תדלוק של ארה"ב/ישראל → ריבוי; מדינות אחרות לא נספרות', () => {
  const T = [
    { hex: 'ae04c5', flight: 'QID21', t: 'K35R', dbFlags: 1, lat: 33.5, lon: 34.0, alt_baro: 25000 },
    { hex: 'ae04c5', flight: 'QID21', t: 'K35R', dbFlags: 1, lat: 33.5, lon: 34.0, alt_baro: 25000 },   // כפול
    { hex: '43c123', flight: 'RRR01', t: 'A332', dbFlags: 1, lat: 34.5, lon: 33.0, alt_baro: 28000 },  // בריטי
  ].map(p => D.normalize(p, true));
  let s = D.tankerStatus(T, TLV);
  assert.equal(s.count, 1); assert.equal(s.multi, false);
  T.push(D.normalize({ hex: '738c01', flight: 'IAF707', t: 'B703', dbFlags: 1, lat: 31.0, lon: 34.5, alt_baro: 22000 }, true));
  s = D.tankerStatus(T, TLV);
  assert.equal(s.count, 2); assert.equal(s.multi, true);
  assert.deepEqual(s.tankers.map(t => t.country).sort(), ['IL', 'US']);
  assert.equal(s.tankers.find(t => t.country === 'US').name, 'KC-135');
  assert.ok(s.tankers.every(t => t.dist > 0));
});

test('trackedStatus: מעל 1,000 עוקבים וקשור לנתב"ג (מסלול או באזור) → מתריע', () => {
  const local = [D.normalize({ hex: '4b1805', flight: 'SWR254 ', lat: 32.1, lon: 34.6, alt_baro: 9000 }, true)];
  const tracked = [
    { id: 'a', flight: 'LY1', callsign: 'ELY001', clicks: 4300, from: 'JFK', to: 'TLV', fromCity: 'New York' },  // נוחתת בנתב"ג
    { id: 'b', flight: 'LX254', callsign: 'SWR254', clicks: 1500, from: 'ZRH', to: 'AMM' },                       // באזור עכשיו
    { id: 'c', flight: 'BA175', callsign: 'BAW175', clicks: 9000, from: 'LHR', to: 'JFK' },                       // לא קשור
    { id: 'd', flight: 'LY8', callsign: 'ELY008', clicks: 999, from: 'TLV', to: 'BKK' },                          // מתחת לסף
    { id: 'a', flight: 'LY1', callsign: 'ELY001', clicks: 4300, from: 'JFK', to: 'TLV' },                         // כפול
  ];
  const s = D.trackedStatus(tracked, local, { threshold: 1000 });
  assert.equal(s.count, 2);
  assert.deepEqual(s.flights.map(f => f.flight), ['LY1', 'LX254']);
  assert.equal(s.flights[0].dir, 'A');
  assert.equal(s.flights[1].inArea, true);
  assert.equal(s.flights[1].planeId, '4b1805');
  assert.equal(D.trackedStatus([], local).count, 0);
  assert.equal(D.trackedStatus(null, null).count, 0);
});
