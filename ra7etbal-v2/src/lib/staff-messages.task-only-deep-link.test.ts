/**
 * Slice 1 — deep-link fix: a task-only decision (staff_message_id IS NULL)
 * resolves through task_id to the REAL task, never to fabricated staff text.
 * Staff-message-backed resolution is covered unchanged by staff-messages.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const results: Record<string, Array<{ data: unknown; error: unknown }>> = {};
const calls: Array<{ table: string; select?: string; eq: Array<[string, unknown]> }> = [];
const writes = vi.fn();

vi.mock("./supabase", () => ({
  supabase: {
    from: (table: string) => {
      const call: { table: string; select?: string; eq: Array<[string, unknown]> } = { table, eq: [] };
      calls.push(call);
      const chain: Record<string, unknown> = {
        select: (s: string) => { call.select = s; return chain; },
        eq: (k: string, v: unknown) => { call.eq.push([k, v]); return chain; },
        insert: (...a: unknown[]) => { writes(...a); return chain; },
        update: (...a: unknown[]) => { writes(...a); return chain; },
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve((results[table] ?? []).shift() ?? { data: [], error: null }).then(resolve, reject),
      };
      return chain;
    },
    rpc: (...a: unknown[]) => { writes(...a); return Promise.resolve({ data: null, error: null }); },
  },
}));

const { getOwnerEscalationByToken, taskNotCurrentReason } = await import("./staff-messages");

function decisionRow(over: Record<string, unknown> = {}) {
  return {
    id: "decision-1",
    status: "open",
    created_at: "2026-09-28T17:00:00.000Z",
    staff_message_id: null,
    task_id: "task-1",
    review_type: "no_response",
    staff_message: null,
    ...over,
  };
}

function taskRow(over: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    description: "call me now.",
    assigned_to: "Christopher",
    status: "pending",
    archived_at: null,
    dismissed_at: null,
    confirmed_at: null,
    ...over,
  };
}

beforeEach(() => {
  for (const k of Object.keys(results)) delete results[k];
  calls.length = 0;
  writes.mockClear();
});

describe("getOwnerEscalationByToken — task-only decisions", () => {
  it("8. resolves the real task via task_id with no fabricated inbound text", async () => {
    results.staff_escalation_owner_decisions = [{ data: [decisionRow()], error: null }];
    results.tasks = [{ data: [taskRow()], error: null }];
    const detail = await getOwnerEscalationByToken("tok");
    expect(detail).toEqual({
      kind: "task_only",
      id: "decision-1",
      status: "open",
      createdAt: "2026-09-28T17:00:00.000Z",
      alreadyAnswered: false,
      reviewType: "no_response",
      taskId: "task-1",
      taskDescription: "call me now.",
      assigneeName: "Christopher",
      taskNotCurrentReason: null,
      ownerChoice: null,
    });
    expect(detail).not.toHaveProperty("inboundText");
    expect(calls.find((c) => c.table === "tasks")?.eq).toEqual([["id", "task-1"]]);
    expect(writes).not.toHaveBeenCalled();
  });

  it("9. a terminal task resolves as non-actionable", async () => {
    results.staff_escalation_owner_decisions = [{ data: [decisionRow()], error: null }];
    results.tasks = [{ data: [taskRow({ status: "done", confirmed_at: "2026-09-28T18:00:00Z" })], error: null }];
    const detail = await getOwnerEscalationByToken("tok");
    expect(detail && "kind" in detail ? detail.taskNotCurrentReason : "missing").toBe("completed");
  });

  it("10. a historical terminal substitute_review decision stays non-actionable (and read-only by type)", async () => {
    results.staff_escalation_owner_decisions = [
      { data: [decisionRow({ review_type: "substitute_review" })], error: null },
    ];
    results.tasks = [{ data: [taskRow({ status: "done", dismissed_at: "2026-09-01T00:00:00Z" })], error: null }];
    const detail = await getOwnerEscalationByToken("tok");
    expect(detail && "kind" in detail ? [detail.reviewType, detail.taskNotCurrentReason] : null)
      .toEqual(["substitute_review", "completed"]);
  });

  it("a task the owner can no longer read is non-actionable, never guessed", async () => {
    results.staff_escalation_owner_decisions = [{ data: [decisionRow()], error: null }];
    results.tasks = [{ data: [], error: null }];
    const detail = await getOwnerEscalationByToken("tok");
    expect(detail && "kind" in detail ? [detail.taskDescription, detail.taskNotCurrentReason] : null)
      .toEqual([null, "task_unavailable"]);
  });

  it("reads the recorded choice for an answered no_response decision", async () => {
    results.staff_escalation_owner_decisions = [
      { data: [decisionRow({ status: "answered" })], error: null },
      { data: [{ owner_reply_text: "Keep waiting" }], error: null },
    ];
    results.tasks = [{ data: [taskRow()], error: null }];
    const detail = await getOwnerEscalationByToken("tok");
    expect(detail && "kind" in detail ? detail.ownerChoice : null).toBe("keep_waiting");
  });

  it("the first lookup still never selects owner_reply_text or user_id", async () => {
    results.staff_escalation_owner_decisions = [{ data: [decisionRow()], error: null }];
    results.tasks = [{ data: [taskRow()], error: null }];
    await getOwnerEscalationByToken("tok");
    const first = calls[0];
    expect(first.select).not.toMatch(/owner_reply_text|\buser_id\b/);
    expect(first.eq).toEqual([["deep_link_token", "tok"]]);
  });

  it("a staff-message-backed row still resolves to the unchanged staff detail shape", async () => {
    results.staff_escalation_owner_decisions = [{
      data: [decisionRow({
        staff_message_id: "sm-1",
        task_id: null,
        review_type: "staff_escalation",
        staff_message: {
          staff_name: "Christopher",
          inbound_text: "Can I buy red wine vinegar instead?",
          escalation_reason: null,
          received_at: "2026-07-27T00:33:23.000Z",
        },
      })],
      error: null,
    }];
    const detail = await getOwnerEscalationByToken("tok");
    expect(detail).not.toHaveProperty("kind");
    expect(detail).toMatchObject({ staffName: "Christopher", inboundText: "Can I buy red wine vinegar instead?" });
    expect(calls.map((c) => c.table)).toEqual(["staff_escalation_owner_decisions"]);
  });
});

describe("taskNotCurrentReason", () => {
  it("is null only for a pending, open, unconfirmed task", () => {
    expect(taskNotCurrentReason(taskRow() as never)).toBeNull();
    expect(taskNotCurrentReason(taskRow({ archived_at: "x" }) as never)).toBe("archived");
    expect(taskNotCurrentReason(taskRow({ dismissed_at: "x" }) as never)).toBe("dismissed");
    expect(taskNotCurrentReason(taskRow({ confirmed_at: "x" }) as never)).toBe("confirmed");
    expect(taskNotCurrentReason(taskRow({ status: "cancelled" }) as never)).toBe("not_pending");
    expect(taskNotCurrentReason(null)).toBe("task_unavailable");
  });
});
