variable "aws_region" {
  description = "האזור ב-AWS שבו רץ השרת"
  type        = string
  default     = "us-east-1"
}

variable "github_owner" {
  description = "שם המשתמש ב-GitHub"
  type        = string
  default     = "ackerme"
}

variable "repository" {
  description = "שם ה-repo"
  type        = string
  default     = "natbag-monitor"
}

variable "deploy_role_arn" {
  description = "התפקיד ש-GitHub Actions מקבל ב-AWS דרך OIDC (נוצר ב-natbag-aws/github-oidc.yaml)"
  type        = string
  default     = "arn:aws:iam::299482272081:role/gha-natbag-deploy"

  validation {
    condition     = can(regex("^arn:aws:iam::\\d{12}:role/", var.deploy_role_arn))
    error_message = "צריך להיות ARN של תפקיד IAM."
  }
}
