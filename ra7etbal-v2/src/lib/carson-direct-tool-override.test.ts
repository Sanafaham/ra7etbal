import { describe, expect, it } from "vitest";
import {
  detectsUnconfirmedNoteSaveClaim,
  resolveCarsonDisplayMessage,
  resolveSanitizedCarsonDisplayMessage,
  type DirectToolSuccessResult,
} from "./carson-direct-tool-override";

const NOW = Date.parse("2026-06-28T00:02:20.000Z");

function successResult(overrides: Partial<DirectToolSuccessResult> = {}): DirectToolSuccessResult {
  return {
    toolName: "create_todo",
    resultText: "Added to your to-do list.",
    at: "2026-06-28T00:02:18.943Z",
    ...overrides,
  };
}

function failureResult(overrides: Partial<DirectToolSuccessResult> = {}): DirectToolSuccessResult {
  return {
    toolName: "create_reminder",
    resultText: "I could not create the recurring reminder.",
    at: "2026-06-28T00:02:18.943Z",
    outcome: "failure",
    ...overrides,
  };
}

describe("resolveCarsonDisplayMessage", () => {
  it("overrides a contradictory failure message with the successful create_todo result", () => {
    const result = resolveCarsonDisplayMessage(
      "I wasn't able to save that. Please try again.",
      successResult(),
      NOW,
    );
    expect(result).toBe("Added to your to-do list.");
  });

  it("overrides a contradictory failure message with the successful complete_todo result", () => {
    const result = resolveCarsonDisplayMessage(
      "I couldn't complete that. Please try again.",
      successResult({ toolName: "complete_todo", resultText: "Done. I've marked that complete." }),
      NOW,
    );
    expect(result).toBe("Done. I've marked that complete.");
  });

  it("overrides a contradictory inability message with the successful control_task result", () => {
    const result = resolveCarsonDisplayMessage(
      "I don't have the ability to directly close a delegation from Rahet Bal.",
      successResult({ toolName: "control_task", resultText: "Done. I marked that task done." }),
      NOW,
    );

    expect(result).toBe("Done. I marked that task done.");
  });

  it("overrides an unrelated agent reply with the successful create_reminder result", () => {
    const result = resolveCarsonDisplayMessage(
      "That sounds like a question about insurance providers.",
      successResult({
        toolName: "create_reminder",
        resultText: "I'll remind you tomorrow at 10:00 AM.",
      }),
      NOW,
    );

    expect(result).toBe("I'll remind you tomorrow at 10:00 AM.");
  });

  it("overrides a generic knowledge answer with the successful create_reminder result", () => {
    const result = resolveCarsonDisplayMessage(
      "As for your question — insurance companies provide financial protection against losses.",
      successResult({
        toolName: "create_reminder",
        resultText: "I'll remind you tomorrow at 10:00 AM.",
      }),
      NOW,
    );

    expect(result).toBe("I'll remind you tomorrow at 10:00 AM.");
  });

  it("overrides a contradictory reminder failure with the successful create_reminder result", () => {
    const result = resolveCarsonDisplayMessage(
      "I wasn't able to create that reminder. Please try again.",
      successResult({
        toolName: "create_reminder",
        resultText: "I'll remind you tomorrow at 10:00 AM.",
      }),
      NOW,
    );

    expect(result).toBe("I'll remind you tomorrow at 10:00 AM.");
  });

  it("does not override a normal, non-contradictory agent message", () => {
    const result = resolveCarsonDisplayMessage(
      "Anything else I can help with?",
      successResult(),
      NOW,
    );
    expect(result).toBe("Anything else I can help with?");
  });

  it("does not override a normal reminder confirmation", () => {
    const result = resolveCarsonDisplayMessage(
      "Reminder created for tomorrow at 10:00 AM.",
      successResult({
        toolName: "create_reminder",
        resultText: "I'll remind you tomorrow at 10:00 AM.",
      }),
      NOW,
    );

    expect(result).toBe("Reminder created for tomorrow at 10:00 AM.");
  });

  it("does not override when there is no recent successful tool result", () => {
    const result = resolveCarsonDisplayMessage(
      "I wasn't able to save that. Please try again.",
      null,
      NOW,
    );
    expect(result).toBe("I wasn't able to save that. Please try again.");
  });

  it("does not override for tools outside the allow-list", () => {
    const result = resolveCarsonDisplayMessage(
      "I wasn't able to save that. Please try again.",
      successResult({ toolName: "save_city", resultText: "Got it. I'll use Dubai for weather." }),
      NOW,
    );
    expect(result).toBe("I wasn't able to save that. Please try again.");
  });

  // save_note joined the allow-list (2026-07-14 production fix): a real
  // save_note success must be able to correct a contradictory agent reply
  // the same way create_todo/create_reminder/etc. already do.
  it("overrides a contradictory failure message with the successful save_note result", () => {
    const result = resolveCarsonDisplayMessage(
      "I wasn't able to save that. Please try again.",
      successResult({ toolName: "save_note", resultText: "Saved." }),
      NOW,
    );
    expect(result).toBe("Saved.");
  });

  it("lets execute_instruction partial-success coverage override a fake all-done agent reply", () => {
    const partial =
      "I handled Grace's request. I may not have sent Ghulam's request: have the cars ready. Please confirm if you want me to send it.";

    const result = resolveCarsonDisplayMessage(
      "Done, I handled Grace and Ghulam.",
      successResult({
        toolName: "execute_instruction",
        resultText: partial,
        inputSummary: {
          kind: "delegation_coverage_partial_success",
          missing: [{ personName: "Ghulam", actionText: "have the cars ready" }],
        },
      }),
      NOW,
    );

    expect(result).toBe(partial);
  });

  it("does not override execute_instruction replies without a partial-success marker", () => {
    const result = resolveCarsonDisplayMessage(
      "Done, I handled it.",
      successResult({
        toolName: "execute_instruction",
        resultText: "I may not have sent Ghulam's request.",
        inputSummary: { kind: "normal_execute_instruction_success" },
      }),
      NOW,
    );

    expect(result).toBe("Done, I handled it.");
  });

  it("overrides a contradictory failure message with a successful guest-plan proposal", () => {
    const result = resolveCarsonDisplayMessage(
      "I wasn't able to process that. Please try again.",
      successResult({
        toolName: "execute_instruction",
        resultText: "I can split this between Christopher, Nasira, and Bahan. Should I send it?",
        inputSummary: {
          kind: "guest_plan_proposal",
          instruction: "I have afternoon tea at home tomorrow",
        },
      }),
      NOW,
    );

    expect(result).toBe("I can split this between Christopher, Nasira, and Bahan. Should I send it?");
  });

  it("does not override once the success result is outside the time window", () => {
    const result = resolveCarsonDisplayMessage(
      "I wasn't able to save that. Please try again.",
      successResult({ at: "2026-06-28T00:01:00.000Z" }),
      NOW,
    );
    expect(result).toBe("I wasn't able to save that. Please try again.");
  });

  it.each([
    "I wasn't able to save that.",
    "I wasn’t able to do that.",
    "I couldn't complete that.",
    "Please try again.",
    "There seems to be a technical issue.",
    "Please contact support.",
  ])("recognizes failure language: '%s'", (failureMessage) => {
    expect(resolveCarsonDisplayMessage(failureMessage, successResult(), NOW)).toBe(
      "Added to your to-do list.",
    );
  });
});

// Regression: a production recurring-reminder request was rejected with a
// verified tool failure (HTTP 400 from /api/automations), yet Carson still
// spoke a fabricated success ("I've set a nightly reminder..."). The
// override system previously only corrected the opposite direction (tool
// succeeded, agent wrongly sounds like it failed) — these tests lock in the
// new symmetric direction: tool failed, agent wrongly sounds successful.
describe("resolveCarsonDisplayMessage — tool-failure truthfulness", () => {
  it("overrides a fabricated success reply with the verified create_reminder failure", () => {
    const result = resolveCarsonDisplayMessage(
      "I've set a nightly reminder at 9:10 PM to check on Google Console — starting tonight.",
      failureResult({ resultText: "I could not create the recurring reminder." }),
      NOW,
    );
    expect(result).toBe("I could not create the recurring reminder.");
  });

  it("overrides a fabricated success reply with the verified create_automation failure", () => {
    const result = resolveCarsonDisplayMessage(
      "I've got that running. First check is tonight at 9:10 PM.",
      failureResult({
        toolName: "create_automation",
        resultText: "I could not create that automation. Recurring WhatsApp automations are currently disabled.",
      }),
      NOW,
    );
    expect(result).toBe(
      "I could not create that automation. Recurring WhatsApp automations are currently disabled.",
    );
  });

  it("does not override an agent reply that already truthfully reads as a failure", () => {
    // Carson failure speech after a real tool failure must remain as-is —
    // it's already truthful, forcing the canned tool text isn't necessary.
    const result = resolveCarsonDisplayMessage(
      "I wasn't able to set that up. Please try again.",
      failureResult(),
      NOW,
    );
    expect(result).toBe("I wasn't able to set that up. Please try again.");
  });

  it("does not override for tools outside the allow-list, even on a recorded failure", () => {
    const result = resolveCarsonDisplayMessage(
      "Done, that's all set.",
      failureResult({ toolName: "save_city", resultText: "I couldn't save the city." }),
      NOW,
    );
    expect(result).toBe("Done, that's all set.");
  });

  // Production bug (2026-07-13): Carson said "Saved." after a verified
  // save_note failure (or after no save_note call at all) — this locks in
  // the failure-truthfulness half of the fix for save_note specifically.
  it("overrides a fabricated success reply with a verified save_note failure", () => {
    const result = resolveCarsonDisplayMessage(
      "Done, that's all set.",
      failureResult({ toolName: "save_note", resultText: "Could not save the note." }),
      NOW,
    );
    expect(result).toBe("Could not save the note.");
  });

  // CodeRabbit finding: "doesn't sound like failure" was too broad a trigger
  // for the failure-override — a neutral follow-up unrelated to the failed
  // action also doesn't sound like failure, but overriding it with stale
  // failure text would itself be an untruthful, out-of-context correction.
  it("does not override a neutral follow-up message that isn't claiming success", () => {
    const result = resolveCarsonDisplayMessage(
      "What would you like me to do next?",
      failureResult(),
      NOW,
    );
    expect(result).toBe("What would you like me to do next?");
  });

  it("does not override a neutral acknowledgement that isn't claiming success", () => {
    const result = resolveCarsonDisplayMessage(
      "Anything else I can help with?",
      failureResult(),
      NOW,
    );
    expect(result).toBe("Anything else I can help with?");
  });

  it("does not override a failure once it is outside the time window (stale result does not leak into a later reply)", () => {
    const result = resolveCarsonDisplayMessage(
      "I've set that reminder for you.",
      failureResult({ at: "2026-06-28T00:01:00.000Z" }),
      NOW,
    );
    expect(result).toBe("I've set that reminder for you.");
  });

  it("a successful create_automation result still overrides a contradictory failure-sounding agent reply (allow-list coverage)", () => {
    const result = resolveCarsonDisplayMessage(
      "I wasn't able to create that automation.",
      successResult({
        toolName: "create_automation",
        resultText: "I've got that running for Grace. First check is tomorrow at 9:00 AM.",
      }),
      NOW,
    );
    expect(result).toBe("I've got that running for Grace. First check is tomorrow at 9:00 AM.");
  });
});

describe("resolveSanitizedCarsonDisplayMessage", () => {
  it("sanitizes an agent message starting with one moment", () => {
    const result = resolveSanitizedCarsonDisplayMessage({
      agentMessage: "One moment. Added to your to-do list.",
      lastSuccess: null,
      now: NOW,
    });

    expect(result).toBe("Added to your to-do list.");
  });

  it("sanitizes an agent message where one moment is the whole reply", () => {
    const result = resolveSanitizedCarsonDisplayMessage({
      agentMessage: "One moment",
      lastSuccess: null,
      now: NOW,
    });

    expect(result).toBe("");
  });

  it("does not let a direct-tool success override bypass Carson reply sanitation", () => {
    const result = resolveSanitizedCarsonDisplayMessage({
      agentMessage: "I wasn't able to save that. Please try again.",
      lastSuccess: successResult({ resultText: "One moment. Added to your to-do list." }),
      now: NOW,
    });

    expect(result).toBe("Added to your to-do list.");
  });

  it("sanitizes the successful create_reminder override before display", () => {
    const result = resolveSanitizedCarsonDisplayMessage({
      agentMessage: "As for your question — insurance companies provide financial protection.",
      lastSuccess: successResult({
        toolName: "create_reminder",
        resultText: "One moment. I'll remind you tomorrow at 10:00 AM.",
      }),
      now: NOW,
    });

    expect(result).toBe("I'll remind you tomorrow at 10:00 AM.");
  });

  it("overrides Carson failure wording with send_delegation success result", () => {
    const result = resolveSanitizedCarsonDisplayMessage({
      agentMessage: "I wasn't able to send that. Please try again.",
      lastSuccess: successResult({
        toolName: "send_delegation",
        // sanitizeCarsonReplyText strips the "Done." filler prefix — expected.
        resultText: "Done. I asked Christopher to make it for lunch.",
        at: new Date(NOW).toISOString(),
      }),
      now: NOW,
    });
    // "Done." stripped by sanitizeCarsonReplyText; the rest of the success text is shown.
    expect(result).toBe("I asked Christopher to make it for lunch.");
  });

  it("overrides Carson failure wording with execute_instruction delegation success", () => {
    const result = resolveSanitizedCarsonDisplayMessage({
      agentMessage: "I couldn't complete that.",
      lastSuccess: successResult({
        toolName: "execute_instruction",
        resultText: "Christopher has it.",
        at: new Date(NOW).toISOString(),
        inputSummary: { kind: "delegation", instruction: "ask Christopher to make these" },
      }),
      now: NOW,
    });
    expect(result).toBe("Christopher has it.");
  });

  it("keeps social acknowledgement fallback natural when the agent reply is only filler", () => {
    const result = resolveSanitizedCarsonDisplayMessage({
      agentMessage: "One moment.",
      previousUserMessage: "thank you",
      lastSuccess: null,
      now: NOW,
    });

    expect(result).toBe("Anytime.");
  });
});

// Production bug (2026-07-13): the user said "Note that I would like to
// make call Carson feature in the app at a later stage", Carson replied
// "Saved.", and no carson_notes row was ever created — no save_note tool
// call succeeded (or ran at all) that turn. The override system previously
// only corrected a reply that contradicted a tool call that DID run; it did
// nothing when no tool ran at all for an explicit note request. These tests
// lock in the new fabricated-success guard.
//
// noteSaveOutcome is turn-scoped by the CALLER (reset to null at every new
// voice/typed turn boundary — see noteSaveOutcomeRef in
// ElevenLabsAgentWidget.tsx), not by this function. A CodeRabbit finding on
// the first version of this fix pointed out that reusing the shared,
// time-windowed lastDirectToolSuccessRef here would let an unrelated tool's
// (or an earlier turn's) success suppress this guard for a later turn's
// note request within the same 15s window — this function intentionally
// takes only the dedicated, turn-scoped outcome instead.
function noteSaveSuccess(overrides: Partial<{ resultText: string; at: string }> = {}) {
  return { outcome: "success" as const, resultText: "Saved.", at: new Date(NOW).toISOString(), ...overrides };
}

function noteSaveFailure(overrides: Partial<{ resultText: string; at: string }> = {}) {
  return { outcome: "failure" as const, resultText: "Could not save the note.", at: new Date(NOW).toISOString(), ...overrides };
}

describe("detectsUnconfirmedNoteSaveClaim", () => {
  it("flags the exact reported production scenario: explicit note request, 'Saved.' reply, no tool ran", () => {
    expect(
      detectsUnconfirmedNoteSaveClaim(
        "Saved.",
        "Note that I would like to make call Carson feature in the app at a later stage",
        null,
      ),
    ).toBe(true);
  });

  it("does not flag when a real save_note success backs up the claim this turn", () => {
    expect(
      detectsUnconfirmedNoteSaveClaim(
        "Saved.",
        "Note that I want to build a flight simulator",
        noteSaveSuccess(),
      ),
    ).toBe(false);
  });

  it("still flags when a verified save_note failure is on record this turn — the reply is fabricated either way", () => {
    expect(
      detectsUnconfirmedNoteSaveClaim(
        "Saved.",
        "Note that I want to build a flight simulator",
        noteSaveFailure(),
      ),
    ).toBe(true);
  });

  it("does not flag when the previous message isn't an explicit note request", () => {
    expect(
      detectsUnconfirmedNoteSaveClaim("Saved.", "What's on my to-do list?", null),
    ).toBe(false);
  });

  it("does not flag when the agent's reply doesn't claim a save", () => {
    expect(
      detectsUnconfirmedNoteSaveClaim(
        "Got it, anything else?",
        "Note that I want to build a flight simulator",
        null,
      ),
    ).toBe(false);
  });
});

describe("resolveSanitizedCarsonDisplayMessage — unconfirmed note save", () => {
  it("replaces a fabricated 'Saved.' reply with a truthful retry message", () => {
    const result = resolveSanitizedCarsonDisplayMessage({
      agentMessage: "Saved.",
      previousUserMessage:
        "Note that I would like to make call Carson feature in the app at a later stage",
      lastSuccess: null,
      now: NOW,
    });
    expect(result).toBe(
      "I couldn't confirm that was saved. Please say it again so I can save it properly.",
    );
  });

  it("leaves a genuine save_note success reply untouched", () => {
    const result = resolveSanitizedCarsonDisplayMessage({
      agentMessage: "Saved.",
      previousUserMessage: "Note that I want to build a flight simulator",
      lastSuccess: successResult({
        toolName: "save_note",
        resultText: "Saved.",
        at: new Date(NOW).toISOString(),
      }),
      noteSaveOutcome: noteSaveSuccess(),
      now: NOW,
    });
    expect(result).toBe("Saved.");
  });
});
