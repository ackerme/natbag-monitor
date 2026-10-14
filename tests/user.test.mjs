// חשבונות משתמשים: בדיקות קלט, הרשאות מנהל, מגבלות, ומחיקה – עם DynamoDB מדומה בזיכרון
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../natbag-aws/src/user/index.mjs';
import { normFlight, validateSettings, validateAlerts, groupsOf, MAX_FLIGHTS } from '../natbag-aws/src/user/users.mjs';

function memDb() {
  const m = new Map();
  return {
    m,
    async get(pk) { const v = m.get(pk); return v ? structuredClone(v) : null; },
    async put(it, { onlyIfNew } = {}) { if (onlyIfNew && m.has(it.pk)) return; m.set(it.pk, structuredClone(it)); },
    async del(pk) { m.delete(pk); },
    async scanUsers() { return [...m.values()].filter(x => x.pk.startsWith('user#')).map(x => structuredClone(x)); },
  };
}
const ev = (routeKey, { sub = 'u1', email = 'a@b.co', groups, num, body } = {}) => ({
  routeKey,
  requestContext: { authorizer: { jwt: { claims: { sub, email, ...(groups ? { 'cognito:groups': groups } : {}) } } } },
  pathParameters: num != null ? { num } : undefined,
  body: body !== undefined ? JSON.stringify(body) : undefined,
});
const call = async (h, ...a) => { const r = await h(ev(...a)); return { status: r.statusCode, body: JSON.parse(r.body) }; };

test('קלט: מספרי טיסה, הגדרות, התרעות, קבוצות', () => {
  assert.equal(normFlight('ly 001'), 'LY1');
  assert.equal(normFlight('580'), '580');
  assert.throws(() => normFlight('<script>'));
  assert.throws(() => normFlight('LY12345'));
  // אות קריאה מהרדאר (ICAO) נשמרת כמו שהיא
  assert.equal(normFlight('wzz907e'), 'WZZ907E');
  assert.equal(normFlight('ELY001'), 'ELY001');
  assert.equal(normFlight('RJA 344'), 'RJA344');
  assert.throws(() => normFlight('WZZ907EEE'));
  assert.throws(() => normFlight('WZZ'));
  assert.deepEqual(validateSettings({ radius: '100', deviation: 20, source: 'opensky' }), { radius: 100, deviation: 20, source: 'opensky' });
  assert.throws(() => validateSettings({ radius: 5000, deviation: 20 }));
  assert.throws(() => validateSettings({ radius: 80, deviation: 20, source: 'evil' }));
  assert.deepEqual(validateAlerts({ anomaly: 'major' }), { anomaly: 'major', flights: true });
  assert.throws(() => validateAlerts({ anomaly: 'always' }));
  assert.deepEqual(groupsOf({ 'cognito:groups': '[admin readers]' }), ['admin', 'readers']);
  assert.deepEqual(groupsOf({ 'cognito:groups': ['admin'] }), ['admin']);
  assert.deepEqual(groupsOf({}), []);
});

test('כניסה ראשונה יוצרת פרופיל עם ברירות מחדל; עדכון הגדרות והתרעות', async () => {
  const db = memDb(), h = createHandler(db, () => 1000);
  let r = await call(h, 'GET /me');
  assert.equal(r.status, 200);
  assert.equal(r.body.email, 'a@b.co');
  assert.equal(r.body.admin, false);
  assert.deepEqual(r.body.settings, { radius: 80, deviation: 18, source: 'auto' });
  r = await call(h, 'PUT /me/settings', { body: { radius: 120, deviation: 25, source: 'auto' } });
  assert.equal(r.body.settings.radius, 120);
  r = await call(h, 'PUT /me/settings', { body: { radius: 1, deviation: 25 } });
  assert.equal(r.status, 400);
  r = await call(h, 'PUT /me/alerts', { body: { anomaly: 'unusual' } });
  assert.equal(r.body.alerts.anomaly, 'unusual');
  assert.equal((await call(h, 'GET /me')).body.settings.radius, 120);
});

test('טיסות במעקב: נרמול, בלי כפילויות, עד 10, הסרה', async () => {
  const db = memDb(), h = createHandler(db);
  await call(h, 'PUT /me/flights/{num}', { num: 'ly001' });
  let r = await call(h, 'PUT /me/flights/{num}', { num: 'LY 1' });
  assert.deepEqual(r.body.flights, ['LY1']);
  for (let i = 2; i <= MAX_FLIGHTS; i++) await call(h, 'PUT /me/flights/{num}', { num: String(i) });
  r = await call(h, 'PUT /me/flights/{num}', { num: '999' });
  assert.equal(r.status, 400);
  r = await call(h, 'DELETE /me/flights/{num}', { num: 'LY001' });
  assert.equal(r.body.flights.length, MAX_FLIGHTS - 1);
  assert.equal((await call(h, 'PUT /me/flights/{num}', { num: 'DROP TABLE' })).status, 400);
});

test('משתמשים מופרדים: כל אחד רואה רק את שלו', async () => {
  const db = memDb(), h = createHandler(db);
  await call(h, 'PUT /me/flights/{num}', { sub: 'alice', num: '1' });
  const r = await call(h, 'GET /me', { sub: 'bob', email: 'bob@x.co' });
  assert.deepEqual(r.body.flights, []);
});

test('דף מנהל: רק לקבוצת admin', async () => {
  const db = memDb(), h = createHandler(db);
  await call(h, 'GET /me', { sub: 'a', email: 'a@x.co' });
  await call(h, 'PUT /me/flights/{num}', { sub: 'b', email: 'b@x.co', num: '7' });
  assert.equal((await call(h, 'GET /admin/users', { sub: 'b' })).status, 403);
  const r = await call(h, 'GET /admin/users', { sub: 'a', groups: '[admin]' });
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 2);
  assert.equal(r.body.trackedFlights, 1);
  assert.ok(r.body.users.every(u => !('pk' in u)), 'בלי מזהים פנימיים');
});

test('מחיקת חשבון מוחקת את כל המידע; בלי sub – 401; JSON שבור – 400', async () => {
  const db = memDb(), h = createHandler(db);
  await call(h, 'PUT /me/flights/{num}', { num: '1' });
  assert.equal(db.m.size, 1);
  assert.equal((await call(h, 'DELETE /me')).body.deleted, true);
  assert.equal(db.m.size, 0);
  assert.equal((await h({ routeKey: 'GET /me', requestContext: {} })).statusCode, 401);
  assert.equal((await h({ ...ev('PUT /me/settings'), body: '{bad' })).statusCode, 400);
});
