import { useState } from "react";

import { signIn, type AuthConfig } from "../auth";

/**
 * The gate.
 *
 * Until this existed, every visitor was the same user: opening the link on a
 * second device showed the first device's connected Instagram account and
 * offered to publish to it. Not a flaw in the authentication — there was none.
 *
 * Sign-in itself happens on Cognito's hosted page, so no password is ever typed
 * into anything in this repository, and this app never holds one.
 */
export function SignIn({ config }: { config: AuthConfig }) {
  const [busy, setBusy] = useState<string | null>(null);

  const available = config.cognito.providers ?? [];
  const has = (p: string) => available.includes(p);

  const go = (provider?: "Google" | "Facebook") => {
    setBusy(provider ?? "email");
    void signIn(config, provider).catch(() => setBusy(null));
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[radial-gradient(ellipse_at_top,_#ede9fe_0%,_#faf5ff_35%,_#ffffff_70%)] px-6">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-40 -left-40 h-[32rem] w-[32rem] rounded-full bg-violet-400/30 blur-[120px]" />
        <div className="absolute right-[-10rem] bottom-[-8rem] h-[30rem] w-[30rem] rounded-full bg-fuchsia-300/30 blur-[120px]" />
      </div>

      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-[14px] font-bold text-white shadow-sm shadow-violet-300">
            F
          </span>
          <span className="text-[15px] font-bold tracking-tight text-stone-900">FollowFav</span>
        </div>

        <div className="mt-6 rounded-2xl border border-white/60 bg-white/80 p-7 shadow-xl shadow-violet-200/40 backdrop-blur-sm">
          <h1 className="text-center text-[19px] font-bold tracking-tight text-stone-900">
            Sign in to continue
          </h1>
          <p className="mt-1.5 text-center text-[12px] leading-relaxed text-stone-600">
            Your calendar, your connected accounts and your photos are yours alone.
          </p>

          <div className="mt-6 space-y-2.5">
            {has("Google") && (
            <button
              disabled={busy !== null}
              onClick={() => go("Google")}
              className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-stone-200 bg-white px-4 py-3 text-[13px] font-semibold text-stone-700 transition hover:border-stone-300 disabled:opacity-50"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4">
                <path fill="#4285F4" d="M23 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.2a5.3 5.3 0 0 1-2.3 3.5v2.9h3.7c2.2-2 3.4-5 3.4-8.6Z" />
                <path fill="#34A853" d="M12 24c3.1 0 5.7-1 7.6-2.8l-3.7-2.9c-1 .7-2.3 1.1-3.9 1.1-3 0-5.5-2-6.4-4.7H1.8v3C3.7 21.4 7.6 24 12 24Z" />
                <path fill="#FBBC05" d="M5.6 14.7a7.2 7.2 0 0 1 0-4.6v-3H1.8a12 12 0 0 0 0 10.6l3.8-3Z" />
                <path fill="#EA4335" d="M12 4.8c1.7 0 3.2.6 4.4 1.7l3.3-3.3C17.7 1.2 15.1 0 12 0 7.6 0 3.7 2.6 1.8 6.1l3.8 3C6.5 6.7 9 4.8 12 4.8Z" />
              </svg>
              {busy === "Google" ? "Opening…" : "Continue with Google"}
            </button>
            )}

            {has("Facebook") && (
            <button
              disabled={busy !== null}
              onClick={() => go("Facebook")}
              className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-stone-200 bg-white px-4 py-3 text-[13px] font-semibold text-stone-700 transition hover:border-stone-300 disabled:opacity-50"
            >
              <svg viewBox="0 0 24 24" fill="#1877F2" className="h-4 w-4">
                <path d="M22 12a10 10 0 1 0-11.56 9.88v-6.99H7.9V12h2.54V9.8c0-2.5 1.49-3.89 3.77-3.89 1.1 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56V12h2.78l-.44 2.89h-2.34v6.99A10 10 0 0 0 22 12Z" />
              </svg>
              {busy === "Facebook" ? "Opening…" : "Continue with Facebook"}
            </button>
            )}

            {available.length > 0 && (
            <div className="flex items-center gap-3 py-1">
              <span className="h-px flex-1 bg-stone-200" />
              <span className="text-[10px] font-medium tracking-wide text-stone-400">OR</span>
              <span className="h-px flex-1 bg-stone-200" />
            </div>
            )}

            <button
              disabled={busy !== null}
              onClick={() => go()}
              className="w-full rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-500 px-4 py-3 text-[13px] font-semibold text-white shadow-lg shadow-violet-300/40 transition hover:brightness-110 disabled:opacity-50"
            >
              {busy === "email" ? "Opening…" : "Continue with email"}
            </button>
          </div>

          <p className="mt-5 text-center text-[11px] leading-relaxed text-stone-500">
            New here? The same button creates your account.
          </p>
        </div>

        <p className="mt-5 text-center text-[11px] text-stone-500">
          <a href="/" className="font-medium text-violet-700 hover:text-violet-800">
            ← Back to the homepage
          </a>
        </p>
      </div>
    </div>
  );
}
