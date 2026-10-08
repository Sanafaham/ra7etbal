/**
 * Carson attention agent — OpenAI Agents SDK vertical slice (2026-08-30).
 *
 * OWNER DECISION: after repeated real-production canary failures of the
 * custom Stage 1 (coarse classifier) / Stage 2 (Anthropic strict-tool-call)
 * / responseIntent taxonomy / structural retry / deterministic fallback
 * design (see api/_carson-read-turn.js, api/_carson-attention-reasoning.js),
 * the typed attention read path is being replaced — behind a narrow
 * owner-only feature flag — with a normal agent loop: the model reasons
 * freely in natural language and decides for itself when to call the one
 * narrow read-only Ra7etBal tool below. No responseIntent taxonomy, no
 * defer_timing branch, no bespoke phrase-specific code — the model
 * understands "what can wait?" the same way it understands any other
 * natural-language question, as long as it has the live tool result.
 *
 * REUSE, NOT REBUILD: the tool's data source is fetchAttentionSummaryForServer
 * (api/_carson-attention-evidence.js) — the exact same per-request,
 * JWT-authorized, RLS-scoped evidence retrieval the old pipeline used.
 * Business classification (what counts as needsYou/overdue/waiting/later)
 * is unchanged. Only the reasoning/response layer on top of that evidence
 * is new.
 *
 * GROUNDING RULE (2026-08-30, CodeRabbit finding on PR #381, hardened):
 * the agent's instructions tell it to call the tool before answering, but
 * instruction text alone is not treated as the enforcement mechanism — a
 * model can still produce plausible-sounding text without actually calling
 * the tool, or after the tool failed. Grounding is therefore enforced in
 * EXECUTION STATE: a small mutable object closed over by the tool's own
 * execute() function records whether the tool was actually called and
 * whether the live evidence fetch actually succeeded. The coordinator only
 * returns the model's finalOutput as a grounded answer when ALL THREE are
 * true: the tool was called, the live fetch succeeded, and the model
 * produced final output text. Any other combination fails closed to an
 * honest "can't confirm" response — never a fabricated answer.
 *
 * previousResponseId (2026-08-30, CodeRabbit finding on PR #381, REMOVED):
 * an earlier version of this file accepted a client-supplied
 * previousResponseId and passed it straight through to OpenAI's Responses
 * API chaining. That is a real cross-tenant trust boundary — an opaque
 * pointer into OpenAI's own stored conversation state, unauthenticated
 * against the caller's actual account. Removed entirely for this first
 * vertical slice, in both directions: no previousResponseId is ever read
 * from the request, ever sent to OpenAI, or ever returned to the client.
 * Each turn runs as a standalone request. Durable, server-owned response
 * chaining (verified against the caller's own account) can be added later
 * as a separate, deliberately-scoped capability if cross-turn memory turns
 * out to matter in practice — not smuggled in here as a client-trusted
 * shortcut.
 */

import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";
import { matchesAttentionIntent, matchesWaitingFollowUp } from "../shared/carson-attention-intent-classifier.js";
import { renderAlsoOnYourMindLine } from "../shared/carson-attention-summary.js";

export const DEFAULT_ATTENTION_AGENT_MODEL = "gpt-5.6-sol";

function describeItemForAgent(item) {
  return {
    id: item.id,
    label: item.label,
    type: item.type,
    status: item.status,
    category: item.category,
    dueAt: item.dueAt,
    dueDescription: item.dueDescription,
    assignee: item.assignee,
  };
}

// Structured, JSON-shaped evidence for the model — includes the raw dueAt
// timestamp and the evidence's own generatedAt ("asOf") so the model can
// judge overdue/not-yet-due/no-due-date itself from real timestamps, never
// from which category an item happens to be filed under (later is a
// residual UI bucket, not a safety signal — see shared/carson-attention-
// summary.js's own comment on this, unchanged from the old pipeline).
export function describeEvidenceForAgent(evidence) {
  return {
    asOf: evidence.generatedAt,
    completeness: evidence.completeness,
    needsYou: (evidence.needsYou ?? []).map(describeItemForAgent),
    overdueReminders: (evidence.overdueReminders ?? []).map(describeItemForAgent),
    upcomingReminders: (evidence.upcomingReminders ?? []).map(describeItemForAgent),
    waiting: (evidence.waiting ?? []).map(describeItemForAgent),
    later: (evidence.later ?? []).map(describeItemForAgent),
    unresolvedCaptures: (evidence.unresolvedCaptures ?? []).map(describeItemForAgent),
  };
}

export const ATTENTION_AGENT_INSTRUCTIONS = `You are Carson, Ra7etBal's Chief of Staff, answering the owner's question about their own live operational state (tasks, reminders, delegations, notes).

Rules:
- Before answering any question about what needs attention, what's overdue, what they're waiting on, or what can wait, you MUST call get_ra7etbal_attention_state to get the live truth. Never answer an operational question from memory or assumption — no tool result means no factual operational answer.
- If the tool result has ok: false, tell the owner plainly that you could not confirm their live state right now. Never guess, and never fall back to a plausible-sounding generic summary.
- Every fact you state must come from the tool result. Never invent a task, reminder, status, assignee, or due date that isn't in it.
- The tool result's "asOf" field is the current time this evidence was generated. Compare it yourself to each item's own "dueAt" to judge whether something is overdue, due soon, or not yet due. Never treat which list/category an item is filed under (needsYou, overdueReminders, upcomingReminders, waiting, later, unresolvedCaptures) as a judgment of urgency, importance, or safety to postpone — those are just organizational buckets, not priority signals.
- A future due date does not by itself mean something is unimportant or safe to ignore. An item having no due date does not mean it is safe to ignore either. Overdue does not automatically outrank a needsYou decision that has no due date at all.
- When asked what can wait (or an equivalent phrasing), describe which items are genuinely not due yet or have no due date, based on each item's own due date — and be explicit that timing alone doesn't tell you what's truly safe to deprioritize or unimportant.
- Keep answers concise, natural, and specific — name the actual items by their label, don't just give counts, unless the owner's question is itself just a count question.
- If the owner's message isn't actually about their live operational state, answer naturally without calling the tool.

Output format:
- Put your complete reply to the owner, written exactly as you would otherwise reply, in "answer".
- Set "answerKind" to describe that reply:
  - "summary": the owner asked broadly what needs their attention, and "answer" is your overview of their live state.
  - "narrow": the question or your answer is about one person, item, category or timing (for example what they are waiting on, what is pending with someone, or whether they are clear to do something).
  - "clarification": you are asking the owner a question instead of answering.
  - "nothing_new": you are telling the owner there is nothing (else) to report.
- If you are unsure, use "narrow".`;

// P3 Step 3 / S2b — the agent's structured final result (same single run:
// the SDK sends this as the Responses API text.format JSON schema). answer
// is the owner-visible reply; answerKind only gates whether the server may
// add omitted eligible captures — it is never marking authority.
export const ATTENTION_ANSWER_KINDS = Object.freeze(["summary", "narrow", "clarification", "nothing_new"]);
export const ATTENTION_AGENT_OUTPUT = z.object({
  answer: z.string(),
  answerKind: z.enum(ATTENTION_ANSWER_KINDS),
});

// Tool built fresh per turn, closing over this turn's own authorization —
// the tool's execute function performs the fetch itself (the model decides
// WHEN to call it, matching a normal agent tool-call loop), but the model
// itself never sees accountId/authorization — only the tool's returned
// JSON result, same security boundary as the old pipeline's reasoning call.
//
// executionState is a mutable object OWNED BY THE COORDINATOR (not the
// model, not the SDK) — this is the actual grounding-enforcement
// mechanism, independent of whether the model followed its instructions.
function buildAttentionStateTool({ fetchEvidence, accountId, authorization, executionState }) {
  return tool({
    name: "get_ra7etbal_attention_state",
    description:
      "Fetch the owner's current live Ra7etBal operational state: Needs You decisions, overdue reminders, " +
      "upcoming reminders, things waiting on other people, other active items, and unresolved notes/to-dos. " +
      "Always call this before answering any question about what needs attention, what's overdue, what's " +
      "waiting, or what can wait — never answer from memory.",
    parameters: z.object({}),
    async execute() {
      executionState.called = true;
      let result;
      try {
        result = await fetchEvidence({ accountId, authorization });
      } catch {
        result = null;
      }
      const evidence = result?.evidence ?? null;
      if (!evidence || evidence.ok !== true) {
        executionState.evidenceOk = false;
        return {
          ok: false,
          message: "The live Ra7etBal check did not complete — do not answer as if you know the current state.",
        };
      }
      executionState.evidenceOk = true;
      executionState.evidence = evidence;
      return { ok: true, ...describeEvidenceForAgent(evidence) };
    },
  });
}

// Safe structured run observability (2026-08-30) — model, tool-call count,
// run/tool success, final response path, latency only. Never user message
// text, tool result contents, or the model's final answer text.
function logAgentRunDiagnostic(fields) {
  try {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ diagnostic: "carson_attention_agent_v1", ...fields }));
  } catch {
    // Diagnostic logging must never affect or interrupt the actual turn.
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Letters, combining marks (e.g. Arabic harakat) and digits continue a word.
const WORD_CHAR = "\\p{L}\\p{M}\\p{N}";

// Every [start, end) range where `label` appears in `text` as a whole phrase,
// case-insensitive.
function phraseRanges(text, label) {
  const pattern = new RegExp(`(?<![${WORD_CHAR}])${escapeRegExp(label)}(?![${WORD_CHAR}])`, "giu");
  const ranges = [];
  for (const match of text.matchAll(pattern)) ranges.push([match.index, match.index + match[0].length]);
  return ranges;
}

/**
 * P3 Step 3 / S2 — which unresolved captures this free-text answer actually
 * showed the owner. Only a capture whose exact label appears in the final
 * answer (case-insensitive, as a whole phrase) counts — and not where that
 * appearance is only part of a longer label of another evidence item (e.g.
 * capture "Call" inside reminder "Call Loulya"). Fetched, available-to-the-
 * model, or paraphrased captures do not count: an unmarked capture only
 * shows again later, while a false mark hides it.
 */
export function capturesNamedInAgentAnswer(evidence, finalOutput) {
  if (!evidence || evidence.ok !== true || typeof finalOutput !== "string" || !finalOutput) return [];
  const labelOf = (item) => (typeof item?.label === "string" ? item.label.trim() : "");
  const allItems = [
    ...(evidence.needsYou ?? []),
    ...(evidence.overdueReminders ?? []),
    ...(evidence.upcomingReminders ?? []),
    ...(evidence.waiting ?? []),
    ...(evidence.later ?? []),
    ...(evidence.unresolvedCaptures ?? []),
  ];
  return (evidence.unresolvedCaptures ?? [])
    .filter((capture) => {
      const label = labelOf(capture);
      if (!label) return false;
      const lower = label.toLowerCase();
      // A longer label containing this one, or a non-capture item with the
      // very same label, makes that appearance ambiguous — don't count it.
      const captures = new Set(evidence.unresolvedCaptures ?? []);
      const covering = allItems
        .filter((other) => other !== capture)
        .filter((other) => {
          const otherLabel = labelOf(other).toLowerCase();
          if (otherLabel === lower) return !captures.has(other);
          return otherLabel.length > lower.length && otherLabel.includes(lower);
        })
        .flatMap((other) => phraseRanges(finalOutput, labelOf(other)));
      return phraseRanges(finalOutput, label).some(
        ([start, end]) => !covering.some(([coverStart, coverEnd]) => coverStart <= start && end <= coverEnd),
      );
    })
    .map((capture) => capture.id);
}

/**
 * P3 Step 3 / S2b. Production 2026-10-08 10:42 UTC: capture retrieval
 * succeeded, three captures were eligible, and the agent's answer to "What
 * needs my attention?" named none of them, so the owner never saw them.
 *
 * Eligible captures the model omitted are appended in the established
 * "Also on your mind: …" wording ONLY when every one of these holds:
 *   - the run completed and was grounded (attention_agent_ok, evidence.ok);
 *   - the agent's structured answerKind is "summary";
 *   - the owner's message is the existing general attention question
 *     (matchesAttentionIntent), not the existing waiting-only shape;
 *   - the answer itself presents at least one live evidence item by exact
 *     label (a substantive answer, not a bare clarification);
 *   - at least one eligible capture is missing from the answer.
 * answerKind alone and a named item alone are each insufficient.
 *
 * surfacedEvidenceIds is derived on the server from the FINAL answer
 * (exact-label named + appended) — never from anything the model reports —
 * and stays the only input to the awaited presentation-boundary mark.
 * Never throws; on any unexpected error the original result is returned.
 */
export function presentOmittedAttentionCaptures(ownerTurn, result) {
  try {
    if (
      !result ||
      result.handled !== true ||
      result.code !== "attention_agent_ok" ||
      result.groundingStatus !== "grounded" ||
      result.capability !== "attention_summary_read" ||
      typeof result.ownerResult !== "string" ||
      !result.ownerResult
    ) {
      return result;
    }
    if (result.answerKind !== "summary") return result;
    const evidence = result.evidence;
    if (!evidence || evidence.ok !== true) return result;
    const captures = (evidence.unresolvedCaptures ?? []).filter(
      (capture) => typeof capture?.label === "string" && capture.label.trim(),
    );
    if (captures.length === 0) return result;

    const transcript = typeof ownerTurn?.transcript === "string" ? ownerTurn.transcript : "";
    if (!matchesAttentionIntent(transcript) || matchesWaitingFollowUp(transcript)) return result;

    const answer = result.ownerResult;
    const presentsLiveEvidence = [
      ...(evidence.needsYou ?? []),
      ...(evidence.overdueReminders ?? []),
      ...(evidence.upcomingReminders ?? []),
      ...(evidence.waiting ?? []),
      ...(evidence.later ?? []),
      ...captures,
    ].some((item) => {
      const label = typeof item?.label === "string" ? item.label.trim() : "";
      return label && phraseRanges(answer, label).length > 0;
    });
    if (!presentsLiveEvidence) return result;

    const named = new Set(capturesNamedInAgentAnswer(evidence, answer));
    const omitted = captures.filter((capture) => !named.has(capture.id));
    if (omitted.length === 0) return result;

    const omittedIds = new Set(omitted.map((capture) => capture.id));
    return {
      ...result,
      ownerResult: `${answer}\n\n${renderAlsoOnYourMindLine(omitted)}`,
      // Evidence order; each presented capture exactly once.
      surfacedEvidenceIds: captures
        .filter((capture) => named.has(capture.id) || omittedIds.has(capture.id))
        .map((capture) => capture.id),
    };
  } catch {
    return result;
  }
}

/**
 * Coordinator for the OpenAI-agent-based attention path
 * (CARSON_OPENAI_AGENT_ATTENTION_V1). Deliberately mirrors
 * createAttentionReadCoordinator's dependency-injection shape
 * (api/_carson-read-turn.js) for the same reason: production wiring
 * passes real implementations, tests inject fakes — no network dependency
 * in unit tests.
 */
export function createAttentionAgentCoordinator({ fetchEvidence, runAgent = run, buildAgent } = {}) {
  if (typeof fetchEvidence !== "function") {
    throw new Error("Carson attention agent coordinator requires fetchEvidence.");
  }

  return async function coordinateAttentionAgentTurn(ownerTurn) {
    if (!ownerTurn?.accountId || !ownerTurn?.transcript?.trim()) {
      return { handled: false, status: 400, code: "invalid_owner_turn" };
    }

    const executionState = { called: false, evidenceOk: false, evidence: null };
    const attentionStateTool = buildAttentionStateTool({
      fetchEvidence,
      accountId: ownerTurn.accountId,
      authorization: ownerTurn.authorization,
      executionState,
    });
    const model = process.env.CARSON_AGENT_MODEL ?? DEFAULT_ATTENTION_AGENT_MODEL;
    const makeAgent = buildAgent ?? ((opts) => new Agent(opts));
    const agent = makeAgent({
      name: "Carson",
      instructions: ATTENTION_AGENT_INSTRUCTIONS,
      model,
      tools: [attentionStateTool],
      outputType: ATTENTION_AGENT_OUTPUT,
    });

    // Standalone per turn — no previousResponseId, no client-supplied
    // conversation pointer of any kind (see the file-level doc comment for
    // why). Each turn is a fresh run(agent, transcript) call.
    const startedAt = Date.now();
    let result = null;
    let runThrew = false;
    try {
      result = await runAgent(agent, ownerTurn.transcript);
    } catch {
      runThrew = true;
    }
    const latencyMs = Date.now() - startedAt;

    const toolCallCount = Array.isArray(result?.newItems)
      ? result.newItems.filter((item) => item?.type === "tool_call_item").length
      : 0;

    // Structured final result (ATTENTION_AGENT_OUTPUT). A plain-text final
    // output (no structure) is still accepted as the answer but carries no
    // answerKind, so nothing is ever added to it.
    const structured = result?.finalOutput;
    const finalOutput =
      typeof structured === "string"
        ? structured.trim()
        : typeof structured?.answer === "string"
          ? structured.answer.trim()
          : "";
    const answerKind =
      typeof structured === "object" && ATTENTION_ANSWER_KINDS.includes(structured?.answerKind)
        ? structured.answerKind
        : null;
    // The actual grounding gate: not "did text come back" but "did a
    // successful live tool call actually happen for THIS run."
    const grounded = executionState.called && executionState.evidenceOk;

    if (runThrew || !finalOutput || !grounded) {
      logAgentRunDiagnostic({
        turnId: ownerTurn.turnId ?? null,
        model,
        toolCallCount,
        toolCalled: executionState.called,
        toolEvidenceOk: executionState.evidenceOk,
        runSuccess: false,
        renderedPath: "agent_run_failed",
        latencyMs,
      });
      return {
        handled: true,
        status: 200,
        code: "attention_agent_failed",
        capability: "attention_summary_read",
        groundingStatus: "failed",
        ownerResult: "I couldn't check your live Ra7etBal state right now — please try again in a moment.",
      };
    }

    logAgentRunDiagnostic({
      turnId: ownerTurn.turnId ?? null,
      model,
      toolCallCount,
      toolCalled: executionState.called,
      toolEvidenceOk: executionState.evidenceOk,
      runSuccess: true,
      renderedPath: "agent_answer",
      latencyMs,
    });

    // Shared by the typed path and the Second Brain voice boundary (both call
    // this coordinator), so both receive the identical final answer.
    return presentOmittedAttentionCaptures(ownerTurn, {
      handled: true,
      status: 200,
      code: "attention_agent_ok",
      capability: "attention_summary_read",
      groundingStatus: "grounded",
      answerKind,
      ownerResult: finalOutput,
      // P3 Step 3 / S2: the evidence this answer was grounded in, and only
      // the captures it actually named — read by the presentation boundary
      // in api/carson-turn.js to set last_surfaced_at.
      evidence: executionState.evidence,
      surfacedEvidenceIds: capturesNamedInAgentAnswer(executionState.evidence, finalOutput),
    });
  };
}
