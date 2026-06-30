import { beforeEach, describe, expect, it, vi } from "vitest";

type TableName =
  | "tasks"
  | "carson_todos"
  | "carson_notes"
  | "carson_memory"
  | "carson_facts"
  | "carson_persistent_memory"
  | "people"
  | "household_rules"
  | "automations"
  | "automation_runs"
  | "whatsapp_deliveries";

const tableData: Record<TableName, unknown> = {
  tasks: [],
  carson_todos: [],
  carson_notes: [],
  carson_memory: [],
  carson_facts: [],
  carson_persistent_memory: [],
  people: [],
  household_rules: null,
  automations: [],
  automation_runs: [],
  whatsapp_deliveries: [],
};

const tableErrors: Partial<Record<TableName, Error>> = {};

function makeQuery(table: TableName) {
  const query: any = {
    select: vi.fn(() => query),
    is: vi.fn(() => query),
    eq: vi.fn(() => query),
    in: vi.fn(() => query),
    gte: vi.fn(() => query),
    lte: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    maybeSingle: vi.fn(() =>
      Promise.resolve({
        data: tableData[table],
        error: tableErrors[table] ?? null,
      }),
    ),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({
        data: tableData[table],
        error: tableErrors[table] ?? null,
      }).then(resolve),
  };
  return query;
}

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      getUser: vi.fn(() =>
        Promise.resolve({
          data: { user: { id: "user-1", email: "sana@example.com" } },
          error: null,
        }),
      ),
    },
    from: vi.fn((table: TableName) => makeQuery(table)),
  },
}));

const { getChiefOfStaffContext, summarizeChiefOfStaffContext } = await import(
  "./chief-of-staff-context"
);

const now = new Date("2026-07-01T10:00:00Z");

beforeEach(() => {
  for (const key of Object.keys(tableData) as TableName[]) {
    tableData[key] = key === "household_rules" ? null : [];
  }
  for (const key of Object.keys(tableErrors) as TableName[]) {
    delete tableErrors[key];
  }
});

describe("getChiefOfStaffContext", () => {
  it("loads typed context across current Carson knowledge systems", async () => {
    tableData.tasks = [
      {
        id: "task-1",
        description: "Ask Grace to buy flowers",
        type: "delegation",
        assigned_to: "Grace",
        status: "pending",
        needs_follow_up: true,
        confirmed_at: null,
        due_at: "2026-07-01T09:00:00Z",
        archived_at: null,
        created_at: "2026-07-01T08:00:00Z",
        followup_sent_at: null,
        escalated_at: null,
        quality_review_status: null,
      },
    ];
    tableData.carson_todos = [
      {
        id: "todo-1",
        title: "Buy flowers",
        description: null,
        status: "active",
        source: "test",
        created_at: "2026-07-01T08:05:00Z",
        updated_at: "2026-07-01T08:05:00Z",
        completed_at: null,
      },
    ];
    tableData.carson_notes = [
      {
        id: "note-1",
        note: "Follow Gemini plan",
        category: "general",
        source: "test",
        created_at: "2026-07-01T08:10:00Z",
        updated_at: "2026-07-01T08:10:00Z",
      },
    ];
    tableData.carson_memory = [
      {
        id: "memory-1",
        summary: "User discussed flower inventory.",
        created_at: "2026-07-01T08:15:00Z",
      },
    ];
    tableData.carson_facts = [
      {
        id: "fact-1",
        category: "preference",
        key: "brief_style",
        value: "Keep updates short.",
        confidence: 0.9,
        source: "voice_session",
        created_at: "2026-07-01T08:20:00Z",
        updated_at: "2026-07-01T08:20:00Z",
        last_seen_at: "2026-07-01T08:20:00Z",
      },
    ];
    tableData.people = [
      {
        id: "person-1",
        name: "Grace",
        role: "Coordinator",
        notes: "Reliable.",
        created_at: "2026-07-01T08:25:00Z",
        relationship: null,
        is_family: false,
        responsibilities: "Flowers",
        reliability_level: "high",
        follow_up_level: "light",
        delegation_guidance: "Short messages.",
        communication_style: "Direct",
        whatsapp_opted_in: true,
      },
    ];
    tableData.carson_persistent_memory = [
      {
        id: "instruction-1",
        category: "style",
        instruction: "Keep responses concise.",
        created_at: "2026-07-01T08:30:00Z",
        updated_at: "2026-07-01T08:30:00Z",
      },
    ];

    const context = await getChiefOfStaffContext("fallback@example.com", { now });

    expect(context.user.email).toBe("sana@example.com");
    expect(context.tasks[0].title).toBe("Ask Grace to buy flowers");
    expect(context.delegations).toHaveLength(1);
    expect(context.todos[0].title).toBe("Buy flowers");
    expect(context.notes[0].text).toBe("Follow Gemini plan");
    expect(context.people[0].title).toBe("Grace");
    expect(context.memory.map((item) => item.title)).toContain("User discussed flower inventory.");
    expect(context.memory.map((item) => item.title)).toContain("preference: brief_style");
    expect(context.instructions[0].text).toBe("Keep responses concise.");
    expect(context.openLoops.length).toBeGreaterThan(0);
    expect(context.metadata.read_only).toBe(true);
    expect(context.metadata.section_status.tasks.ok).toBe(true);
  });

  it("empty states do not crash and still include metadata", async () => {
    const context = await getChiefOfStaffContext("empty@example.com", { now });
    expect(context.tasks).toEqual([]);
    expect(context.todos).toEqual([]);
    expect(context.notes).toEqual([]);
    expect(context.people).toEqual([]);
    expect(context.memory).toEqual([]);
    expect(context.metadata.generated_at).toBe("2026-07-01T10:00:00.000Z");
    expect(summarizeChiefOfStaffContext(context)).toContain("0 open tasks");
  });

  it("failed optional sections do not break the whole response", async () => {
    tableErrors.whatsapp_deliveries = new Error("delivery table unavailable");
    tableData.tasks = [
      {
        id: "task-1",
        description: "Renew passport",
        type: "action",
        assigned_to: null,
        status: "pending",
        needs_follow_up: false,
        confirmed_at: null,
        due_at: null,
        archived_at: null,
        created_at: "2026-07-01T08:00:00Z",
        followup_sent_at: null,
        escalated_at: null,
        quality_review_status: null,
      },
    ];

    const context = await getChiefOfStaffContext("sana@example.com", { now });

    expect(context.tasks).toHaveLength(1);
    expect(context.whatsappHealth.deliveries).toEqual([]);
    expect(context.metadata.section_status.whatsapp_deliveries.ok).toBe(false);
    expect(context.metadata.section_status.whatsapp_deliveries.error).toContain("delivery table unavailable");
  });
});
