import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractedItem } from "../types/extraction";
import type { Person } from "../types/person";

const h = vi.hoisted(() => ({
  activeUserId: "user-1",
  now: "2026-06-28T12:00:00.000Z",
  nextId: 1,
  db: {
    carson_todos: [] as any[],
    carson_notes: [] as any[],
    tasks: [] as any[],
    messages: [] as any[],
    whatsapp_deliveries: [] as any[],
  },
  reminderSchedules: [] as Array<[string, string]>,
  escalationSchedules: [] as Array<[string, string]>,
}));

function resetHarness() {
  h.activeUserId = "user-1";
  h.nextId = 1;
  h.db.carson_todos.length = 0;
  h.db.carson_notes.length = 0;
  h.db.tasks.length = 0;
  h.db.messages.length = 0;
  h.db.whatsapp_deliveries.length = 0;
  h.reminderSchedules.length = 0;
  h.escalationSchedules.length = 0;
}

type TableName = keyof typeof h.db;

function insertRows(table: TableName, payload: unknown): any[] {
  const rows = Array.isArray(payload) ? payload : [payload];
  return rows.map((raw) => {
    const draft = raw as Record<string, unknown>;
    const id = (draft.id as string | undefined) ?? `${table}-${h.nextId++}`;
    const base = {
      id,
      created_at: h.now,
      updated_at: h.now,
      ...draft,
    };

    let row: Record<string, unknown>;
    if (table === "carson_todos") {
      row = {
        user_id: h.activeUserId,
        status: "active",
        completed_at: null,
        description: null,
        source: "voice",
        ...base,
      };
    } else if (table === "carson_notes") {
      row = {
        user_id: h.activeUserId,
        category: "general",
        source: "voice",
        ...base,
      };
    } else if (table === "tasks") {
      row = {
        confirmed_at: null,
        due_at: null,
        archived_at: null,
        qstash_message_id: null,
        followup_sent_at: null,
        escalated_at: null,
        image_path: null,
        proof_image_path: null,
        quality_review_status: null,
        quality_review_note: null,
        quality_reviewed_at: null,
        ...base,
      };
    } else if (table === "messages") {
      row = {
        archived_at: null,
        ...base,
      };
    } else {
      row = base;
    }

    h.db[table].push(row);
    return row;
  });
}

function makeSelectSingle(row: unknown) {
  return {
    single: vi.fn(async () => ({ data: row, error: null })),
  };
}

function makeThenable(value: unknown) {
  return {
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject),
  };
}

function makeInsertResult(inserted: any[]) {
  return {
    select: vi.fn(() => makeSelectSingle(inserted[0] ?? null)),
    single: vi.fn(async () => ({ data: inserted[0] ?? null, error: null })),
    ...makeThenable({ data: null, error: null }),
  };
}

function makeUpdateResult(table: TableName, patch: Record<string, unknown>) {
  return {
    eq: vi.fn((column: string, value: unknown) => {
      const rows = h.db[table].filter((row) => row[column] === value);
      rows.forEach((row) => Object.assign(row, patch, { updated_at: h.now }));
      return {
        select: vi.fn(() => makeSelectSingle(rows[0] ?? null)),
        ...makeThenable({ data: rows, error: null }),
      };
    }),
  };
}

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { user: { id: h.activeUserId } } },
        error: null,
      })),
    },
    from: vi.fn((table: TableName) => ({
      insert: vi.fn((payload: unknown) => makeInsertResult(insertRows(table, payload))),
      update: vi.fn((patch: Record<string, unknown>) => makeUpdateResult(table, patch)),
      delete: vi.fn(() => ({
        eq: vi.fn(async () => ({ error: null, count: 1 })),
      })),
    })),
  },
}));

vi.mock("./qstash-reminder", () => ({
  scheduleReminderPush: vi.fn(async (taskId: string, dueAt: string) => {
    h.reminderSchedules.push([taskId, dueAt]);
  }),
  cancelReminderPush: vi.fn(async () => undefined),
  rescheduleReminderPush: vi.fn(async () => undefined),
}));

vi.mock("./qstash-escalation", () => ({
  scheduleEscalationMessages: vi.fn(async (taskId: string, createdAt: string) => {
    h.escalationSchedules.push([taskId, createdAt]);
  }),
}));

import { saveCarsonNote } from "./carson-notes";
import { createTodo } from "./carson-todos";
import { extractItems } from "./ai/extract";
import { savePending } from "./save";

const grace: Person = {
  id: "person-grace",
  user_id: "user-1",
  name: "Grace",
  role: "assistant",
  phone: "+15550001111",
  notes: null,
  created_at: "2026-06-01T00:00:00.000Z",
  relationship: null,
  is_family: false,
  responsibilities: "errands and household help",
  reliability_level: "high",
  follow_up_level: "regular",
  delegation_guidance: null,
  should_not_assign: null,
  escalate_to: null,
  communication_style: "short WhatsApp messages",
  whatsapp_opted_in: true,
  whatsapp_consent_at: "2026-06-01T00:00:00.000Z",
  whatsapp_consent_method: "owner_confirmed",
};

function mockExtractionResponse(items: Array<Partial<ExtractedItem>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const body = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              summary: "Captured.",
              extracted: items.map((item, index) => ({
                id: `item-${index + 1}`,
                assignedTo: null,
                dueAt: null,
                dueText: null,
                suggestedMessage: null,
                personalNote: null,
                needsPerson: false,
                needsClarification: false,
                clarificationQuestion: null,
                ...item,
              })),
            }),
          },
        ],
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

async function extractAndSave(
  text: string,
  items: Array<Partial<ExtractedItem>>,
  people: Person[] = [],
) {
  mockExtractionResponse(items);
  const result = await extractItems(text, people, "Sana");
  return savePending(result.extracted, h.activeUserId, "Sana", people);
}

describe("canonical action creation paths", () => {
  beforeEach(() => {
    resetHarness();
    vi.stubGlobal("window", {
      location: { origin: "https://ra7etbal.test" },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes Clear My Head to-do intent into one carson_todos row only", async () => {
    const saved = await extractAndSave("Add buy flowers to my to-do list", [
      { type: "action", description: "  buy flowers  " },
    ]);

    expect(saved.todos).toHaveLength(1);
    expect(h.db.carson_todos).toMatchObject([
      {
        user_id: "user-1",
        title: "buy flowers",
        description: null,
        source: "clear_my_head",
      },
    ]);
    expect(h.db.tasks).toHaveLength(0);
    expect(h.db.messages).toHaveLength(0);
    expect(h.db.whatsapp_deliveries).toHaveLength(0);
    expect(h.reminderSchedules).toHaveLength(0);
  });

  it.each([
    ["Buy flowers", "Buy flowers"],
    ["Add buy flowers to my to-do list", "buy flowers"],
    ["Renew passport", "Renew passport"],
  ])("routes Clear My Head %j into To-do", async (text, description) => {
    const saved = await extractAndSave(text, [
      { type: "action", description },
    ]);

    expect(saved.todos).toHaveLength(1);
    expect(h.db.carson_todos).toMatchObject([
      {
        user_id: "user-1",
        title: description,
        source: "clear_my_head",
      },
    ]);
    expect(h.db.carson_notes).toHaveLength(0);
    expect(h.db.tasks).toHaveLength(0);
    expect(h.db.messages).toHaveLength(0);
  });

  it("direct createTodo writes the same to-do shape without task/message side effects", async () => {
    await createTodo("  buy flowers  ", null, "voice");

    expect(h.db.carson_todos).toMatchObject([
      {
        user_id: "user-1",
        title: "buy flowers",
        description: null,
        source: "voice",
      },
    ]);
    expect(h.db.tasks).toHaveLength(0);
    expect(h.db.messages).toHaveLength(0);
    expect(h.reminderSchedules).toHaveLength(0);
  });

  it("routes Clear My Head note intent into one carson_notes row only", async () => {
    const saved = await extractAndSave("Note to follow Gemini plan", [
      { type: "action", description: "follow Gemini plan" },
    ]);

    expect(saved.notesSaved).toBe(1);
    expect(h.db.carson_notes).toMatchObject([
      {
        user_id: "user-1",
        note: "follow Gemini plan",
        category: "general",
        source: "clear_my_head",
      },
    ]);
    expect(h.db.carson_todos).toHaveLength(0);
    expect(h.db.tasks).toHaveLength(0);
    expect(h.db.messages).toHaveLength(0);
  });

  it.each([
    ["Note to follow Gemini plan", "follow Gemini plan"],
    ["Save this note: follow Gemini plan", "follow Gemini plan"],
    ["Remember this idea for later", "idea for later"],
    ["Hold this thought about the menu", "thought about the menu"],
  ])("routes Clear My Head %j into Notes", async (text, description) => {
    const saved = await extractAndSave(text, [
      { type: "action", description },
    ]);

    expect(saved.notesSaved).toBe(1);
    expect(h.db.carson_notes).toMatchObject([
      {
        user_id: "user-1",
        note: description,
        category: "general",
        source: "clear_my_head",
      },
    ]);
    expect(h.db.carson_todos).toHaveLength(0);
    expect(h.db.tasks).toHaveLength(0);
    expect(h.db.messages).toHaveLength(0);
  });

  it("direct saveCarsonNote writes one note without task/reminder side effects", async () => {
    await saveCarsonNote("  follow Gemini plan  ", "general", "voice");

    expect(h.db.carson_notes).toMatchObject([
      {
        user_id: "user-1",
        note: "follow Gemini plan",
        category: "general",
        source: "voice",
      },
    ]);
    expect(h.db.carson_todos).toHaveLength(0);
    expect(h.db.tasks).toHaveLength(0);
    expect(h.db.messages).toHaveLength(0);
    expect(h.reminderSchedules).toHaveLength(0);
  });

  it("routes Clear My Head reminder intent into one reminder task and schedules it", async () => {
    const dueAt = "2026-06-29T09:00:00.000Z";
    const saved = await extractAndSave("Remind me to buy flowers tomorrow", [
      {
        type: "reminder",
        description: "buy flowers",
        assignedTo: "__me__",
        dueAt,
        dueText: "tomorrow",
      },
    ]);

    expect(saved.tasks).toHaveLength(1);
    expect(h.db.tasks).toMatchObject([
      {
        user_id: "user-1",
        description: "buy flowers",
        type: "reminder",
        assigned_to: null,
        status: "pending",
        needs_follow_up: false,
        due_at: dueAt,
      },
    ]);
    expect(h.reminderSchedules).toEqual([[h.db.tasks[0].id, dueAt]]);
    expect(h.db.carson_todos).toHaveLength(0);
    expect(h.db.carson_notes).toHaveLength(0);
    expect(h.db.messages).toHaveLength(0);
  });

  it("routes Clear My Head delegation intent into a delegated task, message, confirmation link, and escalation guard", async () => {
    const saved = await extractAndSave(
      "Ask Grace to buy flowers",
      [
        {
          type: "delegation",
          description: "buy flowers",
          assignedTo: "Grace",
          suggestedMessage: "Grace, please buy flowers.",
        },
      ],
      [grace],
    );

    expect(saved.tasks).toHaveLength(1);
    expect(saved.messages).toHaveLength(1);
    const task = h.db.tasks[0];
    const message = h.db.messages[0];
    const confirmationUrl = `https://ra7etbal.test/confirm?task=${task.id}`;

    expect(task).toMatchObject({
      user_id: "user-1",
      description: "buy flowers",
      type: "delegation",
      assigned_to: "Grace",
      status: "pending",
      needs_follow_up: true,
      confirmation_url: confirmationUrl,
      due_at: null,
    });
    expect(message).toMatchObject({
      user_id: "user-1",
      task_id: task.id,
      recipient: "Grace",
      confirmation_url: confirmationUrl,
    });
    expect(message.content).toContain("buy flowers");
    expect(h.escalationSchedules).toEqual([[task.id, task.created_at]]);
    expect(h.db.carson_todos).toHaveLength(0);
    expect(h.db.carson_notes).toHaveLength(0);
    expect(h.reminderSchedules).toHaveLength(0);
  });
});

describe("canonical path source adapters", () => {
  const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

  it("keeps voice direct tools wired to their canonical low-level helpers", () => {
    const widget = source("src/components/home/ElevenLabsAgentWidget.tsx");

    expect(widget).toMatch(/save_note:\s*\(params[^)]*\)\s*=>\s*\n?\s*runDirectToolWithDiagnostic\("save_note",\s*params,\s*\(\)\s*=>\s*saveNote\(params\)\)/);
    expect(widget).toMatch(/const saveNote = useCallback\([\s\S]*saveCarsonNote\(/);
    expect(widget).toMatch(/create_todo:\s*\(params[^)]*\)\s*=>\s*\n?\s*runDirectToolWithDiagnostic\("create_todo",\s*params,\s*\(\)\s*=>\s*createTodoTool\(params\)\)/);
    expect(widget).toMatch(/const createTodoTool = useCallback\([\s\S]*createTodo\(/);
  });

  it("keeps note/to-do conversion reminder paths on task creation plus reminder scheduling", () => {
    const inbox = source("src/routes/Inbox.tsx");
    const todos = source("src/routes/Todos.tsx");
    const inboxReview = source("src/components/home/InboxReviewPanel.tsx");
    const widget = source("src/components/home/ElevenLabsAgentWidget.tsx");

    expect(inbox).toMatch(/async function handleRemindSubmit[\s\S]*createReminderTask\(\{[\s\S]*source:\s*"inbox"/);
    expect(todos).toMatch(/async function handleRemindSubmit[\s\S]*createReminderTask\(\{[\s\S]*source:\s*"todos"/);
    expect(inboxReview).toMatch(/async function handleRemindMe[\s\S]*createReminderTask\(\{[\s\S]*source:\s*"inbox-review"/);
    expect(widget).toMatch(/const createReminder = useCallback\([\s\S]*createReminderTask\(\{[\s\S]*source:\s*"create_reminder"/);
    expect(widget).toMatch(/if \(action === "reminder"\)[\s\S]*createReminderTask\(\{[\s\S]*source:\s*"act_on_note"/);
  });

  it("keeps note/to-do delegation conversions going through the shared delegation boundary and WhatsApp delivery", () => {
    const inbox = source("src/routes/Inbox.tsx");
    const todos = source("src/routes/Todos.tsx");
    const widget = source("src/components/home/ElevenLabsAgentWidget.tsx");

    expect(inbox).toMatch(/async function handleDelegateSubmit[\s\S]*createDelegationTaskAndMessage\(\{[\s\S]*source:\s*"inbox"[\s\S]*sendWhatsAppTask\(\{/);
    expect(todos).toMatch(/async function handleDelegateSubmit[\s\S]*createDelegationTaskAndMessage\(\{[\s\S]*source:\s*"todos"[\s\S]*sendWhatsAppTask\(\{/);
    expect(widget).toMatch(/async function createAndSendDelegation[\s\S]*createDelegationTaskAndMessage\(\{[\s\S]*source:\s*"send_delegation"[\s\S]*sendWhatsAppTask\(\{/);
  });

  it("keeps direct message creation and sending on the shared direct-message boundary", () => {
    const save = source("src/lib/save.ts");
    const textCarson = source("src/lib/text-carson.ts");
    const fastPath = source("src/lib/direct-message-fast-path.ts");
    const widget = source("src/components/home/ElevenLabsAgentWidget.tsx");
    const review = source("src/routes/Review.tsx");

    expect(save).toMatch(/if \(item\.type === "message"\)[\s\S]*createDirectMessageRecord\(\{[\s\S]*source:\s*"save"/);
    expect(textCarson).toMatch(/sendDirectMessageRecord\(\{[\s\S]*source:\s*"execute_instruction"/);
    expect(fastPath).toMatch(/createAndSendDirectMessage\(\{[\s\S]*source:\s*"direct-message-fast-path"/);
    expect(widget).toMatch(/const sendDirectWhatsAppMessage = useCallback[\s\S]*createAndSendDirectMessage\(\{[\s\S]*source:\s*"send_direct_whatsapp_message"/);
    expect(review).toMatch(/sendDirectMessageRecord\(\{[\s\S]*source:\s*"review"/);
  });

  it("keeps Review successful message saves off blocking browser alerts", () => {
    const review = source("src/routes/Review.tsx");

    expect(review).not.toContain('"Saved and sent on WhatsApp."');
    expect(review).not.toMatch(/if \(!parts\.length\) parts\.push\("Saved\."\)/);
    expect(review).toMatch(/if \(parts\.length\) window\.alert\(parts\.join\("\\n\\n"\)\)/);
  });

  it("starts Voice Carson connect timeout around the SDK handshake, after live preload work", () => {
    const widget = source("src/components/home/ElevenLabsAgentWidget.tsx");
    const preloadIndex = widget.indexOf("const freshVars = onBeforeCallStart ? await onBeforeCallStart() : null;");
    const timeoutIndex = widget.indexOf("connectTimeoutRef.current = setTimeout", preloadIndex);
    const startSessionIndex = widget.indexOf("const conv = await Conversation.startSession", preloadIndex);

    expect(preloadIndex).toBeGreaterThan(-1);
    expect(timeoutIndex).toBeGreaterThan(preloadIndex);
    expect(startSessionIndex).toBeGreaterThan(timeoutIndex);
    expect(startSessionIndex - timeoutIndex).toBeLessThan(800);
    expect(widget.slice(timeoutIndex, startSessionIndex)).toContain("60_000");
    expect(widget.slice(startSessionIndex, startSessionIndex + 300)).toContain('connectionType: "websocket"');
  });

  it("documents confirmation URL canonical param and legacy compatibility", () => {
    const confirm = source("src/routes/Confirm.tsx");
    const save = source("src/lib/save.ts");
    const delegations = source("src/lib/delegations.ts");
    const inbox = source("src/routes/Inbox.tsx");
    const todos = source("src/routes/Todos.tsx");
    const widget = source("src/components/home/ElevenLabsAgentWidget.tsx");
    const recurringRunner = source("api/process-delegation-escalations.js");

    expect(confirm).toMatch(/params\.get\("task"\)\s*\?\?\s*params\.get\("task_id"\)/);
    expect(save).toContain("createDelegationTaskAndMessage");
    expect(delegations).toContain("/confirm?task=");
    expect(inbox).toContain("createDelegationTaskAndMessage");
    expect(todos).toContain("createDelegationTaskAndMessage");
    expect(widget).toContain("/confirm?task=");

    expect(recurringRunner).toContain("/confirm?task=");
    expect(recurringRunner).not.toContain("/confirm?task_id=");
  });
});
