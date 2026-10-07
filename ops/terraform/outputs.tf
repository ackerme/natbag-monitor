output "grafana_iam_user" {
  description = "משתמש הקריאה בלבד ל-Grafana"
  value       = aws_iam_user.grafana.name
}

output "create_grafana_key_command" {
  description = "הפקודה ליצירת מפתח (פעם אחת, ב-CloudShell). את התוצאה מעתיקים ל-ops/monitoring/.env בלבד"
  value       = "aws iam create-access-key --user-name ${aws_iam_user.grafana.name}"
}

output "repository_url" {
  value = github_repository.natbag.html_url
}
