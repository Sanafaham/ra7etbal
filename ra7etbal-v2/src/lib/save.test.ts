import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ExtractedItem } from "../types/extraction";
import type { Person } from "../types/person";

/**
 * Regression suite for Clear My Head's savePending() routing.
 *
 * Covers the "parked → carson_notes" fix (previously parked items were
 * silently skipped, never persisted anywhere) alongside the pre-existing
 * todo/reminder/delegation paths, to guard against any of them regressing
 * together.
 */

const calls = {
  createTask: [] as any[],
  createTodo: [] as any[],
  saveCarsonNote: [] as any[],
  createMessage: [] as any[],
  scheduleReminderPush: [] as any[],
  scheduleEscalationMessages: [] as any[],
};

vi.mock("./tasks", () => ({
  createTask: vi.fn(async (draft: any) => {
    calls.createTask.push(draft);
    return {
      id: draft.id ?? `task-${calls.createTask.length}`,
      status: "pending",
      created_at: new Date().toISOString(),
      type: draft.type,
      due_at: draft.due_at ?? null,
      assigned_to: draft.assigned_to ?? null,
      image_path: draft.image_path ?? null,
      confirmation_url: draft.confirmation_url ?? null,
    };
  }),
}));

vi.mock("./carson-todos", () => ({
  createTodo: vi.fn(async (title: string) => {
    calls.createTodo.push(title);
    return {
      id: "todo-1",
      title,
      description: null,
      status: "active",
      source: "clear_my_head",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: null,
    };
  }),
}));

vi.mock("./carson-notes", () => ({
  saveCarsonNote: vi.fn(async (note: string) => {
    calls.saveCarsonNote.push(note);
  }),
}));

vi.mock("./messages", () => ({
  createMessage: vi.fn(async (draft: any) => {
    calls.createMessage.push(draft);
    return { id: "msg-1", ...draft };
  }),
}));

vi.mock("./qstash-reminder", () => ({
  scheduleReminderPush: vi.fn(async (...args: any[]) => {
    calls.scheduleReminderPush.push(args);
  }),
}));

vi.mock("./qstash-escalation", () => ({
  scheduleEscalationMessages: vi.fn(async (...args: any[]) => {
    calls.scheduleEscalationMessages.push(args);
  }),
}));

vi.mock("./delegation-message", () => ({
  buildDelegationMessage: vi.fn(() => "Hi, could you buy flowers? Confirm when done."),
}));

vi.mock("./personal-note", () => ({
  injectPersonalNote: vi.fn((msg: string) => msg),
  normalizePersonalNote: vi.fn(() => ""),
  stripClosingLine: vi.fn((msg: string) => msg.replace(/ Confirm when done\.$/, "")),
}));

vi.mock("./ai/compose-message", () => ({
  composeMergedMessage: vi.fn(async () => null),
}));

vi.mock("./image-upload", () => ({
  resizeImage: vi.fn(async (file: File) => file),
  uploadTaskImage: vi.fn(async (userId: string, taskId: string) => `task-images/${userId}/${taskId}/photo.jpg`),
  uploadTaskAttachment: vi.fn(),
}));

vi.mock("./supabase", () => ({
  supabase: {
    from: vi.fn(() => ({
      update: vi.fn(() => ({
        eq: vi.fn(() => ({
          select: vi.fn(() => ({
            single: vi.fn(async () => ({
              data: {
                id: "task-delegate-1",
                status: "pending",
                type: "delegation",
                due_at: null,
                created_at: new Date().toISOString(),
                assigned_to: "Grace",
                confirmation_url: "https://www.ra7etbal.com/confirm?task=task-delegate-1",
              },
              error: null,
            })),
          })),
        })),
      })),
    })),
  },
}));

// Delegation confirmation links must stay on the production worker-facing
// domain even when the owner is testing from a preview origin.
vi.stubGlobal("window", { location: { origin: "https://ra7etbal-v2-preview.vercel.app" } });

import { savePending } from "./save";
import { uploadTaskImage } from "./image-upload";

function item(overrides: Partial<ExtractedItem> = {}): ExtractedItem {
  return {
    id: "i1",
    type: "action",
    description: "Buy flowers",
    assignedTo: null,
    dueAt: null,
    dueText: null,
    suggestedMessage: null,
    personalNote: null,
    needsPerson: false,
    needsClarification: false,
    clarificationQuestion: null,
    ...overrides,
  };
}

const GRACE = {
  id: "p1",
  user_id: "user-1",
  name: "Grace",
  role: "staff",
  phone: "+15555550100",
  notes: null,
  created_at: new Date().toISOString(),
  relationship: null,
  is_family: false,
  responsibilities: null,
  reliability_level: null,
  follow_up_level: null,
  delegation_guidance: null,
  should_not_assign: null,
  escalate_to: null,
  communication_style: null,
  whatsapp_opted_in: true,
  whatsapp_consent_at: new Date().toISOString(),
  whatsapp_consent_method: "owner_confirmed",
} as unknown as Person;

beforeEach(() => {
  calls.createTask.length = 0;
  calls.createTodo.length = 0;
  calls.saveCarsonNote.length = 0;
  calls.createMessage.length = 0;
  calls.scheduleReminderPush.length = 0;
  calls.scheduleEscalationMessages.length = 0;
});

describe("savePending — Clear My Head routing (Notes/To-do/Reminder/Delegation)", () => {
  it("'parked' (passive idea) saves to carson_notes, not tasks", async () => {
    const result = await savePending(
      [item({ type: "parked", description: "Save this idea: test note 123" })],
      "user-1",
    );

    expect(calls.saveCarsonNote).toEqual(["Save this idea: test note 123"]);
    expect(result.notesSaved).toBe(1);
    expect(calls.createTask).toHaveLength(0);
    expect(result.tasks).toHaveLength(0);
    expect(result.skipped).toBe(0);
  });

  it("an empty/whitespace-only parked item is skipped, not saved as a blank note", async () => {
    const result = await savePending([item({ type: "parked", description: "   " })], "user-1");
    expect(calls.saveCarsonNote).toHaveLength(0);
    expect(result.notesSaved).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("'todo' routing still works — routes to carson_todos, not tasks", async () => {
    const result = await savePending(
      [item({ type: "todo", description: "Buy flowers" })],
      "user-1",
    );

    expect(calls.createTodo).toEqual(["Buy flowers"]);
    expect(result.todos).toHaveLength(1);
    expect(calls.createTask).toHaveLength(0);
    expect(calls.saveCarsonNote).toHaveLength(0);
  });

  it("reminders still go to a reminder-typed task with a due date", async () => {
    const dueAt = "2026-06-28T09:00:00.000Z";
    const result = await savePending(
      [item({ type: "reminder", description: "Buy flowers", assignedTo: "__me__", dueAt })],
      "user-1",
    );

    expect(calls.createTask).toHaveLength(1);
    expect(calls.createTask[0].type).toBe("reminder");
    expect(calls.createTask[0].due_at).toBe(dueAt);
    expect(result.tasks[0].type).toBe("reminder");
    expect(calls.scheduleReminderPush).toHaveLength(1);
    expect(calls.saveCarsonNote).toHaveLength(0);
    expect(calls.createTodo).toHaveLength(0);
  });

  it("delegations still go to a delegation-typed task + paired message", async () => {
    await savePending(
      [item({ type: "delegation", description: "Buy flowers", assignedTo: "Grace" })],
      "user-1",
      "Sana",
      [GRACE],
    );

    expect(calls.createTask).toHaveLength(1);
    expect(calls.createTask[0].type).toBe("delegation");
    expect(calls.createTask[0].assigned_to).toBe("Grace");
    expect(calls.createMessage).toHaveLength(1);
    expect(calls.createMessage[0].recipient).toBe("Grace");
    expect(calls.scheduleEscalationMessages).toHaveLength(1);
    expect(calls.saveCarsonNote).toHaveLength(0);
    expect(calls.createTodo).toHaveLength(0);
  });

  it("direct messages create one message row with no task and no confirmation link", async () => {
    const result = await savePending(
      [item({ type: "message", description: "Dinner is at 9", assignedTo: "Grace" })],
      "user-1",
      "Sana",
      [GRACE],
    );

    expect(result.messages).toHaveLength(1);
    expect(calls.createTask).toHaveLength(0);
    expect(calls.createMessage).toHaveLength(1);
    expect(calls.createMessage[0]).toMatchObject({
      user_id: "user-1",
      task_id: null,
      recipient: "Grace",
      confirmation_url: null,
    });
    expect(result.messages[0].task_id).toBeNull();
    expect(result.messages[0].confirmation_url).toBeNull();
    expect(calls.scheduleEscalationMessages).toHaveLength(0);
    expect(calls.scheduleReminderPush).toHaveLength(0);
  });

  it("image delegations keep image_path and still get message, canonical link, and escalation", async () => {
    const file = new File(["image"], "reference.jpg", { type: "image/jpeg" });
    const imageFiles = new Map<string, File>([["img-delegation", file]]);

    const result = await savePending(
      [
        item({
          id: "img-delegation",
          type: "delegation",
          description: "Find this blouse",
          assignedTo: "Grace",
        }),
      ],
      "user-1",
      "Sana",
      [GRACE],
      imageFiles,
    );

    expect(result.tasks).toHaveLength(1);
    expect(result.messages).toHaveLength(1);
    const task = result.tasks[0];
    expect(task.image_path).toBe(`task-images/user-1/${task.id}/photo.jpg`);
    expect(task.confirmation_url).toBe(`https://www.ra7etbal.com/confirm?task=${task.id}`);
    expect(result.imagePathsByTaskId.get(task.id)).toBe(task.image_path);
    expect(calls.createTask[0]).toMatchObject({
      id: task.id,
      type: "delegation",
      assigned_to: "Grace",
      image_path: task.image_path,
      confirmation_url: `https://www.ra7etbal.com/confirm?task=${task.id}`,
    });
    expect(calls.createMessage[0]).toMatchObject({
      task_id: task.id,
      recipient: "Grace",
      confirmation_url: `https://www.ra7etbal.com/confirm?task=${task.id}`,
    });
    expect(calls.scheduleEscalationMessages).toEqual([[task.id, task.created_at]]);
  });

  it("broken image upload fails before creating a task, message, or schedule", async () => {
    vi.mocked(uploadTaskImage).mockRejectedValueOnce(new Error("Image upload failed: storage offline"));
    const file = new File(["image"], "reference.jpg", { type: "image/jpeg" });
    const imageFiles = new Map<string, File>([["img-fail", file]]);

    await expect(
      savePending(
        [
          item({
            id: "img-fail",
            type: "delegation",
            description: "Find this blouse",
            assignedTo: "Grace",
          }),
        ],
        "user-1",
        "Sana",
        [GRACE],
        imageFiles,
      ),
    ).rejects.toThrow("Image upload failed");

    expect(calls.createTask).toHaveLength(0);
    expect(calls.createMessage).toHaveLength(0);
    expect(calls.scheduleEscalationMessages).toHaveLength(0);
  });

  it("processes a mixed batch — notes/todo/reminder/delegation are independently routed", async () => {
    const result = await savePending(
      [
        item({ id: "a", type: "parked", description: "Remember this thought: ideas for the garden" }),
        item({ id: "b", type: "todo", description: "Renew passport" }),
        item({ id: "c", type: "reminder", description: "Call the vet", assignedTo: "__me__", dueAt: "2026-06-29T10:00:00.000Z" }),
        item({ id: "d", type: "delegation", description: "Pick up dry cleaning", assignedTo: "Grace" }),
      ],
      "user-1",
      "Sana",
      [GRACE],
    );

    expect(result.notesSaved).toBe(1);
    expect(result.todos).toHaveLength(1);
    expect(result.tasks).toHaveLength(2); // reminder + delegation
    expect(calls.saveCarsonNote).toEqual(["Remember this thought: ideas for the garden"]);
    expect(calls.createTodo).toEqual(["Renew passport"]);
  });
});
