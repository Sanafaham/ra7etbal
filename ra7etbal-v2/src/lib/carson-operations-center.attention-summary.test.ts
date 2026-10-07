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

const {
  fetchAttentionEvidence,
  fetchAttentionSummary,
  fetchAttentionPresentation,
  markAttentionCapturesSurfaced,
  renderAttentionSummary,
} = await import("./carson-operations-center");

// A digest that LOADED SUCCESSFULLY for an owner with no automations — which is
// what these tests mock for the happy path. recurringSourceLinksLoaded is true
// because both link reads returned (empty is a valid result); a digest whose
// reads actually failed is covered separately below.
const EMPTY_DIGEST = {
  pending: [],
  escalated: [],
  failed: [],
  confirmedToday: [],
  firingToday: [],
  firingTomorrow: [],
  routineAutomationTaskIds: new Set<string>(),
  recurringSourceIndexes: {
    automationLinks: new Map(),
    routineLinks: new Map(),
    notificationAutomationClaims: new Map(),
  },
  recurringSourceLinksLoaded: true,
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
    expect(evidence.needsYou).toEqual([]);
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
    expect(evidence.needsYou).toEqual([]);
    expect(evidence.waiting).toEqual([]);
    expect(renderAttentionSummary(evidence)).toMatch(/nothing needs your attention/i);
  });
});

describe("fetchAttentionEvidence — full retrieval, no fabrication", () => {
  it("only includes items actually present in the retrieved tasks, filed under their true category", async () => {
    const owner = makeTask({ id: "t-owner", description: "Book the vet", assigned_to: null, type: "action" });
    const decision = makeTask({ id: "t-decision", description: "Choose the venue", assigned_to: null, type: "decision" });
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
    mocks.listTasks.mockResolvedValue([owner, decision, overdue, waiting]);

    const evidence = await fetchAttentionEvidence();
    expect(evidence.ok).toBe(true);
    expect(evidence.completeness).toBe("full");

    // Needs You is canonical/narrow — only the "decision" type task qualifies.
    expect(evidence.needsYou.map((i) => i.id)).toEqual(["t-decision"]);
    expect(evidence.overdueReminders.map((i) => i.id)).toContain("t-overdue");
    expect(evidence.waiting.map((i) => i.id)).toContain("t-wait");
    // A routine, non-decision owner task is not Needs You — it's Later.
    expect(evidence.later.map((i) => i.id)).toContain("t-owner");
    // No item id appears that wasn't in the retrieved task set.
    const allIds = [
      ...evidence.needsYou,
      ...evidence.overdueReminders,
      ...evidence.upcomingReminders,
      ...evidence.waiting,
      ...evidence.later,
    ].map((i) => i.id);
    for (const id of allIds) {
      expect(["t-owner", "t-decision", "t-overdue", "t-wait"]).toContain(id);
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
    // Routine, non-escalated delegation goes to waiting, not needsYou.
    expect(evidence.needsYou).toEqual([]);
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

describe("fetchAttentionEvidence — 2026-08-25 latency/timeout hardening", () => {
  it("degrades a source that never resolves to that source's own partial-failure handling instead of hanging indefinitely — the confirmed LLM Cascade Error contributing risk (no timeout existed anywhere in this chain before this fix)", async () => {
    vi.useFakeTimers();
    try {
      mocks.listTasks.mockImplementation(() => new Promise(() => {})); // never resolves
      mocks.listOpenStaffEscalationsForNeedsYou.mockResolvedValue([]);
      mocks.fetchUnresolvedCaptureCandidates.mockResolvedValue([]);
      const evidencePromise = fetchAttentionEvidence();
      await vi.advanceTimersByTimeAsync(8_001);
      const evidence = await evidencePromise;
      expect(evidence.ok).toBe(true);
      expect(evidence.completeness).toBe("partial");
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the three independent, fallible sources in parallel, not sequentially — each is invoked before any of them resolves", async () => {
    const callOrder: string[] = [];
    let resolveTasks!: (v: unknown[]) => void;
    let resolveNeedsYou!: (v: unknown[]) => void;
    let resolveCaptures!: (v: unknown[]) => void;
    mocks.listTasks.mockImplementation(() => {
      callOrder.push("tasks-called");
      return new Promise((resolve) => {
        resolveTasks = resolve;
      });
    });
    mocks.listOpenStaffEscalationsForNeedsYou.mockImplementation(() => {
      callOrder.push("needsYou-called");
      return new Promise((resolve) => {
        resolveNeedsYou = resolve;
      });
    });
    mocks.fetchUnresolvedCaptureCandidates.mockImplementation(() => {
      callOrder.push("captures-called");
      return new Promise((resolve) => {
        resolveCaptures = resolve;
      });
    });

    const evidencePromise = fetchAttentionEvidence();
    // Flush microtasks without resolving any source — if the implementation
    // were still sequential, only "tasks-called" would appear here, since
    // the second call wouldn't fire until the first await settles.
    await Promise.resolve();
    await Promise.resolve();
    expect(callOrder).toEqual(["tasks-called", "needsYou-called", "captures-called"]);

    resolveTasks([]);
    resolveNeedsYou([]);
    resolveCaptures([]);
    const evidence = await evidencePromise;
    expect(evidence.ok).toBe(true);
    expect(evidence.completeness).toBe("full");
  });
});

describe("fetchAttentionEvidence — unresolved Notes/To-dos (Second Brain Phase 1)", () => {
  it("includes classifier-selected captures in evidence and the rendered response", async () => {
    const candidates = [{ id: "n1", kind: "note" as const, text: "Check on Nimala's wedding invitation", ageDays: 60, neverSurfaced: true, actionable: true }];
    mocks.fetchUnresolvedCaptureCandidates.mockResolvedValue(candidates);
    mocks.classifyAttentionWorthyCaptures.mockReturnValue(candidates);
    const evidence = await fetchAttentionEvidence();
    expect(evidence.unresolvedCaptures).toEqual([
      {
        id: "n1",
        label: "Check on Nimala's wedding invitation",
        type: "note",
        status: "pending",
        dueAt: null,
        dueDescription: null,
        assignee: null,
        category: "unresolvedCaptures",
      },
    ]);
    expect(renderAttentionSummary(evidence)).toMatch(/Also on your mind.*Nimala/);
  });

  it("labels a to-do capture distinctly from a note capture", async () => {
    const candidates = [{ id: "t1", kind: "todo" as const, text: "Review the Rahet Bal home screen", ageDays: 45, neverSurfaced: true, actionable: true }];
    mocks.fetchUnresolvedCaptureCandidates.mockResolvedValue(candidates);
    mocks.classifyAttentionWorthyCaptures.mockReturnValue(candidates);
    const evidence = await fetchAttentionEvidence();
    expect(evidence.unresolvedCaptures[0].type).toBe("todo");
  });

  it("never includes a capture the classifier excluded — no fabrication beyond what classification selected", async () => {
    const noteCandidate = { id: "n1", kind: "note" as const, text: "Restaurant I liked in Paris", ageDays: 200, neverSurfaced: true, actionable: false };
    mocks.fetchUnresolvedCaptureCandidates.mockResolvedValue([noteCandidate]);
    mocks.classifyAttentionWorthyCaptures.mockReturnValue([]); // classifier excludes it
    const evidence = await fetchAttentionEvidence();
    expect(evidence.unresolvedCaptures).toEqual([]);
    expect(renderAttentionSummary(evidence)).not.toMatch(/Paris/);
  });

  // P3 Step 3 / S2 — RETRIEVED / PREFETCHED ≠ SURFACED TO OWNER. Retrieval
  // (the voice guard prefetch, the get_items_needing_attention tool, the
  // typed read) must never write last_surfaced_at.
  it("S2-A: retrieval never writes last_surfaced_at, even when captures are selected", async () => {
    const selected = [
      { id: "n1", kind: "note" as const, text: "Check on Nimala's wedding invitation", ageDays: 60, neverSurfaced: true, actionable: true },
      { id: "t1", kind: "todo" as const, text: "Review the Rahet Bal home screen", ageDays: 45, neverSurfaced: true, actionable: true },
    ];
    mocks.fetchUnresolvedCaptureCandidates.mockResolvedValue(selected);
    const evidence = await fetchAttentionEvidence();
    await fetchAttentionSummary();
    await fetchAttentionPresentation();
    expect(evidence.unresolvedCaptures.map((c) => c.id)).toEqual(["n1", "t1"]);
    expect(mocks.markCarsonNotesSurfaced).not.toHaveBeenCalled();
    expect(mocks.markCarsonTodosSurfaced).not.toHaveBeenCalled();
  });

  it("does not mark anything surfaced when classification selects nothing", async () => {
    mocks.fetchUnresolvedCaptureCandidates.mockResolvedValue([
      { id: "n1", kind: "note" as const, text: "Restaurant I liked in Paris", ageDays: 200, neverSurfaced: true, actionable: false },
    ]);
    const presentation = await fetchAttentionPresentation();
    expect(presentation.captureIds).toEqual([]);
    expect(mocks.markCarsonNotesSurfaced).not.toHaveBeenCalled();
    expect(mocks.markCarsonTodosSurfaced).not.toHaveBeenCalled();
  });
});

describe("fetchAttentionPresentation / markAttentionCapturesSurfaced — P3 Step 3 / S2", () => {
  // A small stateful store standing in for carson_notes/carson_todos, so the
  // classifier's real neverSurfaced filter sees exactly what the writes did.
  function useCaptureStore() {
    const surfaced = new Map<string, string | null>([
      ["n1", null],
      ["t1", null],
      ["t2", null],
    ]);
    const rows = [
      { id: "n1", kind: "note" as const, text: "Check on Nimala's wedding invitation", ageDays: 60 },
      { id: "t1", kind: "todo" as const, text: "Review the Rahet Bal home screen", ageDays: 45 },
      { id: "t2", kind: "todo" as const, text: "Buy groceries", ageDays: 10 },
    ];
    mocks.fetchUnresolvedCaptureCandidates.mockImplementation(async () =>
      rows.map((r) => ({ ...r, actionable: true, neverSurfaced: !surfaced.get(r.id) })),
    );
    const write = async (ids: string[]) => {
      for (const id of ids) surfaced.set(id, "2026-10-07T00:00:00.000Z");
    };
    mocks.markCarsonNotesSurfaced.mockImplementation(write);
    mocks.markCarsonTodosSurfaced.mockImplementation(write);
    return surfaced;
  }

  it("S2-D: a prefetch followed by the tool's own retrieval still returns the eligible captures", async () => {
    const surfaced = useCaptureStore();
    const prefetch = await fetchAttentionPresentation();
    const tool = await fetchAttentionPresentation();
    expect(prefetch.captureIds.map((c) => c.id)).toEqual(["n1", "t1", "t2"]);
    expect(tool.captureIds).toEqual(prefetch.captureIds);
    expect(tool.text).toMatch(/Also on your mind: Check on Nimala's wedding invitation/);
    expect([...surfaced.values()].every((v) => v === null)).toBe(true);
  });

  it("captureIds are exactly the captures the rendered text includes, with their kind", async () => {
    useCaptureStore();
    const presentation = await fetchAttentionPresentation();
    expect(presentation.captureIds).toEqual([
      { id: "n1", kind: "note" },
      { id: "t1", kind: "todo" },
      { id: "t2", kind: "todo" },
    ]);
    for (const label of ["Check on Nimala's wedding invitation", "Review the Rahet Bal home screen", "Buy groceries"]) {
      expect(presentation.text).toContain(label);
    }
  });

  it("S2-H: a failed read presents no captures", async () => {
    mocks.supabaseGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const signedOut = await fetchAttentionPresentation();
    expect(signedOut.captureIds).toEqual([]);
    mocks.supabaseGetUser.mockRejectedValue(new Error("network"));
    const thrown = await fetchAttentionPresentation();
    expect(thrown.captureIds).toEqual([]);
    expect(thrown.text).toMatch(/couldn't check/i);
  });

  it("S2-E/F/I: marking writes exactly the presented ids; captures fetched but not presented stay unsurfaced", async () => {
    const surfaced = useCaptureStore();
    markAttentionCapturesSurfaced([{ id: "n1", kind: "note" }, { id: "t1", kind: "todo" }]);
    await Promise.resolve();
    expect(mocks.markCarsonNotesSurfaced).toHaveBeenCalledWith(["n1"]);
    expect(mocks.markCarsonTodosSurfaced).toHaveBeenCalledWith(["t1"]);
    expect(surfaced.get("t2")).toBeNull();
    const next = await fetchAttentionPresentation();
    expect(next.captureIds).toEqual([{ id: "t2", kind: "todo" }]);
  });

  it("S2-G: marking an empty presentation writes nothing", () => {
    markAttentionCapturesSurfaced([]);
    expect(mocks.markCarsonNotesSurfaced).not.toHaveBeenCalled();
    expect(mocks.markCarsonTodosSurfaced).not.toHaveBeenCalled();
  });

  it("a failed mark-surfaced write never throws to the caller", () => {
    mocks.markCarsonNotesSurfaced.mockRejectedValue(new Error("write failed"));
    expect(() => markAttentionCapturesSurfaced([{ id: "n1", kind: "note" }])).not.toThrow();
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
