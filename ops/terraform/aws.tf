# משתמש IAM לקריאה בלבד מ-CloudWatch – בשביל ה-Grafana שרצה בבית.
# המפתח עצמו לא נוצר כאן בכוונה: מפתח שנוצר ב-Terraform נשמר כטקסט גלוי בקובץ ה-state.
# יוצרים אותו פעם אחת ידנית (הפקודה מופיעה ב-outputs) ושומרים אותו רק ב-.env של מערך הניטור.

resource "aws_iam_user" "grafana" {
  name = "natbag-grafana-readonly"
  path = "/natbag/"
}

data "aws_iam_policy_document" "grafana_cloudwatch_read" {
  statement {
    sid    = "ReadMetrics"
    effect = "Allow"
    actions = [
      "cloudwatch:GetMetricData",
      "cloudwatch:GetMetricStatistics",
      "cloudwatch:ListMetrics",
      "cloudwatch:DescribeAlarms",
      "cloudwatch:DescribeAlarmsForMetric",
    ]
    resources = ["*"] # פעולות הקריאה של CloudWatch לא תומכות בהגבלה למשאב מסוים
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

resource "aws_iam_user_policy" "grafana_cloudwatch_read" {
  name   = "cloudwatch-read-only"
  user   = aws_iam_user.grafana.name
  policy = data.aws_iam_policy_document.grafana_cloudwatch_read.json
}
