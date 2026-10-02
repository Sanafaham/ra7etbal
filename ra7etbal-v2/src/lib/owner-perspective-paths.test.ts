import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../types/message";
import type { Person } from "../types/person";
import type { Task } from "../types/task";

/**
 * Protected: every app-side recipient-facing path resolves owner perspective
 * through the single contract (shared/owner-perspective.js) — direct messages
 * (Talk and Type converge on createDirectMessageRecord), the typed fast path,
 * tracked delegation (message + stored task description), personal notes —
 * and fails closed into the existing owner-facing clarification instead of
 * guessing.
 */

const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  createMessage: vi.fn(),
  scheduleEscalationMessages: vi.fn(),
}));
vi.mock("./tasks", () => ({ createTask: mocks.createTask }));
vi.mock("./messages", () => ({ createMessage: mocks.createMessage }));
vi.mock("./qstash-escalation", () => ({ scheduleEscalationMessages: mocks.scheduleEscalationMessages }));
vi.mock("./ai/compose-message", () => ({ composeMergedMessage: vi.fn().mockResolvedValue(null) }));
vi.mock("./delivery", () => ({ deliverTaskMessage: vi.fn() }));

import { createDirectMessageRecord, directMessageFailureResponse, DirectMessageBoundaryError } from "./direct-messages";
import { executeDirectMessageFastPath } from "./direct-message-fast-path";
import { createDelegationTaskAndMessage } from "./delegations";
import { normalizePersonalNote } from "./personal-note";
import { sanitizeCarsonErrorDetail } from "./carson-social";
import { ownerPerspectiveClarification, ownerPerspectiveDetail } from "./direct-message-owner-normalization";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scheduleEscalationMessages.mockResolvedValue(undefined);
  mocks.createMessage.mockImplementation(async (draft: Partial<Message>) => ({ id: "message-1", ...draft }) as Message);
  mocks.createTask.mockImplementation(async (draft: Partial<Task>) => ({ created_at: "2026-10-02T08:00:00.000Z", ...draft }) as Task);
});

const loulya = (overrides: Partial<Person> = {}): Person => ({
  id: "p-loulya", user_id: "user-1", name: "Loulya", role: "family", phone: "+971500000009", notes: null,
  created_at: "2026-06-23T00:00:00.000Z", relationship: null, is_family: true, responsibilities: null,
  reliability_level: null, follow_up_level: null, delegation_guidance: null, should_not_assign: null, escalate_to: null,
  communication_style: null, whatsapp_opted_in: true, whatsapp_consent_at: "2026-06-23T00:00:00.000Z",
  whatsapp_consent_method: "owner_confirmed", ...overrides,
}) as Person;

describe("Direct message boundary (Talk and Type converge here)", () => {
  const create = (messageText: string, recipient = "Loulya") => {
    const createMessageFn = vi.fn(async (draft: any) => ({ id: "message-1", ...draft }));
    return { createMessageFn, promise: createDirectMessageRecord({ source: "test", userId: "user-1", recipient, messageText, ownerName: "Sana", createMessageFn }) };
  };

  it.each([
    ["I would like her to call me.", "Sana would like you to call Sana."],
    ["I'd like you to call me.", "Sana would like you to call Sana."],
    ["I want you to call me.", "Sana wants you to call Sana."],
    ["put it in my room.", "put it in Sana's room."],
    ["She texted \"I am on my way\" an hour ago.", "She texted \"I am on my way\" an hour ago."],
  ])("stores and sends %j as %j", async (input, expected) => {
    const { createMessageFn, promise } = create(input);
    await promise;
    expect(createMessageFn).toHaveBeenCalledWith(expect.objectContaining({ content: expected }));
  });

  it("fails closed: an unresolvable owner reference creates no message row", async () => {
    for (const input of ["Grace said I would call back.", "I did it myself.", "اتصلي فيني", "Beni ara lütfen"]) {
      const { createMessageFn, promise } = create(input);
      await expect(promise, input).rejects.toMatchObject({ code: "owner_perspective_unresolved" });
      expect(createMessageFn).not.toHaveBeenCalled();
    }
  });

  it("the owner-facing failure reply asks to rephrase only for an owner-perspective refusal", () => {
    const refusal = new DirectMessageBoundaryError("create_message", Object.assign(new Error("x"), { code: "owner_perspective_unresolved" }));
    expect(directMessageFailureResponse(refusal, "Loulya")).toBe(ownerPerspectiveClarification("Loulya"));
    expect(directMessageFailureResponse(new DirectMessageBoundaryError("deliver_message", "Meta 500"), "Loulya"))
      .toBe("I couldn't send Loulya the message. Please try again.");
  });
});

describe("Typed fast path — parity with Talk and fail-closed clarification", () => {
  const deps = () => ({
    createMessageFn: vi.fn(async (draft: any) => ({ id: "message-1", ...draft })),
    deliverTaskMessageFn: vi.fn().mockResolvedValue({ success: true, channel: "whatsapp", deliveryId: "d1", messageId: "wamid.1" }),
  });

  it("Type (pre-resolved) and Talk (resolved at the boundary) store and send the same text", async () => {
    const typed = deps();
    const voice = deps();
    const ctx = { userId: "user-1", displayName: "Sana", people: [loulya()] };
    await executeDirectMessageFastPath("Tell Loulya I would like her to call me.", { ...ctx, normalizeOwnerReference: true }, typed);
    await executeDirectMessageFastPath("Tell Loulya I would like her to call me.", { ...ctx, normalizeOwnerReference: false }, voice);
    const typedContent = typed.createMessageFn.mock.calls[0][0].content;
    expect(typedContent).toBe("Sana would like you to call Sana.");
    expect(voice.createMessageFn.mock.calls[0][0].content).toBe(typedContent);
  });

  it("an unresolvable owner reference sends nothing and answers with the clarification (Type and Talk)", async () => {
    for (const normalizeOwnerReference of [true, false]) {
      const d = deps();
      const result = await executeDirectMessageFastPath("Tell Loulya I did it myself.",
        { userId: "user-1", displayName: "Sana", people: [loulya()], normalizeOwnerReference }, d);
      expect(result).toMatchObject({ handled: true, response: ownerPerspectiveClarification("Loulya") });
      expect(d.createMessageFn).not.toHaveBeenCalled();
      expect(d.deliverTaskMessageFn).not.toHaveBeenCalled();
    }
  });
});

describe("Tracked delegation — message, stored description and personal note", () => {
  const delegate = (taskText: string, note: string | null = null, name = "Grace") =>
    createDelegationTaskAndMessage({ source: "test", userId: "user-1", assignee: { id: "p-g", name, notes: null } as Person, taskText, note, ownerName: "Sana" });

  it("stores the task description as the assignee reads it, and the message carries the same text", async () => {
    const created = await delegate("put it in my room");
    expect(mocks.createTask).toHaveBeenCalledWith(expect.objectContaining({ description: "put it in Sana's room" }));
    expect(created.messageText).toContain("Sana's room");
    expect(created.messageText).not.toMatch(/\bmy\b|\bme\b|\bI\b/);
  });

  it("keeps the assignee's 'you' as the assignee (never rewritten into the owner)", async () => {
    const created = await delegate("let me know when you're done");
    expect(mocks.createTask).toHaveBeenCalledWith(expect.objectContaining({ description: "let Sana know when you're done" }));
    expect(created.messageText).toMatch(/let Sana know when you're done/i);
  });

  it("never produces the retired blanket rewriter's broken grammar or rewritten third parties", async () => {
    const created = await delegate("Tell Sarah I'm running late");
    expect(mocks.createTask).toHaveBeenCalledWith(expect.objectContaining({ description: "Tell Sarah Sana is running late" }));
    expect(created.messageText).not.toMatch(/Sana'm|Sana'd|Sana've|Sana'll/);
    const third = await delegate("Take Loulya to her appointment and call me after");
    expect(third.messageText).toContain("Loulya to her appointment");
  });

  it("a personal note in the owner's own words is rendered in recipient perspective", async () => {
    expect(normalizePersonalNote("I miss you", "Sana", "Loulya")).toBe("Sana misses you.");
    expect(normalizePersonalNote("call me back", "Sana", "Loulya")).toBe("Sana says call Sana back.");
    const created = await delegate("bring the flowers", "I'd love to see you", "Loulya");
    expect(created.messageText).toContain("Sana would love to see you.");
  });

  it("fails closed before anything is created, with a clarification the owner sees (widget sanitizer, Inbox/Todos)", async () => {
    for (const text of ["I did it myself", "Call me and tell her the plan", "اتصلي فيني"]) {
      vi.clearAllMocks();
      let caught: unknown;
      try {
        await delegate(text);
      } catch (err) {
        caught = err;
      }
      expect(caught, text).toMatchObject({ code: "owner_perspective_unresolved", message: ownerPerspectiveClarification("Grace") });
      expect(mocks.createTask).not.toHaveBeenCalled();
      expect(mocks.createMessage).not.toHaveBeenCalled();
      expect(sanitizeCarsonErrorDetail(caught)).toBe(ownerPerspectiveDetail());
    }
    await expect(delegate("bring the flowers", "I did it myself")).rejects.toMatchObject({ code: "owner_perspective_unresolved" });
  });
});
