import { describe, it, expect } from "vitest";
import { expectedClientTools, zipInlineToolsWithIds } from "./carson-diagnose.mjs";

// Regression coverage for the tool-registration-drift check born from the
// Blue Pen incident's true root cause: get_commitment_history was correct in
// the widget and in the prompt, but was never registered on the live
// ElevenLabs agent, so the model could never call it. `audit()` itself needs
// a live ElevenLabs API key and isn't unit-tested here, but the part that
// reads the widget's actual source — the thing that must never silently
// return a stale or empty list — is deterministic and covered directly.
describe("expectedClientTools (Carson Reliability Engineering — tool-registration-drift check)", () => {
  it("extracts get_commitment_history from the live widget source", () => {
    const names = expectedClientTools();
    expect(names).toContain("get_commitment_history");
  });

  it("extracts every known client tool, not a truncated subset", () => {
    const names = expectedClientTools();
    // A representative spread across the widget's tool categories — if any
    // of these silently disappear from the scan, the regex-based extraction
    // itself has drifted from the widget's actual shape.
    for (const name of [
      "execute_instruction",
      "send_delegation",
      "search_calendar_history",
      "get_task_delivery_status",
      "get_operations_summary",
      "get_commitment_history",
      "create_calendar_event",
      "save_instruction",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("never returns an empty or near-empty list — an empty result must throw, not pass silently", () => {
    const names = expectedClientTools();
    expect(names.length).toBeGreaterThan(15);
  });

  it("returns no duplicate tool names", () => {
    const names = expectedClientTools();
    expect(new Set(names).size).toBe(names.length);
  });
});

// Regression guard for a real bug found while registering get_person_history
// (2026-08-04): fetchLiveAgentToolNames() tried to match the inline
// `prompt.tools` array back to `tool_ids` by an `.id`/`.tool_id` field that
// doesn't exist on inline entries. It silently matched nothing, so every
// tool got resolved a SECOND time via a redundant /tools/{id} call — a live
// audit run reported 42 registered tools instead of the real 21, with every
// orphaned tool listed twice. `tools` and `tool_ids` are parallel arrays
// (same order, same length); zipping by index is the correct match.
describe("zipInlineToolsWithIds (regression: must not double-resolve tools)", () => {
  const toolIds = ["tool_a", "tool_b", "tool_c"];
  const inlineTools = [
    { type: "client", name: "send_followup" },
    { type: "client", name: "create_reminder" },
    { type: "client", name: "get_commitment_history" },
  ];

  it("resolves each tool exactly once when tools and tool_ids are parallel arrays", () => {
    const { resolved, unresolvedIds } = zipInlineToolsWithIds(toolIds, inlineTools);
    expect(resolved).toHaveLength(3);
    expect(unresolvedIds).toHaveLength(0);
  });

  it("pairs each resolved tool with its correct id by position, not by a nonexistent id field on the inline entry", () => {
    const { resolved } = zipInlineToolsWithIds(toolIds, inlineTools);
    expect(resolved.find((r) => r.name === "get_commitment_history")?.id).toBe("tool_c");
    expect(resolved.find((r) => r.name === "send_followup")?.id).toBe("tool_a");
  });

  it("never returns duplicate ids — the exact shape of the bug this guards against", () => {
    const { resolved } = zipInlineToolsWithIds(toolIds, inlineTools);
    const ids = resolved.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("falls back to per-id resolution only when the arrays don't align in length", () => {
    const { resolved, unresolvedIds } = zipInlineToolsWithIds(toolIds, inlineTools.slice(0, 2));
    expect(resolved).toHaveLength(0);
    expect(unresolvedIds).toEqual(toolIds);
  });
});
