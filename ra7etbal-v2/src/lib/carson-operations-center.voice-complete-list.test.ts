/**
 * P3 Step 3 / S3 — spoken-answer reliability (Option A, owner-approved
 * 2026-10-09). Best effort: the voice model is still free to ignore what it is
 * given, so these tests prove what Carson is GIVEN, never what it SAYS.
 *
 * Production (conv_4501m4gfrsgyfdztjms1ypbdt8jp, 2026-10-09): the live data
 * and tool results were correct, but
 *  - "Which ones?" was answered "Call Loulya (twice), Call the doctor, and four
 *    more unspecified tasks… among others" — the live list was only a
 *    background note with no instruction to name every item;
 *  - "What about Christopher?" got no fresh read at all — a person view was
 *    never sent to the model — and was answered from the previous turn;
 *  - the live list used shortened labels ("bill task", "car task", "my
 *    email"), so Carson spoke the session-start names instead.
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

const { fetchAttentionPresentation, fetchVoiceAttentionPresentation, VOICE_FULL_LIST_PAGE_SIZE } = await import(
  "./carson-operations-center"
);

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

const overdue = (id: string, description: string, days: number) => task(id, { description, due_at: ago(days) });
const delegation = (id: string, description: string, assignee: string) =>
  task(id, { description, type: "delegation", assigned_to: assignee, needs_follow_up: true, created_at: ago(10) });

// The owner's live records at 14:07 UTC on 2026-10-09 (read-only check):
// seven overdue reminders — three separate "Call Loulya" — and five
// Christopher delegations, two of them separate "bring the car around".
const OCT_9 = [
  overdue("r1", "Call Loulya", 45),
  overdue("r2", "Check my mailbox", 45),
  overdue("r3", "Check my email", 45),
  overdue("r4", "Pay bills", 42),
  overdue("r5", "Call the doctor", 42),
  overdue("r6", "Call Loulya", 31),
  overdue("r7", "Call Loulya", 19),
  delegation("d1", "bring the car around.", "Christopher"),
  delegation("d2", "bring the car around.", "Christopher"),
  delegation("d3", "Make a pizza for dinner.", "Christopher"),
  delegation("d4", "call me now.", "Christopher"),
  delegation("d5", "prepare lunch for me and track this until he confirms it.", "Christopher"),
];
const OCT_9_IDS = OCT_9.map((t) => t.id);
const OVERDUE_IDS = ["r1", "r2", "r3", "r4", "r5", "r6", "r7"];
const CHRISTOPHER_IDS = ["d1", "d2", "d3", "d4", "d5"];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.supabaseGetUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  mocks.fetchAutomationDigest.mockResolvedValue(EMPTY_DIGEST);
  mocks.listTasks.mockResolvedValue(OCT_9);
  mocks.listOpenStaffEscalationsForNeedsYou.mockResolvedValue([]);
  mocks.fetchUnresolvedCaptureCandidates.mockResolvedValue([]);
  mocks.classifyAttentionWorthyCaptures.mockImplementation((candidates: unknown[]) => candidates);
});

const sorted = (ids: readonly string[] | undefined) => [...(ids ?? [])].sort();

describe("Oct 9 'Which ones?' — every item, in the owner's wording, with an instruction to name them all", () => {
  it("the tool result names all twelve records, groups same-wording records, and says not to shorten", async () => {
    const presentation = await fetchVoiceAttentionPresentation({ kind: "all" });
    expect(presentation.text).toBe(
      "Nothing needs your direct decision right now. " +
        "Overdue reminders (7): Call Loulya (3 separate reminders); Check my mailbox; Check my email; Pay bills; Call the doctor. " +
        "Waiting on others (5): Christopher: bring the car around (2 separate tasks); Christopher: Make a pizza for dinner; " +
        "Christopher: call me now; Christopher: prepare lunch for me and track this until he confirms it.",
    );
    expect(presentation.modelText).toBe(
      `${presentation.text} [For Carson: The owner asked for the items themselves: say every item above by name, in this wording. ` +
        'Do not shorten it to "and N more" or "among others".]',
    );
    for (const shortened of ["bill task", "car task", "and 4 more", "more after these"]) {
      expect(presentation.modelText).not.toContain(shortened);
    }
    expect(sorted(presentation.page?.namedIds)).toEqual(sorted(OCT_9_IDS));
    expect(presentation.page?.remaining).toBe(0);
  });

  it("the background note carries the same complete list and the same instruction", async () => {
    const presentation = await fetchVoiceAttentionPresentation({ kind: "all" });
    expect(presentation.contextNote).toContain(`[Live attention check] ${presentation.text} `);
    expect(presentation.contextNote).toContain("The OPEN list given at the start of this session may be out of date.");
    expect(presentation.contextNote).toContain("say every item above by name");
  });

  it("the summary keeps the five-name limit (owner decision) but in the owner's wording, with no list instruction", async () => {
    const presentation = await fetchVoiceAttentionPresentation();
    expect(presentation.text).toBe(
      "Nothing needs your direct decision right now. " +
        "Overdue reminders (7): Call Loulya (3 separate reminders); Check my mailbox; Check my email; and 2 more. " +
        "Waiting on others (5): Christopher: bring the car around (2 separate tasks); Christopher: Make a pizza for dinner; and 2 more.",
    );
    expect(presentation.modelText).toBe(presentation.text);
  });
});

describe("Oct 9 'What about Christopher?' — a fresh person-scoped read is given to the model", () => {
  it("the person view is offered as a background note labelled as that person's items only", async () => {
    const presentation = await fetchVoiceAttentionPresentation({ kind: "person", name: "Christopher" });
    expect(presentation.text).toBe(
      "Open with Christopher (5): bring the car around (2 separate tasks); Make a pizza for dinner; call me now; " +
        "prepare lunch for me and track this until he confirms it.",
    );
    expect(presentation.contextNote).toBe(
      `[Live attention check: Christopher only] ${presentation.text} This covers only Christopher's open items, not everything that is open. ` +
        "[For Carson: The owner asked for the items themselves: say every item above by name, in this wording. " +
        'Do not shorten it to "and N more" or "among others".]',
    );
    expect(sorted(presentation.page?.namedIds)).toEqual(sorted(CHRISTOPHER_IDS));
  });

  it("only that person's current items: another person's items never appear, and a change shows on the next read", async () => {
    mocks.listTasks.mockResolvedValue([...OCT_9, delegation("g1", "call me now.", "Grace")]);
    const first = await fetchVoiceAttentionPresentation({ kind: "person", name: "Christopher" });
    expect(first.text).not.toContain("Grace");
    expect(first.text).toContain("Open with Christopher (5):");
    // Christopher confirms the pizza mid-call.
    mocks.listTasks.mockResolvedValue([
      ...OCT_9.filter((t) => t.id !== "d3"),
      task("d3", { ...OCT_9[9], status: "done", confirmed_at: ago(0) }),
      delegation("g1", "call me now.", "Grace"),
    ]);
    const second = await fetchVoiceAttentionPresentation({ kind: "person", name: "Christopher" });
    expect(second.text).toBe(
      "Open with Christopher (4): bring the car around (2 separate tasks); call me now; prepare lunch for me and track this until he confirms it.",
    );
    expect(second.contextNote).toContain("[Live attention check: Christopher only]");
    expect(mocks.listTasks).toHaveBeenCalledTimes(2);
  });

  it("the same wording for two different people stays two items", async () => {
    mocks.listTasks.mockResolvedValue([delegation("d4", "call me now.", "Christopher"), delegation("n1", "call me now.", "Nasira")]);
    const { text } = await fetchVoiceAttentionPresentation({ kind: "all" });
    expect(text).toContain("Waiting on others (2): Christopher: call me now; Nasira: call me now.");
  });
});

describe("Oct 9 'Tell me the rest' — the items the last answer did not name", () => {
  it("after Christopher's items, 'the rest' is the seven overdue reminders, not a repeat", async () => {
    const person = await fetchVoiceAttentionPresentation({ kind: "person", name: "Christopher" });
    const rest = await fetchVoiceAttentionPresentation({ kind: "rest", alreadyNamedIds: person.page!.namedIds, person: null });
    expect(rest.text).toBe(
      "Besides what I just mentioned: Overdue reminders (7): Call Loulya (3 separate reminders); Check my mailbox; Check my email; Pay bills; Call the doctor.",
    );
    expect(rest.modelText).toContain("say every item above by name");
    expect(sorted(rest.page?.namedIds)).toEqual(sorted(OVERDUE_IDS));
  });

  it("after the summary, 'the rest' names exactly the items the summary left out", async () => {
    const summary = await fetchVoiceAttentionPresentation();
    const rest = await fetchVoiceAttentionPresentation({ kind: "rest", alreadyNamedIds: summary.page!.namedIds });
    expect(sorted([...summary.page!.namedIds, ...rest.page!.namedIds])).toEqual(sorted(OCT_9_IDS));
    expect(rest.page!.namedIds.some((id) => summary.page!.namedIds.includes(id))).toBe(false);
    expect(rest.text).toBe(
      "Besides what I just mentioned: Overdue reminders (2): Pay bills; Call the doctor. " +
        "Waiting on others (2): Christopher: call me now; Christopher: prepare lunch for me and track this until he confirms it.",
    );
  });

  it("when nothing is left after a complete read, it says so; after a partial read it never claims 'everything'", async () => {
    const all = await fetchVoiceAttentionPresentation({ kind: "all" });
    const done = await fetchVoiceAttentionPresentation({ kind: "rest", alreadyNamedIds: all.page!.namedIds });
    expect(done.text).toBe("That's everything — nothing else is open besides what I just mentioned.");
    mocks.listOpenStaffEscalationsForNeedsYou.mockRejectedValue(new Error("timeout"));
    const partial = await fetchVoiceAttentionPresentation({ kind: "rest", alreadyNamedIds: all.page!.namedIds });
    expect(partial.text).toBe(
      "Nothing else came up besides what I just mentioned. I couldn't check everything just now, so this may be incomplete.",
    );
    expect(partial.text).not.toContain("everything —");
    expect(partial.modelText).toContain("say the list may be incomplete and never call it everything");
  });
});

describe("long lists are split out loud, with a reliable 'continue'", () => {
  const many = Array.from({ length: 14 }, (_, i) => overdue(`m${i + 1}`, `Errand number ${i + 1}`, 20 - i));

  it("a list longer than one answer says how many are left and how to continue, and continue gives exactly the rest", async () => {
    mocks.listTasks.mockResolvedValue(many);
    expect(VOICE_FULL_LIST_PAGE_SIZE).toBe(10);
    const first = await fetchVoiceAttentionPresentation({ kind: "all" });
    expect(first.text).toContain('That\'s 10 of 14; 4 more after these. Say "continue" for the rest.');
    expect(first.modelText).toContain('then say there are 4 more and that they can say "continue"');
    expect(first.modelText).not.toContain("among others");
    expect(first.page?.remaining).toBe(4);
    const next = await fetchVoiceAttentionPresentation({ kind: "rest", alreadyNamedIds: first.page!.namedIds });
    expect(next.page?.remaining).toBe(0);
    expect(next.text).not.toContain("continue");
    expect(sorted([...first.page!.namedIds, ...next.page!.namedIds])).toEqual(sorted(many.map((t) => t.id)));
  });

  it("continuing a split person list stays with that person", async () => {
    const christophers = Array.from({ length: 12 }, (_, i) => delegation(`c${i + 1}`, `Job number ${i + 1}`, "Christopher"));
    mocks.listTasks.mockResolvedValue([...christophers, delegation("g1", "Water the garden", "Grace")]);
    const first = await fetchVoiceAttentionPresentation({ kind: "person", name: "Christopher" });
    expect(first.page).toMatchObject({ remaining: 2, person: "Christopher" });
    const next = await fetchVoiceAttentionPresentation({ kind: "rest", alreadyNamedIds: first.page!.namedIds, person: "Christopher" });
    expect(next.text).toBe("The rest open with Christopher: Job number 11; Job number 12.");
    expect(next.text).not.toContain("Grace");
  });
});

describe("failed reads are never presented as complete", () => {
  it("a failed read gives the honest failure only: no list instruction, no background note, nothing remembered", async () => {
    mocks.supabaseGetUser.mockResolvedValue({ data: { user: null }, error: null });
    for (const request of [{ kind: "all" }, { kind: "rest", alreadyNamedIds: ["r1"] }, { kind: "person", name: "Christopher" }] as const) {
      const presentation = await fetchVoiceAttentionPresentation(request);
      expect(presentation.evidenceOk).toBe(false);
      expect(presentation.modelText).toBe("I couldn't check what needs your attention right now — not signed in.");
      expect(presentation.contextNote).toBeUndefined();
      expect(presentation.page).toBeUndefined();
    }
  });

  it("a read that throws gives the honest failure and no note", async () => {
    mocks.supabaseGetUser.mockRejectedValue(new Error("network"));
    const presentation = await fetchVoiceAttentionPresentation({ kind: "all" });
    expect(presentation.text).toBe("I couldn't check what needs your attention right now — the live check didn't complete.");
    expect(presentation.contextNote).toBeUndefined();
    expect(presentation.page).toBeUndefined();
  });
});

describe("unchanged outside legacy voice", () => {
  it("typed's shared fetchAttentionPresentation keeps the exact counts-only output and has no voice fields", async () => {
    const presentation = await fetchAttentionPresentation();
    expect(presentation).toEqual({
      text: "Nothing needs your direct decision right now. You do have 7 overdue reminders and 5 thing you're waiting ons.",
      captureIds: [],
    });
  });

  it("very long wording is cut at a word boundary, never mid-word", async () => {
    const long = `Please collect ${"the very long parcel ".repeat(10)}from the post office`;
    mocks.listTasks.mockResolvedValue([overdue("l1", long, 3)]);
    const { text } = await fetchVoiceAttentionPresentation({ kind: "all" });
    const name = text.slice(text.indexOf("(1): ") + 5, -1);
    expect(name.endsWith("…")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(121);
    expect(long.startsWith(name.slice(0, -1))).toBe(true);
    expect(long.charAt(name.length - 1)).toBe(" ");
  });
});
