import { describe, expect, it, vi } from "vitest";
import {
  actOnCarsonUpdate,
  buildCarsonUpdatesSnapshot,
  parseCarsonUpdatesIntent,
  resolveCarsonUpdateItem,
  summarizeCarsonUpdates,
  type AutomationSummary,
} from "./carson-updates";
import type { CarsonNote } from "./carson-notes";
import type { CarsonTodo } from "./carson-todos";
import type { Task } from "../types/task";

const NOW = new Date("2026-07-16T10:00:00.000Z");

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? "task-1",
    user_id: overrides.user_id ?? "user-1",
    description: overrides.description ?? "Call the tailor",
    type: overrides.type ?? "action",
    assigned_to: overrides.assigned_to ?? null,
    status: overrides.status ?? "pending",
    needs_follow_up: overrides.needs_follow_up ?? false,
    confirmation_url: overrides.confirmation_url ?? null,
    confirmed_at: overrides.confirmed_at ?? null,
    due_at: overrides.due_at ?? null,
    archived_at: overrides.archived_at ?? null,
    created_at: overrides.created_at ?? "2026-07-16T08:00:00.000Z",
    qstash_message_id: overrides.qstash_message_id ?? null,
    followup_sent_at: overrides.followup_sent_at ?? null,
    escalated_at: overrides.escalated_at ?? null,
    image_path: overrides.image_path ?? null,
    proof_image_path: overrides.proof_image_path ?? null,
    quality_review_status: overrides.quality_review_status ?? null,
    quality_review_note: overrides.quality_review_note ?? null,
    quality_reviewed_at: overrides.quality_reviewed_at ?? null,
    worker_reply: overrides.worker_reply ?? null,
    dismissed_at: overrides.dismissed_at ?? null,
  };
}

function todo(overrides: Partial<CarsonTodo> = {}): CarsonTodo {
  return {
    id: overrides.id ?? "todo-1",
    title: overrides.title ?? "Buy flowers",
    description: overrides.description ?? null,
    status: overrides.status ?? "active",
    source: overrides.source ?? "voice",
    created_at: overrides.created_at ?? "2026-07-16T08:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-07-16T08:00:00.000Z",
    completed_at: overrides.completed_at ?? null,
  };
}

function note(overrides: Partial<CarsonNote> = {}): CarsonNote {
  return {
    id: overrides.id ?? "note-1",
    note: overrides.note ?? "Update the Ra7etBal master plan",
    category: overrides.category ?? "general",
    source: overrides.source ?? "voice",
    created_at: overrides.created_at ?? "2026-07-16T08:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-07-16T08:00:00.000Z",
  };
}

function automation(overrides: Partial<AutomationSummary> = {}): AutomationSummary {
  return {
    id: overrides.id ?? "automation-1",
    title: overrides.title ?? "Daily kitchen check",
    instruction: overrides.instruction ?? "Check the kitchen",
    status: overrides.status ?? "active",
    next_run_at: overrides.next_run_at ?? "2026-07-16T18:00:00.000Z",
    created_at: overrides.created_at ?? "2026-07-16T08:00:00.000Z",
  };
}

describe("carson-updates shared management layer", () => {
  it("lists each supported Updates category from the app sources", () => {
    const snapshot = buildCarsonUpdatesSnapshot({
      now: NOW,
      tasks: [
        task({ id: "needs-1", description: "Owner decision", assigned_to: null }),
        task({ id: "waiting-1", description: "Confirm dinner", type: "delegation", assigned_to: "Grace", needs_follow_up: true }),
        task({ id: "reminder-1", description: "Pay bill", type: "reminder", due_at: "2026-07-16T12:00:00.000Z" }),
      ],
      todos: [todo()],
      notes: [note()],
      automations: [automation()],
    });

    expect(summarizeCarsonUpdates(snapshot)).toContain("Needs You:");
    expect(summarizeCarsonUpdates(snapshot, "waiting")).toContain("Confirm dinner");
    expect(snapshot.todos).toHaveLength(1);
    expect(snapshot.notes).toHaveLength(1);
    expect(snapshot.reminders.map((item) => item.title)).toContain("Pay bill");
    expect(snapshot.automations).toHaveLength(1);
  });

  it("resolves ambiguity by asking instead of changing the wrong item", async () => {
    const result = await actOnCarsonUpdate({
      userId: "user-1",
      action: "complete",
      kind: "todo",
      query: "flowers",
    }, {
      tasks: [],
      todos: [todo({ id: "todo-1", title: "Buy flowers" }), todo({ id: "todo-2", title: "Order flowers" })],
      notes: [],
      automations: [],
      completeTodo: vi.fn(),
    });

    expect(result).toContain("more than one");
  });

  it("completes a to-do only after the mutation succeeds", async () => {
    const completeTodo = vi.fn().mockResolvedValue(undefined);
    const result = await actOnCarsonUpdate({
      userId: "user-1",
      action: "complete",
      kind: "todo",
      query: "flowers",
    }, {
      tasks: [],
      todos: [todo({ title: "Buy flowers" })],
      notes: [],
      automations: [],
      completeTodo,
    });

    expect(completeTodo).toHaveBeenCalledWith(expect.objectContaining({ id: "todo-1" }));
    expect(result).toBe("Done. I marked that to-do complete.");
  });

  it("reports failure truthfully when a mutation fails", async () => {
    await expect(actOnCarsonUpdate({
      userId: "user-1",
      action: "complete",
      kind: "todo",
      query: "flowers",
    }, {
      tasks: [],
      todos: [todo({ title: "Buy flowers" })],
      notes: [],
      automations: [],
      completeTodo: vi.fn().mockRejectedValue(new Error("database down")),
    })).rejects.toThrow("database down");
  });

  it("deletes a note through the existing note deletion behavior", async () => {
    const deleteNote = vi.fn().mockResolvedValue(undefined);
    const result = await actOnCarsonUpdate({
      userId: "user-1",
      action: "delete",
      kind: "note",
      query: "master plan",
    }, {
      tasks: [],
      todos: [],
      notes: [note()],
      automations: [],
      deleteNote,
    });

    expect(deleteNote).toHaveBeenCalledWith(expect.objectContaining({ id: "note-1" }));
    expect(result).toBe("Done. I deleted that note.");
  });

  it("converts a note into the Carson to-do source", async () => {
    const createTodo = vi.fn().mockResolvedValue(todo());
    const result = await actOnCarsonUpdate({
      userId: "user-1",
      action: "convert_to_todo",
      kind: "note",
      query: "master plan",
    }, {
      tasks: [],
      todos: [],
      notes: [note()],
      automations: [],
      createTodo,
    });

    expect(createTodo).toHaveBeenCalledWith("Update the Ra7etBal master plan", null, "note");
    expect(result).toBe("Done. I turned that note into a to-do.");
  });

  it("converts a note into a reminder using existing reminder infrastructure", async () => {
    const createReminder = vi.fn().mockResolvedValue(task({ type: "reminder" }));
    const result = await actOnCarsonUpdate({
      userId: "user-1",
      action: "convert_to_reminder",
      kind: "note",
      query: "master plan",
      due_at: "2026-07-17T17:00:00.000Z",
    }, {
      tasks: [],
      todos: [],
      notes: [note()],
      automations: [],
      createReminder,
    });

    expect(createReminder).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      text: "Update the Ra7etBal master plan",
      dueAt: "2026-07-17T17:00:00.000Z",
    }));
    expect(result).toContain("Done. I'll remind you");
  });

  it("reschedules a waiting item through the task update boundary", async () => {
    const updateTask = vi.fn().mockResolvedValue(task());
    const result = await actOnCarsonUpdate({
      userId: "user-1",
      action: "reschedule",
      kind: "waiting",
      query: "dinner",
      due_at: "2026-07-18T12:00:00.000Z",
    }, {
      tasks: [task({ description: "Confirm dinner", type: "delegation", assigned_to: "Grace", needs_follow_up: true })],
      todos: [],
      notes: [],
      automations: [],
      updateTask,
    });

    expect(updateTask).toHaveBeenCalledWith(expect.objectContaining({ description: "Confirm dinner" }), { due_at: "2026-07-18T12:00:00.000Z" });
    expect(result).toContain("Done. I moved it");
  });

  it("pauses and resumes an automation through the automation API boundary", async () => {
    const patchAutomation = vi.fn().mockResolvedValue(automation({ status: "paused" }));
    const pause = await actOnCarsonUpdate({
      userId: "user-1",
      action: "pause",
      kind: "automation",
      query: "kitchen",
    }, {
      tasks: [],
      todos: [],
      notes: [],
      automations: [automation()],
      patchAutomation,
    });
    const resume = await actOnCarsonUpdate({
      userId: "user-1",
      action: "resume",
      kind: "automation",
      query: "kitchen",
    }, {
      tasks: [],
      todos: [],
      notes: [],
      automations: [automation({ status: "paused" })],
      patchAutomation,
    });

    expect(patchAutomation).toHaveBeenNthCalledWith(1, expect.any(Object), { action: "pause" });
    expect(patchAutomation).toHaveBeenNthCalledWith(2, expect.any(Object), { action: "resume" });
    expect(pause).toBe("Done. I paused that automation.");
    expect(resume).toBe("Done. I resumed that automation.");
  });

  it("uses the same parsed intent for typed and voice callers", () => {
    const typed = parseCarsonUpdatesIntent("What am I waiting for?");
    const voice = parseCarsonUpdatesIntent("Pause the daily kitchen automation");

    expect(typed).toEqual({ action: "list", kind: "waiting" });
    expect(voice).toMatchObject({ action: "pause", kind: "automation" });
  });

  it("keeps resolution inside the supplied user-owned data set", () => {
    const snapshot = buildCarsonUpdatesSnapshot({
      now: NOW,
      tasks: [task({ id: "owned", user_id: "user-1", description: "Owned task" })],
      todos: [],
      notes: [],
      automations: [],
    });

    expect(resolveCarsonUpdateItem(snapshot, { kind: "task", query: "other household task" })).toEqual({ status: "not_found" });
  });
});
