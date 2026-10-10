/**
 * P3 Step 3 / S3 — voice attention follow-up chain (2026-10-10 Production
 * canary conv_4601m4hgwcmqex3swcxmyy6h4f8t, owner's iPhone Home Screen PWA).
 *
 * Speech-to-text heard "What about Chris- Which ones?". The app did not
 * recognise it, so it treated the turn as unrelated, even though Carson itself
 * called get_items_needing_attention. That broke the follow-up chain: the tool
 * (which takes no arguments) returned the five-name summary on every later
 * turn, and "Tell me the rest" could never reach Check my mailbox / Check my
 * email.
 *
 * These tests drive the REAL recogniser, the chain functions the widget calls
 * and the REAL live-read renderer, turn by turn, including stale callbacks.
 * They prove what Carson is GIVEN, never what it SAYS.
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

const { fetchAttentionPresentation, fetchVoiceAttentionPresentation } = await import("./carson-operations-center");
const { beginVoiceAttentionTurn, recordVoiceAttentionRead, settleVoiceAttentionTurn, INITIAL_VOICE_ATTENTION_CHAIN } = await import(
  "./carson-attention-intent-guard"
);
type Presentation = Awaited<ReturnType<typeof fetchVoiceAttentionPresentation>>;
type Chain = typeof INITIAL_VOICE_ATTENTION_CHAIN;

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
// The owner's live records, unchanged on 2026-10-10 (read-only check).
const LIVE = [
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.supabaseGetUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  mocks.fetchAutomationDigest.mockResolvedValue(EMPTY_DIGEST);
  mocks.listTasks.mockResolvedValue(LIVE);
  mocks.listOpenStaffEscalationsForNeedsYou.mockResolvedValue([]);
  mocks.fetchUnresolvedCaptureCandidates.mockResolvedValue([]);
  mocks.classifyAttentionWorthyCaptures.mockImplementation((candidates: unknown[]) => candidates);
});


/** One voice turn as the widget runs it: begin, optional prefetch (recognised turns only), optional tool call, settle. */
async function turn(state: Chain, turnId: string, utterance: string, carsonCallsTool: boolean) {
  let s = beginVoiceAttentionTurn(state, { turnId, utterance, enabled: true });
  let prefetch: Presentation | null = null;
  if (s.recognised) {
    prefetch = await fetchVoiceAttentionPresentation(s.request);
    s = recordVoiceAttentionRead(s, { turnId, presentation: prefetch });
  }
  let tool: Presentation | null = null;
  if (carsonCallsTool) {
    tool = await fetchVoiceAttentionPresentation(s.request);
    s = recordVoiceAttentionRead(s, { turnId, presentation: tool });
  }
  return { state: settleVoiceAttentionTurn(s), prefetch, tool };
}

const OVERDUE_NAMES = ["Call Loulya (3 separate reminders)", "Check my mailbox", "Check my email", "Pay bills", "Call the doctor"];

describe("the exact 2026-10-10 four-turn canary", () => {
  it("summary, then the full list after the garbled follow-up, then Christopher only, then the rest including mailbox and email", async () => {
    // 1. "What needs my attention?" — recognised; Carson calls the tool.
    const t1 = await turn(INITIAL_VOICE_ATTENTION_CHAIN, "t1", "What needs my attention?", true);
    expect(t1.tool!.text).toContain("; and 2 more.");
    expect(t1.tool!.text).toContain("Overdue reminders (7): Call Loulya (3 separate reminders);");
    expect(t1.state.contextActive).toBe(true);

    // 2. "What about Chris- Which ones?" — not recognised, but Carson calls the tool: the complete list.
    const t2 = await turn(t1.state, "t2", "What about Chris- Which ones?", true);
    expect(t2.prefetch).toBeNull(); // no unsolicited background note on an unrecognised turn
    for (const name of OVERDUE_NAMES) expect(t2.tool!.modelText).toContain(name);
    expect(t2.tool!.modelText).toContain("Christopher: bring the car around (2 separate tasks)");
    expect(t2.tool!.modelText).not.toContain("more.");
    expect(t2.tool!.modelText).toContain("say every item above by name");
    expect(t2.state.contextActive).toBe(true);

    // 3. "What about Christopher?" — recognised person follow-up, Christopher only (Carson called get_person_history instead).
    const t3 = await turn(t2.state, "t3", "What about Christopher?", false);
    expect(t3.state.recognised).toBe(true);
    expect(t3.prefetch!.contextNote).toContain("[Live attention check: Christopher only]");
    expect(t3.prefetch!.text).toBe(
      "Open with Christopher (5): bring the car around (2 separate tasks); Make a pizza for dinner; call me now; " +
        "prepare lunch for me and track this until he confirms it.",
    );

    // 4. "Tell me the rest." — recognised; leads with the seven overdue reminders, mailbox and email included.
    const t4 = await turn(t3.state, "t4", "Tell me the rest.", true);
    expect(t4.state.recognised).toBe(true);
    expect(t4.tool!.text.startsWith(
      "Not in my last answer: Overdue reminders (7): Call Loulya (3 separate reminders); Check my mailbox; Check my email; Pay bills; Call the doctor. " +
        "Already given in my last answer: ",
    )).toBe(true);
    expect(t4.tool!.text).not.toContain("That's everything");
    expect(t4.tool!.modelText).toContain("The app cannot tell what you actually said aloud");
  });
});

describe("context rules", () => {
  it("a first overview question with no context still gets the five-name summary", async () => {
    const t1 = await turn(INITIAL_VOICE_ATTENTION_CHAIN, "t1", "What needs my attention?", true);
    expect(t1.state.request).toEqual({ kind: "summary" });
  });

  it("an unrecognised turn with no attention context keeps the summary if Carson calls the tool", async () => {
    const t1 = await turn(INITIAL_VOICE_ATTENTION_CHAIN, "t1", "Anything urgent I should know?", true);
    expect(t1.state.request).toEqual({ kind: "summary" });
    // A complete, successful read Carson asked for starts a context.
    expect(t1.state.contextActive).toBe(true);
  });

  it("a successful complete tool read keeps the context; an unrelated turn with no tool call ends it", async () => {
    const t1 = await turn(INITIAL_VOICE_ATTENTION_CHAIN, "t1", "What needs my attention?", true);
    const unrelated = await turn(t1.state, "t2", "What is the weather tomorrow?", false);
    expect(unrelated.state.contextActive).toBe(false);
    // So a later "Tell me the rest" is no longer treated as an attention follow-up.
    const later = beginVoiceAttentionTurn(unrelated.state, { turnId: "t3", utterance: "Tell me the rest.", enabled: true });
    expect(later.recognised).toBe(false);
    expect(later.request).toEqual({ kind: "summary" });
  });

  it("a partial read does not extend the context", async () => {
    const t1 = await turn(INITIAL_VOICE_ATTENTION_CHAIN, "t1", "What needs my attention?", true);
    mocks.listOpenStaffEscalationsForNeedsYou.mockRejectedValue(new Error("timeout"));
    const t2 = await turn(t1.state, "t2", "What about Chris- Which ones?", true);
    expect(t2.tool!.text).toContain("may be incomplete");
    expect(t2.state.contextActive).toBe(false);
  });

  it("a failed read does not extend the context and records no page", async () => {
    const t1 = await turn(INITIAL_VOICE_ATTENTION_CHAIN, "t1", "What needs my attention?", true);
    mocks.supabaseGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const t2 = await turn(t1.state, "t2", "What about Chris- Which ones?", true);
    expect(t2.tool!.evidenceOk).toBe(false);
    expect(t2.state.contextActive).toBe(false);
    expect(t2.state.lastPage).toEqual(t1.state.lastPage);
  });

  it("a new attention question starts a new chain", async () => {
    const t1 = await turn(INITIAL_VOICE_ATTENTION_CHAIN, "t1", "What needs my attention?", true);
    const t2 = await turn(t1.state, "t2", "Which ones?", true);
    const t3 = beginVoiceAttentionTurn(t2.state, { turnId: "t3", utterance: "What needs my attention?", enabled: true });
    expect(t3.request).toEqual({ kind: "summary" });
    expect(t3.lastPage).toBeNull();
  });

  it("disabled (Second Brain voice) never recognises anything and never asks for more than the summary", async () => {
    const t0 = await turn(INITIAL_VOICE_ATTENTION_CHAIN, "t0", "What needs my attention?", true);
    const t1 = beginVoiceAttentionTurn(t0.state, { turnId: "t1", utterance: "Which ones?", enabled: false });
    expect(t1.recognised).toBe(false);
    expect(t1.request).toEqual({ kind: "summary" });
  });
});

describe("stale and out-of-order callbacks", () => {
  it("a read that finishes after the next turn began changes nothing", async () => {
    const t1 = await turn(INITIAL_VOICE_ATTENTION_CHAIN, "t1", "What needs my attention?", true);
    const unrelated = beginVoiceAttentionTurn(t1.state, { turnId: "t2", utterance: "What is the weather tomorrow?", enabled: true });
    const late = await fetchVoiceAttentionPresentation({ kind: "all" });
    const after = recordVoiceAttentionRead(unrelated, { turnId: "t1", presentation: late });
    expect(after).toBe(unrelated);
    expect(settleVoiceAttentionTurn(after).contextActive).toBe(false);
  });

  it("after a session reset there is no context, whatever came before", async () => {
    const t1 = await turn(INITIAL_VOICE_ATTENTION_CHAIN, "t1", "What needs my attention?", true);
    expect(t1.state.contextActive).toBe(true);
    const fresh = beginVoiceAttentionTurn(INITIAL_VOICE_ATTENTION_CHAIN, { turnId: "t2", utterance: "Which ones?", enabled: true });
    expect(fresh.recognised).toBe(false);
    expect(fresh.request).toEqual({ kind: "summary" });
  });

  it("a barge-in before Carson's last message still continues the chain from that turn's own outcome", async () => {
    // Turn 1 recognised and read, but the user speaks again before Carson's message settles.
    let s = beginVoiceAttentionTurn(INITIAL_VOICE_ATTENTION_CHAIN, { turnId: "t1", utterance: "What needs my attention?", enabled: true });
    s = recordVoiceAttentionRead(s, { turnId: "t1", presentation: await fetchVoiceAttentionPresentation(s.request) });
    const next = beginVoiceAttentionTurn(s, { turnId: "t2", utterance: "Tell me the rest.", enabled: true });
    expect(next.recognised).toBe(true);
    expect(next.request.kind).toBe("rest");
    // And an unrelated turn interrupted the same way ends it.
    const unrelated = beginVoiceAttentionTurn(next, { turnId: "t3", utterance: "Never mind.", enabled: true });
    const after = beginVoiceAttentionTurn({ ...unrelated, recognised: false, readOk: false }, { turnId: "t4", utterance: "Tell me the rest.", enabled: true });
    expect(after.recognised).toBe(false);
  });

  it("settling twice in one turn (speech before and after a tool call) keeps the latest truth", async () => {
    const t0 = await turn(INITIAL_VOICE_ATTENTION_CHAIN, "t0", "What needs my attention?", true);
    let s = beginVoiceAttentionTurn(t0.state, { turnId: "t2", utterance: "Hmm, and those?", enabled: true });
    s = settleVoiceAttentionTurn(s); // pre-tool speech: no read yet
    expect(s.contextActive).toBe(false);
    s = recordVoiceAttentionRead(s, { turnId: "t2", presentation: await fetchVoiceAttentionPresentation(s.request) });
    s = settleVoiceAttentionTurn(s);
    expect(s.contextActive).toBe(true);
    expect(s.request).toEqual({ kind: "all" });
  });
});

describe("records and isolation", () => {
  it("same-wording records stay separate; different people never merge", async () => {
    mocks.listTasks.mockResolvedValue([...LIVE, delegation("n1", "call me now.", "Nasira")]);
    const t1 = await turn(INITIAL_VOICE_ATTENTION_CHAIN, "t1", "What needs my attention?", true);
    const t2 = await turn(t1.state, "t2", "What about Chris- Which ones?", true);
    expect(t2.tool!.text).toContain("Christopher: call me now;");
    expect(t2.tool!.text).toContain("Nasira: call me now");
    expect(t2.tool!.text).toContain("Call Loulya (3 separate reminders)");
  });

  it("names come only from the owner's own session read", async () => {
    await turn(INITIAL_VOICE_ATTENTION_CHAIN, "t1", "What needs my attention?", true);
    expect(mocks.supabaseGetUser).toHaveBeenCalled();
    expect(mocks.listTasks).toHaveBeenCalled();
  });

  it("no read marks captures surfaced", async () => {
    mocks.fetchUnresolvedCaptureCandidates.mockResolvedValue([
      { id: "n1", kind: "note" as const, text: "Look into a new bookshelf", ageDays: 60, neverSurfaced: true, actionable: true },
    ]);
    const t1 = await turn(INITIAL_VOICE_ATTENTION_CHAIN, "t1", "What needs my attention?", true);
    await turn(t1.state, "t2", "What about Chris- Which ones?", true);
    expect(mocks.markCarsonNotesSurfaced).not.toHaveBeenCalled();
    expect(mocks.markCarsonTodosSurfaced).not.toHaveBeenCalled();
  });

  it("typed keeps the shared counts-only result", async () => {
    expect(await fetchAttentionPresentation()).toEqual({
      text: "Nothing needs your direct decision right now. You do have 7 overdue reminders and 5 thing you're waiting ons.",
      captureIds: [],
    });
  });
});

describe("long lists", () => {
  it("an unrecognised follow-up in context still splits a long list out loud, and 'continue' gives the rest", async () => {
    const many = Array.from({ length: 14 }, (_, i) => overdue(`m${i + 1}`, `Errand number ${i + 1}`, 20 - i));
    mocks.listTasks.mockResolvedValue(many);
    const t1 = await turn(INITIAL_VOICE_ATTENTION_CHAIN, "t1", "What needs my attention?", true);
    const t2 = await turn(t1.state, "t2", "Uh, which, which ones are those?", true);
    expect(t2.tool!.text).toContain('Say "continue" for the rest.');
    const t3 = await turn(t2.state, "t3", "Continue.", true);
    expect(t3.tool!.text.startsWith("Not in my last answer: Overdue reminders (4):")).toBe(true);
  });
});
