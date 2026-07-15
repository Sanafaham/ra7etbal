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
      response: "WhatsApp accepted the message to Sana. I'll watch for delivery updates.",
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

  // ── Recipient after "to" ─────────────────────────────────────────────────
  // ElevenLabs agent paraphrases spoken intent as "send a WhatsApp message to
  // Sana saying X" rather than forwarding the verbatim user transcript. The
  // fast path must match this form so it never falls through to /api/anthropic.

  it("matches 'send a WhatsApp message to Sana saying X' (recipient after to)", () => {
    expect(
      parseSimpleDirectMessage(
        "send a WhatsApp message to Sana saying Ra7etBal notification test",
        [person()],
      ),
    ).toEqual({
      recipientName: "Sana",
      messageText: "Ra7etBal notification test",
    });
  });

  it("matches 'send a WhatsApp message to Sana. Say: X'", () => {
    expect(
      parseSimpleDirectMessage(
        "send a WhatsApp message to Sana. Say: Ra7etBal notification test",
        [person()],
      ),
    ).toEqual({
      recipientName: "Sana",
      messageText: "Ra7etBal notification test",
    });
  });

  it("returns missing_person when recipient in 'to NAME' is not in People", async () => {
    const createMessageFn = vi.fn();
    const deliverTaskMessageFn = vi.fn();

    const result = await executeDirectMessageFastPath(
      "send a WhatsApp message to Grace saying hello",
      {
        userId: "user-1",
        displayName: "Sana",
        people: [person()], // only Sana, not Grace
      },
      { createMessageFn, deliverTaskMessageFn },
    );

    expect(result).toMatchObject({
      handled: true,
      status: "blocked",
      reason: "missing_person",
      response: "I don't have Grace in People yet.",
    });
    expect(createMessageFn).not.toHaveBeenCalled();
    expect(deliverTaskMessageFn).not.toHaveBeenCalled();
  });

  // ── Other required patterns ──────────────────────────────────────────────

  it("matches 'text Sana X'", () => {
    expect(
      parseSimpleDirectMessage("text Sana Ra7etBal notification test", [person()]),
    ).toEqual({
      recipientName: "Sana",
      messageText: "Ra7etBal notification test",
    });
  });

  it("matches 'send Sana X' (no WhatsApp filler words)", () => {
    expect(
      parseSimpleDirectMessage("send Sana Ra7etBal notification test", [person()]),
    ).toEqual({
      recipientName: "Sana",
      messageText: "Ra7etBal notification test",
    });
  });

  it("matches 'tell Sana X'", () => {
    expect(
      parseSimpleDirectMessage("tell Sana Ra7etBal notification test", [person()]),
    ).toEqual({
      recipientName: "Sana",
      messageText: "Ra7etBal notification test",
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
    expect(
      parseSimpleDirectMessage("send Loulya call me", [person({ name: "Loulya" })]),
    ).toBeNull();
    expect(
      parseSimpleDirectMessage("message Grace to call me", [person({ name: "Grace" })]),
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
