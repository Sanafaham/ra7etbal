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

  it("the prefetch sends the person-scoped note too, but only after a successful read", () => {
    const prefetch = between("fetchVoiceAttentionPresentation(requestedView)\n", ".catch(() => {");
    const guard = prefetch.indexOf("if (!presentation.evidenceOk || !presentation.contextNote) return;");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(prefetch.indexOf("lastVoiceAttentionPageRef.current = presentation.page ?? null;"));
    expect(guard).toBeLessThan(prefetch.indexOf("sendContextualUpdate(presentation.contextNote)"));
    // Still turn-scoped: a late read from an earlier turn changes nothing.
    expect(prefetch.indexOf("currentOwnerTurnOperationIdRef.current !== requestTurnOperationId")).toBeLessThan(guard);
  });

  it("the tool remembers what it named only for this turn and only after a successful read", () => {
    const tool = between("get_items_needing_attention: (params", "get_commitment_history:");
    const turnCheck = tool.indexOf("if (currentOwnerTurnOperationIdRef.current !== requestTurnOperationId) return;");
    const remember = tool.indexOf("if (grounded?.evidenceOk && grounded.page) lastVoiceAttentionPageRef.current = grounded.page;");
    expect(turnCheck).toBeGreaterThan(-1);
    expect(remember).toBeGreaterThan(turnCheck);
  });

  it("'the rest' starts from what the last answer gave the model; it stays with a person only while that person's list is split", () => {
    const user = between("const lastVoiceAttentionPage = lastVoiceAttentionPageRef.current;", "attentionIntentForCurrentTranscriptRef.current =\n");
    expect(user).toContain('voiceAttentionFollowUp?.kind === "rest"');
    expect(user).toContain("previouslyGivenIds: lastVoiceAttentionPage?.givenIds ?? [],");
    expect(user).toContain("person: lastVoiceAttentionPage && lastVoiceAttentionPage.remaining > 0 ? lastVoiceAttentionPage.person : null,");
    // The opening question is always the summary.
    expect(user).toContain('voiceAttentionRequestRef.current = matchesAttentionIntent(message)\n              ? { kind: "summary" }');
  });

  it("REVIEW FINDING: a new attention question starts a new chain, so an older or failed answer never shapes 'the rest'", () => {
    const reset = SOURCE.indexOf("if (matchesAttentionIntent(message)) lastVoiceAttentionPageRef.current = null;");
    expect(reset).toBeGreaterThan(-1);
    expect(reset).toBeLessThan(SOURCE.indexOf("const lastVoiceAttentionPage = lastVoiceAttentionPageRef.current;"));
  });

  it("what was given is forgotten with the session, everywhere the request resets", () => {
    expect((SOURCE.match(/voiceAttentionRequestRef\.current = \{ kind: "summary" \};\n\s*lastVoiceAttentionPageRef\.current = null;/g) ?? []).length).toBe(3);
  });

  it("typed is unchanged: the typed path never touches the voice list state", () => {
    const typed = between("const isDirectTypedAttentionIntent = matchesAttentionIntent(savedMessage.content);", 'const response = await fetch("/api/carson-turn", {');
    for (const voiceOnly of ["lastVoiceAttentionPageRef", "modelText", "contextNote"]) expect(typed).not.toContain(voiceOnly);
  });

  it("voice still never marks captures surfaced, and the bubbles stay removed (PR #454)", () => {
    expect(SOURCE).toContain('if (requestedChannel !== "voice" && presentedAttentionCaptureIds.length > 0 && attentionGuardResultRef.current) {');
    expect((SOURCE.match(/markAttentionCapturesSurfaced\(/g) ?? []).length).toBe(1);
    expect(SOURCE).not.toContain("Carson heard</");
    expect(SOURCE).toContain("<CarsonVoiceSessionTextRecord");
  });
});
