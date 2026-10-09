/**
 * P3 Step 3 / S2 — RETRIEVED / PREFETCHED ≠ SURFACED TO OWNER. Source-
 * inspection tests, matching this file's existing convention (see
 * ElevenLabsAgentWidget.second-brain-attention-guard-bypass.test.ts) since
 * the component is not unit-rendered anywhere in this repo.
 *
 * Production evidence (2026-08-24, conv_0801m0v2ewzhfvvam8k9fy2e0gda): the
 * voice guard prefetch marked three captures surfaced 12s after the owner's
 * question, with no tool call and no capture spoken. The write lived inside
 * retrieval. It now happens only where the grounded text reaches the bubble.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf-8");

function between(start: string, end: string): string {
  const from = SOURCE.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = SOURCE.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return SOURCE.slice(from, to);
}

describe("last_surfaced_at is written only at the owner-visible bubble", () => {
  it("S2-B: the attention-intent guard prefetch never marks captures surfaced", () => {
    const prefetch = between("if (attentionIntentForCurrentTranscriptRef.current) {", '} else if (role === "agent") {');
    expect(prefetch).toContain("fetchVoiceAttentionPresentation(requestedView)");
    expect(prefetch).not.toContain("markAttentionCapturesSurfaced");
  });

  it("S2-C: the get_items_needing_attention tool result (sent to the model) never marks captures surfaced", () => {
    const tool = between("get_items_needing_attention: (params", "get_commitment_history:");
    expect(tool).toContain("fetchVoiceAttentionPresentation(voiceAttentionRequestRef.current)");
    expect(tool).not.toContain("markAttentionCapturesSurfaced");
  });

  it("S2-F: the only mark call is gated by resolvePresentedAttentionCaptureIds on the text actually displayed, right after the bubble is set", () => {
    expect((SOURCE.match(/markAttentionCapturesSurfaced\(/g) ?? []).length).toBe(1);
    const bubble = SOURCE.indexOf("setLastCarsonMessage(mergedDisplayMessage);\n            setVoiceConversation([...sessionTranscriptRef.current]);");
    const resolver = SOURCE.indexOf("const presentedAttentionCaptureIds = resolvePresentedAttentionCaptureIds({");
    expect(bubble).toBeGreaterThan(-1);
    expect(resolver).toBeGreaterThan(bubble);
    expect(resolver - bubble).toBeLessThan(400);
    const site = between("const presentedAttentionCaptureIds = resolvePresentedAttentionCaptureIds({", "markAttentionCapturesSurfaced(presentedAttentionCaptureIds);\n");
    expect(site).toContain("attentionIntentDetected: attentionIntentForCurrentTranscriptRef.current,");
    expect(site).toContain("grounded: attentionGuardResultRef.current,");
    expect(site).toContain("displayedMessage: finalDisplayMessage,");
    // Marked once per turn: the presented captures are cleared after marking.
    expect(site).toContain("captureIds: [] };");
  });

  it("the widget never writes last_surfaced_at through the lower-level helpers directly", () => {
    expect(SOURCE).not.toContain("markCarsonNotesSurfaced");
    expect(SOURCE).not.toContain("markCarsonTodosSurfaced");
  });
});
