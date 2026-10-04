# natbag-aws

שרת ביניים ב-AWS Lambda בשביל מוניטור נתב"ג. כולל תקציב חודשי ומתג כיבוי אוטומטי.
הכל מוגדר כקוד (AWS SAM / CloudFormation) ועולה בפקודה אחת.

## ארכיטקטורה

```
דפדפן ──► Lambda Function URL ──► natbag-proxy ──► adsb.lol / airplanes.live / adsb.fi / OpenSky
                                        │
                                        └── SSM Parameter Store (מפתח OpenSky, מוצפן)

AWS Budgets ──(עלות > $1)──► SNS ──► natbag-killswitch ──► concurrency של natbag-proxy = 0
```

## מה יש בפנים

| רכיב | תפקיד |
|---|---|
| `natbag-proxy` | Lambda עם Function URL ציבורי, CORS, מעבר אוטומטי בין מקורות, מטמון של 10 שניות ודחיסת gzip. נתיבים: `/aircraft`, `/opensky`, `/mil` (מטוסים צבאיים באזור, לזיהוי מטוסי תדלוק), `/tracked` (הטיסות הכי נעקבות ב-Flightradar24, מקור לא רשמי), `/stats` (סטטיסטיקה יומית ומצב המערכת), `/flight`, `/ivr` |
| SSM Parameter Store | שומר את מפתח OpenSky מוצפן (SecureString), כך שהוא לא נמצא בקוד |
| AWS Budgets | תקציב חודשי של 1$. ב-50% נשלח מייל אזהרה, וב-100% נשלח מייל ומופעל כיבוי |
| `natbag-killswitch` | מקבל את ההתרעה דרך SNS ומוריד את ה-concurrency של השרת ל-0 |
| CloudWatch Logs | הלוגים נשמרים 3 ימים בלבד, כדי שלא תצטבר עלות אחסון |
| `natbag-healthcheck` | בדיקת זמינות כל 5 דקות (EventBridge): ‏`/health`, ‏`/aircraft` והאתר |
| CloudWatch Alarms | 7 התרעות שנשלחות למייל דרך SNS (`natbag-ops-alerts`), כולל הודעה כשהמצב חוזר לתקין |
| `natbag-watcher` + DynamoDB | מחשב את מדד החריגה כל דקה בשרת, ומתקשר בטלפון כשיש חריגה משמעותית |
| CloudWatch Dashboard | לוח בקרה בשם `natbag`. הקישור מופיע ב-Outputs בשם `DashboardUrl` |

## עלות

- **שימוש רגיל** (בקשה אחת בדקה, בערך 43,000 בחודש): **0$**, בתוך ה-Always Free של Lambda.
- **שימוש חריג:** מתג הכיבוי עוצר את השרת כשהעלות בחשבון עוברת את התקציב.
  נתוני החיוב של AWS מתעדכנים רק כמה פעמים ביום, ולכן יש עיכוב של כמה שעות עד שהכיבוי נכנס לפעולה.
- ⚠️ התקציב מחושב על **כל החשבון**. אם יש לך שירותים אחרים בתשלום, הגדל את `BudgetLimitUSD`.

## פריסה

1. **בחירת אזור:** בקונסול של AWS, בפינה הימנית העליונה, בוחרים **US East (N. Virginia) / us-east-1**.
2. **פתיחת CloudShell:** לוחצים על אייקון הטרמינל בסרגל העליון. CloudShell כבר מגיע עם `sam` מותקן.
3. **העלאת הקבצים:** בוחרים **Actions** ← **Upload file** ומעלים את `natbag-aws.zip`.
4. **הרצת הפריסה:**
   ```bash
   unzip natbag-aws.zip && cd natbag-aws
   sam deploy --guided
   ```
5. **תשובות לשאלות של הפריסה:**

   | שאלה | תשובה |
   |---|---|
   | Stack Name | `natbag` |
   | AWS Region | `us-east-1` |
   | AlertEmail | המייל שלך |
   | BudgetLimitUSD | `1` |
   | AllowedOrigin | `*` |
   | Confirm changes before deploy | `y` |
   | Allow SAM CLI IAM role creation | `Y` |
   | Disable rollback | `N` |
   | Save arguments to configuration file | `Y` (בשאר השאלות לוחצים Enter) |
   | Deploy this changeset? | `y` |

6. **בדיקה:** בסוף הפריסה מופיעים **Outputs**. פותחים בדפדפן את `HealthCheck`, וצריך להופיע `{"ok":true,...}`.
   בנוסף AWS שולחת מייל עם הנושא **AWS Notification - Subscription Confirmation**. לוחצים בו על **Confirm subscription**, אחרת התרעות הניטור לא יגיעו.
7. **חיבור הדף:** מעתיקים את `ProxyUrl` לדף, לשורה `const PROXY_URL = "...";`.

## מפתח OpenSky (אופציונלי)

מריצים ב-CloudShell. הפקודה `read -s` מקבלת את הערך בלי להציג אותו על המסך ובלי לשמור אותו בהיסטוריה:

```bash
read -rsp "OpenSky client_id: " V && aws ssm put-parameter --name /natbag/opensky/client_id --type SecureString --value "$V" && unset V; echo
read -rsp "OpenSky client_secret: " V && aws ssm put-parameter --name /natbag/opensky/client_secret --type SecureString --value "$V" && unset V; echo
```

תוך עד 5 דקות השרת יתחיל להשתמש במפתח. בודקים בכתובת `ProxyUrl` + `opensky?lat=32.0055&lon=34.8854&dist=43`.

## אחרי שמתג הכיבוי הופעל

קודם בודקים ב-Billing מה גרם לעלות. אחר כך מפעילים מחדש:

```bash
aws lambda delete-function-concurrency --function-name natbag-proxy
```

## קו טלפוני למידע טיסות (טלפונים כשרים)

בתחילת השיחה יש תפריט:
- **1, נחיתות:** המטוסים שבגישה לנחיתה עכשיו, לפי ADS-B, עם זמן נחיתה משוער. אחריהם מוקראות הנחיתות הבאות מלוח הטיסות, בשעה הקרובה.
- **2, המראות:** המטוסים שהמריאו בדקות האחרונות. אחריהם מוקראות ההמראות הבאות מלוח הטיסות.
- **3, בירור טיסה לפי מספר.**

ההקראה היא ארבעה משפטים בכל פעם: 1 להמשך, 2 מההתחלה עם נתונים מעודכנים, 3 לסיום.

**בירור טיסה:** מקישים מספר טיסה (בספרות בלבד) ולוחצים סולמית. המערכת מקריאה:
- מאיפה הטיסה מגיעה ומה הסטטוס שלה
- שעת נחיתה מתוכננת, ושעה מעודכנת אם השתנתה
- אם המטוס באוויר: המרחק מנמל התעופה, הכיוון, הגובה והערכה בעוד כמה דקות הוא ינחת

אם יש כמה טיסות עם אותו מספר, המערכת מקריאה תפריט בחירה. יש אפשרות לשמיעה חוזרת או לבדיקת טיסה נוספת.

**מקורות הנתונים:**
- **לוח הטיסות הרשמי של רשות שדות התעופה** (data.gov.il): שעות וסטטוס.
- **ADS-B** לפי callsign: מיקום חי.

**התקנה:**
1. **בדיקה בדפדפן:** פותחים את `ProxyUrl` + `flight?num=1`. צריך לחזור JSON עם `speech`.
2. **סיסמה:** בפריסה מגדירים את `IvrToken`. ב-GitHub Actions מוסיפים Secret בשם `IVR_TOKEN`.
3. **ימות המשיח:** פותחים מערכת ב[ימות המשיח](https://www.yemot.co.il). בשלוחה הרצויה, בקובץ `ext.ini`, מגדירים:
   ```
   type=api
   api_link=https://<ProxyUrl>/ivr
   api_add_0=token=<IVR_TOKEN>
   api_hangup_send=no
   voice=Sivan
   ```
   - **מצב מכשיר קשר:** מוסיפים `api_add_2=radio=1` לכל שלוחה, ומעלים לשלוחה הראשית את הקבצים `900.wav` (פתיח באנגלית בסגנון קשר מגדל-טייס), `901.wav` (פתיחת ערוץ) ו-`902.wav` (ביפ וסגירת ערוץ). כל הקראה מקבלת צלילי קשר בתחילתה ובסופה, והפתיח מושמע רק בתפריט הראשי. את הקבצים יוצרים מחדש עם `docs/radio/make-radio.sh`.
   - **תפריט מוקלט:** `api_add_3=menufile=1` בשלוחה הראשית משמיע את הקובץ `910.wav` (פתיח ותפריט מוקלטים) במקום הקראת הטקסט. כל קובץ אחר שתעלו בשם 910 – למשל הקלטה בעברית – יחליף אותו.
   - **קול ההקראה:** השורה `voice=` בוחרת את הקול. האפשרויות הן `Elik_2100` (ברירת המחדל), `Jacob`, `Sivan` ו-`Osnat`. את המהירות קובעים עם `rate=`, מ-‎-10 עד 10.
   - **שלוחות נפרדות בימות המשיח:** כל שלוחה מקבלת את אותן שורות, ובנוסף שורת `api_add_1` משלה:
     - **שלוחה ראשית:** `api_add_1=mode=root`. מקריאה תפריט ושולחת לשלוחה 1, 2 או 3. אפשר להוסיף פתיח משלך: `api_add_2=welcome=<הטקסט>`.
     - **שלוחה 1:** `api_add_1=mode=arrivals`. נחיתות.
     - **שלוחה 2:** `api_add_1=mode=departures`. המראות.
     - **שלוחה 3:** `api_add_1=mode=flights`. בירור טיסה לפי מספר.
     - **אפשרות נוספת:** `mode=planes` מקריא את כל כלי הטיס ברדיוס 100 ק"מ.

השרת עצמו לא שומר מצב. ימות המשיח שולחת בכל בקשה את כל מה שהמתקשר הקיש עד אותו רגע (flight1, pick1, next1, flight2…).

## התרעה טלפונית (natbag-watcher)

הפונקציה רצה כל דקה. כשמדד החריגה עובר ל"חריגה משמעותית", היא מתקשרת אליך דרך ימות המשיח, לכל היותר פעם בחצי שעה. השיחות עולות **יחידות** בימות המשיח.

1. **שמירת הפרטים ב-SSM** (ב-CloudShell; הערכים לא מוצגים על המסך ולא נשמרים בהיסטוריה):
   ```bash
   read -rsp "Yemot system number: " V && aws ssm put-parameter --name /natbag/yemot/username --type SecureString --value "$V" --overwrite && unset V; echo
   read -rsp "Yemot password: " V && aws ssm put-parameter --name /natbag/yemot/password --type SecureString --value "$V" --overwrite && unset V; echo
   read -rsp "Phone to call: " V && aws ssm put-parameter --name /natbag/yemot/phone --type SecureString --value "$V" --overwrite && unset V; echo
   ```
2. **שיחת בדיקה:**
   ```bash
   aws lambda invoke --function-name natbag-watcher --cli-binary-format raw-in-base64-out \
     --payload '{"testCall":true}' /tmp/out.json && cat /tmp/out.json
   ```
3. **מעקב:** הלוגים נמצאים ב-`/aws/lambda/natbag-watcher`, והגרף "מדד החריגה" בלוח הבקרה.

## פריסה אוטומטית מ-GitHub (CI/CD)

מגדירים פעם אחת, ומאז כל push ל-`main` מריץ בדיקות ופורס לבד.

1. **יצירת תפקיד הפריסה:** ב-CloudShell מריצים (מחליפים את `ackerme` בשם המשתמש שלך ב-GitHub):
   ```bash
   git clone https://github.com/ackerme/natbag-monitor && cd natbag-monitor/natbag-aws
   aws cloudformation deploy --template-file github-oidc.yaml --stack-name natbag-github-oidc \
     --capabilities CAPABILITY_NAMED_IAM --parameter-overrides GitHubOwner=ackerme RepoName=natbag-monitor
   aws cloudformation describe-stacks --stack-name natbag-github-oidc --query "Stacks[0].Outputs" --output table
   ```
   אם מופיעה שגיאה שה-OIDC provider כבר קיים, מוסיפים לפקודה `CreateOIDCProvider=false`.
2. **הגדרות ב-GitHub:** ב-repo נכנסים ל-**Settings** ← **Secrets and variables** ← **Actions** ומוסיפים:
   - בלשונית **Variables**: `AWS_DEPLOY_ROLE_ARN`, עם ה-`RoleArn` מהשלב הקודם.
   - בלשונית **Secrets**: `ALERT_EMAIL`, עם כתובת המייל להתרעות התקציב.
3. **בדיקה:** בלשונית **Actions** בוחרים **CI/CD** ← **Run workflow**.

## סביבת בדיקה (staging)

אותה תבנית בדיוק, עם `Stage=staging`. נפרס רק שרת הביניים, בשם `natbag-staging-proxy`, בלי תקציב, בלי ניטור ובלי התרעות.

- **אוטומטית:** כל push לענף `dev` ב-GitHub נפרס ל-stack בשם `natbag-staging`.
- **ידנית:**
  ```bash
  sam deploy --stack-name natbag-staging --resolve-s3 --capabilities CAPABILITY_IAM \
    --parameter-overrides Stage=staging AlertEmail=you@example.com
  ```
- **בדף:** מדביקים את ה-`ProxyUrl` של staging ב-`STAGING_PROXY_URL` שב-`monitor.html`, ופותחים `monitor.html?env=staging`.
- **מחיקה:** `sam delete --stack-name natbag-staging`.

## עדכון והסרה

```bash
sam deploy                      # אחרי שינוי בקוד
sam delete --stack-name natbag  # מוחק את כל המשאבים
```
