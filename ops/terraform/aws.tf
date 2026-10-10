# משתמש IAM לקריאה בלבד מ-CloudWatch – בשביל ה-Grafana שרצה בבית.
# המפתח עצמו לא נוצר כאן בכוונה: מפתח שנוצר ב-Terraform נשמר כטקסט גלוי בקובץ ה-state.
# יוצרים אותו פעם אחת ידנית (הפקודה מופיעה ב-outputs) ושומרים אותו רק ב-.env של מערך הניטור.
# יוצר יוזר 
resource "aws_iam_user" "grafana" {
  #checkov:skip=CKV_AWS_273:Grafana רצה בבית, מחוץ ל-AWS, ולכן צריכה מפתח של משתמש. ההרשאה היא קריאה בלבד, דרך קבוצה, ומוגבלת לאזור אחד
  name = "natbag-grafana-readonly"
  path = "/natbag/"
}

data "aws_caller_identity" "current" {}

# ההרשאות מוצמדות לקבוצה ולא ישירות למשתמש (קל לנהל, ואפשר להוסיף עוד צופים)
resource "aws_iam_group" "grafana_readers" {
  name = "natbag-grafana-readers"
  path = "/natbag/"
}
# משייך את היוזר שיצרנו לקבוצה כך אתה יוצר קובצה אחת אם הרשאות ספציפיות ומשייך להם יוזרים
resource "aws_iam_user_group_membership" "grafana" {
  user   = aws_iam_user.grafana.name
  groups = [aws_iam_group.grafana_readers.name]
}
# מעניק הרשאה לשלוף נתוני מטריקות בכמות גדולה מ-CloudWatch (משמש לציור הגרפים ב-Grafana).
# מעניק הרשאה לשלוף סטטיסטיקות מקובצות על מטריקות (כגון ממוצע, מקסימום, מינימום וסכום).
# מעניק הרשאה להציג ולסקור את רשימת כל המטריקות הקיימות בחשבון ה-AWS (מאפשר ל-Grafana להציע לך מטריקות לבחירה).
# מעניק הרשאה לצפות בהתראות (Alarms) המשויכות למטריקה מסוימת ב-CloudWatch.

data "aws_iam_policy_document" "grafana_cloudwatch_read" {
  statement {
    sid    = "ReadMetrics"
    effect = "Allow"
    actions = [
      "cloudwatch:GetMetricData",
      "cloudwatch:GetMetricStatistics",
      "cloudwatch:ListMetrics",
      "cloudwatch:DescribeAlarmsForMetric",
    ]
    resources = ["*"] # הפעולות האלה לא תומכות בהגבלה למשאב מסוים (כך מוגדר ב-IAM של AWS)
  }

  # את ההתרעות אפשר להגביל – רק ההתרעות של הפרויקט
  statement {
    sid       = "ReadNatbagAlarms"
    effect    = "Allow"
    actions   = ["cloudwatch:DescribeAlarms"]
    resources = ["arn:aws:cloudwatch:${var.aws_region}:${data.aws_caller_identity.current.account_id}:alarm:natbag-*"]
  }

  statement {
    sid       = "GrafanaHelpers"
    effect    = "Allow"
    actions   = ["ec2:DescribeRegions", "tag:GetResources"]
    resources = ["*"]
  }

  # מגבלה נוספת: רק מהאזור שבו רץ השרת
  statement {
    sid         = "DenyOtherRegions"
    effect      = "Deny"
    not_actions = ["ec2:DescribeRegions"]
    resources   = ["*"]
    condition {
      test     = "StringNotEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
  }
}

resource "aws_iam_group_policy" "grafana_cloudwatch_read" {
  name   = "cloudwatch-read-only"
  group  = aws_iam_group.grafana_readers.name
  policy = data.aws_iam_policy_document.grafana_cloudwatch_read.json
}
