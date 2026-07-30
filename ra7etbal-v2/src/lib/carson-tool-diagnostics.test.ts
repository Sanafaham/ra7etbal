import { describe, expect, it, vi } from "vitest";

// The fire-and-forget insert chains two async hops (hashing, then the
// Supabase call) — a single setTimeout(0) macrotask is not reliably enough
// to let it settle before the next assertion. Wait a short, generous margin
// instead of asserting immediately.
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

const h = vi.hoisted(() => ({
  insert: vi.fn(async (_row: Record<string, unknown>) => ({ error: null as { message: string } | null })),
  from: vi.fn((_table: string) => ({})),
}));
h.from.mockImplementation(() => ({ insert: h.insert }));

vi.mock("./supabase", () => ({ supabase: { from: h.from } }));

import { recordCarsonToolDiagnostic } from "./carson-tool-diagnostics";

// Confirmed production incidents (2026-07-29): repeated "Ask Christopher to
// reply..." turns produced zero messages/whatsapp_deliveries rows and zero
// transport logs, with no server-side record of what actually happened
// during the turn — this module closes that gap. These tests prove: no raw
// message/instruction content is ever sent to Supabase, insertion is
// skipped without a user/session id, and a Supabase failure never throws
// (fire-and-forget, matching this codebase's diagnostic-logging convention).
describe("recordCarsonToolDiagnostic", () => {
  it("inserts the expected shape, hashing utterance/message instead of storing raw text", async () => {
    h.insert.mockClear();
    h.from.mockClear();
    recordCarsonToolDiagnostic({
      userId: "user-1",
      sessionId: "conv-1",
      channel: "voice",
      toolName: "send_direct_whatsapp_message",
      stage: "handler_started",
      utterance: "Ask Christopher to reply yes if he can come tomorrow.",
      message: "yes if he can come tomorrow",
    });
    await flush();

    expect(h.from).toHaveBeenCalledWith("carson_tool_diagnostics");
    expect(h.insert).toHaveBeenCalledTimes(1);
    const row = h.insert.mock.calls[0][0];
    expect(row.user_id).toBe("user-1");
    expect(row.session_id).toBe("conv-1");
    expect(row.channel).toBe("voice");
    expect(row.tool_name).toBe("send_direct_whatsapp_message");
    expect(row.stage).toBe("handler_started");
    // Never the raw text.
    expect(JSON.stringify(row)).not.toContain("Ask Christopher");
    expect(JSON.stringify(row)).not.toContain("come tomorrow");
    expect(row.utterance_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.message_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not insert when userId is missing", async () => {
    h.insert.mockClear();
    recordCarsonToolDiagnostic({
      userId: null,
      sessionId: "conv-1",
      channel: "voice",
      toolName: "send_direct_whatsapp_message",
      stage: "invoked",
    });
    await flush();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("does not insert when sessionId is missing", async () => {
    h.insert.mockClear();
    recordCarsonToolDiagnostic({
      userId: "user-1",
      sessionId: null,
      channel: "voice",
      toolName: "send_direct_whatsapp_message",
      stage: "invoked",
    });
    await flush();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("never throws when the Supabase insert rejects", async () => {
    h.insert.mockClear();
    h.insert.mockImplementationOnce(async () => {
      throw new Error("network down");
    });
    expect(() =>
      recordCarsonToolDiagnostic({
        userId: "user-1",
        sessionId: "conv-1",
        channel: "text",
        toolName: "send_direct_whatsapp_message",
        stage: "handler_failure",
        reason: "deliver_message",
      }),
    ).not.toThrow();
    await flush();
  });

  it("stores a safe recipient identifier, never a name", async () => {
    h.insert.mockClear();
    recordCarsonToolDiagnostic({
      userId: "user-1",
      sessionId: "conv-1",
      channel: "voice",
      toolName: "send_direct_whatsapp_message",
      stage: "handler_success",
      recipientPersonId: "person-123",
    });
    await flush();
    const row = h.insert.mock.calls[0][0];
    expect(row.recipient_person_id).toBe("person-123");
  });

  // Carson intent-architecture (2026-07-30): route_people_action's routing
  // decisions must be traceable (action type, app-selected tool) without
  // ever storing the model's raw intendedOutcome/content text.
  it("records action_type and selected_tool for people_action_mapped, never raw envelope content", async () => {
    h.insert.mockClear();
    recordCarsonToolDiagnostic({
      userId: "user-1",
      sessionId: "conv-1",
      channel: "voice",
      toolName: "route_people_action",
      stage: "people_action_mapped",
      actionType: "interpersonal_communication",
      selectedTool: "send_direct_whatsapp_message",
    });
    await flush();
    const row = h.insert.mock.calls[0][0];
    expect(row.action_type).toBe("interpersonal_communication");
    expect(row.selected_tool).toBe("send_direct_whatsapp_message");
    expect(row.utterance_hash).toBeNull();
    expect(row.message_hash).toBeNull();
  });

  it("records legacy_people_tool_bypass when a legacy tool is called directly", async () => {
    h.insert.mockClear();
    recordCarsonToolDiagnostic({
      userId: "user-1",
      sessionId: "conv-1",
      channel: "voice",
      toolName: "send_direct_whatsapp_message",
      stage: "legacy_people_tool_bypass",
    });
    await flush();
    const row = h.insert.mock.calls[0][0];
    expect(row.stage).toBe("legacy_people_tool_bypass");
  });

  it("records the original and final tools for a deterministic legacy redirect", async () => {
    h.insert.mockClear();
    recordCarsonToolDiagnostic({
      userId: "user-1",
      sessionId: "session-redirect",
      channel: "voice",
      toolName: "send_delegation",
      stage: "legacy_people_tool_redirected",
      reason: "plain_communication_selected_as_delegation",
      selectedTool: "send_direct_whatsapp_message",
    });
    await flush();

    expect(h.insert).toHaveBeenCalledWith(expect.objectContaining({
      tool_name: "send_delegation",
      stage: "legacy_people_tool_redirected",
      selected_tool: "send_direct_whatsapp_message",
    }));
  });
});
