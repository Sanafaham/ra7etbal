import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTasksStore } from "./tasks";
import { listTasks } from "../lib/tasks";
import type { Task } from "../types/task";

vi.mock("../lib/tasks", () => ({
  archiveDoneTasks: vi.fn(),
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  deleteTasks: vi.fn(),
  listTasks: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock("../lib/qstash-reminder", () => ({
  cancelReminderPush: vi.fn(),
  rescheduleReminderPush: vi.fn(),
  scheduleReminderPush: vi.fn(),
}));

const listTasksMock = vi.mocked(listTasks);

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
