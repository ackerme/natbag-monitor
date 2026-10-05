// flights.mjs – מידע טיסות לנתב"ג + קו טלפוני (IVR) לטלפונים כשרים דרך "ימות המשיח"
//
// מקורות:
//   • לוח הטיסות הרשמי של רשות שדות התעופה (data.gov.il) – שעות מתוכננות/מעודכנות וסטטוס
//   • ADS-B (adsb.lol / airplanes.live) לפי callsign – מיקום חי של המטוס
//
// כל הפונקציות כאן "טהורות" או מקבלות את מקורות הנתונים כפרמטר (deps),
// כדי שאפשר יהיה לבדוק אותן בלי רשת (tests/ivr.test.mjs).

export const TLV = { lat: 32.0055, lon: 34.8854 };

// קוד IATA (מלוח הטיסות) → קוד ICAO (callsign ב-ADS-B) + שם בעברית להקראה
export const AIRLINES = {
  LY: ['ELY', 'אל על'], '6H': ['ISR', 'ישראייר'], IZ: ['AIZ', 'ארקיע'], TK: ['THY', 'טורקיש איירליינס'],
  PC: ['PGT', 'פגסוס'], EK: ['UAE', 'אמירייטס'], FZ: ['FDB', 'פליי דובאי'], EY: ['ETD', 'אתיחאד'],
  FR: ['RYR', 'ריינאייר'], W6: ['WZZ', 'וויז אייר'], U2: ['EZY', 'איזיגט'], EC: ['EJU', 'איזיגט'],
  LH: ['DLH', 'לופטהנזה'], BA: ['BAW', 'בריטיש איירווייז'], AF: ['AFR', 'אייר פראנס'], KL: ['KLM', 'קיי אל אם'],
  LX: ['SWR', 'סוויס'], OS: ['AUA', 'אוסטריאן'], SN: ['BEL', 'בראסלס איירליינס'], AZ: ['ITY', 'איטה'],
  A3: ['AEE', 'אגאן'], LO: ['LOT', 'לוט'], TP: ['TAP', 'טאפ'], IB: ['IBE', 'איבריה'], VY: ['VLG', 'וואלינג'],
  UA: ['UAL', 'יונייטד'], DL: ['DAL', 'דלתא'], AA: ['AAL', 'אמריקן איירליינס'], AC: ['ACA', 'אייר קנדה'],
  ET: ['ETH', 'אתיופיאן'], MS: ['MSR', 'איגיפטאייר'], RJ: ['RJA', 'רויאל גורדניאן'], GF: ['GFA', 'גאלף אייר'],
  AI: ['AIC', 'אייר אינדיה'], CX: ['CPA', 'קתאיי פסיפיק'], AY: ['FIN', 'פינאייר'], SK: ['SAS', 'סאס'],
  QS: ['TVS', 'סמארטווינגס'], BZ: ['BBG', 'בלו בירד'], XQ: ['SXS', 'סאן אקספרס'], HV: ['TRA', 'טרנסאוויה'],
  HY: ['UZB', 'אוזבקיסטן איירווייז'], '5K': ['HFY', 'היי פליי'], CY: ['CYP', 'סייפרוס איירווייז'],
};

// ימות המשיח לא מקבלת בטקסט להקראה את התווים: . - " ' & |  (ורווחים כפולים מיותרים)
export function say(text) {
  return String(text ?? '').replace(/[-–]/g, ' ').replace(/[."'&|׳״`]/g, '').replace(/[,=]/g, ' ').replace(/\s+/g, ' ').trim();
}

const toRad = x => x * Math.PI / 180;
export function haversine(a, b, c, d) {
  const x = Math.sin(toRad(c - a) / 2) ** 2 + Math.cos(toRad(a)) * Math.cos(toRad(c)) * Math.sin(toRad(d - b) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
export function bearingTo(a, b, c, d) {
  const dl = toRad(d - b);
  return (Math.atan2(Math.sin(dl) * Math.cos(toRad(c)), Math.cos(toRad(a)) * Math.sin(toRad(c)) - Math.sin(toRad(a)) * Math.cos(toRad(c)) * Math.cos(dl)) * 180 / Math.PI + 360) % 360;
}
const DIRS = ['צפון', 'צפון מזרח', 'מזרח', 'דרום מזרח', 'דרום', 'דרום מערב', 'מערב', 'צפון מערב'];
export const dirName = deg => DIRS[Math.round(deg / 45) % 8];

// "עכשיו" בשעון ישראל, באותו "מסגרת" שבה מפרשים את השעות מלוח הטיסות (בלי אזור זמן)
export function israelNowMs(now = Date.now()) {
  const s = new Date(now).toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).replace(' ', 'T');
  return Date.parse(s + 'Z');
}
const localMs = s => (s ? Date.parse(String(s).slice(0, 19) + 'Z') : NaN);

// "2026-09-29T14:05:00" → "14 ו 5 דקות" (+ "מחר"/"אתמול" אם צריך)
export function speakTime(s, nowIl) {
  const t = localMs(s); if (isNaN(t)) return '';
  const d = new Date(t), hh = d.getUTCHours(), mm = d.getUTCMinutes();
  const day = Math.floor(t / 864e5) - Math.floor(nowIl / 864e5);
  const pre = day === 1 ? 'מחר ' : day === -1 ? 'אתמול ' : '';
  return `${pre}בשעה ${hh}${mm ? ` ו ${mm} דקות` : ''}`;
}

// רשומה מלוח הטיסות → אובייקט נוח
export function parseBoardRecord(r) {
  const iata = String(r.CHOPER || '').trim().toUpperCase();
  const num = String(r.CHFLTN || '').trim();
  const al = AIRLINES[iata];
  return {
    iata, num, digits: String(parseInt(num, 10) || num),
    airlineHe: al ? al[1] : String(r.CHOPERD || iata),
    icao: al ? al[0] : null,
    dir: String(r.CHAORD || '').trim().toUpperCase(),          // A = נחיתה, D = המראה
    sched: r.CHSTOL || null, est: r.CHPTOL || null,
    cityHe: r.CHLOC1TH || r.CHLOC1D || '',
    statusHe: r.CHRMINH || '', statusEn: String(r.CHRMINE || '').toUpperCase(),
    terminal: r.CHTERM || null,
  };
}

// חיפוש לפי הספרות שהמתקשר הקיש. מחזיר את הטיסות הקרובות בזמן (12 שעות אחורה עד 24 קדימה), מסודרות לפי קרבה לעכשיו.
export function findFlights(board, digits, nowIl) {
  const want = String(parseInt(digits, 10));
  if (want === 'NaN') return [];
  const seen = new Set();
  return board
    .filter(f => f.digits === want)
    .filter(f => { const t = localMs(f.est || f.sched); return isNaN(t) || (t >= nowIl - 12 * 36e5 && t <= nowIl + 24 * 36e5); })
    .sort((a, b) => (a.dir === b.dir ? 0 : a.dir === 'A' ? -1 : 1) ||
                    Math.abs(localMs(a.est || a.sched) - nowIl) - Math.abs(localMs(b.est || b.sched) - nowIl))
    .filter(f => { const k = f.iata + f.num + f.dir; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 9);
}

// callsign אפשריים ב-ADS-B: ELY + 27 → ELY27, ELY027 (אל על משתמשת ב-3 ספרות), ELY0027
export function callsignCandidates(f) {
  if (!f.icao) return [];
  const n = String(parseInt(f.num, 10));
  return [...new Set([f.icao + n, f.icao + n.padStart(3, '0'), f.icao + n.padStart(4, '0')])];
}

// מיקום חי (אם נמצא) → טקסט להקראה
export function liveSentence(ac) {
  if (!ac || ac.lat == null || ac.lon == null) return '';
  if (ac.alt_baro === 'ground') {
    const dGround = haversine(ac.lat, ac.lon, TLV.lat, TLV.lon);
    return dGround < 5 ? 'המטוס נמצא על הקרקע בנמל התעופה' : '';
  }
  const dist = haversine(TLV.lat, TLV.lon, ac.lat, ac.lon);
  const dir = dirName(bearingTo(TLV.lat, TLV.lon, ac.lat, ac.lon));
  const altM = typeof ac.alt_baro === 'number' ? Math.round(ac.alt_baro * 0.3048 / 100) * 100 : null;
  const kmh = ac.gs ? ac.gs * 1.852 : 0;
  let s = `המטוס באוויר כעת במרחק ${Math.round(dist)} קילומטר ${dir} לנמל התעופה`;
  if (altM) s += ` בגובה ${altM} מטר`;
  if (kmh > 150 && dist > 3) s += ` לפי המיקום והמהירות הנוכחיים הנחיתה בעוד כ ${Math.max(1, Math.round(dist / kmh * 60 + 8))} דקות`;
  return s;
}

// תשובה מלאה על טיסה
export function flightAnswer(f, ac, nowIl) {
  const parts = [];
  const isArr = f.dir !== 'D';
  parts.push(`טיסת ${f.airlineHe} מספר ${f.digits} ${isArr ? 'מ' : 'ל'}${f.cityHe}`);
  if (f.statusHe) parts.push(`סטטוס ${f.statusHe}`);
  const landed = /LANDED|נחת/.test(f.statusEn + f.statusHe);
  const departed = /DEPARTED|המריא/.test(f.statusEn + f.statusHe);
  const canceled = /CANCEL|מבוטל/.test(f.statusEn + f.statusHe);
  if (!canceled) {
    if (isArr) {
      if (landed) parts.push(`הטיסה נחתה ${speakTime(f.est || f.sched, nowIl)}`);
      else {
        parts.push(`נחיתה מתוכננת ${speakTime(f.sched, nowIl)}`);
        if (f.est && f.est !== f.sched) parts.push(`זמן נחיתה מעודכן ${speakTime(f.est, nowIl)}`);
      }
    } else {
      if (departed) parts.push(`הטיסה המריאה ${speakTime(f.est || f.sched, nowIl)}`);
      else {
        parts.push(`המראה מתוכננת ${speakTime(f.sched, nowIl)}`);
        if (f.est && f.est !== f.sched) parts.push(`זמן המראה מעודכן ${speakTime(f.est, nowIl)}`);
      }
    }
  }
  if (f.terminal) parts.push(`טרמינל ${f.terminal}`);
  const live = (isArr && !landed && !canceled) ? liveSentence(ac) : '';
  if (live) parts.push(live);
  return parts.map(say).filter(Boolean);
}

// ───────── פרוטוקול ימות המשיח ─────────
// פריט שמתחיל ב-f- הוא קובץ שמע שהועלה לימות המשיח (מושמע כמו שהוא), כל השאר טקסט להקראה
const msg = arr => arr.map(t => (/^f-\/?\d+$/.test(t) ? t : 't-' + say(t))).filter(x => x.length > 2).join('.');
// read=<הודעות>=<משתנה>,<להקיש מחדש אם קיים>,<מקס ספרות>,<מינ ספרות>,<שניות המתנה>,<השמעת הקשה>,<חסימת כוכבית>,<חסימת 0>,<החלפת תו>,<ספרות מותרות>
const read = (texts, name, { max = 5, min = 1, sec = 10, allowed = '' } = {}) =>
  `read=${msg(texts)}=${name},yes,${max},${min},${sec},No,yes,no,,${allowed},,,,`;
const idList = texts => `id_list_message=${msg(texts)}&`;
const HANGUP = 'go_to_folder=hangup';

const lastVal = v => (v == null ? undefined : String(v).split(',').pop());

/**
 * מצב השיחה נשמר אצל ימות המשיח (כל משתנה שהוקש נשלח שוב בכל בקשה) – השרת עצמו בלי מצב.
 * סבב n: flight{n} = מספר טיסה, pick{n} = בחירה כשיש כמה טיסות, next{n} = מה עכשיו.
 * deps = { getBoard: async () => [parsed records], getLive: async (flight) => ac|null, now?: ms }
 */
// ───────── שלוחה 2: כלי הטיס שבאוויר סביב נמל התעופה ─────────
export const PLANES_RADIUS_KM = 100;
// חברות נוספות שעוברות באזור (בעיקר טיסות שחוצות את המרחב האווירי או טיסות מטען), לפי קוד ICAO שב-callsign
const EXTRA_ICAO_HE = {
  // ישראל
  ICL: 'סי איי אל קרגו',
  // המפרץ והמזרח התיכון
  QTR: 'קטאר איירווייז', SVA: 'סעודיה', FAD: 'פליי אדיל', KNE: 'פליי נאס', KAC: 'כווית איירווייז', JZR: 'ג׳זירה איירווייז',
  OMA: 'עומאן אייר', OMS: 'סלאם אייר', ABY: 'אייר עריביה', MEA: 'מידל איסט איירליינס', IAW: 'עיראקי איירווייז', NIA: 'נייל אייר',
  AXB: 'אייר אינדיה אקספרס', IGO: 'אינדיגו', VTI: 'ויסטרה', PIA: 'פקיסטן איירליינס', ALK: 'סרילנקן', BBC: 'בימן בנגלדש',
  ETH: 'אתיופיאן', KQA: 'קניה איירווייז', RAM: 'רויאל אייר מרוקו', TAR: 'טוניסאייר', DAH: 'אייר אלג׳יר',
  // אסיה
  SIA: 'סינגפור איירליינס', THA: 'תאי איירווייז', KAL: 'קוריאן אייר', AAR: 'אסיאנה', CCA: 'אייר צ׳יינה', CES: 'צ׳יינה איסטרן',
  CSN: 'צ׳יינה סאות׳רן', CHH: 'היינאן איירליינס', HVN: 'וייטנאם איירליינס', VJC: 'וייטג׳ט', JAL: 'ג׳פן איירליינס', ANA: 'אול ניפון',
  KZR: 'אייר אסטנה', AHY: 'אזרבייג׳ן איירליינס', AZV: 'אזימות', AFL: 'אירופלוט', SBI: 'אס 7', UZB: 'אוזבקיסטן איירווייז',
  // אירופה
  NOZ: 'נורווגיאן', NSZ: 'נורווגיאן', IBK: 'נורווגיאן', CFG: 'קונדור', TUI: 'טואי', TFL: 'טואי', TOM: 'טואי', EWG: 'יורווינגס',
  EXS: 'ג׳ט 2', TVF: 'טרנסאוויה', VOE: 'וולוטיאה', BTI: 'אייר בלטיק', LZB: 'בולגריה אייר', ROT: 'טרום', ASL: 'אייר סרביה',
  CTN: 'קרואטיה איירליינס', AEA: 'אייר אירופה', MSC: 'אייר קהיר', ENT: 'אנטר אייר', WMT: 'וויז אייר מלטה', WAZ: 'וויז אייר',
  WUK: 'וויז אייר', SXS: 'סאן אקספרס', CAI: 'קורנדון', AJA: 'אנאדולו ג׳ט',
  LGL: 'לוקסאייר', DLA: 'אייר דולומיטי',
  // מטען
  FDX: 'פדקס', UPS: 'יו פי אס', GTI: 'אטלס אייר', CLX: 'קרגולוקס', BOX: 'אירולוג׳יק', CKS: 'קליטה', MPH: 'מרטינייר',
  ABW: 'אייר ברידג׳ קרגו', CAO: 'אייר צ׳יינה קרגו', DHK: 'די אייץ׳ אל', BCS: 'די אייץ׳ אל', SQC: 'סינגפור קרגו',
  // ארה"ב
  JBU: 'ג׳טבלו', AAY: 'אלג׳יאנט', RCH: 'חיל האוויר האמריקאי',
};
const ICAO_HE = { ...EXTRA_ICAO_HE, ...Object.fromEntries(Object.values(AIRLINES).map(([icao, he]) => [icao, he])) };
export const AIRLINE_NAME_BY_ICAO = ICAO_HE;

// קוד דגם ב-ADS-B (B789, A20N...) → שם להקראה
const TYPE_HE = { A20N: 'איירבוס 320 ניאו', A21N: 'איירבוס 321 ניאו', A19N: 'איירבוס 319 ניאו', BCS1: 'איירבוס 220', BCS3: 'איירבוס 220',
  B38M: 'בואינג 737 מקס', B39M: 'בואינג 737 מקס', B37M: 'בואינג 737 מקס', B3XM: 'בואינג 737 מקס',
  AT72: 'אי טי אר 72', AT75: 'אי טי אר 72', AT76: 'אי טי אר 72', DH8D: 'דאש 8', CRJ9: 'בומברדייה סי אר ג׳יי',
  K35R: 'מטוס תדלוק קיי סי 135', C17: 'מטוס תובלה סי 17', C30J: 'הרקולס', C130: 'הרקולס', B703: 'בואינג 707' };
export function typeHe(t) {
  t = String(t || '').toUpperCase();
  if (!t) return '';
  if (TYPE_HE[t]) return TYPE_HE[t];
  let m;
  if ((m = /^A3(\d)(\d)$/.exec(t))) return `איירבוס 3${m[1]}0`;            // A332 → איירבוס 330
  if ((m = /^A(3[12]\d)$/.exec(t))) return `איירבוס ${m[1]}`;              // A320/A321/A319
  if ((m = /^B7(\d)[\dWLFX]$/.exec(t))) return `בואינג 7${m[1]}7`;           // B738 → 737, B789 → 787, B77W → 777
  if ((m = /^E(1|2)(\d)\d$/.exec(t))) return 'אמבראר';
  return '';
}

// רשימת ADS-B → כלי הטיס שבאוויר ברדיוס, מהקרוב לרחוק, מוכנים להקראה
export function planesNear(acList, radiusKm = PLANES_RADIUS_KM) {
  return (acList || [])
    .filter(a => a && a.lat != null && a.lon != null && a.alt_baro !== 'ground')
    .map(a => {
      const dist = haversine(TLV.lat, TLV.lon, a.lat, a.lon);
      const cs = String(a.flight || '').trim().toUpperCase();
      const m = /^([A-Z]{3})(\d+)[0-9A-Z]{0,3}$/.exec(cs);   // QTR8AB, SVA38H, ELY027
      const altM = typeof a.alt_baro === 'number' ? Math.round(a.alt_baro * 0.3048 / 100) * 100 : null;
      const rate = typeof a.baro_rate === 'number' ? a.baro_rate : 0;
      const kind = a.category === 'A7' ? 'מסוק' : (a.category === 'A1' || a.category === 'A2') ? 'מטוס קל'
                 : (a.dbFlags & 1) ? 'כלי טיס צבאי' : null;
      let name;
      if (m && ICAO_HE[m[1]]) name = `${ICAO_HE[m[1]]} טיסה ${parseInt(m[2], 10)}`;
      else if (kind) name = kind;
      else if (/^4X[A-Z]{3}$/.test(cs)) name = 'מטוס פרטי ישראלי';
      else if (m) name = `מטוס של חברה זרה טיסה ${parseInt(m[2], 10)}`;
      else name = 'מטוס';
      // האם בנחיתה – תמיד אומרים במפורש
      let phase;
      if (rate < -300 && dist < 60 && altM != null && altM < 3500) phase = 'בגישה לנחיתה בנמל התעופה';
      else if (rate < -300) phase = 'בירידה';
      else if (rate > 300 && dist < 40 && altM != null && altM < 4000) phase = 'בטיפוס אחרי המראה';
      else if (rate > 300) phase = 'בטיפוס';
      else phase = 'בטיסה רגילה ולא בנחיתה';
      const model = kind === 'מסוק' || kind === 'מטוס קל' ? '' : typeHe(a.t);
      // נוחת / ממריא: לפי כיוון הטיסה ביחס לשדה, גובה וקצב טיפוס/ירידה
      const brg = bearingTo(TLV.lat, TLV.lon, a.lat, a.lon);
      const track = typeof a.track === 'number' ? a.track : null;
      const ang = (x, y) => { const d = Math.abs(((x - y) % 360 + 360) % 360); return d > 180 ? 360 - d : d; };
      const toward = track != null && ang(track, (brg + 180) % 360) < 60;      // טס לכיוון השדה
      const away = track != null && ang(track, brg) < 70;                      // טס הרחק מהשדה
      const kmh = typeof a.gs === 'number' ? a.gs * 1.852 : null;
      const move = (toward && altM != null && altM < 6000 && (rate < -200 || altM < 2500)) ? 'arr'
                 : (away && rate > 200 && dist < 60 && altM != null && altM < 7000) ? 'dep' : null;
      const eta = move === 'arr' && kmh > 100 ? Math.max(1, Math.round(dist / kmh * 60 + 3)) : null;   // + ~3 דק' לגישה הסופית
      return { name, model, dist, dir: dirName(brg), altM, phase, move, eta };
    })
    .filter(p => p.dist <= radiusKm)
    .sort((a, b) => a.dist - b.dist);
}
export function planeSentence(p, i) {
  return say(`מספר ${i} ${p.name}${p.model ? ` ${p.model}` : ''} במרחק ${Math.round(p.dist)} קילומטר ${p.dir} לנמל התעופה` +
             `${p.altM ? ` בגובה ${p.altM} מטר` : ''}${p.phase ? ` ${p.phase}` : ''}`);
}

// ───────── לוח הטיסות: הנחיתות / ההמראות הבאות (בשעה הקרובה) ─────────
const isDone = f => /LANDED|DEPARTED|CANCEL|נחת|המריא|מבוטל/.test(f.statusEn + f.statusHe);
export function nextFromBoard(board, dir, nowIl, minutes = 60, max = 6) {
  return (board || [])
    .filter(f => f.dir === dir && !isDone(f))
    .map(f => ({ f, t: localMs(f.est || f.sched) }))
    .filter(x => !isNaN(x.t) && x.t >= nowIl - 15 * 60e3 && x.t <= nowIl + minutes * 60e3)
    .sort((a, b) => a.t - b.t)
    .slice(0, max)
    .map(x => x.f);
}
export function boardSentence(f, nowIl) {
  const arr = f.dir === 'A';
  return say(`${f.airlineHe} טיסה ${f.digits} ${arr ? 'מ' : 'ל'}${f.cityHe} ${arr ? 'נחיתה צפויה' : 'המראה צפויה'} ${speakTime(f.est || f.sched, nowIl)}` +
             `${f.statusHe ? ` סטטוס ${f.statusHe}` : ''}`);
}
function liveArrSentence(p, i) {
  return say(`מספר ${i} ${p.name}${p.model ? ` ${p.model}` : ''} במרחק ${Math.round(p.dist)} קילומטר ${p.dir} לנמל התעופה` +
             `${p.altM ? ` בגובה ${p.altM} מטר` : ''}${p.eta ? ` נחיתה בעוד כ ${p.eta} דקות` : ''}`);
}
function liveDepSentence(p, i) {
  return say(`מספר ${i} ${p.name}${p.model ? ` ${p.model}` : ''} במרחק ${Math.round(p.dist)} קילומטר ${p.dir} לנמל התעופה` +
             `${p.altM ? ` בגובה ${p.altM} מטר` : ''} ובטיפוס`);
}

/**
 * בונה את כל המשפטים של שלוחה: kind = 'arr' (נחיתות) / 'dep' (המראות) / 'all' (כל כלי הטיס)
 * נחיתות/המראות = קודם מה שקורה באוויר עכשיו (ADS-B), ואחר כך מה שמתוכנן בשעה הקרובה (לוח הטיסות).
 */
export async function buildList(kind, deps, nowIl) {
  let live = null;
  try { live = planesNear(await deps.getNear()); } catch (e) { deps.onError?.('planes', e); }
  if (kind === 'all') {
    if (!live) return null;
    return [live.length
      ? `בטווח ${PLANES_RADIUS_KM} קילומטר מנמל התעופה בן גוריון יש כרגע ${live.length === 1 ? 'כלי טיס אחד' : live.length + ' כלי טיס'} באוויר`
      : `אין כרגע כלי טיס באוויר בטווח ${PLANES_RADIUS_KM} קילומטר מנמל התעופה`,
      ...live.map((p, i) => planeSentence(p, i + 1))];
  }
  let board = null;
  try { board = await deps.getBoard(); } catch (e) { deps.onError?.('board', e); }
  if (!live && !board) return null;
  const arr = kind === 'arr';
  const out = [];
  if (live) {
    const mv = live.filter(p => p.move === kind).sort((a, b) => arr ? (a.eta ?? 999) - (b.eta ?? 999) : a.dist - b.dist);
    out.push(mv.length
      ? (arr ? `יש כרגע ${mv.length === 1 ? 'מטוס אחד' : mv.length + ' מטוסים'} בגישה לנחיתה בנמל התעופה בן גוריון`
             : `${mv.length === 1 ? 'מטוס אחד המריא' : mv.length + ' מטוסים המריאו'} בדקות האחרונות מנמל התעופה בן גוריון`)
      : (arr ? 'אין כרגע מטוסים בגישה לנחיתה' : 'אין כרגע מטוסים שהמריאו בדקות האחרונות'));
    mv.forEach((p, i) => out.push(arr ? liveArrSentence(p, i + 1) : liveDepSentence(p, i + 1)));
  }
  if (board) {
    const next = nextFromBoard(board, arr ? 'A' : 'D', nowIl);
    out.push(next.length ? (arr ? 'הנחיתות הבאות לפי לוח הטיסות' : 'ההמראות הבאות לפי לוח הטיסות')
                         : (arr ? 'אין נחיתות נוספות מתוכננות בשעה הקרובה' : 'אין המראות נוספות מתוכננות בשעה הקרובה'));
    next.forEach(f => out.push(boardSentence(f, nowIl)));
  }
  return out;
}

// מצב הדפדוף נשמר בשם המשתנה: p<סבב>o<מאיזה משפט> = מה שהמתקשר הקיש (1 המשך, 2 מההתחלה, 3 סיום)
const PAGE_LINES = 4;
async function handleList(params, deps, kind) {
  let seq = -1, prevOff = 0;
  for (const k of Object.keys(params)) {
    const m = /^p(\d+)o(\d+)$/.exec(k);
    if (m && +m[1] > seq) { seq = +m[1]; prevOff = +m[2]; }
  }
  let offset = 0;
  if (seq >= 0) {
    const choice = lastVal(params[`p${seq}o${prevOff}`]);
    if (choice === '3') return idList(['תודה ולהתראות']) + HANGUP;
    if (choice === '1') offset = prevOff + PAGE_LINES;
  }
  const lines = await buildList(kind, deps, israelNowMs(deps.now));
  if (!lines) return idList(['מצטערים הנתונים אינם זמינים כרגע נסו שוב מאוחר יותר']) + HANGUP;
  const texts = lines.slice(offset, offset + PAGE_LINES);
  const more = offset + PAGE_LINES < lines.length;
  if (more) texts.push('להמשך הקישו 1');
  else texts.push(kind === 'all' ? 'אלו כל כלי הטיס' : 'זה הכול');
  texts.push('לשמיעה מההתחלה עם נתונים מעודכנים הקישו 2', 'לסיום הקישו 3');
  return read(texts, `p${seq + 1}o${offset}`, { max: 1, min: 1, sec: 10, allowed: more ? '1.2.3' : '2.3' });
}

// הפתיח: ברירת מחדל, או טקסט משלך מהגדרות השלוחה הראשית בימות המשיח (api_add_2=welcome=...)
export const DEFAULT_WELCOME = 'שלום והגעתם לקו מידע הטיסות של נמל התעופה בן גוריון';
// api_add_3=menufile=1 → במקום הקראה, מושמע קובץ מוקלט 910 (פתיח + תפריט בקול "מכשיר קשר")
// menufile=<שם קובץ בשלוחה הראשית>, למשל menufile=000 (או 1 = הקובץ 910). נתיב יחסי – הקובץ בתיקייה שבה נמצאים
const menuFile = v => (v === '1' ? 'f-910' : /^\d{1,4}$/.test(v || '') ? `f-${v}` : null);
const mainMenu = params => menuFile(params.menufile) ? [menuFile(params.menufile)] : [String(params.welcome || '').trim() || DEFAULT_WELCOME,
  'לנחיתות הקישו 1', 'להמראות הקישו 2', 'לבירור טיסה לפי מספר הקישו 3'];
// מה כל מקש בתפריט עושה
const MENU_KIND = { '1': 'arr', '2': 'dep' };      // 3 = בירור טיסה
const MODE_KIND = { arrivals: 'arr', departures: 'dep', planes: 'all' };

// ───────── "מכשיר קשר": צלילי פתיחת ערוץ וביפ סיום סביב כל הקראה ─────────
// מופעל עם api_add_2=radio=1 בהגדרות השלוחה. הקבצים מועלים לשלוחה הראשית בימות המשיח:
//   900 = פתיח באנגלית בסגנון קשר מגדל-טייס (רק בתפריט הראשי), 901 = פתיחת ערוץ, 902 = ביפ וסגירת ערוץ
export function radioize(resp, { intro = false } = {}) {
  const m = /^(read=|id_list_message=)([^=&]*)/.exec(resp || '');
  if (!m || !m[2]) return resp;
  const wrapped = `${intro ? 'f-/900.' : ''}f-/901.${m[2]}.f-/902`;
  return m[1] + wrapped + resp.slice(m[0].length);
}

export async function handleIvr(params, deps) {
  const resp = await handleIvrCore(params, deps);
  if (params.radio !== '1') return resp;
  const isMainMenu = /=menu,/.test(resp) && params.menu == null;
  return radioize(resp, { intro: isMainMenu });
}

async function handleIvrCore(params, deps) {
  if (params.ApiHangup === 'yes') return '';
  // ניתוב: mode מגיע מ-api_add בהגדרות השלוחה (אם רוצים שלוחה ישירה), אחרת מהתפריט הראשי
  const menu = lastVal(params.menu);
  // שלוחה ראשית בימות המשיח (api_add_1=mode=root): מקריאים תפריט ושולחים לשלוחה 1 או 2 של ימות המשיח
  if (params.mode === 'root') {
    if (['1', '2', '3'].includes(menu)) return `go_to_folder=/${menu}`;
    return read(mainMenu(params), 'menu', { max: 1, min: 1, sec: 10, allowed: '1.2.3' });
  }
  // 1 = נחיתות, 2 = המראות, 3 = בירור טיסה לפי מספר
  const kind = MODE_KIND[params.mode] || (params.mode == null ? MENU_KIND[menu] : undefined);
  if (kind && params.flight1 == null) return handleList(params, deps, kind);
  if (params.mode == null && menu == null && params.flight1 == null)
    return read(mainMenu(params), 'menu', { max: 1, min: 1, sec: 10, allowed: '1.2.3' });

  const nowIl = israelNowMs(deps.now);
  let n = 0;
  while (params[`flight${n + 1}`] != null) n++;
  const WELCOME = ['הקישו את מספר הטיסה בספרות בלבד ובסיום הקישו סולמית'];
  if (n === 0) return read(WELCOME, 'flight1');

  const askAgain = extra => read([...extra, 'לבדיקת טיסה נוספת הקישו את מספר הטיסה ובסיום סולמית'], `flight${n + 1}`);
  const digits = lastVal(params[`flight${n}`]).replace(/\D/g, '');

  let board;
  try { board = await deps.getBoard(); }
  catch { return idList(['מצטערים לוח הטיסות אינו זמין כרגע נסו שוב מאוחר יותר']) + HANGUP; }

  const matches = findFlights(board, digits, nowIl);
  if (!matches.length) return askAgain([`לא נמצאה היום טיסה בנמל התעופה בן גוריון עם המספר ${digits}`]);

  let f = matches[0];
  if (matches.length > 1) {
    const pick = lastVal(params[`pick${n}`]);
    const idx = pick ? parseInt(pick, 10) - 1 : -1;
    if (!(idx >= 0 && idx < matches.length)) {
      const opts = matches.map((m, i) => `ל${m.dir === 'D' ? 'טיסה היוצאת' : 'טיסה הנוחתת'} של ${m.airlineHe} ${m.dir === 'D' ? 'ל' : 'מ'}${m.cityHe} הקישו ${i + 1}`);
      return read([`נמצאו ${matches.length} טיסות עם המספר ${digits}`, ...opts], `pick${n}`,
        { max: 1, min: 1, sec: 8, allowed: matches.map((_, i) => i + 1).join('.') });
    }
    f = matches[idx];
  }

  const nextVal = lastVal(params[`next${n}`]);
  if (nextVal === '2') return read(['הקישו את מספר הטיסה ובסיום סולמית'], `flight${n + 1}`);
  if (nextVal && nextVal !== '1') return idList(['תודה ולהתראות']) + HANGUP;

  let ac = null;
  try { ac = await deps.getLive(f); } catch { ac = null; }
  const answer = flightAnswer(f, ac, nowIl);
  return read([...answer, 'לשמיעה חוזרת הקישו 1', 'לטיסה אחרת הקישו 2', 'לסיום הקישו 3'], `next${n}`,
    { max: 1, min: 1, sec: 8, allowed: '1.2.3' });
}

