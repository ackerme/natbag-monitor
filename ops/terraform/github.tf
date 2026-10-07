# ההגדרות של ה-repo ב-GitHub כקוד: אבטחה, הגנה על main ומשתני ה-CI.
# ה-repo כבר קיים, אז בהרצה הראשונה Terraform מייבא אותו (בלוקי import) במקום ליצור חדש.

import {
  to = github_repository.natbag
  id = var.repository
}

resource "github_repository" "natbag" {
  name         = var.repository
  description  = "ניטור התנועה האווירית סביב נתב\"ג בזמן אמת: רדאר, סטטיסטיקה וקו טלפוני. AWS Lambda, IaC, CI/CD ו-DevSecOps."
  homepage_url = "https://${var.github_owner}.github.io/${var.repository}/"
  visibility   = "public"
  topics       = ["adsb", "aws-lambda", "aws-sam", "devops", "devsecops", "prometheus", "grafana", "terraform", "ansible", "ivr"]

  has_issues             = true
  has_wiki               = false
  has_projects           = false
  delete_branch_on_merge = true
  allow_squash_merge     = true
  allow_merge_commit     = false
  allow_rebase_merge     = false

  # התרעות Dependabot על חבילות עם חולשות
  vulnerability_alerts = true

  # סריקת סודות + חסימת push שמכיל סוד (חינם ב-repo ציבורי)
  security_and_analysis {
    secret_scanning {
      status = "enabled"
    }
    secret_scanning_push_protection {
      status = "enabled"
    }
  }

  lifecycle {
    prevent_destroy = true
    # GitHub Pages מנוהל בהגדרות של GitHub, לא כאן
    ignore_changes = [pages, template]
  }
}

# Dependabot פותח Pull Request אוטומטי לתיקוני אבטחה
resource "github_repository_dependabot_security_updates" "natbag" {
  repository = github_repository.natbag.name
  enabled    = true
}

# הגנה על main: אי אפשר למחוק את הענף או לשכתב את ההיסטוריה שלו (force push).
# לא מחייב Pull Request – כך שהעלאה דרך האתר של GitHub ממשיכה לעבוד.
resource "github_repository_ruleset" "protect_main" {
  name        = "protect-main"
  repository  = github_repository.natbag.name
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["~DEFAULT_BRANCH"]
      exclude = []
    }
  }

  rules {
    deletion         = true
    non_fast_forward = true
  }
}

# המשתנה שה-CI משתמש בו כדי להתחבר ל-AWS (OIDC) – כבר קיים, מייבאים אותו
import {
  to = github_actions_variable.deploy_role
  id = "${var.repository}:AWS_DEPLOY_ROLE_ARN"
}

resource "github_actions_variable" "deploy_role" {
  repository    = github_repository.natbag.name
  variable_name = "AWS_DEPLOY_ROLE_ARN"
  value         = var.deploy_role_arn
}
