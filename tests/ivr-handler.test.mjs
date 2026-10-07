// בדיקת /ivr ו-/flight דרך ה-handler של Lambda, עם data.gov.il ו-ADS-B מדומים (בלי רשת)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
// טיסה בעוד שעה, בשעון ישראל (כמו בלוח של רשות שדות התעופה)
const inAnHour = new Date(Date.now() + 3600e3).toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).replace(' ', 'T');
globalThis.fetch = async (url) => {
  const u = String(url); calls.push(u);
  if (u.includes('data.gov.il')) {
    return new Response(JSON.stringify({ success: true, result: { records: [
      { CHOPER: '6H', CHFLTN: '580', CHAORD: 'A', CHSTOL: inAnHour, CHPTOL: inAnHour, CHLOC1TH: 'זאגרב', CHRMINH: 'בזמן', CHRMINE: 'ON TIME' },
    ] } }));
  }
  if (u.includes('/callsign/ISR580')) return new Response(JSON.stringify({ ac: [{ flight: 'ISR580', lat: 32.25, lon: 35.2, alt_baro: 9800, gs: 280 }] }));
  if (u.includes('/callsign/')) return new Response(JSON.stringify({ ac: [] }));
  return new Response('not found', { status: 404 });
};

process.env.IVR_TOKEN = 's3cret';
const { handler } = await import('../natbag-aws/src/proxy/index.mjs');
const ev = (path, q = {}, method = 'GET', body) => ({ rawPath: path, queryStringParameters: q, requestContext: { http: { method } }, headers: {}, body });

test('/ivr בלי סיסמה נחסם', async () => {
  const r = await handler(ev('/ivr', { ApiPhone: '050' }));
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /גישה לא מורשית.*hangup/);
});

test('/ivr עם סיסמה: פתיחה ואז מידע על טיסה (GET)', async () => {
  let r = await handler(ev('/ivr', { token: 's3cret', ApiPhone: '050' }));
  assert.match(r.headers['Content-Type'], /text\/plain/);
  assert.match(r.body, /^read=t-שלום.*=menu,/);
  r = await handler(ev('/ivr', { token: 's3cret', menu: '4' }));
  assert.match(r.body, /=flight1,/);
  r = await handler(ev('/ivr', { token: 's3cret', flight1: '580' }));
  assert.match(r.body, /טיסת ישראייר מספר 580 מזאגרב/);
  assert.match(r.body, /המטוס באוויר כעת במרחק/);
  assert.ok(calls.some(u => u.includes('data.gov.il/api/3/action/datastore_search')));
});

test('/ivr עם POST (api_url_post=yes)', async () => {
  const r = await handler(ev('/ivr', {}, 'POST', 'token=s3cret&flight1=580'));
  assert.match(r.body, /=next1,/);
});

test('/flight?num=580 מחזיר JSON עם הקראה ומיקום', async () => {
  const r = await handler(ev('/flight', { num: '580' }));
  assert.equal(r.statusCode, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.matches[0].iata, '6H');
  assert.equal(j.live.callsign, 'ISR580');
  assert.ok(j.speech.length > 2);
});
