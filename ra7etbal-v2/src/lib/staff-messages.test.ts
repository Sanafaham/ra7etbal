import { describe, expect, it, vi, beforeEach } from "vitest";

const state: { selectResult: { data: unknown; error: unknown } } = {
  selectResult: { data: [], error: null },
};

const fromSpy = vi.fn();
const selectSpy = vi.fn();
const orderSpy = vi.fn();
const isSpy = vi.fn();
const eqSpy = vi.fn();
const insertSpy = vi.fn();
const updateSpy = vi.fn();
const rpcSpy = vi.fn();

/**
 * A single generic thenable chain — real supabase-js query builders are
 * themselves thenable, so `await supabase.from(x).select(y).is(...).order(...)`
 * resolves however many/few chain methods are actually called, in any
 * order. Every chain method is recorded by its own spy for call-shape
 * assertions and returns the same chain object so tests can call any
 * combination without the mock needing to know each function's exact
 * chain shape in advance.
 */
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    select: (...args: unknown[]) => { selectSpy(...args); return chain; },
    order: (...args: unknown[]) => { orderSpy(...args); return chain; },
    is: (...args: unknown[]) => { isSpy(...args); return chain; },
    eq: (...args: unknown[]) => { eqSpy(...args); return chain; },
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(state.selectResult).then(resolve, reject),
  };
  return chain;
}

vi.mock("./supabase", () => ({
  supabase: {
    from: (...args: unknown[]) => {
      fromSpy(...args);
      return {
        ...makeChain(),
        insert: (...insertArgs: unknown[]) => { insertSpy(...insertArgs); return makeChain(); },
        update: (...updateArgs: unknown[]) => { updateSpy(...updateArgs); return makeChain(); },
      };
    },
    rpc: (...args: unknown[]) => { rpcSpy(...args); return Promise.resolve(state.selectResult); },
  },
}));

import {
  getStaffMessageDisplayState,
  listStaffMessages,
  listOpenStaffEscalationsForNeedsYou,
  getOwnerEscalationByToken,
} from "./staff-messages";

beforeEach(() => {
  state.selectResult = { data: [], error: null };
  fromSpy.mockClear();
  selectSpy.mockClear();
  orderSpy.mockClear();
  isSpy.mockClear();
  eqSpy.mockClear();
  insertSpy.mockClear();
  updateSpy.mockClear();
  rpcSpy.mockClear();
});

describe("listStaffMessages", () => {
  it("10. never adds its own user_id filter — relies entirely on the RLS SELECT policy, so cross-household data cannot be requested through the client query", async () => {
    await listStaffMessages();

    expect(fromSpy).toHaveBeenCalledWith("staff_messages");
    const selectArg = String(selectSpy.mock.calls[0][0]);
    // No caller-supplied filter of any kind exists on this query — nothing
    // to manipulate into requesting another household's rows. The only
    // scoping mechanism is the database's own RLS policy.
    expect(selectArg).not.toMatch(/user_id/i);
    // Never selects internal-only fields.
    expect(selectArg).not.toMatch(/processing_status|processing_error|external_message_id|\buser_id\b/);
  });

  it("returns rows as-is from the query result", async () => {
    state.selectResult = {
      data: [{ id: "1", staff_name: "Grace", inbound_text: "hi", user_facing_state: "Waiting" }],
      error: null,
    };
    const rows = await listStaffMessages();
    expect(rows).toHaveLength(1);
  });

  it("throws a friendly error instead of leaking a raw Supabase/RLS error message", async () => {
    state.selectResult = { data: null, error: { message: "permission denied for table staff_messages" } };
    await expect(listStaffMessages()).rejects.toThrow("You don't have permission to do that.");
  });
});

describe("getStaffMessageDisplayState", () => {
  it("shows Needs You when owner_attention_required is true, even if user_facing_state disagrees", () => {
    expect(
      getStaffMessageDisplayState({ owner_attention_required: true, user_facing_state: "Waiting" }),
    ).toBe("Needs You");
  });

  it("shows Needs You when user_facing_state is Needs You even if owner_attention_required is false", () => {
    expect(
      getStaffMessageDisplayState({ owner_attention_required: false, user_facing_state: "Needs You" }),
    ).toBe("Needs You");
  });

  it("passes through Waiting/Completed/In Progress unchanged when neither Needs You signal is present", () => {
    expect(getStaffMessageDisplayState({ owner_attention_required: false, user_facing_state: "Waiting" })).toBe("Waiting");
    expect(getStaffMessageDisplayState({ owner_attention_required: false, user_facing_state: "Completed" })).toBe("Completed");
    expect(getStaffMessageDisplayState({ owner_attention_required: false, user_facing_state: "In Progress" })).toBe("In Progress");
  });
});

// ── Phase C: open staff escalations for Needs You ───────────────────────────

function openEscalationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "staff-msg-1",
    staff_name: "Christopher",
    inbound_text: "Can I buy red wine vinegar instead?",
    escalation_reason: "Needs approval for the substitution.",
    received_at: "2026-07-27T00:33:23.000Z",
    task_id: null,
    escalation_resolved_at: null,
    owner_attention_required: true,
    user_facing_state: "Needs You",
    decision: {
      id: "decision-1",
      status: "open",
      deep_link_token: "162865ee-4ad6-4b73-b6c4-ae4945a2f545",
      owner_reply_text: null,
      answered_at: null,
    },
    ...overrides,
  };
}

describe("listOpenStaffEscalationsForNeedsYou", () => {
  it("1. an open, undecided escalation appears, with all fields correctly mapped", async () => {
    state.selectResult = { data: [openEscalationRow()], error: null };
    const rows = await listOpenStaffEscalationsForNeedsYou();
    expect(rows).toEqual([
      {
        id: "staff-msg-1",
        staffName: "Christopher",
        inboundText: "Can I buy red wine vinegar instead?",
        escalationReason: "Needs approval for the substitution.",
        receivedAt: "2026-07-27T00:33:23.000Z",
        taskId: null,
        decisionId: "decision-1",
        deepLinkToken: "162865ee-4ad6-4b73-b6c4-ae4945a2f545",
      },
    ]);
  });

  it("handles the embedded decision arriving as a one-item array (PostgREST to-one shape variance)", async () => {
    state.selectResult = { data: [openEscalationRow({ decision: [openEscalationRow().decision] })], error: null };
    const rows = await listOpenStaffEscalationsForNeedsYou();
    expect(rows).toHaveLength(1);
    expect(rows[0].decisionId).toBe("decision-1");
  });

  it("3. a routine staff message (no owner attention, not Needs You) does not appear", async () => {
    state.selectResult = {
      data: [openEscalationRow({ owner_attention_required: false, user_facing_state: "Waiting", decision: null })],
      error: null,
    };
    const rows = await listOpenStaffEscalationsForNeedsYou();
    expect(rows).toHaveLength(0);
  });

  it("4a. an escalation already answered (decision status not 'open') does not appear", async () => {
    state.selectResult = {
      data: [openEscalationRow({ decision: { ...openEscalationRow().decision, status: "answered" } })],
      error: null,
    };
    expect(await listOpenStaffEscalationsForNeedsYou()).toHaveLength(0);
  });

  it("4b. an escalation with owner_reply_text already set does not appear", async () => {
    state.selectResult = {
      data: [openEscalationRow({ decision: { ...openEscalationRow().decision, owner_reply_text: "Go ahead" } })],
      error: null,
    };
    expect(await listOpenStaffEscalationsForNeedsYou()).toHaveLength(0);
  });

  it("4c. an escalation with answered_at already set does not appear", async () => {
    state.selectResult = {
      data: [openEscalationRow({ decision: { ...openEscalationRow().decision, answered_at: "2026-07-27T01:00:00.000Z" } })],
      error: null,
    };
    expect(await listOpenStaffEscalationsForNeedsYou()).toHaveLength(0);
  });

  it("a staff message flagged for owner attention with no paired decision row is excluded, not shown broken", async () => {
    state.selectResult = { data: [openEscalationRow({ decision: null })], error: null };
    expect(await listOpenStaffEscalationsForNeedsYou()).toHaveLength(0);
  });

  it("resolved escalations are excluded at the query level (escalation_resolved_at is null filter)", async () => {
    await listOpenStaffEscalationsForNeedsYou();
    expect(isSpy).toHaveBeenCalledWith("escalation_resolved_at", null);
  });

  it("never adds a manual user_id filter — relies entirely on RLS, same convention as listStaffMessages", async () => {
    await listOpenStaffEscalationsForNeedsYou();
    const selectArg = String(selectSpy.mock.calls[0][0]);
    expect(selectArg).not.toMatch(/\buser_id\b/);
    expect(eqSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(rpcSpy).not.toHaveBeenCalled();
  });
});

// ── Phase C: secure owner-decision page lookup ──────────────────────────────

function escalationDetailRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "decision-1",
    status: "open",
    created_at: "2026-07-27T00:33:32.000Z",
    staff_message: {
      staff_name: "Christopher",
      inbound_text: "Can I buy red wine vinegar instead?",
      escalation_reason: "Needs approval for the substitution.",
      received_at: "2026-07-27T00:33:23.000Z",
    },
    ...overrides,
  };
}

describe("getOwnerEscalationByToken", () => {
  it("7. a valid token resolves the correct escalation detail", async () => {
    state.selectResult = { data: [escalationDetailRow()], error: null };
    const detail = await getOwnerEscalationByToken("162865ee-4ad6-4b73-b6c4-ae4945a2f545");
    expect(detail).toEqual({
      id: "decision-1",
      status: "open",
      createdAt: "2026-07-27T00:33:32.000Z",
      alreadyAnswered: false,
      staffName: "Christopher",
      inboundText: "Can I buy red wine vinegar instead?",
      escalationReason: "Needs approval for the substitution.",
      receivedAt: "2026-07-27T00:33:23.000Z",
    });
  });

  it("queries by deep_link_token, not by id", async () => {
    state.selectResult = { data: [escalationDetailRow()], error: null };
    await getOwnerEscalationByToken("162865ee-4ad6-4b73-b6c4-ae4945a2f545");
    expect(eqSpy).toHaveBeenCalledWith("deep_link_token", "162865ee-4ad6-4b73-b6c4-ae4945a2f545");
  });

  it("truthfully reports an already-answered escalation without fetching the reply text", async () => {
    state.selectResult = { data: [escalationDetailRow({ status: "answered" })], error: null };
    const detail = await getOwnerEscalationByToken("token");
    expect(detail?.alreadyAnswered).toBe(true);
    const selectArg = String(selectSpy.mock.calls[0][0]);
    expect(selectArg).not.toMatch(/owner_reply_text/);
  });

  it("9. an invalid or unknown token resolves to null — a safe, generic not-found", async () => {
    state.selectResult = { data: [], error: null };
    expect(await getOwnerEscalationByToken("does-not-exist")).toBeNull();
  });

  it("8. a token belonging to another household resolves identically to null — RLS-only, never a manual filter", async () => {
    // RLS returning zero rows (cross-household) is indistinguishable at
    // this layer from a token that never existed — by design.
    state.selectResult = { data: [], error: null };
    const detail = await getOwnerEscalationByToken("someone-elses-token");
    expect(detail).toBeNull();
    const selectArg = String(selectSpy.mock.calls[0][0]);
    expect(selectArg).not.toMatch(/\buser_id\b/);
  });

  it("12. never calls insert, update, or rpc — this lookup can never answer or resolve the escalation itself", async () => {
    state.selectResult = { data: [escalationDetailRow()], error: null };
    await getOwnerEscalationByToken("token");
    expect(insertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("throws a friendly error instead of leaking a raw Supabase/RLS error message", async () => {
    state.selectResult = { data: null, error: { message: "permission denied for table staff_escalation_owner_decisions" } };
    await expect(getOwnerEscalationByToken("token")).rejects.toThrow("You don't have permission to do that.");
  });
});
