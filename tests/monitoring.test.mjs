// בדיקות לניטור: מדדי EMF מהשרת ובדיקת הזמינות (natbag-healthcheck). הרצה: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChecks, runChecks, metricLine } from '../natbag-aws/src/healthcheck/index.mjs';

const PROXY = 'https://abc.lambda-url.us-east-1.on.aws/';
const SITE = 'https://ackerme.github.io/natbag-monitor/monitor.html';

const fakeFetch = (bad = {}) => async (url) => {
  if (bad.throw && url.includes(bad.throw)) throw new Error('timeout');
  if (url.endsWith('/health')) return new Response(JSON.stringify({ ok: !bad.health }));
  if (url.includes('/aircraft')) return new Response(JSON.stringify(bad.aircraft ? { error: 'x' } : { ac: [] }));
  if (url === SITE) return new Response(bad.site ? 'not found' : '<title>מוניטור נתב"ג</title>', { status: bad.site ? 404 : 200 });
  return new Response('?', { status: 404 });
};

test('healthcheck: בונה 3 בדיקות, ובלי SITE_URL רק 2', () => {
  assert.deepEqual(buildChecks(PROXY, SITE).map(c => c.name), ['health', 'aircraft', 'site']);
  assert.deepEqual(buildChecks('https://abc.lambda-url.us-east-1.on.aws', '').map(c => c.url),
    [`${PROXY}health`, `${PROXY}aircraft?lat=32.0055&lon=34.8854&dist=43`]);
});

test('healthcheck: הכול תקין → HealthCheckFailed = 0', async () => {
  const res = await runChecks(buildChecks(PROXY, SITE), fakeFetch());
  assert.ok(res.every(r => r.pass));
  const m = metricLine(res, 1);
  assert.equal(m.HealthCheckFailed, 0);
  assert.equal(m._aws.CloudWatchMetrics[0].Namespace, 'Natbag');
  assert.deepEqual(m._aws.CloudWatchMetrics[0].Metrics.map(x => x.Name), ['HealthCheckFailed', 'HealthCheckLatency']);
});

test('healthcheck: אתר נפל / /aircraft בלי ac / timeout → HealthCheckFailed = 1', async () => {
  for (const bad of [{ site: 1 }, { aircraft: 1 }, { health: 1 }, { throw: '/health' }]) {
    const res = await runChecks(buildChecks(PROXY, SITE), fakeFetch(bad));
    assert.equal(metricLine(res).HealthCheckFailed, 1, JSON.stringify(bad));
  }
});

test('proxy: כשכל מקורות ADS-B נופלים נכתב מדד UpstreamFailure{Route=aircraft}', async () => {
  const realFetch = globalThis.fetch, realWrite = process.stdout.write.bind(process.stdout), realErr = console.error;
  const lines = [];
  globalThis.fetch = async () => new Response('down', { status: 503 });
  process.stdout.write = (s) => { lines.push(String(s).trim()); return true; }; console.error = () => {};
  try {
    const { handler } = await import('../natbag-aws/src/proxy/index.mjs?emf');
    const r = await handler({ rawPath: '/aircraft', queryStringParameters: { lat: '32', lon: '34.9', dist: '77' }, requestContext: { http: { method: 'GET' } }, headers: {} });
    assert.equal(r.statusCode, 502);
  } finally { globalThis.fetch = realFetch; process.stdout.write = realWrite; console.error = realErr; }
  const emf = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(j => j && j._aws);
  const f = emf.find(j => j.UpstreamFailure === 1);
  assert.ok(f, 'אין שורת EMF');
  assert.equal(f.Route, 'aircraft');
  assert.deepEqual(f._aws.CloudWatchMetrics[0].Dimensions, [['Route']]);
});

test('staging: METRICS_NAMESPACE ריק → לא נכתבים מדדים; /health מחזיר stage', async () => {
  const { emitMetric, handler } = await import('../natbag-aws/src/proxy/index.mjs?stage');
  const realWrite = process.stdout.write.bind(process.stdout), lines = [];
  process.stdout.write = (s) => { lines.push(String(s)); return true; };
  try {
    process.env.METRICS_NAMESPACE = '';
    emitMetric('SourceUsed', 'Source', 'adsb.lol');
    process.env.METRICS_NAMESPACE = 'Natbag';
    emitMetric('SourceUsed', 'Source', 'adsb.lol');
  } finally { process.stdout.write = realWrite; delete process.env.METRICS_NAMESPACE; }
  assert.equal(lines.length, 1);
  process.env.STAGE = 'staging';
  const r = await handler({ rawPath: '/health', queryStringParameters: {}, requestContext: { http: { method: 'GET' } }, headers: {} });
  delete process.env.STAGE;
  assert.equal(JSON.parse(r.body).stage, 'staging');
});
