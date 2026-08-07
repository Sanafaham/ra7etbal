import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTasksStore } from "./tasks";
import {
  archiveDoneTasks,
  deleteTask,
  dismissConfirmationNotices,
  listTasks,
} from "../lib/tasks";
import { selectConfirmationNotices } from "../lib/dismissed-notifications";
import type { Task } from "../types/task";

vi.mock("../lib/tasks", () => ({
  archiveDoneTasks: vi.fn(),
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  deleteTasks: vi.fn(),
  dismissConfirmationNotices: vi.fn(),
  listTasks: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock("../lib/qstash-reminder", () => ({
  cancelReminderPush: vi.fn(),
  rescheduleReminderPush: vi.fn(),
  scheduleReminderPush: vi.fn(),
}));

const listTasksMock = vi.mocked(listTasks);
const dismissConfirmationNoticesMock = vi.mocked(dismissConfirmationNotices);
const archiveDoneTasksMock = vi.mocked(archiveDoneTasks);
const deleteTaskMock = vi.mocked(deleteTask);

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    user_id: "user-1",
    type: "delegation",
    description: "Buy TEREA turquoise",
    status: "pending",
    assigned_to: "Worker",
    created_at: "2026-07-10T16:01:13.589Z",
    confirmed_at: null,
    due_at: null,
    dismissed_at: null,
    archived_at: null,
    confirmation_url: null,
    qstash_message_id: null,
    followup_sent_at: null,
    escalated_at: null,
    image_path: null,
    proof_image_path: null,
    quality_review_status: "substitute_review",
    quality_review_note: null,
    quality_reviewed_at: null,
    worker_reply: null,
    needs_follow_up: false,
    ...overrides,
  };
}

describe("useTasksStore.loadFor — Phase 8.1 Bug #2 regression (stale client state after a forced refresh)", () => {
  beforeEach(() => {
    useTasksStore.getState().reset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("a forced call made while a fetch is already in flight is not silently dropped — it waits, then fetches again and returns the fresh result", async () => {
    // Prime the store with one completed load, exactly like useTaskList's
    // mount effect does before any poll or user action can fire — loadFor's
    // concurrency guard only applies once loadedForUserId is already set.
    listTasksMock.mockResolvedValueOnce([makeTask({ status: "pending", quality_review_status: "substitute_review" })]);
    await useTasksStore.getState().loadFor("user-1", { force: true });
    listTasksMock.mockClear();

    let resolveFirst: (rows: Task[]) => void = () => {};
    const firstFetch = new Promise<Task[]>((resolve) => {
      resolveFirst = resolve;
    });
    listTasksMock.mockReturnValueOnce(firstFetch);

    // Simulates a background poll (e.g. useTaskList's 15s interval) starting
    // a fetch just before the owner's own post-decision refresh comes in.
    const pollCall = useTasksStore.getState().loadFor("user-1", { force: true });
    expect(useTasksStore.getState().status).toBe("loading");

    // The owner's own refreshTasks() call after Approve Alternative succeeds,
    // fired while the poll's fetch is still in flight.
    const preApprovalSnapshot = [makeTask({ status: "pending", quality_review_status: "substitute_review" })];
    const postApprovalSnapshot = [makeTask({ status: "done", quality_review_status: "approved", confirmed_at: "2026-07-10T16:02:49.773Z" })];
    listTasksMock.mockResolvedValueOnce(postApprovalSnapshot);

    const ownerRefreshCall = useTasksStore.getState().loadFor("user-1", { force: true });

    // The in-flight poll resolves with the stale pre-approval snapshot.
    resolveFirst(preApprovalSnapshot);
    await pollCall;

    // The owner's forced call must still result in its own fresh fetch —
    // never a silent no-op — so the final state reflects the approval.
    await ownerRefreshCall;

    expect(listTasksMock).toHaveBeenCalledTimes(2);
    expect(useTasksStore.getState().items).toEqual(postApprovalSnapshot);
    expect(useTasksStore.getState().items[0].status).toBe("done");
  });

  it("a non-forced call made while a fetch is already in flight still no-ops (dedup for routine background triggers is preserved)", async () => {
    listTasksMock.mockResolvedValueOnce([makeTask()]);
    await useTasksStore.getState().loadFor("user-1", { force: true });
    listTasksMock.mockClear();

    let resolveFirst: (rows: Task[]) => void = () => {};
    const firstFetch = new Promise<Task[]>((resolve) => {
      resolveFirst = resolve;
    });
    listTasksMock.mockReturnValueOnce(firstFetch);

    const first = useTasksStore.getState().loadFor("user-1", { force: true });
    await useTasksStore.getState().loadFor("user-1"); // non-forced, should no-op immediately

    expect(listTasksMock).toHaveBeenCalledTimes(1);

    resolveFirst([makeTask()]);
    await first;
  });

  it("a forced call with no concurrent fetch in flight behaves exactly as before (single fetch, no extra call)", async () => {
    listTasksMock.mockResolvedValueOnce([makeTask({ status: "done" })]);
    await useTasksStore.getState().loadFor("user-1", { force: true });

    expect(listTasksMock).toHaveBeenCalledTimes(1);
    expect(useTasksStore.getState().status).toBe("ready");
    expect(useTasksStore.getState().items[0].status).toBe("done");
  });

  it("same user, status ready, no force — still skips the fetch entirely (unchanged caching behavior)", async () => {
    listTasksMock.mockResolvedValueOnce([makeTask()]);
    await useTasksStore.getState().loadFor("user-1", { force: true });
    listTasksMock.mockClear();

    await useTasksStore.getState().loadFor("user-1");
    expect(listTasksMock).not.toHaveBeenCalled();
  });
});

describe("useTasksStore.dismissConfirmationNotice", () => {
  beforeEach(() => {
    useTasksStore.getState().reset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function completedTask(overrides: Partial<Task> = {}): Task {
    return makeTask({
      status: "done",
      confirmed_at: "2026-07-27T12:00:00.000Z",
      quality_review_status: "approved",
      ...overrides,
    });
  }

  it("keeps a server-dismissed banner hidden after reload, logout/login, and another client load", async () => {
    const persisted = completedTask({ dismissed_at: "2026-07-27T12:05:00.000Z" });
    listTasksMock.mockResolvedValue([persisted]);

    await useTasksStore.getState().loadFor("user-1", { force: true });
    expect(useTasksStore.getState().items[0].dismissed_at).toBe(persisted.dismissed_at);
    expect(selectConfirmationNotices(useTasksStore.getState().items)).toEqual([]);

    useTasksStore.getState().reset();
    await useTasksStore.getState().loadFor("user-1", { force: true });
    expect(useTasksStore.getState().items[0].dismissed_at).toBe(persisted.dismissed_at);
    expect(selectConfirmationNotices(useTasksStore.getState().items)).toEqual([]);

    useTasksStore.getState().reset();
    await useTasksStore.getState().loadFor("user-1", { force: true });
    expect(useTasksStore.getState().items[0].dismissed_at).toBe(persisted.dismissed_at);
    expect(selectConfirmationNotices(useTasksStore.getState().items)).toEqual([]);
    expect(listTasksMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["pending", completedTask({ status: "pending", confirmed_at: null })],
    ["unconfirmed", completedTask({ confirmed_at: null })],
    ["non-delegation", completedTask({ type: "reminder" })],
  ])("does not dismiss %s work", async (_label, task) => {
    useTasksStore.getState().push([task]);

    await useTasksStore.getState().dismissConfirmationNotice(task.id);

    expect(dismissConfirmationNoticesMock).not.toHaveBeenCalled();
    expect(useTasksStore.getState().items[0]).toEqual(task);
  });

  it("rolls back the optimistic dismissal when the database write fails", async () => {
    const task = completedTask();
    useTasksStore.getState().push([task]);
    dismissConfirmationNoticesMock.mockRejectedValueOnce(new Error("database unavailable"));

    const dismissal = useTasksStore.getState().dismissConfirmationNotice(task.id);
    expect(useTasksStore.getState().items[0].dismissed_at).not.toBeNull();
    await expect(dismissal).rejects.toThrow("database unavailable");

    expect(useTasksStore.getState().items[0]).toEqual(task);
  });

  it("rolls back when the guarded database update matches no eligible row", async () => {
    const task = completedTask();
    useTasksStore.getState().push([task]);
    dismissConfirmationNoticesMock.mockResolvedValueOnce([]);

    await useTasksStore.getState().dismissConfirmationNotice(task.id);

    expect(useTasksStore.getState().items[0]).toEqual(task);
  });

  it("persists only dismissed_at and does not archive, delete, or remove the completed task", async () => {
    const task = completedTask();
    const persisted = {
      ...task,
      dismissed_at: "2026-07-27T12:05:00.000Z",
    };
    useTasksStore.getState().push([task]);
    dismissConfirmationNoticesMock.mockResolvedValueOnce([persisted]);

    await useTasksStore.getState().dismissConfirmationNotice(task.id);

    expect(dismissConfirmationNoticesMock).toHaveBeenCalledWith([task.id]);
    expect(archiveDoneTasksMock).not.toHaveBeenCalled();
    expect(deleteTaskMock).not.toHaveBeenCalled();
    expect(useTasksStore.getState().items).toEqual([persisted]);
    expect(useTasksStore.getState().items[0]).toMatchObject({
      id: task.id,
      status: "done",
      archived_at: null,
      confirmed_at: task.confirmed_at,
    });
  });
});
