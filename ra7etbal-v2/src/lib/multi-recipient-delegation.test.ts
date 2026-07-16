import { describe, expect, it } from "vitest";
import { countKnownRecipientsMentioned, parseMultiRecipientDelegation } from "./multi-recipient-delegation";

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
});

describe("countKnownRecipientsMentioned", () => {
  const people = [
    { name: "Grace" },
    { name: "Christopher" },
    { name: "Nasira" },
    { name: "Ghulam" },
  ];

  it("finds two known recipients named in one instruction", () => {
    const found = countKnownRecipientsMentioned(
      "Tell Grace X and Christopher Y.",
      people,
    );
    expect(found.sort()).toEqual(["Christopher", "Grace"]);
  });

  it("finds three known recipients named in one instruction", () => {
    const found = countKnownRecipientsMentioned(
      "Ask Grace to call me, Christopher to prepare lunch, and Ghulam guests arrive at 4.",
      people,
    );
    expect(found.sort()).toEqual(["Christopher", "Ghulam", "Grace"]);
  });

  it("finds exactly one known recipient for an ordinary single-person instruction", () => {
    const found = countKnownRecipientsMentioned("Ask Christopher to make these.", people);
    expect(found).toEqual(["Christopher"]);
  });

  it("does not match a name that is a substring of another word", () => {
    const found = countKnownRecipientsMentioned("Gracefully ask Christopher to help.", people);
    expect(found).toEqual(["Christopher"]);
  });

  it("returns an empty list when no known person is named", () => {
    expect(countKnownRecipientsMentioned("Remind me tomorrow to buy flowers.", people)).toEqual([]);
  });

  it("deduplicates a name mentioned more than once", () => {
    const found = countKnownRecipientsMentioned("Ask Grace to call Grace's florist.", people);
    expect(found).toEqual(["Grace"]);
  });
});
