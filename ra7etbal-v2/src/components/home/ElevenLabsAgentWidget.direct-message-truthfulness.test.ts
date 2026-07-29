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
