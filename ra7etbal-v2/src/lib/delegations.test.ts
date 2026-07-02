import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../types/task";
import type { Message } from "../types/message";

const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  createMessage: vi.fn(),
  scheduleEscalationMessages: vi.fn(),
}));

vi.mock("./tasks", () => ({ createTask: mocks.createTask }));
vi.mock("./messages", () => ({ createMessage: mocks.createMessage }));
vi.mock("./qstash-escalation", () => ({ scheduleEscalationMessages: mocks.scheduleEscalationMessages }));

import { createDelegationTaskAndMessage } from "./delegations";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scheduleEscalationMessages.mockResolvedValue(undefined);
  mocks.createMessage.mockResolvedValue({ id: "message-1" } as Message);
});

function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    user_id: "user-1",
    description: "Prepare lunch.",
    type: "delegation",
    assigned_to: "Christopher",
    status: "pending",
    needs_follow_up: true,
    confirmation_url: "https://ra7etbal.test/confirm?task=task-1",
    confirmed_at: null,
    due_at: null,
    archived_at: null,
    created_at: "2026-07-02T14:25:42.555Z",
    qstash_message_id: null,
    followup_sent_at: null,
    escalated_at: null,
    image_path: null,
    proof_image_path: null,
    quality_review_status: null,
    quality_review_note: null,
    quality_reviewed_at: null,
    ...overrides,
  } as Task;
}

// ── Protection 3: scheduling must anchor on task.created_at, and only that ──
//
// scheduleEscalationMessages(taskId, sentAt) feeds directly into the per-task
// QStash notBefore computation (qstash-reminder.js: sentMs = new
// Date(sentAt).getTime()). If a future change ever passed a client-generated
// timestamp (e.g. `new Date().toISOString()` captured before the INSERT
// resolves) instead of the DB-returned task.created_at, the per-task trigger
// and the periodic sweep's ageMs re-check would silently diverge — the exact
// shape of defect the Follow-Up Timing Bug investigation ruled out today.
// This test locks in that createDelegationTaskAndMessage only ever uses the
// value createTask() actually returned.
describe("createDelegationTaskAndMessage schedules escalation using task.created_at only", () => {
  it("passes the exact created_at returned by createTask, not a locally-generated timestamp", async () => {
    const dbCreatedAt = "2026-07-02T14:25:42.555Z";
    mocks.createTask.mockResolvedValue(taskFixture({ created_at: dbCreatedAt }));

    await createDelegationTaskAndMessage({
      source: "test",
      userId: "user-1",
      assignee: { name: "Christopher" },
      taskText: "Prepare lunch.",
      confirmationOrigin: "https://ra7etbal.test",
    });

    expect(mocks.scheduleEscalationMessages).toHaveBeenCalledTimes(1);
    const [taskIdArg, sentAtArg] = mocks.scheduleEscalationMessages.mock.calls[0];
    expect(taskIdArg).toBe("task-1");
    expect(sentAtArg).toBe(dbCreatedAt);
  });

  it("does not schedule at all if the task somehow has no created_at (fails closed, never guesses a time)", async () => {
    mocks.createTask.mockResolvedValue(taskFixture({ created_at: null as unknown as string }));

    await createDelegationTaskAndMessage({
      source: "test",
      userId: "user-1",
      assignee: { name: "Christopher" },
      taskText: "Prepare lunch.",
      confirmationOrigin: "https://ra7etbal.test",
    });

    expect(mocks.scheduleEscalationMessages).not.toHaveBeenCalled();
  });

  it("uses the returned created_at even when it differs from the moment the call is made", async () => {
    // Simulates network/DB latency: the row's real created_at (server clock,
    // set at INSERT time) can differ from "now" in the calling process by the
    // time the response arrives. The scheduling anchor must be the DB value,
    // never a value derived from when this function happened to run.
    const dbCreatedAt = "2026-07-02T14:25:40.000Z"; // slightly earlier than "now"
    mocks.createTask.mockResolvedValue(taskFixture({ created_at: dbCreatedAt }));

    await createDelegationTaskAndMessage({
      source: "test",
      userId: "user-1",
      assignee: { name: "Nasira" },
      taskText: "Handle the flowers.",
      confirmationOrigin: "https://ra7etbal.test",
    });

    const [, sentAtArg] = mocks.scheduleEscalationMessages.mock.calls[0];
    expect(sentAtArg).toBe(dbCreatedAt);
    expect(sentAtArg).not.toBe(new Date().toISOString());
  });
});
