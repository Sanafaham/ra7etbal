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
    expect(sorted(presentation.page?.givenIds)).toEqual(sorted(OCT_9_IDS));
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
    expect(sorted(presentation.page?.givenIds)).toEqual(sorted(CHRISTOPHER_IDS));
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

describe("Oct 9 'Tell me the rest' — the items not yet given, then the ones given before", () => {
  // The app knows what it GAVE the model, never what Carson SAID aloud, so
  // earlier items are re-offered on a separate line, never silently dropped.
  it("after Christopher's items, 'the rest' leads with the seven overdue reminders and re-offers Christopher's", async () => {
    const person = await fetchVoiceAttentionPresentation({ kind: "person", name: "Christopher" });
    const rest = await fetchVoiceAttentionPresentation({ kind: "rest", previouslyGivenIds: person.page!.givenIds, person: null });
    expect(rest.text).toBe(
      "Not in my last answer: Overdue reminders (7): Call Loulya (3 separate reminders); Check my mailbox; Check my email; Pay bills; Call the doctor. " +
        "Already given in my last answer: Christopher: bring the car around (2 separate tasks); Christopher: Make a pizza for dinner; " +
        "Christopher: call me now; Christopher: prepare lunch for me and track this until he confirms it.",
    );
    expect(rest.modelText).toContain("The app cannot tell what you actually said aloud");
    expect(rest.modelText).toContain('if your last answer did not name every item under "Already given in my last answer", name those too');
    expect(sorted(rest.page?.givenIds)).toEqual(sorted(OCT_9_IDS));
  });

  it("REGRESSION (Oct 9 turn B): every item was given but only three were spoken — 'the rest' still offers all twelve, never 'that's everything'", async () => {
    const all = await fetchVoiceAttentionPresentation({ kind: "all" });
    const rest = await fetchVoiceAttentionPresentation({ kind: "rest", previouslyGivenIds: all.page!.givenIds });
    expect(rest.text).toBe(
      "Nothing else is open beyond my last answer. " +
        "Already given in my last answer: Call Loulya (3 separate reminders); Check my mailbox; Check my email; Pay bills; Call the doctor; " +
        "Christopher: bring the car around (2 separate tasks); Christopher: Make a pizza for dinner; " +
        "Christopher: call me now; Christopher: prepare lunch for me and track this until he confirms it.",
    );
    expect(rest.text).not.toContain("That's everything");
    expect(rest.modelText).toContain("name those too");
  });

  it("after the summary, 'the rest' leads with exactly the items the summary left out", async () => {
    const summary = await fetchVoiceAttentionPresentation();
    const rest = await fetchVoiceAttentionPresentation({ kind: "rest", previouslyGivenIds: summary.page!.givenIds });
    expect(rest.text.startsWith(
      "Not in my last answer: Overdue reminders (2): Pay bills; Call the doctor. " +
        "Waiting on others (2): Christopher: call me now; Christopher: prepare lunch for me and track this until he confirms it. " +
        "Already given in my last answer: ",
    )).toBe(true);
    // A further "the rest" in the same chain has nothing new and re-offers everything given so far.
    const again = await fetchVoiceAttentionPresentation({ kind: "rest", previouslyGivenIds: rest.page!.givenIds });
    expect(sorted(rest.page!.givenIds)).toEqual(sorted(OCT_9_IDS));
    expect(again.text.startsWith("Nothing else is open beyond my last answer. Already given in my last answer: ")).toBe(true);
  });

  it("after a partial read it never claims the list is complete", async () => {
    const all = await fetchVoiceAttentionPresentation({ kind: "all" });
    mocks.listOpenStaffEscalationsForNeedsYou.mockRejectedValue(new Error("timeout"));
    const partial = await fetchVoiceAttentionPresentation({ kind: "rest", previouslyGivenIds: all.page!.givenIds });
    expect(partial.text.startsWith("Nothing else came up beyond my last answer. ")).toBe(true);
    expect(partial.text.endsWith("I couldn't check everything just now, so this may be incomplete.")).toBe(true);
    expect(partial.text).not.toContain("Nothing else is open");
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
    const next = await fetchVoiceAttentionPresentation({ kind: "rest", previouslyGivenIds: first.page!.givenIds });
    expect(next.page?.remaining).toBe(0);
    expect(next.text).not.toContain('"continue"');
    expect(next.text.startsWith("Not in my last answer: Overdue reminders (4): Errand number 11; Errand number 12; Errand number 13; Errand number 14. ")).toBe(true);
    expect(sorted(next.page!.givenIds)).toEqual(sorted(many.map((t) => t.id)));
  });

  it("REVIEW FINDING: a three-page chain never repeats a page and ends with nothing new", async () => {
    const twentyFive = Array.from({ length: 25 }, (_, i) => overdue(`p${i + 1}`, `Errand number ${i + 1}`, 30 - i));
    mocks.listTasks.mockResolvedValue(twentyFive);
    const first = await fetchVoiceAttentionPresentation({ kind: "all" });
    const second = await fetchVoiceAttentionPresentation({ kind: "rest", previouslyGivenIds: first.page!.givenIds });
    const third = await fetchVoiceAttentionPresentation({ kind: "rest", previouslyGivenIds: second.page!.givenIds });
    const fourth = await fetchVoiceAttentionPresentation({ kind: "rest", previouslyGivenIds: third.page!.givenIds });
    expect(second.text.startsWith("Not in my last answer: Overdue reminders (15): Errand number 11;")).toBe(true);
    expect(second.page?.remaining).toBe(5);
    expect(third.text.startsWith("Not in my last answer: Overdue reminders (5): Errand number 21; Errand number 22; Errand number 23; Errand number 24; Errand number 25.")).toBe(true);
    expect(third.page?.remaining).toBe(0);
    expect(sorted(third.page!.givenIds)).toEqual(sorted(twentyFive.map((t) => t.id)));
    expect(fourth.text.startsWith("Nothing else is open beyond my last answer.")).toBe(true);
  });

  it("continuing a split person list stays with that person", async () => {
    const christophers = Array.from({ length: 12 }, (_, i) => delegation(`c${i + 1}`, `Job number ${i + 1}`, "Christopher"));
    mocks.listTasks.mockResolvedValue([...christophers, delegation("g1", "Water the garden", "Grace")]);
    const first = await fetchVoiceAttentionPresentation({ kind: "person", name: "Christopher" });
    expect(first.page).toMatchObject({ remaining: 2, person: "Christopher" });
    const next = await fetchVoiceAttentionPresentation({ kind: "rest", previouslyGivenIds: first.page!.givenIds, person: "Christopher" });
    expect(next.text.startsWith("Not in my last answer, open with Christopher: Job number 11; Job number 12. Already given in my last answer: Job number 1; ")).toBe(true);
    expect(next.text).not.toContain("Grace");
  });
});

describe("review findings: captures and grouping", () => {
  it("a 'the rest' after the summary does not repeat the 'Also on your mind' line as new", async () => {
    mocks.fetchUnresolvedCaptureCandidates.mockResolvedValue([
      { id: "n1", kind: "note" as const, text: "Look into a new bookshelf", ageDays: 60, neverSurfaced: true, actionable: true },
    ]);
    const summary = await fetchVoiceAttentionPresentation();
    expect(summary.text).toContain("Also on your mind: Look into a new bookshelf");
    expect(summary.captureIds).toEqual([{ id: "n1", kind: "note" }]);
    const rest = await fetchVoiceAttentionPresentation({ kind: "rest", previouslyGivenIds: summary.page!.givenIds });
    expect(rest.text).not.toContain("Also on your mind");
    expect(rest.captureIds).toEqual([]);
  });

  it("a reminder and a task with the same wording are not grouped together", async () => {
    mocks.listTasks.mockResolvedValue([overdue("r1", "Call the bank", 3), delegation("d1", "Call the bank", "Christopher")]);
    const { text } = await fetchVoiceAttentionPresentation({ kind: "person", name: "Christopher" });
    expect(text).toBe("Open with Christopher (1): Call the bank.");
    const all = await fetchVoiceAttentionPresentation({ kind: "all" });
    expect(all.text).not.toContain("separate");
  });
});

describe("failed reads are never presented as complete", () => {
  it("a failed read gives the honest failure only: no list instruction, no background note, nothing remembered", async () => {
    mocks.supabaseGetUser.mockResolvedValue({ data: { user: null }, error: null });
    for (const request of [{ kind: "all" }, { kind: "rest", previouslyGivenIds: ["r1"] }, { kind: "person", name: "Christopher" }] as const) {
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
