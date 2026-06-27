import { describe, expect, it } from "vitest";
import { applyTodoRouting } from "./todo-routing";
import type { ExtractedItem } from "../../types/extraction";

function item(overrides: Partial<ExtractedItem> = {}): ExtractedItem {
  return {
    id: "i1",
    type: "action",
    description: "Buy flowers",
    assignedTo: null,
    dueAt: null,
    dueText: null,
    suggestedMessage: null,
    personalNote: null,
    needsPerson: false,
    needsClarification: false,
    clarificationQuestion: null,
    ...overrides,
  };
}

describe("applyTodoRouting — Clear My Head To-do misrouting fix", () => {
  it("'Add buy flowers to my to-do list' (action, no due date, no delegate) → todo", () => {
    const [result] = applyTodoRouting([
      item({ type: "action", description: "Buy flowers", dueAt: null, assignedTo: null }),
    ]);
    expect(result.type).toBe("todo");
  });

  it("bare 'Add renew passport' (action, no signals) → todo", () => {
    const [result] = applyTodoRouting([
      item({ type: "action", description: "Renew passport", dueAt: null, assignedTo: "__me__" }),
    ]);
    expect(result.type).toBe("todo");
  });

  it("an errand with no due date and no delegate also routes to todo", () => {
    const [result] = applyTodoRouting([
      item({ type: "errand", description: "Buy flowers", dueAt: null, assignedTo: null }),
    ]);
    expect(result.type).toBe("todo");
  });

  it("'Remind me to buy flowers tomorrow' (reminder, has dueAt) stays reminder, untouched", () => {
    const [result] = applyTodoRouting([
      item({ type: "reminder", description: "Buy flowers", dueAt: "2026-06-28T09:00:00Z", assignedTo: "__me__" }),
    ]);
    expect(result.type).toBe("reminder");
  });

  it("an action WITH a due date stays a dated task, not a todo", () => {
    const [result] = applyTodoRouting([
      item({ type: "action", description: "Buy flowers", dueAt: "2026-06-28T09:00:00Z", assignedTo: null }),
    ]);
    expect(result.type).toBe("action");
  });

  it("'Ask Grace to buy flowers' (delegation, assignedTo=Grace) stays delegation, untouched", () => {
    const [result] = applyTodoRouting([
      item({ type: "delegation", description: "Buy flowers", dueAt: null, assignedTo: "Grace" }),
    ]);
    expect(result.type).toBe("delegation");
  });

  it("an action delegated to someone other than the user is NOT rerouted to todo", () => {
    const [result] = applyTodoRouting([
      item({ type: "action", description: "Buy flowers", dueAt: null, assignedTo: "Grace" }),
    ]);
    expect(result.type).toBe("action");
  });

  it("message/decision/followup/parked types are never touched", () => {
    const types: ExtractedItem["type"][] = ["message", "decision", "followup", "parked"];
    for (const type of types) {
      const [result] = applyTodoRouting([item({ type, dueAt: null, assignedTo: null })]);
      expect(result.type).toBe(type);
    }
  });

  it("preserves all other item fields unchanged when rerouting to todo", () => {
    const original = item({
      type: "action",
      description: "Buy flowers",
      dueAt: null,
      assignedTo: null,
      personalNote: "for the anniversary",
    });
    const [result] = applyTodoRouting([original]);
    expect(result).toEqual({ ...original, type: "todo" });
  });

  it("processes a mixed batch independently per item", () => {
    const results = applyTodoRouting([
      item({ id: "a", type: "action", dueAt: null, assignedTo: null }),
      item({ id: "b", type: "reminder", dueAt: "2026-06-28T09:00:00Z", assignedTo: "__me__" }),
      item({ id: "c", type: "delegation", dueAt: null, assignedTo: "Grace" }),
    ]);
    expect(results.find((r) => r.id === "a")?.type).toBe("todo");
    expect(results.find((r) => r.id === "b")?.type).toBe("reminder");
    expect(results.find((r) => r.id === "c")?.type).toBe("delegation");
  });
});
