import { OAuthError, type Grant, type OAuthProvider } from "./types.js";
import type { Provider } from "../schemas.js";

/**
 * A provider the app knows about but cannot connect yet.
 *
 * This exists because of a real hole: Facebook was simply absent from the
 * provider list, so the UI rendered it only when a connection happened to
 * exist. Disconnecting the seeded Facebook account made the row disappear
 * entirely — no Facebook, no explanation, no way back. The app looked like it
 * had forgotten Facebook was a thing.
 *
 * Declaring it unavailable is better than omitting it. "Not available yet,
 * here is why" is a product telling you where it is; a missing row is a product
 * that looks broken. It also makes the eventual implementation a swap rather
 * than an addition — the UI, the model and the panel already account for it.
 */
export class UnavailableProvider implements OAuthProvider {
  constructor(
    readonly provider: Provider,
    readonly unavailableReason: string,
  ) {}

  /** Always false. That is the entire point of this class. */
  isConfigured(): boolean {
    return false;
  }

  async verify(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: false, reason: this.unavailableReason };
  }

  authorizeUrl(): string {
    throw new OAuthError(this.unavailableReason, "NOT_CONFIGURED");
  }

  async exchange(): Promise<Grant> {
    throw new OAuthError(this.unavailableReason, "NOT_CONFIGURED");
  }
}
