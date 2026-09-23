variable "project" {
  description = "Name prefix for every resource."
  type        = string
  default     = "social-planner"
}

variable "region" {
  description = "Region for everything except the ACM cert a custom domain would need."
  type        = string
  default     = "us-east-1"
}

variable "lambda_zip" {
  description = "Built by `npm run build:lambda` before `terraform apply`."
  type        = string
  default     = "../dist-lambda/function.zip"
}

variable "demo_mode" {
  description = "Enforce the spend cap. Must be true on a public URL; false locally."
  type        = bool
  default     = true
}

variable "daily_budget_usd" {
  description = "Agent spend allowed per day before the chat degrades gracefully."
  type        = number
  default     = 2
}

variable "turns_per_hour" {
  description = "Agent runs per client per hour, so one visitor cannot drain the day."
  type        = number
  default     = 5
}

variable "reserved_concurrency" {
  description = "Hard ceiling on concurrent turns — the real limiter on spend velocity."
  type        = number
  default     = 5
}

variable "llm_provider" {
  description = "anthropic | bedrock. Switch once the Bedrock on-demand quota is granted."
  type        = string
  default     = "anthropic"

  validation {
    condition     = contains(["anthropic", "bedrock"], var.llm_provider)
    error_message = "llm_provider must be anthropic or bedrock."
  }
}

variable "api_key_parameter" {
  description = "SSM Parameter Store path holding the Anthropic key (SecureString). Free, unlike Secrets Manager."
  type        = string
  default     = "/social-planner/anthropic-api-key"
}

variable "cors_origins" {
  description = "Origins allowed to call the Function URL. Narrow this to the CloudFront domain after the first apply."
  type        = list(string)
  default     = ["*"]
}

variable "budget_email" {
  description = "Where budget alerts go. Empty disables the budget."
  type        = string
  default     = ""
}

variable "budget_alert_usd" {
  description = "Monthly figure the alerts are a percentage of. Alerts fire at 50% and 100%."
  type        = number
  default     = 10
}

variable "enable_pitr" {
  description = "DynamoDB point-in-time recovery. Costs a little; off for a demo."
  type        = bool
  default     = false
}
