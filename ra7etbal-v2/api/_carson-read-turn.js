import { matchesAttentionIntent } from "../shared/carson-attention-intent-classifier.js";
import { renderAttentionSummary, renderAttentionDecision } from "../shared/carson-attention-summary.js";
import { validateAttentionDecision } from "./_carson-attention-reasoning.js";

const SUPPORTED_CAPABILITY = "calendar_read";
const SUPPORTED_RANGES = new Set(["today", "tomorrow", "this_week", "next_week", "next_7_days", "next_10_days", "next_14_days", "next_30_days"]);
export const ATTENTION_CAPABILITY = "attention_summary_read";

export const READ_CAPABILITY_REGISTRY = Object.freeze({
  [SUPPORTED_CAPABILITY]: Object.freeze({ permission: "read" }),
  [ATTENTION_CAPABILITY]: Object.freeze({ permission: "read" }),
});

export function validateStructuredIntent(value) {
  if (!value || typeof value !== "object") return { ok: false, code: "malformed_intent" };
  if (typeof value.capability !== "string" || typeof value.range !== "string") {
    return { ok: false, code: "malformed_intent" };
  }
  if (value.capability !== SUPPORTED_CAPABILITY) return { ok: false, code: "unsupported_intent" };
  if (!SUPPORTED_RANGES.has(value.range)) return { ok: false, code: "malformed_intent" };
  return { ok: true, intent: { capability: SUPPORTED_CAPABILITY, range: value.range } };
}

export function authorizeReadIntent({ accountId, intent }) {
  if (!accountId) return { ok: false, code: "unauthorized" };
  const registration = READ_CAPABILITY_REGISTRY[intent.capability];
  if (!registration || registration.permission !== "read") {
    return { ok: false, code: "unsupported_intent" };
  }
  return { ok: true, accountId, capability: intent.capability, permission: "read" };
}

function cleanEvent(event) {
  if (!event || typeof event !== "object") return null;
  const title = typeof event.title === "string" && event.title.trim() ? event.title.trim() : "Untitled event";
  return {
    id: typeof event.id === "string" ? event.id : null,
    title,
    start: typeof event.start === "string" ? event.start : null,
    end: typeof event.end === "string" ? event.end : null,
    location: typeof event.location === "string" ? event.location : null,
    allDay: event.allDay === true,
  };
}

export function normalizeCalendarEvidence(raw, range) {
  if (!raw || typeof raw !== "object") {
    return { ok: false, code: "calendar_read_failed", range, connected: null, events: [] };
  }
  if (raw.connected !== true) {
    return {
      ok: false,
      code: raw.revoked ? "calendar_reconnect_required" : "calendar_not_connected",
      range,
      connected: false,
      events: [],
    };
  }
  return {
    ok: true,
    code: "calendar_read_succeeded",
    range,
    connected: true,
    events: Array.isArray(raw.events) ? raw.events.map(cleanEvent).filter(Boolean) : [],
  };
}

export function renderCalendarOwnerResult(evidence) {
  if (!evidence.ok) {
    if (evidence.code === "calendar_reconnect_required" || evidence.code === "calendar_not_connected") {
      return "I couldn't read your calendar. Please reconnect it in Settings.";
    }
    return "I couldn't read your calendar right now.";
  }
  if (evidence.events.length === 0) {
    return evidence.range === "tomorrow"
      ? "You have nothing on your calendar tomorrow."
      : "You have no calendar events in that period.";
  }
  const titles = evidence.events.map((event) => event.title);
  const prefix = evidence.range === "tomorrow" ? "Tomorrow" : "On your calendar";
  return `${prefix}: ${titles.join("; ")}.`;
}

export function createReadOnlyTurnCoordinator({ interpretIntent, readCalendar }) {
  if (typeof interpretIntent !== "function" || typeof readCalendar !== "function") {
    throw new Error("Carson read coordinator dependencies are required.");
  }

  return async function coordinateOwnerTurn(ownerTurn) {
    if (!ownerTurn?.accountId || !ownerTurn?.turnId || !ownerTurn?.providerEventId || !ownerTurn?.transcript?.trim()) {
      return { handled: false, status: 400, code: "invalid_owner_turn" };
    }
    if (ownerTurn.legacyClaimed === true) {
      return { handled: false, status: 409, code: "ownership_collision" };
    }

    let proposed;
    try {
      proposed = await interpretIntent(ownerTurn.transcript);
    } catch {
      return { handled: true, status: 502, code: "intent_unavailable", ownerResult: "I couldn't understand that request reliably. Nothing was changed." };
    }

    const validated = validateStructuredIntent(proposed);
    if (!validated.ok) {
      const unsupported = validated.code === "unsupported_intent";
      return {
        handled: unsupported ? false : true,
        status: unsupported ? 422 : 502,
        code: validated.code,
        ...(unsupported ? {} : { ownerResult: "I couldn't understand that request reliably. Nothing was changed." }),
      };
    }

    const policy = authorizeReadIntent({ accountId: ownerTurn.accountId, intent: validated.intent });
    if (!policy.ok) return { handled: true, status: 401, code: policy.code, ownerResult: "Please sign in again before I read your calendar." };

    let rawEvidence;
    try {
      rawEvidence = await readCalendar({
        accountId: policy.accountId,
        authorization: ownerTurn.authorization,
        range: validated.intent.range,
      });
    } catch {
      rawEvidence = null;
    }
    const evidence = normalizeCalendarEvidence(rawEvidence, validated.intent.range);
    return {
      handled: true,
      status: evidence.ok ? 200 : 502,
      code: evidence.code,
      turnId: ownerTurn.turnId,
      capability: policy.capability,
      evidence,
      ownerResult: renderCalendarOwnerResult(evidence),
    };
  };
}

function collectAllEvidenceIds(evidence) {
  return [
    ...(evidence.needsYou ?? []),
    ...(evidence.overdueReminders ?? []),
    ...(evidence.upcomingReminders ?? []),
    ...(evidence.waiting ?? []),
    ...(evidence.later ?? []),
    ...(evidence.unresolvedCaptures ?? []),
  ].map((item) => item.id);
}

/**
 * Coordinator for attention_summary_read — the typed hard-grounding +
 * Second Brain stateful reasoning boundary.
 *
 * Two admission paths, deliberately different in mechanism:
 *
 * 1. DIRECT intent (matchesAttentionIntent, shared/carson-attention-intent-
 *    classifier.js) — the same deterministic regex already used
 *    client-side, no model call, no latency/cost. Unchanged from the
 *    original hard-grounding slice: fetch fresh evidence, render the full
 *    result deterministically via renderAttentionSummary.
 *
 * 2. ACTIVE GROUNDED ATTENTION CONTEXT (ownerTurn.previousCapability ===
 *    "attention_summary_read" && ownerTurn.previousGroundingStatus ===
 *    "grounded") — admitted WITHOUT requiring any regex match on the new
 *    transcript. This is the 2026-08-28 correction: making a growing
 *    follow-up regex the intelligence gate would mean adding a new pattern
 *    for every new phrasing forever, exactly what this reasoning layer
 *    exists to stop. Once genuine grounded attention context is active,
 *    the REASONING MODEL decides — from fresh evidence, not memory —
 *    whether this new message continues the topic (and how: list,
 *    prioritize, filter, explain, nothing_new, clarify) or is unrelated
 *    (not_attention, in which case the turn is left unclaimed so the
 *    normal typed path can handle it).
 *
 * Both paths always perform a fresh, authenticated, RLS-scoped retrieval —
 * previouslySurfacedEvidenceIds/priorObjective are conversational context
 * for the model only, never a substitute for retrieval and never trusted
 * for identity/tenant scoping (that remains accountId/authorization only,
 * verified the same way for every turn regardless of conversation state).
 *
 * fetchEvidence and reasonOverEvidence are injected (matches this file's
 * existing dependency-injection convention) — production wiring passes
 * fetchAttentionSummaryForServer (api/_carson-attention-evidence.js) and
 * reasonOverOperationalEvidenceWithClaude (api/_carson-attention-
 * reasoning.js).
 */
export function createAttentionReadCoordinator({ fetchEvidence, reasonOverEvidence }) {
  if (typeof fetchEvidence !== "function" || typeof reasonOverEvidence !== "function") {
    throw new Error("Carson attention read coordinator dependencies are required.");
  }

  return async function coordinateAttentionTurn(ownerTurn) {
    if (!ownerTurn?.accountId || !ownerTurn?.turnId || !ownerTurn?.transcript?.trim()) {
      return { handled: false, status: 400, code: "invalid_owner_turn" };
    }
    if (ownerTurn.legacyClaimed === true) {
      return { handled: false, status: 409, code: "ownership_collision" };
    }

    const isDirectAttentionIntent = matchesAttentionIntent(ownerTurn.transcript);
    const hasActiveGroundedAttentionContext =
      ownerTurn.previousCapability === ATTENTION_CAPABILITY && ownerTurn.previousGroundingStatus === "grounded";
    // Third admission path (2026-08-28 correction): the orchestration layer
    // (api/carson-turn.js) may have already run a coarse, transcript-only
    // Stage 1 semantic classification and determined this turn is a novel
    // operational-state question with no regex/context match at all — set
    // ownerTurn.stage1Admitted = true in that case. This coordinator still
    // independently re-derives isDirectAttentionIntent/
    // hasActiveGroundedAttentionContext itself either way; stage1Admitted is
    // purely additive, never a substitute for those checks when applicable.
    const stage1Admitted = ownerTurn.stage1Admitted === true;

    if (!isDirectAttentionIntent && !hasActiveGroundedAttentionContext && !stage1Admitted) {
      return { handled: false, status: 422, code: "unsupported_intent" };
    }

    const policy = authorizeReadIntent({
      accountId: ownerTurn.accountId,
      intent: { capability: ATTENTION_CAPABILITY },
    });
    if (!policy.ok) {
      return {
        handled: true,
        status: 401,
        code: policy.code,
        ownerResult: "Please sign in again before I check what needs your attention.",
      };
    }

    // The server retrieval itself never throws (see
    // fetchAttentionSummaryForServer's own try/catch), but this coordinator
    // does not assume that of an arbitrary injected dependency — a thrown
    // rejection here still resolves to the same honest, code-enforced
    // failure result as an ok:false evidence object would. Fresh retrieval
    // failing is always the honest fallback, regardless of admission path —
    // no evidence means no factual operational answer, and no reasoning
    // call is even attempted without evidence to reason over.
    let result;
    try {
      result = await fetchEvidence({ accountId: policy.accountId, authorization: ownerTurn.authorization });
    } catch {
      result = null;
    }
    const evidence = result?.evidence ?? null;
    const grounded = evidence?.ok === true;

    if (!grounded) {
      return {
        handled: true,
        status: 502,
        code: evidence?.code ?? "attention_read_failed",
        turnId: ownerTurn.turnId,
        capability: ATTENTION_CAPABILITY,
        groundingStatus: "failed",
        evidence,
        ownerResult:
          result?.text ?? "I couldn't check what needs your attention right now — the live check didn't complete.",
      };
    }

    if (isDirectAttentionIntent) {
      return {
        handled: true,
        status: 200,
        code: evidence.code,
        turnId: ownerTurn.turnId,
        capability: ATTENTION_CAPABILITY,
        groundingStatus: "grounded",
        evidence,
        ownerResult: result.text,
        surfacedEvidenceIds: collectAllEvidenceIds(evidence),
        responseIntent: "list",
      };
    }

    // Context-only candidate (no direct regex match): the reasoning model
    // decides relevance/selection/intent over the fresh evidence just
    // retrieved. It never sees accountId/authorization and cannot
    // influence retrieval or tenant scoping — it only classifies and
    // selects among ids already authorized above.
    let rawDecision;
    try {
      rawDecision = await reasonOverEvidence({
        userMessage: ownerTurn.transcript,
        conversationState: {
          priorCapability: ownerTurn.previousCapability ?? null,
          priorGroundingStatus: ownerTurn.previousGroundingStatus ?? null,
          previouslySurfacedEvidenceIds: Array.isArray(ownerTurn.previouslySurfacedEvidenceIds)
            ? ownerTurn.previouslySurfacedEvidenceIds
            : [],
          priorObjective: typeof ownerTurn.priorObjective === "string" ? ownerTurn.priorObjective : null,
        },
        authorizedEvidence: evidence,
      });
    } catch {
      rawDecision = null;
    }

    const validated = rawDecision ? validateAttentionDecision(rawDecision, evidence) : { ok: false };

    if (!validated.ok) {
      // Reasoning failed/returned invalid output, but fresh evidence IS
      // valid — fall back to the existing full deterministic render
      // (truthful, just not intelligently filtered), never a fabricated
      // or free-form answer.
      return {
        handled: true,
        status: 200,
        code: evidence.code,
        turnId: ownerTurn.turnId,
        capability: ATTENTION_CAPABILITY,
        groundingStatus: "grounded",
        evidence,
        ownerResult: renderAttentionSummary(evidence),
        surfacedEvidenceIds: collectAllEvidenceIds(evidence),
        responseIntent: "list",
      };
    }

    if (validated.decision.responseIntent === "not_attention") {
      // Not an error — a resolved, valid decision that this turn does not
      // belong to the attention topic. Left unclaimed so the normal typed
      // path (unrelated to this coordinator) can handle it.
      return { handled: false, status: 200, code: "not_attention" };
    }

    return {
      handled: true,
      status: 200,
      code: evidence.code,
      turnId: ownerTurn.turnId,
      capability: ATTENTION_CAPABILITY,
      groundingStatus: "grounded",
      evidence,
      ownerResult: renderAttentionDecision(evidence, validated.decision),
      surfacedEvidenceIds: validated.decision.selectedEvidenceIds,
      responseIntent: validated.decision.responseIntent,
    };
  };
}
