/**
 * 2026-09-13 confirmation/truthfulness defect fix.
 *
 * Reproduced defect: "Ask Grace to prepare dinner." -> Carson said "Grace has
 * it." (pre-tool speech, before the tool resolved) -> the mocked tool then
 * failed -> Carson said "Grace has it." again (the model's own separately
 * generated post-tool reply, contradicting the real failure). Root cause was
 * layered: (1) execute_instruction's exception path never recorded a
 * canonical result at all, so nothing overrode the model's fabricated
 * post-tool claim; (2) even when a canonical result WAS recorded, the
 * multi-segment merge logic unconditionally APPENDED it after an earlier
 * same-turn segment instead of replacing it, so a premature/contradictory
 * claim could survive concatenated next to the truthful one; (3) the
 * calendar tools (create/update/delete) never fed into the canonical-result
 * system at all, so they had no protection whatsoever.
 *
 * The pure decision logic (shouldReplaceProvisionalConsequentialSegment) is
 * unit-tested directly in carson-consequential-result.test.ts, including the
 * Arabic-language case. This file is source-inspection only (the component
 * is not unit-rendered anywhere in this repo — see
 * ElevenLabsAgentWidget.multi-segment-agent-message.test.ts's own header for
 * the same convention) and verifies the WIDGET is actually wired to that
 * logic at every point the fix touches.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf-8");

// Mirrors the widget's own (module-private, source-inspected-only — see this
// file's header for why the module itself is never imported directly)
// CALENDAR_*_SUCCESS_PATTERN constants exactly, so their actual regex
// behavior against known calendar-tool return strings can be verified.
// Kept in lockstep by the literal-source assertions below.
const CALENDAR_CREATE_SUCCESS_PATTERN = /^Added .+ to your Google Calendar/;
const CALENDAR_UPDATE_SUCCESS_PATTERN = / is on your calendar\b/;
const CALENDAR_DELETE_SUCCESS_PATTERN = / is off your calendar\b/;

function blockBetween(startNeedle: string, endNeedle: string): string {
  const start = SOURCE.indexOf(startNeedle);
  const end = SOURCE.indexOf(endNeedle, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("confirmation/truthfulness defect fix — widget wiring", () => {
  // ── 1/2. TRACKED SUCCESS / FAILURE (execute_instruction) ──────────────────
  it("execute_instruction's exception path records an 'unclear' canonical result instead of leaving the model's own fabricated claim unchallenged", () => {
    const catchBlock = blockBetween(
      "} catch (err) {\n              trace.outcome = \"error\";\n              console.error(\"[executeInstruction:catch]\", err);",
      "} finally {",
    );
    expect(catchBlock).toContain("recordCanonicalConsequentialResult({");
    expect(catchBlock).toContain('toolName: "execute_instruction"');
    expect(catchBlock).toContain('outcome: "unclear"');
    // The recorded text must be the same truthful failure string returned to
    // ElevenLabs — never a separate, potentially inconsistent message.
    expect(catchBlock).toContain("resultText: failureText");
    expect(catchBlock).toContain("return failureText;");
  });

  // ── 5/6. CALENDAR SUCCESS / FAILURE ────────────────────────────────────────
  it("all three calendar tools now feed their own known-format result into the canonical consequential-result system", () => {
    for (const toolName of ["create_calendar_event", "update_calendar_event", "delete_calendar_event"]) {
      const block = blockBetween(`${toolName}: async (params:`, "return result;\n          },");
      expect(block).toContain("recordCanonicalConsequentialResult({");
      expect(block).toContain(`toolName: "${toolName}"`);
      expect(block).toContain('outcome: ');
    }
  });

  it("the widget's own pattern constants are exactly what this test mirrors above (no silent drift)", () => {
    expect(SOURCE).toContain("const CALENDAR_CREATE_SUCCESS_PATTERN = /^Added .+ to your Google Calendar/;");
    expect(SOURCE).toContain('const CALENDAR_UPDATE_SUCCESS_PATTERN = / is on your calendar\\b/;');
    expect(SOURCE).toContain('const CALENDAR_DELETE_SUCCESS_PATTERN = / is off your calendar\\b/;');
  });

  it("classifies calendar success purely from each tool's own closed, fully-enumerated return text — never the model's free-form reply", () => {
    expect(CALENDAR_CREATE_SUCCESS_PATTERN.test("Added Dentist to your Google Calendar — Monday at 3:00 PM.")).toBe(true);
    expect(CALENDAR_CREATE_SUCCESS_PATTERN.test("I couldn't add the event to your calendar. Please try again.")).toBe(false);

    expect(CALENDAR_UPDATE_SUCCESS_PATTERN.test("Dentist is on your calendar for Monday at 4:00 PM.")).toBe(true);
    expect(CALENDAR_UPDATE_SUCCESS_PATTERN.test("I couldn't update that event. Please try again.")).toBe(false);

    expect(CALENDAR_DELETE_SUCCESS_PATTERN.test("Dentist is off your calendar.")).toBe(true);
    expect(CALENDAR_DELETE_SUCCESS_PATTERN.test("I couldn't delete that event. Please try again.")).toBe(false);
  });

  // ── 7. TURN ISOLATION ───────────────────────────────────────────────────
  it("consequentialResultReplacedAtRef is reset alongside canonicalConsequentialResultRef at every reset site — never leaks into the next turn", () => {
    const canonicalResets = SOURCE.split("canonicalConsequentialResultRef.current = null;").length - 1;
    const replacedAtResets = SOURCE.split("consequentialResultReplacedAtRef.current = null;").length - 1;
    expect(canonicalResets).toBeGreaterThan(0);
    expect(replacedAtResets).toBe(canonicalResets);
  });

  // ── 8. DUPLICATE SUPPRESSION ────────────────────────────────────────────
  it("the merge step replaces (never appends) a provisional segment on a fresh canonical reveal, and appends normally otherwise", () => {
    const mergeBlock = blockBetween(
      "const currentCanonicalResult = canonicalConsequentialResultRef.current;",
      "setLastCarsonMessage(mergedDisplayMessage);",
    );
    expect(mergeBlock).toContain("shouldReplaceProvisionalConsequentialSegment(");
    // Exactly one branch replaces without concatenation, one appends — proves
    // the fix does not simply always concatenate (the pre-fix behavior).
    const replaceIdx = mergeBlock.indexOf("isFreshConsequentialReveal) {");
    const appendIdx = mergeBlock.indexOf("mergedDisplayMessage = `${previousSegment.message} ${finalDisplayMessage}`;");
    expect(replaceIdx).toBeGreaterThan(-1);
    expect(appendIdx).toBeGreaterThan(replaceIdx);
  });

  // ── 9. WORKFLOW CONTROL / protected text ───────────────────────────────
  it("does not touch buildCanonicalConsequentialSpeechPayload's protected verbatim-relay contract", () => {
    expect(SOURCE).toContain("speak_owner_result_exactly_without_additions_or_changes");
  });

  // ── 10. VOICE / TEXT PARITY ─────────────────────────────────────────────
  it("the replace-vs-append decision is not gated on requestedChannel — voice and text share the exact same merge path", () => {
    const mergeBlock = blockBetween(
      "const currentCanonicalResult = canonicalConsequentialResultRef.current;",
      "setLastCarsonMessage(mergedDisplayMessage);",
    );
    expect(mergeBlock).not.toContain("requestedChannel");
  });
});
