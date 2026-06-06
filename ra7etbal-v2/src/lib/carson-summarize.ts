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
// Set to 1 so even a single-exchange session (quick delegation / reminder)
// is eligible for summarisation.
const MIN_USER_TURNS = 1;

/**
 * Summarise a conversation transcript into 3-5 short memory bullets.
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
  console.log(
    `[carson-summarize] start — total turns=${transcript.length} user turns=${userTurns.length} MIN_USER_TURNS=${MIN_USER_TURNS}`,
  );

  if (userTurns.length < MIN_USER_TURNS) {
    console.log(
      `[carson-summarize] skipped — not enough user turns (${userTurns.length} < ${MIN_USER_TURNS})`,
    );
    return null;
  }

  const transcriptText = transcript
    .map((m) => `${m.role === "user" ? "User" : "Carson"}: ${m.message}`)
    .join("\n");

  const prompt = `You are a memory assistant for a voice AI called Carson.

Below is a transcript of a conversation between the user and Carson.
Extract 3–7 bullet points that Carson should remember about this user in future sessions.

━━ ALWAYS CAPTURE ━━
• Anything the user explicitly says to remember ("remember that…", "don't forget…").
• Preferences, habits, and routines ("I usually…", "I always…", "I prefer…", "I don't like…", "I keep…").
• Work style, schedule patterns, recurring situations.
• Household context: who lives there, relationships, responsibilities.
• People: names, roles, what was delegated or discussed with them.
• Decisions made and the reasoning behind them.
• Open loops: things started but not finished, waiting on someone.
• Corrections the user makes to Carson ("that's wrong", "I meant…", "next time say…").
• Product feedback or feature requests the user mentions.
• Ideas the user floats, especially casual ones at night or in passing.

━━ NEVER CAPTURE ━━
• Greetings, goodbyes, thank-yous.
• Generic tool confirmations ("reminder set", "message sent").
• Small talk with no lasting personal value.
• One-off jokes, unless the user is correcting Carson or asking him to remember it.
• Speculation or emotional interpretations — factual only.

━━ FORMAT ━━
- Start each bullet with "• ".
- Add a category label when it helps: Preference: / Habit: / Person: / Open loop: / Correction: / Product feedback: / Idea:
- Each bullet is one sentence. Max 22 words.
- 3–7 bullets total. No more.
- Do NOT number the bullets.
- If there is truly nothing worth keeping, return exactly: ${NOTHING}

Transcript:
${transcriptText}`;

  console.log("[carson-summarize] calling /api/anthropic …");

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
  } catch (err) {
    console.error("[carson-summarize] /api/anthropic network error:", err);
    return null; // network failure — non-fatal
  }

  console.log(`[carson-summarize] /api/anthropic response status=${res.status} ok=${res.ok}`);

  if (!res.ok) {
    // Log the error body so we can see exactly what the API rejected.
    try {
      const errBody = await res.text();
      console.error(`[carson-summarize] /api/anthropic non-OK body: ${errBody}`);
    } catch {
      console.error("[carson-summarize] /api/anthropic non-OK, could not read body");
    }
    return null;
  }

  let body: { content?: Array<{ type?: string; text?: string }> };
  try {
    body = await res.json();
  } catch (err) {
    console.error("[carson-summarize] failed to parse /api/anthropic JSON:", err);
    return null;
  }

  const text = body?.content?.[0]?.text?.trim();
  console.log(
    `[carson-summarize] LLM result: text="${text?.slice(0, 80) ?? "(empty)"}" isNothing=${text === NOTHING}`,
  );

  if (!text || text === NOTHING) return null;

  return text;
}
