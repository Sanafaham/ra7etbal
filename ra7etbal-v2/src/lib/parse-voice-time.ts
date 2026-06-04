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
 *   "tomorrow at 5 PM"          → next calendar day 17:00 local
 *   "today at 3:30 PM"          → today 15:30 local
 *   "at 6 PM"                   → today 18:00 if future, else tomorrow
 *   "6 PM"                      → same as above
 *   "5 PM tomorrow"             → next calendar day 17:00 local
 *   "in 30 minutes"             → now + 30 min
 *   "in 2 hours"                → now + 2 hours
 *   "in 1.5 hours"              → now + 90 min
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

  // ── 1. Relative: "in X minutes" / "in X hours" ───────────────────────────
  const relMatch = raw.match(
    /^in\s+(\d+(?:\.\d+)?)\s*(minute|minutes|min|hour|hours|hr|hrs)s?$/,
  );
  if (relMatch) {
    const n = parseFloat(relMatch[1]);
    const unit = relMatch[2];
    const ms = unit.startsWith("min") ? n * 60_000 : n * 3_600_000;
    const dueAt = new Date(now.getTime() + ms).toISOString();
    const parsedAs = `relative: now + ${n} ${unit}`;
    console.log(`[parse-voice-time] ${parsedAs} → ${dueAt}`);
    return { dueAt, timezone, localNow, rawText: timeText, parsedAs };
  }

  // ── 2. Absolute: extract day word + clock time ────────────────────────────
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
    const todayAt = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hours,
      minutes,
      0,
      0,
    );

    let dueDate: Date;
    if (dayWord === "tomorrow") {
      // Always next calendar day — this is the critical fix.
      dueDate = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1, // next day
        hours,
        minutes,
        0,
        0,
      );
    } else if (dayWord === "today") {
      dueDate = todayAt;
    } else {
      // No day specified: today if still in the future (>1 min), else tomorrow.
      const oneMinuteFromNow = now.getTime() + 60_000;
      dueDate =
        todayAt.getTime() > oneMinuteFromNow
          ? todayAt
          : new Date(
              now.getFullYear(),
              now.getMonth(),
              now.getDate() + 1,
              hours,
              minutes,
              0,
              0,
            );
    }

    const dueAt = dueDate.toISOString();
    const parsedAs = `absolute: day="${dayWord ?? "auto"}" time=${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
    console.log(`[parse-voice-time] ${parsedAs} → ${dueAt}`);
    return { dueAt, timezone, localNow, rawText: timeText, parsedAs };
  }

  // ── 3. Unrecognized ───────────────────────────────────────────────────────
  const error = `Could not parse time phrase: "${timeText}"`;
  console.error(`[parse-voice-time] FAILED: ${error}`);
  return { dueAt: "", timezone, localNow, rawText: timeText, parsedAs: "failed", error };
}
