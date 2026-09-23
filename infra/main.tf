terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
    }
  }
}

# ---------------------------------------------------------------------------
# Topology
#
# CloudFront serves the React build. The browser calls the Lambda Function URL
# DIRECTLY for the API — CloudFront is deliberately NOT in front of it.
#
# That is not laziness. CloudFront buffers streaming responses, which would
# defeat the entire reason this app uses a Function URL: an agent turn takes
# ~80 seconds and the UI shows progress as it happens. Put a buffering CDN in
# the path and the user sees nothing for eighty seconds, then everything at
# once.
#
# The cost is two origins, so the API needs CORS — which the handler already
# answers. When a custom domain arrives, the UI moves to it and the API can
# either stay on its Function URL or get a subdomain of its own.
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}

locals {
  name = var.project
}

# ---------------------------------------------------------------------------
# DynamoDB — one table, two GSIs
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "main" {
  name = local.name

  # On-demand: no provisioned capacity ticking over when nobody is visiting,
  # and 25 GB of storage is permanently free.
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }
  attribute {
    name = "GSI1PK"
    type = "S"
  }
  attribute {
    name = "GSI1SK"
    type = "S"
  }
  attribute {
    name = "GSI2PK"
    type = "S"
  }
  attribute {
    name = "GSI2SK"
    type = "S"
  }

  # Items by campaign, variants by item.
  global_secondary_index {
    name            = "GSI1"
    hash_key        = "GSI1PK"
    range_key       = "GSI1SK"
    projection_type = "ALL"
  }

  # The publisher's work queue. Sparse: only SCHEDULED variants carry a GSI2PK,
  # so this index holds pending work rather than every row in the table.
  global_secondary_index {
    name            = "GSI2"
    hash_key        = "GSI2PK"
    range_key       = "GSI2SK"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = var.enable_pitr
  }
}

# ---------------------------------------------------------------------------
# S3 — the React build, and uploaded media
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "web" {
  bucket        = "${local.name}-web-${data.aws_caller_identity.current.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Media needs to be publicly READABLE, because Meta's publishing API does not
# accept bytes — it fetches the image from a URL you hand it. A private bucket
# the publisher reads into memory would not work.
resource "aws_s3_bucket" "media" {
  bucket        = "${local.name}-media-${data.aws_caller_identity.current.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = false
  ignore_public_acls      = true
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "media_public_read" {
  bucket     = aws_s3_bucket.media.id
  depends_on = [aws_s3_bucket_public_access_block.media]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "PublicReadForMetaFetch"
      Effect    = "Allow"
      Principal = "*"
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.media.arn}/*"
    }]
  })
}

# ---------------------------------------------------------------------------
# IAM — least privilege for the Lambda
# ---------------------------------------------------------------------------

resource "aws_iam_role" "lambda" {
  name = "${local.name}-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "lambda" {
  name = "${local.name}-lambda"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "Logs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = "${aws_cloudwatch_log_group.lambda.arn}:*"
      },
      {
        Sid    = "TableAccess"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:TransactWriteItems",
        ]
        # Index ARNs are separate resources from the table's, so both are
        # needed — a policy granting only the table silently fails every Query
        # against GSI1 or GSI2.
        Resource = [
          aws_dynamodb_table.main.arn,
          "${aws_dynamodb_table.main.arn}/index/*",
        ]
      },
      {
        Sid      = "MediaBucket"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.media.arn}/*"
      },
      {
        # Bedrock, for when the account's on-demand quota is granted. This SDK
        # uses the bedrock-mantle endpoint, which wants CreateInference — NOT
        # the bedrock:InvokeModel permission most tutorials show.
        Sid      = "BedrockInference"
        Effect   = "Allow"
        Action   = "bedrock-mantle:CreateInference"
        Resource = "arn:aws:bedrock-mantle:*:${data.aws_caller_identity.current.account_id}:project/*"
      },
      {
        # The Anthropic API key, while inference runs first-party. Parameter
        # Store SecureString rather than Secrets Manager: functionally the same
        # here and $0.40/month cheaper per secret.
        Sid      = "ReadApiKey"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${var.api_key_parameter}"
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# Lambda
# ---------------------------------------------------------------------------

# Created explicitly so the retention actually applies. Left to Lambda, the log
# group is created on first invocation with retention set to "never expire",
# and logs quietly become the largest line on the bill.
resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.name}-api"
  retention_in_days = 7
}

resource "aws_lambda_function" "api" {
  function_name = "${local.name}-api"
  role          = aws_iam_role.lambda.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"

  filename         = var.lambda_zip
  source_code_hash = filebase64sha256(var.lambda_zip)

  # A turn takes ~80s; the ceiling allows for a slow one without allowing a
  # runaway to burn fifteen minutes of wall clock.
  timeout     = 180
  memory_size = 1024

  # The real spend limiter. Five concurrent 80-second turns is a hard ceiling
  # on how fast anyone — or any crawler — can spend money.
  reserved_concurrent_executions = var.reserved_concurrency

  environment {
    variables = {
      STORE                 = "dynamo"
      DDB_TABLE             = aws_dynamodb_table.main.name
      MEDIA_BUCKET          = aws_s3_bucket.media.id
      DEMO_MODE             = tostring(var.demo_mode)
      DEMO_DAILY_BUDGET_USD = tostring(var.daily_budget_usd)
      DEMO_TURNS_PER_HOUR   = tostring(var.turns_per_hour)
      LLM_PROVIDER          = var.llm_provider
      API_KEY_PARAMETER     = var.api_key_parameter
      # Defeats Lambda's undocumented small-frame buffering on SSE.
      SSE_PAD_BYTES = "1024"
      NODE_OPTIONS  = "--enable-source-maps"
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
}

# RESPONSE_STREAM is the whole point. Without it the Function URL buffers, and
# an 80-second turn arrives as one lump at the end.
resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"
  invoke_mode        = "RESPONSE_STREAM"

  cors {
    allow_origins = var.cors_origins

    # NOT "OPTIONS". Lambda rejects it: each member must be 6 characters or
    # fewer, and OPTIONS is 7. Preflight is answered by the Function URL itself
    # once CORS is configured, so listing it was both invalid and unnecessary.
    allow_methods = ["GET", "POST"]

    allow_headers = ["content-type"]
    max_age       = 3600
  }
}

# Setting authorization_type = "NONE" on the Function URL is only HALF of making
# it public. Lambda also needs a resource-based policy allowing anyone to invoke
# it; without this every request gets a 403 that reads like an auth
# misconfiguration, because it is one.
#
# The console adds this silently when you create a Function URL by hand, which
# is why the omission is easy to miss in Terraform.
resource "aws_lambda_permission" "function_url_public" {
  statement_id           = "AllowPublicFunctionUrlInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.api.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

# ---------------------------------------------------------------------------
# CloudFront — the React build only
# ---------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${local.name}-web"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "web" {
  enabled             = true
  default_root_object = "index.html"
  comment             = "${local.name} UI"
  price_class         = "PriceClass_100" # cheapest edge set; plenty for a demo

  origin {
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_id                = "web"
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  default_cache_behavior {
    target_origin_id       = "web"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # AWS managed policy: CachingOptimized
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  # A single-page app: every unknown path is a client route, not a 404.
  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }
  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    # The default *.cloudfront.net certificate. A custom domain swaps this for
    # an ACM cert, which MUST be issued in us-east-1 whatever region the rest
    # of the stack lives in.
    cloudfront_default_certificate = true
  }
}

resource "aws_s3_bucket_policy" "web_cloudfront" {
  bucket = aws_s3_bucket.web.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.web.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.web.arn
        }
      }
    }]
  })
}

# ---------------------------------------------------------------------------
# Budget alarm
#
# Not a charge — a notification rule. If this ever fires, something is
# misconfigured and you want to know on day two rather than on the invoice.
# ---------------------------------------------------------------------------

resource "aws_budgets_budget" "monthly" {
  count = var.budget_email == "" ? 0 : 1

  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_alert_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }
}
