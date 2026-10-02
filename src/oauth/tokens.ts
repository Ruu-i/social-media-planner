import {
  DeleteParameterCommand,
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";

import type { TokenStore } from "./types.js";

/**
 * Token storage.
 *
 * A `tokenRef` is an opaque string on the Connection row; only this module
 * knows how to turn one back into a token. That indirection is what lets the
 * content store, the agent's tool results and every log line carry a connection
 * around without carrying a credential.
 */

/** Development only. Tokens vanish with the process, which is the right default. */
export class MemoryTokenStore implements TokenStore {
  private tokens = new Map<string, string>();

  async put(ref: string, token: string): Promise<void> {
    this.tokens.set(ref, token);
  }

  async get(ref: string): Promise<string> {
    const token = this.tokens.get(ref);
    if (!token) throw new Error(`No token for ${ref}`);
    return token;
  }

  async remove(ref: string): Promise<void> {
    this.tokens.delete(ref);
  }
}

/**
 * SSM Parameter Store, SecureString.
 *
 * Not DynamoDB: the table is read by the API Lambda, the publisher, and
 * anything debugging a row, and a token sitting in it would be visible to all
 * of them and to anyone with console read access. A SecureString is KMS
 * encrypted at rest and granted separately in IAM, so reading posts and reading
 * credentials are two different permissions.
 *
 * Not Secrets Manager either: functionally equivalent here and $0.40/month per
 * secret, which for one secret per connected account is a real line item.
 */
export class SsmTokenStore implements TokenStore {
  private client: SSMClient;

  constructor(
    private prefix = process.env.TOKEN_PARAMETER_PREFIX ?? "/social-planner/tokens",
    client?: SSMClient,
  ) {
    this.client = client ?? new SSMClient({ region: process.env.AWS_REGION ?? "us-east-1" });
  }

  /** `ssm://...` refs are stored verbatim; anything else is namespaced. */
  private nameFor(ref: string): string {
    return ref.startsWith("/") ? ref : `${this.prefix}/${ref}`;
  }

  async put(ref: string, token: string): Promise<void> {
    await this.client.send(
      new PutParameterCommand({
        Name: this.nameFor(ref),
        Value: token,
        Type: "SecureString",
        // Reconnecting must replace the old token rather than fail. Without
        // this, every re-auth after the first one errors.
        Overwrite: true,
      }),
    );
  }

  async get(ref: string): Promise<string> {
    const result = await this.client.send(
      new GetParameterCommand({ Name: this.nameFor(ref), WithDecryption: true }),
    );
    const value = result.Parameter?.Value;
    if (!value) throw new Error(`No token stored at ${ref}`);
    return value;
  }

  async remove(ref: string): Promise<void> {
    try {
      await this.client.send(new DeleteParameterCommand({ Name: this.nameFor(ref) }));
    } catch (error) {
      // Disconnecting something already gone is a success, not an error — this
      // runs on a path the user triggered and cannot retry meaningfully.
      if ((error as { name?: string }).name !== "ParameterNotFound") throw error;
    }
  }
}

export function createTokenStore(): TokenStore {
  return process.env.STORE === "dynamo" ? new SsmTokenStore() : new MemoryTokenStore();
}
