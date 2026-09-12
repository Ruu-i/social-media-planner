/**
 * Telling the agent what "now" is.
 *
 * Models cannot know the current date, and they are poor at calendar
 * arithmetic. Before this existed, the agent inferred today's date from
 * whatever dates happened to appear in tool results — which produced a
 * different answer on every run, and put one draft in the past.
 *
 * Two design constraints:
 *
 * 1. This must NOT go in the system prompt. Prompt caching is a prefix match,
 *    so a timestamp there would invalidate the cache on every single request.
 *    It is appended to the user turn instead — after the cache breakpoint.
 *
 * 2. We precompute the calendar rather than asking the model to do date maths.
 *    Looking "Monday" up in a table is reliable; counting forward from a
 *    weekday name is not.
 */

const DAY_MS = 86_400_000;

/** "2026-09-12" as it reads in the given timezone. */
function isoDate(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function weekday(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long" }).format(at);
}

function humanDate(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(at);
}

function clockTime(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}

/** "+05:30" for the given zone at the given instant (handles DST). */
export function utcOffset(at: Date, tz: string): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const offset = name?.replace("GMT", "").trim();
  return offset && offset.length > 0 ? offset : "+00:00";
}

/**
 * A compact calendar the model can read off, plus the rules for turning a
 * vague phrase into a stored instant.
 */
export function buildTimeContext(tz: string, now = new Date()): string {
  const offset = utcOffset(now, tz);

  const lines: string[] = [];
  for (let i = 0; i < 15; i++) {
    const day = new Date(now.getTime() + i * DAY_MS);
    const label = i === 0 ? "  (today)" : i === 1 ? "  (tomorrow)" : "";
    lines.push(`  ${isoDate(day, tz)}  ${weekday(day, tz).padEnd(9)}${label}`);
  }

  // "next Monday" genuinely means different things to different people. Rather
  // than silently picking one, hand the model both candidates and require it to
  // say which it used.
  const comingMonday = nextWeekday(now, tz, "Monday");
  const mondayAfter = new Date(comingMonday.getTime() + 7 * DAY_MS);

  return `<current_time>
Right now it is ${weekday(now, tz)} ${humanDate(now, tz)}, ${clockTime(now, tz)} in ${tz} (UTC${offset}).

The next two weeks:
${lines.join("\n")}

Ambiguity to watch: "next Monday" may mean the coming Monday (${isoDate(comingMonday, tz)}) or
the Monday of the following week (${isoDate(mondayAfter, tz)}). The same applies to any
"next <weekday>". When the user's phrasing is ambiguous, pick the nearer date, state
plainly which date you used, and invite them to correct you.

Times:
- The user always means ${tz} local time unless they say otherwise.
- Always talk to the user in ${tz} local time.
- Always pass scheduledFor as a full ISO 8601 string WITH the offset,
  e.g. 2026-09-14T11:00:00${offset}. A value without an offset is rejected.
- Never schedule anything in the past. Check against the current time above.
</current_time>`;
}

/** The next occurrence of a weekday, strictly after today, in the given zone. */
function nextWeekday(from: Date, tz: string, target: string): Date {
  for (let i = 1; i <= 7; i++) {
    const day = new Date(from.getTime() + i * DAY_MS);
    if (weekday(day, tz) === target) return day;
  }
  return from;
}
