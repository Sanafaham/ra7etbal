import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../types/task";

const mocks = vi.hoisted(() => ({
  supabaseGetUser: vi.fn(
    async (): Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }> => ({
      data: { user: { id: "user-1" } },
      error: null,
    }),
  ),
  listTasks: vi.fn(),
  listOpenStaffEscalationsForNeedsYou: vi.fn(),
  fetchAutomationDigest: vi.fn(),
  fetchUnresolvedCaptureCandidates: vi.fn(),
  classifyAttentionWorthyCaptures: vi.fn(),
  markCarsonNotesSurfaced: vi.fn(),
  markCarsonTodosSurfaced: vi.fn(),
}));

vi.mock("./supabase", () => ({
  supabase: { auth: { getUser: mocks.supabaseGetUser } },
}));
vi.mock("./tasks", () => ({ listTasks: mocks.listTasks }));
vi.mock("./staff-messages", () => ({
  listOpenStaffEscalationsForNeedsYou: mocks.listOpenStaffEscalationsForNeedsYou,
}));
vi.mock("./automation-context", () => ({
  fetchAutomationDigest: mocks.fetchAutomationDigest,
}));
vi.mock("./carson-unresolved-captures", () => ({
  fetchUnresolvedCaptureCandidates: mocks.fetchUnresolvedCaptureCandidates,
  classifyAttentionWorthyCaptures: mocks.classifyAttentionWorthyCaptures,
}));
vi.mock("./carson-notes", () => ({
  markCarsonNotesSurfaced: mocks.markCarsonNotesSurfaced,
}));
vi.mock("./carson-todos", () => ({
  markCarsonTodosSurfaced: mocks.markCarsonTodosSurfaced,
}));

const { fetchAttentionEvidence, fetchAttentionSummary, renderAttentionSummary } = await import(
  "./carson-operations-center"
);

const EMPTY_DIGEST = {
  pending: [],
  escalated: [],
  failed: [],
  confirmedToday: [],
  firingToday: [],
  firingTomorrow: [],
  routineAutomationTaskIds: new Set<string>(),
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    user_id: "user-1",
    description: "Do the thing",
    type: "action",
    assigned_to: null,
    status: "pending",
    needs_follow_up: false,
    confirmation_url: null,
    confirmed_at: null,
    due_at: null,
    dismissed_at: null,
    archived_at: null,
    created_at: new Date().toISOString(),
    qstash_message_id: null,
    followup_sent_at: null,
    escalated_at: null,
    image_path: null,
    proof_image_path: null,
    quality_review_status: null,
    quality_review_note: null,
    quality_reviewed_at: null,
    worker_reply: null,
    ...overrides,
  } as Task;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.supabaseGetUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  mocks.fetchAutomationDigest.mockResolvedValue(EMPTY_DIGEST);
  mocks.listTasks.mockResolvedValue([]);
  mocks.listOpenStaffEscalationsForNeedsYou.mockResolvedValue([]);
  mocks.fetchUnresolvedCaptureCandidates.mockResolvedValue([]);
  mocks.classifyAttentionWorthyCaptures.mockImplementation((candidates: unknown[]) => candidates);
  mocks.markCarsonNotesSurfaced.mockResolvedValue(undefined);
  mocks.markCarsonTodosSurfaced.mockResolvedValue(undefined);
});

describe("fetchAttentionEvidence — auth", () => {
  it("returns no factual answer when signed out", async () => {
    mocks.supabaseGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const evidence = await fetchAttentionEvidence();
    expect(evidence.ok).toBe(false);
    expect(evidence.code).toBe("attention_auth_failed");
    expect(evidence.needsAttention).toEqual([]);
    expect(evidence.waiting).toEqual([]);
  });

  it("returns no factual answer when the auth check itself errors", async () => {
    mocks.supabaseGetUser.mockResolvedValue({ data: { user: null }, error: { message: "network" } });
    const evidence = await fetchAttentionEvidence();
    expect(evidence.ok).toBe(false);
    expect(evidence.code).toBe("attention_auth_failed");
  });
});

describe("fetchAttentionEvidence — tenant isolation", () => {
  it("never accepts or forwards a caller-supplied account id — identity comes only from supabase.auth.getUser()", async () => {
    await fetchAttentionEvidence();
    // The only identity-bearing call is auth.getUser(); listTasks/needsYou
    // take zero arguments in this codebase's existing RLS-scoped contract
    // (see src/lib/tasks.ts, src/lib/staff-messages.ts) — asserting the
    // zero-arg call shape here is a static proof this function has no
    // parameter through which a different account id could be substituted.
    expect(mocks.listTasks).toHaveBeenCalledWith();
    expect(mocks.listOpenStaffEscalationsForNeedsYou).toHaveBeenCalledWith();
    expect(mocks.supabaseGetUser).toHaveBeenCalled();
  });
});

describe("fetchAttentionEvidence — empty verified state", () => {
  it("reports nothing needing attention, without implying nothing exists to check", async () => {
    const evidence = await fetchAttentionEvidence();
    expect(evidence.ok).toBe(true);
    expect(evidence.completeness).toBe("full");
    expect(evidence.needsAttention).toEqual([]);
    expect(evidence.waiting).toEqual([]);
    expect(renderAttentionSummary(evidence)).toMatch(/nothing needs your attention/i);
  });
});

describe("fetchAttentionEvidence — full retrieval, no fabrication", () => {
  it("only includes items actually present in the retrieved tasks", async () => {
    const owner = makeTask({ id: "t-owner", description: "Book the vet", assigned_to: null, type: "action" });
    const overdue = makeTask({
      id: "t-overdue",
      description: "Pay the internet bill",
      type: "reminder",
      due_at: new Date(Date.now() - 3600_000).toISOString(),
    });
    const waiting = makeTask({
      id: "t-wait",
      description: "Pick up dry cleaning",
      type: "delegation",
      assigned_to: "Ahmed",
      needs_follow_up: true,
    });
    mocks.listTasks.mockResolvedValue([owner, overdue, waiting]);

    const evidence = await fetchAttentionEvidence();
    expect(evidence.ok).toBe(true);
    expect(evidence.completeness).toBe("full");

    const needsIds = evidence.needsAttention.map((i) => i.id);
    const waitIds = evidence.waiting.map((i) => i.id);
    expect(needsIds).toContain("t-overdue");
    expect(waitIds).toContain("t-wait");
    // No item id appears that wasn't in the retrieved task set.
    for (const item of [...evidence.needsAttention, ...evidence.waiting]) {
      expect(["t-owner", "t-overdue", "t-wait"]).toContain(item.id);
    }
  });

  it("classifies open staff escalations as Waiting (Needs You source)", async () => {
    mocks.listOpenStaffEscalationsForNeedsYou.mockResolvedValue([
      {
        id: "esc-1",
        staffName: "Christopher",
        inboundText: "not sure how many guests",
        escalationReason: "needs a decision on guest count",
        receivedAt: new Date().toISOString(),
        taskId: null,
        decisionId: "dec-1",
        deepLinkToken: "tok-1",
      },
    ]);
    const evidence = await fetchAttentionEvidence();
    expect(evidence.waiting.some((i) => i.id === "esc-1" && i.label.includes("Christopher"))).toBe(true);
  });

  it("never manufactures urgency when nothing is actually escalated or overdue", async () => {
    const routine = makeTask({ id: "t-routine", description: "Water the plants", type: "delegation", assigned_to: "Ahmed" });
    mocks.listTasks.mockResolvedValue([routine]);
    const evidence = await fetchAttentionEvidence();
    // Routine, non-escalated delegation goes to waiting, not needsAttention.
    expect(evidence.needsAttention).toEqual([]);
    expect(evidence.waiting.map((i) => i.id)).toContain("t-routine");
  });
});

describe("fetchAttentionEvidence — partial retrieval", () => {
  it("marks completeness partial and never claims completeness when tasks fail", async () => {
    mocks.listTasks.mockRejectedValue(new Error("db timeout"));
    mocks.listOpenStaffEscalationsForNeedsYou.mockResolvedValue([]);
    const evidence = await fetchAttentionEvidence();
    expect(evidence.ok).toBe(true);
    expect(evidence.completeness).toBe("partial");
    expect(renderAttentionSummary(evidence)).toMatch(/couldn't check everything|may be incomplete/i);
  });

  it("marks completeness partial when the Needs You source fails but tasks succeed", async () => {
    mocks.listTasks.mockResolvedValue([]);
    mocks.listOpenStaffEscalationsForNeedsYou.mockRejectedValue(new Error("db timeout"));
    const evidence = await fetchAttentionEvidence();
    expect(evidence.completeness).toBe("partial");
  });

  it("stays partial (not total failure) when tasks and needsYou fail but unresolved-capture retrieval succeeds", async () => {
    mocks.listTasks.mockRejectedValue(new Error("db timeout"));
    mocks.listOpenStaffEscalationsForNeedsYou.mockRejectedValue(new Error("db timeout"));
    const evidence = await fetchAttentionEvidence();
    expect(evidence.ok).toBe(true);
    expect(evidence.completeness).toBe("partial");
  });

  it("marks completeness partial when unresolved-capture retrieval fails but tasks/needsYou succeed", async () => {
    mocks.fetchUnresolvedCaptureCandidates.mockRejectedValue(new Error("db timeout"));
    const evidence = await fetchAttentionEvidence();
    expect(evidence.ok).toBe(true);
    expect(evidence.completeness).toBe("partial");
  });

  it("never converts a total failure of every source into a confident empty answer", async () => {
    mocks.listTasks.mockRejectedValue(new Error("db timeout"));
    mocks.listOpenStaffEscalationsForNeedsYou.mockRejectedValue(new Error("db timeout"));
    mocks.fetchUnresolvedCaptureCandidates.mockRejectedValue(new Error("db timeout"));
    const evidence = await fetchAttentionEvidence();
    expect(evidence.ok).toBe(false);
    expect(evidence.code).toBe("attention_read_failed");
    expect(renderAttentionSummary(evidence)).not.toMatch(/nothing needs your attention right now\./i);
  });
});

describe("fetchAttentionEvidence — unresolved Notes/To-dos (Second Brain Phase 1)", () => {
  it("includes classifier-selected captures in evidence and the rendered response", async () => {
    const candidates = [{ id: "n1", kind: "note" as const, text: "Check on Nimala's wedding invitation", ageDays: 60, neverSurfaced: true, actionable: true }];
    mocks.fetchUnresolvedCaptureCandidates.mockResolvedValue(candidates);
    mocks.classifyAttentionWorthyCaptures.mockReturnValue(candidates);
    const evidence = await fetchAttentionEvidence();
    expect(evidence.unresolvedCaptures).toEqual([
      { id: "n1", label: "Check on Nimala's wedding invitation", reason: "a note you made" },
    ]);
    expect(renderAttentionSummary(evidence)).toMatch(/Also on your mind.*Nimala/);
  });

  it("labels a to-do capture distinctly from a note capture", async () => {
    const candidates = [{ id: "t1", kind: "todo" as const, text: "Review the Rahet Bal home screen", ageDays: 45, neverSurfaced: true, actionable: true }];
    mocks.fetchUnresolvedCaptureCandidates.mockResolvedValue(candidates);
    mocks.classifyAttentionWorthyCaptures.mockReturnValue(candidates);
    const evidence = await fetchAttentionEvidence();
    expect(evidence.unresolvedCaptures[0].reason).toBe("on your to-do list");
  });

  it("never includes a capture the classifier excluded — no fabrication beyond what classification selected", async () => {
    const noteCandidate = { id: "n1", kind: "note" as const, text: "Restaurant I liked in Paris", ageDays: 200, neverSurfaced: true, actionable: false };
    mocks.fetchUnresolvedCaptureCandidates.mockResolvedValue([noteCandidate]);
    mocks.classifyAttentionWorthyCaptures.mockReturnValue([]); // classifier excludes it
    const evidence = await fetchAttentionEvidence();
    expect(evidence.unresolvedCaptures).toEqual([]);
    expect(renderAttentionSummary(evidence)).not.toMatch(/Paris/);
  });

  it("marks surfaced only the notes/todos actually selected by classification — never merely-retrieved ones", async () => {
    const selected = [
      { id: "n1", kind: "note" as const, text: "Check on Nimala's wedding invitation", ageDays: 60, neverSurfaced: true, actionable: true },
      { id: "t1", kind: "todo" as const, text: "Review the Rahet Bal home screen", ageDays: 45, neverSurfaced: true, actionable: true },
    ];
    mocks.fetchUnresolvedCaptureCandidates.mockResolvedValue(selected);
    mocks.classifyAttentionWorthyCaptures.mockReturnValue(selected);
    await fetchAttentionEvidence();
    expect(mocks.markCarsonNotesSurfaced).toHaveBeenCalledWith(["n1"]);
    expect(mocks.markCarsonTodosSurfaced).toHaveBeenCalledWith(["t1"]);
  });

  it("does not mark anything surfaced when classification selects nothing", async () => {
    mocks.fetchUnresolvedCaptureCandidates.mockResolvedValue([
      { id: "n1", kind: "note" as const, text: "Restaurant I liked in Paris", ageDays: 200, neverSurfaced: true, actionable: false },
    ]);
    mocks.classifyAttentionWorthyCaptures.mockReturnValue([]);
    await fetchAttentionEvidence();
    expect(mocks.markCarsonNotesSurfaced).not.toHaveBeenCalled();
    expect(mocks.markCarsonTodosSurfaced).not.toHaveBeenCalled();
  });

  it("a failed mark-surfaced write does not fail the overall read the user is waiting on", async () => {
    const selected = [{ id: "n1", kind: "note" as const, text: "Check on Nimala's wedding invitation", ageDays: 60, neverSurfaced: true, actionable: true }];
    mocks.fetchUnresolvedCaptureCandidates.mockResolvedValue(selected);
    mocks.classifyAttentionWorthyCaptures.mockReturnValue(selected);
    mocks.markCarsonNotesSurfaced.mockRejectedValue(new Error("write failed"));
    const evidence = await fetchAttentionEvidence();
    expect(evidence.ok).toBe(true);
    expect(evidence.unresolvedCaptures).toHaveLength(1);
  });
});

describe("fetchAttentionSummary — outer failure safety net", () => {
  it("never throws, even if an unexpected error occurs inside evidence gathering", async () => {
    mocks.fetchAutomationDigest.mockRejectedValue(new Error("unexpected"));
    const result = await fetchAttentionSummary();
    expect(typeof result).toBe("string");
    expect(result).toMatch(/couldn't check/i);
  });
});
