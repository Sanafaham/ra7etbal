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
 * GROUNDING RULE: the agent's instructions require it to call the tool
 * before answering any operational question, and to say plainly that it
 * cannot confirm the live state if the tool reports failure — never to
 * fall back to a plausible-sounding generic summary. This is enforced by
 * instruction text (the model must reason honestly), not by a code branch
 * — there is no separate "generic fallback" render path in this file at
 * all, unlike the old pipeline's renderAttentionSummary fallback.
 */

import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";

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
- If the owner's message isn't actually about their live operational state, answer naturally without calling the tool.`;

// Tool built fresh per turn, closing over this turn's own authorization —
// the tool's execute function performs the fetch itself (the model decides
// WHEN to call it, matching a normal agent tool-call loop), but the model
// itself never sees accountId/authorization — only the tool's returned
// JSON result, same security boundary as the old pipeline's reasoning call.
function buildAttentionStateTool({ fetchEvidence, accountId, authorization }) {
  return tool({
    name: "get_ra7etbal_attention_state",
    description:
      "Fetch the owner's current live Ra7etBal operational state: Needs You decisions, overdue reminders, " +
      "upcoming reminders, things waiting on other people, other active items, and unresolved notes/to-dos. " +
      "Always call this before answering any question about what needs attention, what's overdue, what's " +
      "waiting, or what can wait — never answer from memory.",
    parameters: z.object({}),
    async execute() {
      let result;
      try {
        result = await fetchEvidence({ accountId, authorization });
      } catch {
        result = null;
      }
      const evidence = result?.evidence ?? null;
      if (!evidence || evidence.ok !== true) {
        return {
          ok: false,
          message: "The live Ra7etBal check did not complete — do not answer as if you know the current state.",
        };
      }
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

    const attentionStateTool = buildAttentionStateTool({
      fetchEvidence,
      accountId: ownerTurn.accountId,
      authorization: ownerTurn.authorization,
    });
    const model = process.env.CARSON_AGENT_MODEL ?? DEFAULT_ATTENTION_AGENT_MODEL;
    const makeAgent = buildAgent ?? ((opts) => new Agent(opts));
    const agent = makeAgent({
      name: "Carson",
      instructions: ATTENTION_AGENT_INSTRUCTIONS,
      model,
      tools: [attentionStateTool],
    });

    const startedAt = Date.now();
    let result = null;
    let runThrew = false;
    try {
      result = await runAgent(agent, ownerTurn.transcript, {
        previousResponseId:
          typeof ownerTurn.previousResponseId === "string" && ownerTurn.previousResponseId.trim()
            ? ownerTurn.previousResponseId
            : undefined,
      });
    } catch {
      runThrew = true;
    }
    const latencyMs = Date.now() - startedAt;

    const toolCallCount = Array.isArray(result?.newItems)
      ? result.newItems.filter((item) => item?.type === "tool_call_item").length
      : 0;

    const finalOutput = typeof result?.finalOutput === "string" ? result.finalOutput.trim() : "";

    if (runThrew || !finalOutput) {
      logAgentRunDiagnostic({
        turnId: ownerTurn.turnId ?? null,
        model,
        toolCallCount,
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
      runSuccess: true,
      renderedPath: "agent_answer",
      latencyMs,
    });

    return {
      handled: true,
      status: 200,
      code: "attention_agent_ok",
      capability: "attention_summary_read",
      groundingStatus: "grounded",
      ownerResult: finalOutput,
      previousResponseId: typeof result.lastResponseId === "string" ? result.lastResponseId : null,
    };
  };
}
