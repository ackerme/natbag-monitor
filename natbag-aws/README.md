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
| `natbag-proxy` | Lambda עם Function URL ציבורי, CORS, מעבר אוטומטי בין מקורות, מטמון של 10 שניות ודחיסת gzip |
| SSM Parameter Store | שומר את מפתח OpenSky מוצפן (SecureString), כך שהוא לא נמצא בקוד |
| AWS Budgets | תקציב חודשי של 1$. ב-50% נשלח מייל אזהרה, וב-100% נשלח מייל ומופעל כיבוי |
| `natbag-killswitch` | מקבל את ההתרעה דרך SNS ומוריד את ה-concurrency של השרת ל-0 |
| CloudWatch Logs | הלוגים נשמרים 3 ימים בלבד, כדי שלא תצטבר עלות אחסון |

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

## עדכון והסרה

```bash
sam deploy                      # אחרי שינוי בקוד
sam delete --stack-name natbag  # מוחק את כל המשאבים
```
