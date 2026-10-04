import type { ReactNode } from "react";

/**
 * The front door.
 *
 * Its job is to answer one question before anything else: is this a chat box
 * with a social-media theme, or software that actually does something? Almost
 * every "AI app" is the former, so the claim is made with specifics — tool
 * counts, an enforced rule, a real published post — rather than adjectives.
 *
 * Icons are inline SVG rather than an icon package: six glyphs do not justify a
 * dependency, and these inherit currentColor so they tint with their card.
 */

/* ---------------------------------------------------------------- icons -- */

const icon = (d: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-5 w-5"
  >
    {d}
  </svg>
);

const IconLink = icon(
  <>
    <path d="M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L10.7 5.2" />
    <path d="M14 11a5 5 0 0 0-7.07 0L4.8 13.12a5 5 0 0 0 7.07 7.07L13.3 18.8" />
  </>,
);
const IconSpark = icon(
  <>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
    <path d="M12 8.5 13.6 11l2.4 1-2.4 1-1.6 2.5L10.4 13 8 12l2.4-1Z" />
  </>,
);
const IconImage = icon(
  <>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <circle cx="8.5" cy="9.5" r="1.5" />
    <path d="m4 17 4.5-4.5a2 2 0 0 1 2.8 0L20 20" />
  </>,
);
const IconCheck = icon(
  <>
    <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" />
    <path d="m8.5 12 2.5 2.5 4.5-5" />
  </>,
);
const IconClock = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </>,
);
const IconSend = icon(<path d="M20 4 3 10.5l6.5 2.5L12 20l8-16Z" />);
const IconShield = icon(
  <>
    <path d="M12 3 5 6v6c0 4 3 7.5 7 9 4-1.5 7-5 7-9V6l-7-3Z" />
    <path d="m9 12 2 2 4-4" />
  </>,
);
const IconLayers = icon(
  <>
    <path d="m12 3 9 5-9 5-9-5 9-5Z" />
    <path d="m3 13 9 5 9-5" />
  </>,
);

const IconInstagram = (
  <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6">
    <rect x="3" y="3" width="18" height="18" rx="5.5" stroke="currentColor" strokeWidth="1.8" />
    <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8" />
    <circle cx="17.2" cy="6.8" r="1.2" fill="currentColor" />
  </svg>
);

const IconFacebook = (
  <svg viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6">
    <path d="M22 12a10 10 0 1 0-11.56 9.88v-6.99H7.9V12h2.54V9.8c0-2.5 1.49-3.89 3.77-3.89 1.1 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56V12h2.78l-.44 2.89h-2.34v6.99A10 10 0 0 0 22 12Z" />
  </svg>
);

const PLATFORMS = [
  {
    icon: IconInstagram,
    name: "Instagram",
    formats: "Posts · Carousels · Reels · Stories",
    status: "Live",
    live: true,
    tint: "from-fuchsia-500 to-amber-400",
  },
  {
    icon: IconFacebook,
    name: "Facebook Pages",
    formats: "Posts · Carousels · Reels",
    status: "Coming next",
    live: false,
    tint: "from-sky-500 to-blue-600",
  },
];

/* ------------------------------------------------------------- content -- */

const STEPS = [
  { icon: IconLink, title: "Connect", body: "One Instagram grant. It stores a pointer to the credential, never the credential." },
  { icon: IconSpark, title: "Ask for a week", body: "It plans the slots first - which day, which format, which theme - then writes every caption." },
  { icon: IconImage, title: "It uses your photos", body: "Each upload is described once. It knows a square shot cannot be a Reel, and plans around what fits." },
  { icon: IconCheck, title: "You approve", body: "Nothing moves without this. Edit first if you like - changing the words withdraws the approval.", gate: true },
  { icon: IconClock, title: "Scheduled", body: "Committed to a time, in your timezone, with the media attached and checked." },
  { icon: IconSend, title: "Published", body: "It posts while you are doing something else, then tells you - with the link." },
];

const CAPABILITIES = [
  {
    icon: IconLayers,
    title: "One idea, written for each platform",
    body: "Instagram carries hashtags and no clickable links. Facebook reads a wall of hashtags as spam. The same thought is rewritten for each, never pasted into both.",
  },
  {
    icon: IconImage,
    title: "It plans around real photos",
    body: "Not described placeholders - your actual library, searched by what is in each shot, filtered by what each format allows.",
  },
  {
    icon: IconClock,
    title: "It knows what day it is",
    body: "“Next Monday” is resolved against your timezone, with the ambiguity surfaced rather than guessed at.",
  },
  {
    icon: IconShield,
    title: "Failures come back classified",
    body: "A rate limit retries. A dead token asks you to reconnect. A rejected caption stops. The difference is in code, not in a log nobody reads.",
  },
];

const PROOF = [
  { figure: "19", label: "tools the agent can call" },
  { figure: "146", label: "assertions, two databases" },
  { figure: "0", label: "tools that can publish" },
];

/* ---------------------------------------------------------------- page -- */

export function Landing() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[radial-gradient(ellipse_at_top,_#ede9fe_0%,_#faf5ff_35%,_#ffffff_70%)] text-stone-800">
      {/* Corner auras.
          Large, heavily blurred colour fields pinned to the corners — the trick
          the reference uses to make a white page feel designed without putting
          anything in the way of the words. They sit behind everything and take
          no clicks, so they are decoration in the literal sense.
          overflow-hidden on the parent matters: a blob extending past the
          viewport would otherwise add a horizontal scrollbar. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-40 -left-40 h-[32rem] w-[32rem] rounded-full bg-violet-400/30 blur-[120px]" />
        <div className="absolute -top-32 right-[-10rem] h-[28rem] w-[28rem] rounded-full bg-fuchsia-300/30 blur-[120px]" />
        <div className="absolute top-[42%] -left-56 h-[30rem] w-[30rem] rounded-full bg-indigo-300/25 blur-[130px]" />
        <div className="absolute right-[-12rem] bottom-[18%] h-[34rem] w-[34rem] rounded-full bg-violet-400/25 blur-[130px]" />
        <div className="absolute bottom-[-12rem] left-[20%] h-[26rem] w-[26rem] rounded-full bg-amber-200/30 blur-[120px]" />
      </div>

      <div className="relative mx-auto max-w-6xl px-6 pb-20">
        <nav className="flex items-center gap-3 py-6">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-[14px] font-bold text-white shadow-sm shadow-violet-300">
            F
          </span>
          <span className="text-[15px] font-bold tracking-tight text-stone-900">FollowFav</span>

          <a
            href="/app"
            className="ml-auto rounded-full bg-gradient-to-r from-violet-600 to-fuchsia-500 px-5 py-2.5 text-[13px] font-semibold text-white shadow-lg shadow-violet-300/50 transition hover:brightness-110"
          >
            Get started
          </a>
        </nav>

        {/* ---------------------------------------------------------- hero */}
        <section className="grid items-center gap-12 pt-10 lg:grid-cols-[1.05fr_1fr] lg:pt-16">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full bg-white/70 px-3.5 py-1.5 text-[11px] font-semibold tracking-wide text-violet-700 ring-1 ring-violet-200 ring-inset">
              <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
              AI AGENT · INSTAGRAM & FACEBOOK
            </span>

            <h1 className="mt-6 text-[2.75rem] leading-[1.05] font-extrabold tracking-tight text-stone-900 sm:text-6xl">
              It plans your week.
              <br />
              <span className="bg-gradient-to-r from-violet-600 via-fuchsia-500 to-violet-500 bg-clip-text text-transparent">
                Not just your captions.
              </span>
            </h1>

            <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-stone-600 sm:text-base">
              Most "AI tools" are a chat box wired to a text box. This one reads your calendar,
              looks through your photos, writes each post for the platform it is going to,
              schedules what you approve - and publishes it on its own.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <a
                href="/app"
                className="rounded-full bg-gradient-to-r from-violet-600 to-fuchsia-500 px-7 py-3.5 text-[14px] font-semibold text-white shadow-lg shadow-violet-300/50 transition hover:brightness-110"
              >
                Get started
              </a>
              <a
                href="#how"
                className="rounded-full bg-white/80 px-6 py-3.5 text-[14px] font-semibold text-stone-600 ring-1 ring-stone-200 ring-inset transition hover:text-stone-900"
              >
                See how it works
              </a>
            </div>

            <div className="mt-10 flex flex-wrap gap-x-8 gap-y-3">
              {PROOF.map((p) => (
                <div key={p.label}>
                  <p className="bg-gradient-to-r from-violet-600 to-fuchsia-500 bg-clip-text text-2xl font-extrabold text-transparent">
                    {p.figure}
                  </p>
                  <p className="text-[11px] text-stone-500">{p.label}</p>
                </div>
              ))}
            </div>
          </div>

          {/* A sketch of the product rather than a screenshot: it stays true
              when the UI changes, and loads instantly. */}
          <div className="relative">
            <div className="rounded-[28px] bg-gradient-to-br from-violet-500 via-violet-500 to-fuchsia-500 p-5 shadow-2xl shadow-violet-300/50">
              <div className="rounded-[20px] bg-white/95 p-5">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  <span className="text-[11px] font-semibold text-stone-700">@yourhandle</span>
                  <span className="ml-auto rounded-md bg-violet-100 px-2 py-0.5 text-[9px] font-bold tracking-wide text-violet-700">
                    MON 9:00 AM
                  </span>
                </div>

                <div className="mt-4 flex gap-3">
                  <div className="h-14 w-14 shrink-0 rounded-xl bg-gradient-to-br from-amber-200 to-violet-200" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] leading-snug font-medium text-stone-800">
                      Saturdays are for going nowhere slowly.
                    </p>
                    <p className="mt-1 text-[10px] text-sky-600">#slowweekend #colombo</p>
                  </div>
                </div>

                <div className="mt-4 flex items-center gap-2 border-t border-stone-100 pt-3">
                  <span className="rounded-md bg-amber-100 px-2 py-0.5 text-[9px] font-bold text-amber-700">
                    PENDING APPROVAL
                  </span>
                  <span className="ml-auto rounded-lg bg-emerald-500 px-2.5 py-1 text-[10px] font-bold text-white">
                    Approve
                  </span>
                </div>
              </div>

              <div className="mt-4 flex items-center gap-2 px-1 text-[11px] font-medium text-white/90">
                {IconShield}
                <span>Nothing posts until you approve it</span>
              </div>
            </div>

            <div className="absolute -bottom-5 -left-5 hidden rounded-2xl bg-white px-4 py-3 shadow-xl ring-1 ring-stone-200/70 sm:block">
              <p className="text-[10px] text-stone-500">Published automatically</p>
              <p className="text-[13px] font-bold text-stone-900">01:25 PM · on time</p>
            </div>
          </div>
        </section>

        {/* ----------------------------------------------------- platforms */}
        <section className="mt-24">
          <div className="text-center">
            <span className="text-[11px] font-bold tracking-widest text-violet-600 uppercase">
              Works with
            </span>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-stone-900 sm:text-4xl">
              Written for each platform, not pasted into both
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-[14px] leading-relaxed text-stone-600">
              One idea becomes a different post on each. Instagram carries hashtags and no
              clickable links; Facebook tolerates links and treats a wall of hashtags as spam.
            </p>
          </div>

          <div className="mx-auto mt-10 grid max-w-3xl gap-4 sm:grid-cols-2">
            {PLATFORMS.map((p) => (
              <div
                key={p.name}
                className="flex items-center gap-4 rounded-2xl bg-white/70 p-5 ring-1 ring-white/60 ring-inset backdrop-blur-sm"
              >
                <span
                  className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br text-white ${p.tint}`}
                >
                  {p.icon}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-[15px] font-bold text-stone-900">{p.name}</h3>
                    {/* Said plainly. A landing page that claims Facebook works
                        is a landing page someone will try Facebook on. */}
                    <span
                      className={`rounded-full px-2 py-0.5 text-[9px] font-bold tracking-wide ${
                        p.live
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-stone-100 text-stone-500"
                      }`}
                    >
                      {p.status.toUpperCase()}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11.5px] text-stone-500">{p.formats}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------------ workflow */}
        <section id="how" className="mt-28 scroll-mt-8">
          <div className="text-center">
            <span className="text-[11px] font-bold tracking-widest text-violet-600 uppercase">
              How it works
            </span>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-stone-900 sm:text-4xl">
              Six steps, one of them yours
            </h2>
          </div>

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {STEPS.map((s, i) => (
              <div
                key={s.title}
                className={`relative rounded-2xl p-6 transition ${
                  s.gate
                    ? "bg-gradient-to-br from-violet-600 to-fuchsia-500 text-white shadow-xl shadow-violet-300/50"
                    : "bg-white/80 ring-1 ring-stone-200/80 ring-inset hover:ring-violet-200"
                }`}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`flex h-10 w-10 items-center justify-center rounded-xl ${
                      s.gate ? "bg-white/20 text-white" : "bg-violet-100 text-violet-600"
                    }`}
                  >
                    {s.icon}
                  </span>
                  <span
                    className={`text-[11px] font-bold ${s.gate ? "text-white/70" : "text-stone-400"}`}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                </div>

                <h3
                  className={`mt-4 text-[15px] font-bold ${s.gate ? "text-white" : "text-stone-900"}`}
                >
                  {s.title}
                </h3>
                <p
                  className={`mt-1.5 text-[12.5px] leading-relaxed ${
                    s.gate ? "text-white/85" : "text-stone-600"
                  }`}
                >
                  {s.body}
                </p>

                {s.gate && (
                  <span className="mt-3 inline-block rounded-full bg-white/20 px-2.5 py-1 text-[10px] font-bold tracking-wide">
                    THE ONLY HUMAN STEP
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* -------------------------------------------------- the real claim */}
        <section className="mt-24 overflow-hidden rounded-[28px] bg-gradient-to-br from-violet-600 via-violet-600 to-fuchsia-500 p-10 text-white shadow-2xl shadow-violet-300/50 sm:p-14">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/20">
            {IconShield}
          </span>
          <h2 className="mt-6 max-w-2xl text-3xl font-extrabold tracking-tight sm:text-4xl">
            It cannot post without you
          </h2>
          <p className="mt-5 max-w-2xl text-[15px] leading-relaxed text-white/90">
            Not as a setting, and not as a line in a prompt that a long conversation could wear
            down. The agent has no tool that approves content and no tool that publishes it -
            those live outside everything it can reach.
          </p>
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed font-medium text-white">
            Asking it to post anyway is not refused. It is impossible.
          </p>
        </section>

        {/* ---------------------------------------------------- capabilities */}
        <section className="mt-24">
          <div className="text-center">
            <span className="text-[11px] font-bold tracking-widest text-violet-600 uppercase">
              Under the hood
            </span>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-stone-900 sm:text-4xl">
              The parts a chat box does not have
            </h2>
          </div>

          <div className="mt-12 grid gap-4 sm:grid-cols-2">
            {CAPABILITIES.map((c) => (
              <div
                key={c.title}
                className="rounded-2xl bg-white/70 p-7 ring-1 ring-white/60 ring-inset backdrop-blur-sm transition hover:ring-violet-200"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-violet-100 to-fuchsia-100 text-violet-600">
                  {c.icon}
                </span>
                <h3 className="mt-4 text-[15px] font-bold text-stone-900">{c.title}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-stone-600">{c.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------------------- cta */}
        <section className="mt-24 rounded-[28px] bg-white/70 p-10 text-center ring-1 ring-white/60 ring-inset backdrop-blur-sm sm:p-14">
          <h2 className="text-3xl font-extrabold tracking-tight text-stone-900 sm:text-4xl">
            Have a look around
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-[14px] leading-relaxed text-stone-600">
            The calendar, the photo library and the approvals all work without spending anything.
          </p>
          <a
            href="/app"
            className="mt-8 inline-block rounded-full bg-gradient-to-r from-violet-600 to-fuchsia-500 px-8 py-4 text-[15px] font-semibold text-white shadow-lg shadow-violet-300/50 transition hover:brightness-110"
          >
            Get started
          </a>
        </section>

      </div>
    </div>
  );
}
