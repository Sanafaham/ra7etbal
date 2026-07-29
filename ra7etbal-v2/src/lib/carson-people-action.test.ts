import { describe, expect, it } from "vitest";
import { resolveCarsonPeopleAction, type CarsonPeopleActionEnvelope } from "./carson-people-action";

function envelope(overrides: Partial<CarsonPeopleActionEnvelope> = {}): CarsonPeopleActionEnvelope {
  return {
    intendedOutcome: "test",
    actionType: "interpersonal_communication",
    recipient: "Christopher",
    content: "yes if he can come tomorrow",
    replyExpected: true,
    trackedCompletionExpected: false,
    followUpOrEscalationExpected: false,
    actualWorkRequired: false,
    ...overrides,
  };
}

// Confirmed production incidents (PR #110, PR #122): this exact phrase was
// twice misrouted by a raw-text regex classifier requiring "to" within one
// word of the name. Under the new architecture, the model no longer picks
// the executable tool at all — it describes the outcome via these
// structured fields, and this is the permanent regression test proving the
// new routing authorizes it directly, with zero raw-text involvement.
describe("resolveCarsonPeopleAction — communication", () => {
  it("authorizes 'Ask Christopher to reply yes if he can come tomorrow.' as direct communication", () => {
    const decision = resolveCarsonPeopleAction(envelope());
    expect(decision).toEqual({
      status: "authorized",
      tool: "send_direct_whatsapp_message",
      params: { recipient_name: "Christopher", message: "yes if he can come tomorrow" },
    });
  });

  // The exact example the user corrected: this must NOT clarify just
  // because "confirm" is present. The model's own evidence fields (all
  // false — no tracked completion, no follow-up, no operational work)
  // are what authorize it directly, not a word check.
  it("authorizes 'I need Grace to confirm the room.' directly, without asking for clarification", () => {
    const decision = resolveCarsonPeopleAction(
      envelope({
        intendedOutcome: "Grace should confirm the room is ready",
        recipient: "Grace",
        content: "please confirm the room is ready",
        replyExpected: true,
      }),
    );
    expect(decision.status).toBe("authorized");
    if (decision.status === "authorized") {
      expect(decision.tool).toBe("send_direct_whatsapp_message");
    }
  });

  it("authorizes 'Ask Grace to confirm whether she can come.' as communication", () => {
    const decision = resolveCarsonPeopleAction(
      envelope({ recipient: "Grace", content: "confirm whether she can come" }),
    );
    expect(decision).toMatchObject({ status: "authorized", tool: "send_direct_whatsapp_message" });
  });
});

describe("resolveCarsonPeopleAction — delegation", () => {
  it("authorizes 'Tell Christopher to clean the kitchen.' as tracked delegation", () => {
    const decision = resolveCarsonPeopleAction(
      envelope({
        actionType: "tracked_delegation",
        recipient: "Christopher",
        content: "clean the kitchen",
        replyExpected: false,
        trackedCompletionExpected: true,
        actualWorkRequired: true,
      }),
    );
    expect(decision).toEqual({
      status: "authorized",
      tool: "send_delegation",
      params: { name: "Christopher", task: "clean the kitchen" },
    });
  });

  // The same word ("confirm") that authorized communication above must
  // route to delegation here — the distinction comes entirely from the
  // structured evidence fields, never from the word itself.
  it("authorizes 'Have Grace make sure the room is ready by noon, confirm completion, and keep following up until it is done.' as tracked delegation", () => {
    const decision = resolveCarsonPeopleAction(
      envelope({
        actionType: "tracked_delegation",
        recipient: "Grace",
        content: "make sure the room is ready by noon and confirm completion",
        replyExpected: false,
        trackedCompletionExpected: true,
        followUpOrEscalationExpected: true,
        actualWorkRequired: true,
      }),
    );
    expect(decision).toMatchObject({ status: "authorized", tool: "send_delegation" });
  });

  it("authorizes 'The kitchen still needs cleaning, have Christopher handle it.' as tracked delegation", () => {
    const decision = resolveCarsonPeopleAction(
      envelope({
        actionType: "tracked_delegation",
        recipient: "Christopher",
        content: "clean the kitchen",
        trackedCompletionExpected: true,
        actualWorkRequired: true,
      }),
    );
    expect(decision).toMatchObject({ status: "authorized", tool: "send_delegation" });
  });
});

describe("resolveCarsonPeopleAction — missing information", () => {
  it("asks who, when no recipient is present", () => {
    const decision = resolveCarsonPeopleAction(envelope({ recipient: "" }));
    expect(decision).toEqual({
      status: "clarify",
      question: "Who should this go to?",
      reason: "missing_recipient",
    });
  });

  it("asks what to say, when content is missing for a communication request", () => {
    const decision = resolveCarsonPeopleAction(envelope({ content: "" }));
    expect(decision.status).toBe("clarify");
    if (decision.status === "clarify") {
      expect(decision.question).toContain("tell Christopher");
      expect(decision.reason).toBe("missing_content");
    }
  });

  it("asks what the person should do, when content is missing for a delegation request", () => {
    const decision = resolveCarsonPeopleAction(
      envelope({ actionType: "tracked_delegation", content: "", trackedCompletionExpected: true, actualWorkRequired: true }),
    );
    expect(decision.status).toBe("clarify");
    if (decision.status === "clarify") {
      expect(decision.question).toBe("What should Christopher do?");
    }
  });
});

describe("resolveCarsonPeopleAction — genuine ambiguity, never a keyword rule", () => {
  it("clarifies when the model itself flags ambiguity, regardless of otherwise-coherent fields", () => {
    const decision = resolveCarsonPeopleAction(
      envelope({ ambiguityReason: "unclear whether owner wants this tracked" }),
    );
    expect(decision.status).toBe("clarify");
    if (decision.status === "clarify") {
      expect(decision.reason).toBe("unclear whether owner wants this tracked");
    }
  });

  it("clarifies when actionType and the evidence booleans disagree, instead of silently picking a side", () => {
    // actionType claims communication, but the model also set
    // trackedCompletionExpected — an internally inconsistent envelope.
    const decision = resolveCarsonPeopleAction(
      envelope({ actionType: "interpersonal_communication", trackedCompletionExpected: true }),
    );
    expect(decision).toMatchObject({ status: "clarify", reason: "actionType_evidence_mismatch" });
  });

  it("clarifies when actionType claims delegation but no evidence booleans support tracked work", () => {
    const decision = resolveCarsonPeopleAction(
      envelope({
        actionType: "tracked_delegation",
        trackedCompletionExpected: false,
        followUpOrEscalationExpected: false,
        actualWorkRequired: false,
      }),
    );
    expect(decision).toMatchObject({ status: "clarify", reason: "actionType_evidence_mismatch" });
  });
});
