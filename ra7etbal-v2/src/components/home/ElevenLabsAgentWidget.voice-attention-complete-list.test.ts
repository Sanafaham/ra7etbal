/**
 * P3 Step 3 / S3 — spoken-answer reliability (Option A, 2026-10-09), widget
 * wiring. Source-inspection tests, matching this file family's convention.
 * What the model is given is covered in
 * src/lib/carson-operations-center.voice-complete-list.test.ts. None of this
 * can force the model to call the tool or to say every item; it only makes
 * sure the fresh, complete list and the instruction reach it.
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

describe("voice attention: complete lists and person follow-ups reach the model", () => {
  it("the tool gives the model the list plus its instruction; the session text record keeps the plain text", () => {
    const tool = between("get_items_needing_attention: (params", "get_commitment_history:");
    expect(tool).toContain("return presentation.modelText ?? presentation.text;");
    expect(tool).toContain("text: grounded?.text ?? text,");
    // Typed still gets the shared counts-only result, which has no modelText.
    expect(tool).toContain(": await fetchAttentionPresentation();");
  });

  it("the prefetch records its read for this turn only, and sends the note only after a successful read", () => {
    const prefetch = between("fetchVoiceAttentionPresentation(requestedView)\n", ".catch(() => {");
    const turnCheck = prefetch.indexOf("currentOwnerTurnOperationIdRef.current !== requestTurnOperationId");
    const record = prefetch.indexOf("voiceAttentionChainRef.current = recordVoiceAttentionRead(voiceAttentionChainRef.current, {");
    const guard = prefetch.indexOf("if (!presentation.evidenceOk || !presentation.contextNote) return;");
    expect(turnCheck).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(turnCheck);
    expect(guard).toBeGreaterThan(record);
    expect(guard).toBeLessThan(prefetch.indexOf("sendContextualUpdate(presentation.contextNote)"));
  });

  it("S3 2026-10-10: a voice tool read Carson asked for is recorded against its own turn, after the turn check", () => {
    const tool = between("get_items_needing_attention: (params", "get_commitment_history:");
    const turnCheck = tool.indexOf("if (currentOwnerTurnOperationIdRef.current !== requestTurnOperationId) return;");
    const record = tool.indexOf('if (requestedChannel === "voice" && grounded && requestTurnOperationId) {');
    expect(turnCheck).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(turnCheck);
    expect(tool).toContain("turnId: requestTurnOperationId,");
    // The tool returns this turn's request, decided when the turn began.
    expect(tool).toContain("fetchVoiceAttentionPresentation(voiceAttentionChainRef.current.request)");
  });

  it("S3 2026-10-10: each voice turn begins the chain with its own turn id; Carson's message settles it", () => {
    const user = between("voiceAttentionChainRef.current = beginVoiceAttentionTurn(", "if (attentionIntentForCurrentTranscriptRef.current) {");
    expect(user).toContain("turnId: turnOperationId,");
    expect(user).toContain("enabled: !secondBrainVoiceEnabled,");
    expect(user).toContain("attentionIntentForCurrentTranscriptRef.current = voiceAttentionChainRef.current.recognised;");
    expect(SOURCE).toContain(
      'if (requestedChannel === "voice") {\n              voiceAttentionChainRef.current = settleVoiceAttentionTurn(voiceAttentionChainRef.current);',
    );
    // The old recogniser-only gate is gone from the voice path.
    expect(SOURCE).not.toContain("const voiceAttentionFollowUp = lastTurnWasAttentionIntentRef.current");
  });

  it("the whole chain is forgotten with the session, everywhere it resets", () => {
    expect((SOURCE.match(/voiceAttentionChainRef\.current = INITIAL_VOICE_ATTENTION_CHAIN;/g) ?? []).length).toBe(3);
  });

  it("typed is unchanged: the typed path never touches the voice list state", () => {
    const typed = between("const isDirectTypedAttentionIntent = matchesAttentionIntent(savedMessage.content);", 'const response = await fetch("/api/carson-turn", {');
    for (const voiceOnly of ["voiceAttentionChainRef", "modelText", "contextNote"]) expect(typed).not.toContain(voiceOnly);
  });

  it("voice still never marks captures surfaced, and the bubbles stay removed (PR #454)", () => {
    expect(SOURCE).toContain('if (requestedChannel !== "voice" && presentedAttentionCaptureIds.length > 0 && attentionGuardResultRef.current) {');
    expect((SOURCE.match(/markAttentionCapturesSurfaced\(/g) ?? []).length).toBe(1);
    expect(SOURCE).not.toContain("Carson heard</");
    expect(SOURCE).toContain("<CarsonVoiceSessionTextRecord");
  });
});
