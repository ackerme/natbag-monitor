terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.70, < 7.0"
    }
    github = {
      source  = "integrations/github"
      version = "~> 6.6"
    }
  }

  # ה-state נשמר מקומית כברירת מחדל. כדי לשמור אותו ב-S3 (מומלץ לעבודה בצוות):
  # backend "s3" {
  #   bucket       = "natbag-terraform-state-<מספר-החשבון>"
  #   key          = "ops/terraform.tfstate"
  #   region       = "us-east-1"
  #   encrypt      = true
  #   use_lockfile = true
  # }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = { Project = "natbag-monitor", ManagedBy = "terraform" }
  }
}

# הטוקן נלקח מהמשתנה GITHUB_TOKEN (fine-grained, הרשאות Administration + Variables + Secrets ל-repo הזה בלבד)
provider "github" {
  owner = var.github_owner
}
