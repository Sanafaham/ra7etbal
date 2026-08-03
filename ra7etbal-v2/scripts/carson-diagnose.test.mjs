import { describe, it, expect } from "vitest";
import { expectedClientTools } from "./carson-diagnose.mjs";

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
