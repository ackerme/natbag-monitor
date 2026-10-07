// בדיקות לקו הטלפוני (ימות המשיח) ולמידע הטיסות. הרצה: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../natbag-aws/src/proxy/flights.mjs';

// 29/09/2026 11:00 UTC = 14:00 שעון ישראל (שעון קיץ)
const NOW = Date.UTC(2026, 8, 29, 11, 0);
const rec = (o) => ({ CHOPER: 'LY', CHFLTN: '027', CHOPERD: 'EL AL ISRAEL AIRLINES', CHAORD: 'A',
  CHSTOL: '2026-09-29T14:40:00', CHPTOL: '2026-09-29T14:40:00', CHLOC1TH: 'ניו יורק', CHRMINH: 'בזמן', CHRMINE: 'ON TIME', CHTERM: 3, ...o });
const RAW = [
  rec({}),
  rec({ CHOPER: '6H', CHFLTN: '580', CHLOC1TH: 'זאגרב', CHSTOL: '2026-09-29T14:10:00', CHPTOL: '2026-09-29T14:25:00', CHRMINH: 'מתעכבת', CHRMINE: 'DELAYED' }),
  rec({ CHOPER: 'LY', CHFLTN: '5', CHLOC1TH: 'תל-אביב', CHSTOL: '2026-09-29T09:00:00', CHPTOL: '2026-09-29T08:52:00', CHRMINH: 'נחתה', CHRMINE: 'LANDED' }),
  rec({ CHOPER: 'W6', CHFLTN: '5', CHLOC1TH: "ז'נבה", CHSTOL: '2026-09-29T16:00:00', CHPTOL: '2026-09-29T16:00:00' }),
  rec({ CHOPER: 'FR', CHFLTN: '777', CHLOC1TH: 'רומא', CHRMINH: 'מבוטלת', CHRMINE: 'CANCELED' }),
  rec({ CHOPER: 'LY', CHFLTN: '315', CHAORD: 'D', CHLOC1TH: 'לונדון', CHSTOL: '2026-09-30T06:30:00', CHPTOL: '2026-09-30T06:30:00' }),
  rec({ CHOPER: 'LY', CHFLTN: '27', CHSTOL: '2026-09-27T14:40:00', CHPTOL: '2026-09-27T14:40:00' }),   // לפני יומיים – לא רלוונטי
];
const BOARD = RAW.map(F.parseBoardRecord);
const nowIl = F.israelNowMs(NOW);

// ה-ADS-B המדומה: ISR580 באוויר 40 ק"מ צפון מזרחית, ELY027 לא נמצא
const LIVE = { ISR580: { flight: 'ISR580', lat: 32.25, lon: 35.2, alt_baro: 9800, gs: 280 } };
const deps = { now: NOW, getBoard: async () => BOARD, getLive: async f => F.callsignCandidates(f).map(c => LIVE[c]).find(Boolean) || null };

// בדיקה שהתשובה לימות המשיח חוקית: רק t-, בלי תווים אסורים בטקסט
function assertYemot(resp) {
  for (const cmd of resp.split('&').filter(Boolean)) {
    const [key, messages] = cmd.split('=');
    if (key === 'go_to_folder') continue;
    assert.ok(['read', 'id_list_message'].includes(key), `פקודה לא מוכרת: ${key}`);
    for (const item of messages.split('.')) {
      assert.ok(item.startsWith('t-'), `פריט לא תקין: ${item}`);
      assert.doesNotMatch(item.slice(2), /[.\-"'&|=,]/, `תו אסור בטקסט: ${item}`);
    }
  }
}
const texts = resp => resp.split('&')[0].split('=')[1].split('.').map(t => t.slice(2));

test('say: מסיר תווים שימות המשיח לא מקבלת', () => {
  assert.equal(F.say('תל-אביב'), 'תל אביב');
  assert.equal(F.say("ז'נבה \"נתב\"ג\". & |"), 'זנבה נתבג');
});

test('speakTime: שעה, דקות ומחר', () => {
  assert.equal(F.speakTime('2026-09-29T14:05:00', nowIl), 'בשעה 14 ו 5 דקות');
  assert.equal(F.speakTime('2026-09-29T09:00:00', nowIl), 'בשעה 9');
  assert.equal(F.speakTime('2026-09-30T06:30:00', nowIl), 'מחר בשעה 6 ו 30 דקות');
});

test('findFlights: אפסים מובילים, חלון זמן, נחיתות קודם', () => {
  assert.equal(F.findFlights(BOARD, '27', nowIl).length, 1, 'הטיסה מלפני יומיים לא נכללת');
  assert.equal(F.findFlights(BOARD, '0027', nowIl)[0].iata, 'LY');
  assert.equal(F.findFlights(BOARD, '5', nowIl).length, 2);
  assert.equal(F.findFlights(BOARD, '315', nowIl)[0].dir, 'D');
  assert.equal(F.findFlights(BOARD, '999', nowIl).length, 0);
});

test('callsignCandidates: ELY + 27 → ELY27 / ELY027 / ELY0027', () => {
  assert.deepEqual(F.callsignCandidates(F.findFlights(BOARD, '27', nowIl)[0]), ['ELY27', 'ELY027', 'ELY0027']);
});

test('liveSentence: מרחק, כיוון, גובה וזמן משוער', () => {
  const s = F.liveSentence(LIVE.ISR580);
  assert.match(s, /במרחק \d+ קילומטר צפון מזרח/);
  assert.match(s, /בגובה 3000 מטר/);
  assert.match(s, /בעוד כ \d+ דקות/);
  assert.equal(F.liveSentence({ lat: 32.006, lon: 34.884, alt_baro: 'ground' }), 'המטוס נמצא על הקרקע בנמל התעופה');
});

test('flightAnswer: מתעכבת עם שעה מעודכנת ומיקום חי', () => {
  const f = F.findFlights(BOARD, '580', nowIl)[0];
  const a = F.flightAnswer(f, LIVE.ISR580, nowIl).join(' | ');
  assert.match(a, /טיסת ישראייר מספר 580 מזאגרב/);
  assert.match(a, /סטטוס מתעכבת/);
  assert.match(a, /נחיתה מתוכננת בשעה 14 ו 10 דקות/);
  assert.match(a, /זמן נחיתה מעודכן בשעה 14 ו 25 דקות/);
  assert.match(a, /המטוס באוויר/);
});

test('flightAnswer: נחתה / מבוטלת / יוצאת', () => {
  assert.match(F.flightAnswer(F.findFlights(BOARD, '5', nowIl).find(f => f.iata === 'LY'), null, nowIl).join(' '), /הטיסה נחתה בשעה 8 ו 52 דקות/);
  const c = F.flightAnswer(F.findFlights(BOARD, '777', nowIl)[0], null, nowIl).join(' ');
  assert.match(c, /מבוטלת/); assert.doesNotMatch(c, /נחיתה מתוכננת/);
  assert.match(F.flightAnswer(F.findFlights(BOARD, '315', nowIl)[0], null, nowIl).join(' '), /ללונדון.*המראה מתוכננת מחר/);
});

test('IVR: שיחה מלאה – פתיחה, טיסה, שמיעה חוזרת, טיסה אחרת, סיום', async () => {
  let r = await F.handleIvr({ ApiPhone: '0527000000' }, deps);           // תפריט ראשי
  assertYemot(r); assert.match(r, /^read=.*=menu,yes,1,1,10,No,yes,no,,1\.2\.3\.4,,Ok,HASH,$/);
  assert.match(texts(r).join(' '), /לנחיתות הקישו 1.*להמראות הקישו 2.*באוויר עכשיו הקישו 3.*לפי מספר הקישו 4.*סולמית/);
  r = await F.handleIvr({ menu: '4' }, deps);
  assertYemot(r); assert.match(r, /^read=.*=flight1,yes,/);
  r = await F.handleIvr({ mode: 'flights' }, deps);                       // שלוחה ישירה (api_add_1=mode=flights)
  assert.match(r, /=flight1,yes,/);

  r = await F.handleIvr({ flight1: '580' }, deps);
  assertYemot(r); assert.match(r, /=next1,yes,1,1,/);
  assert.ok(texts(r).some(t => t.includes('זמן נחיתה מעודכן')));

  r = await F.handleIvr({ flight1: '580', next1: '1' }, deps);             // שמיעה חוזרת
  assertYemot(r); assert.match(r, /=next1,/);

  r = await F.handleIvr({ flight1: '580', next1: '1,2' }, deps);           // ערכים כפולים → האחרון קובע
  assertYemot(r); assert.match(r, /=flight2,yes,/);

  r = await F.handleIvr({ flight1: '580', next1: '2', flight2: '27' }, deps);
  assertYemot(r); assert.match(r, /=next2,/); assert.ok(texts(r)[0].includes('אל על'));

  r = await F.handleIvr({ flight1: '580', next1: '2', flight2: '27', next2: '3' }, deps);
  assert.match(r, /^id_list_message=t-תודה ולהתראות&go_to_folder=hangup$/);
});

test('IVR: כמה טיסות עם אותו מספר → תפריט בחירה', async () => {
  let r = await F.handleIvr({ flight1: '5' }, deps);
  assertYemot(r); assert.match(r, /=pick1,yes,1,1,8,No,yes,no,,1\.2,/);
  assert.ok(texts(r).some(t => t.includes('וויז אייר') && t.includes('זנבה')));
  // הטיסה הקרובה ביותר בזמן מוצגת ראשונה; בוחרים לפי מה שהוקרא
  const opts = texts(r).slice(1);
  const wizz = opts.findIndex(t => t.includes('וויז אייר')) + 1;
  assert.equal(wizz, 1, 'וויז אייר (בעוד שעתיים) לפני אל על (נחתה בבוקר)');
  r = await F.handleIvr({ flight1: '5', pick1: String(wizz) }, deps);
  assertYemot(r); assert.ok(texts(r)[0].includes('וויז אייר'));
  r = await F.handleIvr({ flight1: '5', pick1: '2' }, deps);
  assertYemot(r); assert.ok(texts(r)[0].includes('אל על')); assert.ok(texts(r).some(t => t.includes('נחתה')));
});

test('IVR: טיסה שלא קיימת → מבקש מספר חדש', async () => {
  const r = await F.handleIvr({ flight1: '999' }, deps);
  assertYemot(r); assert.match(r, /=flight2,yes,/); assert.ok(texts(r)[0].includes('לא נמצאה'));
});

test('IVR: ניתוק ותקלה בלוח הטיסות', async () => {
  assert.equal(await F.handleIvr({ ApiHangup: 'yes', flight1: '5' }, deps), '');
  const r = await F.handleIvr({ flight1: '5' }, { ...deps, getBoard: async () => { throw new Error('down'); } });
  assert.match(r, /לוח הטיסות אינו זמין.*go_to_folder=hangup$/);
});

// ───── שלוחת כלי הטיס סביב נמל התעופה ─────
const AC_NEAR = [
  { hex: '738065', flight: 'ELY027 ', lat: 31.90, lon: 34.70, alt_baro: 3000, baro_rate: -900, category: 'A5', t: 'B789', track: 55, gs: 250 },   // ~20 ק"מ, יורד לכיוון השדה
  { hex: '4b1805', flight: 'SWR254', lat: 32.30, lon: 34.40, alt_baro: 20000, baro_rate: 1500, category: 'A3', track: 300 },   // ~55 ק"מ, מטפס ומתרחק
  { hex: '7395af', flight: '4XHSG', lat: 32.05, lon: 34.95, alt_baro: 1500, category: 'A1' },                      // מטוס קל
  { hex: '738aaa', flight: 'HELI1', lat: 32.10, lon: 34.85, alt_baro: 900, category: 'A7' },                       // מסוק
  { hex: 'abc123', flight: 'XYZ123', lat: 31.70, lon: 34.60, alt_baro: 15000, category: 'A3' },                     // חברה לא מוכרת
  { hex: '738001', flight: 'ELY001', lat: 32.006, lon: 34.884, alt_baro: 'ground' },                                // על הקרקע – לא נספר
  { hex: 'far', flight: 'THY794', lat: 33.80, lon: 35.50, alt_baro: 35000, category: 'A3' },                        // ~200 ק"מ – מחוץ לטווח
];
const pdeps = { ...deps, getNear: async () => AC_NEAR };

test('planesNear: רק באוויר, עד 100 ק"מ, מהקרוב לרחוק, עם שם וסוג', () => {
  const l = F.planesNear(AC_NEAR);
  assert.equal(l.length, 5);
  assert.deepEqual(l.map(p => p.name), ['מטוס קל', 'מסוק', 'אל על טיסה 27', 'מטוס של חברה זרה טיסה 123', 'סוויס טיסה 254']);
  const ely = l.find(p => p.name.includes('אל על'));
  assert.equal(ely.phase, 'בגישה לנחיתה בנמל התעופה');
  assert.equal(ely.model, 'בואינג 787');
  assert.equal(l.find(p => p.name === 'מטוס של חברה זרה טיסה 123').phase, 'בטיסה באזור');
  assert.match(F.planeSentence(ely, 3), /^מספר 3 אל על טיסה 27 בואינג 787 במרחק \d+ קילומטר .* בגישה לנחיתה בנמל התעופה$/);
  assert.equal(l.find(p => p.name.includes('סוויס')).phase, 'אחרי המראה מנמל התעופה');
  assert.ok(l.every((p, i) => i === 0 || p.dist >= l[i - 1].dist));
});

test('IVR כל כלי הטיס (mode=planes): עמוד ראשון, המשך, סוף, מההתחלה, סיום', async () => {
  let r = await F.handleIvr({ mode: 'planes' }, pdeps);
  assertYemot(r); assert.match(r, /=p0o0,yes,1,1,10,No,yes,no,,1\.2\.3,,Ok,HASH,/);
  let t = texts(r);
  assert.match(t[0], /ברגע זה יש באוויר 5 כלי טיס/);
  assert.match(t[1], /^מספר 1 מטוס קל במרחק \d+ קילומטר \S+.* לנמל התעופה בגובה 500 מטר בטיסה באזור$/);
  assert.equal(t.filter(x => x.startsWith('מספר ')).length, 3);

  r = await F.handleIvr({ mode: 'planes', p0o0: '1' }, pdeps);            // המשך
  t = texts(r);
  assert.match(r, /=p1o4,yes,1,1,10,No,yes,no,,2\.3,/);                // אין עוד עמודים → רק 2/3
  assert.match(t[0], /^מספר 4 /); assert.ok(t.includes('אלו כל כלי הטיס'));

  r = await F.handleIvr({ mode: 'planes', p0o0: '1', p1o4: '2' }, pdeps); // מההתחלה
  assert.match(r, /=p2o0,/); assert.match(texts(r)[0], /יש באוויר 5/);

  r = await F.handleIvr({ mode: 'planes', p0o0: '1', p1o4: '3' }, pdeps); // סיום
  assert.match(r, /^id_list_message=t-תודה ולהתראות&go_to_folder=hangup$/);

  r = await F.handleIvr({ mode: 'planes' }, { ...pdeps, getNear: async () => [] });
  assert.match(texts(r)[0], /ברגע זה אין כלי טיס/);
  r = await F.handleIvr({ mode: 'planes' }, { ...pdeps, getNear: async () => { throw new Error('x'); } });
  assert.match(r, /אינם זמינים.*go_to_folder=hangup$/);
});

test('IVR נחיתות (1): רק מהרדאר – מטוס בגישה עם זמן משוער, בלי לוח הטיסות', async () => {
  const r = await F.handleIvr({ menu: '1' }, pdeps);
  assertYemot(r);
  const t = texts(r);
  assert.match(t[0], /לפי הרדאר יש כרגע מטוס אחד בגישה לנחיתה/);
  assert.match(t[1], /^מספר 1 אל על טיסה 27 מניו יורק בואינג 787 במרחק \d+ קילומטר .* נחיתה בעוד כ \d+ דקות$/);
  assert.ok(t.includes('זה הכול'));
  assert.ok(!t.join(' ').includes('לוח הטיסות'), 'בלי לוח הטיסות');
  assert.ok(!t.join(' ').includes('ישראייר'), 'טיסה מהלוח לא מוקראת');
  assert.ok(!t.join(' ').includes('סוויס'), 'מטוס ממריא לא מופיע בנחיתות');
});

test('IVR המראות (2): רק מהרדאר – מטוס שהמריא ומטפס', async () => {
  const t = texts(await F.handleIvr({ mode: 'departures' }, pdeps));
  assert.match(t[0], /לפי הרדאר מטוס אחד המריא בדקות האחרונות/);
  assert.match(t[1], /^מספר 1 סוויס טיסה 254 במרחק \d+ קילומטר .* ובטיפוס$/);
  assert.ok(!t.join(' ').includes('לוח הטיסות'));
});

test('IVR נחיתות: אם הרדאר לא זמין – הודעה וניתוק (לא נופלים ללוח הטיסות)', async () => {
  const r = await F.handleIvr({ mode: 'arrivals' }, { ...pdeps, getNear: async () => { throw new Error('x'); } });
  assert.match(r, /אינם זמינים.*go_to_folder=hangup$/);
  const t = texts(await F.handleIvr({ mode: 'arrivals' }, { ...pdeps, getNear: async () => [] }));
  assert.equal(t[0], 'לפי הרדאר אין כרגע מטוסים בגישה לנחיתה');
});

test('classifyMove: נחיתה / המראה / מעבר לפי גובה, מרחק, קצב וכיוון', () => {
  const C = F.classifyMove;
  assert.equal(C({ dist: 12, altM: 800, rate: -700, track: 120, brg: 300 }), 'arr');      // גישה סופית
  assert.equal(C({ dist: 18, altM: 900, rate: 0, track: 120, brg: 300 }), 'arr');         // נמוך, ישר, לכיוון המסלול
  assert.equal(C({ dist: 90, altM: 5500, rate: -1500, track: 90, brg: 270 }), 'arr');     // יורד מרחוק לכיוון השדה
  assert.equal(C({ dist: 90, altM: 5500, rate: -1500, track: 270, brg: 270 }), null);     // יורד אבל מתרחק – לא לנתב"ג
  assert.equal(C({ dist: 8, altM: 900, rate: 2500, track: 300, brg: 300 }), 'dep');       // מטפס ליד השדה
  assert.equal(C({ dist: 70, altM: 6500, rate: 1800, track: 300, brg: 300 }), 'dep');     // מטפס ומתרחק
  assert.equal(C({ dist: 60, altM: 11000, rate: 0, track: 180, brg: 0 }), null);          // מעבר בגובה שיוט
  assert.equal(C({ dist: 30, altM: null, rate: -900, track: 0, brg: 180 }), null);        // בלי גובה – לא מנחשים
});

test('IVR שלוחה ראשית בימות המשיח (mode=root): תפריט ואז מעבר לשלוחה 1 עד 4', async () => {
  let r = await F.handleIvr({ mode: 'root' }, pdeps);
  assertYemot(r); assert.match(r, /=menu,yes,1,1,10,No,yes,no,,1\.2\.3\.4,/);
  assert.equal(await F.handleIvr({ mode: 'root', menu: '4' }, pdeps), 'go_to_folder=/4');
  assert.equal(await F.handleIvr({ mode: 'root', menu: '3' }, pdeps), 'go_to_folder=/3');
  assert.equal(await F.handleIvr({ mode: 'root', menu: '1' }, pdeps), 'go_to_folder=/1');
  assert.equal(await F.handleIvr({ mode: 'root', menu: '2' }, pdeps), 'go_to_folder=/2');
  r = await F.handleIvr({ mode: 'planes' }, pdeps);                       // שלוחה 3 (api_add_1=mode=planes)
  assert.match(texts(r)[0], /ברגע זה יש באוויר 5 כלי טיס/);
});

test('typeHe: קודי דגם נפוצים להקראה', () => {
  assert.equal(F.typeHe('B738'), 'בואינג 737');
  assert.equal(F.typeHe('A21N'), 'איירבוס 321 ניאו');
  assert.equal(F.typeHe('A333'), 'איירבוס 330');
  assert.equal(F.typeHe('B77W'), 'בואינג 777');
  assert.equal(F.typeHe(''), '');
});

test('IVR: פתיח מותאם אישית מהגדרות השלוחה (welcome)', async () => {
  const r = await F.handleIvr({ mode: 'root', welcome: 'ברוכים הבאים לקו של ישראל' }, pdeps);
  assert.equal(texts(r)[0], 'ברוכים הבאים לקו של ישראל');
  assert.equal(texts(await F.handleIvr({ mode: 'root' }, pdeps))[0], F.DEFAULT_WELCOME);
});

test('planesNear: חברות שחוצות את האזור (קטאר, פדקס) ומטוס פרטי ישראלי', () => {
  const l = F.planesNear([
    { flight: 'QTR8AB', lat: 32.3, lon: 34.6, alt_baro: 36000, category: 'A5', t: 'B77W' },
    { flight: 'FDX5', lat: 32.2, lon: 34.6, alt_baro: 30000, category: 'A5' },
    { flight: '4XCJA', lat: 32.1, lon: 34.8, alt_baro: 9000, category: 'A3' },
  ]);
  assert.deepEqual(l.map(p => p.name).sort(), ['מטוס פרטי ישראלי', 'פדקס טיסה 5', 'קטאר איירווייז טיסה 8'].sort());
});

test('מכשיר קשר (radio=1): צלילי ערוץ סביב ההקראה, ופתיח באנגלית רק בתפריט הראשי', async () => {
  let r = await F.handleIvr({ mode: 'root', radio: '1' }, pdeps);
  assert.match(r, /^read=f-\/900\.f-\/901\.t-שלום.*\.f-\/902=menu,yes,1,1,10,/);
  r = await F.handleIvr({ mode: 'planes', radio: '1' }, pdeps);
  assert.match(r, /^read=f-\/901\.t-.*\.f-\/902=p0o0,/);
  assert.doesNotMatch(r, /f-\/900/);
  r = await F.handleIvr({ mode: 'planes', radio: '1', p0o0: '3' }, pdeps);
  assert.equal(r, 'id_list_message=f-/901.t-תודה ולהתראות.f-/902&go_to_folder=hangup');
  assert.equal(await F.handleIvr({ mode: 'root', radio: '1', menu: '2' }, pdeps), 'go_to_folder=/2');
  assert.doesNotMatch(await F.handleIvr({ mode: 'planes' }, pdeps), /f-\//, 'בלי radio=1 – אין קבצים');
});

test('תפריט מוקלט (menufile=1): משמיעים את קובץ 910 במקום הקראה', async () => {
  let r = await F.handleIvr({ mode: 'root', menufile: '1' }, pdeps);
  assert.match(r, /^read=f-910=menu,/);
  assert.match(await F.handleIvr({ mode: 'root', menufile: '000' }, pdeps), /^read=f-000=menu,/);
  assert.doesNotMatch(r, /t-/);
  r = await F.handleIvr({ mode: 'root', menufile: '1', radio: '1' }, pdeps);
  assert.match(r, /^read=f-\/900\.f-\/901\.f-910\.f-\/902=menu,/);
  assert.match(await F.handleIvr({ mode: 'root' }, pdeps), /לנחיתות הקישו 1/, 'בלי menufile – הקראה רגילה');
});

test('סולמית לבד מחזירה לתפריט הראשי מכל שלב', async () => {
  for (const v of ['HASH', '']) {
    assert.equal(await F.handleIvr({ mode: 'planes', p0o0: v }, pdeps), 'go_to_folder=/');
    assert.equal(await F.handleIvr({ mode: 'arrivals', p0o0: v }, pdeps), 'go_to_folder=/');
    assert.equal(await F.handleIvr({ mode: 'flights', flight1: v }, deps), 'go_to_folder=/');
    assert.equal(await F.handleIvr({ mode: 'flights', flight1: '580', next1: v }, deps), 'go_to_folder=/');
  }
  const t = texts(await F.handleIvr({ mode: 'planes' }, pdeps));
  assert.ok(t.includes(F.BACK_KEY_TEXT));
  assert.ok(texts(await F.handleIvr({ mode: 'flights' }, deps)).some(x => x.includes('תפריט הראשי')));
  // ערך רגיל לא מחזיר
  assert.notEqual(await F.handleIvr({ mode: 'planes', p0o0: '2' }, pdeps), 'go_to_folder=/');
});

test('מאיפה / לאן: אות קריאה ↔ טיסה בלוח (ELY027 = LY 27, ISR580 = 6H 580)', () => {
  const idx = F.routeIndex(BOARD, nowIl);
  assert.equal(F.routeFor(idx, 'ISR580', 'arr').city, 'זאגרב');
  assert.equal(F.routeFor(idx, 'ISR580 ', null).dir, 'A');
  assert.equal(F.routeFor(idx, 'ISR580', 'dep'), null, 'נוחת לפי הלוח – לא נותנים לו יעד של המראה');
  assert.equal(F.routeFor(idx, 'ABC123', 'arr'), null);
  assert.equal(F.routeFor(null, 'ISR580', 'arr'), null);
});

test('נחיתות בלי לוח הטיסות: ההקראה ממשיכה, רק בלי העיר', async () => {
  const t = texts(await F.handleIvr({ mode: 'arrivals' }, { ...pdeps, getBoard: async () => { throw new Error('down'); } }));
  assert.match(t[1], /^מספר 1 אל על טיסה 27 בואינג 787 במרחק/);
});
