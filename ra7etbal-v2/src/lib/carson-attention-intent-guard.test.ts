import { describe, expect, it } from "vitest";
import {
  matchesAttentionIntent,
  matchesAttentionFollowUp,
  resolveAttentionGuardedMessage,
} from "./carson-attention-intent-guard";

describe("matchesAttentionIntent", () => {
  it("matches every general live-attention trigger phrase", () => {
    expect(matchesAttentionIntent("What needs my attention?")).toBe(true);
    expect(matchesAttentionIntent("What's pending?")).toBe(true);
    expect(matchesAttentionIntent("What am I waiting on?")).toBe(true);
    expect(matchesAttentionIntent("What's on my plate?")).toBe(true);
    expect(matchesAttentionIntent("Am I clear?")).toBe(true);
    expect(matchesAttentionIntent("What's outstanding?")).toBe(true);
  });

  it("does not match unrelated questions", () => {
    expect(matchesAttentionIntent("What's the weather today?")).toBe(false);
    expect(matchesAttentionIntent("Ask Christopher to make dinner")).toBe(false);
    expect(matchesAttentionIntent("What happened with the passport reminder?")).toBe(false);
  });
});

describe("matchesAttentionFollowUp", () => {
  it("matches only the exact bare follow-up phrasings", () => {
    expect(matchesAttentionFollowUp("What else?")).toBe(true);
    expect(matchesAttentionFollowUp("Anything else?")).toBe(true);
    expect(matchesAttentionFollowUp("Is that everything?")).toBe(true);
    expect(matchesAttentionFollowUp("What else is pending?")).toBe(true);
  });

  it("does not match an unrelated sentence that happens to contain 'else'", () => {
    expect(matchesAttentionFollowUp("What else should Christopher buy?")).toBe(false);
    expect(matchesAttentionFollowUp("Is that everything Grace needs for the party?")).toBe(false);
  });
});

describe("resolveAttentionGuardedMessage — grounded result is authoritative, never merely advisory", () => {
  const base = {
    agentMessage: "You're clear right now. Nothing is waiting on you.",
    attentionIntentDetected: true,
    groundedResult: null as string | null,
  };

  it("passes the agent message through untouched when no attention intent was detected", () => {
    expect(
      resolveAttentionGuardedMessage({ ...base, attentionIntentDetected: false }),
    ).toBe(base.agentMessage);
  });

  it("passes the agent message through untouched when no grounded result is available yet — safe failure, never fabricates one", () => {
    expect(resolveAttentionGuardedMessage(base)).toBe(base.agentMessage);
  });

  it("unrelated Carson intents are unchanged — a stale/unrelated groundedResult is never applied when attention intent was not detected", () => {
    const result = resolveAttentionGuardedMessage({
      agentMessage: "Grace has it. I'll follow up if she doesn't confirm.",
      attentionIntentDetected: false,
      groundedResult: "Nothing needs your attention right now.",
    });
    expect(result).toBe("Grace has it. I'll follow up if she doesn't confirm.");
  });

  it("substitutes the live grounded result when attention intent was detected and a fresh result is ready — reproduces the exact 2026-08-24 production failure and proves it is now corrected", () => {
    const grounded = "One note needs your attention: Check on Nimala's wedding invitation.";
    expect(
      resolveAttentionGuardedMessage({ ...base, groundedResult: grounded }),
    ).toBe(grounded);
  });

  it("closes the confirmed tool-ran-but-model-embellished gap: the tool running is no longer a reason to trust the model's reply — grounded result always wins whenever one is available, regardless of what the model composed", () => {
    // Simulates the exact 2026-08-25 production failure shape: the model's
    // own reply blends real reminder facts with a fabricated, unsupported
    // person + task the tool evidence never returned.
    const modelReplyWithFabricatedPerson =
      "You're waiting on Nasira to confirm the call request. Your reminder to charge your phone is overdue.";
    const grounded = "Your reminder to charge your phone is overdue.";
    // Note: the old implementation took an `attentionToolRan` flag and
    // unconditionally trusted agentMessage whenever it was true — this
    // exact input (a fabricated person alongside a real fact) is precisely
    // the case that flag would have let through unchanged, keeping
    // "Nasira" in the final answer. That parameter no longer exists: the
    // function now ignores whether the tool "ran" entirely.
    const result = resolveAttentionGuardedMessage({
      agentMessage: modelReplyWithFabricatedPerson,
      attentionIntentDetected: true,
      groundedResult: grounded,
    });
    expect(result).toBe(grounded);
    expect(result).not.toContain("Nasira");
  });

  it("closes the gap for a fabricated reminder/task too, not just a fabricated person", () => {
    const modelReplyWithFabricatedReminder =
      "Two reminders today: call Ahmed at 9 AM and check the laundry at 10 AM.";
    const grounded = "Nothing needs your attention right now.";
    const result = resolveAttentionGuardedMessage({
      agentMessage: modelReplyWithFabricatedReminder,
      attentionIntentDetected: true,
      groundedResult: grounded,
    });
    expect(result).toBe(grounded);
    expect(result).not.toContain("Ahmed");
    expect(result).not.toContain("laundry");
  });

  it("never invents an item not present in the grounded result — the corrected message is exactly the tool's own text, nothing appended", () => {
    const grounded = "Nothing needs your attention right now.";
    const result = resolveAttentionGuardedMessage({ ...base, groundedResult: grounded });
    expect(result).toBe(grounded);
    expect(result).not.toContain("cat food");
  });

  it("existing legitimate attention evidence still works — a genuinely accurate model reply is replaced by the byte-identical grounded text, not altered", () => {
    const grounded = "Needs your attention: renew passport (overdue).";
    const result = resolveAttentionGuardedMessage({
      agentMessage: grounded,
      attentionIntentDetected: true,
      groundedResult: grounded,
    });
    expect(result).toBe(grounded);
  });

  it("follow-up attention turns remain grounded the same way — the function has no special-cased follow-up branch, so a follow-up-triggered detection is corrected identically", () => {
    const grounded = "You also have a pending reminder for the Claude skill files check.";
    const result = resolveAttentionGuardedMessage({
      agentMessage: "You also have a pending reminder for something unrelated I'm inventing.",
      attentionIntentDetected: true, // set by the caller when matchesAttentionFollowUp fires after a grounded turn
      groundedResult: grounded,
    });
    expect(result).toBe(grounded);
  });
});
