import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(__dirname, "ElevenLabsAgentWidget.tsx"),
  "utf-8",
);

// 2026-08-28: a 4th reset site was added deliberately — the Second Brain
// stateful reasoning admission block resets both refs (plus its own two
// conversation-state refs) when the server returns a valid not_attention
// decision, ending the active attention context immediately rather than
// waiting for session teardown. See
// ElevenLabsAgentWidget.typed-attention-reasoning.test.ts.
const RESET_SITE_COUNT = 4;

/**
 * 2026-08-25 production investigation, follow-up-turn fix: a failed-to-ground
 * first attention turn used to silently disable grounding for its own
 * follow-up turn too, because matchesAttentionFollowUp's gate
 * (lastAttentionTurnWasGroundedRef) required the FIRST turn to have
 * successfully grounded. lastTurnWasAttentionIntentRef fixes this by
 * tracking "was the prior turn attention-intent at all" independent of
 * whether it grounded, so a follow-up always gets its own fresh attempt.
 */
describe("ElevenLabsAgentWidget — attention follow-up grounding independent of prior-turn success", () => {
  it("declares lastTurnWasAttentionIntentRef alongside lastAttentionTurnWasGroundedRef", () => {
    expect(SOURCE).toContain("const lastTurnWasAttentionIntentRef = useRef(false);");
  });

  it("gates isAttentionFollowUpTurn on lastTurnWasAttentionIntentRef, not on grounding success", () => {
    // P3 Step 3 / S3 (2026-10-10): voice follow-ups are recognised by
    // beginVoiceAttentionTurn, gated on the previous turn's own outcome
    // (recognised, or a complete read reached Carson), likewise independent
    // of whether that turn grounded. Typed user messages return before it.
    const GUARD = readFileSync(join(__dirname, "../../lib/carson-attention-intent-guard.ts"), "utf-8");
    expect(GUARD).toContain("const ownOutcome = state.recognised || state.readOk;");
    expect(GUARD).not.toContain("lastAttentionTurnWasGrounded");
    expect(SOURCE.indexOf('if (role === "user" && requestedChannel === "text") {')).toBeLessThan(
      SOURCE.indexOf("voiceAttentionChainRef.current = beginVoiceAttentionTurn("),
    );
    // The old, fixed gate must not remain as the follow-up condition.
    expect(SOURCE).not.toContain(
      "matchesAttentionFollowUp(message) && lastAttentionTurnWasGroundedRef.current",
    );
    expect(SOURCE).not.toContain("lastAttentionTurnWasGroundedRef.current\n              ? resolveVoiceAttentionFollowUp");
  });

  it("sets lastTurnWasAttentionIntentRef unconditionally from attentionIntentForCurrentTranscriptRef — not gated on attentionGuardResultRef being non-null", () => {
    expect(SOURCE).toContain(
      "lastTurnWasAttentionIntentRef.current = attentionIntentForCurrentTranscriptRef.current;",
    );
  });

  it("resets lastTurnWasAttentionIntentRef at every reset site alongside lastAttentionTurnWasGroundedRef (teardown, disconnect, error)", () => {
    const groundedResets = SOURCE.split("lastAttentionTurnWasGroundedRef.current = false;").length - 1;
    const intentResets = SOURCE.split("lastTurnWasAttentionIntentRef.current = false;").length - 1;
    expect(groundedResets).toBe(RESET_SITE_COUNT);
    expect(intentResets).toBe(RESET_SITE_COUNT);
  });
});
