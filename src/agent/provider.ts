import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";

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
 * Build the client.
 *
 * Bedrock credentials come from the standard AWS chain — environment
 * variables, `~/.aws/credentials`, or, in a Lambda, the execution role. Nothing
 * needs to be passed explicitly in any of those cases.
 */
export function createClient(provider = resolveProvider()) {
  if (provider === "bedrock") {
    return new AnthropicBedrockMantle({
      awsRegion: process.env.AWS_REGION ?? "us-east-1",
    });
  }
  return new Anthropic();
}

/** A human-readable description of where inference is going, for logs and UI. */
export function describeProvider(provider = resolveProvider()): string {
  return provider === "bedrock"
    ? `Bedrock (${process.env.AWS_REGION ?? "us-east-1"}) · ${resolveModel(provider)}`
    : `Anthropic API · ${resolveModel(provider)}`;
}
