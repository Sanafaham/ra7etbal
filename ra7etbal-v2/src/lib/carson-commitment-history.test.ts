import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../types/task";

const mocks = vi.hoisted(() => ({
  supabaseGetUser: vi.fn(async (): Promise<{ data: { user: { id: string } | null } }> => ({
    data: { user: { id: "user-1" } },
  })),
  supabaseFrom: vi.fn(),
}));

vi.mock("./supabase", () => ({
  supabase: {
    auth: { getUser: mocks.supabaseGetUser },
    from: mocks.supabaseFrom,
  },
}));

// Chainable query builder mirroring carson-operations-center.test.ts's
// convention — same shape as the real Supabase query builder.
function makeChain(result: { data: unknown; error: unknown } = { data: [], error: null }) {
  const b: Record<string, unknown> = {};
  const methods = ["select", "eq", "or", "order", "limit"];
  for (const m of methods) b[m] = () => b;
  b.then = (res: (v: typeof result) => unknown, rej?: (r: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return b;
}

const {
  findCommitmentCandidates,
  buildCommitmentHistory,
  formatCommitmentHistoryAnswer,
  lookupCommitmentHistory,
} = await import("./carson-commitment-history");

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    user_id: "user-1",
    description: "prepare the guest room",
    type: "delegation",
    assigned_to: "Grace",
    status: "pending",
    needs_follow_up: true,
    confirmation_url: null,
    confirmed_at: null,
    due_at: null,
    archived_at: null,
    created_at: "2026-07-20T10:00:00Z",
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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.supabaseGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
});

describe("findCommitmentCandidates", () => {
  it("returns [] for an empty keyword", async () => {
    const result = await findCommitmentCandidates("", "user-1");
    expect(result).toEqual([]);
    expect(mocks.supabaseFrom).not.toHaveBeenCalled();
  });

  it("returns [] on a query error rather than throwing", async () => {
    mocks.supabaseFrom.mockReturnValue(makeChain({ data: null, error: { message: "db error" } }));
    const result = await findCommitmentCandidates("guest room", "user-1");
    expect(result).toEqual([]);
  });

  it("returns matching tasks regardless of status or archived state", async () => {
    const rows = [makeTask({ status: "done", archived_at: "2026-07-25T00:00:00Z" })];
    mocks.supabaseFrom.mockReturnValue(makeChain({ data: rows, error: null }));
    const result = await findCommitmentCandidates("guest room", "user-1");
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("done");
    expect(result[0].archived_at).not.toBeNull();
  });
});

describe("lookupCommitmentHistory — resolution and disambiguation", () => {
  it("asks for a keyword when none is given", async () => {
    const result = await lookupCommitmentHistory("");
    expect(result).toMatch(/task description or a person's name/i);
    expect(mocks.supabaseGetUser).not.toHaveBeenCalled();
  });

  it("reports not signed in when there is no authenticated user", async () => {
    mocks.supabaseGetUser.mockResolvedValue({ data: { user: null } });
    const result = await lookupCommitmentHistory("guest room");
    expect(result).toMatch(/not signed in/i);
  });

  it("says plainly when nothing matches — never guesses", async () => {
    mocks.supabaseFrom.mockReturnValue(makeChain({ data: [], error: null }));
    const result = await lookupCommitmentHistory("passport");
    expect(result).toMatch(/don't have a record/i);
    expect(result).toContain("passport");
  });

  it("asks which one when multiple candidates match — never guesses", async () => {
    const rows = [
      makeTask({ id: "task-1", description: "prepare the guest room for arrival" }),
      makeTask({ id: "task-2", description: "clean the guest room windows" }),
    ];
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "tasks") return makeChain({ data: rows, error: null });
      return makeChain({ data: [], error: null });
    });
    const result = await lookupCommitmentHistory("guest room");
    expect(result).toMatch(/found 2 matching/i);
    expect(result).toMatch(/ask the user which one/i);
    expect(result).toContain("prepare the guest room");
    expect(result).toContain("clean the guest room");
  });

  it("proceeds straight to the answer when exactly one candidate matches", async () => {
    const task = makeTask({ status: "done", confirmed_at: "2026-07-21T09:00:00Z" });
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "tasks") return makeChain({ data: [task], error: null });
      return makeChain({ data: [], error: null });
    });
    const result = await lookupCommitmentHistory("guest room");
    expect(result).toContain("prepare the guest room");
    expect(result).toMatch(/confirmed done/i);
  });
});

describe("buildCommitmentHistory — timeline merge and ordering", () => {
  it("merges events from every related table into chronological order", async () => {
    const task = makeTask({
      created_at: "2026-07-20T08:00:00Z",
      followup_sent_at: "2026-07-20T08:10:00Z",
    });
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "whatsapp_deliveries") {
        return makeChain({
          data: [
            {
              delivery_status: "delivered",
              failure_reason: null,
              accepted_at: "2026-07-20T08:01:00Z",
              sent_at: "2026-07-20T08:02:00Z",
              delivered_at: "2026-07-20T08:05:00Z",
              read_at: null,
              failed_at: null,
              last_status_at: "2026-07-20T08:05:00Z",
            },
          ],
          error: null,
        });
      }
      return makeChain({ data: [], error: null });
    });

    const result = await buildCommitmentHistory(task);
    const timestamps = result.timeline.map((e) => e.at);
    const sorted = [...timestamps].sort(
      (a, b) => new Date(a).getTime() - new Date(b).getTime(),
    );
    expect(timestamps).toEqual(sorted);
    expect(result.timeline.map((e) => e.label)).toContain("Sent");
    expect(result.timeline.map((e) => e.label)).toContain("Delivered");
  });

  it("includes confirmations table rows even when tasks.confirmed_at is also set", async () => {
    const task = makeTask({ status: "done", confirmed_at: "2026-07-22T10:00:00Z" });
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "confirmations") {
        return makeChain({
          data: [{ confirmed_at: "2026-07-22T10:00:00Z", confirmed_by: "Grace", source: "whatsapp" }],
          error: null,
        });
      }
      return makeChain({ data: [], error: null });
    });

    const result = await buildCommitmentHistory(task);
    const confirmedEvents = result.timeline.filter((e) => e.label.startsWith("Confirmed"));
    // One structured confirmation event, not a duplicate from the tasks
    // fallback — proves the ladder prefers the richer confirmations row.
    expect(confirmedEvents).toHaveLength(1);
    expect(confirmedEvents[0].label).toBe("Confirmed by Grace");
    expect(confirmedEvents[0].source).toBe("confirmations");
  });

  it("falls back to tasks.confirmed_at when no confirmations row exists", async () => {
    const task = makeTask({ status: "done", confirmed_at: "2026-07-22T10:00:00Z" });
    mocks.supabaseFrom.mockReturnValue(makeChain({ data: [], error: null }));

    const result = await buildCommitmentHistory(task);
    const confirmedEvents = result.timeline.filter((e) => e.label === "Confirmed");
    expect(confirmedEvents).toHaveLength(1);
    expect(confirmedEvents[0].source).toBe("tasks");
  });

  it("only queries reminder_delivery_events for reminder-type tasks", async () => {
    const task = makeTask({ type: "delegation" });
    mocks.supabaseFrom.mockReturnValue(makeChain({ data: [], error: null }));
    await buildCommitmentHistory(task);
    expect(mocks.supabaseFrom).not.toHaveBeenCalledWith("reminder_delivery_events");
  });
});

describe("buildCommitmentHistory — conflict resolution", () => {
  it("flags a done task whose last delivery attempt failed, without overriding the terminal 'done' state", async () => {
    const task = makeTask({ status: "done", confirmed_at: "2026-07-22T10:00:00Z" });
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "whatsapp_deliveries") {
        return makeChain({
          data: [
            {
              delivery_status: "failed",
              failure_reason: "template rejected",
              accepted_at: "2026-07-20T08:00:00Z",
              sent_at: null,
              delivered_at: null,
              read_at: null,
              failed_at: "2026-07-20T08:01:00Z",
              last_status_at: "2026-07-20T08:01:00Z",
            },
          ],
          error: null,
        });
      }
      return makeChain({ data: [], error: null });
    });

    const result = await buildCommitmentHistory(task);
    expect(result.task.status).toBe("done"); // terminal state is never overridden
    expect(result.caveats.length).toBeGreaterThan(0);
    expect(result.caveats.join(" ")).toMatch(/delivery attempt.*fail/i);

    const answer = formatCommitmentHistoryAnswer(result);
    expect(answer).toMatch(/confirmed done/i);
    expect(answer).toMatch(/worth noting/i);
  });

  it("flags a done task with an unanswered owner escalation", async () => {
    const task = makeTask({ status: "done", confirmed_at: "2026-07-22T10:00:00Z" });
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "staff_escalation_owner_decisions") {
        return makeChain({
          data: [{ status: "active", answered_at: null, created_at: "2026-07-21T09:00:00Z" }],
          error: null,
        });
      }
      return makeChain({ data: [], error: null });
    });

    const result = await buildCommitmentHistory(task);
    expect(result.caveats.join(" ")).toMatch(/owner decision.*doesn't show as answered/i);
  });

  it("adds no caveats for a clean, uncontradicted done task", async () => {
    const task = makeTask({ status: "done", confirmed_at: "2026-07-22T10:00:00Z" });
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "whatsapp_deliveries") {
        return makeChain({
          data: [
            {
              delivery_status: "delivered",
              failure_reason: null,
              accepted_at: null,
              sent_at: null,
              delivered_at: "2026-07-20T08:05:00Z",
              read_at: null,
              failed_at: null,
              last_status_at: "2026-07-20T08:05:00Z",
            },
          ],
          error: null,
        });
      }
      return makeChain({ data: [], error: null });
    });

    const result = await buildCommitmentHistory(task);
    expect(result.caveats).toEqual([]);
  });
});

describe("formatCommitmentHistoryAnswer — evidence-based, no raw dump", () => {
  it("names the outcome and at most two pivotal events, not the full log", async () => {
    const task = makeTask({ status: "pending" });
    const result = {
      task,
      timeline: [
        { at: "2026-07-20T08:00:00Z", label: "Created", source: "tasks" as const },
        { at: "2026-07-20T08:02:00Z", label: "Sent", source: "whatsapp_deliveries" as const },
        { at: "2026-07-20T08:05:00Z", label: "Delivered", source: "whatsapp_deliveries" as const },
        { at: "2026-07-20T09:00:00Z", label: "Read", source: "whatsapp_deliveries" as const },
      ],
      caveats: [],
    };
    const answer = formatCommitmentHistoryAnswer(result);
    expect(answer).toContain("prepare the guest room");
    expect(answer).toMatch(/pending/i);
    // "Created" is excluded from the pivotal excerpt, and only two of the
    // remaining three events are surfaced — evidence, not a full dump.
    expect(answer).not.toContain("Created on");
    const mentioned = ["Sent", "Delivered", "Read"].filter((label) => answer.includes(label));
    expect(mentioned.length).toBeLessThanOrEqual(2);
  });

  it("states cancellation plainly", () => {
    const task = makeTask({ status: "cancelled" });
    const answer = formatCommitmentHistoryAnswer({ task, timeline: [], caveats: [] });
    expect(answer).toMatch(/cancelled/i);
  });
});
