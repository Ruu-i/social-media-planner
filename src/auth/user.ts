import { CognitoJwtVerifier } from "aws-jwt-verify";

import type { FunctionUrlEvent } from "../lambda/runtime.js";

/**
 * Who is making this request.
 *
 * The app had no answer to that question: USER_ID was a module constant, so
 * every visitor was the same person. Opening the URL on a second device showed
 * the first device's connected Instagram account and offered to publish to it.
 * That is not a leak through a flaw — it is what "no authentication" means, and
 * it was fine only while the URL was private.
 *
 * The token is verified against Cognito's public keys on every request. It is
 * never trusted because it looks well-formed: a signature check is the entire
 * point, and skipping it would let anyone mint a userId by editing a header.
 */

export interface AuthedUser {
  userId: string;
  email: string | null;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Built lazily and kept per container.
 *
 * The verifier caches Cognito's JWKS, so constructing one per request would
 * fetch the key set every time — slow, and rate-limited by Cognito if the app
 * were ever busy.
 */
let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

function getVerifier() {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const clientId = process.env.COGNITO_CLIENT_ID;
  if (!userPoolId || !clientId) return null;

  verifier ??= CognitoJwtVerifier.create({
    userPoolId,
    clientId,
    // The ID token, not the access token: this app wants to know WHO the user
    // is, and only the id token carries their identity claims.
    tokenUse: "id",
  });
  return verifier;
}

/** Whether authentication is configured at all. */
export function authEnabled(): boolean {
  return Boolean(process.env.COGNITO_USER_POOL_ID && process.env.COGNITO_CLIENT_ID);
}

/**
 * Resolve the caller, or throw.
 *
 * Returns a fixed demo identity when Cognito is not configured, so local
 * development and the test suite keep working without a user pool. That
 * fallback is deliberately keyed on configuration being ABSENT rather than on
 * a NODE_ENV flag — a misread environment variable should not silently turn
 * authentication off in production.
 */
export async function authenticate(event: FunctionUrlEvent): Promise<AuthedUser> {
  const v = getVerifier();
  if (!v) return { userId: "user_demo", email: null };

  const header = event.headers.authorization ?? event.headers.Authorization ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new AuthError("Sign in to continue");

  try {
    const claims = await v.verify(token);
    return {
      // `sub` is Cognito's stable id for the user. Email is not used as the key
      // because a user can change it, and every row in DynamoDB is partitioned
      // by this value.
      userId: `user_${String(claims.sub)}`,
      email: typeof claims.email === "string" ? claims.email : null,
    };
  } catch {
    // Expired and forged are the same answer to the caller: sign in again.
    // Saying which would tell an attacker whether a token was ever valid.
    throw new AuthError("Your session has expired. Sign in again.");
  }
}
