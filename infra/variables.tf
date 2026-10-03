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

# Narrowed from ["*"] once the CloudFront domain was known.
#
# "*" is right for the first apply — the distribution does not exist yet, so
# there is no origin to name — and wrong to leave in place: the Function URL is
# public and unauthenticated, so the only thing standing between a hostile page
# and a visitor's session is the browser refusing the cross-origin read.
#
# This does not restrict curl or a server-side caller; CORS never does. It stops
# somebody else's site from scripting against this API in your users' browsers.
#
# Local development is unaffected: `npm run api` serves its own API on
# localhost, so the browser never crosses an origin.
variable "cors_origins" {
  description = "Origins allowed to call the Function URL. Scheme and host only, no trailing slash."
  type        = list(string)
  default     = ["https://d252um6eslhku1.cloudfront.net"]
}

# How often the publisher sweeps for due posts.
#
# This is the worst-case lateness of a scheduled post, so it is a product
# decision rather than a tuning knob: five minutes is invisible for social
# scheduling, and one minute would be five times the invocations to buy
# precision nobody asked for.
variable "sweep_schedule" {
  description = "EventBridge schedule expression for the publisher sweep."
  type        = string
  default     = "rate(5 minutes)"
}

# The only switch here with an irreversible, PUBLIC side effect.
#
# Off by default and opt-in by name: with this false the publisher runs its
# whole pipeline against a mock that posts nothing, which is what every test and
# every demo wants. Setting it true means a scheduled post appears on a real
# Instagram account, with no undo.
variable "live_publishing" {
  description = "Publish to real social accounts. Leave false unless you mean it."
  type        = bool
  default     = false
}

variable "instagram_app_id" {
  description = "Instagram app (client) ID. Not a secret — the app SECRET goes in SSM."
  type        = string
  # The INSTAGRAM app id from "API setup with Instagram login", not the Meta app
  # id under App settings → Basic. They are different numbers and only this one
  # works with Instagram Login.
  default = "2159460094974977"
}

variable "public_api_base" {
  description = "Override for the API's public origin. Empty means derive it from the request Host."
  type        = string
  default     = ""
}

variable "oauth_secret_prefix" {
  description = "SSM path holding instagram-app-secret and oauth-state-secret."
  type        = string
  default     = "/social-planner/oauth"
}

variable "token_parameter_prefix" {
  description = "SSM path under which per-connection access tokens are stored."
  type        = string
  default     = "/social-planner/tokens"
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
