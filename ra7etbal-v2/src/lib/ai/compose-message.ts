/**
 * Natural message composer
 *
 * When a delegation has a personal/emotional/status note, a simple
 * append ("Hi Grace, could you call Sana? She misses you.") reads like
 * two disconnected sentences. This module uses Claude Haiku to merge
 * the task and note into one fluent message.
 *
 * Only called when personalNote is non-empty. Falls back to null so the
 * caller can fall through to the existing injectPersonalNote path.
 *
 * The personalNote passed here should already be normalised by
 * normalizePersonalNote() so it reads in third-person ("Sana is on her
 * way." not "I'm on the way.").
 */

const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 150;

export async function composeMergedMessage({
  personName,
  taskText,
  personalNote,
  ownerName,
}: {
  personName: string;
  taskText: string;
  personalNote: string;
  ownerName?: string | null;
}): Promise<string | null> {
  const note = personalNote.trim();
  if (!note) return null;

  const owner = ownerName?.trim() || "the sender";

  // Strip trailing punctuation from task for cleaner embedding
  const task = taskText.trim().replace(/[.!?]+$/, "").trim();

  const prompt = `You are a thoughtful chief of staff writing a WhatsApp message from ${owner} to ${personName}. Sound warm and human — not like a task manager.

ACTION: ${task}
NOTE: ${note}

Write ONE natural message starting with "Hi ${personName},".

Rules by note type — apply the FIRST matching rule:
- Emotional/relational (misses you, loves you, thinking of you, appreciates you): lead with the emotional sentiment in a warm sentence (e.g. "Sana misses you and would love to hear from you"), then make the request conversationally (e.g. "Could you give her a call when you have a moment?")
- Status (owner is on the way, coming, heading there, arriving): make the request briefly, then mention the status in one short sentence (e.g. "She's on her way")
- Urgency (urgent, ASAP, right away, immediately, quickly, as soon as possible): embed the urgency naturally inside the request (e.g. "as soon as possible", "right away"), then optionally add a brief appreciation line (e.g. "Sana would appreciate it")

Style rules:
- Use second person (you, your) for ${personName}
- Use third person (${owner}, she/he/they) for ${owner}
- Keep it concise — 2 sentences max
- No "Confirm when done", no confirmation link, no closing instruction
- Output ONLY the message text, nothing else`;

  try {
    const res = await fetch("/api/anthropic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) return null;

    const body = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      error?: unknown;
    };
    if (body.error) return null;

    const text = body.content?.[0]?.text?.trim();
    if (!text || text.length < 10) return null;

    // Sanity guard: must start with "Hi " otherwise the model wandered
    if (!text.startsWith("Hi ")) return null;

    return text;
  } catch {
    return null;
  }
}
