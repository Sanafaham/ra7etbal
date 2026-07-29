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
 * Carson intent architecture (2026-07-30): route_people_action replaces
 * regex-based intent re-derivation for communication/delegation. The model
 * describes the intended outcome as structured evidence fields;
 * resolveCarsonPeopleAction (deterministic, no raw-text parsing) decides
 * which existing, unchanged handler to invoke. These tests protect the
 * wiring: registration, the typed-advisory gate, the exemption from the
 * old regex-based policy gate, legacy-tool bypass telemetry, and correct
 * dispatch to the two existing execution handlers.
 */
describe("ElevenLabsAgentWidget — route_people_action wiring (2026-07-30 intent architecture)", () => {
  it("imports resolveCarsonPeopleAction from the new semantic-routing module", () => {
    expect(SOURCE).toContain(
      'import { resolveCarsonPeopleAction, type CarsonPeopleActionEnvelope } from "../../lib/carson-people-action";',
    );
  });

  it("is a voice-only, typed-blocked tool — same as the legacy tools it replaces", () => {
    expect(SOURCE).toContain("route_people_action: TYPED_ADVISORY_STAFF_MESSAGE,");
  });

  it("is exempted from the raw-text regex policy gate, before that gate is ever reached", () => {
    const guardBlock = blockBetween(
      "const guardCurrentToolInvocation = (toolName: string, toolArguments?: unknown): string | null => {",
      "    try {",
    );
    const exemptionIndex = guardBlock.indexOf('if (toolName === "route_people_action") return null;');
    const policyCallIndex = guardBlock.indexOf("const policyDecision = evaluateCarsonToolPolicy({");
    expect(exemptionIndex).toBeGreaterThan(-1);
    expect(policyCallIndex).toBeGreaterThan(exemptionIndex);
  });

  it("still runs the voice-capture guard, since the exemption is placed after it", () => {
    const guardBlock = blockBetween(
      "const guardCurrentToolInvocation = (toolName: string, toolArguments?: unknown): string | null => {",
      "    try {",
    );
    const captureIndex = guardBlock.indexOf("const captureBlock = guardCurrentVoiceCapture(toolName);");
    const exemptionIndex = guardBlock.indexOf('if (toolName === "route_people_action") return null;');
    expect(captureIndex).toBeGreaterThan(-1);
    expect(captureIndex).toBeLessThan(exemptionIndex);
  });

  it("records legacy_people_tool_bypass for direct calls to the legacy tools, covering both by name", () => {
    expect(SOURCE).toContain(
      'const LEGACY_PEOPLE_TOOLS = new Set(["send_direct_whatsapp_message", "send_delegation"]);',
    );
    const guardBlock = blockBetween(
      "const guardCurrentToolInvocation = (toolName: string, toolArguments?: unknown): string | null => {",
      "    try {",
    );
    expect(guardBlock).toContain("if (LEGACY_PEOPLE_TOOLS.has(toolName)) {");
    expect(guardBlock).toContain('stage: "legacy_people_tool_bypass"');
  });

  it("calls guardCurrentToolInvocation and resolveCarsonPeopleAction before dispatching to either execution handler", () => {
    const block = blockBetween(
      "route_people_action: async (params: CarsonPeopleActionEnvelope) => {",
      "send_delegation: async (params: Parameters<typeof sendDelegation>[0]) => {",
    );
    const guardIndex = block.indexOf('guardCurrentToolInvocation("route_people_action", params)');
    const resolveIndex = block.indexOf("const decision = resolveCarsonPeopleAction(params);");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(resolveIndex).toBeGreaterThan(guardIndex);
  });

  it("returns the clarifying question directly, without calling either execution handler", () => {
    const block = blockBetween(
      "route_people_action: async (params: CarsonPeopleActionEnvelope) => {",
      "send_delegation: async (params: Parameters<typeof sendDelegation>[0]) => {",
    );
    const clarifyBlock = block.slice(
      block.indexOf('if (decision.status === "clarify") {'),
      block.indexOf("return decision.question;") + "return decision.question;".length,
    );
    expect(clarifyBlock).toContain('stage: "people_action_clarify"');
    expect(clarifyBlock).toContain("return decision.question;");
    expect(clarifyBlock).not.toContain("sendDirectWhatsAppMessage");
    expect(clarifyBlock).not.toContain("sendDelegation(");
  });

  it("dispatches interpersonal_communication to sendDirectWhatsAppMessage and tracked_delegation to sendDelegation", () => {
    const block = blockBetween(
      "route_people_action: async (params: CarsonPeopleActionEnvelope) => {",
      "send_delegation: async (params: Parameters<typeof sendDelegation>[0]) => {",
    );
    expect(block).toContain('if (decision.tool === "send_direct_whatsapp_message") {');
    expect(block).toContain("sendDirectWhatsAppMessage(decision.params)");
    expect(block).toContain("sendDelegation(decision.params)");
    expect(block).toContain('stage: "people_action_mapped"');
    expect(block).toContain("selectedTool: decision.tool");
  });

  it("captures messageSendInFlightRef for the WhatsApp path, same as the direct registration", () => {
    const block = blockBetween(
      "route_people_action: async (params: CarsonPeopleActionEnvelope) => {",
      "send_delegation: async (params: Parameters<typeof sendDelegation>[0]) => {",
    );
    expect(block).toContain("messageSendInFlightRef.current = resultPromise");
  });
});
