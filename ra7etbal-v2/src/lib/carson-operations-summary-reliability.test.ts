import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  supabaseGetUser: vi.fn(),
  supabaseFrom: vi.fn(),
}));

vi.mock("./supabase", () => ({
  supabase: {
    auth: { getUser: mocks.supabaseGetUser },
    from: mocks.supabaseFrom,
  },
}));

type QueryResult = { data: unknown; error: unknown };

type QueryCall = {
  method: string;
  args: unknown[];
};

function makeChain(result: QueryResult, calls: QueryCall[] = []) {
  const b: Record<string, unknown> = {};
  for (const method of ["select", "eq", "gte", "in", "order", "limit"]) {
    b[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return b;
    };
  }
  b.then = (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return b;
}

function makeDeferredChain(calls: QueryCall[] = []) {
  let resolveResult!: (value: QueryResult) => void;
  let rejectResult!: (reason: unknown) => void;
  const promise = new Promise<QueryResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const b: Record<string, unknown> = {};
  for (const method of ["select", "eq", "gte", "in", "order", "limit"]) {
    b[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return b;
    };
  }
  b.then = (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
    promise.then(resolve, reject);
  return { chain: b, resolveResult, rejectResult };
}

const { fetchOperationsSummary } = await import("./carson-operations-center");

describe("get_operations_summary first-call reliability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.supabaseGetUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
      error: null,
    });
  });

  it("starts both independent live reads before either one resolves", async () => {
    const wa = makeDeferredChain();
    const reminders = makeDeferredChain();

    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "whatsapp_deliveries") return wa.chain;
      if (table === "tasks") return reminders.chain;
      throw new Error(`unexpected table ${table}`);
    });

    const pending = fetchOperationsSummary();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.supabaseFrom).toHaveBeenCalledTimes(2);
    expect(mocks.supabaseFrom).toHaveBeenNthCalledWith(1, "whatsapp_deliveries");
    expect(mocks.supabaseFrom).toHaveBeenNthCalledWith(2, "tasks");

    // Resolve in reverse order. Promise.all must preserve the two result roles.
    reminders.resolveResult({ data: [], error: null });
    wa.resolveResult({ data: [], error: null });

    const result = await pending;
    expect(result).toContain("OPERATIONS SUMMARY (live):");
    expect(result).toContain("No WhatsApp delivery failures in the last 48 hours.");
    expect(result).toContain("No reminder delivery issues in the last 48 hours.");
  });

  it("keeps auth as the gate and preserves the owner user_id filter", async () => {
    const taskCalls: QueryCall[] = [];
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "tasks") return makeChain({ data: [], error: null }, taskCalls);
      return makeChain({ data: [], error: null });
    });

    await fetchOperationsSummary();
    expect(mocks.supabaseGetUser).toHaveBeenCalledTimes(1);
    expect(taskCalls).toContainEqual({ method: "eq", args: ["user_id", "user-1"] });

    vi.clearAllMocks();
    mocks.supabaseGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const signedOut = await fetchOperationsSummary();
    expect(signedOut).toMatch(/not signed in/i);
    expect(mocks.supabaseFrom).not.toHaveBeenCalled();
  });

  it("does not turn a query failure into a false healthy summary", async () => {
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "whatsapp_deliveries") {
        return makeChain({ data: null, error: { message: "delivery query failed" } });
      }
      return makeChain({ data: [], error: null });
    });

    const result = await fetchOperationsSummary();
    expect(result).toMatch(/couldn't load the operations summary/i);
    expect(result).toMatch(/live status checks failed/i);
    expect(result).not.toMatch(/no whatsapp delivery failures/i);
    expect(result).not.toMatch(/no reminder delivery issues/i);
  });

  it("reports auth and rejected-query failures truthfully", async () => {
    mocks.supabaseGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: "auth unavailable" },
    });
    const authFailure = await fetchOperationsSummary();
    expect(authFailure).toMatch(/authentication check failed/i);

    mocks.supabaseGetUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
      error: null,
    });
    const wa = makeDeferredChain();
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "whatsapp_deliveries") return wa.chain;
      return makeChain({ data: [], error: null });
    });

    const pending = fetchOperationsSummary();
    await Promise.resolve();
    await Promise.resolve();
    wa.rejectResult(new Error("network timeout"));

    const queryFailure = await pending;
    expect(queryFailure).toMatch(/live status check did not complete/i);
    expect(queryFailure).not.toMatch(/no whatsapp delivery failures/i);
  });

  it("preserves successful summary meaning and performs no duplicate reads", async () => {
    const failedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "whatsapp_deliveries") {
        return makeChain({
          data: [{
            recipient_name: "Grace",
            source_type: "task",
            failure_reason: "user not found",
            failure_code: null,
            failed_at: failedAt,
          }],
          error: null,
        });
      }
      return makeChain({
        data: [{
          description: "Pick up medicine",
          assigned_to: null,
          reminder_delivery_status: "failed",
          reminder_delivery_error: "no subscriptions",
          created_at: new Date().toISOString(),
        }],
        error: null,
      });
    });

    const result = await fetchOperationsSummary();
    expect(result).toContain("WhatsApp delivery failures (1):");
    expect(result).toContain("Grace");
    expect(result).toContain("user not found");
    expect(result).toContain("Reminder delivery issues (1):");
    expect(result).toContain("Pick up medicine");
    expect(result).toContain("failed: no subscriptions");
    expect(mocks.supabaseFrom).toHaveBeenCalledTimes(2);
  });
});
