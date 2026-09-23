output "api_url" {
  description = "The API. Public HTTPS, no domain required — put this in the web build."
  value       = aws_lambda_function_url.api.function_url
}

output "web_url" {
  description = "The UI. Also public HTTPS with no domain required."
  value       = "https://${aws_cloudfront_distribution.web.domain_name}"
}

output "web_bucket" {
  description = "Sync the Vite build here, then invalidate the distribution."
  value       = aws_s3_bucket.web.id
}

output "distribution_id" {
  description = "Needed for cache invalidation after a UI deploy."
  value       = aws_cloudfront_distribution.web.id
}

output "table_name" {
  value = aws_dynamodb_table.main.name
}

output "next_steps" {
  value = <<-EOT

    1. Put the Anthropic key in Parameter Store (free, unlike Secrets Manager):
         aws ssm put-parameter --name ${var.api_key_parameter} \
           --type SecureString --value sk-ant-... --region ${var.region}

    2. Build the UI against the API URL, then upload:
         cd web
         VITE_API_BASE=${aws_lambda_function_url.api.function_url} npm run build
         aws s3 sync dist s3://${aws_s3_bucket.web.id} --delete
         aws cloudfront create-invalidation \
           --distribution-id ${aws_cloudfront_distribution.web.id} --paths "/*"

    3. Open https://${aws_cloudfront_distribution.web.domain_name}

    4. Tighten CORS: set cors_origins to that domain and apply again.

  EOT
}
