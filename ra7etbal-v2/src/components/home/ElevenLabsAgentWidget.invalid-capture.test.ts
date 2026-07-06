import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(__dirname, "ElevenLabsAgentWidget.tsx"),
  "utf-8",
);

function blockBetween(startNeedle: string, endNeedle: string): string {
  const start = SOURCE.indexOf(startNeedle);
  const end = SOURCE.indexOf(endNeedle, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("ElevenLabsAgentWidget — invalid voice capture guard", () => {
  it("uses one shared transcript guard and repeat prompt source of truth", () => {
    expect(SOURCE).toContain("evaluateCarsonTranscriptCapture");
    expect(SOURCE).toContain("CARSON_REPEAT_PROMPT");
    expect(SOURCE).toContain("const guardCurrentVoiceCapture = useCallback");
  });

  it("does not push junk user transcript into sessionTranscriptRef or recurring/stale context", () => {
    const userBlock = blockBetween(
      'if (role === "user") {',
      '          } else if (role === "agent") {',
    );
    const invalidIndex = userBlock.indexOf("if (!captureEvaluation.valid) {");
    const pushIndex = userBlock.indexOf("sessionTranscriptRef.current.push({ role, message });");
    expect(invalidIndex).toBeGreaterThan(-1);
    expect(pushIndex).toBeGreaterThan(invalidIndex);
    expect(userBlock.slice(invalidIndex, pushIndex)).toContain("invalidCaptureRef.current = invalidCapture;");
    expect(userBlock.slice(invalidIndex, pushIndex)).toContain("recurringRawRef.current = null;");
    expect(userBlock.slice(invalidIndex, pushIndex)).toContain("lastDirectToolSuccessRef.current = null;");
    expect(userBlock.slice(invalidIndex, pushIndex)).toContain("return;");
  });

  it("suppresses the next agent reply from stale context after a failed capture", () => {
    const agentBlock = blockBetween(
      '          } else if (role === "agent") {',
      "// \"agent\" is the ElevenLabs SDK role for Carson's spoken turns.",
    );
    expect(agentBlock).toContain("sessionTranscriptRef.current.push({ role, message });");
    expect(agentBlock).toContain("if (invalidCaptureRef.current) {");
    expect(agentBlock).toContain("sessionTranscriptRef.current.pop();");
    expect(agentBlock).toContain("setLastCarsonMessage(CARSON_REPEAT_PROMPT);");
    expect(agentBlock).toContain("return;");
  });

  it("blocks all registered client tools before they can run from junk capture", () => {
    const sessionBlock = blockBetween(
      "clientTools: {",
      "        onModeChange: ({ mode: m }) => {",
    );
    const toolNames = [
      "execute_instruction",
      "send_followup",
      "send_delegation",
      "create_reminder",
      "create_automation",
      "send_direct_whatsapp_message",
      "save_city",
      "save_note",
      "act_on_note",
      "list_inbox_items",
      "act_on_inbox_item",
      "create_todo",
      "complete_todo",
      "control_task",
      "get_calendar_events",
      "create_calendar_event",
      "update_calendar_event",
      "delete_calendar_event",
      "save_instruction",
    ];

    for (const toolName of toolNames) {
      expect(sessionBlock).toContain(`guardCurrentVoiceCapture("${toolName}")`);
    }
  });

  it("execute_instruction rejects invalid instruction params even when no clean transcript arrived", () => {
    const executeBlock = blockBetween(
      "const executeInstruction = useCallback(",
      "// ── Carson supervisor — Phase 1+2",
    );
    expect(executeBlock).toContain("const instructionCapture = evaluateCarsonTranscriptCapture(rawInstruction);");
    expect(executeBlock).toContain("if (!instructionCapture.valid) {");
    expect(executeBlock).toContain("return CARSON_REPEAT_PROMPT;");
    expect(executeBlock).not.toContain("I did not receive an instruction.");
  });
});
