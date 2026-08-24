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

describe("resolveAttentionGuardedMessage", () => {
  const base = {
    agentMessage: "You're clear right now. Nothing is waiting on you.",
    attentionIntentDetected: true,
    attentionToolRan: false,
    groundedResult: null as string | null,
  };

  it("passes the agent message through untouched when no attention intent was detected", () => {
    expect(
      resolveAttentionGuardedMessage({ ...base, attentionIntentDetected: false }),
    ).toBe(base.agentMessage);
  });

  it("passes the agent message through untouched when get_items_needing_attention actually ran", () => {
    expect(
      resolveAttentionGuardedMessage({ ...base, attentionToolRan: true }),
    ).toBe(base.agentMessage);
  });

  it("passes the agent message through untouched when no grounded result is available yet — never fabricates one", () => {
    expect(resolveAttentionGuardedMessage(base)).toBe(base.agentMessage);
  });

  it("substitutes the live grounded result when attention intent was detected, the tool did not run, and a fresh result is ready — reproduces the exact 2026-08-24 production failure and proves it is now corrected", () => {
    const grounded = "One note needs your attention: Check on Nimala's wedding invitation.";
    expect(
      resolveAttentionGuardedMessage({ ...base, groundedResult: grounded }),
    ).toBe(grounded);
  });

  it("never invents an item not present in the grounded result — the corrected message is exactly the tool's own text, nothing appended", () => {
    const grounded = "Nothing needs your attention right now.";
    const result = resolveAttentionGuardedMessage({ ...base, groundedResult: grounded });
    expect(result).toBe(grounded);
    expect(result).not.toContain("cat food");
  });
});
