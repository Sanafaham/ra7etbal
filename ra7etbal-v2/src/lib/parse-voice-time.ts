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
 *   "in 30 minutes" / "in a minute"   → now + N min
 *   "in 2 hours"    / "in an hour"    → now + N hours
 *   "in 3 days"                        → now + N days (same time)
 *   "in 2 weeks"                       → now + N×7 days
 *   "tonight"                          → today 21:00
 *   "later today"                      → now + 3 hours
 *   "before bed"                       → today 22:00
 *   "tomorrow morning"                 → tomorrow 09:00
 *   "tomorrow afternoon"               → tomorrow 14:00
 *   "tomorrow evening"                 → tomorrow 19:00
 *   "tomorrow at 5 PM"                 → next calendar day 17:00 local
 *   "today at 3:30 PM"                 → today 15:30 local
 *   "at 6 PM" / "6 PM"                 → today 18:00 if future, else tomorrow
 *   "next week"                        → +7 days
 *   "next month"                       → +30 days
 *   "next Friday"                      → next occurrence of that weekday at 09:00
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

  // ── 1. Relative: "in X / a / an  minutes|hours|days|weeks" ──────────────
  // Accepts numeric ("in 5"), word-number "a"/"an" (treated as 1).
  const relMatch = raw.match(
    /^in\s+(a\b|an\b|\d+(?:\.\d+)?)\s*(minute|minutes|min|hour|hours|hr|hrs|day|days|week|weeks)\b/,
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
    } else {
      // weeks
      dueAt = addDays(now, n * 7).toISOString();
      parsedAs = `relative: now + ${n} week(s)`;
    }

    console.log(`[parse-voice-time] ${parsedAs} → ${dueAt}`);
    return { dueAt, timezone, localNow, rawText: timeText, parsedAs };
  }

  // ── 2. Named periods: tonight / later today / before bed ────────────────
  if (/\btonight\b/.test(raw)) {
    const dueAt = localDate(now.getFullYear(), now.getMonth(), now.getDate(), 21, 0).toISOString();
    const parsedAs = "named: tonight → today 21:00";
    console.log(`[parse-voice-time] ${parsedAs} → ${dueAt}`);
    return { dueAt, timezone, localNow, rawText: timeText, parsedAs };
  }

  if (/\blater today\b/.test(raw)) {
    const dueAt = new Date(now.getTime() + 3 * 3_600_000).toISOString();
    const parsedAs = "named: later today → now + 3 hours";
    console.log(`[parse-voice-time] ${parsedAs} → ${dueAt}`);
    return { dueAt, timezone, localNow, rawText: timeText, parsedAs };
  }

  if (/\bbefore bed\b/.test(raw)) {
    const dueAt = localDate(now.getFullYear(), now.getMonth(), now.getDate(), 22, 0).toISOString();
    const parsedAs = "named: before bed → today 22:00";
    console.log(`[parse-voice-time] ${parsedAs} → ${dueAt}`);
    return { dueAt, timezone, localNow, rawText: timeText, parsedAs };
  }

  // ── 3. "tomorrow morning/afternoon/evening" ──────────────────────────────
  if (/\btomorrow\s+morning\b/.test(raw)) {
    const dueAt = addDays(now, 1, 9, 0).toISOString();
    const parsedAs = "named: tomorrow morning → tomorrow 09:00";
    console.log(`[parse-voice-time] ${parsedAs} → ${dueAt}`);
    return { dueAt, timezone, localNow, rawText: timeText, parsedAs };
  }
  if (/\btomorrow\s+afternoon\b/.test(raw)) {
    const dueAt = addDays(now, 1, 14, 0).toISOString();
    const parsedAs = "named: tomorrow afternoon → tomorrow 14:00";
    console.log(`[parse-voice-time] ${parsedAs} → ${dueAt}`);
    return { dueAt, timezone, localNow, rawText: timeText, parsedAs };
  }
  if (/\btomorrow\s+evening\b/.test(raw)) {
    const dueAt = addDays(now, 1, 19, 0).toISOString();
    const parsedAs = "named: tomorrow evening → tomorrow 19:00";
    console.log(`[parse-voice-time] ${parsedAs} → ${dueAt}`);
    return { dueAt, timezone, localNow, rawText: timeText, parsedAs };
  }

  // ── 4. "next week" / "next month" ────────────────────────────────────────
  if (/\bnext\s+week\b/.test(raw)) {
    const dueAt = addDays(now, 7).toISOString();
    const parsedAs = "named: next week → now + 7 days";
    console.log(`[parse-voice-time] ${parsedAs} → ${dueAt}`);
    return { dueAt, timezone, localNow, rawText: timeText, parsedAs };
  }
  if (/\bnext\s+month\b/.test(raw)) {
    const dueAt = addDays(now, 30).toISOString();
    const parsedAs = "named: next month → now + 30 days";
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
  const nextDayMatch = raw.match(/\bnext\s+(sunday|sun|monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat)\b/);
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

  // ── 6. Absolute: extract day word + clock time ────────────────────────────
  // Day word: "tomorrow" or "today" anywhere in the phrase.
  const dayWordMatch = raw.match(/\b(tomorrow|today)\b/);
  const dayWord = dayWordMatch?.[1] ?? null;

  // Clock time: H or H:MM with mandatory AM/PM  →  "5 pm", "5:30 pm"
  //         or  H or H:MM without AM/PM          →  "17:00", "9" (ambiguous)
  const timeWithAmPm = raw.match(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/);
  const timeWithout = raw.match(/\b([01]?\d|2[0-3])(?::([0-5]\d))?\b/);
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
