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
 *
 * C-02 (2026-09-05/07 reconciliation) — INPUT CHANGE, not an axis change.
 * Confirmed Production regression: "Ask Christopher to bring the car around
 * at 6." fed to this classifier as the isolated task fragment ("bring the
 * car around at 6.") was misclassified COMMUNICATION. Live-model evidence
 * (real claude-haiku-4-5, not simulated, recorded in RA7ETBAL_STATE.md)
 * showed this was a CONSISTENT failure (3/3), not a rare flake — and that
 * merely feeding the full utterance with the same question changed nothing
 * (also 3/3 wrong). What fixed it, verified across 42 real model calls with
 * zero failures: keeping the exact same axis above, but (a) always passing
 * the full original owner utterance instead of the isolated fragment, and
 * (b) naming the one dimension the model was actually missing — that a
 * direct instruction to the recipient counts as delegation even when the
 * action is simple (e.g. placing a phone call), while a request relayed
 * through the recipient on a third party's behalf does not. Callers now
 * pass the full utterance (see sendDelegation's `internal.rawInstruction`
 * in ElevenLabsAgentWidget.tsx) instead of the bare task fragment.
 */
import { callAnthropicProxy } from "./anthropic-client";

/**
 * C-02 gap closure (2026-09-07): the deterministic E-axis exclusion — is the
 * named recipient actually the direct grammatical actor, or is this a
 * reported/relayed third-party desire ("Tell Loulya I would like her to
 * call me.") — previously existed ONLY inside parseDelegationFastPath, on
 * the raw instruction text, upstream of sendDelegation. That structural
 * check never ran at all for the legacy send_delegation clientTool, since
 * the model calls sendDelegation(params) directly with its own already-
 * extracted name/task, bypassing parseDelegationFastPath entirely. Gate 1
 * evidence: for that exact construction, the semantic classifier ALONE was
 * only ~77% reliable (23% failure, always toward wrongly saying
 * DELEGATION) — not safe to rely on as the sole authority. This pattern is
 * verb-agnostic (it doesn't care what the reported action is, only that it
 * is reported rather than instructed) and requires no reference to fast
 * path grammar — it can be tested directly on whatever text is available
 * to sendDelegation, closing the gap for every caller including the legacy
 * one, without a new architecture and without touching the classifier
 * prompt.
 */
// CodeRabbit finding, PR #402: "I'd like" (either apostrophe style — ASCII
// ' or curly ’, both real in typed/transcribed text) is at least as common
// as the fully spelled "I would like" and must resolve identically.
const REPORTED_THIRD_PARTY_DESIRE =
  /\bi\s*(?:would\s+like|['’]d\s+like|want|wish|need)\s+(?:him|her|them)\s+to\s+\S/i;

/**
 * True when the text reports a third party's desire/preference through the
 * recipient ("I would like her to call me") rather than instructing the
 * recipient themselves to do something. Deterministic, no network call —
 * checked before the model-backed classifier below, and short-circuits it
 * when true (see isCommunicationStyleTaskText).
 */
export function isReportedThirdPartyDesire(text: string): boolean {
  return REPORTED_THIRD_PARTY_DESIRE.test(text.trim());
}

export type StaffInstructionClassification = "communication" | "delegation";

export const STAFF_INSTRUCTION_MODEL = "claude-haiku-4-5";
// Room for the one-word classification plus a verbatim recipient span.
export const STAFF_INSTRUCTION_MAX_TOKENS = 120;
/** The interpretation call fails closed if the proxy has not answered by then. */
export const STAFF_INSTRUCTION_TIMEOUT_MS = 8000;

export function buildClassificationPrompt(utterance: string, recipientName?: string | null): string {
  const who = recipientName?.trim() || "the person being addressed";
  return `A household owner said this:

"${utterance}"

Decide whether, once this is delivered to whoever it's about, the owner needs an assistant (Carson) to keep tracking the matter and follow up if that person doesn't respond or confirm — or whether Carson's job is done the moment it's delivered.

COMMUNICATION: the person only needs to receive this — come somewhere, wait somewhere, meet someone, receive information, or respond personally. There is nothing for them to complete or produce that needs verifying afterward. This includes a personal request being relayed or reported on someone else's behalf (e.g. "tell X I would like her to call me" is informing X of a wish, not issuing X a work order).

DELEGATION: the person is being directly instructed to complete, produce, or verify something as a piece of work. The owner needs to know whether it actually got done, and Carson should follow up if it doesn't. A direct instruction to a staff member to perform an action for the owner (e.g. "ask Grace to call me") counts as this, even if the action itself is simple.

Answer on the first line with exactly one word: COMMUNICATION or DELEGATION.

If DELEGATION, add a second line: RECIPIENT: followed by the words that describe the work ${who} must do, copied exactly from the owner's message, in the owner's own order. Leave out the words that address ${who} (such as "ask ${who} to"). Also leave out anything the owner is asking Carson itself to do about managing the task — for example tracking it, following up on it, or reporting back to the owner — because Carson does that anyway. Keep such words only when they are part of ${who}'s own work (for example "follow up with the butcher", "track the grocery delivery", "make sure the oven is off", "tell Grace it is ready"). Never add, change, or reorder words.`;
}

export interface StaffInstructionInterpretation {
  classification: StaffInstructionClassification;
  /** The model's claimed verbatim recipient span (DELEGATION only). Untrusted until grounded. */
  recipientSpan: string | null;
  /** True when no usable answer came back (network, non-OK, error body, timeout, unparseable). */
  failed: boolean;
}

const FAILED_INTERPRETATION: StaffInstructionInterpretation = {
  classification: "delegation",
  recipientSpan: null,
  failed: true,
};

/** Parses the model's answer: first line the classification, then an optional RECIPIENT: line. */
export function parseStaffInstructionAnswer(text: string): StaffInstructionInterpretation {
  // The verdict is the first word of the answer, ignoring markdown or
  // trailing punctuation ("**DELEGATION**", "DELEGATION.").
  const verdict = text.trim().match(/^[^A-Za-z]*([A-Za-z]+)/)?.[1]?.toUpperCase();
  if (verdict === "COMMUNICATION") {
    return { classification: "communication", recipientSpan: null, failed: false };
  }
  if (verdict !== "DELEGATION") return FAILED_INTERPRETATION;
  const recipient = text.match(/RECIPIENT\s*:[ \t]*([^\r\n]*)/i)?.[1]?.trim();
  return { classification: "delegation", recipientSpan: recipient || null, failed: false };
}

/**
 * The one existing model call on the tracked-delegation path (C-02), now also
 * asked which of the owner's own words are the recipient's work. Never
 * throws. Every failure path returns `failed: true`.
 */
export async function interpretStaffInstructionViaModel(
  utterance: string,
  recipientName?: string | null,
): Promise<StaffInstructionInterpretation> {
  const text = utterance.trim();
  if (!text) return FAILED_INTERPRETATION;

  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), STAFF_INSTRUCTION_TIMEOUT_MS);
    });
    const res = await Promise.race([
      callAnthropicProxy({
        model: STAFF_INSTRUCTION_MODEL,
        max_tokens: STAFF_INSTRUCTION_MAX_TOKENS,
        messages: [{ role: "user", content: buildClassificationPrompt(text, recipientName) }],
      }),
      timeout,
    ]).finally(() => clearTimeout(timer));
    if (!res || !res.ok) return FAILED_INTERPRETATION;

    const body = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      error?: unknown;
      stop_reason?: string;
    };
    if (body.error) return FAILED_INTERPRETATION;
    // A cut-off answer could still ground as a partial instruction.
    if (body.stop_reason === "max_tokens") return FAILED_INTERPRETATION;

    return parseStaffInstructionAnswer(body.content?.[0]?.text ?? "");
  } catch {
    return FAILED_INTERPRETATION;
  }
}

/**
 * The real, production classifier, kept as the classification-only view of
 * the same single model call. Any failure resolves to "delegation" (see the
 * module-level fail-safe note above).
 */
export async function classifyStaffInstructionViaModel(
  taskText: string,
): Promise<StaffInstructionClassification> {
  const interpretation = await interpretStaffInstructionViaModel(taskText);
  return interpretation.failed ? "delegation" : interpretation.classification;
}

function normalizeForGrounding(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Deterministic grounding for the model's recipient span. The model only
 * points at the owner's own words; it never supplies content. Returns the
 * owner's exact words (whitespace collapsed) or null when the span is not a
 * contiguous piece of what the owner said, is empty, or still addresses the
 * recipient by name.
 */
export function groundRecipientInstruction(
  span: string | null | undefined,
  ownerText: string,
  recipientName?: string | null,
): string | null {
  if (!span) return null;
  const candidate = normalizeForGrounding(span)
    .replace(/^["']+|["']+$/g, "")
    .replace(/[\s.,;:!?]+$/g, "")
    // "to prepare lunch" → "prepare lunch": the leftover of "ask X to".
    .replace(/^to\s+/i, "")
    .trim();
  if (candidate.length < 3 || !/[a-z]/i.test(candidate)) return null;

  const owner = normalizeForGrounding(ownerText);
  const index = owner.toLowerCase().indexOf(candidate.toLowerCase());
  if (index < 0) return null;
  const grounded = owner.slice(index, index + candidate.length);

  const name = recipientName?.trim();
  if (name && new RegExp(`(?<![\\w])${escapeRegExp(name)}(?![\\w])`, "i").test(grounded)) return null;
  return grounded;
}

export type StaffInstructionDecision =
  | { kind: "communication" }
  | { kind: "delegation"; recipientInstruction: string }
  | { kind: "unsafe"; reason: "interpretation_unavailable" | "recipient_instruction_not_grounded" };

/**
 * The single decision sendDelegation acts on: communication (unchanged
 * C-02 routing), a tracked delegation carrying only the owner's words for
 * the recipient, or unsafe — nothing may be sent.
 */
export async function interpretStaffInstruction(
  ownerText: string,
  options: {
    recipientName?: string | null;
    interpretFn?: (text: string, recipientName?: string | null) => Promise<StaffInstructionInterpretation>;
  } = {},
): Promise<StaffInstructionDecision> {
  if (isReportedThirdPartyDesire(ownerText)) return { kind: "communication" };
  const interpretFn = options.interpretFn ?? interpretStaffInstructionViaModel;
  const interpretation = await interpretFn(ownerText, options.recipientName);
  if (interpretation.failed) return { kind: "unsafe", reason: "interpretation_unavailable" };
  if (interpretation.classification === "communication") return { kind: "communication" };
  const recipientInstruction = groundRecipientInstruction(
    interpretation.recipientSpan,
    ownerText,
    options.recipientName,
  );
  if (!recipientInstruction) return { kind: "unsafe", reason: "recipient_instruction_not_grounded" };
  return { kind: "delegation", recipientInstruction };
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
  // Deterministic E-axis check first (see isReportedThirdPartyDesire above)
  // — short-circuits the model-backed classifier entirely when it matches,
  // both for reliability (Gate 1: the classifier alone was only ~77%
  // reliable on this exact construction) and to avoid the network call.
  // Runs for every caller of this shared entry point, including the legacy
  // send_delegation clientTool, which never goes through
  // parseDelegationFastPath's own structural exclusion.
  if (isReportedThirdPartyDesire(taskText)) return true;
  const classification = await classifyFn(taskText);
  return classification === "communication";
}
