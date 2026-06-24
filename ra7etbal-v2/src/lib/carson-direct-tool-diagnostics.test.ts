import { describe, expect, it } from "vitest";

import {
  buildCarsonDirectToolDiagnosticEvent,
  summarizeDiagnosticInput,
} from "./carson-direct-tool-diagnostics";

describe("carson direct tool diagnostics", () => {
  it("builds a successful direct-tool event with sanitized string previews", () => {
    const longMessage =
      "Please tell Christopher the full private travel itinerary, exact address, and family context that should not be stored in full.";

    const event = buildCarsonDirectToolDiagnosticEvent({
      toolName: "send_direct_whatsapp_message",
      startedAt: "2026-06-24T23:00:00.000Z",
      durationMs: 12.34,
      success: true,
      result: "Done.",
      input: {
        recipient_name: "Christopher",
        message: longMessage,
      },
    });

    expect(event.tool_name).toBe("send_direct_whatsapp_message");
    expect(event.success).toBe(true);
    expect(event.result_type).toBe("string");
    expect(event.duration_ms).toBe(12.3);
    expect(JSON.stringify(event)).not.toContain(longMessage);
    expect(JSON.stringify(event)).toContain("Christopher");
  });

  it("builds a failed direct-tool event with a short error message", () => {
    const event = buildCarsonDirectToolDiagnosticEvent({
      toolName: "create_reminder",
      startedAt: "2026-06-24T23:00:00.000Z",
      durationMs: 4,
      success: false,
      input: {
        description: "Buy milk tomorrow before the guests arrive",
        time_text: "tomorrow at 5",
      },
      error: new Error(
        "A very long private failure message that should be shortened before it is persisted into local diagnostics storage.",
      ),
    });

    expect(event.success).toBe(false);
    expect(event.result_type).toBe("undefined");
    expect(event.error_message).toBeDefined();
    expect(event.error_message!.length).toBeLessThanOrEqual(120);
  });

  it("summarizes arrays and nested objects without storing their contents", () => {
    const summary = summarizeDiagnosticInput({
      photos: ["one-private-file", "two-private-file"],
      nested: { secret: "do not store this raw value" },
    });

    expect(summary).toEqual({
      photos: { type: "array", count: 2 },
      nested: { type: "object", keys: ["secret"] },
    });
  });
});
