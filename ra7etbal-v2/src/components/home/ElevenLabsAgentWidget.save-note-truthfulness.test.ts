import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf-8");

function blockBetween(startNeedle: string, endNeedle: string): string {
  const start = SOURCE.indexOf(startNeedle);
  const end = SOURCE.indexOf(endNeedle, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

/**
 * Production bug (2026-07-13): Carson replied "Saved." to an explicit typed
 * note request with no corresponding carson_notes row ever created. save_note
 * must (a) only ever report success after saveCarsonNote resolves without
 * throwing, (b) record that outcome so a contradictory agent-generated reply
 * can be corrected the same way create_todo/create_reminder/etc. already are,
 * and (c) tell the Notes route to refresh. Applies identically to voice and
 * typed Carson — both run through this same onMessage handler.
 */
describe("ElevenLabsAgentWidget — save_note truthfulness (2026-07-14 fix)", () => {
  it("only returns success text after saveCarsonNote resolves, inside the try block", () => {
    const block = blockBetween(
      "const saveNote = useCallback(",
      "  // ------------------------------------------------------------------\n  // Client tool: create_todo",
    );
    const tryIndex = block.indexOf("try {");
    const saveIndex = block.indexOf("await saveCarsonNote(");
    const successReturnIndex = block.indexOf('const resultText = "Saved.";');
    expect(tryIndex).toBeGreaterThan(-1);
    expect(saveIndex).toBeGreaterThan(tryIndex);
    expect(successReturnIndex).toBeGreaterThan(saveIndex);
  });

  it("records lastDirectToolSuccessRef with outcome success on save, and failure on a thrown error", () => {
    const block = blockBetween(
      "const saveNote = useCallback(",
      "  // ------------------------------------------------------------------\n  // Client tool: create_todo",
    );
    expect(block).toMatch(/outcome:\s*"success"/);
    expect(block).toMatch(/outcome:\s*"failure"/);
    expect(block).toContain('toolName: "save_note"');
  });

  it("dispatches a notes-changed event only after the note is actually saved", () => {
    const block = blockBetween(
      "const saveNote = useCallback(",
      "  // ------------------------------------------------------------------\n  // Client tool: create_todo",
    );
    const saveIndex = block.indexOf("await saveCarsonNote(");
    const dispatchIndex = block.indexOf('"ra7etbal:notes-changed"');
    expect(dispatchIndex).toBeGreaterThan(saveIndex);
  });

  it("save_note is registered as a client tool wired to saveNote, applying to both voice and typed sessions", () => {
    expect(SOURCE).toContain('save_note: (params: Parameters<typeof saveNote>[0]) => {');
    expect(SOURCE).toContain('runDirectToolWithDiagnostic("save_note", params, () => saveNote(params))');
  });

  it("the shared onMessage handler resolves the agent's reply through the truthfulness override for both channels", () => {
    expect(SOURCE).toContain("const displayMessage = resolveSanitizedCarsonDisplayMessage({");
    expect(SOURCE).toContain("lastSuccess: lastDirectToolSuccessRef.current");
    expect(SOURCE).toContain("noteSaveOutcome: noteSaveOutcomeRef.current");
    // Not gated on requestedChannel — same resolution path for voice and typed.
    const resolveIndex = SOURCE.indexOf("const displayMessage = resolveSanitizedCarsonDisplayMessage({");
    const channelGateIndex = SOURCE.indexOf('if (requestedChannel === "text") {', resolveIndex);
    expect(channelGateIndex).toBeGreaterThan(resolveIndex);
  });

  // CodeRabbit finding (2026-07-14): the first version of this fix reused
  // the shared, time-windowed lastDirectToolSuccessRef for the fabrication
  // check, which would let an unrelated tool's (or an earlier turn's)
  // success suppress the guard for a LATER turn's note request inside that
  // same 15s window. noteSaveOutcomeRef must instead be reset to null at
  // every new-turn boundary, for both channels, so it can never leak across
  // turns or tools regardless of timing.
  it("resets noteSaveOutcomeRef to null at the start of every voice turn", () => {
    const block = blockBetween('if (role === "user") {', "const receivedAt = new Date().toISOString();");
    expect(block).toContain("noteSaveOutcomeRef.current = null");
  });

  it("resets noteSaveOutcomeRef to null at the start of every typed turn", () => {
    const block = blockBetween(
      "pendingTypedClientMessageIdRef.current = clientMessageId;",
      "typedResponseTimeoutRef.current = setTimeout(",
    );
    expect(block).toContain("noteSaveOutcomeRef.current = null");
  });

  it("noteSaveOutcomeRef is a dedicated ref, separate from the shared lastDirectToolSuccessRef", () => {
    expect(SOURCE).toContain("const noteSaveOutcomeRef = useRef<{");
  });
});
