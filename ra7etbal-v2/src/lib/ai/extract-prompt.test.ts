import { describe, expect, it } from "vitest";
import { buildExtractionPrompt } from "./extract-prompt";

/**
 * Production bug (2026-07-10): a reference photo of "TEREA Silver" produced
 * the task "Buy OTEREA Silver cigarettes." — the shared extraction prompt
 * had no instruction requiring literal transcription of visible brand/
 * product/model text, so nothing stopped the model from silently altering
 * it. This is a behavioral, not a source-scanning, guard: it calls the real
 * buildExtractionPrompt() and asserts on its actual output, so a future edit
 * that accidentally drops or waters down the instruction fails loudly.
 */
describe("buildExtractionPrompt — exact brand/product/model text preservation", () => {
  const prompt = buildExtractionPrompt("(See the attached image.)", [], "Sana");

  it("instructs exact, character-for-character transcription of visible brand/product/model text", () => {
    expect(prompt).toMatch(/PRESERVE BRAND \/ PRODUCT \/ MODEL TEXT EXACTLY/);
    expect(prompt).toMatch(/transcribe it EXACTLY as it appears/i);
    expect(prompt).toMatch(/character-for-character/i);
  });

  it("explicitly forbids inventing characters, correcting spelling, or substituting a more familiar name", () => {
    expect(prompt).toMatch(/invent, add, or drop a character/i);
    expect(prompt).toMatch(/"correct" what looks like a typo/i);
    expect(prompt).toMatch(/substitute a more familiar-sounding or better-known name/i);
  });

  it("includes the exact production failure case as a worked example, corrected", () => {
    expect(prompt).toMatch(/TEREA → TEREA/);
    expect(prompt).toMatch(/TEREA → OTEREA/); // listed under "Incorrect (never do this)"
  });

  it("directs low-confidence reads to needsClarification instead of guessing, reusing the existing mechanism", () => {
    const section = prompt.slice(
      prompt.indexOf("PRESERVE BRAND / PRODUCT / MODEL TEXT EXACTLY"),
      prompt.indexOf("MESSAGE STYLE"),
    );
    expect(section).toMatch(/do NOT guess a plausible-looking\s*\n?\s*replacement/i);
    expect(section).toMatch(/needsClarification: true/);
    expect(section).toMatch(/clarificationQuestion/);
  });

  it("does not introduce a new output field — reuses needsClarification/clarificationQuestion already in OUTPUT SHAPE", () => {
    const outputShapeSection = prompt.slice(
      prompt.indexOf("OUTPUT SHAPE"),
      prompt.indexOf("MISSING-DETAIL NOTES"),
    );
    expect(outputShapeSection).toMatch(/"needsClarification": false/);
    expect(outputShapeSection).toMatch(/"clarificationQuestion":/);
  });

  it("leaves existing classification rules (image routing / delegation routing) untouched", () => {
    // Rule 0/1 relationship-noun and role-precedence logic, present before this fix, still intact.
    expect(prompt).toMatch(/RULE 0 \(ABSOLUTE\) — RELATIONSHIP-NOUN TARGETS/);
    expect(prompt).toMatch(/RULE 1 — ROLE OVERRIDES PHRASING/);
    expect(prompt).toMatch(/Operational-role mapping/);
    // Worked examples A-R, present before this fix, still intact.
    expect(prompt).toMatch(/Example A\. Input: "Tell Christopher dinner is at 9\."/);
    expect(prompt).toMatch(/Example R\. Input: "Tell Nasira to clean the kitchen/);
  });

  it("leaves PRESERVE TIME CONTEXT EXACTLY (the analogous prior rule) untouched", () => {
    expect(prompt).toMatch(/PRESERVE TIME CONTEXT EXACTLY/);
    expect(prompt).toMatch(/Never invent time words\./);
  });
});
