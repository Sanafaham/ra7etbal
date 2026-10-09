/**
 * P3 Step 3 / S3 — legacy voice attention uses live item names. Source-
 * inspection tests, matching this file family's convention (the component is
 * not unit-rendered anywhere in this repo). Behaviour of the renderer and the
 * follow-up recogniser is covered in
 * src/lib/carson-operations-center.voice-live-names.test.ts.
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

describe("legacy voice attention reads and names live items", () => {
  it("the voice prefetch reads live with this turn's request", () => {
    const prefetch = between("if (attentionIntentForCurrentTranscriptRef.current) {", '} else if (role === "agent") {');
    expect(prefetch).toContain("const requestedView = voiceAttentionRequestRef.current;");
    expect(prefetch).toContain("fetchVoiceAttentionPresentation(requestedView)");
    expect(prefetch).not.toContain("fetchAttentionPresentation()");
  });

  it("the shared get_items_needing_attention tool uses the voice view only in a voice session; typed keeps the shared counts-only result", () => {
    const tool = between("get_items_needing_attention: (params", "get_commitment_history:");
    expect(tool).toContain(
      'requestedChannel === "voice"\n' +
        "                  ? await fetchVoiceAttentionPresentation(voiceAttentionRequestRef.current)\n" +
        "                  : await fetchAttentionPresentation();",
    );
  });

  it("an item follow-up is recognised only straight after an attention turn, against the people in that live answer", () => {
    const user = between("const voiceAttentionFollowUp = lastTurnWasAttentionIntentRef.current", "attentionIntentForCurrentTranscriptRef.current =\n");
    expect(user).toContain("resolveVoiceAttentionFollowUp(message, lastVoiceAttentionAssigneesRef.current)");
    expect(user).toContain("const isAttentionFollowUpTurn = voiceAttentionFollowUp !== null;");
    // The initial question always gets the five-name summary.
    expect(user).toContain("voiceAttentionRequestRef.current = matchesAttentionIntent(message)\n              ? { kind: \"summary\" }");
  });

  it("the live read is also given to the voice model, informational only, and never marks captures", () => {
    const prefetch = between("fetchVoiceAttentionPresentation(requestedView)\n", ".catch(() => {");
    expect(prefetch).toContain("conversationRef.current?.sendContextualUpdate(");
    // Only a successful whole view is offered as the full picture.
    expect(prefetch).toContain('if (requestedView.kind === "person" || !presentation.evidenceOk) return;');
    expect(prefetch.indexOf('if (requestedView.kind === "person"')).toBeLessThan(prefetch.indexOf("sendContextualUpdate("));
    expect(prefetch).toContain("[Live attention check]");
    expect(prefetch).toContain("The OPEN list given at the start of this session may be out of date.");
    expect(prefetch).not.toContain("markAttentionCapturesSurfaced");
  });

  it("the people for a follow-up come only from this session's last grounded voice attention answer, and are cleared with the session", () => {
    expect(SOURCE).toContain(
      "if (attentionIntentForCurrentTranscriptRef.current && attentionGuardResultRef.current?.assignees) {\n" +
        "              lastVoiceAttentionAssigneesRef.current = attentionGuardResultRef.current.assignees;",
    );
    expect((SOURCE.match(/lastVoiceAttentionAssigneesRef\.current = \[\];/g) ?? []).length).toBe(3);
    // The request resets with the session too, so a later typed session can never inherit it.
    expect((SOURCE.match(/voiceAttentionRequestRef\.current = \{ kind: "summary" \};/g) ?? []).length).toBe(3);
  });

  it("typed is unchanged: the typed /api/carson-turn path never uses the voice renderer or voice follow-up state", () => {
    const typed = between("const isDirectTypedAttentionIntent = matchesAttentionIntent(savedMessage.content);", 'const response = await fetch("/api/carson-turn", {');
    for (const voiceOnly of ["fetchVoiceAttentionPresentation", "voiceAttentionRequestRef", "lastVoiceAttentionAssigneesRef", "resolveVoiceAttentionFollowUp"]) {
      expect(typed).not.toContain(voiceOnly);
    }
    // Exactly two voice reads: the voice prefetch and the voice branch of the tool.
    expect((SOURCE.match(/fetchVoiceAttentionPresentation\((?:voiceAttentionRequestRef\.current|requestedView)\)/g) ?? []).length).toBe(2);
  });
});
