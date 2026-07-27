import { describe, expect, it } from "vitest";
import { filterVisibleStaffEscalations } from "./needs-you-staff-escalations";
import type { OpenStaffEscalation } from "../types/staff-message";

/**
 * Root-cause regression suite (independent re-review of PR #90):
 * task_id is not a reliable shared-decision identifier. A task can be
 * shown in Needs You for a reason wholly unrelated to Phase B while a
 * staff escalation on that same task represents a genuinely separate
 * owner decision — both must remain visible. No heuristic (text,
 * category, timing, or task_id alone) is used as a substitute for a
 * real shared-decision identifier, because none exists in the current
 * schema — so no deduplication happens here at all.
 */
function escalation(overrides: Partial<OpenStaffEscalation> = {}): OpenStaffEscalation {
  return {
    id: "staff-msg-1",
    staffName: "Christopher",
    inboundText: "Can I buy red wine vinegar instead?",
    escalationReason: "Needs approval.",
    receivedAt: "2026-07-27T00:33:23.000Z",
    taskId: null,
    decisionId: "decision-1",
    deepLinkToken: "162865ee-4ad6-4b73-b6c4-ae4945a2f545",
    ...overrides,
  };
}

describe("filterVisibleStaffEscalations", () => {
  it("1. a task shown for quality review and a separate staff escalation sharing its task_id both remain visible", () => {
    // task-quality-review appears in Needs You via quality_review_status
    // ('uncertain'/'substitute_review') — a proof-review decision,
    // unrelated to the staff escalation below.
    const result = filterVisibleStaffEscalations(
      [escalation({ id: "esc-quality", taskId: "task-quality-review" })],
      ["task-quality-review"],
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("esc-quality");
  });

  it("2. a cancelled task and a separate staff escalation sharing its task_id both remain visible", () => {
    const result = filterVisibleStaffEscalations(
      [escalation({ id: "esc-cancelled", taskId: "task-cancelled" })],
      ["task-cancelled"],
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("esc-cancelled");
  });

  it("3. a self-owned decision task and a separate staff escalation sharing its task_id both remain visible", () => {
    const result = filterVisibleStaffEscalations(
      [escalation({ id: "esc-decision", taskId: "task-self-owned-decision" })],
      ["task-self-owned-decision"],
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("esc-decision");
  });

  it("4. two distinct staff escalation rows linked to the same task both remain visible", () => {
    const result = filterVisibleStaffEscalations(
      [
        escalation({ id: "esc-a", taskId: "task-shared", decisionId: "decision-a" }),
        escalation({ id: "esc-b", taskId: "task-shared", decisionId: "decision-b" }),
      ],
      ["task-shared"],
    );
    expect(result.map((e) => e.id)).toEqual(["esc-a", "esc-b"]);
  });

  it("5. escalations without a task_id remain visible regardless of the shown task set", () => {
    const result = filterVisibleStaffEscalations(
      [escalation({ taskId: null })],
      ["task-1", "task-2"],
    );
    expect(result).toHaveLength(1);
  });

  it("6. never hides an escalation merely because its task_id appears in the shown set — inclusion/exclusion is otherwise unchanged: nothing here ever removes a caller-supplied escalation", () => {
    const result = filterVisibleStaffEscalations(
      [
        escalation({ id: "esc-linked", taskId: "task-1" }),
        escalation({ id: "esc-taskless", taskId: null }),
        escalation({ id: "esc-unrelated-task", taskId: "task-9" }),
      ],
      ["task-1", "task-9"],
    );
    expect(result.map((e) => e.id)).toEqual(["esc-linked", "esc-taskless", "esc-unrelated-task"]);
  });

  it("returns an empty array unchanged when there are no open escalations", () => {
    expect(filterVisibleStaffEscalations([], ["task-1"])).toEqual([]);
  });

  it("returns the exact same escalations regardless of what shownTaskIds contains", () => {
    const input = [escalation({ id: "esc-x", taskId: "task-x" })];
    expect(filterVisibleStaffEscalations(input, [])).toEqual(input);
    expect(filterVisibleStaffEscalations(input, ["task-x"])).toEqual(input);
    expect(filterVisibleStaffEscalations(input, ["task-x", "task-y", "task-z"])).toEqual(input);
  });
});
