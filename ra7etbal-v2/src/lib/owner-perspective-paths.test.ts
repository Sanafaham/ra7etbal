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
const compose = vi.hoisted(() => ({ composeMergedMessage: vi.fn() }));
vi.mock("./ai/compose-message", () => compose);
vi.mock("./delivery", () => ({ deliverTaskMessage: vi.fn() }));
// Proof that no deterministic path falls back to a model call to verify text.
const anthropic = vi.hoisted(() => ({ callAnthropicProxy: vi.fn() }));
vi.mock("./anthropic-client", () => anthropic);

import { createAndSendDirectMessage, createDirectMessageRecord, directMessageFailureResponse, DirectMessageBoundaryError } from "./direct-messages";
import { executeDirectMessageFastPath } from "./direct-message-fast-path";
import { createDelegationTaskAndMessage } from "./delegations";
import { normalizePersonalNote } from "./personal-note";
import { sanitizeCarsonErrorDetail } from "./carson-social";
import { OwnerPerspectiveError, ownerPerspectiveClarification, ownerPerspectiveDetail } from "./direct-message-owner-normalization";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scheduleEscalationMessages.mockResolvedValue(undefined);
  compose.composeMergedMessage.mockResolvedValue(null);
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
    for (const input of ["Grace said I would call back.", "I did it myself.", "اتصلي فيني", "Beni ara lütfen", "بروح السوق بعدين", "Eve geliyorum"]) {
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

describe("Owner-facing refusal text", () => {
  it("identity and language refusals show their own truthful detail, not the pronoun explanation", () => {
    const identity = new OwnerPerspectiveError("recipient_not_bound", "قريس", "I couldn't match \"قريس\" to anyone in your People list, so nothing was saved or sent. Please use their name as it appears there.");
    expect(sanitizeCarsonErrorDetail(identity)).toMatch(/couldn't match "قريس"/);
    expect(identity.message).toMatch(/^I didn't send anything to قريس\. I couldn't match/);
    expect(sanitizeCarsonErrorDetail(new OwnerPerspectiveError("owner_reflexive", "Grace"))).toBe(ownerPerspectiveDetail());
  });
});

describe("Deterministic no-model paths — Arabic/Turkish bodies fail closed (never guessed, never sent to a model)", () => {
  const deps = () => ({
    createMessageFn: vi.fn(async (draft: any) => ({ id: "message-1", ...draft })),
    deliverTaskMessageFn: vi.fn().mockResolvedValue({ success: true, channel: "whatsapp", deliveryId: "d1", messageId: "wamid.1" }),
  });
  const ctx = { userId: "user-1", displayName: "Sana", people: [loulya()] };

  it("existing safe English still sends; ambiguous English still fails closed", async () => {
    const ok = deps();
    await executeDirectMessageFastPath("Tell Loulya I miss you.", { ...ctx, normalizeOwnerReference: true }, ok);
    expect(ok.createMessageFn.mock.calls[0][0].content).toBe("Sana misses you.");
    const ambiguous = deps();
    const result = await executeDirectMessageFastPath("Tell Loulya Grace said I would call back.", { ...ctx, normalizeOwnerReference: true }, ambiguous);
    expect(result).toMatchObject({ handled: true, status: "blocked", reason: "owner_perspective_unresolved" });
    expect(ambiguous.createMessageFn).not.toHaveBeenCalled();
  });

  it.each([
    ["Tell Loulya الغدا جاهز", "Arabic, no first-person marker"],
    ["Tell Loulya بروح السوق", "Arabic first person (frozen backstop)"],
    ["Tell Loulya akşam yemeği hazır", "Turkish, no first-person marker"],
    ["Tell Loulya eve geliyorum", "Turkish first person (frozen backstop)"],
  ])("%s (%s): Type and Talk send nothing and answer with the rephrase request", async (input) => {
    for (const normalizeOwnerReference of [true, false]) {
      const d = deps();
      const result = await executeDirectMessageFastPath(input, { ...ctx, normalizeOwnerReference }, d);
      expect(result, `${input} normalize=${normalizeOwnerReference}`).toMatchObject({ handled: true, response: ownerPerspectiveClarification("Loulya") });
      expect(d.createMessageFn).not.toHaveBeenCalled();
      expect(d.deliverTaskMessageFn).not.toHaveBeenCalled();
    }
    expect(anthropic.callAnthropicProxy).not.toHaveBeenCalled();
  });

  it("Talk's send_direct_whatsapp_message boundary: model-written Arabic/Turkish with no declared status fails closed (C-01 parity)", async () => {
    for (const messageText of ["الغدا جاهز", "Akşam yemeği hazır"]) {
      const d = deps();
      let caught: unknown;
      try {
        await createAndSendDirectMessage({ source: "send_direct_whatsapp_message", userId: "user-1", recipient: "Loulya",
          messageText, phone: "+971500000009", ownerName: "Sana", createMessageFn: d.createMessageFn, deliverTaskMessageFn: d.deliverTaskMessageFn });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DirectMessageBoundaryError);
      expect(directMessageFailureResponse(caught, "Loulya")).toBe(ownerPerspectiveClarification("Loulya"));
      expect(d.createMessageFn).not.toHaveBeenCalled();
      expect(d.deliverTaskMessageFn).not.toHaveBeenCalled();
    }
    expect(anthropic.callAnthropicProxy).not.toHaveBeenCalled();
  });

  it("the same Arabic text IS accepted from the existing extraction call when it declared 'rendered' (composed voice)", async () => {
    const createMessageFn = vi.fn(async (draft: any) => ({ id: "message-1", ...draft }));
    await createDirectMessageRecord({ source: "save", userId: "user-1", recipient: "Loulya", messageText: "الغدا جاهز",
      ownerName: "Sana", declaredPerspective: "rendered", createMessageFn });
    expect(createMessageFn).toHaveBeenCalledWith(expect.objectContaining({ content: "الغدا جاهز" }));
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

  it("the existing note-merge model call's output is used only when nothing in it needs resolving; otherwise the verified parts are used", async () => {
    compose.composeMergedMessage.mockResolvedValueOnce("Hi Loulya, Sana would love to see you. Could you bring the flowers?");
    expect((await delegate("bring the flowers", "I'd love to see you", "Loulya")).messageText)
      .toBe("Hi Loulya, Sana would love to see you. Could you bring the flowers?");
    // Deterministic message built only from the verified task and note.
    const deterministic = (await delegate("bring the flowers", "I'd love to see you", "Loulya")).messageText;
    for (const merged of ["Hi Loulya, I'd love to see you. Could you bring the flowers?", "Hi Loulya, could you tell Loulya to bring the flowers?", "مرحبا لوليا، جيبي الورد"]) {
      compose.composeMergedMessage.mockResolvedValueOnce(merged);
      const created = await delegate("bring the flowers", "I'd love to see you", "Loulya");
      // The merge lost track of who is who: its output is discarded, never repaired.
      expect(created.messageText, merged).toBe(deterministic);
    }
    expect(deterministic).toContain("Sana would love to see you.");
  });

  it("Talk/Type parity: the delegation fast path (owner's own words, no declared status) and the extraction path (declared) store the same text", async () => {
    const fast = await delegate("call me after the appointment");
    vi.clearAllMocks();
    const extracted = await createDelegationTaskAndMessage({ source: "save", userId: "user-1", assignee: { id: "p-g", name: "Grace", notes: null } as Person,
      taskText: "call Sana after the appointment", ownerName: "Sana", ownerPerspective: "rendered" });
    expect(fast.task.description).toBe("call Sana after the appointment");
    expect(extracted.task.description).toBe(fast.task.description);
    expect(extracted.messageText).toBe(fast.messageText);
  });

  it("an Arabic delegation in the owner's own words (no model call) fails closed; declared extraction text is stored", async () => {
    await expect(delegate("جيبي الاغراض")).rejects.toMatchObject({ code: "owner_perspective_unresolved" });
    expect(mocks.createTask).not.toHaveBeenCalled();
    const created = await createDelegationTaskAndMessage({ source: "save", userId: "user-1", assignee: { id: "p-g", name: "Grace", notes: null } as Person,
      taskText: "جيبي الاغراض لسنا", ownerName: "Sana", ownerPerspective: "rendered" });
    expect(created.task.description).toBe("جيبي الاغراض لسنا");
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
