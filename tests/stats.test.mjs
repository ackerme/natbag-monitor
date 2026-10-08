// בדיקות לסטטיסטיקה היומית ולדף "מצב המערכת". הרצה: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordStats, israelParts, emptyDay } from '../natbag-aws/src/watcher/index.mjs';
import { healthUpdate } from '../natbag-aws/src/healthcheck/index.mjs';
import { summarizeStats, israelDates, fromDynamo, ivrUsage } from '../natbag-aws/src/proxy/stats.mjs';

const NOW = Date.UTC(2026, 9, 1, 11, 30);          // 14:30 בישראל
const P = (id, cs, extra) => ({ icao24: id, callsign: cs, cls: 'passenger', onGround: false, isFinal: false, isDeparting: false, isAlert: false, dist: 30, ...extra });

test('israelParts / israelDates: לפי שעון ישראל', () => {
  assert.deepEqual(israelParts(NOW), { date: '2026-10-01', hour: 14 });
  assert.deepEqual(israelParts(Date.UTC(2026, 9, 1, 22, 30)), { date: '2026-10-02', hour: 1 });   // אחרי חצות
  assert.deepEqual(israelDates(NOW, 3), ['2026-09-29', '2026-09-30', '2026-10-01']);
});

test('recordStats: כל מטוס נספר פעם אחת ביום; יום חדש מתחיל מאפס', () => {
  let d = recordStats(null, [P('a', 'ELY027', { isFinal: true }), P('b', 'THY794', { isDeparting: true, dist: 10 }), P('c', 'WZZ1', {})], { level: 'normal' }, NOW);
  d = recordStats(d, [P('a', 'ELY027', { isFinal: true, isAlert: true }), P('d', 'RYR5', { isDeparting: true, dist: 40 })], { level: 'unusual' }, NOW + 60e3);
  assert.deepEqual(Object.keys(d.landings), ['a']);
  assert.deepEqual(d.landings.a, [14, 'ELY']);
  assert.deepEqual(Object.keys(d.departures), ['b'], 'המראה רחוקה מ-25 ק"מ לא נספרת');
  assert.deepEqual(d.alerts.a, [14, 'ELY027']);
  assert.equal(d.air[14].n, 2); assert.equal(d.air[14].m, 3);
  assert.equal(d.levelMin.unusual, 1);
  assert.deepEqual(d.events.map(e => e.level), ['unusual']);
  const next = recordStats(d, [], { level: 'normal' }, NOW + 864e5);
  assert.equal(next.date, '2026-10-02'); assert.equal(Object.keys(next.landings).length, 0);
});

test('healthUpdate: מונים אטומיים לפי יום ושעה', () => {
  const u = healthUpdate('natbag-watch', [{ name: 'health', pass: true, ms: 120 }, { name: 'aircraft', pass: false, ms: 900 }], NOW);
  assert.equal(u.Key.pk.S, 'health#2026-10-01');
  assert.match(u.UpdateExpression, /^ADD checks :one, failed :f, latSum :ms, #hc :one, #hf :f SET lastCheck = :last$/);
  assert.deepEqual(u.ExpressionAttributeNames, { '#hc': 'c14', '#hf': 'f14' });
  assert.equal(u.ExpressionAttributeValues[':f'].N, '1');
  assert.equal(u.ExpressionAttributeValues[':ms'].N, '900');
  assert.deepEqual(JSON.parse(u.ExpressionAttributeValues[':last'].S).failedChecks, ['aircraft']);
});

test('summarizeStats: היום, שבוע, ממוצע לפי שעה וזמינות', () => {
  const day = (date, n, hour = 9) => {
    const d = emptyDay(date);
    for (let i = 0; i < n; i++) d.landings['x' + i] = [hour, i % 2 ? 'ELY' : 'THY'];
    d.departures.y = [hour + 1, 'ELY'];
    return d;
  };
  const statsByDate = { '2026-09-30': day('2026-09-30', 4), '2026-10-01': day('2026-10-01', 6) };
  statsByDate['2026-10-01'].alerts.z = [9, 'ELY027'];
  statsByDate['2026-10-01'].levelMin.major = 3;
  const healthByDate = {
    '2026-09-30': fromDynamo({ pk: { S: 'health#2026-09-30' }, checks: { N: '288' }, failed: { N: '0' }, latSum: { N: '28800' } }),
    '2026-10-01': fromDynamo({ pk: { S: 'health#2026-10-01' }, checks: { N: '100' }, failed: { N: '2' }, latSum: { N: '20000' },
                               lastCheck: { S: JSON.stringify({ t: NOW - 120e3, pass: true, ms: 150, source: 'adsb.lol' }) } }),
  };
  const s = summarizeStats({ statsByDate, healthByDate, now: NOW });
  assert.equal(s.today.landings, 6); assert.equal(s.today.departures, 1); assert.equal(s.today.alerts, 1);
  assert.equal(s.today.busiestHour, 9);
  assert.equal(s.today.landingsByHour[9], 6);
  assert.deepEqual(s.today.topAirlines.map(a => [a.code, a.count]), [['ELY', 4], ['THY', 3]]);
  assert.equal(s.today.topAirlines[0].name, 'אל על');
  assert.equal(s.today.anomalyMinutes.major, 3);
  assert.equal(s.week.length, 7);
  assert.equal(s.week[5].landings, 4); assert.equal(s.week[0].landings, null);
  assert.equal(s.avgLandingsByHour[9], 4);
  assert.equal(s.status.uptime30, 99.48);          // (288+98)/388
  assert.equal(s.status.uptimeToday, 98);
  assert.equal(s.status.avgLatencyToday, 200);
  assert.equal(s.status.state, 'ok');
  assert.equal(s.status.days.length, 30);
  assert.equal(s.status.lastCheck.source, 'adsb.lol');
});

test('summarizeStats: בלי נתונים בכלל → מצב "לא ידוע", בלי קריסה', () => {
  const s = summarizeStats({ statsByDate: {}, healthByDate: {}, now: NOW });
  assert.equal(s.today, null); assert.equal(s.status.state, 'unknown'); assert.equal(s.status.uptime30, null);
  assert.equal(s.avgLandingsByHour, null);
});

test('ivrUsage: שלוחה לפי mode, טלפון רק כטביעה יומית, בלי ApiCallId או בניתוק – לא רושמים', () => {
  const u = ivrUsage({ ApiCallId: 'abc', ApiPhone: '0501234567', mode: 'arrivals' }, NOW);
  assert.equal(u.date, '2026-10-01');
  assert.equal(u.ext, 'arr');
  assert.match(u.caller, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(u).includes('0501234567'));
  assert.notEqual(ivrUsage({ ApiCallId: 'abc', ApiPhone: '0501234567' }, NOW + 864e5).caller, u.caller);  // משתנה כל יום
  assert.equal(ivrUsage({ ApiCallId: 'x', mode: 'flights' }, NOW).ext, 'flight');
  assert.equal(ivrUsage({ ApiCallId: 'x', flight1: '580' }, NOW).ext, 'flight');
  assert.equal(ivrUsage({ ApiCallId: 'x' }, NOW).ext, 'menu');
  assert.equal(ivrUsage({ mode: 'planes' }, NOW), null);
  assert.equal(ivrUsage({ ApiCallId: 'x', ApiHangup: 'yes' }, NOW), null);
});

test('summarizeStats: קו הטלפון – היום ושבוע, קבוצות DynamoDB נספרות', () => {
  const ivr = fromDynamo({ pk: { S: 'ivr#2026-10-01' }, calls: { SS: ['a', 'b', 'c'] }, callers: { SS: ['p1', 'p2'] },
                          requests: { N: '11' }, ext_arr: { SS: ['a', 'b'] }, ext_flight: { SS: ['c'] } });
  const s = summarizeStats({ statsByDate: {}, healthByDate: {}, ivrByDate: { '2026-10-01': ivr }, now: NOW });
  assert.deepEqual(s.phone.today, { calls: 3, callers: 2, requests: 11, byExt: { arr: 2, dep: 0, all: 0, flight: 1, menu: 0 } });
  assert.equal(s.phone.week.length, 7);
  assert.equal(s.phone.week[6].calls, 3);
  // בלי נתונים – אפסים ולא שגיאה
  assert.equal(summarizeStats({ statsByDate: {}, healthByDate: {}, now: NOW }).phone.today.calls, 0);
});
