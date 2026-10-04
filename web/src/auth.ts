/**
 * Signing in, from the browser.
 *
 * Authorization Code with PKCE, not the implicit flow. A single-page app cannot
 * keep a client secret — anything shipped to the browser is readable — so PKCE
 * replaces it: the app invents a random verifier, sends only its hash when it
 * asks for a code, and proves possession of the original when it redeems one.
 * An intercepted code is therefore useless to whoever intercepted it.
 *
 * The id token is kept in sessionStorage rather than localStorage. It is the
 * credential for everything in this app, and sessionStorage dies with the tab —
 * so a shared or borrowed machine does not stay signed in, which is exactly the
 * failure this whole piece of work exists to stop.
 */

const TOKEN_KEY = "idToken";
const VERIFIER_KEY = "pkceVerifier";

export interface AuthConfig {
  authEnabled: boolean;
  cognito: { domain: string; clientId: string; providers?: string[] };
}

export function storedToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Decode the token's payload for display. NEVER for a decision — only the server verifies. */
export function tokenEmail(): string | null {
  const token = storedToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

/**
 * A stable key for whoever is signed in.
 *
 * Used to namespace per-user things kept in the browser. Without it the stored
 * session id was shared by everyone who ever signed in on this machine, so the
 * next person opened the previous person's conversation.
 */
export function tokenSubject(): string {
  const token = storedToken();
  if (!token) return "anon";
  try {
    const payload = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.sub === "string" ? payload.sub : "anon";
  } catch {
    return "anon";
  }
}

/** Expired tokens are worse than absent ones: they fail mid-action instead of at the door. */
export function tokenExpired(): boolean {
  const token = storedToken();
  if (!token) return true;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.exp !== "number" || payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

const redirectUri = () => `${window.location.origin}/app`;

/** Send the browser to the hosted sign-in page. */
export async function signIn(config: AuthConfig, provider?: "Google" | "Facebook"): Promise<void> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  sessionStorage.setItem(VERIFIER_KEY, verifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.cognito.clientId,
    redirect_uri: redirectUri(),
    scope: "openid email profile",
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
  });
  // Naming the provider skips the chooser and goes straight to Google or
  // Facebook, so the button the user pressed is the thing that happens.
  if (provider) params.set("identity_provider", provider);

  window.location.href = `${config.cognito.domain}/oauth2/authorize?${params}`;
}

/**
 * Finish the round trip if we have just come back with a code.
 *
 * Returns true when a sign-in completed, so the caller knows to re-read state.
 * The code is stripped from the URL afterwards: it is single-use, and leaving
 * it there means a refresh tries to redeem it again and fails confusingly.
 */
export async function completeSignIn(config: AuthConfig): Promise<boolean> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) return false;

  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  window.history.replaceState({}, "", window.location.pathname);
  if (!verifier) return false;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.cognito.clientId,
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });

  const res = await fetch(`${config.cognito.domain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return false;

  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) return false;

  sessionStorage.setItem(TOKEN_KEY, tokens.id_token);
  sessionStorage.removeItem(VERIFIER_KEY);
  return true;
}

export function signOut(config: AuthConfig): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(VERIFIER_KEY);
  } catch {
    /* ignore */
  }
  // Through Cognito's logout, not just locally: clearing our copy while the
  // hosted session survives means the next "sign in" silently returns the same
  // account, which on a shared machine is the bug we are trying to prevent.
  const params = new URLSearchParams({
    client_id: config.cognito.clientId,
    logout_uri: `${window.location.origin}/`,
  });
  window.location.href = `${config.cognito.domain}/logout?${params}`;
}
