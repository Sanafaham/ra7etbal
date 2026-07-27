import { describe, expect, it } from "vitest";
import { filterVisibleStaffEscalations } from "./needs-you-staff-escalations";
import type { OpenStaffEscalation } from "../types/staff-message";

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
  it("keeps a taskless escalation regardless of shown task ids", () => {
    const result = filterVisibleStaffEscalations([escalation({ taskId: null })], ["task-1", "task-2"]);
    expect(result).toHaveLength(1);
  });

  it("5. drops an escalation whose linked task is already shown elsewhere, preventing a duplicate card", () => {
    const result = filterVisibleStaffEscalations(
      [escalation({ taskId: "task-1" })],
      ["task-1", "task-2"],
    );
    expect(result).toHaveLength(0);
  });

  it("keeps a task-linked escalation whose task is not currently shown", () => {
    const result = filterVisibleStaffEscalations(
      [escalation({ taskId: "task-9" })],
      ["task-1", "task-2"],
    );
    expect(result).toHaveLength(1);
  });

  it("handles a mix of duplicate and non-duplicate escalations correctly", () => {
    const result = filterVisibleStaffEscalations(
      [
        escalation({ id: "a", taskId: "task-1" }), // duplicate — dropped
        escalation({ id: "b", taskId: null }), // taskless — kept
        escalation({ id: "c", taskId: "task-9" }), // not shown elsewhere — kept
      ],
      ["task-1"],
    );
    expect(result.map((e) => e.id)).toEqual(["b", "c"]);
  });

  it("returns an empty array unchanged when no escalations are open", () => {
    expect(filterVisibleStaffEscalations([], ["task-1"])).toEqual([]);
  });
});
