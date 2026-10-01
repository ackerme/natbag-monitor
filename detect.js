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
    let lat, lon, alt, vrate, speed, cs, id, og, track = null, type = null, reg = null, squawk = null, category = null, dbFlags = 0, desc = null;
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
      type = p.t || null; reg = p.r || null; squawk = p.squawk || null;
      category = p.category || null; dbFlags = p.dbFlags || 0; desc = p.desc || null;
    } else {
      let osCat;
      [id, cs, , , , lon, lat, alt, og, speed, track, vrate, , , squawk, , , osCat] = p;
      category = { 2: 'A1', 3: 'A2', 4: 'A3', 5: 'A4', 6: 'A5', 8: 'A7' }[osCat] || null;
      squawk = squawk || null;
      cs = (cs || '').trim();
      speed = speed != null ? speed * 3.6 : 0;
      if (track === undefined) track = null;
    }
    if (!lat || !lon) return null;
    return { id, cs, lat, lon, alt, vrate, speed: speed || 0, og: !!og, track, type, reg, squawk, category, dbFlags, desc };
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
    const { cls, country } = aircraftClass(n);
    // התרעת סטייה – רק למטוסי נוסעים/מסחריים (לא מסוקים, מטוסים קלים או צבאיים)
    const isAlert = cls === 'passenger' && isFinal && dev != null && dev > ctx.devThresh && enoughHistory && trend !== 'i';
    const sev = dev == null ? 'lo' : dev > ctx.devThresh * 2 ? 'hi' : dev > ctx.devThresh * 1.4 ? 'me' : 'lo';
    const eta = (!onGround && spd > 60) ? Math.round((dist / spd) * 60) : null;

    return {
      icao24: n.id, callsign: n.cs, type: n.type || null, reg: n.reg || null, squawk: n.squawk || null, cls, country,
      lat: n.lat, lon: n.lon, track: n.track, alt, vrate, speed: spd,
      dist, dev, onGround, isDeparting, isApproach, isFinal, isAlert, sev, trend, eta, c1, c2, c3
    };
  }

  // ───────────── סוג כלי הטיס ─────────────
  // מבוסס על מה שהמטוס משדר ב-ADS-B: קטגוריה (A1 קל … A5 כבד, A7 מסוק), קוד דגם, דגל צבאי ו-callsign.
  const AIRLINER_TYPES = new Set(('A306 A310 A318 A319 A320 A20N A321 A21N A332 A333 A338 A339 A359 A35K A388 ' +
    'B737 B738 B739 B37M B38M B39M B3XM B752 B753 B762 B763 B764 B772 B77L B77W B778 B779 B788 B789 B78X B744 B748 ' +
    'E170 E175 E75L E75S E190 E195 E290 E295 AT72 AT75 AT76 DH8D CRJ7 CRJ9 CRJX BCS1 BCS3 SU95 A220 A221 A223').split(' '));
  const HELI_TYPES = new Set(('H60 S70 S76 S92 EC20 EC25 EC30 EC35 EC45 EC55 EC75 AS32 AS50 AS55 AS65 A109 A119 A139 A169 A189 ' +
    'B06 B407 B412 B429 B505 R22 R44 R66 UH1 H47 H64 CH47 V22 NH90 AW09').split(' '));
  // מטוסי תדלוק: KC-135 (K35R/K35E), KC-46 (K46/KC46), KC-10 (DC10 צבאי), A330 MRTT, בואינג 707 "ראם", KC-130
  const TANKER_TYPES = new Set(['K35R', 'K35E', 'K35T', 'KC35', 'K46', 'KC46', 'KC10', 'MRTT', 'K707', 'KC30', 'KC39', 'E390']);
  const TANKER_IF_MIL = new Set(['DC10', 'B762', 'B763', 'A332', 'B703', 'B707', 'C30J']);   // רק כשמסומן צבאי
  const TYPE_NAMES = { K35R: 'KC-135', K35E: 'KC-135', K35T: 'KC-135', KC35: 'KC-135', K46: 'KC-46', KC46: 'KC-46', B762: 'KC-46',
    KC10: 'KC-10', DC10: 'KC-10', MRTT: 'A330 MRTT', A332: 'A330 MRTT', B703: 'בואינג 707 "ראם"', B707: 'בואינג 707 "ראם"',
    K707: 'בואינג 707 "ראם"', C30J: 'KC-130J', KC30: 'KC-30', KC39: 'KC-390', E390: 'KC-390' };

  // מדינה לפי טווח כתובת ה-ICAO (24 ביט) שהוקצה לה
  function countryOf(hex) {
    const v = parseInt(String(hex || '').replace(/^~/, ''), 16);
    if (isNaN(v)) return null;
    if (v >= 0xA00000 && v <= 0xAFFFFF) return 'US';
    if (v >= 0x738000 && v <= 0x73FFFF) return 'IL';
    return null;
  }
  const isAirlineCallsign = cs => /^[A-Z]{3}\d[0-9A-Z]{0,4}$/.test(cs || '');

  /** מחזיר { cls: 'passenger'|'tanker'|'military'|'helicopter'|'light'|'other', country: 'US'|'IL'|null } */
  function aircraftClass(n) {
    const t = String(n.type || '').toUpperCase();
    const cat = String(n.category || '').toUpperCase();
    const mil = !!(n.dbFlags & 1);
    const desc = String(n.desc || '');
    const country = countryOf(n.id);
    if (TANKER_TYPES.has(t) || (mil && TANKER_IF_MIL.has(t)) || /tanker|stratotanker|pegasus|extender|mrtt|\bKC-?\d/i.test(desc))
      return { cls: 'tanker', country };
    if (cat === 'A7' || HELI_TYPES.has(t)) return { cls: 'helicopter', country };
    if (mil) return { cls: 'military', country };
    const bigCat = cat === 'A3' || cat === 'A4' || cat === 'A5';
    if (isAirlineCallsign(n.cs) && (bigCat || AIRLINER_TYPES.has(t) || (!cat && !t))) return { cls: 'passenger', country };
    if (AIRLINER_TYPES.has(t) && (bigCat || !cat)) return { cls: 'passenger', country };   // דגם נוסעים גם כשה-callsign משובש
    if (cat === 'A1' || cat === 'A2' || (t && !AIRLINER_TYPES.has(t))) return { cls: 'light', country };
    return { cls: 'other', country };
  }

  // מטוסי תדלוק צבאיים של ארה"ב/ישראל מתוך רשימה (מקומית או אזורית), בלי כפילויות
  function tankerStatus(list, center) {
    const seen = new Set(), tankers = [];
    for (const n of list) {
      if (!n || seen.has(n.id)) continue;
      const c = aircraftClass(n);
      if (c.cls !== 'tanker' || !(c.country === 'US' || c.country === 'IL')) continue;
      seen.add(n.id);
      const dist = center ? haversine(center.lat, center.lon, n.lat, n.lon) : null;
      const brg = center ? bearingTo(center.lat, center.lon, n.lat, n.lon) : null;
      tankers.push({ id: n.id, cs: n.cs, type: n.type, name: TYPE_NAMES[String(n.type || '').toUpperCase()] || n.type || 'מטוס תדלוק',
                     country: c.country, lat: n.lat, lon: n.lon, alt: n.alt, dist, brg });
    }
    tankers.sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0));
    return { count: tankers.length, tankers, multi: tankers.length >= 2 };
  }

  // ───────────── טיסות שהרבה אנשים עוקבים אחריהן (Flightradar24 "Most tracked") ─────────────
  // tracked: [{ id, flight, callsign, clicks, from, to, fromCity, toCity, model }]
  // local:   מטוסים מנורמלים באזור (בשביל התאמה לפי callsign)
  // רלוונטי = מעל הסף, וגם (יוצא/נוחת בנתב"ג, או נמצא עכשיו באזור)
  function trackedStatus(tracked, local, opts = {}) {
    const threshold = opts.threshold ?? 1000;
    const airport = opts.airport || 'TLV';
    const byCs = new Map();
    for (const n of local || []) if (n && n.cs) byCs.set(String(n.cs).trim().toUpperCase(), n);
    const seen = new Set(), flights = [];
    for (const f of tracked || []) {
      if (!f || !(Number(f.clicks) >= threshold)) continue;
      const key = f.id || f.callsign || f.flight;
      if (!key || seen.has(key)) continue;
      const cs = String(f.callsign || '').trim().toUpperCase();
      const near = cs ? byCs.get(cs) : null;
      const tlv = f.from === airport || f.to === airport;
      if (!near && !tlv) continue;
      seen.add(key);
      flights.push({ key, flight: f.flight || '', callsign: cs, clicks: Number(f.clicks),
                     from: f.from || '', to: f.to || '', fromCity: f.fromCity || '', toCity: f.toCity || '',
                     model: f.model || '', inArea: !!near, planeId: near ? near.id : null,
                     dir: f.to === airport ? 'A' : f.from === airport ? 'D' : '' });
    }
    flights.sort((a, b) => b.clicks - a.clicks);
    return { count: flights.length, flights };
  }

  // ───────────── מדד חריגה בתנועה האווירית ─────────────
  // שים לב: זה מדד לתנועה האווירית בלבד, לא מערכת התרעה.

  // האם השובל של מטוס מראה המתנה (סיבוב מלא): סכום הפניות ≥ 300°
  function isHolding(trail) {
    if (!trail || trail.length < 4) return false;
    const segs = [];
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1], b = trail[i];
      const d = haversine(a.lat, a.lon, b.lat, b.lon);
      if (d < 0.3) continue;                    // תזוזה קטנה מדי = רעש
      if (d > 20) { segs.length = 0; continue; } // קפיצה לא הגיונית (נקודה שגויה) – מתחילים מחדש
      segs.push(bearingTo(a.lat, a.lon, b.lat, b.lon));
    }
    if (segs.length < 3) return false;
    let turn = 0;
    for (let i = 1; i < segs.length; i++) turn += ((segs[i] - segs[i - 1] + 540) % 360) - 180;
    return Math.abs(turn) >= 300;
  }

  // מטוס שהיה בגישה בעשר הדקות האחרונות, ועכשיו פונה מהשדה ומתרחק
  function isTurnBack({ wasApproaching, onGround, isApproach, dev, prevDist, dist }) {
    return !!wasApproaching && !onGround && !isApproach && dev != null && dev > 120 &&
           prevDist != null && dist > prevDist + 0.5;
  }

  /**
   * history: [{ t, airborne, finals, holding, turnBacks, emergencies }] – דגימה אחת בכל רענון
   * מחזיר { level: 'normal'|'unusual'|'major', score, reasons[], baselineReady, collectedMin }
   */
  function airspaceStatus(history, now) {
    const reasons = [];
    let score = 0;
    if (!history || !history.length) return { level: 'normal', score: 0, reasons, baselineReady: false, collectedMin: 0 };
    const cur = history[history.length - 1];
    const recent = history.filter(h => now - h.t <= 10 * 60e3);
    const base = history.filter(h => now - h.t > 10 * 60e3 && now - h.t <= 60 * 60e3);
    const collectedMin = Math.round((now - history[0].t) / 60e3);
    const baselineReady = base.length >= 5 && (base[base.length - 1].t - base[0].t) >= 10 * 60e3;
    const avg = (arr, k) => arr.reduce((s, h) => s + (h[k] || 0), 0) / arr.length;

    if (cur.holding >= 3) { score += 2; reasons.push(`${cur.holding} מטוסים בהמתנה (טסים במעגלים)`); }
    else if (cur.holding >= 1) { score += 1; reasons.push(`${cur.holding === 1 ? 'מטוס אחד' : cur.holding + ' מטוסים'} בהמתנה (טס במעגלים)`); }

    const turnBacks = Math.max(0, ...recent.map(h => h.turnBacks || 0));
    if (turnBacks >= 2) { score += 2; reasons.push(`${turnBacks} מטוסים שהיו בגישה לנתב"ג הסתובבו והתרחקו`); }
    else if (turnBacks === 1) { score += 1; reasons.push('מטוס שהיה בגישה לנתב"ג הסתובב והתרחק'); }

    if (cur.emergencies >= 1) { score += 2; reasons.push('מטוס משדר קוד חירום (7700/7600)'); }

    if (baselineReady) {
      const baseFinals = avg(base, 'finals'), baseAir = avg(base, 'airborne');
      const recentFinals = Math.max(...recent.map(h => h.finals || 0));
      if (recentFinals === 0 && baseFinals >= 1.5) {
        score += 3; reasons.push(`אין מטוסים בגישה סופית ב-10 הדקות האחרונות (בדרך כלל ~${baseFinals.toFixed(1)})`);
      }
      if (baseAir >= 6 && cur.airborne <= baseAir * 0.4) {
        score += 2; reasons.push(`ירידה חדה במספר המטוסים באוויר (${cur.airborne} לעומת ממוצע ${Math.round(baseAir)})`);
      }
    }
    const level = score >= 4 ? 'major' : score >= 2 ? 'unusual' : 'normal';
    return { level, score, reasons, baselineReady, collectedMin };
  }

  const api = { haversine, bearingTo, angDiff, normalize, updateTrend, classify, isHolding, isTurnBack, airspaceStatus, aircraftClass, tankerStatus, countryOf, trackedStatus };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NatbagDetect = api;
})(typeof window !== 'undefined' ? window : globalThis);
