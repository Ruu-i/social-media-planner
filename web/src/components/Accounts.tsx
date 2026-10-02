import { useEffect, useState } from "react";

import { api, type Account, type Connection, type ProviderStatus } from "../api";

/**
 * Connected accounts.
 *
 * The first thing a new user has to do and, until now, the one thing the UI
 * offered no way to do at all — the header showed connections but there was no
 * path to creating one.
 *
 * Deliberately a panel rather than a buried settings page: on an empty account
 * this is the only useful action on the screen, so it should be one click from
 * the header rather than three.
 */

const PROVIDER_LABEL: Record<string, string> = {
  instagram: "Instagram",
  facebook: "Facebook Page",
};

export function Accounts({
  accounts,
  onClose,
  onChanged,
}: {
  accounts: Account[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await api.connections();
      setConnections(data.connections);
      setProviders(data.providers);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const connect = async (provider: string) => {
    setBusy(provider);
    setError(null);
    try {
      const { url } = await api.connectStart(provider);
      // A full navigation, not a fetch: the consent screen is the provider's
      // page and the user has to actually see it.
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const disconnect = async (connection: Connection) => {
    setBusy(connection.id);
    setError(null);
    try {
      await api.disconnect(connection.id);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-stone-900/20 p-4 pt-20 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-stone-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-stone-100 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-stone-900">Connected accounts</h2>
            <p className="mt-0.5 text-[11px] text-stone-500">
              The agent plans for these. Nothing publishes without your approval.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-stone-400 transition hover:bg-stone-50 hover:text-stone-600"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="mx-5 mt-4 rounded-lg bg-rose-50 px-3 py-2 text-[11px] text-rose-700 ring-1 ring-rose-200 ring-inset">
            {error}
          </div>
        )}

        <div className="space-y-2 p-5">
          {/* Every provider the server offers, PLUS any provider that already
              has a connection. Without the second half, a connection whose
              provider is no longer registered renders nowhere — present in the
              data, invisible in the UI, and impossible to disconnect. */}
          {[
            ...providers,
            ...connections
              .filter((c) => !providers.some((p) => p.provider === c.provider))
              .map((c) => ({ provider: c.provider, configured: false, reason: undefined })),
          ].map((p) => {
            const connection = connections.find((c) => c.provider === p.provider);
            const channels = accounts.filter((a) => a.platform === p.provider);

            return (
              <div
                key={p.provider}
                className="flex items-center gap-3 rounded-xl border border-stone-200 bg-stone-50/60 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-stone-800">
                      {PROVIDER_LABEL[p.provider] ?? p.provider}
                    </span>
                    {connection && (
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          connection.status === "ACTIVE" ? "bg-emerald-500" : "bg-rose-500"
                        }`}
                      />
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-stone-500">
                    {connection
                      ? connection.status === "ACTIVE"
                        ? channels.map((c) => c.handle).join(", ") || "Connected"
                        : "Session expired — reconnect to keep publishing"
                      : p.configured
                        ? "Not connected"
                        : (p.reason ?? "Not available yet")}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {/* A healthy connection is a FINISHED state, so the loud
                      action disappears and "Connected" is just reported. An
                      always-primary "Reconnect" reads as an unfinished task and
                      invites a user to redo something that already worked.
                      Switching accounts is still possible — quietly, below. */}
                  {connection && connection.status === "ACTIVE" ? (
                    <>
                      <span className="text-[11px] font-medium text-emerald-700">Connected</span>
                      <button
                        disabled={busy === connection.id}
                        onClick={() => void disconnect(connection)}
                        className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-[11px] font-medium text-stone-500 transition hover:border-rose-200 hover:text-rose-600 disabled:opacity-50"
                      >
                        {busy === connection.id ? "…" : "Disconnect"}
                      </button>
                    </>
                  ) : (
                    <button
                      disabled={!p.configured || busy === p.provider}
                      onClick={() => void connect(p.provider)}
                      className="rounded-lg bg-violet-600 px-3 py-1.5 text-[11px] font-medium text-white shadow-sm transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400"
                    >
                      {busy === p.provider
                        ? "…"
                        : connection
                          ? "Reconnect"
                          : "Connect"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {connections.some((c) => c.status === "ACTIVE") && (
            <p className="pt-1 text-[11px] text-stone-400">
              To use a different account, disconnect first, then connect again.
            </p>
          )}

          {/* Stated rather than hidden: a Facebook button that cannot work is
              worse than an honest explanation of why it is not there. */}
          <p className="pt-2 text-[11px] leading-relaxed text-stone-400">
            Instagram needs a Business or Creator account — personal accounts cannot be published
            to through any API. Facebook posting needs a Page you administer, and is coming next.
          </p>
        </div>
      </div>
    </div>
  );
}
