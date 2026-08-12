import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../types/task";

const h = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

vi.mock("./qstash-reminder", () => ({
  REMINDER_CREATION_CONTRACT_VERSION: "reminder-creation-v1",
  createRoutedReminder: vi.fn(async (input: Record<string, unknown>) => {
    h.calls.push(input);
    const evidence = input.routingEvidence as { operation_id?: string } | undefined;
    const contract = input.creationContract as { operation_id?: string } | undefined;
    return {
      id: evidence?.operation_id ?? contract?.operation_id ?? "missing",
      user_id: "user-1",
      description: input.description,
      type: "reminder",
      assigned_to: null,
      status: "pending",
      needs_follow_up: false,
      confirmation_url: null,
      confirmed_at: null,
      due_at: input.dueAt,
      archived_at: null,
      created_at: "2026-06-28T12:00:00.000Z",
      qstash_message_id: null,
      followup_sent_at: null,
      escalated_at: null,
      image_path: input.imagePath ?? null,
      proof_image_path: null,
      quality_review_status: null,
      quality_review_note: null,
      quality_reviewed_at: null,
      worker_reply: null,
    } as Task;
  }),
}));

import { createReminderTask } from "./reminders";

describe("createReminderTask server authority", () => {
  beforeEach(() => h.calls.splice(0));

  it("routes a normal current reminder through the server contract", async () => {
    const task = await createReminderTask({
      id: "4c438c39-7b8f-43f6-9085-0b4b64905bf8",
      userId: "user-1",
      text: "  buy flowers  ",
      dueAt: "2026-06-29T09:00:00.000Z",
      source: "inbox",
    });

    expect(h.calls).toEqual([expect.objectContaining({
      description: "buy flowers",
      dueAt: "2026-06-29T09:00:00.000Z",
      creationContract: {
        contract_version: "reminder-creation-v1",
        source: "inbox",
        operation_id: "4c438c39-7b8f-43f6-9085-0b4b64905bf8",
      },
    })]);
    expect(task.type).toBe("reminder");
  });

  it("preserves pre-generated id and image path for extracted attachment saves", async () => {
    await createReminderTask({
      id: "4c438c39-7b8f-43f6-9085-0b4b64905bf8",
      userId: "user-1",
      text: "buy flowers",
      dueAt: null,
      source: "save",
      imagePath: "task-images/user-1/4c438c39-7b8f-43f6-9085-0b4b64905bf8/photo.jpg",
    });
    expect(h.calls[0]).toMatchObject({
      dueAt: null,
      imagePath: "task-images/user-1/4c438c39-7b8f-43f6-9085-0b4b64905bf8/photo.jpg",
      creationContract: { source: "save" },
    });
  });

  it("uses voice routing evidence instead of a generic creation contract", async () => {
    const routingEvidence = {
      contract_version: "one-time-routing-v1" as const,
      destination: "owner_reminder" as const,
      decision_source: "fresh_user_transcript" as const,
      client_build: "build-1",
      operation_id: "4c438c39-7b8f-43f6-9085-0b4b64905bf8",
    };
    await createReminderTask({
      userId: "user-1",
      text: "buy flowers",
      dueAt: "2026-06-29T09:00:00.000Z",
      source: "voice",
      routingEvidence,
    });
    expect(h.calls[0]).toMatchObject({ routingEvidence, creationContract: undefined });
  });

  it("never calls the authenticated direct task insert boundary", async () => {
    const source = await import("./reminders?raw").then((module) => module.default as string);
    expect(source).not.toContain("createTask(");
    expect(source).not.toContain('.from("tasks")');
  });
});
