import { matchesAttentionIntent } from "../shared/carson-attention-intent-classifier.js";

const SUPPORTED_CAPABILITY = "calendar_read";
const SUPPORTED_RANGES = new Set(["today", "tomorrow", "this_week", "next_week", "next_7_days", "next_10_days", "next_14_days", "next_30_days"]);
const ATTENTION_CAPABILITY = "attention_summary_read";

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

/**
 * Deterministic coordinator for attention_summary_read — the typed
 * hard-grounding boundary. Unlike createReadOnlyTurnCoordinator() above
 * (Claude-based intent interpretation for calendar_read), classification
 * here is the same deterministic regex already used client-side
 * (matchesAttentionIntent, shared/carson-attention-intent-classifier.js) —
 * no model call, no latency/cost for this question class, and one
 * source of truth with the existing client-side guard's classification.
 *
 * fetchEvidence is injected (matches this file's existing dependency-
 * injection convention) — production wiring passes
 * fetchAttentionSummaryForServer from api/_carson-attention-evidence.js.
 */
export function createAttentionReadCoordinator({ fetchEvidence }) {
  if (typeof fetchEvidence !== "function") {
    throw new Error("Carson attention read coordinator dependencies are required.");
  }

  return async function coordinateAttentionTurn(ownerTurn) {
    if (!ownerTurn?.accountId || !ownerTurn?.turnId || !ownerTurn?.transcript?.trim()) {
      return { handled: false, status: 400, code: "invalid_owner_turn" };
    }
    if (ownerTurn.legacyClaimed === true) {
      return { handled: false, status: 409, code: "ownership_collision" };
    }
    if (!matchesAttentionIntent(ownerTurn.transcript)) {
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
    // failure result as an ok:false evidence object would.
    let result;
    try {
      result = await fetchEvidence({ accountId: policy.accountId, authorization: ownerTurn.authorization });
    } catch {
      result = null;
    }

    const evidence = result?.evidence ?? null;
    const grounded = evidence?.ok === true;
    return {
      handled: true,
      status: grounded ? 200 : 502,
      code: evidence?.code ?? "attention_read_failed",
      turnId: ownerTurn.turnId,
      capability: ATTENTION_CAPABILITY,
      groundingStatus: grounded ? "grounded" : "failed",
      evidence,
      ownerResult:
        result?.text ?? "I couldn't check what needs your attention right now — the live check didn't complete.",
    };
  };
}
