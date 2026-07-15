import { describe, expect, it, vi } from "vitest";
import {
  executeVoiceTaskControl,
  resolveVoiceTaskControl,
  type VoiceTaskContext,
} from "./voice-task-control";
import type { Task } from "../types/task";

function task(overrides: Partial<Task> & Pick<Task, "id" | "description" | "type">): Task {
  return {
    user_id: "user-1",
    assigned_to: null,
    status: "pending",
    needs_follow_up: false,
    confirmation_url: null,
    confirmed_at: null,
    due_at: null,
    archived_at: null,
    created_at: "2026-06-29T04:00:00.000Z",
    qstash_message_id: null,
    followup_sent_at: null,
    escalated_at: null,
    image_path: null,
    proof_image_path: null,
    quality_review_status: null,
    quality_review_note: null,
    quality_reviewed_at: null,
    worker_reply: null,
    dismissed_at: null,
    ...overrides,
  };
}

const insuranceReminder = task({
  id: "reminder-1",
  description: "Renew passport",
  type: "reminder",
  due_at: "2026-06-30T10:00:00.000Z",
});

const flowerReminder = task({
  id: "reminder-4",
  description: "Buy flowers",
  type: "reminder",
  due_at: "2026-06-30T12:00:00.000Z",
});

const alarmReminder = task({
  id: "reminder-2",
  description: "Set the alarm",
  type: "reminder",
  due_at: "2026-06-29T04:42:00.000Z",
});

const ghulamDelegation = task({
  id: "delegation-1",
  description: "Have the cars clean and ready by 8 AM",
  type: "delegation",
  assigned_to: "Ghulam",
  needs_follow_up: true,
  confirmation_url: "https://ra7etbal.test/confirm?task=delegation-1",
});

const graceDelegation = task({
  id: "delegation-2",
  description: "Send the flower inventory",
  type: "delegation",
  assigned_to: "Grace",
  needs_follow_up: true,
  confirmation_url: "https://ra7etbal.test/confirm?task=delegation-2",
});

async function run(rawText: string, tasks: Task[], currentTask?: VoiceTaskContext | null) {
  const markDoneTask = vi.fn(async (item: Task) => ({ ...item, status: "done" as const }));
  const deleteTask = vi.fn(async () => undefined);
  const result = await executeVoiceTaskControl({
    rawText,
    tasks,
    currentTask,
    markDoneTask,
    deleteTask,
  });
  return { result, markDoneTask, deleteTask };
}

describe("voice task control", () => {
  it("voice marks a reminder done", async () => {
    const { result, markDoneTask, deleteTask } = await run(
      "mark my passport reminder done",
      [insuranceReminder],
    );

    expect(result.reply).toBe("Done. I marked that reminder done.");
    expect(markDoneTask).toHaveBeenCalledWith(insuranceReminder);
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it("voice completes a flower reminder", async () => {
    const { result, markDoneTask } = await run(
      "complete the flower reminder",
      [flowerReminder],
    );

    expect(result.reply).toBe("Done. I marked that reminder done.");
    expect(markDoneTask).toHaveBeenCalledWith(flowerReminder);
  });

  it("voice deletes or cancels a reminder", async () => {
    const { result, markDoneTask, deleteTask } = await run(
      "cancel the alarm reminder",
      [alarmReminder],
    );

    expect(result.reply).toBe("Done. I deleted that reminder.");
    expect(deleteTask).toHaveBeenCalledWith(alarmReminder);
    expect(markDoneTask).not.toHaveBeenCalled();
  });

  it("voice marks Ghulam delegation done as owner override", async () => {
    const { result, markDoneTask } = await run(
      "mark Ghulam's task complete",
      [ghulamDelegation],
    );

    expect(result.reply).toBe("Done. I marked that task done.");
    expect(markDoneTask).toHaveBeenCalledWith(ghulamDelegation);
  });

  it("voice closes a waiting item by assignee", async () => {
    const { result, markDoneTask, deleteTask } = await run(
      "close the waiting item for Grace",
      [graceDelegation],
    );

    expect(result.reply).toBe("Done. I marked that task done.");
    expect(markDoneTask).toHaveBeenCalledWith(graceDelegation);
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it("voice treats handled waiting language as completion", async () => {
    const { result, markDoneTask } = await run(
      "that Grace item is handled",
      [graceDelegation],
    );

    expect(result.reply).toBe("Done. I marked that task done.");
    expect(markDoneTask).toHaveBeenCalledWith(graceDelegation);
  });

  it("voice treats remove-from-waiting language as completion, not deletion", async () => {
    const { result, markDoneTask, deleteTask } = await run(
      "remove Ghulam from waiting",
      [ghulamDelegation],
    );

    expect(result.reply).toBe("Done. I marked that task done.");
    expect(markDoneTask).toHaveBeenCalledWith(ghulamDelegation);
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it("voice marks Grace delegation done as owner override", async () => {
    const { result, markDoneTask } = await run(
      "mark Grace's flower inventory done",
      [graceDelegation],
    );

    expect(result.reply).toBe("Done. I marked that task done.");
    expect(markDoneTask).toHaveBeenCalledWith(graceDelegation);
  });

  it("this/it/that resolves only when current task context exists", async () => {
    const withoutContext = await run("mark this done", [insuranceReminder]);
    expect(withoutContext.result.reply).toBe("Which task do you mean?");
    expect(withoutContext.markDoneTask).not.toHaveBeenCalled();

    const currentTask: VoiceTaskContext = {
      id: insuranceReminder.id,
      description: insuranceReminder.description,
      assigned_to: insuranceReminder.assigned_to,
      type: insuranceReminder.type,
    };
    const withContext = await run("mark this done", [insuranceReminder], currentTask);
    expect(withContext.result.reply).toBe("Done. I marked that reminder done.");
    expect(withContext.markDoneTask).toHaveBeenCalledWith(insuranceReminder);
  });

  it("ambiguous match asks for clarification", async () => {
    const secondInsurance = task({
      id: "reminder-3",
      description: "Renew insurance paperwork",
      type: "reminder",
    });
    const { result, markDoneTask, deleteTask } = await run(
      "cancel insurance reminder",
      [
        task({ ...insuranceReminder, description: "Call insurance company" }),
        secondInsurance,
      ],
    );

    expect(result.reply).toMatch(/more than one matching task/i);
    expect(markDoneTask).not.toHaveBeenCalled();
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it("missing item returns a clear not-found response", async () => {
    const { result, markDoneTask, deleteTask } = await run(
      "mark the passport reminder done",
      [flowerReminder],
    );

    expect(result.reply).toBe("I couldn't find an open task matching that. Which one do you mean?");
    expect(markDoneTask).not.toHaveBeenCalled();
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it("does not return a technical inability response", async () => {
    const { result } = await run("close Ghulam's car task", [ghulamDelegation]);

    expect(result.reply).not.toMatch(/don['’]?t have the ability|directly close|technical|support/i);
  });

  it("does not treat calendar cancellation as task control", () => {
    const result = resolveVoiceTaskControl(
      "cancel my dentist appointment",
      [insuranceReminder],
      null,
    );

    expect(result.status).toBe("not_task_control");
  });
});
