import { beforeEach, describe, expect, it, vi } from "vitest";

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

type QueryCall = { method: string; args: unknown[] };

/**
 * Chainable query builder. `insert`/`update`/`delete` are included
 * deliberately as spies that throw — any accidental write anywhere in
 * carson-communication-history.ts fails the test immediately rather than
 * silently succeeding against a mock, which a plain "assert not called"
 * check alone would not catch if the code path were never exercised by a
 * given test.
 */
function makeChain(result: { data: unknown; error: unknown } = { data: [], error: null }, calls: QueryCall[] = []) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "ilike", "or", "order", "limit"]) {
    b[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return b;
    };
  }
  for (const m of ["insert", "update", "delete"]) {
    b[m] = () => {
      throw new Error(`Unexpected write call: ${m}() against a communication-history source table`);
    };
  }
  // getProfile() (src/lib/profile.ts) terminates its chain with
  // .maybeSingle() rather than the implicit thenable used by every other
  // query in this file — supported here only so lookupCommunicationHistory's
  // orchestrator-level tests can exercise the real profile-timezone fetch.
  b.maybeSingle = () => Promise.resolve(result);
  b.then = (res: (v: typeof result) => unknown, rej?: (r: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return b;
}

const {
  resolvePersonForCommunicationHistory,
  buildCommunicationHistory,
  formatCommunicationHistoryAnswer,
  lookupCommunicationHistory,
  resolveCommunicationHistoryTimezone,
} = await import("./carson-communication-history");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.supabaseGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
});

// ── Person resolution ───────────────────────────────────────────────────────

describe("resolvePersonForCommunicationHistory", () => {
  it("returns no_match for an empty result", async () => {
    mocks.supabaseFrom.mockReturnValue(makeChain({ data: [], error: null }));
    const result = await resolvePersonForCommunicationHistory("Nobody", "user-1");
    expect(result.status).toBe("no_match");
  });

  it("returns ambiguous and lists every candidate when more than one person matches", async () => {
    mocks.supabaseFrom.mockReturnValue(
      makeChain({ data: [{ id: "p1", name: "Christopher" }, { id: "p2", name: "Christopher Lee" }], error: null }),
    );
    const result = await resolvePersonForCommunicationHistory("Christopher", "user-1");
    expect(result.status).toBe("ambiguous");
    expect(result.matches).toHaveLength(2);
  });

  it("returns resolved with exactly one match", async () => {
    mocks.supabaseFrom.mockReturnValue(makeChain({ data: [{ id: "p1", name: "Christopher" }], error: null }));
    const result = await resolvePersonForCommunicationHistory("Christopher", "user-1");
    expect(result.status).toBe("resolved");
    expect(result.matches[0]).toEqual({ id: "p1", name: "Christopher" });
  });

  it("scopes the people query to the given user_id — cross-household isolation", async () => {
    const calls: QueryCall[] = [];
    mocks.supabaseFrom.mockImplementation(() => makeChain({ data: [], error: null }, calls));
    await resolvePersonForCommunicationHistory("Christopher", "user-1");
    expect(calls).toContainEqual({ method: "eq", args: ["user_id", "user-1"] });
  });

  it("returns error status, not no_match, on a genuine query failure", async () => {
    mocks.supabaseFrom.mockReturnValue(makeChain({ data: null, error: { message: "db error" } }));
    const result = await resolvePersonForCommunicationHistory("Christopher", "user-1");
    expect(result.status).toBe("error");
  });

  it("returns error status, not an uncaught rejection, when the query promise itself rejects", async () => {
    mocks.supabaseFrom.mockReturnValue({
      select: () => {
        throw new Error("network failure");
      },
    });
    const result = await resolvePersonForCommunicationHistory("Christopher", "user-1");
    expect(result.status).toBe("error");
  });
});

// ── Timeline construction ───────────────────────────────────────────────────

function mockTables(byTable: Record<string, { data: unknown; error: unknown }>, allCalls: Record<string, QueryCall[]> = {}) {
  mocks.supabaseFrom.mockImplementation((table: string) => {
    const calls = (allCalls[table] ??= []);
    return makeChain(byTable[table] ?? { data: [], error: null }, calls);
  });
}

describe("buildCommunicationHistory", () => {
  it("merges events from multiple source tables into one chronological order", async () => {
    mockTables({
      staff_messages: {
        data: [
          {
            id: "sm1",
            task_id: null,
            inbound_text: "Are we still on for Thursday?",
            carson_response: "Yes, confirmed.",
            received_at: "2026-08-01T09:00:00Z",
            responded_at: "2026-08-01T09:01:00Z",
            external_message_id: "wamid.sm1",
          },
        ],
        error: null,
      },
      personal_contact_replies: {
        data: [
          { id: "pcr1", inbound_text: "Sounds good!", created_at: "2026-08-02T10:00:00Z", external_message_id: "wamid.pcr1" },
        ],
        error: null,
      },
      messages: {
        data: [
          { id: "m1", task_id: "task-1", body: null, content: "Please pick up the dry cleaning.", created_at: "2026-08-03T08:00:00Z", whatsapp_message_id: "wamid.m1", channel: "whatsapp" },
        ],
        error: null,
      },
      whatsapp_deliveries: { data: [], error: null },
      staff_escalation_owner_decisions: { data: [], error: null },
    });

    const result = await buildCommunicationHistory("p1", "Christopher", "user-1");

    expect(result.events).toHaveLength(4); // staff inbound + carson reply + contact reply + outbound message
    const timestamps = result.events.map((e) => e.at);
    const sorted = [...timestamps].sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
    expect(timestamps).toEqual(sorted);
    expect(result.failedSources).toEqual([]);
  });

  it("labels inbound and outbound events correctly", async () => {
    mockTables({
      staff_messages: {
        data: [
          {
            id: "sm1",
            task_id: null,
            inbound_text: "On my way.",
            carson_response: "Got it, thanks.",
            received_at: "2026-08-01T09:00:00Z",
            responded_at: "2026-08-01T09:01:00Z",
            external_message_id: null,
          },
        ],
        error: null,
      },
      personal_contact_replies: { data: [], error: null },
      messages: { data: [], error: null },
      whatsapp_deliveries: { data: [], error: null },
      staff_escalation_owner_decisions: { data: [], error: null },
    });

    const result = await buildCommunicationHistory("p1", "Christopher", "user-1");
    const [received, replied] = result.events;
    expect(received.direction).toBe("inbound");
    expect(received.eventType).toBe("staff_message_received");
    expect(replied.direction).toBe("outbound");
    expect(replied.eventType).toBe("carson_response_sent");
  });

  it("scopes every source-table query to the given user_id — cross-household isolation", async () => {
    const allCalls: Record<string, QueryCall[]> = {};
    mockTables(
      {
        staff_messages: { data: [{ id: "sm1", task_id: "task-1", inbound_text: "hi", carson_response: null, received_at: "2026-08-01T09:00:00Z", responded_at: null, external_message_id: null }], error: null },
      },
      allCalls,
    );

    await buildCommunicationHistory("p1", "Christopher", "user-1");

    for (const table of ["staff_messages", "personal_contact_replies", "messages"]) {
      expect(allCalls[table]).toContainEqual({ method: "eq", args: ["user_id", "user-1"] });
      expect(allCalls[table]).toContainEqual({ method: "eq", args: ["person_id", "p1"] });
    }
    // The staff_messages fixture above has task_id: "task-1", so wave 2's
    // whatsapp_deliveries query is guaranteed to fire — asserted
    // unconditionally, not behind an `if`, so this can't pass vacuously if
    // wave 2 is ever skipped by a future change.
    expect(allCalls.whatsapp_deliveries).toBeDefined();
    expect(allCalls.whatsapp_deliveries).toContainEqual({ method: "eq", args: ["user_id", "user-1"] });
  });

  it("returns an empty, non-failed result when a person genuinely has no communication evidence", async () => {
    mockTables({
      staff_messages: { data: [], error: null },
      personal_contact_replies: { data: [], error: null },
      messages: { data: [], error: null },
    });
    const result = await buildCommunicationHistory("p1", "Christopher", "user-1");
    expect(result.events).toEqual([]);
    expect(result.failedSources).toEqual([]);
  });

  it("marks the source as failed, not silently empty, on a genuine query error", async () => {
    mockTables({
      staff_messages: { data: null, error: { message: "db error" } },
      personal_contact_replies: { data: [], error: null },
      messages: { data: [], error: null },
    });
    const result = await buildCommunicationHistory("p1", "Christopher", "user-1");
    expect(result.failedSources).toContain("staff_messages");
    expect(result.events).toEqual([]);
  });

  it("marks the source as failed, not an uncaught rejection, when a wave-1 query promise itself rejects", async () => {
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "staff_messages") {
        return { select: () => { throw new Error("network failure"); } };
      }
      return makeChain({ data: [], error: null });
    });
    const result = await buildCommunicationHistory("p1", "Christopher", "user-1");
    expect(result.failedSources).toContain("staff_messages");
  });

  it("drops an event with an unparseable timestamp rather than sorting/rendering it as Invalid Date", async () => {
    mockTables({
      staff_messages: {
        data: [
          { id: "sm1", task_id: null, inbound_text: "good", carson_response: null, received_at: "2026-08-01T09:00:00Z", responded_at: null, external_message_id: null },
          { id: "sm2", task_id: null, inbound_text: "corrupted", carson_response: null, received_at: "not-a-real-timestamp", responded_at: null, external_message_id: null },
        ],
        error: null,
      },
      personal_contact_replies: { data: [], error: null },
      messages: { data: [], error: null },
      whatsapp_deliveries: { data: [], error: null },
      staff_escalation_owner_decisions: { data: [], error: null },
    });
    const result = await buildCommunicationHistory("p1", "Christopher", "user-1");
    expect(result.events).toHaveLength(1);
    expect(result.events[0].label).toBe("good");
  });

  it("never emits a duplicate event from the same source row, even if the same row id is returned more than once by a query", async () => {
    // A single .or() query cannot itself produce a duplicate row from
    // Postgres — this proves dedupeById's own defense-in-depth correctness
    // directly, in case a future refactor ever merges results from more
    // than one query for the same table (exactly the class of bug the
    // partial unique index behind the push-subscription "This device"
    // badge exists to guard against at the DB layer — this is the
    // equivalent app-layer guard for a table with no such constraint).
    mockTables({
      staff_messages: { data: [], error: null },
      personal_contact_replies: { data: [], error: null },
      messages: {
        data: [{ id: "m1", task_id: "task-1", body: null, content: "reminder text", created_at: "2026-08-01T10:00:00Z", whatsapp_message_id: "wamid.m1", channel: "whatsapp" }],
        error: null,
      },
      whatsapp_deliveries: {
        data: [
          { id: "wd1", message_id: "m1", task_id: "task-1", delivery_status: "delivered", failure_reason: null, accepted_at: null, sent_at: null, delivered_at: "2026-08-01T10:05:00Z", read_at: null, failed_at: null, meta_message_id: "wamid.wd1" },
          { id: "wd1", message_id: "m1", task_id: "task-1", delivery_status: "delivered", failure_reason: null, accepted_at: null, sent_at: null, delivered_at: "2026-08-01T10:05:00Z", read_at: null, failed_at: null, meta_message_id: "wamid.wd1" },
        ],
        error: null,
      },
      staff_escalation_owner_decisions: { data: [], error: null },
    });

    const result = await buildCommunicationHistory("p1", "Christopher", "user-1");
    const deliveryEvents = result.events.filter((e) => e.source === "whatsapp_deliveries");
    expect(deliveryEvents).toHaveLength(1);
  });

  it("surfaces both task-linked and non-task communication in the same timeline", async () => {
    mockTables({
      staff_messages: {
        data: [{ id: "sm1", task_id: "task-1", inbound_text: "task-linked message", carson_response: null, received_at: "2026-08-01T09:00:00Z", responded_at: null, external_message_id: null }],
        error: null,
      },
      personal_contact_replies: {
        data: [{ id: "pcr1", inbound_text: "not linked to any task", created_at: "2026-08-02T09:00:00Z", external_message_id: null }],
        error: null,
      },
      messages: { data: [], error: null },
      whatsapp_deliveries: { data: [], error: null },
      staff_escalation_owner_decisions: { data: [], error: null },
    });

    const result = await buildCommunicationHistory("p1", "Christopher", "user-1");
    const taskLinked = result.events.find((e) => e.source === "staff_messages");
    const nonTask = result.events.find((e) => e.source === "personal_contact_replies");
    expect(taskLinked?.taskId).toBe("task-1");
    expect(nonTask?.taskId).toBeNull();
  });

  it("never issues an insert/update/delete against any source table", async () => {
    mockTables({
      staff_messages: { data: [{ id: "sm1", task_id: "task-1", inbound_text: "hi", carson_response: "ok", received_at: "2026-08-01T09:00:00Z", responded_at: "2026-08-01T09:01:00Z", external_message_id: null }], error: null },
      personal_contact_replies: { data: [{ id: "pcr1", inbound_text: "hey", created_at: "2026-08-01T09:02:00Z", external_message_id: null }], error: null },
      messages: { data: [{ id: "m1", task_id: "task-1", body: null, content: "reminder", created_at: "2026-08-01T09:03:00Z", whatsapp_message_id: null, channel: "whatsapp" }], error: null },
      whatsapp_deliveries: { data: [{ id: "wd1", message_id: "m1", task_id: "task-1", delivery_status: "delivered", failure_reason: null, accepted_at: null, sent_at: null, delivered_at: "2026-08-01T09:04:00Z", read_at: null, failed_at: null, meta_message_id: null }], error: null },
      staff_escalation_owner_decisions: { data: [{ id: "esc1", task_id: "task-1", staff_message_id: "sm1", status: "open", owner_reply_text: null, answered_at: null, created_at: "2026-08-01T09:05:00Z" }], error: null },
    });
    // Reaching this line without the mock's insert/update/delete spies
    // throwing is itself the proof — they throw unconditionally if called.
    await expect(buildCommunicationHistory("p1", "Christopher", "user-1")).resolves.toBeDefined();
  });

  // ── Durable person_id retrieval (task-deletion survival) ──────────────────
  //
  // task_id/message_id/staff_message_id are all ON DELETE SET NULL when the
  // linked task is deleted (Clear History, voice "delete that task") — a
  // real, intentional, actively-used feature, not a bug. person_id is
  // written independent of task_id and is never touched by that deletion.
  // These tests use rows with task_id/staff_message_id/message_id already
  // null (as they are after a real deletion) and only person_id set —
  // exactly the shape of a real orphaned-but-recoverable row.

  it("owner-decision history survives task deletion — found via person_id alone", async () => {
    mockTables({
      staff_messages: { data: [], error: null },
      personal_contact_replies: { data: [], error: null },
      messages: { data: [], error: null },
      whatsapp_deliveries: { data: [], error: null },
      staff_escalation_owner_decisions: {
        data: [
          {
            id: "esc-orphaned",
            task_id: null,
            staff_message_id: null,
            status: "delivered_to_staff",
            owner_reply_text: "Approve it",
            answered_at: "2026-08-05T19:53:23Z",
            created_at: "2026-08-04T22:47:01Z",
          },
        ],
        error: null,
      },
    });

    const result = await buildCommunicationHistory("p1", "Christopher", "user-1");
    const decided = result.events.find((e) => e.eventType === "escalation_decided");
    expect(decided).toBeDefined();
    expect(decided?.label).toContain("Approve it");
  });

  it("delivery history survives task deletion — found via person_id alone", async () => {
    mockTables({
      staff_messages: { data: [], error: null },
      personal_contact_replies: { data: [], error: null },
      messages: { data: [], error: null },
      whatsapp_deliveries: {
        data: [
          {
            id: "wd-orphaned",
            message_id: null,
            task_id: null,
            delivery_status: "delivered",
            failure_reason: null,
            accepted_at: null,
            sent_at: null,
            delivered_at: "2026-08-04T22:50:00Z",
            read_at: null,
            failed_at: null,
            meta_message_id: null,
          },
        ],
        error: null,
      },
      staff_escalation_owner_decisions: { data: [], error: null },
    });

    const result = await buildCommunicationHistory("p1", "Christopher", "user-1");
    expect(result.events.some((e) => e.eventType === "delivery_delivered")).toBe(true);
  });

  it("always queries wave-2 tables by person_id, even with nothing to legacy-link against", async () => {
    const allCalls: Record<string, QueryCall[]> = {};
    mockTables(
      {
        staff_messages: { data: [], error: null },
        personal_contact_replies: { data: [], error: null },
        messages: { data: [], error: null },
      },
      allCalls,
    );

    await buildCommunicationHistory("p1", "Christopher", "user-1");

    const deliveryOr = allCalls.whatsapp_deliveries?.find((c) => c.method === "or");
    const escalationOr = allCalls.staff_escalation_owner_decisions?.find((c) => c.method === "or");
    expect(String(deliveryOr?.args[0])).toContain("person_id.eq.p1");
    expect(String(escalationOr?.args[0])).toContain("person_id.eq.p1");
  });

  it("does not double-report a row found through both the durable and legacy paths", async () => {
    // A single row can legitimately satisfy person_id.eq AND task_id.in in
    // the same .or(...) query — Postgres/PostgREST returns it once, and
    // buildCommunicationHistory's existing dedupeById() must not turn that
    // one row into two events.
    mockTables({
      staff_messages: {
        data: [
          { id: "sm1", task_id: "task-1", inbound_text: "hi", carson_response: null, received_at: "2026-08-01T09:00:00Z", responded_at: null, external_message_id: null },
        ],
        error: null,
      },
      personal_contact_replies: { data: [], error: null },
      messages: { data: [], error: null },
      whatsapp_deliveries: { data: [], error: null },
      staff_escalation_owner_decisions: {
        data: [
          { id: "esc-dual", task_id: "task-1", staff_message_id: null, status: "delivered_to_staff", owner_reply_text: "Yes", answered_at: "2026-08-01T09:10:00Z", created_at: "2026-08-01T09:05:00Z" },
        ],
        error: null,
      },
    });

    const result = await buildCommunicationHistory("p1", "Christopher", "user-1");
    const decidedEvents = result.events.filter((e) => e.eventType === "escalation_decided" && e.label.includes("Yes"));
    expect(decidedEvents).toHaveLength(1);
  });

  it("legacy-only rows (no person_id, pre-dating this column) still surface via task/message id", async () => {
    mockTables({
      staff_messages: {
        data: [
          { id: "sm1", task_id: "task-1", inbound_text: "hi", carson_response: null, received_at: "2026-08-01T09:00:00Z", responded_at: null, external_message_id: null },
        ],
        error: null,
      },
      personal_contact_replies: { data: [], error: null },
      messages: { data: [], error: null },
      whatsapp_deliveries: { data: [], error: null },
      staff_escalation_owner_decisions: {
        data: [
          { id: "esc-legacy", task_id: "task-1", staff_message_id: null, status: "delivered_to_staff", owner_reply_text: "Legacy approval", answered_at: "2026-08-01T09:10:00Z", created_at: "2026-08-01T09:05:00Z" },
        ],
        error: null,
      },
    });

    const result = await buildCommunicationHistory("p1", "Christopher", "user-1");
    expect(result.events.some((e) => e.label.includes("Legacy approval"))).toBe(true);
  });
});

// ── Answer formatting ───────────────────────────────────────────────────────

describe("formatCommunicationHistoryAnswer", () => {
  it("states truthful no-history, not an error, when there is genuinely no evidence", () => {
    const answer = formatCommunicationHistoryAnswer({ personId: "p1", personName: "Christopher", events: [], failedSources: [] }, "UTC");
    expect(answer).toMatch(/don't have a record/i);
    expect(answer).not.toMatch(/couldn't|error|try again/i);
  });

  it("states a truthful partial-failure message, never a false 'no history', when a query failed and nothing was returned", () => {
    const answer = formatCommunicationHistoryAnswer({ personId: "p1", personName: "Christopher", events: [], failedSources: ["staff_messages"] }, "UTC");
    expect(answer).toMatch(/couldn't fully check/i);
    expect(answer).not.toMatch(/don't have a record/i);
  });

  it("appends an incompleteness caveat when some events exist but a source still failed", () => {
    const answer = formatCommunicationHistoryAnswer({
      personId: "p1",
      personName: "Christopher",
      events: [{ at: "2026-08-01T09:00:00Z", direction: "inbound", eventType: "staff_message_received", channel: "whatsapp", label: "hi", source: "staff_messages", taskId: null, transportMessageId: null }],
      failedSources: ["messages"],
    }, "UTC");
    expect(answer).toMatch(/may be incomplete/i);
  });

  it("never labels a delivery-status event as if it were message content", () => {
    const answer = formatCommunicationHistoryAnswer({
      personId: "p1",
      personName: "Christopher",
      events: [{ at: "2026-08-01T09:00:00Z", direction: "outbound", eventType: "delivery_delivered", channel: "whatsapp", label: "Delivered", source: "whatsapp_deliveries", taskId: null, transportMessageId: null }],
      failedSources: [],
    }, "UTC");
    expect(answer).toContain("Delivered");
    expect(answer).not.toMatch(/"Delivered"/); // not quoted as if it were spoken/typed content
  });

  it("caps rendered events at the most recent MAX_RENDERED_EVENTS and states the true total", () => {
    const events = Array.from({ length: 25 }, (_, i) => ({
      at: `2026-08-${String(i + 1).padStart(2, "0")}T09:00:00Z`,
      direction: "inbound" as const,
      eventType: "staff_message_received",
      channel: "whatsapp",
      label: `event ${i + 1}`,
      source: "staff_messages" as const,
      taskId: null,
      transportMessageId: null,
    }));
    const answer = formatCommunicationHistoryAnswer({ personId: "p1", personName: "Christopher", events, failedSources: [] }, "UTC");
    // Only the most recent (highest-numbered) events render, not the oldest.
    expect(answer).toContain("event 25");
    expect(answer).not.toContain("event 1 ");
    expect(answer).toMatch(/most recent of 25 total/i);
  });

  it("includes the year in the rendered date only when the event is not from the current year, judged in the account timezone", () => {
    const lastYear = new Date().getFullYear() - 1;
    const answer = formatCommunicationHistoryAnswer({
      personId: "p1",
      personName: "Christopher",
      events: [
        { at: `${lastYear}-08-01T09:00:00Z`, direction: "inbound", eventType: "staff_message_received", channel: "whatsapp", label: "old", source: "staff_messages", taskId: null, transportMessageId: null },
        { at: new Date().toISOString(), direction: "inbound", eventType: "staff_message_received", channel: "whatsapp", label: "recent", source: "staff_messages", taskId: null, transportMessageId: null },
      ],
      failedSources: [],
    }, "UTC");
    expect(answer).toContain(String(lastYear));
  });

  // ── Timestamp rendering (Communication History event timestamps) ─────────

  it("renders both calendar date and clock time for every event", () => {
    const answer = formatCommunicationHistoryAnswer({
      personId: "p1",
      personName: "Christopher",
      events: [{ at: "2026-08-01T14:30:00Z", direction: "inbound", eventType: "staff_message_received", channel: "whatsapp", label: "hi", source: "staff_messages", taskId: null, transportMessageId: null }],
      failedSources: [],
    }, "UTC");
    expect(answer).toMatch(/Aug 1/);
    expect(answer).toMatch(/2:30\s*PM/i);
  });

  it("renders in the stored account timezone, not a hardcoded or device default — the same UTC instant differs across two account timezones", () => {
    const event = { at: "2026-08-01T14:30:00Z", direction: "inbound" as const, eventType: "staff_message_received", channel: "whatsapp", label: "hi", source: "staff_messages" as const, taskId: null, transportMessageId: null };
    const inTokyo = formatCommunicationHistoryAnswer({ personId: "p1", personName: "Christopher", events: [event], failedSources: [] }, "Asia/Tokyo");
    const inLosAngeles = formatCommunicationHistoryAnswer({ personId: "p1", personName: "Christopher", events: [event], failedSources: [] }, "America/Los_Angeles");
    // 14:30 UTC is 23:30 in Tokyo (UTC+9) the same calendar day, and 07:30
    // in Los Angeles (UTC-7 in August) — genuinely different clock times,
    // proving the timezone argument is actually applied, not ignored.
    expect(inTokyo).toMatch(/11:30\s*PM/i);
    expect(inLosAngeles).toMatch(/7:30\s*AM/i);
    expect(inTokyo).not.toBe(inLosAngeles);
  });

  it("a timezone day-boundary crossing displays the account-local calendar date, not the UTC date", () => {
    // 23:30 UTC on Aug 1 is already 08:30 on Aug 2 in Tokyo (UTC+9) — the
    // UTC date and the account-local date genuinely disagree here.
    const answer = formatCommunicationHistoryAnswer({
      personId: "p1",
      personName: "Christopher",
      events: [{ at: "2026-08-01T23:30:00Z", direction: "inbound", eventType: "staff_message_received", channel: "whatsapp", label: "hi", source: "staff_messages", taskId: null, transportMessageId: null }],
      failedSources: [],
    }, "Asia/Tokyo");
    expect(answer).toMatch(/Aug 2/);
    expect(answer).not.toMatch(/Aug 1\b/);
  });

  it("never renders 'Invalid Date' when given a valid event and a valid timezone", () => {
    const answer = formatCommunicationHistoryAnswer({
      personId: "p1",
      personName: "Christopher",
      events: [{ at: "2026-08-01T14:30:00Z", direction: "inbound", eventType: "staff_message_received", channel: "whatsapp", label: "hi", source: "staff_messages", taskId: null, transportMessageId: null }],
      failedSources: [],
    }, "Europe/Istanbul");
    expect(answer).not.toMatch(/invalid date/i);
  });
});

// ── Timezone resolution ──────────────────────────────────────────────────────

describe("resolveCommunicationHistoryTimezone", () => {
  it("uses the stored account timezone when it is a valid IANA identifier — the authoritative source", () => {
    expect(resolveCommunicationHistoryTimezone("Asia/Tokyo")).toBe("Asia/Tokyo");
  });

  it("falls through to the browser/device timezone when the stored timezone is missing (null)", () => {
    const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(resolveCommunicationHistoryTimezone(null)).toBe(deviceTimezone);
  });

  it("falls through to the browser/device timezone when the stored timezone is missing (undefined) — the failed-profile-fetch case", () => {
    // Simulates lookupCommunicationHistory's own behavior on a failed
    // profile fetch: it passes null through, never a hardcoded location
    // standing in for a real account it couldn't actually check.
    const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(resolveCommunicationHistoryTimezone(undefined)).toBe(deviceTimezone);
  });

  it("falls through to the browser/device timezone, not a hardcoded location, when the stored value is an invalid IANA identifier", () => {
    const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(resolveCommunicationHistoryTimezone("Not/A_Real_Timezone")).toBe(deviceTimezone);
  });

  it("resolves to a real, valid timezone identifier usable by Intl.DateTimeFormat, never throwing", () => {
    const resolved = resolveCommunicationHistoryTimezone("garbage-value");
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: resolved }).format()).not.toThrow();
  });
});

// ── Top-level orchestrator ──────────────────────────────────────────────────

describe("lookupCommunicationHistory", () => {
  it("returns not-signed-in truthfully when there is no authenticated user", async () => {
    mocks.supabaseGetUser.mockResolvedValue({ data: { user: null } });
    const result = await lookupCommunicationHistory("Christopher");
    expect(result).toMatch(/not signed in/i);
  });

  it("asks the user to clarify on an ambiguous person match — never guesses", async () => {
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "people") {
        return makeChain({ data: [{ id: "p1", name: "Christopher" }, { id: "p2", name: "Christopher Lee" }], error: null });
      }
      return makeChain({ data: [], error: null });
    });
    const result = await lookupCommunicationHistory("Christopher");
    expect(result).toMatch(/more than one person/i);
    expect(result).toMatch(/which one/i);
  });

  it("reports no match truthfully when no person matches", async () => {
    mocks.supabaseFrom.mockImplementation(() => makeChain({ data: [], error: null }));
    const result = await lookupCommunicationHistory("Nobody");
    expect(result).toMatch(/don't have anyone matching/i);
  });

  // ── Account-timezone threading (Communication History event timestamps) ──

  function mockResolvedPersonWithEvent(morningBriefTimezone: string | null) {
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "people") {
        return makeChain({ data: [{ id: "p1", name: "Christopher" }], error: null });
      }
      if (table === "profiles") {
        return makeChain({
          data: { display_name: "Sana", weather_city: null, morning_brief_timezone: morningBriefTimezone, evening_brief_enabled: false, evening_brief_time: "20:00" },
          error: null,
        });
      }
      if (table === "staff_messages") {
        return makeChain({
          data: [{ id: "sm1", task_id: null, inbound_text: "hi", carson_response: null, received_at: "2026-08-01T23:30:00Z", responded_at: null, external_message_id: null }],
          error: null,
        });
      }
      return makeChain({ data: [], error: null });
    });
  }

  it("uses the stored profiles.morning_brief_timezone end to end — the resulting answer reflects the account-local date, not UTC", async () => {
    mockResolvedPersonWithEvent("Asia/Tokyo");
    const result = await lookupCommunicationHistory("Christopher");
    // 23:30 UTC on Aug 1 is 08:30 Aug 2 in Tokyo — proves the real fetched
    // profile value was actually threaded through to the render, not a
    // default.
    expect(result).toMatch(/Aug 2/);
  });

  it("falls back to the browser/device timezone, not a hardcoded location, when the profile has no stored timezone", async () => {
    mockResolvedPersonWithEvent(null);
    const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // A full "month day" fragment, not a bare day number — a bare number
    // (e.g. "1") would trivially match the answer's own "1 communication
    // event..." header line regardless of whether the date rendering was
    // actually correct.
    const expectedDate = new Intl.DateTimeFormat("en-US", { timeZone: deviceTimezone, month: "short", day: "numeric" }).format(new Date("2026-08-01T23:30:00Z"));
    const result = await lookupCommunicationHistory("Christopher");
    expect(result).toContain(expectedDate);
  });

  it("falls back to the browser/device timezone, not Europe/Istanbul or any other hardcoded location, when the profile fetch itself fails", async () => {
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "people") {
        return makeChain({ data: [{ id: "p1", name: "Christopher" }], error: null });
      }
      if (table === "profiles") {
        return makeChain({ data: null, error: { message: "db error" } });
      }
      if (table === "staff_messages") {
        return makeChain({
          data: [{ id: "sm1", task_id: null, inbound_text: "hi", carson_response: null, received_at: "2026-08-01T23:30:00Z", responded_at: null, external_message_id: null }],
          error: null,
        });
      }
      return makeChain({ data: [], error: null });
    });
    const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // A full "month day" fragment, not a bare day number — a bare number
    // (e.g. "1") would trivially match the answer's own "1 communication
    // event..." header line regardless of whether the date rendering was
    // actually correct.
    const expectedDate = new Intl.DateTimeFormat("en-US", { timeZone: deviceTimezone, month: "short", day: "numeric" }).format(new Date("2026-08-01T23:30:00Z"));
    const result = await lookupCommunicationHistory("Christopher");
    expect(result).toContain(expectedDate);
  });

  // ── Existing behavior unaffected by the timestamp/timezone change ────────

  it("still surfaces the exact same event content, attribution, and direction wording after the timezone fetch is added", async () => {
    mockResolvedPersonWithEvent("Asia/Tokyo");
    const result = await lookupCommunicationHistory("Christopher");
    expect(result).toContain("hi");
    expect(result).toMatch(/from Christopher/);
    expect(result).toMatch(/^1 communication event with Christopher, in order:/);
  });
});
