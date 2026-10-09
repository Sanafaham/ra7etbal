/**
 * P3 Step 3 / S3 — legacy voice attention names live items.
 *
 * Production (conv_1501m3fmxeh4eknvqy7m07n55qat, 2026-09-26): the live voice
 * result was counts only ("7 overdue reminders and 3 thing you're waiting
 * ons"), so every item Carson then named came from the session-start
 * {{ra7etbal_state}} list, which is never refreshed during a call. Voice now
 * names the live items (at most five in a summary, owner decision 2026-10-09)
 * and answers item follow-ups from a fresh live read. Typed is unchanged.
 */
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

vi.mock("./supabase", () => ({ supabase: { auth: { getUser: mocks.supabaseGetUser } } }));
vi.mock("./tasks", () => ({ listTasks: mocks.listTasks }));
vi.mock("./staff-messages", () => ({ listOpenStaffEscalationsForNeedsYou: mocks.listOpenStaffEscalationsForNeedsYou }));
vi.mock("./automation-context", () => ({ fetchAutomationDigest: mocks.fetchAutomationDigest }));
vi.mock("./carson-unresolved-captures", () => ({
  fetchUnresolvedCaptureCandidates: mocks.fetchUnresolvedCaptureCandidates,
  classifyAttentionWorthyCaptures: mocks.classifyAttentionWorthyCaptures,
}));
vi.mock("./carson-notes", () => ({ markCarsonNotesSurfaced: mocks.markCarsonNotesSurfaced }));
vi.mock("./carson-todos", () => ({ markCarsonTodosSurfaced: mocks.markCarsonTodosSurfaced }));

const {
  fetchAttentionEvidence,
  fetchAttentionPresentation,
  fetchVoiceAttentionPresentation,
  renderAttentionSummary,
  renderVoiceAttentionSummary,
  VOICE_ATTENTION_NAME_LIMIT,
} = await import("./carson-operations-center");
const { resolveVoiceAttentionFollowUp } = await import("./carson-attention-intent-guard");

const EMPTY_DIGEST = {
  pending: [],
  escalated: [],
  failed: [],
  confirmedToday: [],
  firingToday: [],
  firingTomorrow: [],
  routineAutomationTaskIds: new Set<string>(),
  recurringSourceIndexes: { automationLinks: new Map(), routineLinks: new Map(), notificationAutomationClaims: new Map() },
  recurringSourceLinksLoaded: true,
};

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const ahead = (days: number) => new Date(Date.now() + days * DAY).toISOString();

function task(id: string, overrides: Partial<Task>): Task {
  return {
    id,
    user_id: "user-1",
    description: id,
    type: "reminder",
    assigned_to: null,
    status: "pending",
    needs_follow_up: false,
    confirmation_url: null,
    confirmed_at: null,
    due_at: null,
    dismissed_at: null,
    archived_at: null,
    created_at: ago(30),
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

const overdue = (id: string, description: string, days = 3) => task(id, { description, due_at: ago(days) });
const delegation = (id: string, description: string, assignee: string) =>
  task(id, { description, type: "delegation", assigned_to: assignee, created_at: ago(5) });

// Seven overdue reminders and three Christopher delegations — the shape of the
// 2026-09-26 Production session.
const SEPT_26 = [
  overdue("r1", "Call Loulya", 32),
  overdue("r2", "Check my mailbox", 32),
  overdue("r3", "Check my email", 32),
  overdue("r4", "Pay bills", 30),
  overdue("r5", "Call the doctor", 29),
  overdue("r6", "Renew the parking permit", 18),
  overdue("r7", "Water the plants", 6),
  delegation("d1", "bring the car around.", "Christopher"),
  delegation("d2", "Make a pizza for dinner.", "Christopher"),
  delegation("d3", "Collect the dry cleaning.", "Grace"),
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.supabaseGetUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  mocks.fetchAutomationDigest.mockResolvedValue(EMPTY_DIGEST);
  mocks.listTasks.mockResolvedValue(SEPT_26);
  mocks.listOpenStaffEscalationsForNeedsYou.mockResolvedValue([]);
  mocks.fetchUnresolvedCaptureCandidates.mockResolvedValue([]);
  mocks.classifyAttentionWorthyCaptures.mockImplementation((candidates: unknown[]) => candidates);
});

function namesIn(text: string, labels: string[]): string[] {
  return labels.filter((label) => text.includes(label));
}

// The live labels exactly as the shared classifier derives them.
async function liveLabels(): Promise<{ all: string[]; christopher: string[] }> {
  const evidence = await fetchAttentionEvidence();
  const items = [...evidence.needsYou, ...evidence.overdueReminders, ...evidence.upcomingReminders, ...evidence.waiting, ...evidence.later];
  return {
    all: items.map((item) => item.label),
    christopher: items.filter((item) => item.assignee === "Christopher").map((item) => item.label),
  };
}

describe("voice summary names live items (S3-1/2)", () => {
  it("S3-1: the summary names live items with exact category counts", async () => {
    const { text } = await fetchVoiceAttentionPresentation();
    expect(text).toMatch(/^Nothing needs your direct decision right now\./);
    expect(text).toContain("Overdue reminders (7):");
    expect(text).toContain("Waiting on others (3):");
    expect(namesIn(text, (await liveLabels()).all).length).toBeGreaterThan(0);
  });

  it("S3-2: at most five names in a summary, every category named first, and 'and N more' for the rest", async () => {
    const { text } = await fetchVoiceAttentionPresentation();
    expect(VOICE_ATTENTION_NAME_LIMIT).toBe(5);
    expect(namesIn(text, (await liveLabels()).all)).toHaveLength(5);
    // Round-robin: 3 overdue + 2 waiting names, so 4 overdue and 1 waiting remain.
    expect(text).toContain("; and 4 more.");
    expect(text).toContain("; and 1 more.");
    expect(text).toMatch(/Waiting on others \(3\): [^.;]+; [^.;]+; and 1 more\./);
  });

  it("names every item and adds no 'more' when five or fewer exist", async () => {
    mocks.listTasks.mockResolvedValue([overdue("r1", "Call Loulya"), delegation("d1", "bring the car around.", "Christopher")]);
    const { text } = await fetchVoiceAttentionPresentation();
    const labels = await liveLabels();
    expect(labels.all).toHaveLength(2);
    expect(text).toContain(`Overdue reminders (1): ${labels.all[0]}.`);
    expect(text).toContain(`Waiting on others (1): ${labels.all[1]}.`);
    expect(text).not.toContain("more");
  });

  it("names upcoming reminders as their own category", async () => {
    mocks.listTasks.mockResolvedValue([task("u1", { description: "Dentist", due_at: ahead(2) })]);
    const { text } = await fetchVoiceAttentionPresentation();
    const labels = await liveLabels();
    expect(text).toBe(`Nothing needs your direct decision right now. Upcoming reminders (1): ${labels.all[0]}.`);
  });
});

describe("follow-ups re-read live evidence (S3-3/4)", () => {
  it("S3-3: 'all' names every open item from a fresh read", async () => {
    const { text } = await fetchVoiceAttentionPresentation({ kind: "all" });
    expect(mocks.listTasks).toHaveBeenCalledTimes(1);
    const labels = await liveLabels();
    expect(labels.all).toHaveLength(10);
    expect(namesIn(text, labels.all)).toHaveLength(10);
    expect(text).not.toContain("more");
  });

  it("S3-3: a person view lists only that person's open items", async () => {
    const { text, captureIds } = await fetchVoiceAttentionPresentation({ kind: "person", name: "Christopher" });
    const labels = await liveLabels();
    expect(labels.christopher).toHaveLength(2);
    expect(text).toBe(`Open with Christopher (2): ${labels.christopher.join("; ")}.`);
    expect(captureIds).toEqual([]);
  });

  it("S3-4: changes during an active session show on the next read, never the earlier list", async () => {
    const first = await fetchVoiceAttentionPresentation({ kind: "all" });
    const before = await liveLabels();
    expect(first.text).toContain("Overdue reminders (7):");
    expect(before.christopher).toHaveLength(2);
    // Mid-session: Christopher confirms the car, Loulya is called, a new reminder lands.
    mocks.listTasks.mockResolvedValue([
      ...SEPT_26.filter((t) => t.id !== "r1" && t.id !== "d1"),
      task("d1", { ...SEPT_26[7], status: "done", confirmed_at: ago(0) }),
      task("r1", { description: "Call Loulya", due_at: ago(32), status: "done", confirmed_at: ago(0) }),
      overdue("r8", "Book the vet", 1),
    ]);
    const second = await fetchVoiceAttentionPresentation({ kind: "all" });
    const after = await liveLabels();
    expect(after.all).toHaveLength(9);
    expect(namesIn(second.text, after.all)).toHaveLength(9);
    expect(second.text).toContain("Overdue reminders (7):");
    expect(second.text).toContain("Waiting on others (2):");
    // The confirmed delegation's label is gone from the live labels and the text.
    const removed = before.christopher.filter((label) => !after.christopher.includes(label));
    expect(removed).toHaveLength(1);
    expect(second.text).not.toContain(removed[0]);
    const person = await fetchVoiceAttentionPresentation({ kind: "person", name: "Christopher" });
    expect(person.text).toBe(`Open with Christopher (1): ${after.christopher[0]}.`);
  });

  it("S3-5: completed and archived items are never named as open", async () => {
    mocks.listTasks.mockResolvedValue([
      overdue("r1", "Call Loulya"),
      task("x1", { description: "Done reminder", due_at: ago(3), status: "done", confirmed_at: ago(1) }),
      task("x3", { description: "Archived reminder", due_at: ago(3), archived_at: ago(1) }),
      task("x4", { description: "Done delegation", type: "delegation", assigned_to: "Christopher", status: "done", confirmed_at: ago(1) }),
    ]);
    const { text } = await fetchVoiceAttentionPresentation({ kind: "all" });
    const labels = await liveLabels();
    expect(labels.all).toHaveLength(1);
    expect(text).toBe(`Nothing needs your direct decision right now. Overdue reminders (1): ${labels.all[0]}.`);
    for (const gone of ["Done reminder", "Archived reminder", "Done delegation", "done reminder", "archived reminder"]) expect(text).not.toContain(gone);
  });

  it("a person with nothing open now gets a truthful 'nothing open', not an old list", async () => {
    mocks.listTasks.mockResolvedValue([overdue("r1", "Call Loulya")]);
    const { text } = await fetchVoiceAttentionPresentation({ kind: "person", name: "Christopher" });
    expect(text).toBe("Nothing is open with Christopher right now.");
  });
});

describe("truthful uncertainty and owner scope (S3-6/7)", () => {
  it("S3-6: signed out — no names, no counts, the existing honest failure", async () => {
    mocks.supabaseGetUser.mockResolvedValue({ data: { user: null }, error: null });
    for (const request of [{ kind: "summary" }, { kind: "all" }, { kind: "person", name: "Christopher" }] as const) {
      const presentation = await fetchVoiceAttentionPresentation(request);
      expect(presentation.evidenceOk).toBe(false);
      expect(presentation.text).toBe("I couldn't check what needs your attention right now — not signed in.");
      expect(presentation.captureIds).toEqual([]);
      expect(presentation.assignees).toEqual([]);
    }
    expect(mocks.listTasks).not.toHaveBeenCalled();
  });

  it("S3-6: a read that throws gives the honest failure and names nothing", async () => {
    const labels = await liveLabels();
    mocks.supabaseGetUser.mockRejectedValue(new Error("network"));
    const presentation = await fetchVoiceAttentionPresentation({ kind: "all" });
    expect(presentation.text).toBe("I couldn't check what needs your attention right now — the live check didn't complete.");
    expect(namesIn(presentation.text, labels.all)).toEqual([]);
  });

  it("S3-6: a partial read still says it may be incomplete", async () => {
    mocks.listOpenStaffEscalationsForNeedsYou.mockRejectedValue(new Error("timeout"));
    const { text } = await fetchVoiceAttentionPresentation();
    expect(text).toContain("I couldn't check everything just now, so this may be incomplete.");
  });

  it("S3-6: nothing open keeps the existing 'Nothing needs your attention right now.'", async () => {
    mocks.listTasks.mockResolvedValue([]);
    const { text } = await fetchVoiceAttentionPresentation();
    expect(text).toBe("Nothing needs your attention right now.");
  });

  it("S3-7: names come only from the owner's own session read (the RLS-scoped listTasks), and assignees only from it", async () => {
    const presentation = await fetchVoiceAttentionPresentation();
    expect(mocks.supabaseGetUser).toHaveBeenCalled();
    expect(mocks.listTasks).toHaveBeenCalledTimes(1);
    expect(presentation.assignees).toEqual(["Christopher", "Grace"]);
    expect(presentation.evidenceOk).toBe(true);
  });
});

describe("unchanged behaviour (S3-8/9)", () => {
  it("S3-8: the shared renderer and fetchAttentionPresentation keep the exact counts-only output", async () => {
    const { text } = await fetchAttentionPresentation();
    expect(text).toBe("Nothing needs your direct decision right now. You do have 7 overdue reminders and 3 thing you're waiting ons.");
  });

  it("S3-9 (S2/S2b): the capture line and captureIds are identical to the shared renderer's", async () => {
    mocks.fetchUnresolvedCaptureCandidates.mockResolvedValue([
      { id: "n1", kind: "note" as const, text: "Look into a new bookshelf", ageDays: 60, neverSurfaced: true, actionable: true },
      { id: "t1", kind: "todo" as const, text: "Sort the photo album", ageDays: 45, neverSurfaced: true, actionable: true },
    ]);
    const shared = await fetchAttentionPresentation();
    const voice = await fetchVoiceAttentionPresentation();
    const line = "Also on your mind: Look into a new bookshelf (a note you made); Sort the photo album (on your to-do list).";
    expect(shared.text).toContain(line);
    expect(voice.text).toContain(line);
    expect(voice.captureIds).toEqual(shared.captureIds);
    expect(mocks.markCarsonNotesSurfaced).not.toHaveBeenCalled();
    expect(mocks.markCarsonTodosSurfaced).not.toHaveBeenCalled();
  });

  it("decisions are always named in full, as before", () => {
    const evidence = {
      ok: true,
      code: "attention_read_succeeded",
      completeness: "full",
      generatedAt: new Date().toISOString(),
      needsYou: [{ id: "e1", label: "Grace asks about the guest room", type: "staff_escalation", status: "pending", dueAt: null, dueDescription: null, assignee: "Grace", category: "needsYou" }],
      overdueReminders: [],
      upcomingReminders: [],
      waiting: [],
      later: [],
      unresolvedCaptures: [],
    } as const;
    expect(renderVoiceAttentionSummary(evidence as never)).toBe(renderAttentionSummary(evidence as never));
  });
});

describe("resolveVoiceAttentionFollowUp (voice-only follow-up recognition)", () => {
  const assignees = ["Christopher", "Grace"];
  it.each(["Which ones?", "which ones", "Tell me the rest", "Tell me the rest of them", "What are they?", "What are the rest?", "What\u2019s the rest?", "And the rest?", "List them all.", "What else?", "Is that everything?"])(
    "'%s' asks for every item",
    (utterance) => {
      expect(resolveVoiceAttentionFollowUp(utterance, assignees)).toEqual({ kind: "all" });
    },
  );

  it.each([
    ["What about Christopher?", "Christopher"],
    ["what about christopher", "Christopher"],
    ["And Grace?", "Grace"],
    ["How about Grace?", "Grace"],
  ])("'%s' asks for one person", (utterance, name) => {
    expect(resolveVoiceAttentionFollowUp(utterance, assignees)).toEqual({ kind: "person", name });
  });

  it("matches an unambiguous first name to a full stored name, never an ambiguous one", () => {
    expect(resolveVoiceAttentionFollowUp("What about Christopher?", ["Christopher Smith", "Grace"])).toEqual({ kind: "person", name: "Christopher Smith" });
    expect(resolveVoiceAttentionFollowUp("What about Chris?", ["Chris Adams", "Chris Brown"])).toBeNull();
    expect(resolveVoiceAttentionFollowUp("What about Smith?", ["Christopher Smith"])).toBeNull();
  });

  it.each(["What about dinner?", "What about Loulya?", "Yes.", "Send it to Christopher", "Remind Christopher about the car", "Thanks", "and Christopher too", "And Grace, remind her tomorrow"])(
    "'%s' is not taken over",
    (utterance) => {
      expect(resolveVoiceAttentionFollowUp(utterance, assignees)).toBeNull();
    },
  );
});
