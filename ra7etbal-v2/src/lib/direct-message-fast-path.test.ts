import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./messages", () => ({
  createMessage: vi.fn(),
}));

import {
  executeDirectMessageFastPath,
  parseSimpleDirectMessage,
} from "./direct-message-fast-path";
import type { Message } from "../types/message";
import type { Person } from "../types/person";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Voice Carson direct message fast path", () => {
  it("sends a simple direct message without calling /api/anthropic", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const createMessageFn = vi.fn().mockResolvedValue(messageRow());
    const deliverTaskMessageFn = vi.fn().mockResolvedValue({
      success: true,
      channel: "whatsapp",
      deliveryId: "delivery-1",
      messageId: "wamid.1",
    });

    const result = await executeDirectMessageFastPath(
      "send Sana a WhatsApp message saying Ra7etBal notification test",
      {
        userId: "user-1",
        displayName: "Sana",
        people: [person()],
      },
      { createMessageFn, deliverTaskMessageFn },
    );

    expect(result).toMatchObject({
      handled: true,
      status: "sent",
      response: "Done. I sent Sana the message.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/api/anthropic")),
    ).toBe(false);
  });

  it("reaches the direct WhatsApp send path for simple messages", async () => {
    const createMessageFn = vi.fn().mockResolvedValue(
      messageRow({ content: "Ra7etBal notification test" }),
    );
    const deliverTaskMessageFn = vi.fn().mockResolvedValue({
      success: true,
      channel: "whatsapp",
      deliveryId: "delivery-1",
      messageId: "wamid.1",
    });

    await executeDirectMessageFastPath(
      "message Sana saying Ra7etBal notification test",
      {
        userId: "user-1",
        displayName: "Sana",
        people: [person()],
      },
      { createMessageFn, deliverTaskMessageFn },
    );

    expect(createMessageFn).toHaveBeenCalledWith({
      user_id: "user-1",
      task_id: null,
      recipient: "Sana",
      content: "Ra7etBal notification test",
      confirmation_url: null,
    });
    expect(deliverTaskMessageFn).toHaveBeenCalledWith({
      to: "+971500000000",
      messageText: "Ra7etBal notification test",
      confirmationLink: null,
      messageRecordId: "message-1",
      taskId: null,
      sendMode: "direct_message",
      recipientName: "Sana",
      ownerName: "Sana",
    });
  });

  it("handles the exact voice retest shape with now plus Say colon", () => {
    expect(
      parseSimpleDirectMessage(
        "Send Sana a WhatsApp test message now. Say: Ra7etBal notification test.",
        [person()],
      ),
    ).toEqual({
      recipientName: "Sana",
      messageText: "Ra7etBal notification test.",
    });
  });

  it("blocks non-consented recipients before message creation or send", async () => {
    const createMessageFn = vi.fn();
    const deliverTaskMessageFn = vi.fn();

    const result = await executeDirectMessageFastPath(
      "tell Sana Ra7etBal notification test",
      {
        userId: "user-1",
        displayName: "Sana",
        people: [person({ whatsapp_opted_in: false })],
      },
      { createMessageFn, deliverTaskMessageFn },
    );

    expect(result).toMatchObject({
      handled: true,
      status: "blocked",
      reason: "missing_consent",
      response: "WhatsApp consent is not recorded for Sana.",
    });
    expect(createMessageFn).not.toHaveBeenCalled();
    expect(deliverTaskMessageFn).not.toHaveBeenCalled();
  });

  it("leaves task/delegation language for the normal extraction path", () => {
    expect(
      parseSimpleDirectMessage("tell Sana to call me tomorrow", [person()]),
    ).toBeNull();
    expect(
      parseSimpleDirectMessage("send Sana a task to confirm the documents", [person()]),
    ).toBeNull();
    expect(
      parseSimpleDirectMessage("remind Sana to call me", [person()]),
    ).toBeNull();
  });
});

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: "person-1",
    user_id: "user-1",
    name: "Sana",
    role: "family",
    phone: "+971500000000",
    notes: null,
    created_at: "2026-06-23T00:00:00.000Z",
    relationship: null,
    is_family: true,
    responsibilities: null,
    reliability_level: null,
    follow_up_level: null,
    delegation_guidance: null,
    should_not_assign: null,
    escalate_to: null,
    communication_style: null,
    whatsapp_opted_in: true,
    whatsapp_consent_at: "2026-06-23T00:00:00.000Z",
    whatsapp_consent_method: "owner_confirmed",
    ...overrides,
  };
}

function messageRow(overrides: Partial<Message> = {}): Message {
  return {
    id: "message-1",
    user_id: "user-1",
    task_id: null,
    recipient: "Sana",
    content: "Ra7etBal notification test",
    confirmation_url: null,
    archived_at: null,
    created_at: "2026-06-23T00:00:00.000Z",
    ...overrides,
  };
}
