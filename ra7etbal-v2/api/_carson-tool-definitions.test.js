import { describe, it, expect } from "vitest";
import {
  CARSON_TOOL_ALLOWLIST,
  isAllowlistedTool,
  getToolDefinition,
  toOpenAiToolsPayload,
  DETERMINISTIC_OUTCOME_TOOLS,
  UNCERTAIN_OUTCOME_TOOLS,
  LEGACY_COMPATIBILITY_TOOLS,
} from "./_carson-tool-definitions.js";

const EXPECTED_23 = [
  "execute_instruction", "send_delegation", "send_followup", "create_reminder", "create_automation",
  "send_direct_whatsapp_message", "save_city", "save_note", "act_on_note", "create_todo", "complete_todo",
  "control_task", "get_calendar_events", "search_calendar_history", "get_task_delivery_status",
  "get_operations_summary", "get_commitment_history", "get_person_history", "get_communication_history",
  "create_calendar_event", "update_calendar_event", "delete_calendar_event", "save_instruction",
];

describe("CARSON_TOOL_ALLOWLIST", () => {
  it("contains exactly the 23 tools read from ElevenLabsAgentWidget.tsx clientTools", () => {
    const names = CARSON_TOOL_ALLOWLIST.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_23].sort());
    expect(CARSON_TOOL_ALLOWLIST).toHaveLength(23);
  });

  it("every allowlisted tool has a description and a JSON-schema parameters object", () => {
    for (const tool of CARSON_TOOL_ALLOWLIST) {
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters.type).toBe("object");
    }
  });

  it("isAllowlistedTool rejects anything not on the list", () => {
    expect(isAllowlistedTool("execute_instruction")).toBe(true);
    expect(isAllowlistedTool("delete_everything")).toBe(false);
    expect(isAllowlistedTool("")).toBe(false);
    expect(isAllowlistedTool(undefined)).toBe(false);
  });

  it("getToolDefinition returns null for an unregistered name", () => {
    expect(getToolDefinition("not_a_real_tool")).toBeNull();
    expect(getToolDefinition("save_note")?.name).toBe("save_note");
  });

  it("send_delegation is marked legacy and cannot be exact", () => {
    const def = getToolDefinition("send_delegation");
    expect(def.legacy).toBe(true);
    expect(def.canBeExact).toBe(false);
    expect(LEGACY_COMPATIBILITY_TOOLS.has("send_delegation")).toBe(true);
  });

  it("only execute_instruction is marked canBeExact (Hosting's exact-output contract)", () => {
    const exactCapable = CARSON_TOOL_ALLOWLIST.filter((t) => t.canBeExact).map((t) => t.name);
    expect(exactCapable).toEqual(["execute_instruction"]);
  });

  it("deterministic/uncertain classification is disjoint and covers every tool", () => {
    for (const name of EXPECTED_23) {
      const inDeterministic = DETERMINISTIC_OUTCOME_TOOLS.has(name);
      const inUncertain = UNCERTAIN_OUTCOME_TOOLS.has(name);
      expect(inDeterministic && inUncertain).toBe(false);
    }
    expect(UNCERTAIN_OUTCOME_TOOLS.size).toBe(4); // send_followup, send_direct_whatsapp_message, save_city, act_on_note
  });

  it("toOpenAiToolsPayload produces a valid OpenAI function-calling shape for every tool", () => {
    const payload = toOpenAiToolsPayload();
    expect(payload).toHaveLength(23);
    for (const entry of payload) {
      expect(entry.type).toBe("function");
      expect(typeof entry.function.name).toBe("string");
      expect(entry.function.parameters.type).toBe("object");
    }
  });
});
