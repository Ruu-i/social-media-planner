import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

/**
 * The provider seam.
 *
 * The Messages API surface is identical across Anthropic's first-party API and
 * Bedrock, so switching is a constructor — not a rewrite. Everything downstream
 * of this file calls `messages.create` / `toolRunner` and never learns which
 * one it got.
 *
 * Worth being clear about a thing that confuses people: **Bedrock needs an AWS
 * account, not AWS hosting.** It is an API you call with AWS credentials. This
 * process can run on your laptop, on Render, or in a Lambda, and reach Bedrock
 * identically. Only the credential source changes.
 *
 * Two reasons Bedrock is the better target for a deployed demo:
 *
 *   - In a Lambda there is no API key at all. The execution role carries
 *     `bedrock:InvokeModel`, so there is no secret to store, rotate or leak.
 *   - Model spend lands on the AWS bill, so one AWS Budget bounds inference
 *     AND infrastructure together rather than leaving two separate surfaces.
 *
 * What Bedrock does not carry, all currently unused here but on the roadmap:
 * the web search server tool, server-side refusal fallbacks, and the Files and
 * Batches APIs. Web search is the one that matters later, and the reason this
 * seam exists rather than Bedrock being hard-coded.
 */

export type Provider = "anthropic" | "bedrock";

export function resolveProvider(): Provider {
  return process.env.LLM_PROVIDER === "bedrock" ? "bedrock" : "anthropic";
}

/**
 * Model ids differ between the two.
 *
 * Bedrock prefixes with the vendor: `anthropic.claude-opus-5`.
 *
 * Verified by probing the endpoint rather than assumed: the geo inference
 * profiles (`us.`, `eu.`, `global.`) that work on the bedrock-runtime
 * InvokeModel path return "does not exist" on the bedrock-mantle endpoint this
 * SDK uses. A bare `claude-opus-5` does too.
 */
export function resolveModel(provider = resolveProvider()): string {
  if (process.env.MODEL_ID) return process.env.MODEL_ID;
  return provider === "bedrock" ? "anthropic.claude-opus-5" : "claude-opus-5";
}

/**
 * Fetch the API key from SSM Parameter Store, once per container.
 *
 * In Lambda there is no .env file and the key must not be a plaintext
 * environment variable — anyone with console read access would see it. The
 * function's role grants ssm:GetParameter on exactly one path, and the value is
 * decrypted here at cold start.
 *
 * A no-op when ANTHROPIC_API_KEY is already set (local development) or when
 * running on Bedrock, where IAM replaces the key entirely.
 */
let keyPromise: Promise<void> | null = null;

export function ensureApiKey(): Promise<void> {
  keyPromise ??= (async () => {
    if (process.env.ANTHROPIC_API_KEY) return;
    if (resolveProvider() === "bedrock") return;

    const name = process.env.API_KEY_PARAMETER;
    if (!name) return;

    const ssm = new SSMClient({ region: process.env.AWS_REGION ?? "us-east-1" });
    const result = await ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    const value = result.Parameter?.Value;
    if (!value) {
      throw new Error(
        `SSM parameter ${name} is empty. Put the key there with:
` +
          `  aws ssm put-parameter --name ${name} --type SecureString --value sk-ant-...`,
      );
    }
    process.env.ANTHROPIC_API_KEY = value;
  })();

  return keyPromise;
}

/**
 * Build the client, LAZILY.
 *
 * Lazy matters: the key arrives from SSM asynchronously at cold start, and a
 * client constructed at module-import time would capture an empty key before
 * the fetch ever ran. Deferring construction to first use means it picks up
 * whatever ensureApiKey resolved.
 *
 * Bedrock credentials come from the standard AWS chain — environment
 * variables, ~/.aws/credentials, or in a Lambda the execution role.
 */
let cached: { provider: Provider; client: Anthropic | AnthropicBedrockMantle } | null = null;

export function createClient(provider = resolveProvider()) {
  if (cached?.provider === provider) return cached.client;

  const client =
    provider === "bedrock"
      ? new AnthropicBedrockMantle({ awsRegion: process.env.AWS_REGION ?? "us-east-1" })
      : new Anthropic();

  cached = { provider, client };
  return client;
}

/** A human-readable description of where inference is going, for logs and UI. */
export function describeProvider(provider = resolveProvider()): string {
  return provider === "bedrock"
    ? `Bedrock (${process.env.AWS_REGION ?? "us-east-1"}) · ${resolveModel(provider)}`
    : `Anthropic API · ${resolveModel(provider)}`;
}
