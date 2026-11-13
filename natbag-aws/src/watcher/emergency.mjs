// emergency.mjs – מטוס שמשדר קוד חירום ליד נתב"ג → התרעה במייל (ושיחת טלפון, אם הופעלה)
//
// מקור: נתוני ADS-B פתוחים. כל מטוס משדר "squawk" (קוד בן 4 ספרות). שלושה קודים שמורים לחירום:
//   7700 – מצב חירום · 7600 – תקלת קשר רדיו · 7500 – התערבות בלתי חוקית בטיסה
// בנוסף, חלק מהמקלטים מדווחים שדה "emergency" (general / nordo / unlawful / minfuel / lifeguard / downed).
//
// דיוק – למה לא מתקשרים בדגימה הראשונה:
//   • קוד חירום "מהבהב" לשנייה קורה (טייס שמעביר בין קודים, או טעות במקלט) → מחכים לשתי דגימות רצופות (~2 דקות)
//   • אותו מטוס לא מתריע פעמיים: לכל היותר התרעה אחת לכל מטוס בכל 3 שעות
// זה מידע על תנועה אווירית בלבד, לא מערכת התרעה ביטחונית.

import { planesNear, TLV, haversine } from "./flights.mjs";

export const EMERGENCY_RADIUS_KM = 100;
export const CONFIRM_SCANS = 2;                // כמה דגימות רצופות עד שמתקשרים
export const SCAN_GAP_MS = 3 * 60e3;           // דגימה "רצופה" = עד 3 דקות מהקודמת (ה-watcher רץ כל דקה)
export const RECALL_MS = 3 * 60 * 60e3;        // אותו מטוס – שוב רק אחרי 3 שעות

const SQUAWK = { "7700": "מצב חירום", "7600": "תקלת קשר רדיו", "7500": "התערבות בלתי חוקית בטיסה" };
const FIELD = {                                 // שדה emergency של ADS-B → קוד + הסבר
  general: ["7700", "מצב חירום"], nordo: ["7600", "תקלת קשר רדיו"], unlawful: ["7500", "התערבות בלתי חוקית בטיסה"],
  minfuel: [null, "מחסור בדלק"], lifeguard: [null, "טיסה רפואית בעדיפות"], downed: [null, "מטוס במצוקה"],
};

/** קוד החירום של מטוס, או null */
export function emergencyOf(a) {
  const sq = String(a?.squawk ?? "").trim();
  if (SQUAWK[sq]) return { code: sq, meaning: SQUAWK[sq] };
  const f = FIELD[String(a?.emergency ?? "").toLowerCase()];
  return f ? { code: f[0], meaning: f[1] } : null;
}

/** כל המטוסים בחירום ברדיוס 100 ק"מ מנתב"ג */
export function emergencies(acList, radiusKm = EMERGENCY_RADIUS_KM) {
  const out = [];
  for (const a of acList || []) {
    if (!a || a.lat == null || a.lon == null) continue;
    const e = emergencyOf(a); if (!e) continue;
    const dist = haversine(TLV.lat, TLV.lon, a.lat, a.lon);
    if (dist > radiusKm) continue;
    out.push({ id: String(a.hex || a.flight || "").trim().toLowerCase(), ...e, a });
  }
  return out;
}

/**
 * צעד אחד: מעדכן את "מי בחירום" ומחזיר את מי שצריך להתקשר עליו עכשיו.
 * seen = { [id]: { count, last, code, calledAt } } – נשמר ב-DynamoDB בין ההרצות.
 */
export function emergencyStep(prevSeen, list, now) {
  const seen = {};
  for (const [id, s] of Object.entries(prevSeen || {}))   // זוכרים שיחות קודמות 3 שעות, גם אם המטוס כבר לא בחירום
    if (s.calledAt && now - s.calledAt < RECALL_MS) seen[id] = { ...s, count: 0 };
  const toCall = [];
  for (const e of list) {
    const p = prevSeen?.[e.id];
    const continuous = p && p.count > 0 && now - p.last <= SCAN_GAP_MS;
    const s = seen[e.id] = { ...(seen[e.id] || {}), code: e.code, last: now, count: continuous ? p.count + 1 : 1 };
    if (s.count >= CONFIRM_SCANS && !(s.calledAt && now - s.calledAt < RECALL_MS)) toCall.push(e);
  }
  return { seen, toCall };
}

const spellCode = c => String(c).split("").join(" ");    // "7700" → "7 7 0 0" (אחרת ההקראה אומרת "שבעת אלפים...")

/** הטקסט להקראה – באותו ניסוח כמו שלוחת "כלי הטיס סביב נמל התעופה" בקו */
export function emergencyText(list) {
  const parts = ["התרעת חירום מקו מידע הטיסות"];
  for (const e of list) {
    const [p] = planesNear([e.a], 10000);
    parts.push(`מטוס ליד נמל התעופה בן גוריון משדר${e.code ? ` קוד ${spellCode(e.code)}` : ""} ${e.meaning}`);
    if (p) parts.push(`${p.name}${p.model ? ` ${p.model}` : ""} במרחק ${Math.round(p.dist)} קילומטר ${p.dir} לנמל התעופה` +
                      `${p.altM ? ` בגובה ${p.altM} מטר` : ""} ${p.phase}`);
  }
  parts.push("המידע מבוסס על נתוני רדאר פתוחים ועלול להיות שגוי",
             "זו התרעה על תנועה אווירית בלבד ואינה התרעה של פיקוד העורף");
  return parts.join(" , ");
}

export const SITE_URL = "https://ackerme.github.io/natbag-monitor/monitor.html";

/**
 * אותה התרעה במייל (SNS): נושא קצר באנגלית (נראה טוב בכל תיבת דואר) + גוף בעברית עם הפרטים וקישורים.
 */
export function emergencyEmail(list) {
  const first = list[0];
  const cs = String(first?.a?.flight || "").trim() || first?.id || "";
  const subject = `natbag: EMERGENCY${first?.code ? ` squawk ${first.code}` : ""}${cs ? ` - ${cs}` : ""}` +
                  `${list.length > 1 ? ` (+${list.length - 1})` : ""}`;
  const lines = ["🚨 התרעת חירום – מוניטור נתב\"ג", ""];
  for (const e of list) {
    const [p] = planesNear([e.a], 10000);
    const a = e.a || {};
    lines.push(`מטוס ליד נמל התעופה בן גוריון משדר${e.code ? ` קוד ${e.code}` : ""} – ${e.meaning}`);
    if (p) {
      lines.push(`• מי: ${p.name}${p.model ? ` (${p.model})` : ""}${String(a.flight || "").trim() ? ` · אות קריאה ${String(a.flight).trim()}` : ""}${a.r ? ` · רישום ${a.r}` : ""}`);
      lines.push(`• איפה: ${Math.round(p.dist)} ק"מ ${p.dir} לנתב"ג${p.altM ? ` · גובה ${p.altM} מ'` : ""}${p.kmh ? ` · ${Math.round(p.kmh)} קמ"ש` : ""}`);
      lines.push(`• מה הוא עושה: ${p.phase}`);
    }
    if (a.hex) lines.push(`• מפה חיה: https://globe.adsbexchange.com/?icao=${encodeURIComponent(a.hex)}`);
    lines.push("");
  }
  lines.push(`הרדאר באתר: ${SITE_URL}`, "",
             "המידע מבוסס על נתוני ADS-B פתוחים ועלול להיות שגוי.",
             "זו התרעה על תנועה אווירית בלבד ואינה התרעה של פיקוד העורף.");
  return { subject: subject.slice(0, 99), body: lines.join("\n") };
}
