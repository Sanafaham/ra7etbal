import { describe, expect, it } from "vitest";
import type { CarsonTypedMessage } from "./carson-typed-messages";
import { buildTypedHistoryContext, normalizeTypedCarsonMessage } from "./carson-typed-message-utils";

function message(role: "user" | "agent", content: string, index: number): CarsonTypedMessage {
  return {
    id: `id-${index}`,
    session_id: "session-id",
    client_message_id: role === "user" ? `client-${index}` : null,
    reply_to_client_message_id: role === "agent" ? `client-${index - 1}` : null,
    role,
    content,
    delivery_status: role === "user" ? "sent" : "responded",
    elevenlabs_conversation_id: null,
    elevenlabs_event_id: null,
    created_at: new Date(index * 1000).toISOString(),
    updated_at: new Date(index * 1000).toISOString(),
  };
}

describe("typed Carson message helpers", () => {
  it("normalizes whitespace and rejects content beyond the database limit", () => {
    expect(normalizeTypedCarsonMessage("  remind   me tomorrow  ")).toBe("remind me tomorrow");
    expect(normalizeTypedCarsonMessage("x".repeat(12_050))).toHaveLength(12_000);
  });

  it("formats only the most recent turns for session continuity", () => {
    const messages = [
      message("user", "first", 1),
      message("agent", "second", 2),
      message("user", "third", 3),
    ];

    expect(buildTypedHistoryContext(messages, 2)).toBe("Carson: second\nOwner: third");
  });

  it("returns no contextual update for an empty history", () => {
    expect(buildTypedHistoryContext([])).toBe("");
  });

  it("never puts failed or interrupted owner instructions back into agent context", () => {
    const interrupted = message("user", "send this only once", 1);
    interrupted.delivery_status = "interrupted";
    const failed = message("user", "this never reached Carson", 2);
    failed.delivery_status = "failed";

    expect(buildTypedHistoryContext([interrupted, failed])).toBe("");
  });
});
