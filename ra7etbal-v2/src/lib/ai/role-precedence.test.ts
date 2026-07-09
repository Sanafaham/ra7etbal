import { describe, expect, it } from "vitest";
import { applyRolePrecedence } from "./role-precedence";
import type { ExtractedItem } from "../../types/extraction";
import type { Person } from "../../types/person";

/**
 * Regression coverage for the Clear My Head routing bug: attaching a photo
 * caused "Ask Christopher to make this for lunch" to skip delegation
 * detection and fall back to whatever the raw model guessed (observed as
 * "parked"/Inbox in production). Root cause: Home.tsx appends
 * "\n\nAttached image:\n<description>" to the extraction text, and the
 * direct-recipient regex in role-precedence.ts used `.*$` without the
 * dotAll flag, which can never cross that inserted blank line.
 */

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: "p1",
    user_id: "u1",
    name: "Christopher",
    role: "Cook",
    phone: "+1000000000",
    notes: null,
    created_at: new Date().toISOString(),
    relationship: null,
    is_family: false,
    responsibilities: null,
    reliability_level: null,
    follow_up_level: null,
    delegation_guidance: null,
    should_not_assign: null,
    escalate_to: null,
    communication_style: null,
    whatsapp_opted_in: true,
    whatsapp_consent_at: null,
    whatsapp_consent_method: null,
    ...overrides,
  };
}

function item(overrides: Partial<ExtractedItem> = {}): ExtractedItem {
  return {
    id: "item_0",
    type: "message",
    description: "Ask Christopher to make this for lunch",
    assignedTo: null,
    dueAt: null,
    dueText: null,
    suggestedMessage: null,
    personalNote: null,
    needsPerson: true,
    needsClarification: false,
    clarificationQuestion: null,
    ...overrides,
  };
}

describe("applyRolePrecedence — direct-recipient delegation detection", () => {
  it("routes a plain 'ask X to...' instruction to delegation (no photo attached)", () => {
    const sourceText = "Ask Christopher to make this for lunch";
    const result = applyRolePrecedence([item()], [person()], sourceText);

    expect(result[0].type).toBe("delegation");
    expect(result[0].assignedTo).toBe("Christopher");
  });

  it("still routes to delegation when a photo's description is appended after a blank line", () => {
    const sourceText =
      "Ask Christopher to make this for lunch\n\nAttached image:\nA plate of grilled chicken and vegetables.";
    const result = applyRolePrecedence([item()], [person()], sourceText);

    expect(result[0].type).toBe("delegation");
    expect(result[0].assignedTo).toBe("Christopher");
  });

  it("does not pull appended image-description text into the recipient message", () => {
    const sourceText =
      "Ask Christopher to make this for lunch\n\nAttached image:\nA plate of grilled chicken and vegetables.";
    const result = applyRolePrecedence([item()], [person()], sourceText);

    expect(result[0].suggestedMessage).not.toMatch(/Attached image/i);
    expect(result[0].suggestedMessage).not.toMatch(/grilled chicken/i);
  });

  it("still suppresses 'remind me to ask X...' when a photo description is appended", () => {
    const sourceText =
      "Remind me to ask Christopher to make this for lunch\n\nAttached image:\nA plate of food.";
    const result = applyRolePrecedence(
      [item({ type: "reminder", assignedTo: "__me__" })],
      [person()],
      sourceText,
    );

    // Falls through untouched — direct-recipient correction must not fire.
    expect(result[0].type).toBe("reminder");
    expect(result[0].assignedTo).toBe("__me__");
  });

  it("keeps promoting operational role + topic to delegation regardless of photo context", () => {
    const sourceText = "Christopher should prep dinner\n\nAttached image:\nAn empty fridge.";
    const result = applyRolePrecedence(
      [item({ type: "message", assignedTo: "Christopher", description: "Christopher should prep dinner" })],
      [person()],
      sourceText,
    );

    expect(result[0].type).toBe("delegation");
  });
});
