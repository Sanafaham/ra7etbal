import { describe, expect, it, vi } from "vitest";
import {
  createAndSendDirectMessage,
  createDirectMessageRecord,
  DirectMessageBoundaryError,
  sendDirectMessageRecord,
} from "./direct-messages";
import type { Message } from "../types/message";

describe("direct message boundary", () => {
  it("creates a message row with no task and no confirmation link", async () => {
    const createMessageFn = vi.fn(async (draft: any) => ({ id: "message-1", ...draft }));

    const message = await createDirectMessageRecord({
      source: "test",
      userId: "user-1",
      recipient: " Sana ",
      messageText: " hello ",
      createMessageFn,
    });

    expect(createMessageFn).toHaveBeenCalledWith({
      user_id: "user-1",
      task_id: null,
      recipient: "Sana",
      content: "hello",
      confirmation_url: null,
    });
    expect(message).toMatchObject({
      task_id: null,
      confirmation_url: null,
    });
  });

  it("sends an existing direct message through direct_message mode", async () => {
    const deliverTaskMessageFn = vi.fn(async () => ({
      success: true,
      channel: "whatsapp" as const,
      deliveryId: "delivery-1",
      messageId: "wamid.1",
    }));

    await sendDirectMessageRecord({
      source: "test",
      message: messageRow(),
      phone: "+971500000000",
      ownerName: "Sana",
      deliverTaskMessageFn,
    });

    expect(deliverTaskMessageFn).toHaveBeenCalledWith({
      to: "+971500000000",
      messageText: "Hello",
      confirmationLink: null,
      messageRecordId: "message-1",
      taskId: null,
      sendMode: "direct_message",
      recipientName: "Grace",
      ownerName: "Sana",
    });
  });

  it("allows callers to preserve an adjusted outbound message body", async () => {
    const deliverTaskMessageFn = vi.fn(async () => ({
      success: true,
      channel: "whatsapp" as const,
    }));

    await sendDirectMessageRecord({
      source: "test",
      message: messageRow({ content: "Hello" }),
      messageText: "Hello\n\nAttached photo context: a blue dress.",
      deliverTaskMessageFn,
    });

    expect(deliverTaskMessageFn).toHaveBeenCalledWith(
      expect.objectContaining({
        messageText: "Hello\n\nAttached photo context: a blue dress.",
      }),
    );
  });

  it("createAndSend creates once and does not duplicate delivery rows", async () => {
    const createMessageFn = vi.fn(async (draft: any) => ({ id: "message-1", ...draft }));
    const deliverTaskMessageFn = vi.fn(async () => ({
      success: true,
      channel: "whatsapp" as const,
      deliveryId: "delivery-1",
    }));

    const result = await createAndSendDirectMessage({
      source: "test",
      userId: "user-1",
      recipient: "Grace",
      messageText: "Hello",
      phone: "+971500000000",
      ownerName: "Sana",
      createMessageFn,
      deliverTaskMessageFn,
    });

    expect(result.message.id).toBe("message-1");
    expect(createMessageFn).toHaveBeenCalledTimes(1);
    expect(deliverTaskMessageFn).toHaveBeenCalledTimes(1);
  });

  it("preserves failure stage for message creation failures", async () => {
    await expect(
      createAndSendDirectMessage({
        source: "test",
        userId: "user-1",
        recipient: "Grace",
        messageText: "Hello",
        createMessageFn: vi.fn(async () => {
          throw new Error("insert failed");
        }),
      }),
    ).rejects.toMatchObject({
      name: "DirectMessageBoundaryError",
      stage: "create_message",
      message: "insert failed",
    } satisfies Partial<DirectMessageBoundaryError>);
  });

  it("preserves failure stage for delivery failures", async () => {
    await expect(
      createAndSendDirectMessage({
        source: "test",
        userId: "user-1",
        recipient: "Grace",
        messageText: "Hello",
        createMessageFn: vi.fn(async (draft: any) => ({ id: "message-1", ...draft })),
        deliverTaskMessageFn: vi.fn(async () => ({
          success: false,
          channel: "failed" as const,
          error: "Meta rejected",
        })),
      }),
    ).rejects.toMatchObject({
      name: "DirectMessageBoundaryError",
      stage: "deliver_message",
      message: "Meta rejected",
    } satisfies Partial<DirectMessageBoundaryError>);
  });
});

function messageRow(overrides: Partial<Message> = {}): Message {
  return {
    id: "message-1",
    user_id: "user-1",
    task_id: null,
    recipient: "Grace",
    content: "Hello",
    confirmation_url: null,
    archived_at: null,
    created_at: "2026-06-28T00:00:00.000Z",
    ...overrides,
  };
}
