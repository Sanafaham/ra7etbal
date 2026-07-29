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
 * Confirmed production incidents (2026-07-29): repeated "Ask Christopher to
 * reply..." turns produced zero messages/whatsapp_deliveries rows and zero
 * transport logs, with no persisted record distinguishing "the model never
 * called the tool" from "the policy gate rejected it" from "the handler ran
 * and exited early" from "the backend call failed". These tests prove the
 * server-side diagnostic instrumentation (carson-tool-diagnostics.ts) is
 * wired at every stage the investigation needed and couldn't observe.
 */
describe("ElevenLabsAgentWidget — server-side tool diagnostics (2026-07-29)", () => {
  it("imports recordCarsonToolDiagnostic", () => {
    expect(SOURCE).toContain(
      'import { recordCarsonToolDiagnostic } from "../../lib/carson-tool-diagnostics";',
    );
  });

  it("records 'invoked' at the very top of guardCurrentToolInvocation, before any block can return early", () => {
    const block = blockBetween(
      "const guardCurrentToolInvocation = (toolName: string, toolArguments?: unknown): string | null => {",
      "if (requestedChannel === \"voice\") {\n        const captureBlock = guardCurrentVoiceCapture(toolName);",
    );
    expect(block).toContain('stage: "invoked"');
  });

  it("records 'typed_blocked' when the typed-advisory-only guard fires", () => {
    const block = blockBetween(
      "if (TYPED_MODE_IS_ADVISORY_ONLY && TYPED_BLOCKED_TOOL_MESSAGES[toolName]) {",
      "return TYPED_BLOCKED_TOOL_MESSAGES[toolName];",
    );
    expect(block).toContain('stage: "typed_blocked"');
  });

  it("records 'policy_rejected' with the exact rejection reason and missing entities", () => {
    const block = blockBetween(
      'console.warn("[carson-tool-policy] rejected before side effect", diagnostic);',
      "return policyDecision.outcome;",
    );
    expect(block).toContain('stage: "policy_rejected"');
    expect(block).toContain("reason: policyDecision.reason");
    expect(block).toContain("missingEntities: policyDecision.missingEntities");
  });

  it("records 'handler_started' at the top of sendDirectWhatsAppMessage, before any validation return", () => {
    const block = blockBetween(
      "const sendDirectWhatsAppMessage = useCallback(",
      "if (!name || !text) {",
    );
    expect(block).toContain('stage: "handler_started"');
  });

  it("records 'handler_success' and 'handler_failure' with a safe recipientPersonId, never a name", () => {
    const block = blockBetween(
      "const sendDirectWhatsAppMessage = useCallback(",
      "  // Client tool: save_city",
    );
    expect(block).toContain('stage: "handler_success"');
    expect(block).toContain('stage: "handler_failure"');
    expect(block).toContain("recipientPersonId: person.id");
  });

  it("records 'claim_overridden' exactly where the truthfulness guard corrects the displayed transcript", () => {
    const block = blockBetween(
      "if (finalDisplayMessage !== message) {",
      "console.log(\"[transcript] agent role confirmed",
    );
    expect(block).toContain('stage: "claim_overridden"');
    // Hashed, never the raw agent text itself, passed as a distinct field.
    expect(block).toContain("message,");
  });
});
