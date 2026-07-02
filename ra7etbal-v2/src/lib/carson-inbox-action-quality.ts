/**
 * carson-inbox-action-quality.ts
 *
 * Pure quality guard used by act_on_inbox_item (Carson Inbox Review):
 * an inbox item phrased as an instruction for someone to DO something
 * ("Confirm the menu.", "Call Grace.") should go through the delegation
 * path (task + confirmation link + follow-up coverage) rather than being
 * silently sent as a bare direct message, which has none of that.
 */

const TASK_INSTRUCTION_VERBS = new Set([
  "confirm", "check", "call", "buy", "pick", "bring", "prepare", "finish",
  "complete", "get", "handle", "arrange", "book", "schedule", "cancel",
  "order", "pay", "renew", "submit", "register", "drop", "collect",
  "deliver", "notify", "verify", "compare", "review", "organize", "sort",
  "fix", "repair", "return", "clean", "cook", "follow", "remind", "ask",
  "set", "sign", "print", "update", "install", "reschedule",
]);

/**
 * True when the text reads as an imperative instruction (starts with a
 * common task verb, optionally after "please"). Deliberately simple and
 * conservative — greeting/FYI-style text ("Happy birthday Sarah!") never
 * matches, so the "message" action stays usable for genuine messages.
 */
export function looksLikeTaskInstruction(text: string): boolean {
  const trimmed = text.trim().toLowerCase().replace(/^please\s+/, "");
  const firstWord = trimmed.split(/\s+/)[0]?.replace(/[^a-z]/g, "") ?? "";
  return TASK_INSTRUCTION_VERBS.has(firstWord);
}
