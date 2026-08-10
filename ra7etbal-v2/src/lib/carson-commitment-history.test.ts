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
  lookupPersonHistory,
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

  // Permanent regression guard for the confirmed production issue: "What
  // happened with the passport?" must answer ONLY the requested commitment —
  // never an unrelated overdue reminder, Needs You item, or daily-brief
  // content, even though the tool itself was proven (by exhaustive code
  // review — no reminders/daily_brief/ra7etbal_state read anywhere in this
  // module) not to be the source of that leak. Asserting exact equality here
  // means a future change that starts pulling in other state will fail loudly.
  it("returns exactly the no-match string for a zero-match keyword — nothing else, ever", async () => {
    mocks.supabaseFrom.mockReturnValue(makeChain({ data: [], error: null }));
    const result = await lookupCommitmentHistory("passport");
    expect(result).toBe('I don\'t have a record of anything matching "passport".');
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

  it("surfaces the automated quality review even when no quality_substitute_decisions row exists — found via production verification against a real approved errand with no substitute row", async () => {
    const task = makeTask({
      status: "done",
      confirmed_at: "2026-08-02T15:12:38Z",
      quality_review_status: "approved",
      quality_reviewed_at: "2026-08-02T15:10:25Z",
    });
    mocks.supabaseFrom.mockReturnValue(makeChain({ data: [], error: null }));

    const result = await buildCommitmentHistory(task);
    const reviewEvents = result.timeline.filter((e) =>
      e.label.startsWith("Automated quality review"),
    );
    expect(reviewEvents).toHaveLength(1);
    expect(reviewEvents[0].label).toBe("Automated quality review: approved");
    expect(reviewEvents[0].source).toBe("tasks");
  });

  it("labels the owner's later substitute decision distinctly from the automated task-level review", async () => {
    const task = makeTask({
      status: "done",
      quality_review_status: "substitute_review",
      quality_reviewed_at: "2026-08-01T15:03:00Z",
    });
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "quality_substitute_decisions") {
        return makeChain({
          data: [{ decision: "approved_alternative", outcome: "success", reviewed_at: "2026-08-01T23:12:00Z", completed_at: "2026-08-01T23:12:00Z" }],
          error: null,
        });
      }
      return makeChain({ data: [], error: null });
    });

    const result = await buildCommitmentHistory(task);
    expect(result.timeline.map((e) => e.label)).toContain("Automated quality review: substitute_review");
    expect(result.timeline.map((e) => e.label)).toContain("Owner quality decision: approved_alternative");
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

describe("buildCommitmentHistory — substitute-review reconstruction (real production shape)", () => {
  // Reproduces the exact real "Buy a blue pen." production task: an escalation
  // row with review_type "substitute_review", owner_reply_text "Yes buy it",
  // and a task-level quality_review_note "Owner approved the alternative." —
  // with zero quality_substitute_decisions rows (that table has been
  // superseded by staff_escalation_owner_decisions for this flow) and a
  // task.quality_review_status that only reflects the FINAL state ("approved"),
  // not what was true at quality_reviewed_at.
  function mockRealBluePenShape() {
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "staff_escalation_owner_decisions") {
        return makeChain({
          data: [
            {
              status: "delivered_to_staff",
              answered_at: "2026-08-02T15:11:54Z",
              created_at: "2026-08-02T15:10:31Z",
              review_type: "substitute_review",
              owner_reply_text: "Yes buy it",
            },
          ],
          error: null,
        });
      }
      if (table === "confirmations") {
        return makeChain({
          data: [{ confirmed_at: "2026-08-02T15:12:38Z", confirmed_by: null, source: "confirmation_link" }],
          error: null,
        });
      }
      return makeChain({ data: [], error: null });
    });
  }

  // Production verification round 2 (2026-08-03) confirmed the backend was NOT
  // the source of the remaining "completion only" answer: Carson's live reply
  // included an exact clock time ("6:12 PM") that this module structurally
  // cannot produce (it never calls toLocaleTimeString/toLocaleString, only
  // toLocaleDateString with month/day). That time matches the "COMPLETED
  // (recent, treat as history only)" block in src/lib/carson-context.ts's
  // buildCarsonContext() — the static {{ra7etbal_state}} snapshot injected once
  // at session start. The real root cause was Carson never invoking this tool
  // at all, answering from that stale snapshot instead — a prompt/routing gap
  // (COMMITMENT HISTORY lacked the same "never answer from ra7etbal_state,
  // always call the live tool" guardrail DELIVERY STATUS already has), not a
  // backend defect. This test (and the not.toMatch clock-time assertion below)
  // proves the backend's own correctness; it cannot prove Carson actually
  // calls the tool for a given question — that routing behavior lives in the
  // ElevenLabs prompt and can only be verified with a live conversational test.
  it("surfaces the substitution/review story instead of only the final completion", async () => {
    const task = makeTask({
      description: "Buy a blue pen.",
      assigned_to: "Christopher",
      type: "errand",
      status: "done",
      confirmed_at: "2026-08-02T15:12:38Z",
      quality_review_status: "approved",
      quality_review_note: "Owner approved the alternative.",
      quality_reviewed_at: "2026-08-02T15:10:25Z",
    });
    mockRealBluePenShape();

    const result = await buildCommitmentHistory(task);
    const labels = result.timeline.map((e) => e.label);
    expect(labels).toContain("Substitute proposed — needed your review");
    expect(labels.some((l) => l.includes('Owner decided: "Yes buy it"'))).toBe(true);
    expect(labels.some((l) => l.includes("Owner approved the alternative."))).toBe(true);

    const answer = formatCommitmentHistoryAnswer(result);
    expect(answer).toMatch(/Yes buy it/);
    expect(answer).toMatch(/approved the alternative/i);
    // Locks in the exact evidence that proved this was a routing failure, not
    // a backend one: get_commitment_history must never emit a clock time —
    // if it ever starts to, it would become indistinguishable from the
    // ra7etbal_state "COMPLETED" snapshot text that caused the production bug.
    expect(answer).not.toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/i);
  });

  it("skips the generic 'Automated quality review: <current status>' event when a substitute-review escalation exists, since the current status would mislabel the earlier moment", async () => {
    const task = makeTask({
      status: "done",
      quality_review_status: "approved", // final state — NOT what was true at quality_reviewed_at
      quality_review_note: "Owner approved the alternative.",
      quality_reviewed_at: "2026-08-02T15:10:25Z",
    });
    mockRealBluePenShape();

    const result = await buildCommitmentHistory(task);
    expect(result.timeline.map((e) => e.label)).not.toContain("Automated quality review: approved");
  });

  it("still uses the generic 'Automated quality review: <status>' event for a routine review with no owner escalation", async () => {
    const task = makeTask({
      status: "done",
      quality_review_status: "approved",
      quality_reviewed_at: "2026-07-20T09:00:00Z",
    });
    mocks.supabaseFrom.mockReturnValue(makeChain({ data: [], error: null }));

    const result = await buildCommitmentHistory(task);
    expect(result.timeline.map((e) => e.label)).toContain("Automated quality review: approved");
  });

  it("still labels a plain (non-substitute) escalation generically — no substitute-only wording leaks into unrelated escalation types", async () => {
    const task = makeTask({ status: "done" });
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "staff_escalation_owner_decisions") {
        return makeChain({
          data: [
            {
              status: "answered",
              answered_at: "2026-07-21T10:00:00Z",
              created_at: "2026-07-21T09:00:00Z",
              review_type: null,
              owner_reply_text: null,
            },
          ],
          error: null,
        });
      }
      return makeChain({ data: [], error: null });
    });

    const result = await buildCommitmentHistory(task);
    const labels = result.timeline.map((e) => e.label);
    expect(labels).toContain("Owner decision requested");
    expect(labels).toContain("Owner decided");
    expect(labels.some((l) => l.startsWith("Substitute proposed"))).toBe(false);
  });

  it("truncates a long owner_reply_text and quality_review_note before including them in the timeline", async () => {
    const longReply = "A".repeat(200);
    const longNote = "B".repeat(200);
    const task = makeTask({ status: "done", quality_review_note: longNote });
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "staff_escalation_owner_decisions") {
        return makeChain({
          data: [
            {
              status: "delivered_to_staff",
              answered_at: "2026-07-21T10:00:00Z",
              created_at: "2026-07-21T09:00:00Z",
              review_type: "substitute_review",
              owner_reply_text: longReply,
            },
          ],
          error: null,
        });
      }
      return makeChain({ data: [], error: null });
    });

    const result = await buildCommitmentHistory(task);
    const decidedEvent = result.timeline.find((e) => e.label.startsWith("Owner decided"));
    expect(decidedEvent).toBeDefined();
    expect(decidedEvent!.label.length).toBeLessThan(200);
    expect(decidedEvent!.label).toContain("…");
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

  it("prioritizes outcome-relevant events (Confirmed) over administrative ones, even when Confirmed happens last — reproduces the real 'Buy a blue pen' production shape (quality review + escalation both precede Confirmed)", async () => {
    const task = makeTask({ status: "done", confirmed_at: "2026-08-02T15:12:38Z" });
    const result = {
      task,
      timeline: [
        { at: "2026-08-02T15:06:17Z", label: "Created", source: "tasks" as const },
        { at: "2026-08-02T15:10:25Z", label: "Automated quality review: approved", source: "tasks" as const },
        { at: "2026-08-02T15:10:31Z", label: "Owner decision requested", source: "staff_escalation_owner_decisions" as const },
        { at: "2026-08-02T15:11:54Z", label: "Owner decided", source: "staff_escalation_owner_decisions" as const },
        { at: "2026-08-02T15:12:38Z", label: "Confirmed", source: "confirmations" as const },
      ],
      caveats: [],
    };
    const answer = formatCommitmentHistoryAnswer(result);
    // Without the fix, slice(0,2) on chronological order would pick the two
    // earliest non-Created events ("Automated quality review", "Owner
    // decision requested") and silently drop "Confirmed" entirely.
    expect(answer).toContain("Confirmed");
    expect(answer).not.toContain("Automated quality review");
  });

  it("prioritizes the LATEST outcome-relevant events, not the earliest — CodeRabbit finding on PR #165: an earlier Sent/Delivered pair must not crowd out a later Owner-decided/Confirmed pair", async () => {
    const task = makeTask({ status: "done", confirmed_at: "2026-08-02T15:12:38Z" });
    const result = {
      task,
      timeline: [
        { at: "2026-08-02T15:00:00Z", label: "Created", source: "tasks" as const },
        { at: "2026-08-02T15:01:00Z", label: "Sent", source: "whatsapp_deliveries" as const },
        { at: "2026-08-02T15:02:00Z", label: "Delivered", source: "whatsapp_deliveries" as const },
        { at: "2026-08-02T15:11:54Z", label: 'Owner decided: "Yes buy it"', source: "staff_escalation_owner_decisions" as const },
        { at: "2026-08-02T15:12:38Z", label: "Confirmed", source: "confirmations" as const },
      ],
      caveats: [],
    };
    const answer = formatCommitmentHistoryAnswer(result);
    // All four (Sent, Delivered, Owner decided, Confirmed) are outcome-relevant
    // — the fix must pick the latest two (Owner decided, Confirmed), not the
    // first two (Sent, Delivered), which would silently drop the decision.
    expect(answer).toContain("Owner decided");
    expect(answer).toContain("Confirmed");
    expect(answer).not.toContain("Sent on");
    expect(answer).not.toContain("Delivered on");
  });
});

describe("lookupPersonHistory — Historical Lookup Phase 2 (person overview, not task disambiguation)", () => {
  it("asks for a person's name when none is given", async () => {
    const result = await lookupPersonHistory("");
    expect(result).toMatch(/person's name/i);
  });

  it("reports not signed in when there is no authenticated user", async () => {
    mocks.supabaseGetUser.mockResolvedValueOnce({ data: { user: null } });
    const result = await lookupPersonHistory("Grace");
    expect(result).toMatch(/not signed in/i);
  });

  it("says plainly when nothing matches — never guesses", async () => {
    mocks.supabaseFrom.mockReturnValue(makeChain({ data: [], error: null }));
    const result = await lookupPersonHistory("Grace");
    expect(result).toMatch(/don't have a record/i);
    expect(result).toContain("Grace");
  });

  it("gives the full evidence-based lifecycle answer when the person has exactly one commitment — reuses lookupCommitmentHistory's own path, not a reimplementation", async () => {
    const task = makeTask({ assigned_to: "Grace", status: "done", confirmed_at: "2026-07-21T09:00:00Z" });
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "tasks") return makeChain({ data: [task], error: null });
      return makeChain({ data: [], error: null });
    });
    const result = await lookupPersonHistory("Grace");
    expect(result).toContain("prepare the guest room");
    expect(result).toMatch(/confirmed done/i);
    // Must NOT take the multi-match "ask which one" shape for a single result.
    expect(result).not.toMatch(/ask the user which one/i);
  });

  it("summarizes outcome counts and recent items instead of asking which one — the key behavior difference from lookupCommitmentHistory's task-keyword ambiguity", async () => {
    const rows = [
      makeTask({ id: "task-1", assigned_to: "Grace", description: "send the flower inventory", status: "done", confirmed_at: "2026-07-22T10:00:00Z" }),
      makeTask({ id: "task-2", assigned_to: "Grace", description: "restock the pantry", status: "pending" }),
      makeTask({ id: "task-3", assigned_to: "Grace", description: "cancelled catering order", status: "cancelled" }),
    ];
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "tasks") return makeChain({ data: rows, error: null });
      return makeChain({ data: [], error: null });
    });
    const result = await lookupPersonHistory("Grace");
    expect(result).toContain("Grace total: 3 commitments");
    expect(result).toMatch(/1 done/);
    expect(result).toMatch(/1 pending/);
    expect(result).toMatch(/1 cancelled/);
    // Never the task-keyword disambiguation phrasing — a person naturally
    // has multiple commitments; this must not ask which one they mean.
    expect(result).not.toMatch(/ask the user which one/i);
    expect(result).not.toMatch(/found \d+ matching/i);
  });

  it("caps the recent-items list even when more candidates exist", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeTask({ id: `task-${i}`, assigned_to: "Grace", description: `task number ${i}`, status: "pending" }),
    );
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "tasks") return makeChain({ data: rows, error: null });
      return makeChain({ data: [], error: null });
    });
    const result = await lookupPersonHistory("Grace");
    const mentioned = rows.filter((t) => result.includes(t.description)).length;
    expect(mentioned).toBeLessThanOrEqual(3);
  });

  /**
   * Regression coverage for the 2026-08-10 production defect: a person
   * with more than 6 real tasks was reported as having exactly 6 total,
   * because the outcome-count summary was computed from the same
   * .limit(6)-capped candidate list used for the recent-items display.
   *
   * findCommitmentCandidates() (call 1, capped at 6 by the real .limit(6))
   * and fetchPersonOutcomeCounts() (call 2, unbounded) both query "tasks"
   * sequentially — mockReturnValueOnce chains simulate that distinction
   * precisely, since makeChain()'s .limit() is a no-op that doesn't
   * truncate on its own.
   */
  it("reports the TRUE total across all matching tasks, not the 6-row candidate cap, when a person has more than 6 tasks", async () => {
    const cappedCandidates = Array.from({ length: 6 }, (_, i) =>
      makeTask({ id: `recent-${i}`, assigned_to: "Christopher", description: `recent task ${i}`, status: "done" }),
    );
    const fullHistoryRows = Array.from({ length: 9 }, (_, i) => ({
      status: i < 8 ? "done" : "pending",
      dismissed_at: null,
    }));

    mocks.supabaseFrom
      .mockReturnValueOnce(makeChain({ data: cappedCandidates, error: null })) // findCommitmentCandidates
      .mockReturnValueOnce(makeChain({ data: fullHistoryRows, error: null })); // fetchPersonOutcomeCounts

    const result = await lookupPersonHistory("Christopher");

    expect(result).toContain("Christopher total: 9 commitments");
    expect(result).toMatch(/8 done/);
    expect(result).toMatch(/1 pending/);
    expect(result).not.toContain("6 commitments");

    const mentionedRecent = cappedCandidates.filter((t) => result.includes(t.description)).length;
    expect(mentionedRecent).toBeLessThanOrEqual(3);
  });

  /**
   * CodeRabbit finding (PR #219): the full-history count query returning
   * [] on a genuine error was indistinguishable from a real zero-row
   * result, so a query failure could report "0 commitments" right next
   * to a real recent-items list — a directly self-contradictory false
   * statement. fetchPersonOutcomeCounts() now returns null on error;
   * lookupPersonHistory must never state a total in that case.
   */
  it("never reports a false '0 commitments' total when the full-history count query fails — still lists real recent items", async () => {
    const cappedCandidates = Array.from({ length: 3 }, (_, i) =>
      makeTask({ id: `recent-${i}`, assigned_to: "Christopher", description: `recent task ${i}`, status: "done" }),
    );

    mocks.supabaseFrom
      .mockReturnValueOnce(makeChain({ data: cappedCandidates, error: null })) // findCommitmentCandidates
      .mockReturnValueOnce(makeChain({ data: null, error: { message: "db error" } })); // fetchPersonOutcomeCounts fails

    const result = await lookupPersonHistory("Christopher");

    expect(result).not.toMatch(/0 commitments/i);
    expect(result).not.toContain("Christopher total:");
    expect(result).toMatch(/couldn't get an accurate total/i);
    const mentionedRecent = cappedCandidates.filter((t) => result.includes(t.description)).length;
    expect(mentionedRecent).toBeGreaterThan(0);
  });

  it("reports total = 6 through the full-count path when a person has exactly 6 tasks (not coincidentally via the candidate cap)", async () => {
    const candidates = Array.from({ length: 6 }, (_, i) =>
      makeTask({ id: `t-${i}`, assigned_to: "Nasira", description: `task ${i}`, status: "done" }),
    );
    const fullHistoryRows = candidates.map(() => ({ status: "done", dismissed_at: null }));

    mocks.supabaseFrom
      .mockReturnValueOnce(makeChain({ data: candidates, error: null }))
      .mockReturnValueOnce(makeChain({ data: fullHistoryRows, error: null }));

    const result = await lookupPersonHistory("Nasira");

    expect(result).toContain("Nasira total: 6 commitments");
    expect(result).toMatch(/6 done/);
  });
});
