/**
 * CARSON PROTECTED BEHAVIORS — the single shared classifier distinguishing
 * simple staff communication from tracked delegated work. See "CARSON
 * PROTECTED BEHAVIORS" in AGENTS.md and the carson-protected-behaviors test
 * suite (a mandatory CI gate — see .github/workflows).
 *
 * Used at the one place both channels' delegation-creation paths converge:
 * sendDelegation() in ElevenLabsAgentWidget.tsx — the shared handler behind
 * BOTH Talk to Carson's send_delegation clientTool and Type to Carson's
 * delegation fast path (executeDelegationFastPath's injected
 * sendDelegationFn) — so both channels are protected by one guard,
 * regardless of how each one decided to attempt a delegation.
 * direct-message-fast-path.ts's own parsing logic (COMMAND_PREFIX,
 * DELEGATION_BODY_START, isUnsafeBody) is unrelated and unchanged by this
 * module.
 *
 * ARCHITECTURE (2026-08-16 rewrite) — the classification axis is:
 *
 *   Does Carson need to track an outcome after the message is delivered?
 *
 *   COMMUNICATION: Carson's responsibility ends once the message reaches
 *   the recipient — a location/positional instruction, a personal request
 *   of the owner, or plain information, with nothing to verify afterward.
 *
 *   DELEGATION: Carson must keep the item open, expect a confirmation, and
 *   follow up if the recipient doesn't respond — the recipient owes a
 *   verifiable outcome, not just receipt of a message.
 *
 * This is a genuinely semantic distinction, not a syntactic one — it does
 * NOT hold for any single deterministic signal: not imperative mood, not
 * "[command] + [person] + 'to' + [verb]", not whether the owner is named
 * as the target, not any fixed verb list, not any specific phrase. Prior
 * versions of this module used exactly that kind of regex (a fixed
 * "owner-target verb" list: call/contact/text/wait-for-me/let-me-know) and
 * it silently missed every case where the same axis applied to a
 * *third party* with no owner-target marker at all — e.g. "Christopher,
 * come to the kitchen now." (a location instruction to Christopher, not
 * about the owner) was misclassified as delegation because no verb in the
 * old fixed list matched. A larger verb list only defers the same failure
 * to the next unlisted verb — see RA7ETBAL_STATE.md for the confirmed
 * production incident this rewrite fixes.
 *
 * The fix delegates the actual judgment to a small, focused model call
 * (claude-haiku-4-5, via the existing authenticated /api/anthropic proxy —
 * see src/lib/anthropic-client.ts, src/lib/ai/compose-message.ts for the
 * established pattern) rather than growing the regex indefinitely. The
 * classifier is injectable (`classifyFn`) so callers/tests can supply a
 * deterministic implementation without hitting the network — every
 * existing and new protected phrase in carson-protected-behaviors.test.ts
 * is tested this way; classifyStaffInstructionViaModel's own prompt
 * construction, response parsing, and fail-safe default are tested
 * separately in communication-vs-delegation.model.test.ts, against a
 * mocked Anthropic response, not the real model.
 *
 * FAIL-SAFE DEFAULT: on any network error, non-OK response, or
 * unparseable/ambiguous model output, this defaults to "delegation" (task
 * tracked), never "communication". Silently dropping a real delegation
 * (task never created, never followed up) is the worse failure mode than
 * over-tracking a plain message (visible in Waiting, correctable) — the
 * same fail-closed reasoning used throughout this project's security work.
 */
import { callAnthropicProxy } from "./anthropic-client";

export type StaffInstructionClassification = "communication" | "delegation";

const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 10;

function buildClassificationPrompt(taskText: string): string {
  return `A household owner gave this instruction to be relayed to a staff member:

"${taskText}"

Decide whether, once this message is delivered to the staff member, the owner needs an assistant (Carson) to keep tracking the matter and follow up if the staff member doesn't respond or confirm — or whether Carson's job is done the moment the message is delivered.

COMMUNICATION: the staff member only needs to receive this — come somewhere, wait somewhere, meet someone, receive information, or respond personally. There is nothing for the staff member to complete or produce that needs verifying afterward.

DELEGATION: the staff member is being asked to complete, produce, or verify something. The owner needs to know whether it actually got done, and Carson should follow up if it doesn't.

Respond with exactly one word: COMMUNICATION or DELEGATION.`;
}

/**
 * The real, production classifier. Calls the authenticated Anthropic proxy.
 * Never throws — every failure path (network error, non-OK response,
 * malformed/ambiguous model output) resolves to "delegation" (see the
 * module-level fail-safe note above).
 */
export async function classifyStaffInstructionViaModel(
  taskText: string,
): Promise<StaffInstructionClassification> {
  const text = taskText.trim();
  if (!text) return "delegation";

  try {
    const res = await callAnthropicProxy({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: buildClassificationPrompt(text) }],
    });
    if (!res.ok) return "delegation";

    const body = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      error?: unknown;
    };
    if (body.error) return "delegation";

    const raw = body.content?.[0]?.text?.trim().toUpperCase();
    return raw === "COMMUNICATION" ? "communication" : "delegation";
  } catch {
    return "delegation";
  }
}

/**
 * The shared entry point both channels call. Accepts an injectable
 * classifier function (defaults to the real model-backed one) so tests can
 * supply a deterministic mapping without hitting the network — see
 * carson-protected-behaviors.test.ts's `fakeClassify` fixture, which covers
 * every confirmed protected phrase plus the new grammatical forms this
 * rewrite adds coverage for.
 */
export async function isCommunicationStyleTaskText(
  taskText: string,
  classifyFn: (text: string) => Promise<StaffInstructionClassification> = classifyStaffInstructionViaModel,
): Promise<boolean> {
  const classification = await classifyFn(taskText);
  return classification === "communication";
}
