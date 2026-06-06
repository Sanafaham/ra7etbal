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
Extract 3-5 bullet points of facts, preferences, context, or open items
that Carson should remember about this user in future sessions.

Rules:
- Be specific and factual. No speculation.
- Omit greetings, goodbyes, and tool confirmations (e.g. "reminder set").
- Omit generic small talk with no personal dimension.
- Focus on: names, preferences, corrections, household context, work context,
  recurring concerns, decisions made, open loops, things user wants Carson to know.
- Each bullet is one short sentence. Max 20 words per bullet.
- Do NOT number the bullets. Start each with "• ".
- If there is truly nothing memorable, return exactly: ${NOTHING}

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
