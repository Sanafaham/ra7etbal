import { describe, expect, it, vi } from "vitest";
import {
  actOnCarsonUpdate,
  buildProactiveDismissalContinuation,
  buildCarsonUpdatesSnapshot,
  chooseProactiveCarsonUpdate,
  extractInstructionAfterLeadingDismissal,
  getCarsonUpdateItemKey,
  isCarsonProactiveUpdateDismissal,
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

  it("selects Needs You before lower-priority items", () => {
    const snapshot = buildCarsonUpdatesSnapshot({
      now: NOW,
      tasks: [
        task({ id: "needs-1", description: "Approve the substitute flowers", type: "delegation", assigned_to: "Grace", quality_review_status: "substitute_review" }),
      ],
      todos: [todo({ id: "todo-1", title: "Buy labels" })],
      notes: [note()],
      automations: [automation()],
    });

    const prompt = chooseProactiveCarsonUpdate(snapshot, { now: NOW });

    expect(prompt?.item.id).toBe("needs-1");
    expect(prompt?.item.kind).toBe("needs_you");
    expect(prompt?.prompt).toContain("needs your decision");
    expect(prompt?.prompt).toContain("Do you want to give a different instruction or delete it?");
  });

  it("selects an overdue reminder before a normal To-do", () => {
    const snapshot = buildCarsonUpdatesSnapshot({
      now: NOW,
      tasks: [
        task({ id: "reminder-1", description: "Pay internet bill", type: "reminder", due_at: "2026-07-16T09:00:00.000Z" }),
      ],
      todos: [todo({ id: "todo-1", title: "Buy folders" })],
      notes: [],
      automations: [],
    });

    const prompt = chooseProactiveCarsonUpdate(snapshot, { now: NOW });

    expect(prompt?.item.id).toBe("reminder-1");
    expect(prompt?.actions).toEqual(["mark done", "reschedule", "snooze", "delete"]);
    expect(prompt?.prompt).toContain("overdue");
  });

  it("selects only one proactive item at a time", () => {
    const snapshot = buildCarsonUpdatesSnapshot({
      now: NOW,
      tasks: [
        task({ id: "needs-1", description: "Approve proof", quality_review_status: "uncertain" }),
        task({ id: "needs-2", description: "Review change", escalated_at: "2026-07-16T08:00:00.000Z" }),
      ],
      todos: [todo()],
      notes: [note()],
      automations: [automation()],
    });

    const prompt = chooseProactiveCarsonUpdate(snapshot, { now: NOW });

    expect(prompt).toBeTruthy();
    expect(prompt?.prompt).not.toContain("Buy flowers");
    expect(prompt?.prompt).not.toContain("Daily kitchen check");
  });

  it("gives notes the correct proactive action choices", () => {
    const snapshot = buildCarsonUpdatesSnapshot({
      now: NOW,
      tasks: [],
      todos: [],
      notes: [note()],
      automations: [],
    });

    const prompt = chooseProactiveCarsonUpdate(snapshot, { now: NOW });

    expect(prompt?.item.kind).toBe("note");
    expect(prompt?.actions).toEqual(["turn into To-do", "turn into reminder", "leave as note", "delete"]);
    expect(prompt?.prompt).toContain("leave it as a note");
  });

  it("gives waiting items follow-up, keep-waiting, or cancel choices", () => {
    const snapshot = buildCarsonUpdatesSnapshot({
      now: NOW,
      tasks: [task({ id: "waiting-1", description: "Confirm documents", type: "delegation", assigned_to: "Grace", needs_follow_up: true })],
      todos: [],
      notes: [],
      automations: [],
    });

    const prompt = chooseProactiveCarsonUpdate(snapshot, { now: NOW });

    expect(prompt?.item.kind).toBe("waiting");
    expect(prompt?.actions).toEqual(["follow up", "keep waiting", "cancel"]);
    expect(prompt?.prompt).toContain("Should I follow up, keep waiting, or cancel it?");
  });

  it("gives automations keep, pause, update, or delete choices", () => {
    const snapshot = buildCarsonUpdatesSnapshot({
      now: NOW,
      tasks: [],
      todos: [],
      notes: [],
      automations: [automation()],
    });

    const prompt = chooseProactiveCarsonUpdate(snapshot, { now: NOW });

    expect(prompt?.item.kind).toBe("automation");
    expect(prompt?.actions).toEqual(["keep", "pause", "update", "delete"]);
    expect(prompt?.prompt).toContain("keep it, pause it, change it, or delete it");
  });

  it("does not show the same proactive item twice when session-suppressed", () => {
    const snapshot = buildCarsonUpdatesSnapshot({
      now: NOW,
      tasks: [task({ id: "needs-1", description: "Approve proof", quality_review_status: "uncertain" })],
      todos: [todo({ id: "todo-1", title: "Buy labels" })],
      notes: [],
      automations: [],
    });
    const first = chooseProactiveCarsonUpdate(snapshot, { now: NOW });

    const second = chooseProactiveCarsonUpdate(snapshot, {
      now: NOW,
      suppressedItemKeys: first ? [first.itemKey] : [],
    });

    expect(first?.item.id).toBe("needs-1");
    expect(second?.item.id).toBe("todo-1");
  });

  it("uses the same proactive selection result for typed and voice callers", () => {
    const snapshot = buildCarsonUpdatesSnapshot({
      now: NOW,
      tasks: [
        task({ id: "waiting-1", description: "Confirm dinner", type: "delegation", assigned_to: "Grace", needs_follow_up: true }),
      ],
      todos: [todo({ id: "todo-1", title: "Buy labels" })],
      notes: [note()],
      automations: [automation()],
    });

    const typed = chooseProactiveCarsonUpdate(snapshot, { now: NOW });
    const voice = chooseProactiveCarsonUpdate(snapshot, { now: NOW });

    expect(typed?.itemKey).toBe(voice?.itemKey);
    expect(typed?.actions).toEqual(voice?.actions);
  });

  it("builds stable item keys for current-session not-now suppression", () => {
    const snapshot = buildCarsonUpdatesSnapshot({
      now: NOW,
      tasks: [],
      todos: [],
      notes: [note({ id: "note-9" })],
      automations: [],
    });
    const key = getCarsonUpdateItemKey(snapshot.notes[0]);

    expect(key).toBe("note:note-9");
    expect(chooseProactiveCarsonUpdate(snapshot, { now: NOW, suppressedItemKeys: [key] })).toBeNull();
    expect(isCarsonProactiveUpdateDismissal("not now")).toBe(true);
    expect(isCarsonProactiveUpdateDismissal("let's do it")).toBe(false);
  });

  it("splits a leading dismissal phrase from a trailing instruction", () => {
    expect(extractInstructionAfterLeadingDismissal("Not now. Ask Grace to call me."))
      .toBe("Ask Grace to call me.");
    expect(extractInstructionAfterLeadingDismissal("not now, ask Grace to call me"))
      .toBe("ask Grace to call me");
    expect(extractInstructionAfterLeadingDismissal("Later - tell Ghulam to bring the car"))
      .toBe("tell Ghulam to bring the car");
  });

  it("returns null for a pure dismissal with nothing left to act on", () => {
    expect(extractInstructionAfterLeadingDismissal("Not now")).toBeNull();
    expect(extractInstructionAfterLeadingDismissal("not now.")).toBeNull();
    expect(extractInstructionAfterLeadingDismissal("later")).toBeNull();
  });

  it("returns null when the dismissal phrase is not at the start", () => {
    expect(extractInstructionAfterLeadingDismissal("Ask Grace to call me, not now")).toBeNull();
    expect(extractInstructionAfterLeadingDismissal("Let's do it")).toBeNull();
  });

  it("continues to the next eligible proactive item after not-now suppression", () => {
    const snapshot = buildCarsonUpdatesSnapshot({
      now: NOW,
      tasks: [
        task({ id: "needs-1", description: "Approve proof", quality_review_status: "uncertain" }),
      ],
      todos: [todo({ id: "todo-1", title: "Buy labels" })],
      notes: [note()],
      automations: [],
    });
    const first = chooseProactiveCarsonUpdate(snapshot, { now: NOW });
    expect(first?.itemKey).toBe("task:needs-1");

    const continuation = buildProactiveDismissalContinuation({
      current: first!,
      snapshot,
      now: NOW,
    });

    expect(continuation.suppressedItemKey).toBe("task:needs-1");
    expect(continuation.nextPrompt?.itemKey).toBe("todo:todo-1");
    expect(continuation.message).toContain("Buy labels");
    expect(continuation.message).toContain("complete it, reschedule it, or delete it");
  });

  it("does not repeat an overdue reminder through its reminder category after not-now", () => {
    const snapshot = buildCarsonUpdatesSnapshot({
      now: NOW,
      tasks: [
        task({
          id: "task-master-plan",
          description: "Update the Ra7etBal master plan",
          type: "reminder",
          due_at: "2026-07-16T09:00:00.000Z",
        }),
      ],
      todos: [],
      notes: [],
      automations: [],
    });

    const displayed = chooseProactiveCarsonUpdate(snapshot, { now: NOW });
    const continuation = buildProactiveDismissalContinuation({
      current: displayed!,
      snapshot,
      now: NOW,
    });

    expect(displayed?.itemKey).toBe("task:task-master-plan");
    expect(continuation.suppressedItemKey).toBe("task:task-master-plan");
    expect(continuation.nextPrompt).toBeNull();
    expect(continuation.message).toBe("That is everything requiring attention right now.");
  });

  it("keeps item identity stable when the title is translated or reformatted", () => {
    const englishSnapshot = buildCarsonUpdatesSnapshot({
      now: NOW,
      tasks: [
        task({
          id: "task-master-plan",
          description: "Update the Ra7etBal master plan",
          type: "reminder",
          due_at: "2026-07-16T09:00:00.000Z",
        }),
      ],
      todos: [],
      notes: [],
      automations: [],
    });
    const reformattedSnapshot = buildCarsonUpdatesSnapshot({
      now: NOW,
      tasks: [
        task({
          id: "task-master-plan",
          description: "Update the راحة بال master plan.",
          type: "reminder",
          due_at: "2026-07-16T09:00:00.000Z",
        }),
      ],
      todos: [],
      notes: [],
      automations: [],
    });

    const english = chooseProactiveCarsonUpdate(englishSnapshot, { now: NOW });
    const reformatted = chooseProactiveCarsonUpdate(reformattedSnapshot, { now: NOW });

    expect(english?.item.title).not.toBe(reformatted?.item.title);
    expect(english?.itemKey).toBe("task:task-master-plan");
    expect(reformatted?.itemKey).toBe("task:task-master-plan");
    expect(chooseProactiveCarsonUpdate(reformattedSnapshot, {
      now: NOW,
      suppressedItemKeys: [english!.itemKey],
    })).toBeNull();
  });

  it("does not mutate the skipped item merely by continuing after not-now", () => {
    const skippedTask = task({
      id: "needs-1",
      description: "Approve proof",
      quality_review_status: "uncertain",
      status: "pending",
    });
    const before = structuredClone(skippedTask);
    const completeTodo = vi.fn();
    const deleteNote = vi.fn();
    const snapshot = buildCarsonUpdatesSnapshot({
      now: NOW,
      tasks: [skippedTask],
      todos: [todo({ id: "todo-1", title: "Buy labels" })],
      notes: [note()],
      automations: [],
    });
    const first = chooseProactiveCarsonUpdate(snapshot, { now: NOW });

    buildProactiveDismissalContinuation({
      current: first!,
      snapshot,
      now: NOW,
    });

    expect(skippedTask).toEqual(before);
    expect(completeTodo).not.toHaveBeenCalled();
    expect(deleteNote).not.toHaveBeenCalled();
  });

  it("does not show the skipped proactive item again in the same session", () => {
    const snapshot = buildCarsonUpdatesSnapshot({
      now: NOW,
      tasks: [
        task({ id: "needs-1", description: "Approve proof", quality_review_status: "uncertain" }),
      ],
      todos: [todo({ id: "todo-1", title: "Buy labels" })],
      notes: [],
      automations: [],
    });
    const first = chooseProactiveCarsonUpdate(snapshot, { now: NOW });
    const continuation = buildProactiveDismissalContinuation({
      current: first!,
      snapshot,
      now: NOW,
    });
    const thirdSelection = chooseProactiveCarsonUpdate(snapshot, {
      now: NOW,
      suppressedItemKeys: [continuation.suppressedItemKey, continuation.nextPrompt!.itemKey],
    });

    expect(continuation.nextPrompt?.itemKey).not.toBe(first?.itemKey);
    expect(thirdSelection).toBeNull();
  });

  it("reports clearly when not-now leaves no further eligible items", () => {
    const snapshot = buildCarsonUpdatesSnapshot({
      now: NOW,
      tasks: [],
      todos: [],
      notes: [note({ id: "note-1", note: "Update the Ra7etBal master plan" })],
      automations: [],
    });
    const first = chooseProactiveCarsonUpdate(snapshot, { now: NOW });
    const continuation = buildProactiveDismissalContinuation({
      current: first!,
      snapshot,
      now: NOW,
    });

    expect(continuation.nextPrompt).toBeNull();
    expect(continuation.message).toBe("That is everything requiring attention right now.");
  });

  it("uses the same not-now continuation result for typed and voice callers", () => {
    const snapshot = buildCarsonUpdatesSnapshot({
      now: NOW,
      tasks: [
        task({ id: "needs-1", description: "Approve proof", quality_review_status: "uncertain" }),
      ],
      todos: [todo({ id: "todo-1", title: "Buy labels" })],
      notes: [],
      automations: [],
    });
    const first = chooseProactiveCarsonUpdate(snapshot, { now: NOW });

    const typed = buildProactiveDismissalContinuation({ current: first!, snapshot, now: NOW });
    const voice = buildProactiveDismissalContinuation({ current: first!, snapshot, now: NOW });

    expect(typed.message).toBe(voice.message);
    expect(typed.nextPrompt?.itemKey).toBe(voice.nextPrompt?.itemKey);
  });

  it("does not mutate records while selecting a proactive prompt", () => {
    const completeTodo = vi.fn();
    const deleteNote = vi.fn();
    const snapshot = buildCarsonUpdatesSnapshot({
      now: NOW,
      tasks: [],
      todos: [todo()],
      notes: [note()],
      automations: [],
    });

    const prompt = chooseProactiveCarsonUpdate(snapshot, { now: NOW });

    expect(prompt?.item.kind).toBe("todo");
    expect(completeTodo).not.toHaveBeenCalled();
    expect(deleteNote).not.toHaveBeenCalled();
  });
});
