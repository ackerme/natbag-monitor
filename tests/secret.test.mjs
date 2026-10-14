// סיסמת הקו מ-SSM: עדיפות ל-SSM, מעבר למשתנה סביבה רק כשהפרמטר לא קיים, ו"נכשלים סגור" בשגיאה אחרת.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getIvrToken, _resetCache } from '../natbag-aws/src/proxy/secret.mjs';
import * as atcSecret from '../natbag-aws/src/atc/secret.mjs';
import { readFileSync } from 'node:fs';

const env = { IVR_TOKEN_PARAM: '/natbag/ivr/token', IVR_TOKEN: 'from-env' };
beforeEach(() => _resetCache());

test('SSM קודם, ונשמר במטמון 5 דקות', async () => {
  let calls = 0;
  const ssmSend = async (input) => { calls++; assert.equal(input.Name, '/natbag/ivr/token'); assert.equal(input.WithDecryption, true); return { Parameter: { Value: 'from-ssm' } }; };
  assert.equal(await getIvrToken({ ssmSend, env, now: 1000 }), 'from-ssm');
  assert.equal(await getIvrToken({ ssmSend, env, now: 1000 + 60_000 }), 'from-ssm');
  assert.equal(calls, 1);
  assert.equal(await getIvrToken({ ssmSend, env, now: 1000 + 6 * 60_000 }), 'from-ssm');   // אחרי 5 דקות – קורא שוב
  assert.equal(calls, 2);
});

test('אין פרמטר ב-SSM – משתנה הסביבה (תקופת מעבר)', async () => {
  const ssmSend = async () => { const e = new Error('nf'); e.name = 'ParameterNotFound'; throw e; };
  assert.equal(await getIvrToken({ ssmSend, env }), 'from-env');
});

test('שגיאה אחרת (הרשאות/רשת) – null, כדי שהקו לא ייפתח בלי סיסמה', async () => {
  const ssmSend = async () => { const e = new Error('denied'); e.name = 'AccessDeniedException'; throw e; };
  const orig = console.error; console.error = () => {};
  try { assert.equal(await getIvrToken({ ssmSend, env }), null); } finally { console.error = orig; }
});

test('בלי IVR_TOKEN_PARAM – רק משתנה הסביבה, בלי SSM', async () => {
  assert.equal(await getIvrToken({ ssmSend: async () => { throw new Error('should not call'); }, env: { IVR_TOKEN: 'x' } }), 'x');
});

test('הקובץ זהה בשתי הפונקציות', () => {
  const a = readFileSync(new URL('../natbag-aws/src/proxy/secret.mjs', import.meta.url), 'utf8');
  const b = readFileSync(new URL('../natbag-aws/src/atc/secret.mjs', import.meta.url), 'utf8');
  assert.equal(a, b);
  assert.equal(typeof atcSecret.getIvrToken, 'function');
});
