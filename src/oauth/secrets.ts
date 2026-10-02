import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";

/**
 * Pull the OAuth secrets into the environment, once per container.
 *
 * Two values that must never be plaintext environment variables on the
 * function, because anyone with console read access on the Lambda can see
 * those:
 *
 *   INSTAGRAM_APP_SECRET   mints tokens for any account that has granted the app
 *   OAUTH_STATE_SECRET     signs the state; forging one turns the callback into
 *                          an endpoint that attaches an ATTACKER's Instagram
 *                          account to someone else's planner, or the reverse
 *
 * The app ID is not secret and stays a plain env var.
 *
 * Mirrors ensureApiKey in agent/provider.ts — same reasoning, same once-per-
 * container memoisation, and the same reason every consumer reads its
 * credentials lazily rather than at module load.
 */
let secretsPromise: Promise<void> | null = null;

export function ensureOAuthSecrets(): Promise<void> {
  secretsPromise ??= (async () => {
    const prefix = process.env.OAUTH_SECRET_PREFIX;
    if (!prefix) return;

    // Already present — local development with a .env file.
    if (process.env.INSTAGRAM_APP_SECRET && process.env.OAUTH_STATE_SECRET) return;

    const names = [`${prefix}/instagram-app-secret`, `${prefix}/oauth-state-secret`];
    const ssm = new SSMClient({ region: process.env.AWS_REGION ?? "us-east-1" });
    const result = await ssm.send(
      new GetParametersCommand({ Names: names, WithDecryption: true }),
    );

    for (const parameter of result.Parameters ?? []) {
      if (parameter.Name?.endsWith("instagram-app-secret") && parameter.Value) {
        process.env.INSTAGRAM_APP_SECRET = parameter.Value;
      }
      if (parameter.Name?.endsWith("oauth-state-secret") && parameter.Value) {
        process.env.OAUTH_STATE_SECRET = parameter.Value;
      }
    }

    // Deliberately NOT an error. A missing secret means Instagram has not been
    // set up yet, which the UI already renders as "Not available yet" — the
    // rest of the app works, and failing here would take it down with it.
    if (result.InvalidParameters?.length) {
      console.warn(
        JSON.stringify({ msg: "oauth: secrets not set", missing: result.InvalidParameters }),
      );
    }
  })();

  return secretsPromise;
}
