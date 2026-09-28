// detect.js – לוגיקת הזיהוי של מוניטור נתב"ג
// קובץ נפרד כדי שאפשר יהיה לבדוק אותו אוטומטית (tests/detect.test.mjs)
// עובד גם בדפדפן (window.NatbagDetect) וגם ב-Node (module.exports).
(function (root) {
  const toRad = x => x * Math.PI / 180;

  // מרחק בק"מ בין שתי נקודות (Haversine)
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371, dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }

  // כיוון (0°=צפון, עם כיוון השעון) מנקודה 1 לנקודה 2
  function bearingTo(lat1, lon1, lat2, lon2) {
    const dLon = toRad(lon2 - lon1);
    return (Math.atan2(
      Math.sin(dLon) * Math.cos(toRad(lat2)),
      Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon)
    ) * 180 / Math.PI + 360) % 360;
  }

  // ההפרש הקטן בין שני כיוונים (0–180)
  function angDiff(a, b) {
    let d = ((a - b) + 360) % 360;
    return d > 180 ? 360 - d : d;
  }

  // המרת רשומה גולמית (adsb.lol/airplanes.live/adsb.fi או OpenSky) ליחידות אחידות:
  // גובה במטרים, קצב אנכי במ'/ש', מהירות בקמ"ש
  function normalize(p, isAdsb) {
    let lat, lon, alt, vrate, speed, cs, id, og, track = null;
    if (isAdsb) {
      og = p.alt_baro === 'ground';
      const ft = og ? 0 : (typeof p.alt_baro === 'number' ? p.alt_baro : p.alt_geom);
      lat = p.lat; lon = p.lon;
      alt = ft != null ? ft * 0.3048 : null;
      const vr = p.baro_rate != null ? p.baro_rate : p.geom_rate;
      vrate = vr != null ? vr * 0.00508 : null;
      speed = p.gs != null ? p.gs * 1.852 : 0;
      cs = ((p.flight || '').replace(/[@\s]/g, '') || p.r || '').trim();
      id = p.hex || '';
      track = p.track != null ? p.track : (p.true_heading != null ? p.true_heading : null);
    } else {
      [id, cs, , , , lon, lat, alt, og, speed, track, vrate] = p;
      cs = (cs || '').trim();
      speed = speed != null ? speed * 3.6 : 0;
      if (track === undefined) track = null;
    }
    if (!lat || !lon) return null;
    return { id, cs, lat, lon, alt, vrate, speed: speed || 0, og: !!og, track };
  }

  // מגמת הסטייה לפי 3 הקריאות האחרונות: 'i' משתפר, 'w' מחמיר, 's' יציב
  function updateTrend(history, id, dev) {
    if (!history[id]) history[id] = [];
    history[id].push(dev);
    if (history[id].length > 8) history[id].shift();
    const h = history[id];
    if (h.length < 3) return 's';
    const r = h.slice(-3), a1 = (r[0] + r[1]) / 2, a2 = (r[1] + r[2]) / 2;
    return a2 < a1 - 2 ? 'i' : a2 > a1 + 2 ? 'w' : 's';
  }

  /**
   * סיווג מטוס אחד.
   * ctx = { lat, lon, radius, devThresh, finalKm, finalAlt, history }
   * מחזיר null אם המטוס מחוץ לטווח.
   */
  function classify(n, ctx) {
    const dist = haversine(n.lat, n.lon, ctx.lat, ctx.lon);
    if (dist > ctx.radius * 1.1) return null;
    const spd = n.speed;
    const alt = n.alt, vrate = n.vrate;

    // על הקרקע / מסיע – לא משתתף בלוגיקת הגישה
    const onGround = n.og || (spd < 80 && (alt == null || alt < 150));
    const bearing = bearingTo(n.lat, n.lon, ctx.lat, ctx.lon);
    // סטייה = הפרש בין כיוון הטיסה לבין הכיוון אל השדה
    const dev = n.track != null ? angDiff(n.track, bearing) : null;

    const c1 = dist <= ctx.radius;
    const c2 = alt != null && alt <= 4000;
    const c3 = vrate != null && vrate <= -1;
    const isDeparting = !onGround && vrate != null && vrate > 2;          // מטפס מעל 2 מ'/ש'
    const isApproach = !onGround && !isDeparting && [c1, c2, c3].filter(Boolean).length >= 2;
    const isFinal = isApproach && dist <= ctx.finalKm && alt != null && alt <= ctx.finalAlt && (vrate == null || vrate < 0);

    const trend = (isFinal && dev != null) ? updateTrend(ctx.history, n.id, dev) : 's';
    const enoughHistory = (ctx.history[n.id] || []).length >= 3;          // לפחות 3 קריאות רצופות
    const isAlert = isFinal && dev != null && dev > ctx.devThresh && enoughHistory && trend !== 'i';
    const sev = dev == null ? 'lo' : dev > ctx.devThresh * 2 ? 'hi' : dev > ctx.devThresh * 1.4 ? 'me' : 'lo';
    const eta = (!onGround && spd > 60) ? Math.round((dist / spd) * 60) : null;

    return {
      icao24: n.id, callsign: n.cs, lat: n.lat, lon: n.lon, track: n.track, alt, vrate, speed: spd,
      dist, dev, onGround, isDeparting, isApproach, isFinal, isAlert, sev, trend, eta, c1, c2, c3
    };
  }

  const api = { haversine, bearingTo, angDiff, normalize, updateTrend, classify };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NatbagDetect = api;
})(typeof window !== 'undefined' ? window : globalThis);
