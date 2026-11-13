// natbag-investigator — סוכן AI (Agentic AI) שחוקר התרעות.
//
// מנוי לנושא natbag-ops-alerts (SNS). כשמגיעה התרעה (מטוס בחירום, חריגה, CloudWatch Alarm):
//   1. בודק שזו התרעה שכדאי לחקור (לא הדוח של עצמו, לא בדיקה, לא חזרה ל-OK)
//   2. תופס את "החקירה של היום" ב-DynamoDB (ai#YYYY-MM-DD, כתיבה מותנית) – לכל היותר חקירה אחת ביום
//   3. מריץ את Claude Haiku 4.5 ב-Amazon Bedrock עם כלים לקריאה בלבד (לוגים, מטוסים, סטטיסטיקה, מצב המערכת)
//   4. שולח את הדוח לאותו נושא SNS, עם נושא שמתחיל ב-"natbag AI" (ולכן לא נחקר שוב)
//
// הרשאות: קריאת לוגים של natbag-watcher ו-natbag-proxy, DescribeAlarms, כתיבה לרשומת ai# בלבד,
// Publish לנושא, ו-InvokeModel למודל אחד. אין לו שום יכולת לשנות את המערכת.
//
// בדיקה ידנית (נספרת במכסה היומית):
//   aws lambda invoke --function-name natbag-investigator --cli-binary-format raw-in-base64-out \
//     --payload '{"subject":"natbag: manual check","message":"בדיקה ידנית – מה המצב עכשיו?"}' /tmp/ai.json

import { shouldInvestigate, alertPrompt, investigate, reportEmail, asciiSubject } from "./agent.mjs";
import { makeTools, ilTime } from "./tools.mjs";

const log = obj => process.stdout.write(JSON.stringify(obj) + "\n");
export const israelDate = now => new Date(now).toLocaleDateString("sv-SE", { timeZone: "Asia/Jerusalem" });

// ───────── AWS ─────────
async function claimDay(table, date, subject, limit) {
  const { DynamoDBClient, UpdateItemCommand } = await import("@aws-sdk/client-dynamodb");
  try {
    // מונה יומי: עולה ב-1 רק אם עוד לא הגיע למכסה (כתיבה אטומית – גם אם SNS שולח פעמיים)
    await new DynamoDBClient({}).send(new UpdateItemCommand({
      TableName: table, Key: { pk: { S: `ai#${date}` } },
      UpdateExpression: "ADD n :one SET lastSubject = :s",
      ConditionExpression: "attribute_not_exists(n) OR n < :limit",
      ExpressionAttributeValues: { ":one": { N: "1" }, ":limit": { N: String(limit) }, ":s": { S: subject.slice(0, 200) } },
    }));
    return true;
  } catch (e) {
    if (e.name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

async function filterLogs(group, startTime, filterPattern) {
  const { CloudWatchLogsClient, FilterLogEventsCommand } = await import("@aws-sdk/client-cloudwatch-logs");
  const client = new CloudWatchLogsClient({});
  const events = [];
  let nextToken;
  for (let i = 0; i < 5; i++) {
    const out = await client.send(new FilterLogEventsCommand({ logGroupName: group, startTime, filterPattern, nextToken, limit: 500 }));
    events.push(...(out.events || []));
    nextToken = out.nextToken;
    if (!nextToken || events.length >= 500) break;
  }
  return events.slice(-500);
}

async function alarmsInAlarm() {
  const { CloudWatchClient, DescribeAlarmsCommand } = await import("@aws-sdk/client-cloudwatch");
  const out = await new CloudWatchClient({}).send(new DescribeAlarmsCommand({ AlarmNamePrefix: "natbag-", StateValue: "ALARM" }));
  return (out.MetricAlarms || []).map(a => a.AlarmName);
}

async function bedrockConverse(modelId, req) {
  const { BedrockRuntimeClient, ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
  return new BedrockRuntimeClient({}).send(new ConverseCommand({ modelId, ...req }));
}

async function publish(topicArn, subject, message) {
  const { SNSClient, PublishCommand } = await import("@aws-sdk/client-sns");
  return new SNSClient({}).send(new PublishCommand({ TopicArn: topicArn, Subject: asciiSubject(subject), Message: message }));
}

export const realDeps = env => ({
  now: () => Date.now(),
  claimDay: (date, subject) => claimDay(env.TABLE, date, subject, Number(env.AI_DAILY_LIMIT || 1)),
  converse: req => bedrockConverse(env.MODEL_ID, req),
  publish: (s, m) => publish(env.ALERT_TOPIC_ARN, s, m),
  tools: makeTools({ fetch, filterLogs, alarmsInAlarm, proxyUrl: env.PROXY_URL }),
  model: env.MODEL_ID,
});

/** הלב: התרעה אחת → (אולי) חקירה → מייל. deps מוזרקים כדי שאפשר לבדוק בלי AWS */
export async function handleAlert({ subject, message }, deps) {
  const decision = shouldInvestigate(subject, message);
  if (!decision.go) { log({ level: "info", skipped: decision.why, subject }); return { investigated: false, reason: decision.why }; }

  const now = deps.now();
  if (!(await deps.claimDay(israelDate(now), subject))) {
    log({ level: "info", skipped: "daily-limit", subject });
    return { investigated: false, reason: "daily-limit" };
  }

  const runTool = async (name, input) => {
    const fn = deps.tools[name];
    if (!fn) throw new Error(`אין כלי בשם ${name}`);
    return fn(input || {});
  };
  let result;
  try {
    result = await investigate({ prompt: alertPrompt(subject, message, ilTime(now)), converse: deps.converse, runTool });
  } catch (e) {
    // למשל: לא הופעלה גישה למודל ב-Bedrock. מודיעים פעם אחת (המכסה כבר נתפסה) ולא מנסים שוב
    log({ level: "error", investigator: "failed", error: e.message, name: e.name });
    await deps.publish(`natbag AI: investigation failed`,
      `סוכן ה-AI לא הצליח לחקור את ההתרעה "${subject}".\n\nשגיאה: ${e.name || ""} ${e.message}\n\n` +
      `אם זו AccessDeniedException / ResourceNotFoundException – צריך להפעיל את המודל ב-Bedrock (ראו natbag-aws/README).`);
    return { investigated: false, reason: "error", error: e.message };
  }
  const mail = reportEmail({ subject, ...result, model: deps.model });
  await deps.publish(mail.subject, mail.body);
  log({ level: "info", investigated: true, subject, calls: result.calls, usage: result.usage, cost: result.cost });
  return { investigated: true, calls: result.calls.map(c => c.name), usage: result.usage, cost: result.cost };
}

export const handler = async (event = {}) => {
  const deps = realDeps(process.env);
  // הפעלה ידנית: { subject, message }
  if (!event.Records) return handleAlert({ subject: event.subject || "natbag: manual check", message: event.message || "" }, deps);
  const out = [];
  for (const r of event.Records) out.push(await handleAlert({ subject: r.Sns?.Subject || "", message: r.Sns?.Message || "" }, deps));
  return out;
};
