// בדיקות ל-natbag-exporter (ops/monitoring/exporter): פורמט Prometheus ומדדים מנתוני ADS-B אמיתיים
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { render, aircraftMetrics, statsMetrics } from '../ops/monitoring/exporter/exporter.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/' + ('tlv-sample.json'), import.meta.url)));

test('render: פורמט Prometheus תקין, תוויות עם תווים מיוחדים, ערכים ריקים לא נכתבים', () => {
  const txt = render([{ name: 'x_total', type: 'counter', help: 'בדיקה', samples: [
    { labels: { a: 'say "hi"\\n' }, value: 3 }, { labels: { a: 'b' }, value: null }] }]);
  assert.equal(txt, '# HELP x_total בדיקה\n# TYPE x_total counter\nx_total{a="say \\"hi\\"\\\\n"} 3\n');
});

test('aircraftMetrics: סופר נוחתים, ממריאים ואחרים, ומטוסים על הקרקע', () => {
  const txt = render(aircraftMetrics(fixture));
  const val = re => Number((txt.match(re) || [])[1]);
  const arr = val(/natbag_aircraft\{move="arr"\} (\d+)/), dep = val(/natbag_aircraft\{move="dep"\} (\d+)/), oth = val(/natbag_aircraft\{move="other"\} (\d+)/);
  assert.ok(arr + dep + oth > 0, 'יש מטוסים באוויר');
  assert.ok(val(/natbag_aircraft_on_ground (\d+)/) > 0, 'יש מטוסים על הקרקע בנתב"ג');
  assert.match(txt, /natbag_data_source_info\{source="adsb.lol"\} 1/);
  assert.match(txt, /# TYPE natbag_aircraft gauge/);
});

test('statsMetrics: מדדי היום ומצב המערכת', () => {
  const now = 1_800_000_000_000;
  const txt = render(statsMetrics({ today: { landings: 81, departures: 70, alerts: 1, maxAirborne: 14, anomalyMinutes: { unusual: 6, major: 1 } },
    status: { uptime30: 99.86, uptimeToday: 100, avgLatencyToday: 412, lastCheck: { t: now - 120e3, pass: true } } }, now));
  assert.match(txt, /natbag_landings_today 81/);
  assert.match(txt, /natbag_anomaly_seconds_today\{level="major"\} 60/);
  assert.match(txt, /natbag_last_healthcheck_age_seconds 120/);
  assert.match(txt, /natbag_last_healthcheck_passed 1/);
  // בלי today (תחילת יום) – רק מדדי המערכת
  assert.doesNotMatch(render(statsMetrics({ status: {} }, now)), /natbag_landings_today/);
});

test('statsMetrics: קו הטלפון', () => {
  const txt = render(statsMetrics({ status: {}, phone: { today: { calls: 5, callers: 4, requests: 19, byExt: { arr: 3, flight: 2 } } } }));
  assert.match(txt, /natbag_phone_calls_today 5/);
  assert.match(txt, /natbag_phone_callers_today 4/);
  assert.match(txt, /natbag_phone_ext_calls_today\{ext="arr"\} 3/);
});
