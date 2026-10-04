import { useEffect, useState } from "react";

import { api, type BusinessProfile } from "../api";

/**
 * Who the agent is writing for.
 *
 * This was a hard-coded constant — every user of the app was told they ran a
 * coffee shop in Colombo, and the agent wrote cafe copy around whatever photo
 * it was given because the profile said so and the profile was never wrong,
 * only fixed.
 *
 * It is the highest-leverage screen here: every caption, every pillar, every
 * banned word and the whole tone of the output come from these ten fields.
 */

const FIELDS: {
  key: keyof BusinessProfile;
  label: string;
  hint?: string;
  long?: boolean;
}[] = [
  { key: "businessName", label: "Business name" },
  { key: "industry", label: "Industry", hint: "e.g. Coffee shop, Yoga studio, Freelance design" },
  { key: "description", label: "What you do", long: true },
  { key: "targetAudience", label: "Who you are talking to", long: true },
  { key: "location", label: "Location" },
  { key: "timezone", label: "Timezone", hint: "IANA name, e.g. Asia/Colombo. Posts are scheduled in this zone." },
  { key: "tone", label: "Tone of voice", long: true, hint: "The agent writes in this voice." },
  { key: "marketingGoal", label: "What you want from this", long: true },
];

export function Profile({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  const [pillars, setPillars] = useState("");
  const [banned, setBanned] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .profile()
      .then((d) => {
        setProfile(d.profile);
        // One per line: these are phrases, and commas appear inside them.
        setPillars(d.profile.contentPillars.join("\n"));
        setBanned(d.profile.bannedWords.join(", "));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const save = async () => {
    if (!profile) return;
    setSaving(true);
    setError(null);
    try {
      await api.updateProfile({
        ...profile,
        contentPillars: pillars.split("\n").map((p) => p.trim()).filter(Boolean),
        bannedWords: banned.split(",").map((w) => w.trim()).filter(Boolean),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-stone-900/20 p-4 pt-12 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-stone-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-stone-100 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-stone-900">Your business</h2>
            <p className="mt-0.5 text-[11px] text-stone-600">
              Everything the agent writes comes from this. Change it and the next plan changes.
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

        {!profile ? (
          <p className="px-5 py-10 text-center text-[12px] text-stone-500">Loading…</p>
        ) : (
          <>
            <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-5 py-4">
              {FIELDS.map((f) => (
                <label key={f.key} className="block">
                  <span className="text-[11px] font-medium text-stone-700">{f.label}</span>
                  {f.hint && <span className="ml-1.5 text-[10px] text-stone-400">{f.hint}</span>}
                  {f.long ? (
                    <textarea
                      value={String(profile[f.key] ?? "")}
                      onChange={(e) => setProfile({ ...profile, [f.key]: e.target.value })}
                      rows={2}
                      className="mt-1 w-full resize-y rounded-lg border border-stone-300 px-2.5 py-1.5 text-[12px] text-stone-800 outline-none focus:border-violet-400"
                    />
                  ) : (
                    <input
                      value={String(profile[f.key] ?? "")}
                      onChange={(e) => setProfile({ ...profile, [f.key]: e.target.value })}
                      className="mt-1 w-full rounded-lg border border-stone-300 px-2.5 py-1.5 text-[12px] text-stone-800 outline-none focus:border-violet-400"
                    />
                  )}
                </label>
              ))}

              <label className="block">
                <span className="text-[11px] font-medium text-stone-700">Posts per week</span>
                <input
                  type="number"
                  min={1}
                  value={profile.postsPerWeek}
                  onChange={(e) =>
                    setProfile({ ...profile, postsPerWeek: Number(e.target.value) || 1 })
                  }
                  className="mt-1 w-24 rounded-lg border border-stone-300 px-2.5 py-1.5 text-[12px] text-stone-800 outline-none focus:border-violet-400"
                />
              </label>

              <label className="block">
                <span className="text-[11px] font-medium text-stone-700">Content pillars</span>
                <span className="ml-1.5 text-[10px] text-stone-400">
                  one per line - the themes it plans around
                </span>
                <textarea
                  value={pillars}
                  onChange={(e) => setPillars(e.target.value)}
                  rows={4}
                  className="mt-1 w-full resize-y rounded-lg border border-stone-300 px-2.5 py-1.5 text-[12px] text-stone-800 outline-none focus:border-violet-400"
                />
              </label>

              <label className="block">
                <span className="text-[11px] font-medium text-stone-700">Words to avoid</span>
                <span className="ml-1.5 text-[10px] text-stone-400">
                  comma separated - it will not use these
                </span>
                <input
                  value={banned}
                  onChange={(e) => setBanned(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-stone-300 px-2.5 py-1.5 text-[12px] text-stone-800 outline-none focus:border-violet-400"
                />
              </label>
            </div>

            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-stone-100 px-5 py-3">
              <span className="mr-auto text-[11px] text-stone-500">
                Existing posts are not rewritten - this changes what comes next.
              </span>
              <button
                onClick={onClose}
                className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-[11px] font-medium text-stone-600 transition hover:border-stone-300"
              >
                Cancel
              </button>
              <button
                disabled={saving}
                onClick={() => void save()}
                className="rounded-lg bg-violet-600 px-3.5 py-1.5 text-[11px] font-semibold text-white transition hover:bg-violet-500 disabled:opacity-40"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
