/**
 * Re-exports plus a cached config read.
 *
 * App needs the config before it can decide what to render, and several places
 * ask for it; fetching per caller would mean three identical requests on every
 * load before anything appears.
 */
import { getConfig } from "./api";
import type { AuthConfig } from "./auth";

export {
  completeSignIn,
  signIn,
  signOut,
  storedToken,
  tokenEmail,
  tokenExpired,
  tokenSubject,
} from "./auth";
export type { AuthConfig } from "./auth";

let cached: Promise<AuthConfig | null> | null = null;

export function getConfigOnce(): Promise<AuthConfig | null> {
  cached ??= getConfig().catch(() => null);
  return cached;
}
