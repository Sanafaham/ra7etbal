import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "ElevenLabsAgentWidget.tsx"), "utf8");

describe("ElevenLabsAgentWidget — pre-dispatch policy boundary", () => {
  it("evaluates the current turn, channel, tool, arguments, and people", () => {
    for (const evidence of [
      "evaluateCarsonToolPolicy({", "utterance: currentUtterance",
      "channel: requestedChannel", "selectedTool: toolName", "toolArguments",
      "people: usePeopleStore.getState().items",
    ]) expect(SOURCE).toContain(evidence);
  });

  it("records and returns rejection before client handlers", () => {
    expect(SOURCE.indexOf("const guardCurrentToolInvocation ="))
      .toBeLessThan(SOURCE.indexOf("clientTools: {"));
    expect(SOURCE).toContain("[carson-tool-policy] rejected before side effect");
    expect(SOURCE).toContain('recordCarsonDiagnostic("carson-direct-tool", diagnostic)');
    expect(SOURCE).toContain("return policyDecision.outcome");
  });

  it("passes arguments into every relevant client-tool guard", () => {
    for (const tool of [
      "execute_instruction", "send_followup", "send_delegation", "create_reminder",
      "create_automation", "send_direct_whatsapp_message", "save_note", "act_on_note",
      "create_todo", "complete_todo", "control_task", "get_calendar_events",
      "create_calendar_event", "update_calendar_event", "delete_calendar_event", "save_city",
    ]) expect(SOURCE).toContain(`guardCurrentToolInvocation("${tool}", params)`);
  });

  it("keeps typed reads available and blocks typed note persistence", () => {
    expect(SOURCE).toContain("save_note: TYPED_ADVISORY_TASK_STATE");
    expect(SOURCE).toContain("// get_calendar_events is intentionally absent");
  });
});
