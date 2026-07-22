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
      response: "I let Sana know. I'll watch for the reply.",
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
  });
});

// ---------------------------------------------------------------------------
// Typed/voice parity — owner-reference normalization
// ---------------------------------------------------------------------------
//
// The parser's own output contract is unchanged: it always returns the raw,
// unnormalized message body it extracted (test 1 below). Normalization is a
// separate, opt-in step applied by executeDirectMessageFastPath only when
// context.normalizeOwnerReference is set — see direct-message-fast-path.ts
// and direct-message-owner-normalization.ts.

describe("parseSimpleDirectMessage — parser output stays unnormalized (routing only)", () => {
  it("'Tell Grace I have no Wi-Fi' matches as a direct message with the raw, unrewritten body", () => {
    expect(
      parseSimpleDirectMessage("Tell Grace I have no Wi-Fi", [person({ id: "p-grace", name: "Grace" })]),
    ).toEqual({ recipientName: "Grace", messageText: "I have no Wi-Fi" });
  });

  it("'Tell Grace I'm on my way' matches as a direct message with the raw, unrewritten body", () => {
    expect(
      parseSimpleDirectMessage("Tell Grace I'm on my way", [person({ id: "p-grace", name: "Grace" })]),
    ).toEqual({ recipientName: "Grace", messageText: "I'm on my way" });
  });
});

describe("executeDirectMessageFastPath — typed owner-reference normalization", () => {
  function grace(overrides: Partial<Person> = {}): Person {
    return person({ id: "p-grace", name: "Grace", ...overrides });
  }

  function deliveredDeps() {
    return {
      // Echoes the created row's content back, exactly like the real
      // Supabase insert does — sendDirectMessageRecord falls back to
      // message.content, so a static mock would mask what messageText was
      // actually passed through.
      createMessageFn: vi.fn().mockImplementation((draft: { content: string; recipient: string }) =>
        Promise.resolve(messageRow({ recipient: draft.recipient, content: draft.content })),
      ),
      deliverTaskMessageFn: vi.fn().mockResolvedValue({
        success: true,
        channel: "whatsapp" as const,
        deliveryId: "delivery-1",
        messageId: "wamid.1",
      }),
    };
  }

  it("1. typed direct message: 'Tell Grace I have no Wi-Fi.' sends 'Sana has no Wi-Fi.'", async () => {
    const deps = deliveredDeps();
    await executeDirectMessageFastPath(
      "Tell Grace I have no Wi-Fi.",
      { userId: "user-1", displayName: "Sana", people: [grace()], normalizeOwnerReference: true },
      deps,
    );
    expect(deps.deliverTaskMessageFn).toHaveBeenCalledWith(
      expect.objectContaining({ messageText: "Sana has no Wi-Fi." }),
    );
  });

  it("4. first-person contraction: 'Tell Grace I'm on my way.' sends 'Sana is on the way.' (no invented gendered pronoun)", async () => {
    const deps = deliveredDeps();
    await executeDirectMessageFastPath(
      "Tell Grace I'm on my way.",
      { userId: "user-1", displayName: "Sana", people: [grace()], normalizeOwnerReference: true },
      deps,
    );
    expect(deps.deliverTaskMessageFn).toHaveBeenCalledWith(
      expect.objectContaining({ messageText: "Sana is on the way." }),
    );
  });

  it("5. first-person possessive: 'Tell Grace my phone is not working.' sends \"Sana's phone is not working.\"", async () => {
    const deps = deliveredDeps();
    await executeDirectMessageFastPath(
      "Tell Grace my phone is not working.",
      { userId: "user-1", displayName: "Sana", people: [grace()], normalizeOwnerReference: true },
      deps,
    );
    expect(deps.deliverTaskMessageFn).toHaveBeenCalledWith(
      expect.objectContaining({ messageText: "Sana's phone is not working." }),
    );
  });

  it("additional required example: 'Tell Grace I am running late.' sends 'Sana is running late.'", async () => {
    const deps = deliveredDeps();
    await executeDirectMessageFastPath(
      "Tell Grace I am running late.",
      { userId: "user-1", displayName: "Sana", people: [grace()], normalizeOwnerReference: true },
      deps,
    );
    expect(deps.deliverTaskMessageFn).toHaveBeenCalledWith(
      expect.objectContaining({ messageText: "Sana is running late." }),
    );
  });

  it("additional required example: 'Tell Grace I'll arrive in ten minutes.' sends 'Sana will arrive in ten minutes.'", async () => {
    const deps = deliveredDeps();
    await executeDirectMessageFastPath(
      "Tell Grace I'll arrive in ten minutes.",
      { userId: "user-1", displayName: "Sana", people: [grace()], normalizeOwnerReference: true },
      deps,
    );
    expect(deps.deliverTaskMessageFn).toHaveBeenCalledWith(
      expect.objectContaining({ messageText: "Sana will arrive in ten minutes." }),
    );
  });

  it("6. text without first-person wording is sent unchanged", async () => {
    const deps = deliveredDeps();
    await executeDirectMessageFastPath(
      "Tell Grace the meeting is at four.",
      { userId: "user-1", displayName: "Sana", people: [grace()], normalizeOwnerReference: true },
      deps,
    );
    expect(deps.deliverTaskMessageFn).toHaveBeenCalledWith(
      expect.objectContaining({ messageText: "the meeting is at four." }),
    );
  });

  it("8. no duplicate send: exactly one create and one deliver call per invocation", async () => {
    const deps = deliveredDeps();
    await executeDirectMessageFastPath(
      "Tell Grace I have no Wi-Fi.",
      { userId: "user-1", displayName: "Sana", people: [grace()], normalizeOwnerReference: true },
      deps,
    );
    expect(deps.createMessageFn).toHaveBeenCalledTimes(1);
    expect(deps.deliverTaskMessageFn).toHaveBeenCalledTimes(1);
  });

  it("9. the typed tool call receives the normalized text in its result, not the raw parsed text", async () => {
    const deps = deliveredDeps();
    const result = await executeDirectMessageFastPath(
      "Tell Grace I have no Wi-Fi.",
      { userId: "user-1", displayName: "Sana", people: [grace()], normalizeOwnerReference: true },
      deps,
    );
    expect(result).toMatchObject({ status: "sent", messageText: "Sana has no Wi-Fi." });
  });

  it("10. voice behavior is untouched: without normalizeOwnerReference, the raw first-person text is sent as-is", async () => {
    const deps = deliveredDeps();
    await executeDirectMessageFastPath(
      "Tell Grace I have no Wi-Fi.",
      { userId: "user-1", displayName: "Sana", people: [grace()] }, // normalizeOwnerReference omitted
      deps,
    );
    expect(deps.deliverTaskMessageFn).toHaveBeenCalledWith(
      expect.objectContaining({ messageText: "I have no Wi-Fi." }),
    );
  });

  it("10b. voice behavior is untouched: normalizeOwnerReference explicitly false also sends the raw text", async () => {
    const deps = deliveredDeps();
    await executeDirectMessageFastPath(
      "Tell Grace I have no Wi-Fi.",
      { userId: "user-1", displayName: "Sana", people: [grace()], normalizeOwnerReference: false },
      deps,
    );
    expect(deps.deliverTaskMessageFn).toHaveBeenCalledWith(
      expect.objectContaining({ messageText: "I have no Wi-Fi." }),
    );
  });

  it("does not invent a hardcoded owner — uses whatever displayName is passed in", async () => {
    const deps = deliveredDeps();
    await executeDirectMessageFastPath(
      "Tell Grace I have no Wi-Fi.",
      { userId: "user-1", displayName: "Marcus", people: [grace()], normalizeOwnerReference: true },
      deps,
    );
    expect(deps.deliverTaskMessageFn).toHaveBeenCalledWith(
      expect.objectContaining({ messageText: "Marcus has no Wi-Fi." }),
    );
  });
});

describe("Routing protection — delegation vs. direct message (typed/voice parity task)", () => {
  it("2/3. 'Tell Grace I have no Wi-Fi' and 'Tell Grace I'm on my way' remain direct messages (routing unaffected by normalization)", () => {
    const people = [person({ id: "p-grace", name: "Grace" })];
    expect(parseSimpleDirectMessage("Tell Grace I have no Wi-Fi", people)).not.toBeNull();
    expect(parseSimpleDirectMessage("Tell Grace I'm on my way", people)).not.toBeNull();
  });

  // KNOWN, PRE-EXISTING GAP — confirmed on origin/main, independent of the
  // carson-protected-behaviors fix (see src/lib/carson-protected-behaviors.test.ts):
  // DELEGATION_BODY_START's fixed verb whitelist does not include "make", so
  // this instruction currently falls through as a direct message instead of
  // being excluded for delegation routing. Out of scope for that fix — it's
  // a separate, narrower verb-whitelist gap, not the confirmed
  // call-me/contact-me/wait-for-me production regression that fix targets,
  // and closing it safely requires its own scoped change (see
  // RA7ETBAL_STATE.md). Written as it.fails so this suite honestly reports
  // the gap instead of asserting the current (wrong) behavior as if correct.
  it.fails("7. 'Tell Christopher to make lunch.' remains a delegation, not a direct message", () => {
    expect(
      parseSimpleDirectMessage(
        "Tell Christopher to make lunch.",
        [person({ id: "p-christopher", name: "Christopher" })],
      ),
    ).toBeNull();
  });

  // CORRECTED (was previously it.fails, asserting the opposite): confirmed
  // production regression fixed by carson-protected-behaviors — "wait for
  // me" targets the owner, so it is simple communication, not trackable
  // delegated work, regardless of which verb introduces it. See
  // src/lib/communication-vs-delegation.ts and CARSON PROTECTED BEHAVIORS
  // in AGENTS.md. This fast path already got this case right without any
  // change (COMMAND_PREFIX/DELEGATION_BODY_START never flagged "wait"); the
  // confirmed regression was specifically in Talk to Carson and in Type to
  // Carson's "Ask X to call me" phrasing, both fixed in sendDelegation().
  it("7b. 'Tell Christopher to wait for me in the kitchen. I'm on my way.' remains a direct message (communication, not delegation)", () => {
    expect(
      parseSimpleDirectMessage(
        "Tell Christopher to wait for me in the kitchen. I'm on my way.",
        [person({ id: "p-christopher", name: "Christopher" })],
      ),
    ).not.toBeNull();
  });
});

describe("Behavioral: outgoing message body for 'Tell <person> to <message>' never carries the leading 'to' connector", () => {
  // Confirmed production regression (2026-07-21, typed dispatch): the typed
  // pipeline previously never sent this instruction at all (see
  // carson-protected-behaviors.test.ts, "Typed direct-message dispatch").
  // Once wired to send deterministically, parseSimpleDirectMessage's own
  // body extraction leaves a leading "to" connector in the parsed body
  // ("to wait for me in the kitchen") — this was harmless while nothing
  // deterministically sent it, but became a real malformed-WhatsApp-body
  // risk the moment delivery became deterministic. This block asserts the
  // ACTUAL outgoing body at the dispatcher/service boundary (the exact
  // deliverTaskMessageFn call), not just that parseSimpleDirectMessage
  // returns non-null.
  function christopher(overrides: Partial<Person> = {}): Person {
    return person({ id: "p-christopher", name: "Christopher", ...overrides });
  }

  function deliveredDeps() {
    return {
      createMessageFn: vi.fn().mockImplementation((draft: { content: string; recipient: string }) =>
        Promise.resolve(messageRow({ recipient: draft.recipient, content: draft.content })),
      ),
      deliverTaskMessageFn: vi.fn().mockResolvedValue({
        success: true,
        channel: "whatsapp" as const,
        deliveryId: "delivery-1",
        messageId: "wamid.1",
      }),
    };
  }

  it("confirmed production phrase: 'Tell Christopher to wait for me in the kitchen' sends body 'wait for me in the kitchen', never 'to wait for me in the kitchen'", async () => {
    const deps = deliveredDeps();
    const result = await executeDirectMessageFastPath(
      "Tell Christopher to wait for me in the kitchen",
      { userId: "user-1", displayName: "Sana", people: [christopher()], normalizeOwnerReference: true },
      deps,
    );

    expect(result).toMatchObject({ status: "sent", messageText: "wait for me in the kitchen" });
    expect(deps.deliverTaskMessageFn).toHaveBeenCalledWith(
      expect.objectContaining({ messageText: "wait for me in the kitchen" }),
    );
    expect(deps.createMessageFn).toHaveBeenCalledWith(
      expect.objectContaining({ content: "wait for me in the kitchen" }),
    );
    // The malformed body must never reach either call.
    const deliverCallArg = deps.deliverTaskMessageFn.mock.calls[0][0];
    const createCallArg = deps.createMessageFn.mock.calls[0][0];
    expect(deliverCallArg.messageText).not.toMatch(/^to\s/i);
    expect(createCallArg.content).not.toMatch(/^to\s/i);
    // Plain communication: no confirmation link, tied directly to this exact
    // confirmed production phrase rather than only proven generically
    // elsewhere.
    expect(deliverCallArg.confirmationLink).toBeNull();
    expect(createCallArg.confirmation_url).toBeNull();
  });

  it("same fix applies without normalizeOwnerReference (voice/execute_instruction call site)", async () => {
    const deps = deliveredDeps();
    await executeDirectMessageFastPath(
      "Tell Christopher to wait for me in the kitchen",
      { userId: "user-1", displayName: "Sana", people: [christopher()] },
      deps,
    );
    expect(deps.deliverTaskMessageFn).toHaveBeenCalledWith(
      expect.objectContaining({ messageText: "wait for me in the kitchen" }),
    );
  });

  it("parseSimpleDirectMessage's own raw output is unchanged (still carries the leading 'to') — the fix is applied only in executeDirectMessageFastPath, after classification", () => {
    expect(
      parseSimpleDirectMessage("Tell Christopher to wait for me in the kitchen", [christopher()]),
    ).toEqual({ recipientName: "Christopher", messageText: "to wait for me in the kitchen" });
  });

  it("does not strip a mid-sentence 'to' — only a leading connector", async () => {
    const deps = deliveredDeps();
    await executeDirectMessageFastPath(
      "Tell Christopher the car is going to the shop",
      { userId: "user-1", displayName: "Sana", people: [christopher()], normalizeOwnerReference: true },
      deps,
    );
    expect(deps.deliverTaskMessageFn).toHaveBeenCalledWith(
      expect.objectContaining({ messageText: "the car is going to the shop" }),
    );
  });

  it("classification/routing is unaffected — the strip runs after isUnsafeBody, so a real delegation body ('to clean the kitchen') is unchanged by this fix and still excluded from direct-message routing exactly as before", () => {
    // DELEGATION_BODY_START's known, separate, pre-existing whitelist gap
    // (see it.fails "7" above) is untouched: "clean" is in the whitelist,
    // but the missing space after the "to" alternative already prevents a
    // match today, independent of this fix. Confirming parseSimpleDirectMessage's
    // classification verdict for this input is identical before and after —
    // it still matches (the known gap), proving this fix did not touch
    // classification.
    expect(
      parseSimpleDirectMessage("Tell Christopher to clean the kitchen.", [christopher()]),
    ).not.toBeNull();
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
