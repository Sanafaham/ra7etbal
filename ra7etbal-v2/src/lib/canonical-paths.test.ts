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
        worker_reply: null,
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
      // access_token is required by callAnthropicProxy() (src/lib/anthropic-client.ts),
      // which extractItems() now calls via the authenticated Anthropic proxy --
      // this mock previously only anticipated the user id shape.
      getSession: vi.fn(async () => ({
        data: { session: { access_token: "test-session-token", user: { id: h.activeUserId } } },
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
  REMINDER_CREATION_CONTRACT_VERSION: "reminder-creation-v1",
  createRoutedReminder: vi.fn(async (input: any) => {
    const id = input.creationContract?.operation_id ?? input.routingEvidence?.operation_id;
    const row = insertRows("tasks", {
      id,
      user_id: h.activeUserId,
      description: input.description,
      type: "reminder",
      assigned_to: null,
      status: "pending",
      needs_follow_up: false,
      confirmation_url: null,
      due_at: input.dueAt,
      image_path: input.imagePath ?? null,
    })[0] as any;
    if (input.dueAt) h.reminderSchedules.push([row.id, input.dueAt]);
    return row;
  }),
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
          ownerPerspective: "rendered",
        },
      ],
      [grace],
    );

    expect(saved.tasks).toHaveLength(1);
    expect(saved.messages).toHaveLength(1);
    const task = h.db.tasks[0];
    const message = h.db.messages[0];
    const confirmationUrl = `https://www.ra7etbal.com/confirm?task=${task.id}`;

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

  describe("owner perspective — existing extraction call declares it, the shared boundary enforces it", () => {
    const person = (name: string): Person => ({ ...grace, id: `person-${name.toLowerCase()}`, name });
    const sarah = person("Sarah");
    const loulya = person("Loulya");
    const people = [grace, sarah, loulya];
    const nothingWritten = () => {
      expect(h.db.tasks).toHaveLength(0);
      expect(h.db.messages).toHaveLength(0);
      expect(h.db.carson_todos).toHaveLength(0);
      expect(h.db.carson_notes).toHaveLength(0);
    };
    const refused = (promise: Promise<unknown>) =>
      expect(promise).rejects.toMatchObject({ code: "owner_perspective_unresolved" });

    it("Sarah case: the recipient reads the model's recipient-perspective text, never \"could you tell Sarah …\"", async () => {
      await extractAndSave("Tell Sarah I'm running late tonight.", [{
        type: "message", assignedTo: "Sarah", description: "Tell Sarah I'm running late tonight.",
        suggestedMessage: "Sana is running late tonight.", ownerPerspective: "rendered",
      }], people);
      expect(h.db.messages).toHaveLength(1);
      expect(h.db.messages[0]).toMatchObject({ recipient: "Sarah", task_id: null, content: "Sana is running late tonight." });
      expect(h.db.messages[0].content).not.toMatch(/tell Sarah|\bI'm\b|\bme\b/i);
    });

    it("Sarah case: model output that still names the recipient as a third party fails closed, nothing written", async () => {
      await refused(extractAndSave("Tell Sarah I'm running late.", [{
        type: "message", assignedTo: "Sarah", description: "Tell Sarah I'm running late.",
        suggestedMessage: "Hi Sarah, could you tell Sarah Sana is running late?", ownerPerspective: "rendered",
      }], people));
      nothingWritten();
    });

    it("Loulya case: \"Sana loves you.\" is sent; \"Sana loves her.\" (recipient as a third party) fails closed", async () => {
      await extractAndSave("Tell Loulya I love her.", [{
        type: "message", assignedTo: "Loulya", description: "Tell Loulya I love her.",
        suggestedMessage: "Sana loves you.", ownerPerspective: "rendered",
      }], people);
      expect(h.db.messages[0]).toMatchObject({ recipient: "Loulya", content: "Sana loves you." });

      resetHarness();
      await refused(extractAndSave("Tell Loulya I love her.", [{
        type: "message", assignedTo: "Loulya", description: "Tell Loulya I love her.",
        suggestedMessage: "Sana loves her.", ownerPerspective: "rendered",
      }], people));
      nothingWritten();
    });

    it.each([
      ["missing", {}],
      ["unclear", { ownerPerspective: "unclear" }],
      ["invalid", { ownerPerspective: "yes" }],
    ])("%s perspective status fails closed even for clean text, nothing written", async (_label, status) => {
      await refused(extractAndSave("Tell Grace dinner is at 8.", [{
        type: "message", assignedTo: "Grace", description: "Tell Grace dinner is at 8.",
        suggestedMessage: "Grace, dinner is at 8.", ...(status as Partial<ExtractedItem>),
      }], people));
      nothingWritten();
    });

    it("model claims rendered but leaves owner first person: structurally contradictory, fails closed", async () => {
      await refused(extractAndSave("Tell Grace I'm running late.", [{
        type: "message", assignedTo: "Grace", description: "Tell Grace I'm running late.",
        suggestedMessage: "I'm running late.", ownerPerspective: "rendered",
      }], people));
      nothingWritten();
    });

    it("one unresolvable item fails the whole instruction before ANY row is written", async () => {
      await refused(extractAndSave("Add buy flowers to my to-do list and tell Grace I'm late", [
        { type: "action", description: "buy flowers" },
        { type: "message", assignedTo: "Grace", description: "Tell Grace I'm late.", suggestedMessage: "I'm late.", ownerPerspective: "rendered" },
      ], people));
      nothingWritten();
    });

    it("tracked delegation: owner named, assignee is 'you', third party kept; stored description is what the assignee reads", async () => {
      await extractAndSave("Ask Grace to take Loulya to her appointment and call me after", [{
        type: "delegation", assignedTo: "Grace",
        description: "Take Loulya to her appointment and call Sana after.",
        suggestedMessage: "Can you take Loulya to her appointment and call Sana after?", ownerPerspective: "rendered",
      }], people);
      expect(h.db.tasks[0]).toMatchObject({ assigned_to: "Grace", description: "Take Loulya to her appointment and call Sana after." });
      expect(h.db.messages[0].content).toContain("Loulya to her appointment and call Sana after");
      expect(h.db.messages[0].content).not.toMatch(/\bme\b|\bI\b|\bmy\b/);
    });

    it("tracked delegation with an unclear or contradictory declaration creates no task and no message", async () => {
      await refused(extractAndSave("Ask Grace to call me", [{
        type: "delegation", assignedTo: "Grace", description: "Call Sana.", ownerPerspective: "unclear",
      }], people));
      nothingWritten();
      await refused(extractAndSave("Ask Grace to call me", [{
        type: "delegation", assignedTo: "Grace", description: "Call me.", ownerPerspective: "rendered",
      }], people));
      nothingWritten();
    });

    it("Arabic and Turkish recipient text is accepted ONLY from the declaring extraction call, with the frozen backstop still applied", async () => {
      await extractAndSave("قول لقريس إن الغدا جاهز", [{
        type: "message", assignedTo: "Grace", description: "قول لقريس إن الغدا جاهز",
        suggestedMessage: "الغدا جاهز", ownerPerspective: "rendered",
      }], people);
      expect(h.db.messages[0]).toMatchObject({ recipient: "Grace", content: "الغدا جاهز" });

      resetHarness();
      await extractAndSave("Grace'e söyle akşam yemeği hazır", [{
        type: "delegation", assignedTo: "Grace", description: "Akşam yemeğini hazırla, Sana yolda.", ownerPerspective: "rendered",
      }], people);
      expect(h.db.tasks[0]).toMatchObject({ description: "Akşam yemeğini hazırla, Sana yolda." });

      resetHarness();
      await refused(extractAndSave("قول لقريس بروح السوق", [{
        type: "message", assignedTo: "Grace", description: "قول لقريس بروح السوق",
        suggestedMessage: "بروح السوق", ownerPerspective: "rendered",
      }], people));
      nothingWritten();
    });

    describe("Batch #2 live evidence (run 37040868214, claude-sonnet-4-6) — permanent regression fixtures", () => {
      // The model outputs below are the exact items returned live in Batch #2.
      const rendered = { ownerPerspective: "rendered" as const };

      it("row 1 (EN): 'Sana is running late tonight.' is accepted for Sarah", async () => {
        await extractAndSave("Tell Sarah I'm running late tonight.", [{ type: "message", assignedTo: "Sarah",
          description: "Tell Sarah I'm running late tonight.", suggestedMessage: "Sana is running late tonight.", ...rendered }], people);
        expect(h.db.messages[0]).toMatchObject({ recipient: "Sarah", content: "Sana is running late tonight." });
      });

      it("row 2 (EN): 'Sana loves you.' is accepted for Loulya", async () => {
        await extractAndSave("Tell Loulya I love her.", [{ type: "message", assignedTo: "Loulya",
          description: "Tell Loulya I love her.", suggestedMessage: "Sana loves you.", ...rendered }], people);
        expect(h.db.messages[0]).toMatchObject({ recipient: "Loulya", content: "Sana loves you." });
      });

      it("row 3 (EN): the task text actually used is correct; the model's unused delegation message ('your appointment … call me') is never sent", async () => {
        await extractAndSave("Ask Grace to take Loulya to her appointment and call me after.", [{ type: "delegation", assignedTo: "Grace",
          description: "Take Loulya to her appointment and call Sana after.",
          suggestedMessage: "Can you please take Loulya to your appointment and call me after.", ...rendered }], people);
        expect(h.db.tasks[0]).toMatchObject({ assigned_to: "Grace", description: "Take Loulya to her appointment and call Sana after." });
        expect(h.db.messages[0].content).not.toMatch(/your appointment|call me/);
      });

      it.each([
        ["row 4 (EN)", "Tell Grace Ali said I'd come at 5.", "Tell Grace Ali said I'd come at 5."],
        ["row 8 (AR)", "قول لقريس إن علي قال إني بجي الساعة ٥", "Tell Grace that Ali said he's coming at 5."],
      ])("%s: the embedded speaker stays unclear and fails closed", async (_row, input, description) => {
        await refused(extractAndSave(input, [{ type: "message", assignedTo: "Grace", description, suggestedMessage: null, ownerPerspective: "unclear" }], people));
        nothingWritten();
      });

      it("row 5 (AR): the live output's model-spelled recipient 'قريس' is not bound to the contact Grace — refused before anything is saved", async () => {
        let caught: unknown;
        try {
          await extractAndSave("قول لقريس إني بتأخر الليلة", [{ type: "message", assignedTo: "قريس",
            description: "قول لقريس إنها بتأخر الليلة.", suggestedMessage: "سنا بتأخر الليلة.", ...rendered }], people);
        } catch (err) {
          caught = err;
        }
        expect(caught).toMatchObject({ code: "owner_perspective_unresolved", reason: "recipient_not_bound" });
        expect((caught as Error).message).toMatch(/couldn't match "قريس" to anyone in your People list/);
        nothingWritten();
      });

      it.todo("row 5 (AR): 'سنا بتأخر الليلة.' bound to Grace and declared rendered is still NOT detectable deterministically (first-person verb form) — needs the owner decision recorded in RA7ETBAL_STATE.md");

      it("row 6 (AR): 'سنا تحبك.' is accepted for Loulya (Arabic kept, recipient bound)", async () => {
        await extractAndSave("قولي للوليا إني أحبها", [{ type: "message", assignedTo: "Loulya",
          description: "قولي للوليا إني أحبها.", suggestedMessage: "سنا تحبك.", ...rendered }], people);
        expect(h.db.messages[0]).toMatchObject({ recipient: "Loulya", content: "سنا تحبك." });
      });

      it("row 7 (AR): Arabic input whose delegation came back in English is refused (language contract) — no task, no message", async () => {
        let caught: unknown;
        try {
          await extractAndSave("خلي قريس تجيب الأغراض لغرفتي", [{ type: "delegation", assignedTo: "Grace",
            description: "Bring the groceries to Sana's room.", suggestedMessage: "Can you please bring the groceries to Sana's room?", ...rendered }], people);
        } catch (err) {
          caught = err;
        }
        expect(caught).toMatchObject({ code: "owner_perspective_unresolved", reason: "composition_language_changed" });
        expect((caught as Error).message).toMatch(/couldn't keep the message in the language you used/);
        nothingWritten();
      });

      it.each([
        ["row 9", "Grace'e söyle bu akşam geç kalacağım", "message", "Grace", "Grace, Sana bu akşam geç kalacak."],
        ["row 10", "Loulya'ya onu sevdiğimi söyle", "message", "Loulya", "Sana seni seviyor."],
      ])("%s (TR): accepted — identity comes from the bound contact, not from reading 'Sana'", async (_row, input, type, assignedTo, text) => {
        await extractAndSave(input, [{ type: type as "message", assignedTo, description: input, suggestedMessage: text, ...rendered }], people);
        expect(h.db.messages[0]).toMatchObject({ recipient: assignedTo, content: text });
      });

      it("row 11 (TR): delegation 'Çantaları Sana'nın odasına getir.' is stored for Grace", async () => {
        await extractAndSave("Grace'ten odama çantaları getirmesini iste", [{ type: "delegation", assignedTo: "Grace",
          description: "Çantaları Sana'nın odasına getir.", suggestedMessage: "Çantaları Sana'nın odasına getirir misin lütfen?", ...rendered }], people);
        expect(h.db.tasks[0]).toMatchObject({ assigned_to: "Grace", description: "Çantaları Sana'nın odasına getir." });
      });

      it("Turkish: the pronoun 'sana' (to you) is not mistaken for the owner, and a Turkish item that came back in English is refused", async () => {
        await extractAndSave("Grace'e bir paket geldiğini söyle", [{ type: "message", assignedTo: "Grace",
          description: "Grace'e paket geldiğini söyle", suggestedMessage: "Grace, sana bir paket geldi.", ...rendered }], people);
        expect(h.db.messages[0]).toMatchObject({ recipient: "Grace", content: "Grace, sana bir paket geldi." });
        resetHarness();
        await refused(extractAndSave("Grace'e söyle bu akşam geç kalacağım", [{ type: "message", assignedTo: "Grace",
          description: "x", suggestedMessage: "Sana will be late tonight, please wait for her.", ...rendered }], people));
        nothingWritten();
      });

      it("row 12 (TR): invalid JSON from the model fails closed — truthful error, nothing written", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text: "{ not valid json" }] }), {
          status: 200, headers: { "Content-Type": "application/json" },
        })));
        await expect(extractItems("Grace'e Ali'nin saat 5'te geleceğimi söylediğini söyle", people, "Sana"))
          .rejects.toThrow("The AI returned something Ra7etBal couldn't parse. Please try again.");
        nothingWritten();
      });

      it("an unknown recipient the model explicitly marks needsPerson keeps the existing never-sent path", async () => {
        await extractAndSave("Tell Ahmed dinner is at 8", [{ type: "message", assignedTo: "Ahmed", needsPerson: true,
          description: "Tell Ahmed dinner is at 8", suggestedMessage: "Ahmed, dinner is at 8.", ...rendered }], people);
        expect(h.db.messages[0]).toMatchObject({ recipient: "Ahmed" });
      });
    });

    it("the extraction parser turns a missing or invalid declaration into 'unclear' (never 'rendered')", async () => {
      mockExtractionResponse([
        { type: "message", assignedTo: "Grace", description: "a", suggestedMessage: "a" },
        { type: "message", assignedTo: "Grace", description: "b", suggestedMessage: "b", ownerPerspective: "RENDERED" as never },
        { type: "message", assignedTo: "Grace", description: "c", suggestedMessage: "c", ownerPerspective: "rendered" },
      ]);
      const result = await extractItems("x", people, "Sana");
      expect(result.extracted.map((i) => i.ownerPerspective)).toEqual(["unclear", "unclear", "rendered"]);
    });
  });
});

describe("canonical path source adapters", () => {
  const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

  it("keeps historical calendar lookup on the authenticated canonical route without an upcoming fallback", () => {
    const calendar = source("src/lib/calendar.ts");
    const widget = source("src/components/home/ElevenLabsAgentWidget.tsx");
    const api = source("api/google-calendar.js");

    expect(calendar).toContain('range: "historical"');
    expect(calendar).toContain("/api/google-calendar?");
    expect(calendar).toContain("Authorization: `Bearer ${jwt}`");
    expect(calendar).not.toContain("googleapis.com/calendar/v3");
    expect(widget).toContain("search_calendar_history:");
    expect(widget).toContain("searchCalendarHistoryTool(params)");
    expect(api).toContain('range === "historical"');
    expect(api).toContain('req.method === "GET"');
  });

  it("keeps voice direct tools wired to their canonical low-level helpers", () => {
    const widget = source("src/components/home/ElevenLabsAgentWidget.tsx");

    expect(widget).toMatch(/save_note:\s*\(params[^)]*\)\s*=>\s*\{[\s\S]*guardCurrentToolInvocation\("save_note"\)[\s\S]*runDirectToolWithDiagnostic\("save_note",\s*params,\s*\(\)\s*=>\s*saveNote\(params\)\)/);
    expect(widget).toMatch(/const saveNote = useCallback\([\s\S]*saveCarsonNote\(/);
    expect(widget).toMatch(/create_todo:\s*\(params[^)]*\)\s*=>\s*\{[\s\S]*guardCurrentToolInvocation\("create_todo"\)[\s\S]*runDirectToolWithDiagnostic\("create_todo",\s*params,\s*\(\)\s*=>\s*createTodoTool\(params\)\)/);
    expect(widget).toMatch(/const createTodoTool = useCallback\([\s\S]*createTodo\(/);
  });

  it("keeps note/to-do conversion reminder paths on task creation plus reminder scheduling", () => {
    const inbox = source("src/routes/Inbox.tsx");
    const todos = source("src/routes/Todos.tsx");
    const widget = source("src/components/home/ElevenLabsAgentWidget.tsx");

    expect(inbox).toMatch(/async function handleRemindSubmit[\s\S]*createReminderTask\(\{[\s\S]*source:\s*"inbox"/);
    expect(todos).toMatch(/async function handleRemindSubmit[\s\S]*createReminderTask\(\{[\s\S]*source:\s*"todos"/);
    expect(widget).toMatch(/const createReminder = useCallback\([\s\S]*createReminderTask\(\{[\s\S]*source:\s*"voice"/);
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

    expect(save).toMatch(/if \(item\.type === "message"\)[\s\S]*createDirectMessageRecord\(\{[\s\S]*source:\s*"save"/);
    expect(textCarson).toMatch(/sendDirectMessageRecord\(\{[\s\S]*source:\s*"execute_instruction"/);
    expect(fastPath).toMatch(/createAndSendDirectMessage\(\{[\s\S]*source:\s*"direct-message-fast-path"/);
    expect(widget).toMatch(/const sendDirectWhatsAppMessage = useCallback[\s\S]*createAndSendDirectMessage\(\{[\s\S]*source:\s*"send_direct_whatsapp_message"/);
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
    // Regression 1: the websocket/pcm_16000 browser PWA experiment prevented
    // Carson from connecting, so the single SDK public voice path must not
    // force a connectionType/format/sampleRate override here.
    expect(widget.slice(startSessionIndex, startSessionIndex + 500)).not.toContain("connectionType");
    expect(widget.slice(startSessionIndex, startSessionIndex + 500)).not.toContain("sampleRate");
    expect(widget.slice(startSessionIndex, startSessionIndex + 500)).not.toContain("format:");
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

  // Protected behavior (item 10): createReminderTask (src/lib/reminders.ts)
  // is explicitly documented as the canonical *one-off* reminder creation
  // boundary, "intentionally not used for recurring reminder routines, which
  // currently create action tasks plus immediate owner push notifications
  // from the server routine runner." This proves that separation actually
  // holds in the code, not just in the comment: the recurring runner
  // (runAutomationsCore / processAutomation in
  // api/process-delegation-escalations.js) never imports or calls
  // createReminderTask, and creates its task row through its own local
  // createTask() REST helper instead.
  it("keeps the recurring automation runner structurally separate from the one-off reminder creation boundary (createReminderTask)", () => {
    const recurringRunner = source("api/process-delegation-escalations.js");
    const reminders = source("src/lib/reminders.ts");

    expect(recurringRunner).not.toContain("createReminderTask");
    expect(recurringRunner).not.toMatch(/from\s+["'][^"']*lib\/reminders["']/);
    expect(recurringRunner).not.toMatch(/require\(\s*["'][^"']*lib\/reminders["']\s*\)/);
    // The recurring runner creates its task row through its own local
    // createTask(supabaseUrl, serviceKey, fields) helper, defined in this
    // same file — a plain Supabase REST insert, not the canonical boundary.
    expect(recurringRunner).toMatch(/const taskId = await createTask\(supabaseUrl, serviceKey, \{/);
    expect(recurringRunner).toMatch(/async function createTask\(supabaseUrl, serviceKey, fields\)/);
    // And reminders.ts's own doc comment still states the intentional split,
    // so this test and the source it protects can't silently drift apart.
    expect(reminders).toMatch(/not used for recurring\s*\n\s*\* reminder routines/);
  });
});
