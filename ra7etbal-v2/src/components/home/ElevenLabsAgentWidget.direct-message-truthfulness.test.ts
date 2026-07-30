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
 * Confirmed production regression (2026-07-29): live-tested "Ask Christopher
 * to reply 'test received'." produced the spoken reply "Message sent to
 * Christopher." with zero `messages` row, zero `whatsapp_deliveries` row, and
 * zero `/api/send-whatsapp-task` request in production — send_direct_whatsapp_message
 * was never invoked at all that turn. Structurally identical to the
 * 2026-07-13 save_note fabrication bug (see save-note-truthfulness.test.ts),
 * just never wired up for this tool. Applies identically to voice and typed
 * Carson — both run through the same onMessage handler.
 */
describe("ElevenLabsAgentWidget — send_direct_whatsapp_message truthfulness (2026-07-29 fix)", () => {
  it("only returns the success text after createAndSendDirectMessage resolves, inside the try block", () => {
    const block = blockBetween(
      "const sendDirectWhatsAppMessage = useCallback(",
      "  // Client tool: save_city",
    );
    const tryIndex = block.indexOf("try {");
    const sendIndex = block.indexOf("await createAndSendDirectMessage(");
    const successReturnIndex = block.indexOf("const resultText = `It's with ${person.name}");
    expect(tryIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeGreaterThan(tryIndex);
    expect(successReturnIndex).toBeGreaterThan(sendIndex);
  });

  it("records messageSendOutcomeRef with outcome success on send, and failure on a thrown error", () => {
    const block = blockBetween(
      "const sendDirectWhatsAppMessage = useCallback(",
      "  // Client tool: save_city",
    );
    expect(block).toMatch(/messageSendOutcomeRef\.current = \{ outcome: "success"/);
    expect(block).toMatch(/messageSendOutcomeRef\.current = \{ outcome: "failure"/);
  });

  it("clears messageSendOutcomeRef at entry, before any validation early return", () => {
    const block = blockBetween(
      "const sendDirectWhatsAppMessage = useCallback(",
      "  // Client tool: save_city",
    );
    const clearIndex = block.indexOf("messageSendOutcomeRef.current = null;");
    const validationIndex = block.indexOf("if (!name || !text) {");
    expect(clearIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeLessThan(validationIndex);
  });

  it("the shared onMessage handler resolves the agent's reply through the truthfulness override for both channels", () => {
    expect(SOURCE).toContain("const displayMessage = resolveSanitizedCarsonDisplayMessage({");
    expect(SOURCE).toContain("messageSendOutcome: messageSendOutcomeRef.current");
    // Not gated on requestedChannel — same resolution path for voice and typed.
    const resolveIndex = SOURCE.indexOf("const displayMessage = resolveSanitizedCarsonDisplayMessage({");
    const channelGateIndex = SOURCE.indexOf('if (requestedChannel === "text") {', resolveIndex);
    expect(channelGateIndex).toBeGreaterThan(resolveIndex);
  });

  // Mirrors noteSaveOutcomeRef exactly rather than reusing the shared,
  // time-windowed lastDirectToolSuccessRef — CodeRabbit already flagged that
  // a shared window lets an earlier turn's unrelated success suppress this
  // class of fabrication check for a later turn within that same window.
  it("resets messageSendOutcomeRef to null at the start of every voice turn", () => {
    const block = blockBetween('if (role === "user") {', "const receivedAt = new Date().toISOString();");
    expect(block).toContain("messageSendOutcomeRef.current = null");
  });

  it("resets messageSendOutcomeRef to null at the start of every typed turn", () => {
    const block = blockBetween(
      "pendingTypedClientMessageIdRef.current = clientMessageId;",
      "typedResponseTimeoutRef.current = setTimeout(",
    );
    expect(block).toContain("messageSendOutcomeRef.current = null");
  });

  it("messageSendOutcomeRef is a dedicated ref, separate from the shared lastDirectToolSuccessRef, typed via DirectMessageSendOutcome", () => {
    expect(SOURCE).toContain("const messageSendOutcomeRef = useRef<DirectMessageSendOutcome | null>(null);");
    expect(SOURCE).toContain("type DirectMessageSendOutcome } from \"../../lib/carson-direct-tool-override\"");
  });
});

/**
 * Confirmed production incident (2026-07-29, ~18:39 and ~20:19 Turkey time):
 * a genuine voice send_direct_whatsapp_message call succeeded — Christopher
 * received the WhatsApp message — but carson_tool_diagnostics shows the
 * agent's reply was classified by the truthfulness guard ~35ms BEFORE the
 * tool's own handler_success, while the real network send was still in
 * flight. Reading messageSendOutcomeRef as still-null at that exact instant
 * produced a false-negative "I couldn't confirm..." displayed reply for a
 * send that truly worked. These tests protect the fix: onMessage now awaits
 * the in-flight call's own settle (via messageSendInFlightRef /
 * resolvePendingMessageSendOutcome) before finalizing an unconfirmed-claim
 * correction, instead of reading an instantaneous snapshot.
 */
describe("ElevenLabsAgentWidget — awaiting the authoritative send result before overriding (2026-07-29 race fix)", () => {
  it("declares messageSendInFlightRef and clears it at every reset point alongside messageSendOutcomeRef", () => {
    expect(SOURCE).toContain(
      "const messageSendInFlightRef = useRef<Promise<DirectMessageSendOutcome | null> | null>(null);",
    );
    const voiceTurnBlock = blockBetween('if (role === "user") {', "const receivedAt = new Date().toISOString();");
    expect(voiceTurnBlock).toContain("messageSendOutcomeRef.current = null");
    expect(voiceTurnBlock).toContain("messageSendInFlightRef.current = null");
    const typedTurnBlock = blockBetween(
      "pendingTypedClientMessageIdRef.current = clientMessageId;",
      "typedResponseTimeoutRef.current = setTimeout(",
    );
    expect(typedTurnBlock).toContain("messageSendOutcomeRef.current = null");
    expect(typedTurnBlock).toContain("messageSendInFlightRef.current = null");
  });

  it("captures the in-flight promise at the send_direct_whatsapp_message call site before awaiting it", () => {
    const block = blockBetween(
      'send_direct_whatsapp_message: async (params: { recipient_name: string; message: string }) => {',
      "toolInFlightRef.current = null;",
    );
    const resultPromiseIndex = block.indexOf("const resultPromise = runDirectToolWithDiagnostic(");
    const captureIndex = block.indexOf("messageSendInFlightRef.current = resultPromise");
    const awaitIndex = block.indexOf("return await resultPromise;");
    expect(resultPromiseIndex).toBeGreaterThan(-1);
    expect(captureIndex).toBeGreaterThan(resultPromiseIndex);
    expect(awaitIndex).toBeGreaterThan(captureIndex);
  });

  it("only defers for voice, only when no outcome is known yet, and only when a real call is in flight", () => {
    const block = blockBetween(
      "const pendingMessageSend = messageSendInFlightRef.current;",
      "// This onMessage callback delivers the agent's own separately-generated",
    );
    expect(block).toContain('requestedChannel === "voice"');
    expect(block).toContain("messageSendOutcomeRef.current === null");
    expect(block).toContain("pendingMessageSend &&");
    // Confirmed 2026-07-30 incident: the old gate here only matched
    // success-shaped claims (detectsUnconfirmedMessageSendClaim), so a false
    // FAILURE claim ("I wasn't able to send that.") never deferred at all.
    // looksLikeMessageSendOutcomeClaim matches either direction.
    expect(block).toContain("looksLikeMessageSendOutcomeClaim(message, previousUserMessage)");
  });

  it("awaits resolvePendingMessageSendOutcome before finalizing the corrected transcript entry", () => {
    const block = blockBetween(
      "const pendingMessageSend = messageSendInFlightRef.current;",
      "// This onMessage callback delivers the agent's own separately-generated",
    );
    const awaitIndex = block.indexOf("const resolvedOutcome = await resolvePendingMessageSendOutcome(pendingMessageSend);");
    const resolveIndex = block.indexOf("const correctedDisplayMessage = resolveSanitizedCarsonDisplayMessage({");
    const outcomeFieldIndex = block.indexOf("messageSendOutcome: resolvedOutcome ?? messageSendOutcomeRef.current,");
    expect(awaitIndex).toBeGreaterThan(-1);
    expect(resolveIndex).toBeGreaterThan(awaitIndex);
    expect(outcomeFieldIndex).toBeGreaterThan(resolveIndex);
    // A confirmed success (correctedDisplayMessage === message) is left
    // untouched — no override, no diagnostic write, no re-render.
    expect(block).toContain("if (correctedDisplayMessage === message) return;");
  });

  it("still records claim_overridden and re-renders only when the awaited result is a genuine, confirmed non-success", () => {
    const block = blockBetween(
      "const pendingMessageSend = messageSendInFlightRef.current;",
      "// This onMessage callback delivers the agent's own separately-generated",
    );
    const guardIndex = block.indexOf("if (correctedDisplayMessage === message) return;");
    const diagnosticIndex = block.indexOf('stage: "claim_overridden"', guardIndex);
    const rerenderIndex = block.indexOf("setLastCarsonMessage(correctedDisplayMessage);", guardIndex);
    expect(diagnosticIndex).toBeGreaterThan(guardIndex);
    expect(rerenderIndex).toBeGreaterThan(diagnosticIndex);
  });
});

/**
 * Confirmed gap found during the 2026-07-29 spoken-execution-truthfulness
 * review: messageSendOutcomeRef/messageSendInFlightRef/noteSaveOutcomeRef
 * were cleared at every turn boundary but NOT in onDisconnect/onError. This
 * codebase already has an established precedent for exactly this class of
 * bug — other per-session refs (activeExecuteLatencyRef,
 * lastUserTranscriptTimingRef, etc.) are explicitly cleared there with the
 * comment "a NEXT session's ... event could log or complete a trace using
 * this session's stale timing." Without the same treatment here, a stale
 * in-flight promise or outcome from a call that never settled (or settled
 * after the session ended) could be read by a brand-new, unrelated session's
 * onMessage as if it belonged to a fresh turn — a cross-session leak.
 */
describe("ElevenLabsAgentWidget — no cross-session leakage on reconnect (2026-07-29 hardening)", () => {
  it("clears messageSendOutcomeRef, messageSendInFlightRef, and noteSaveOutcomeRef in onDisconnect", () => {
    const block = blockBetween(
      "onDisconnect: (details?: {",
      "onError: (msg, context?: unknown) => {",
    );
    expect(block).toContain("noteSaveOutcomeRef.current = null");
    expect(block).toContain("messageSendOutcomeRef.current = null");
    expect(block).toContain("messageSendInFlightRef.current = null");
  });

  it("clears messageSendOutcomeRef, messageSendInFlightRef, and noteSaveOutcomeRef in onError", () => {
    const block = blockBetween(
      "onError: (msg, context?: unknown) => {",
      "onConnect: ({ conversationId }) => {",
    );
    expect(block).toContain("noteSaveOutcomeRef.current = null");
    expect(block).toContain("messageSendOutcomeRef.current = null");
    expect(block).toContain("messageSendInFlightRef.current = null");
  });
});
