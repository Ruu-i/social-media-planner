import "dotenv/config";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";

/**
 * A one-shot Bedrock connectivity check.
 *
 * Exists so that "is AWS configured correctly?" can be answered separately from
 * "is my application correct?". When the first real agent run fails, you want to
 * already know which of those two it is.
 *
 * Deliberately tiny: max_tokens 16, one word of output. Costs a fraction of a
 * cent to run.
 */

const region = process.env.AWS_REGION ?? "us-east-1";
const model = process.env.MODEL_ID ?? "anthropic.claude-opus-5";

function ok(line: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${line}`);
}
function bad(line: string) {
  console.log(`  \x1b[31m✗\x1b[0m ${line}`);
}
function hint(line: string) {
  console.log(`    \x1b[2m${line}\x1b[0m`);
}

async function main() {
  console.log(`\nBedrock check — region ${region}, model ${model}\n`);

  // Credentials are resolved from the standard AWS chain, so the useful thing
  // to report is which source actually supplied them.
  const hasEnvKeys = Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
  if (hasEnvKeys) {
    ok(`credentials from environment (${process.env.AWS_ACCESS_KEY_ID!.slice(0, 8)}…)`);
  } else if (process.env.AWS_PROFILE) {
    ok(`credentials from profile "${process.env.AWS_PROFILE}"`);
  } else {
    hint("no AWS_ACCESS_KEY_ID in the environment — falling back to ~/.aws/credentials");
  }

  const client = new AnthropicBedrockMantle({ awsRegion: region });

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with the single word: connected" }],
    });

    const text = response.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    ok(`Bedrock replied: "${text}"`);
    ok(`tokens in ${response.usage.input_tokens}, out ${response.usage.output_tokens}`);
    console.log(`\n\x1b[32mBedrock is working.\x1b[0m Set LLM_PROVIDER=bedrock and run npm run agent.\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    bad(message.slice(0, 300));
    console.log();
    diagnose(message);
    process.exit(1);
  }
}

/**
 * Turn the three failures that actually happen into the fix, rather than
 * leaving an AWS error code to be searched for.
 */
function diagnose(message: string) {
  const m = message.toLowerCase();

  if (m.includes("could not load credentials") || m.includes("credential")) {
    console.log("  No AWS credentials were found.");
    hint("Put AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env,");
    hint("or run: aws configure");
    return;
  }

  if (m.includes("is not available for this account")) {
    console.log("  Credentials and model id are both correct.");
    console.log("  Anthropic models need a ONE-TIME use case form on this account.");
    hint("");
    hint("The old 'Model access' page has been retired — serverless models are");
    hint("enabled automatically now. Anthropic is the exception: a first-time");
    hint("usage form is still required, and access is granted immediately on");
    hint("submission.");
    hint("");
    hint("Console route:");
    hint("  Bedrock -> Model catalog -> pick a Claude model -> open in Playground.");
    hint("  The form appears on first use. Fill it in once, for the account.");
    hint("");
    hint("CLI route:");
    hint("  aws bedrock put-use-case-for-model-access \\");
    hint("    --form-data fileb://use-case.json --region " + region);
    hint("");
    hint("  where use-case.json holds YOUR real details:");
    hint('  { "companyName": "...", "companyWebsite": "...",');
    hint('    "intendedUsers": "...", "industryOption": "...",');
    hint('    "otherIndustryOption": "", "useCases": "..." }');
    return;
  }

  if (m.includes("does not exist")) {
    console.log("  Wrong model id for this endpoint.");
    hint("This SDK uses bedrock-mantle, which wants the plain vendor prefix:");
    hint("  anthropic.claude-opus-5");
    hint("The us. / eu. / global. geo profiles are for bedrock-runtime, not this.");
    return;
  }

  if (m.includes("accessdenied") || m.includes("not authorized") || m.includes("forbidden")) {
    console.log("  Credentials work, but this identity lacks Bedrock permission.");
    hint("This SDK uses the bedrock-mantle endpoint, which needs");
    hint("bedrock-mantle:CreateInference — NOT the bedrock:InvokeModel");
    hint("permission most tutorials show. Attach this policy:");
    hint("");
    hint('  { "Effect": "Allow",');
    hint('    "Action": "bedrock-mantle:CreateInference",');
    hint('    "Resource": "arn:aws:bedrock-mantle:*:<ACCOUNT_ID>:project/*" }');
    return;
  }

  if (m.includes("model") && (m.includes("access") || m.includes("not found"))) {
    console.log("  The model is not reachable in this region.");
    hint(`Try another region, or check the id "${model}" is right.`);
    hint("Geo profiles: us. / eu. / au. / global. prefix the model name.");
    return;
  }

  if (m.includes("throttl") || m.includes("too many")) {
    console.log("  Throttled. Wait a moment and retry — this is not a config problem.");
    return;
  }

  console.log("  Unrecognised failure. The message above is the thing to search for.");
}

main();
