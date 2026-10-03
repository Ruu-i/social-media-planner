import { useCallback, useEffect, useState } from "react";
import { api, type Account, type ContentItem, type MediaAsset, type PublishOutcome } from "./api";
import { Chat } from "./components/Chat";
import { Calendar } from "./components/Calendar";
import { MediaLibrary } from "./components/MediaLibrary";
import { Accounts } from "./components/Accounts";
import { Tooltip } from "./components/Tooltip";
import { Notifications } from "./components/Notifications";
import { AnimatedBackdrop } from "./ui";

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [tab, setTab] = useState<"calendar" | "media">("calendar");
  const [items, setItems] = useState<ContentItem[]>([]);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [showAccounts, setShowAccounts] = useState(false);
  const [livePublishing, setLivePublishing] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [connectNotice, setConnectNotice] = useState<string | null>(null);
  const [connectOk, setConnectOk] = useState(true);
  /**
   * A message the calendar wants the agent to receive.
   *
   * Lifted to App because the two panels are siblings: approving a post happens
   * on the left and the agent lives on the right, and the whole point is that
   * one leads to the other. Chat consumes it and clears it.
   */
  const [agentPrompt, setAgentPrompt] = useState<string | null>(null);

  /**
   * The return leg of the OAuth round trip.
   *
   * The callback redirects here with ?connected=1, which is the only signal the
   * SPA gets that a connection was made — it was a full page navigation, so all
   * component state from before the redirect is gone. The query is cleared
   * afterwards so reloading does not re-announce a connection.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    if (!connected) return;

    setConnectOk(connected === "1");
    setConnectNotice(
      connected === "1"
        ? `Connected ${params.get("handle") ?? "your account"}`
        : `Could not connect: ${params.get("reason") ?? "the request was declined"}`,
    );
    window.history.replaceState({}, "", window.location.pathname);
    void refresh();
  }, []);
  const [outcomes, setOutcomes] = useState<PublishOutcome[] | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [c, m, a] = await Promise.all([api.calendar(), api.media(), api.accounts()]);
      setItems(c.items);
      setAssets(m.assets);
      setAccounts(a.accounts);
      setLivePublishing(a.livePublishing);
    } catch (e) {
      setBootError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /**
   * Reuse the previous session instead of minting a new one on every mount.
   *
   * A browser reload used to start a fresh conversation, so the history — which
   * was in the store the whole time — became unreachable, and the agent lost
   * every reference the user had built up ("this photo", "that post"). From the
   * user's side it looked like the app had forgotten the last five minutes.
   *
   * localStorage because the session id identifies a conversation, not a user,
   * and carries no privilege: it is the key to a transcript this browser just
   * created, which is exactly what should survive a refresh.
   */
  /**
   * Poll for background changes.
   *
   * The publisher sweep runs every five minutes in a Lambda the browser knows
   * nothing about, so a post can go out — or fail — with the page showing
   * yesterday's state indefinitely. Polling at the same cadence as the sweep
   * keeps the two roughly in step without being chatty: it is one small GET,
   * and the tab is usually not even open.
   */
  useEffect(() => {
    const id = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const existing = (() => {
      try {
        return localStorage.getItem("sessionId");
      } catch {
        // Private browsing and blocked site data both throw here. Losing the
        // conversation is the old behaviour, not a crash.
        return null;
      }
    })();

    if (existing) {
      setSessionId(existing);
    } else {
      api
        .createSession()
        .then((s) => {
          setSessionId(s.sessionId);
          try {
            localStorage.setItem("sessionId", s.sessionId);
          } catch {
            /* ignore — the session still works for this page view */
          }
        })
        .catch((e) => setBootError(e instanceof Error ? e.message : String(e)));
    }
    void refresh();
  }, [refresh]);

  const variants = items.flatMap((i) => i.variants);
  const counts = {
    pending: variants.filter((v) => v.status === "PENDING_APPROVAL").length,
    approved: variants.filter((v) => v.status === "APPROVED").length,
    scheduled: variants.filter((v) => v.status === "SCHEDULED").length,
    published: variants.filter((v) => v.status === "PUBLISHED").length,
  };

  // One Meta grant covers both channels, so a dead token breaks them together —
  // which is why this says "Reconnect Meta" rather than naming a platform.
  const needsReauth = accounts.some((a) => a.connectionStatus !== "ACTIVE");

  if (bootError) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="card max-w-md rounded-2xl border border-rose-200 bg-white p-6">
          <h1 className="text-sm font-semibold text-rose-700">Cannot reach the API</h1>
          <p className="mt-2 text-sm text-stone-600">{bootError}</p>
          <p className="mt-3 text-xs text-stone-500">
            Start it with <code className="rounded bg-stone-100 px-1 py-0.5">npm run api</code> in
            the project root, then reload.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col text-stone-900">
      <header className="flex shrink-0 items-center gap-4 border-b border-stone-200/80 bg-white/80 px-5 py-2.5 backdrop-blur-sm">
        <div className="flex items-center gap-2.5">
          {/* A warm mark rather than a cool one — the accent through the whole
              app is amber, which sits with the coffee photography instead of
              fighting it. */}
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-amber-700 text-sm shadow-sm">
            ☕
          </div>
          <div className="leading-tight">
            <h1 className="text-[13px] font-semibold">Social Media Planner</h1>
            <p className="text-[11px] text-stone-500">Brew &amp; Bean · Colombo</p>
          </div>
        </div>

        <div className="mx-2 hidden h-8 w-px bg-stone-200 md:block" />

        {/* The status strip. It fills the header, and it is genuinely the first
            thing you want to know on opening a planning tool. */}
        <div className="hidden items-center gap-4 md:flex">
          <Stat label="pending" value={counts.pending} tone="amber" />
          <Stat label="approved" value={counts.approved} tone="emerald" />
          <Stat label="scheduled" value={counts.scheduled} tone="sky" />
          {counts.published > 0 && (
            <Stat label="published" value={counts.published} tone="emerald" />
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          <div className="hidden items-center gap-2.5 lg:flex">
            {accounts.map((a) => (
              <span key={a.channelId} className="flex items-center gap-1.5 text-[11px]">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    a.connectionStatus === "ACTIVE" ? "bg-emerald-500" : "bg-rose-500"
                  }`}
                />
                <span className="font-medium text-stone-700">{a.handle}</span>
              </span>
            ))}
          </div>

          {/* An explicit, always-visible button.
              Making the handle strip itself clickable was not enough: with any
              account already present it rendered as plain text with no
              affordance, so there was no visible way to connect anything. A
              named button is findable whether or not something is connected. */}
          <Notifications items={items} />

          <Tooltip
            text={
              accounts.length === 0
                ? "Connect Instagram so the agent can plan and publish for you."
                : needsReauth
                  ? "A connection expired. Reconnect it, or scheduled posts will not go out."
                  : "The accounts the agent plans for. Connect or disconnect them here."
            }
          >
            <button
              onClick={() => setShowAccounts(true)}
              className={`rounded-lg px-3 py-1.5 text-[11px] font-medium shadow-sm transition ${
                accounts.length === 0 || needsReauth
                  ? "bg-violet-600 text-white hover:bg-violet-700"
                  : "border border-stone-200 bg-white text-stone-600 hover:border-stone-300 hover:text-stone-900"
              }`}
            >
              {accounts.length === 0
                ? "Connect an account"
                : needsReauth
                  ? "Reconnect"
                  : "Accounts"}
            </button>
          </Tooltip>

          {/* Runs the publish sweep immediately instead of waiting for the next
              scheduled one.
              It was called "Run publisher", which named an internal process
              rather than an outcome — a user cannot be expected to know what a
              publisher is, or that running one posts their content.
              Like Approve, it does not go through the agent: there is no
              publish tool, so no amount of prompting can reach this. */}
          <Tooltip
            text={
              livePublishing
                ? "Posts anything whose scheduled time has passed — to your real accounts, immediately."
                : "Simulates publishing. Nothing is sent to any real account while live publishing is off."
            }
          >
            <button
              onClick={async () => {
                // Ask first when this is real. The action is irreversible and
                // public: an accidental click would put content on someone's
                // actual Instagram, which no undo can take back. In mock mode
                // there is nothing to confirm, so it stays one click.
                if (livePublishing) {
                  setConfirmPublish(true);
                  return;
                }
                const { outcomes } = await api.publishDue();
                setOutcomes(outcomes);
                void refresh();
              }}
              className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-[11px] font-medium text-stone-600 shadow-sm transition hover:border-stone-300 hover:text-stone-900"
            >
              Publish due posts
            </button>
          </Tooltip>
        </div>
      </header>

      {/* Connecting an account is the single most consequential thing a user
          does here, and it finishes on a page they were redirected back to —
          so the confirmation has to be unmissable. A thin 11px strip was being
          read as chrome and skipped entirely. */}
      {connectNotice && (
        <div
          className={`flex shrink-0 items-center gap-3 border-b px-5 py-3 ${
            connectOk
              ? "border-emerald-200 bg-emerald-50"
              : "border-rose-200 bg-rose-50"
          }`}
        >
          <span
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white ${
              connectOk ? "bg-emerald-500" : "bg-rose-500"
            }`}
          >
            {connectOk ? "✓" : "!"}
          </span>
          <div className="min-w-0">
            <p
              className={`text-[13px] font-semibold ${
                connectOk ? "text-emerald-900" : "text-rose-900"
              }`}
            >
              {connectNotice}
            </p>
            <p
              className={`text-[11px] ${connectOk ? "text-emerald-700" : "text-rose-700"}`}
            >
              {connectOk
                ? "The agent can now plan and publish to this account."
                : "Nothing was changed. You can try connecting again."}
            </p>
          </div>
          <button
            onClick={() => setConnectNotice(null)}
            className={`ml-auto shrink-0 rounded-lg px-2 py-1 transition ${
              connectOk
                ? "text-emerald-600 hover:bg-emerald-100"
                : "text-rose-600 hover:bg-rose-100"
            }`}
          >
            ✕
          </button>
        </div>
      )}

      {outcomes && (
        <div className="flex shrink-0 items-center gap-3 border-b border-stone-200/80 bg-amber-50/60 px-5 py-1.5 text-[11px]">
          <span className="font-medium text-stone-700">Publishing</span>
          {outcomes.length === 0 ? (
            <span className="text-stone-500">nothing was due to post yet</span>
          ) : (
            outcomes.map((o) => (
              <span key={o.variantId} className="text-stone-500">
                {o.platform}{" "}
                <span
                  className={
                    o.status === "PUBLISHED"
                      ? "font-medium text-emerald-600"
                      : o.status === "RETRY"
                        ? "font-medium text-amber-600"
                        : "font-medium text-rose-600"
                  }
                >
                  {o.status}
                </span>
              </span>
            ))
          )}
          <button
            onClick={() => setOutcomes(null)}
            className="ml-auto text-stone-400 transition hover:text-stone-700"
          >
            dismiss
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-1 border-b border-stone-200/80 bg-white/60 px-5">
            {(["calendar", "media"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`relative px-3 py-2.5 text-[13px] font-medium capitalize transition ${
                  tab === t ? "text-stone-900" : "text-stone-500 hover:text-stone-800"
                }`}
              >
                {t}
                {t === "media" && (
                  <span className="ml-1.5 rounded bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-500">
                    {assets.length}
                  </span>
                )}
                {tab === t && (
                  <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-amber-500" />
                )}
              </button>
            ))}

            {counts.pending > 0 && (
              <span className="ml-auto text-[11px] text-amber-700">
                {counts.pending} waiting for your approval — the agent cannot approve its own work
              </span>
            )}
          </div>

          <div className="relative min-h-0 flex-1">
            <AnimatedBackdrop />
            <div className="relative h-full overflow-y-auto">
              {tab === "calendar" ? (
                <Calendar
                  items={items}
                  assets={assets}
                  onChanged={refresh}
                  onAskAgent={setAgentPrompt}
                />
              ) : (
                <MediaLibrary assets={assets} onChanged={refresh} />
              )}
            </div>
          </div>
        </main>

        <aside className="hidden w-[400px] shrink-0 border-l border-stone-200/80 lg:block">
          {sessionId ? (
            <Chat
              sessionId={sessionId}
              onChanged={refresh}
              prompt={agentPrompt}
              onPromptSent={() => setAgentPrompt(null)}
              onNewChat={() => {
                // A new conversation, not a new account: the calendar, media
                // and connections are all server-side and untouched.
                api
                  .createSession()
                  .then((s) => {
                    try {
                      localStorage.setItem("sessionId", s.sessionId);
                    } catch {
                      /* ignore */
                    }
                    setSessionId(s.sessionId);
                  })
                  .catch(() => undefined);
              }}
            />
          ) : (
            <div className="p-4 text-sm text-stone-500">Starting session…</div>
          )}
        </aside>
      </div>

      {confirmPublish && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-stone-900/20 p-4 pt-24 backdrop-blur-sm"
          onClick={() => setConfirmPublish(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-semibold text-stone-900">Publish to your real accounts?</h2>
            <p className="mt-1.5 text-[12px] leading-relaxed text-stone-600">
              Every approved post whose scheduled time has already passed will be posted now, to
              the accounts shown in the header. This cannot be undone from here — you would have to
              delete the posts in Instagram.
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={() => setConfirmPublish(false)}
                className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-[11px] font-medium text-stone-600 transition hover:border-stone-300"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  setConfirmPublish(false);
                  const { outcomes } = await api.publishDue();
                  setOutcomes(outcomes);
                  void refresh();
                }}
                className="rounded-lg bg-rose-600 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-rose-500"
              >
                Yes, publish now
              </button>
            </div>
          </div>
        </div>
      )}

      {showAccounts && (
        <Accounts
          accounts={accounts}
          onClose={() => setShowAccounts(false)}
          onChanged={() => void refresh()}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "amber" | "emerald" | "sky";
}) {
  const colour = { amber: "text-amber-600", emerald: "text-emerald-600", sky: "text-sky-600" }[
    tone
  ];

  return (
    <div className="flex items-baseline gap-1.5">
      <span
        className={`text-sm font-semibold tabular-nums ${value === 0 ? "text-stone-300" : colour}`}
      >
        {value}
      </span>
      <span className="text-[11px] text-stone-500">{label}</span>
    </div>
  );
}
