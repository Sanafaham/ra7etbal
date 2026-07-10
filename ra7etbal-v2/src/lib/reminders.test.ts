import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskDraft } from "../types/task";

const h = vi.hoisted(() => ({
  drafts: [] as TaskDraft[],
  schedules: [] as Array<[string, string]>,
}));

vi.mock("./tasks", () => ({
  createTask: vi.fn(async (draft: TaskDraft) => {
    h.drafts.push(draft);
    return {
      id: draft.id ?? `task-${h.drafts.length}`,
      created_at: "2026-06-28T12:00:00.000Z",
      confirmed_at: null,
      archived_at: null,
      qstash_message_id: null,
      followup_sent_at: null,
      escalated_at: null,
      image_path: draft.image_path ?? null,
      proof_image_path: null,
      quality_review_status: null,
      quality_review_note: null,
      quality_reviewed_at: null,
      worker_reply: null,
      ...draft,
    } satisfies Task;
  }),
}));

vi.mock("./qstash-reminder", () => ({
  scheduleReminderPush: vi.fn(async (taskId: string, dueAt: string) => {
    h.schedules.push([taskId, dueAt]);
  }),
}));

import { createReminderTask } from "./reminders";

describe("createReminderTask", () => {
  beforeEach(() => {
    h.drafts.length = 0;
    h.schedules.length = 0;
  });

  it("creates the canonical reminder task shape and schedules the reminder push", async () => {
    const dueAt = "2026-06-29T09:00:00.000Z";

    const task = await createReminderTask({
      userId: "user-1",
      text: "  buy flowers  ",
      dueAt,
      source: "test",
    });

    expect(h.drafts).toEqual([
      {
        user_id: "user-1",
        description: "buy flowers",
        type: "reminder",
        assigned_to: null,
        status: "pending",
        needs_follow_up: false,
        confirmation_url: null,
        due_at: dueAt,
      },
    ]);
    expect(task).toMatchObject({ id: "task-1", type: "reminder", due_at: dueAt });
    expect(h.schedules).toEqual([["task-1", dueAt]]);
  });

  it("preserves optional id and image path for Clear My Head attachment saves", async () => {
    const dueAt = "2026-06-29T09:00:00.000Z";

    await createReminderTask({
      id: "task-pregen",
      userId: "user-1",
      text: "buy flowers",
      dueAt,
      source: "save",
      imagePath: "task-images/user-1/task-pregen/photo.jpg",
    });

    expect(h.drafts[0]).toMatchObject({
      id: "task-pregen",
      image_path: "task-images/user-1/task-pregen/photo.jpg",
      due_at: dueAt,
    });
    expect(h.schedules).toEqual([["task-pregen", dueAt]]);
  });

  it("does not schedule a push when dueAt is absent", async () => {
    await createReminderTask({
      userId: "user-1",
      text: "buy flowers",
      dueAt: null,
      source: "inbox-review",
    });

    expect(h.drafts[0]).toMatchObject({
      type: "reminder",
      due_at: null,
    });
    expect(h.schedules).toHaveLength(0);
  });

  it("can use an injected createTask function for store-backed Voice creation", async () => {
    const createTaskFn = vi.fn(async (draft: TaskDraft) => ({
      id: "store-task-1",
      created_at: "2026-06-28T12:00:00.000Z",
      confirmed_at: null,
      archived_at: null,
      qstash_message_id: null,
      followup_sent_at: null,
      escalated_at: null,
      image_path: null,
      proof_image_path: null,
      quality_review_status: null,
      quality_review_note: null,
      quality_reviewed_at: null,
      worker_reply: null,
      ...draft,
    }) satisfies Task);
    const dueAt = "2026-06-29T09:00:00.000Z";

    await createReminderTask({
      userId: "user-1",
      text: "buy flowers",
      dueAt,
      source: "create_reminder",
      createTaskFn,
    });

    expect(createTaskFn).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user-1",
        description: "buy flowers",
        type: "reminder",
        due_at: dueAt,
      }),
    );
    expect(h.schedules).toEqual([["store-task-1", dueAt]]);
  });
});
