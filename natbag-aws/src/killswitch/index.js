// natbag-killswitch — מתג כיבוי אוטומטי
// AWS Budgets שולח הודעה ל-SNS כשהעלות בפועל עוברת את התקציב.
// הפונקציה הזו מקבלת את ההודעה ומורידה את ה-concurrency של שרת הביניים ל-0,
// כך שהוא מפסיק לענות ומפסיק לעלות כסף.
//
// הפעלה מחדש (אחרי שבדקת מה קרה):
//   aws lambda delete-function-concurrency --function-name natbag-proxy

// מפעילים רק על התרעת עלות אמיתית, לא על הודעת בדיקה או על התרעה אחרת
function shouldDisable(message) {
  if (!message) return false;
  return /AWS Budget/i.test(message) && /ACTUAL/i.test(message);
}

exports.shouldDisable = shouldDisable;

exports.handler = async (event) => {
  const target = process.env.TARGET_FUNCTION;
  const messages = (event.Records || []).map(r => (r.Sns && r.Sns.Message) || "");
  console.log("Received", messages.length, "message(s)");

  if (!messages.some(shouldDisable)) {
    console.log("Not an ACTUAL budget alert – ignoring:", messages.map(m => m.slice(0, 200)));
    return { disabled: false };
  }

  // כל הפונקציות שעולות כסף: שרת הביניים, ושלוחה 5 (natbag-atc)
  const targets = (process.env.TARGET_FUNCTIONS || target || "").split(",").map(s => s.trim()).filter(Boolean);
  const { LambdaClient, PutFunctionConcurrencyCommand } = require("@aws-sdk/client-lambda");
  const lambda = new LambdaClient({});
  for (const fn of targets) {
    await lambda.send(new PutFunctionConcurrencyCommand({ FunctionName: fn, ReservedConcurrentExecutions: 0 }));
    console.log(`Budget exceeded → ${fn} disabled (reserved concurrency = 0)`);
  }
  return { disabled: true, target: targets[0], targets };
};
