import { describe, expect, it } from "vitest";
import { classifyTypedExecutionRequest } from "./typed-advisory-redirect";
import type { Person } from "../types/person";

function person(overrides: Partial<Person> & Pick<Person, "id" | "name" | "role">): Person {
  return {
    user_id: "user-1",
    phone: null,
    notes: null,
    created_at: "2026-07-01T00:00:00.000Z",
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
    whatsapp_consent_at: "2026-07-01T00:00:00.000Z",
    whatsapp_consent_method: "owner_confirmed",
    ...overrides,
  };
}

const TEAM: Person[] = [
  person({ id: "grace", name: "Grace", role: "House Manager" }),
  person({ id: "christopher", name: "Christopher", role: "Cook" }),
];

describe("classifyTypedExecutionRequest — typed advisory redirect (2026-07-25)", () => {
  it.each([
    ["Remind me tomorrow.", "reminder"],
    ["Please set a reminder for 5pm.", "reminder"],
    ["Add this to my calendar.", "calendar"],
    ["Put the meeting on my calendar.", "calendar"],
    ["Tell Grace.", "staff_message"],
    ["Send this to Christopher.", "staff_message"],
    ["Pay the electricity bill.", "generic_action"],
    ["Create a to-do.", "generic_action"],
    ["Book this.", "generic_action"],
    ["Assign this.", "generic_action"],
    ["Take care of it.", "generic_action"],
    ["Handle dinner tomorrow.", "generic_action"],
  ] as const)("classifies '%s' as %s and redirects to Talk to Carson", (text, expectedCategory) => {
    const result = classifyTypedExecutionRequest(text, TEAM);
    expect(result).not.toBeNull();
    expect(result?.category).toBe(expectedCategory);
    expect(result?.message).toMatch(/Talk to Carson/);
  });

  it("gives each category a distinct, brief, specific redirect — never a follow-up question", () => {
    const categories = ["Remind me tomorrow.", "Add this to my calendar.", "Tell Grace.", "Pay the bill."] as const;
    const messages = categories.map((text) => classifyTypedExecutionRequest(text, TEAM)?.message);
    expect(new Set(messages).size).toBe(messages.length);
    for (const message of messages) {
      expect(message).not.toMatch(/\?/);
    }
  });

  it("returns null for the exact protected brain-dump request — no redirect, no action assumed", () => {
    const brainDump =
      "My head is full. I need to think about improving the Ra7etBal home screen, reviewing the monthly " +
      "expenses, deciding whether to change the living-room curtains, and planning what I need for next week. " +
      "I am not asking you to do anything yet. Please organize these thoughts for me.";
    expect(classifyTypedExecutionRequest(brainDump, TEAM)).toBeNull();
  });

  it("returns null for planning and general questions", () => {
    for (const text of [
      "What's on my calendar this week?",
      "How should I think about prioritizing next week?",
      "What did you ask Christopher?",
      "Can you help me draft a message to the team?",
      "What's the weather like today?",
      "Help me plan the dinner party — what should I consider?",
    ]) {
      expect(classifyTypedExecutionRequest(text, TEAM), text).toBeNull();
    }
  });

  it("does not misfire when an action verb appears mid-sentence in advisory prose, only when it opens the message", () => {
    expect(
      classifyTypedExecutionRequest("I need to think about how to handle the tension between two designs.", TEAM),
    ).toBeNull();
    expect(
      classifyTypedExecutionRequest("Someone should really take care of the garden eventually.", TEAM),
    ).toBeNull();
  });

  it("does not classify a mixed advisory+action message that doesn't open with the action clause", () => {
    // The confirmed production mixed-request bug — the action is not the
    // very first thing in the message. This case is intentionally left to
    // the free-form model + sanitizeTypedAdvisoryReply's truthfulness guard,
    // not this pre-model classifier (see carson-direct-tool-override.test.ts).
    expect(
      classifyTypedExecutionRequest(
        "I need to make the UI of Ra7etBal better and pay the electricity bill.",
        TEAM,
      ),
    ).toBeNull();
  });

  it("returns null for empty or whitespace-only input", () => {
    expect(classifyTypedExecutionRequest("", TEAM)).toBeNull();
    expect(classifyTypedExecutionRequest("   ", TEAM)).toBeNull();
  });

  // Independent review finding (2026-07-25): a `[A-Z]` character class is
  // meaningless under the `/i` flag every other pattern in this module needs
  // — JS case-insensitive matching makes `[A-Z]` match lowercase too — so a
  // capitalization heuristic silently can't distinguish "Tell Grace." from
  // "Tell me what you think." The fix validates the addressed word against
  // the real People list instead of relying on capitalization at all.
  it("does not misclassify ordinary 'tell/ask/call/text' phrasing that doesn't address a real person", () => {
    for (const text of [
      "Tell me what you think about my week.",
      "Ask yourself why this keeps happening.",
      "Call whenever is convenient for you.",
      "Text me back with your thoughts sometime.",
    ]) {
      expect(classifyTypedExecutionRequest(text, TEAM), text).toBeNull();
    }
  });

  it("still redirects when the addressed word is a real person, case-insensitively", () => {
    expect(classifyTypedExecutionRequest("tell grace to know I'm running late.", TEAM)?.category).toBe(
      "staff_message",
    );
  });

  it("does not misclassify with no People loaded — never assumes a name without a match", () => {
    expect(classifyTypedExecutionRequest("Tell Grace.", [])).toBeNull();
  });

  // Independent review finding (2026-07-25): a bare anchored "book"/"pay"
  // verb without an object check false-positived on "Book club is..." and
  // "Pay attention to...".
  it("does not misclassify 'book'/'pay' used as a noun or idiom, not an imperative action", () => {
    expect(classifyTypedExecutionRequest("Book club is stressing me out this month.", TEAM)).toBeNull();
    expect(classifyTypedExecutionRequest("Pay attention to how stressed I have been lately.", TEAM)).toBeNull();
  });

  it("still redirects a genuine bare 'book'/'pay' imperative", () => {
    expect(classifyTypedExecutionRequest("Book this.", TEAM)?.category).toBe("generic_action");
    expect(classifyTypedExecutionRequest("Pay the internet bill.", TEAM)?.category).toBe("generic_action");
  });
});
