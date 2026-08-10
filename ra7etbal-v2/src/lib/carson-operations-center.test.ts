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

// Chainable query builder — returns the same builder for every method,
// final resolution is controlled per-test via the `resolve` helper.
function makeChain(result: { data: unknown; error: unknown } | null = { data: [], error: null }) {
  const b: Record<string, unknown> = {};
  const methods = ["select", "eq", "or", "gte", "in", "order", "limit"];
  for (const m of methods) b[m] = () => b;
  b.maybeSingle = async () => result;
  b.then = (res: (v: typeof result) => unknown, rej?: (r: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return b;
}

const { fetchTaskDeliveryStatus, fetchOperationsSummary } = await import("./carson-operations-center");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.supabaseGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
});

// ── fetchTaskDeliveryStatus ───────────────────────────────────────────────────

describe("fetchTaskDeliveryStatus", () => {
  it("returns prompt when keyword is empty", async () => {
    const result = await fetchTaskDeliveryStatus("");
    expect(result).toMatch(/which task or person/i);
  });

  it("returns not-signed-in message when user is null", async () => {
    mocks.supabaseGetUser.mockResolvedValue({ data: { user: null } });
    const result = await fetchTaskDeliveryStatus("Ahmed");
    expect(result).toMatch(/not signed in/i);
  });

  it("returns 'not found' when no tasks match", async () => {
    mocks.supabaseFrom.mockReturnValue(makeChain({ data: [], error: null }));
    const result = await fetchTaskDeliveryStatus("Ahmed");
    expect(result).toMatch(/no tasks found/i);
    expect(result).toContain("Ahmed");
  });

  it("returns 'not found' on task query error", async () => {
    mocks.supabaseFrom.mockReturnValue(makeChain({ data: null, error: { message: "db error" } }));
    const result = await fetchTaskDeliveryStatus("kitchen");
    expect(result).toMatch(/no tasks found/i);
  });

  it("reports 'read' delivery status with age", async () => {
    const readAt = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 min ago
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "tasks") {
        return makeChain({
          data: [
            { id: "task-1", description: "Send photo to Ahmed", assigned_to: "Ahmed", type: "delegation", status: "pending", reminder_delivery_status: null, reminder_delivery_error: null, created_at: new Date().toISOString() },
          ],
          error: null,
        });
      }
      // whatsapp_deliveries
      return makeChain({
        data: [
          { delivery_status: "read", failure_reason: null, failure_code: null, failure_stage: null, accepted_at: null, sent_at: null, delivered_at: null, read_at: readAt, failed_at: null, last_status_at: readAt },
        ],
        error: null,
      });
    });
    const result = await fetchTaskDeliveryStatus("Ahmed");
    expect(result).toContain("Send photo to Ahmed");
    expect(result).toMatch(/WhatsApp: read/i);
    expect(result).toMatch(/10m ago/);
  });

  it("reports 'delivered but not read'", async () => {
    const delivAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "tasks") {
        return makeChain({
          data: [{ id: "t1", description: "Kitchen task", assigned_to: "Nasira", type: "delegation", status: "pending", reminder_delivery_status: null, reminder_delivery_error: null, created_at: new Date().toISOString() }],
          error: null,
        });
      }
      return makeChain({
        data: [{ delivery_status: "delivered", failure_reason: null, failure_code: null, failure_stage: null, accepted_at: null, sent_at: null, delivered_at: delivAt, read_at: null, failed_at: null, last_status_at: delivAt }],
        error: null,
      });
    });
    const result = await fetchTaskDeliveryStatus("kitchen");
    expect(result).toMatch(/delivered.*, not yet read/i);
  });

  it("reports failed delivery with reason", async () => {
    const failedAt = new Date(Date.now() - 5 * 3_600_000).toISOString();
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "tasks") {
        return makeChain({
          data: [{ id: "t1", description: "Send update to staff", assigned_to: "Grace", type: "delegation", status: "pending", reminder_delivery_status: null, reminder_delivery_error: null, created_at: new Date().toISOString() }],
          error: null,
        });
      }
      return makeChain({
        data: [{ delivery_status: "failed", failure_reason: "recipient phone not found", failure_code: "131026", failure_stage: "meta_send", accepted_at: null, sent_at: null, delivered_at: null, read_at: null, failed_at: failedAt, last_status_at: failedAt }],
        error: null,
      });
    });
    const result = await fetchTaskDeliveryStatus("staff");
    expect(result).toMatch(/FAILED/i);
    expect(result).toContain("recipient phone not found");
    expect(result).toMatch(/stage: meta_send/i);
  });

  it("reports reminder delivery failure from tasks table", async () => {
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "tasks") {
        return makeChain({
          data: [{ id: "r1", description: "Call bank", assigned_to: null, type: "reminder", status: "pending", reminder_delivery_status: "failed", reminder_delivery_error: "no push subscriptions", created_at: new Date().toISOString() }],
          error: null,
        });
      }
      return makeChain({ data: [], error: null });
    });
    const result = await fetchTaskDeliveryStatus("bank");
    expect(result).toContain("Call bank");
    expect(result).toMatch(/Reminder delivery: failed — no push subscriptions/i);
  });

  it("skips reminder_delivery block when status is 'scheduled'", async () => {
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "tasks") {
        return makeChain({
          data: [{ id: "r1", description: "Buy groceries", assigned_to: null, type: "reminder", status: "pending", reminder_delivery_status: "scheduled", reminder_delivery_error: null, created_at: new Date().toISOString() }],
          error: null,
        });
      }
      return makeChain({ data: [], error: null });
    });
    const result = await fetchTaskDeliveryStatus("groceries");
    expect(result).not.toMatch(/Reminder delivery/i);
  });

  it("reports 'no delivery record' for delegation type tasks with no whatsapp row", async () => {
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "tasks") {
        return makeChain({
          data: [{ id: "d1", description: "Fix the tap", assigned_to: "Ahmed", type: "delegation", status: "pending", reminder_delivery_status: null, reminder_delivery_error: null, created_at: new Date().toISOString() }],
          error: null,
        });
      }
      return makeChain({ data: [], error: null });
    });
    const result = await fetchTaskDeliveryStatus("tap");
    expect(result).toMatch(/no delivery record found/i);
  });

  /**
   * Parallelization regression coverage: the per-task whatsapp_deliveries
   * lookup was changed from a sequential for-loop (one query awaited at a
   * time) to Promise.all (all queries fired concurrently). This must not
   * change: task iteration order, which delivery rows attach to which
   * task, or the resolved-out-of-order case where a later task's query
   * happens to resolve before an earlier task's.
   */
  it("preserves exact task order and correct per-task delivery matching across multiple tasks (parallelized lookup)", async () => {
    const readAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const failedAt = new Date(Date.now() - 5 * 3_600_000).toISOString();
    let deliveryCallCount = 0;

    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "tasks") {
        return makeChain({
          data: [
            { id: "task-first", description: "First task for Christopher", assigned_to: "Christopher", type: "delegation", status: "done", reminder_delivery_status: null, reminder_delivery_error: null, created_at: new Date().toISOString() },
            { id: "task-second", description: "Second task for Christopher", assigned_to: "Christopher", type: "delegation", status: "done", reminder_delivery_status: null, reminder_delivery_error: null, created_at: new Date().toISOString() },
            { id: "task-third", description: "Third task for Christopher", assigned_to: "Christopher", type: "delegation", status: "done", reminder_delivery_status: null, reminder_delivery_error: null, created_at: new Date().toISOString() },
          ],
          error: null,
        });
      }

      // whatsapp_deliveries — each call returns a chain whose resolution
      // order is deliberately scrambled (the third task's query resolves
      // before the first's) to prove Promise.all's index correspondence,
      // not call-completion order, determines which delivery attaches to
      // which task in the output.
      const callIndex = deliveryCallCount;
      deliveryCallCount += 1;
      const resultsByCallIndex = [
        { data: [{ delivery_status: "read", failure_reason: null, failure_code: null, failure_stage: null, accepted_at: null, sent_at: null, delivered_at: null, read_at: readAt, failed_at: null, last_status_at: readAt }], error: null },
        { data: [], error: null },
        { data: [{ delivery_status: "failed", failure_reason: "recipient phone not found", failure_code: "131026", failure_stage: "meta_send", accepted_at: null, sent_at: null, delivered_at: null, read_at: null, failed_at: failedAt, last_status_at: failedAt }], error: null },
      ];
      const resolveDelays = [15, 1, 5]; // ms — third call's chain resolves before the first's
      const chain = makeChain(resultsByCallIndex[callIndex]);
      const originalThen = chain.then as (res: (v: unknown) => unknown, rej?: (r: unknown) => unknown) => unknown;
      chain.then = (res: (v: unknown) => unknown, rej?: (r: unknown) => unknown) =>
        new Promise((resolve) => setTimeout(resolve, resolveDelays[callIndex])).then(() => originalThen(res, rej));
      return chain;
    });

    const result = await fetchTaskDeliveryStatus("Christopher");

    // Task order in the output must match the original query order
    // (first/second/third), not resolution order (third/first/second).
    const firstIndex = result.indexOf("First task for Christopher");
    const secondIndex = result.indexOf("Second task for Christopher");
    const thirdIndex = result.indexOf("Third task for Christopher");
    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(firstIndex);
    expect(thirdIndex).toBeGreaterThan(secondIndex);

    // Each task's own delivery evidence must appear directly after that
    // task's own line, not another task's.
    const firstBlock = result.slice(firstIndex, secondIndex);
    const secondBlock = result.slice(secondIndex, thirdIndex);
    const thirdBlock = result.slice(thirdIndex);
    expect(firstBlock).toMatch(/WhatsApp: read/i);
    expect(firstBlock).not.toMatch(/FAILED/i);
    expect(secondBlock).toMatch(/no delivery record found/i);
    expect(thirdBlock).toMatch(/FAILED/i);
    expect(thirdBlock).toContain("recipient phone not found");
  });
});

// ── fetchOperationsSummary ────────────────────────────────────────────────────

describe("fetchOperationsSummary", () => {
  it("returns not-signed-in message when user is null", async () => {
    mocks.supabaseGetUser.mockResolvedValue({ data: { user: null } });
    const result = await fetchOperationsSummary();
    expect(result).toMatch(/not signed in/i);
  });

  it("reports 'no failures' when all deliveries are ok", async () => {
    mocks.supabaseFrom.mockImplementation(() => makeChain({ data: [], error: null }));
    const result = await fetchOperationsSummary();
    expect(result).toContain("OPERATIONS SUMMARY");
    expect(result).toMatch(/no whatsapp delivery failures/i);
    expect(result).toMatch(/no reminder delivery issues/i);
  });

  it("reports WhatsApp delivery failures count and details", async () => {
    const failedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "whatsapp_deliveries") {
        return makeChain({
          data: [
            { recipient_name: "Ahmed", source_type: "task", failure_reason: "invalid phone", failure_code: "131026", failed_at: failedAt },
            { recipient_name: "Nasira", source_type: "task", failure_reason: "Template rejected", failure_code: null, failed_at: failedAt },
          ],
          error: null,
        });
      }
      return makeChain({ data: [], error: null });
    });
    const result = await fetchOperationsSummary();
    expect(result).toContain("WhatsApp delivery failures (2):");
    expect(result).toContain("Ahmed");
    expect(result).toContain("invalid phone");
    expect(result).toContain("Nasira");
    expect(result).toContain("Template rejected");
  });

  it("reports reminder delivery issues", async () => {
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "tasks") {
        return makeChain({
          data: [
            { description: "Call doctor", assigned_to: null, reminder_delivery_status: "delivery_unconfirmed", reminder_delivery_error: null, created_at: new Date().toISOString() },
          ],
          error: null,
        });
      }
      return makeChain({ data: [], error: null });
    });
    const result = await fetchOperationsSummary();
    expect(result).toContain("Reminder delivery issues (1):");
    expect(result).toContain("Call doctor");
    expect(result).toContain("delivery_unconfirmed");
  });

  it("reports both WhatsApp and reminder issues together", async () => {
    const failedAt = new Date(Date.now() - 1 * 3_600_000).toISOString();
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "whatsapp_deliveries") {
        return makeChain({
          data: [{ recipient_name: "Grace", source_type: "task", failure_reason: "user not found", failure_code: null, failed_at: failedAt }],
          error: null,
        });
      }
      // tasks table
      return makeChain({
        data: [{ description: "Reminder: pick up kids", assigned_to: null, reminder_delivery_status: "failed", reminder_delivery_error: "no subscriptions", created_at: new Date().toISOString() }],
        error: null,
      });
    });
    const result = await fetchOperationsSummary();
    expect(result).toContain("WhatsApp delivery failures (1):");
    expect(result).toContain("Grace");
    expect(result).toContain("Reminder delivery issues (1):");
    expect(result).toContain("Reminder: pick up kids");
  });
});
