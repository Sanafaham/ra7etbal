/**
 * carson-summarize.ts
 *
 * Extracts memorable facts from a voice-session transcript using the
 * existing /api/anthropic proxy (Haiku — cheapest available model).
 *
 * Called once at session end, before saving to carson_memory.
 * Non-blocking: caller catches all errors and falls back to V2 behaviour.
 *
 * Cost: ~$0.0004 per session (1,500 tokens in + 100 out at Haiku rates).
 */

export interface TranscriptMessage {
  role: "user" | "agent";
  message: string;
}

// Sentinel returned when the model finds nothing worth keeping.
const NOTHING = "NOTHING_MEMORABLE";

// Minimum user turns before we bother calling the LLM.
// 2 turns required — a single user utterance rarely produces durable memory
// worth saving and risks polluting the [Most recent session] label with a
// thin housekeeping row.
const MIN_USER_TURNS = 2;

/**
 * Returns true when a summary is worth persisting to carson_memory.
 *
 * A summary passes if it has:
 *  - 2 or more bullet lines, OR
 *  - at least 1 bullet that is a Correction or explicit user preference/instruction
 *    (these are always durable even from short sessions)
 *
 * This prevents thin technical or housekeeping summaries from becoming
 * the [Most recent session] row and displacing meaningful memory.
 */
export function isSummaryWorthSaving(summary: string): boolean {
  const bullets = summary
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("•"));

  if (bullets.length >= 2) return true;

  // Single bullet is acceptable only when it captures durable user training.
  const durableSingleBullet = bullets.some((b) => {
    const lower = b.toLowerCase();
    return (
      lower.includes("correction:") ||
      lower.includes("preference:") ||
      lower.includes("habit:") ||
      lower.includes("routine:") ||
      lower.includes("always") ||
      lower.includes("never") ||
      lower.includes("from now on") ||
      lower.includes("pronounced") ||
      lower.includes("spelled")
    );
  });

  return durableSingleBullet;
}

/** Prefix that marks a carson_memory row as a session recap (not durable fact). */
export const SESSION_RECAP_PREFIX = "• Session recap:";

/**
 * Produce a single-sentence topical recap of a session — saved on EVERY voice
 * disconnect (with enough turns) regardless of whether anything durable was
 * found. This is what lets Carson answer "what did we talk about last session?"
 * even when the durable-memory gate correctly saves nothing.
 *
 * Does NOT touch the durable gate. Returns one short sentence (no prefix), or
 * null when the session was too short. Falls back to the first user utterance
 * if the LLM call fails, so a real session always yields a recap.
 */
export async function summarizeSessionRecap(
  transcript: TranscriptMessage[],
): Promise<string | null> {
  // Recap saves with >= 1 user turn — the whole point is that Carson knows the
  // ACTUAL last session even when it was trivial. Durable memory keeps its own
  // higher MIN_USER_TURNS floor; this is intentionally lower.
  const userTurns = transcript.filter((m) => m.role === "user");
  if (userTurns.length < 1) return null;

  // Heuristic fallback: first user utterance, trimmed to a short topic line.
  const fallback = (() => {
    const first = userTurns[0]?.message?.trim();
    if (!first) return null;
    const oneLine = first.replace(/\s+/g, " ");
    return oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine;
  })();

  const transcriptText = transcript
    .map((m) => `${m.role === "user" ? "User" : "Carson"}: ${m.message}`)
    .join("\n");

  const prompt = `Summarize what this conversation was about in ONE short sentence.
Topic only — what the user and Carson discussed or did. Max 18 words.
No preamble, no "the user", no quotes. Just the sentence.

Transcript:
${transcriptText}`;

  let res: Response;
  try {
    res = await fetch("/api/anthropic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 60,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    return fallback;
  }
  if (!res.ok) return fallback;

  let body: { content?: Array<{ type?: string; text?: string }> };
  try {
    body = await res.json();
  } catch {
    return fallback;
  }

  const text = body?.content?.[0]?.text?.trim();
  return text && text !== NOTHING ? text.replace(/\s+/g, " ") : fallback;
}

/**
 * Summarise a conversation transcript into 3–7 short memory bullets.
 *
 * Returns a non-empty string on success, or null when:
 * - the session was too short to bother
 * - the model found nothing memorable
 * - the API call failed
 */
export async function summarizeConversation(
  transcript: TranscriptMessage[],
): Promise<string | null> {
  const userTurns = transcript.filter((m) => m.role === "user");
  if (userTurns.length < MIN_USER_TURNS) return null;

  const transcriptText = transcript
    .map((m) => `${m.role === "user" ? "User" : "Carson"}: ${m.message}`)
    .join("\n");

  const prompt = `You are a memory assistant for a voice AI called Carson.

Below is a transcript of a conversation between the user and Carson.
Extract only durable memory Carson should remember about this user in future sessions.

Before saving any fact, ask: "Is this likely to still be true in 30 days?"
If yes, save it. If no, do not save it as long-term memory.

You must separate three categories:
1. Durable facts — stable identity, preferences, routines, relationships, product direction, corrections. SAVE these.
2. Temporary operational context — today's plans, event times, household logistics. DO NOT SAVE these.
3. Completed or one-time tasks — delegations, reminders, WhatsApp sends, confirmations. DO NOT SAVE these.

━━ ALWAYS CAPTURE DURABLE MEMORY ━━
• Anything the user explicitly says to remember, unless it is obviously a one-time task.
• Preferences, habits, and routines ("I usually…", "I always…", "I prefer…", "I don't like…", "I keep…", "next time…").
• Work style, schedule patterns, recurring situations.
• Stable household context: who lives there, relationships, recurring responsibilities.
• Stable people facts: names, roles, relationships, reliability patterns, recurring ownership.
• Product direction, durable decisions, and the reasoning behind them.
• Corrections — ALL of the following types must be captured:
    - Spelling corrections: e.g. "it's Ra7etBal, not Rahet Bal"
    - Pronunciation corrections: e.g. "it's pronounced rah-het, not ray-het"
    - Name corrections: e.g. "her name is Loulya, not Lula"
    - Preference corrections: e.g. "I said short, not brief"
    - Workflow corrections: e.g. "next time ask me before sending"
    - Any time the user says "that's wrong", "I meant…", "actually it's…", "you got that wrong", "not X, Y"
• Product feedback or feature requests.
• Ideas the user floats, especially casual ones at night or in passing, if they may matter later.

━━ NEVER CAPTURE AS LONG-TERM MEMORY ━━
• Greetings, goodbyes, thank-yous.
• Generic tool confirmations ("reminder set", "message sent", "delegated to X").
• One-time event logistics: guests arriving, dinner time, cars to wash, flowers to replace, kitchen checks.
• One-time family/household check-ins: "tell me when X gets home", "ask X to confirm".
• Temporary open loops from today's brief unless the user says they are recurring or durable.
• Completed or pending tasks, reminders, WhatsApp messages, confirmations, follow-ups, or escalations.
• Do not infer identity or preference from one event.
  Bad: "Sana likes hosting dinners" from one dinner plan.
  Bad: "Guests arrive at 7 and dinner is at 9" as a user fact.
• Small talk with no lasting personal value.
• One-off jokes, unless the user is correcting Carson or explicitly asking to remember it.
• Speculation or emotional interpretations — factual only.

━━ EXAMPLES ━━
User says: "Guests arrive at 7 PM. Dinner is at 9 PM."
Return: ${NOTHING}

User says: "I usually host dinner every Friday and Christopher handles the kitchen."
Return: "• Routine: User usually hosts dinner every Friday and Christopher handles kitchen work."

User says: "I prefer compact answers and I hate over-explaining."
Return: "• Preference: User prefers compact answers and dislikes over-explaining."

━━ FORMAT ━━
- Start each bullet with "• ".
- Add a category label when it helps: Preference: / Habit: / Routine: / Person: / Correction: / Product feedback: / Idea:
- Each bullet is one sentence. Max 22 words.
- 1–7 bullets total. No more.
- Do NOT number the bullets.
- If there is truly nothing durable worth keeping, return exactly: ${NOTHING}

Transcript:
${transcriptText}`;

  let res: Response;
  try {
    res = await fetch("/api/anthropic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    return null; // network failure — non-fatal
  }

  if (!res.ok) return null;

  let body: { content?: Array<{ type?: string; text?: string }> };
  try {
    body = await res.json();
  } catch {
    return null;
  }

  const text = body?.content?.[0]?.text?.trim();
  if (!text || text === NOTHING) return null;

  return filterDurableMemoryText(text);
}

function filterDurableMemoryText(text: string): string | null {
  const durableLines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== NOTHING)
    .filter((line) => !isLikelyTemporaryOperationalMemory(line));

  return durableLines.length > 0 ? durableLines.join("\n") : null;
}

function isLikelyTemporaryOperationalMemory(line: string): boolean {
  const lower = line.toLowerCase();

  const hasDurableSignal =
    /\b(prefers?|dislikes?|likes?|usually|always|routine|habit|recurring|every\s+(day|week|month|friday|saturday|sunday|monday|tuesday|wednesday|thursday)|lives?|building|wants?|correction|pronounced|spelled|chief of staff|product direction)\b/.test(
      lower,
    );
  if (hasDurableSignal) return false;

  const hasTemporarySignal =
    /\b(today|tonight|tomorrow|yesterday|guests? arrive|dinner is|dinner at|arrive at|at \d{1,2}(:\d{2})?\s*(am|pm)|flowers?|cars?|kitchen|washing|replacing|check-in|gets? home|got home|delegated|sent|reminder|confirm|confirmation|follow-up|follow up|whatsapp|task)\b/.test(
      lower,
    );

  return hasTemporarySignal;
}
