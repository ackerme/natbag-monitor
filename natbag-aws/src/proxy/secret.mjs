// secret.mjs – סיסמת הקו (IVR token) מ-SSM Parameter Store (SecureString), לא ממשתנה סביבה גלוי.
//
// סדר עדיפויות:
//   1. SSM (שם הפרמטר ב-IVR_TOKEN_PARAM, למשל /natbag/ivr/token) – נקרא פעם ב-5 דקות, כך שהחלפת סיסמה נכנסת לתוקף לבד
//      (בלי IVR_TOKEN_PARAM – למשל בבדיקות – רק משתנה הסביבה)
//   2. אם הפרמטר לא קיים (ParameterNotFound) – משתנה הסביבה IVR_TOKEN (תקופת מעבר)
//   3. אם הקריאה מ-SSM נכשלה מסיבה אחרת (הרשאות, רשת) – נכשלים "סגור": מחזירים null, והקוד דוחה את הבקשה
// הקובץ זהה ב-src/proxy וב-src/atc (לכל Lambda תיקייה משלה).

const TTL_MS = 5 * 60_000;
let cache = { t: 0, v: undefined };

export async function getIvrToken({ ssmSend, now = Date.now(), env = process.env } = {}) {
  if (cache.v !== undefined && now - cache.t < TTL_MS) return cache.v;
  const name = env.IVR_TOKEN_PARAM;
  if (!name) return env.IVR_TOKEN || "";
  try {
    const send = ssmSend || await defaultSend();
    const out = await send({ Name: name, WithDecryption: true });
    const v = out?.Parameter?.Value || "";
    cache = { t: now, v };
    return v;
  } catch (e) {
    if (e?.name === "ParameterNotFound") {
      const v = env.IVR_TOKEN || "";
      cache = { t: now, v };
      return v;
    }
    console.error(JSON.stringify({ level: "error", route: "ivr-token", details: [String(e?.name || e?.message || e)] }));
    return null;   // לא יודעים מה הסיסמה – לא פותחים את הקו
  }
}

export function _resetCache() { cache = { t: 0, v: undefined }; }

async function defaultSend() {
  const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
  const client = new SSMClient({});
  return (input) => client.send(new GetParameterCommand(input));
}
