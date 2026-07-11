/**
 * parseVoiceTime
 *
 * Converts a natural-language time phrase (from the ElevenLabs voice agent)
 * into an ISO 8601 timestamp using the browser's local clock and timezone.
 *
 * Never trusts the agent to do time arithmetic — the agent passes the raw
 * phrase and this function resolves it correctly.
 *
 * Supported patterns:
 *   Relative (spoken numbers supported — "five" = 5):
 *   "in 5 minutes" / "in five minutes" / "5 minutes" / "a minute"  → now + N min
 *   "half an hour" / "in half an hour"                              → now + 30 min
 *   "in 2 hours"   / "in two hours"    / "an hour"                 → now + N hours
 *   "in 3 days"    / "in three days"   / "a day"                   → now + N days
 *   "in 2 weeks"   / "in two weeks"    / "a week"                  → now + N×7 days
 *   "in 2 months"  / "in two months"   / "a month"                 → now + N×30 days
 *   "in 2 years"   / "in two years"    / "a year"                  → now + N×365 days
 *
 *   Named:
 *   "tonight"           → today 21:00
 *   "later today"       → now + 3 hours
 *   "before bed"        → today 22:00
 *   "tomorrow"          → tomorrow 09:00
 *   "tomorrow morning"  → tomorrow 09:00
 *   "tomorrow afternoon"→ tomorrow 14:00
 *   "tomorrow evening"  → tomorrow 19:00
 *   "next week"         → +7 days
 *   "next month"        → +30 days
 *   "next year"         → +365 days
 *   "next Friday"       → next occurrence of that weekday at 09:00
 *
 *   Absolute:
 *   "tomorrow at 5 PM"  → next calendar day 17:00 local
 *   "today at 3:30 PM"  → today 15:30 local
 *   "at 6 PM" / "6 PM"  → today 18:00 if future, else tomorrow
 */

export interface VoiceTimeResult {
  /** ISO 8601 timestamp, or empty string on failure. */
  dueAt: string;
  /** Browser timezone, e.g. "Asia/Riyadh". */
  timezone: string;
  /** Human-readable local now for logging. */
  localNow: string;
  /** The raw phrase passed in. */
  rawText: string;
  /** How the phrase was interpreted. */
  parsedAs: string;
  /** Non-null when parsing failed. */
  error?: string;
}

export function parseVoiceTime(
  timeText: string,
  now = new Date(),
): VoiceTimeResult {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localNow = now.toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

  console.log(
    `[parse-voice-time] raw="${timeText}" | timezone="${timezone}" | localNow="${localNow}"`,
  );

  const raw = (timeText ?? "").trim().toLowerCase();

  // ── Reject "N <unit> before" phrases ─────────────────────────────────────
  // "one day before", "three days before" etc. are relative to an implicit
  // deadline, not a standalone time. Parsing them as "now + N days" is wrong.
  // Return an error so the agent can ask for clarification rather than silently
  // creating a reminder for the wrong date.
  if (/\bbefore\b/.test(raw) && !/\bbefore\s+(noon|midnight|bed|morning|evening|afternoon)\b/.test(raw)) {
    const error = `Phrase "${timeText}" contains "before" — cannot resolve without a reference date.`;
    console.error(`[parse-voice-time] REJECTED: ${error}`);
    return { dueAt: "", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, localNow: now.toLocaleString(), rawText: timeText, parsedAs: "rejected", error };
  }

  // ── Spoken-number normalisation ──────────────────────────────────────────
  // ElevenLabs STT transcribes spoken digits as words ("five" not "5").
  // Replace word-numbers with digits before any pattern matching so that
  // "in five minutes" is treated identically to "in 5 minutes".
  const WORD_NUMBERS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
    // compound forms: "twenty five" / "twenty-five"
    "twenty one": 21, "twenty-one": 21,
    "twenty two": 22, "twenty-two": 22,
    "twenty three": 23, "twenty-three": 23,
    "twenty four": 24, "twenty-four": 24,
    "twenty five": 25, "twenty-five": 25,
    "twenty six": 26, "twenty-six": 26,
    "twenty seven": 27, "twenty-seven": 27,
    "twenty eight": 28, "twenty-eight": 28,
    "twenty nine": 29, "twenty-nine": 29,
    "thirty five": 35, "thirty-five": 35,
    "forty five": 45, "forty-five": 45,
    "fifty five": 55, "fifty-five": 55,
  };
  // Replace longest matches first (compound before single words).
  let normalised = raw.replace(
    /\btwenty[\s-](?:one|two|three|four|five|six|seven|eight|nine)\b|\bthirty[\s-]five\b|\bforty[\s-]five\b|\bfifty[\s-]five\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty)\b/g,
    (m) => String(WORD_NUMBERS[m] ?? m),
  );

  // Normalise "half [an] hour" variants → "30 minutes" so relMatch picks them up.
  // Covers: "half an hour", "half hour", "a half hour", "in half an hour", etc.
  normalised = normalised.replace(/\b(?:a\s+)?half(?:\s+an?)?\s+hour\b/g, "30 minutes");

  if (normalised !== raw) {
    console.log(`[parse-voice-time] normalised: "${raw}" → "${normalised}"`);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  function localDate(
    year: number,
    month: number,
    day: number,
    hours = 0,
    minutes = 0,
  ): Date {
    return new Date(year, month, day, hours, minutes, 0, 0);
  }

  function addDays(base: Date, n: number, h = base.getHours(), m = base.getMinutes()): Date {
    return localDate(base.getFullYear(), base.getMonth(), base.getDate() + n, h, m);
  }

  // ── 1. Relative: "[in] X / a / an  minutes|hours|days|weeks|months|years" ─
  // "in" is optional so "one minute", "a minute", "5 minutes" all work.
  // `normalised` has already converted word-numbers → digits and half-hour → 30 minutes.
  const relMatch = normalised.match(
    /^(?:in\s+)?(a\b|an\b|\d+(?:\.\d+)?)\s*(minute|minutes|min|hour|hours|hr|hrs|day|days|week|weeks|month|months|year|years)\b/,
  );
  if (relMatch) {
    const raw_n = relMatch[1];
    const n = raw_n === "a" || raw_n === "an" ? 1 : parseFloat(raw_n);
    const unit = relMatch[2];
    let dueAt: string;
    let parsedAs: string;

    if (unit.startsWith("min")) {
      dueAt = new Date(now.getTime() + n * 60_000).toISOString();
      parsedAs = `relative: now + ${n} minute(s)`;
    } else if (unit.startsWith("hour") || unit.startsWith("hr")) {
      dueAt = new Date(now.getTime() + n * 3_600_000).toISOString();
      parsedAs = `relative: now + ${n} hour(s)`;
    } else if (unit.startsWith("day")) {
      dueAt = addDays(now, n).toISOString();
      parsedAs = `relative: now + ${n} day(s)`;
    } else if (unit.startsWith("week")) {
      dueAt = addDays(now, n * 7).toISOString();
      parsedAs = `relative: now + ${n} week(s)`;
    } else if (unit.startsWith("month")) {
      dueAt = addDays(now, n * 30).toISOString();
      parsedAs = `relative: now + ${n} month(s)`;
    } else {
      // years
      dueAt = addDays(now, n * 365).toISOString();
      parsedAs = `relative: now + ${n} year(s)`;
    }

    console.log(`[parse-voice-time] ${parsedAs} → ${dueAt}`);
    return { dueAt, timezone, localNow, rawText: timeText, parsedAs };
  }

  // ── 2. Named periods: tonight / later today / before bed ────────────────
  if (/\btonight\b/.test(normalised)) {
    const dueAt = localDate(now.getFullYear(), now.getMonth(), now.getDate(), 21, 0).toISOString();
    const parsedAs = "named: tonight → today 21:00";
    console.log(`[parse-voice-time] ${parsedAs} → ${dueAt}`);
    return { dueAt, timezone, localNow, rawText: timeText, parsedAs };
  }

  if (/\blater today\b/.test(normalised)) {
    const dueAt = new Date(now.getTime() + 3 * 3_600_000).toISOString();
    const parsedAs = "named: later today → now + 3 hours";
    console.log(`[parse-voice-time] ${parsedAs} → ${dueAt}`);
    return { dueAt, timezone, localNow, rawText: timeText, parsedAs };
  }

  if (/\bbefore bed\b/.test(normalised)) {
    const dueAt = localDate(now.getFullYear(), now.getMonth(), now.getDate(), 22, 0).toISOString();
    const parsedAs = "named: before bed → today 22:00";
    console.log(`[parse-voice-time] ${parsedAs} → ${dueAt}`);
    return { dueAt, timezone, localNow, rawText: timeText, parsedAs };
  }

  // ── 3. "tomorrow morning/afternoon/evening" ──────────────────────────────
  if (/\btomorrow\s+morning\b/.test(normalised)) {
    const dueAt = addDays(now, 1, 9, 0).toISOString();
    const parsedAs = "named: tomorrow morning → tomorrow 09:00";
    console.log(`[parse-voice-time] ${parsedAs} → ${dueAt}`);
    return { dueAt, timezone, localNow, rawText: timeText, parsedAs };
  }
  if (/\btomorrow\s+afternoon\b/.test(normalised)) {
    const dueAt = addDays(now, 1, 14, 0).toISOString();
    const parsedAs = "named: tomorrow afternoon → tomorrow 14:00";
    console.log(`[parse-voice-time] ${parsedAs} → ${dueAt}`);
    return { dueAt, timezone, localNow, rawText: timeText, parsedAs };
  }
  if (/\btomorrow\s+evening\b/.test(normalised)) {
    const dueAt = addDays(now, 1, 19, 0).toISOString();
    const parsedAs = "named: tomorrow evening → tomorrow 19:00";
    console.log(`[parse-voice-time] ${parsedAs} → ${dueAt}`);
    return { dueAt, timezone, localNow, rawText: timeText, parsedAs };
  }

  // ── 4. "next week" / "next month" ────────────────────────────────────────
  if (/\bnext\s+week\b/.test(normalised)) {
    const dueAt = addDays(now, 7).toISOString();
    const parsedAs = "named: next week → now + 7 days";
    console.log(`[parse-voice-time] ${parsedAs} → ${dueAt}`);
    return { dueAt, timezone, localNow, rawText: timeText, parsedAs };
  }
  if (/\bnext\s+month\b/.test(normalised)) {
    const dueAt = addDays(now, 30).toISOString();
    const parsedAs = "named: next month → now + 30 days";
    console.log(`[parse-voice-time] ${parsedAs} → ${dueAt}`);
    return { dueAt, timezone, localNow, rawText: timeText, parsedAs };
  }
  if (/\bnext\s+year\b/.test(normalised)) {
    const dueAt = addDays(now, 365).toISOString();
    const parsedAs = "named: next year → now + 365 days";
    console.log(`[parse-voice-time] ${parsedAs} → ${dueAt}`);
    return { dueAt, timezone, localNow, rawText: timeText, parsedAs };
  }

  // ── 5. "next <weekday>" ──────────────────────────────────────────────────
  const WEEKDAYS: Record<string, number> = {
    sunday: 0, sun: 0,
    monday: 1, mon: 1,
    tuesday: 2, tue: 2,
    wednesday: 3, wed: 3,
    thursday: 4, thu: 4,
    friday: 5, fri: 5,
    saturday: 6, sat: 6,
  };
  const nextDayMatch = normalised.match(/\bnext\s+(sunday|sun|monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat)\b/);
  if (nextDayMatch) {
    const targetDay = WEEKDAYS[nextDayMatch[1]];
    const todayDay = now.getDay();
    // Always go to the NEXT occurrence (at least 1 day ahead, up to 7).
    const daysUntil = ((targetDay - todayDay + 7) % 7) || 7;
    const dueAt = addDays(now, daysUntil, 9, 0).toISOString();
    const parsedAs = `named: next ${nextDayMatch[1]} → +${daysUntil} days at 09:00`;
    console.log(`[parse-voice-time] ${parsedAs} → ${dueAt}`);
    return { dueAt, timezone, localNow, rawText: timeText, parsedAs };
  }

  // ── 5b. Standalone "tomorrow" (no clock time) → tomorrow at 09:00 ─────────
  if (/^\s*tomorrow\s*$/.test(normalised)) {
    const dueAt = addDays(now, 1, 9, 0).toISOString();
    const parsedAs = "named: tomorrow → tomorrow 09:00";
    console.log(`[parse-voice-time] ${parsedAs} → ${dueAt}`);
    return { dueAt, timezone, localNow, rawText: timeText, parsedAs };
  }

  // ── 6. Absolute: extract day word + clock time ────────────────────────────
  // Day word: "tomorrow" or "today" anywhere in the phrase.
  const dayWordMatch = normalised.match(/\b(tomorrow|today)\b/);
  const dayWord = dayWordMatch?.[1] ?? null;

  // Clock time: H or H:MM with mandatory AM/PM  →  "5 pm", "5:30 pm"
  //         or  H or H:MM without AM/PM          →  "17:00", "9" (ambiguous)
  const timeWithAmPm = normalised.match(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/);
  const timeWithout = normalised.match(/\b([01]?\d|2[0-3])(?::([0-5]\d))?\b/);
  const timeMatch = timeWithAmPm ?? timeWithout;

  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2] ?? "0", 10);
    const ampm = timeMatch[3] as "am" | "pm" | undefined;

    // AM/PM adjustment
    if (ampm === "pm" && hours !== 12) hours += 12;
    if (ampm === "am" && hours === 12) hours = 0;

    // Heuristic: no AM/PM and hour 1–7 almost always means PM for a reminder
    // ("remind me at 5" = 5 PM, not 5 AM).
    if (!ampm && hours >= 1 && hours <= 7) hours += 12;

    // Build candidate on today in local timezone.
    // Using new Date(y, m, d, H, M) gives local midnight + offset automatically.
    const todayAt = localDate(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);

    let dueDate: Date;
    if (dayWord === "tomorrow") {
      // Always next calendar day — this is the critical fix.
      dueDate = localDate(now.getFullYear(), now.getMonth(), now.getDate() + 1, hours, minutes);
    } else if (dayWord === "today") {
      dueDate = todayAt;
    } else {
      // No day specified: today if still in the future (>1 min), else tomorrow.
      const oneMinuteFromNow = now.getTime() + 60_000;
      dueDate =
        todayAt.getTime() > oneMinuteFromNow
          ? todayAt
          : localDate(now.getFullYear(), now.getMonth(), now.getDate() + 1, hours, minutes);
    }

    const dueAt = dueDate.toISOString();
    const parsedAs = `absolute: day="${dayWord ?? "auto"}" time=${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
    console.log(`[parse-voice-time] ${parsedAs} → ${dueAt}`);
    return { dueAt, timezone, localNow, rawText: timeText, parsedAs };
  }

  // ── 7. Unrecognized ───────────────────────────────────────────────────────
  const error = `Could not parse time phrase: "${timeText}"`;
  console.error(`[parse-voice-time] FAILED: ${error}`);
  return { dueAt: "", timezone, localNow, rawText: timeText, parsedAs: "failed", error };
}

/**
 * resolveRecurringAutomationFirstRun
 *
 * Confirmed production failure: a daily automation requested ~2 minutes
 * ahead ("charge your phone" at 1:36 AM, created at 1:34 AM) was scheduled
 * for the following day instead of firing that morning, because the
 * first_run_text passed to create_automation contained the literal word
 * "tomorrow" (the tool caller's own argument, not necessarily what the
 * user asked for). parseVoiceTime's "absolute, day=tomorrow" branch always
 * honors that literally — correct, intentional behavior for a one-time
 * task (see its own "critical fix" comment above), left unchanged here.
 *
 * For a recurring loop specifically, "first run" means "the next time this
 * cadence's time of day happens" — silently skipping a whole day when that
 * time is still safely ahead today is never correct. This prefers today's
 * occurrence in exactly that one case.
 *
 * Scoped narrowly via parsedAs (parseVoiceTime's only machine-readable
 * signal of which branch fired) to the literal "day=tomorrow" branch —
 * never touches "next Friday", "next week", "in N days", or any other
 * genuinely multi-day-ahead result, which must keep landing on their real
 * target day. Never moves a run earlier than "now" either (would make the
 * automation runner treat it as immediately overdue). Uses local
 * calendar-day construction (year/month/day + the resolved hour/minute),
 * not a fixed 24-hour subtraction, so the result stays correct across a
 * DST transition.
 */
export function resolveRecurringAutomationFirstRun(
  parsed: Pick<VoiceTimeResult, "dueAt" | "parsedAs">,
  cadenceType: string,
  now: Date = new Date(),
): string {
  if (cadenceType === "once" || !parsed.parsedAs.includes('day="tomorrow"')) {
    return parsed.dueAt;
  }

  const tomorrowDate = new Date(parsed.dueAt);
  const todayAtSameLocalTime = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    tomorrowDate.getHours(),
    tomorrowDate.getMinutes(),
    0,
    0,
  );

  if (todayAtSameLocalTime.getTime() > now.getTime() + 60_000) {
    return todayAtSameLocalTime.toISOString();
  }
  return parsed.dueAt;
}
