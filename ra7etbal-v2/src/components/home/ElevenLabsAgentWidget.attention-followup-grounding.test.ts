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
    expect(SOURCE).toContain(
      "matchesAttentionFollowUp(message) && lastTurnWasAttentionIntentRef.current",
    );
    // The old, fixed gate must not remain as the follow-up condition.
    expect(SOURCE).not.toContain(
      "matchesAttentionFollowUp(message) && lastAttentionTurnWasGroundedRef.current",
    );
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
