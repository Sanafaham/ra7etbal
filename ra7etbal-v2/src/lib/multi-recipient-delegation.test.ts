import { describe, expect, it } from "vitest";
import { parseMultiRecipientDelegation } from "./multi-recipient-delegation";

describe("parseMultiRecipientDelegation", () => {
  const people = [
    { name: "Grace" },
    { name: "Christopher" },
    { name: "Nasira" },
    { name: "Ghulam" },
  ];

  it("parses explicit multi-recipient delegation shorthand into separate items", () => {
    const items = parseMultiRecipientDelegation(
      "Ask Grace to prepare the table, Christopher to prepare lunch, Nasira to arrange flowers, and Ghulam to be on standby.",
      people,
    );

    expect(items?.map((item) => [item.assignedTo, item.description])).toEqual([
      ["Grace", "prepare the table"],
      ["Christopher", "prepare lunch"],
      ["Nasira", "arrange flowers"],
      ["Ghulam", "be on standby."],
    ]);
    expect(items?.every((item) => item.type === "delegation")).toBe(true);
  });

  it("does not intercept single-recipient delegation", () => {
    expect(parseMultiRecipientDelegation("Ask Grace to prepare the table.", people)).toBeNull();
  });

  it("does not intercept ambiguous one-way messages without 'to'", () => {
    expect(parseMultiRecipientDelegation("Tell Grace dinner is at 8, Christopher lunch is ready.", people)).toBeNull();
  });

  it("parses repeated verbs in one typed image delegation without needing model extraction", () => {
    const items = parseMultiRecipientDelegation(
      "Ask Christopher to do this for snack now and tell Nasira to call me now and tell Ghulam to bring the car out",
      people,
    );

    expect(items?.map((item) => [item.assignedTo, item.description])).toEqual([
      ["Christopher", "do this for snack now"],
      ["Nasira", "call me now"],
      ["Ghulam", "bring the car out"],
    ]);
  });
});
