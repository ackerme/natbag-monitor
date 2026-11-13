// סוכן החקירה – עם מודל מדומה (בלי Bedrock ובלי רשת)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldInvestigate, investigate, reportEmail, asciiSubject, alertPrompt, toolConfig, TOOL_SPECS, TOOL_CHARS } from '../natbag-aws/src/investigator/agent.mjs';
import { summarizeWatcher, summarizeErrors, summarizeAircraft, makeTools } from '../natbag-aws/src/investigator/tools.mjs';
import { handleAlert, israelDate } from '../natbag-aws/src/investigator/index.mjs';

const alarm = state => JSON.stringify({ AlarmName: 'natbag-proxy-errors', NewStateValue: state, NewStateReason: 'Threshold crossed', AlarmDescription: 'x' });

test('shouldInvestigate: חוקר התרעות אמיתיות בלבד', () => {
  assert.equal(shouldInvestigate('natbag: EMERGENCY squawk 7700 - ELY001', '').kind, 'emergency');
  assert.equal(shouldInvestigate('natbag: airspace anomaly (major, score 5)', '').kind, 'anomaly');
  assert.equal(shouldInvestigate('ALARM: "natbag-proxy-errors" in US East', alarm('ALARM')).kind, 'alarm');
  // לא חוקרים:
  assert.equal(shouldInvestigate('natbag AI: airspace anomaly', '').why, 'self');          // הדוח של עצמו – לולאה
  assert.equal(shouldInvestigate('[TEST] natbag: EMERGENCY squawk 7700', '').why, 'test');
  assert.equal(shouldInvestigate('OK: "natbag-proxy-errors"', alarm('OK')).go, false);
  assert.equal(shouldInvestigate('AWS Budgets: natbag-monthly', 'AWS Budget Notification ACTUAL').why, 'budget');
  assert.equal(shouldInvestigate('hello', 'world').go, false);
});

test('alertPrompt: Alarm מ-JSON הופך לטקסט קריא', () => {
  const p = alertPrompt('ALARM: x', alarm('ALARM'), '09:02');
  assert.match(p, /CloudWatch Alarm: natbag-proxy-errors/);
  assert.match(p, /Threshold crossed/);
  assert.doesNotMatch(p, /"NewStateValue"/);
});

test('asciiSubject: נושא SNS חוקי (ASCII, בלי שורות, עד 99)', () => {
  assert.equal(asciiSubject('natbag AI: חריגה ELY001\nבדיקה'), 'natbag AI: ELY001');
  assert.ok(asciiSubject('x'.repeat(300)).length <= 99);
});

test('toolConfig: כל כלי בפורמט של Bedrock Converse', () => {
  const tc = toolConfig();
  assert.equal(tc.tools.length, TOOL_SPECS.length);
  for (const t of tc.tools) { assert.ok(t.toolSpec.name); assert.equal(t.toolSpec.inputSchema.json.type, 'object'); }
});

// מודל מדומה: מריץ תסריט של תשובות
function fakeModel(script) {
  const reqs = [];
  return { reqs, converse: async req => { reqs.push(structuredClone(req)); return script[reqs.length - 1]; } };
}
const toolUse = (id, name, input = {}) => ({ toolUse: { toolUseId: id, name, input } });
const reply = (content, stopReason = 'end_turn', inputTokens = 1000) => ({ output: { message: { role: 'assistant', content } }, stopReason, usage: { inputTokens, outputTokens: 100 } });

test('investigate: מפעיל כלים, מחזיר את התוצאות למודל, ומסיים בדוח', async () => {
  const m = fakeModel([
    reply([{ text: 'בודק' }, toolUse('t1', 'watcher_log', { minutes: 60 }), toolUse('t2', 'aircraft_now')], 'tool_use'),
    reply([{ text: 'בשורה אחת: רעש' }]),
  ]);
  const ran = [];
  const r = await investigate({ prompt: 'התרעה', converse: m.converse, runTool: async (n, i) => { ran.push([n, i]); return `out-${n}`; } });
  assert.deepEqual(ran, [['watcher_log', { minutes: 60 }], ['aircraft_now', {}]]);
  assert.equal(r.report, 'בשורה אחת: רעש');
  assert.deepEqual(r.usage, { input: 2000, output: 200 });
  assert.ok(r.cost > 0 && r.cost < 0.01);
  // בסבב השני המודל קיבל את תוצאות הכלים עם אותו toolUseId
  const last = m.reqs[1].messages.at(-1);
  assert.equal(last.role, 'user');
  assert.deepEqual(last.content.map(c => c.toolResult?.toolUseId), ['t1', 't2']);
  assert.equal(last.content[0].toolResult.content[0].text, 'out-watcher_log');
});

test('investigate: כלי שנכשל מוחזר כשגיאה, והפלט מקוצר', async () => {
  const m = fakeModel([
    reply([toolUse('a', 'proxy_errors'), toolUse('b', 'today_stats')], 'tool_use'),
    reply([{ text: 'דוח' }]),
  ]);
  const r = await investigate({ prompt: 'x', converse: m.converse,
    runTool: async n => { if (n === 'proxy_errors') throw new Error('boom'); return 'y'.repeat(10000); } });
  const res = m.reqs[1].messages.at(-1).content;
  assert.equal(res[0].toolResult.status, 'error');
  assert.match(res[0].toolResult.content[0].text, /boom/);
  assert.ok(res[1].toolResult.content[0].text.length < TOOL_CHARS + 100);
  assert.deepEqual(r.calls.map(c => c.status), ['error', 'success']);
});

test('investigate: לא עובר את מספר הסבבים, ובסבב האחרון מבקש דוח', async () => {
  const loop = Array.from({ length: 10 }, (_, i) => reply([toolUse('x' + i, 'system_health')], 'tool_use'));
  const m = fakeModel(loop);
  const r = await investigate({ prompt: 'x', converse: m.converse, runTool: async () => 'ok', maxTurns: 3 });
  assert.equal(m.reqs.length, 3);
  assert.match(JSON.stringify(m.reqs[2].messages.at(-1)), /הסבב האחרון/);
  assert.match(r.report, /לא הסתיימה/);
});

test('investigate: עוצר כשנגמר תקציב הטוקנים', async () => {
  const loop = Array.from({ length: 10 }, (_, i) => reply([toolUse('x' + i, 'system_health')], 'tool_use', 50000));
  const m = fakeModel(loop);
  await investigate({ prompt: 'x', converse: m.converse, runTool: async () => 'ok', maxInputTokens: 30000 });
  assert.equal(m.reqs.length, 1);
});

test('reportEmail: נושא ASCII שמתחיל ב-natbag AI (כדי שלא ייחקר שוב)', () => {
  const e = reportEmail({ subject: 'natbag: EMERGENCY squawk 7700 - ELY001', report: 'בשורה אחת: אמיתי', calls: [{ name: 'aircraft_now', input: { id: 'ELY001' } }],
                          usage: { input: 5000, output: 400 }, cost: 0.007, model: 'm' });
  assert.equal(e.subject, 'natbag AI: EMERGENCY squawk 7700 - ELY001');
  assert.equal(shouldInvestigate(e.subject, e.body).why, 'self');
  assert.match(e.body, /aircraft_now\(ELY001\)/);
  assert.match(e.body, /בשורה אחת: אמיתי/);
});

test('summarizeWatcher: דקות זהות מקובצות לטווח', () => {
  const ev = (t, level, score, reasons = []) => ({ timestamp: Date.UTC(2026, 10, 13, 1, t), message: JSON.stringify({ level, AirspaceScore: score, reasons }) });
  const s = summarizeWatcher([ev(35, 'unusual', 2, ['2 הסתובבו']), ev(36, 'unusual', 2, ['2 הסתובבו']), ev(37, 'unusual', 2, ['2 הסתובבו']), ev(38, 'normal', 0), { message: 'not json' }]);
  const lines = s.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^03:35–03:37 ×3 unusual ציון 2 \| 2 הסתובבו$/);
  assert.match(lines[1], /^03:38 normal ציון 0$/);
});

test('summarizeErrors: מקבץ לפי מסלול ופרטים', () => {
  const ev = (m, route, d) => ({ timestamp: Date.UTC(2026, 10, 13, 10, m), message: JSON.stringify({ level: 'error', route, details: [d] }) });
  const s = summarizeErrors([ev(1, 'aircraft', 'adsb.lol 502'), ev(2, 'aircraft', 'adsb.lol 502'), ev(3, 'board', 'timeout')]);
  assert.match(s.split('\n')[0], /^aircraft ×2 \(12:01–12:02\): adsb.lol 502$/);
  assert.equal(summarizeErrors([]), 'אין שגיאות בשרת הביניים בטווח הזה.');
});

test('summarizeAircraft: הקרובים קודם, סינון לפי אות קריאה, יחידות מטריות', () => {
  const ac = [
    { hex: 'aaa', flight: 'ELY001 ', t: 'B789', lat: 32.2, lon: 34.6, alt_baro: 9000, baro_rate: -1200, gs: 300, track: 120, squawk: '7700' },
    { hex: 'bbb', flight: 'WZZ907E', t: 'A21N', lat: 32.01, lon: 34.89, alt_baro: 'ground' },
    { hex: 'ccc', lat: null, lon: null },
  ];
  const all = summarizeAircraft(ac).split('\n');
  assert.equal(all.length, 3);
  assert.match(all[1], /^WZZ907E A21N 1ק"מ קרקע$/);
  assert.match(all[2], /ELY001 B789 \d+ק"מ 2743מ' -6.1מ'\/ש' 556קמ"ש כיוון 120° squawk 7700/);
  assert.match(summarizeAircraft(ac, 'ely001'), /ELY001/);
  assert.doesNotMatch(summarizeAircraft(ac, 'ely001'), /WZZ/);
  assert.match(summarizeAircraft(ac, 'XYZ1'), /לא נמצא/);
});

test('makeTools: קורא לשרת הביניים ולוגים עם הפרמטרים הנכונים', async () => {
  const urls = [], logs = [];
  const tools = makeTools({
    now: 1_000_000_000_000, proxyUrl: 'https://p.example/',
    fetch: async url => { urls.push(url); return { ok: true, headers: { get: () => 'adsb.lol' }, json: async () => ({ ac: [], today: null, status: { state: 'ok', uptimeToday: 100 } }) }; },
    filterLogs: async (g, start, pattern) => { logs.push([g, start, pattern]); return []; },
    alarmsInAlarm: async () => ['natbag-proxy-errors'],
  });
  await tools.watcher_log({ minutes: 9999 });
  await tools.proxy_errors({});
  assert.deepEqual(logs[0], ['/aws/lambda/natbag-watcher', 1_000_000_000_000 - 360 * 60e3, '{ $.AirspaceScore >= 0 }']);   // מוגבל ל-6 שעות
  assert.equal(logs[1][1], 1_000_000_000_000 - 90 * 60e3);
  assert.match(await tools.aircraft_now({}), /אין מטוסים/);
  assert.match(urls[0], /^https:\/\/p\.example\/aircraft\?lat=32\.0055&lon=34\.8854&dist=54$/);
  const h = await tools.system_health();
  assert.match(h, /ADS-B: עונה/);
  assert.match(h, /natbag-proxy-errors/);
  assert.equal(await tools.today_stats(), 'אין עדיין סטטיסטיקה להיום.');
});

// ───────── handleAlert: המכסה היומית והלולאה ─────────
function fakeDeps({ claim = true, converse } = {}) {
  const sent = [], claims = [];
  return { sent, claims, deps: {
    now: () => Date.UTC(2026, 10, 13, 22, 30),      // 00:30 בישראל → כבר 14 בנובמבר
    claimDay: async (d, s) => { claims.push([d, s]); return claim; },
    converse: converse || (async () => reply([{ text: 'בשורה אחת: רעש' }])),
    publish: async (s, m) => { sent.push({ s, m }); return { MessageId: '1' }; },
    tools: { system_health: async () => 'ok' }, model: 'test-model',
  } };
}

test('handleAlert: חוקר, שולח דוח אחד, ותופס את היום לפי שעון ישראל', async () => {
  const f = fakeDeps();
  const r = await handleAlert({ subject: 'natbag: airspace anomaly (major, score 5)', message: 'x' }, f.deps);
  assert.equal(r.investigated, true);
  assert.deepEqual(f.claims[0], ['2026-11-14', 'natbag: airspace anomaly (major, score 5)']);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].s, 'natbag AI: airspace anomaly (major, score 5)');
});

test('handleAlert: מעבר למכסה היומית – בלי מודל ובלי מייל', async () => {
  let called = false;
  const f = fakeDeps({ claim: false, converse: async () => { called = true; } });
  const r = await handleAlert({ subject: 'natbag: EMERGENCY squawk 7700', message: '' }, f.deps);
  assert.deepEqual(r, { investigated: false, reason: 'daily-limit' });
  assert.equal(called, false);
  assert.equal(f.sent.length, 0);
});

test('handleAlert: הדוח של עצמו לא נחקר ולא נוגע במכסה', async () => {
  const f = fakeDeps();
  await handleAlert({ subject: 'natbag AI: airspace anomaly', message: '' }, f.deps);
  assert.equal(f.claims.length, 0);
  assert.equal(f.sent.length, 0);
});

test('handleAlert: שגיאת Bedrock → מייל קצר אחד, בלי לזרוק (אין ניסיון חוזר)', async () => {
  const f = fakeDeps({ converse: async () => { const e = new Error('model access denied'); e.name = 'AccessDeniedException'; throw e; } });
  const r = await handleAlert({ subject: 'natbag: EMERGENCY squawk 7700', message: '' }, f.deps);
  assert.equal(r.reason, 'error');
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].s, /^natbag AI: investigation failed$/);
  assert.match(f.sent[0].m, /AccessDeniedException/);
});

test('israelDate', () => {
  assert.equal(israelDate(Date.UTC(2026, 10, 13, 21, 59)), '2026-11-13');
  assert.equal(israelDate(Date.UTC(2026, 10, 13, 22, 0)), '2026-11-14');
});
