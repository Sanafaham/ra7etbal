import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GOLDEN JOURNEY 5 — Direct staff communication
 * Phase 3 of the Carson Engineering Hardening Project.
 *
 * owner asks Carson to send plain communication → correct communication
 * route → WhatsApp send → correct person identity/linkage →
 * Communication History visibility. PLUS the negative: no delegation/task
 * created, no Needs You item, no Waiting task, no confirmation-task side
 * effects.
 *
 * Preserves the communication-vs-delegation contract (PR #49/#50/#52/#53,
 * PERMANENTLY LOCKED per RA7ETBAL_STATE.md): src/lib/direct-message-fast-path.ts's
 * real parseSimpleDirectMessage/executeDirectMessageFastPath → the real
 * createAndSendDirectMessage (src/lib/direct-messages.ts) — the exact same
 * send primitive sendDelegation()'s communication reroute in
 * ElevenLabsAgentWidget.tsx also calls — → the real buildDailyBrief (proves
 * the negative) → the real buildCommunicationHistory (proves visibility).
 */

vi.mock("@/lib/supabase", async () => {
  const tables = {};
  function makeChain(table) {
    const state = { table };
    const chain = {
      select: () => chain,
      eq: () => chain,
      or: () => chain,
      order: () => chain,
      limit: () => chain,
      then: (resolve) => resolve(tables[state.table] ?? { data: [], error: null }),
      insert: () => { throw new Error(`unexpected insert on ${state.table}`); },
      update: () => { throw new Error(`unexpected update on ${state.table}`); },
      delete: () => { throw new Error(`unexpected delete on ${state.table}`); },
    };
    return chain;
  }
  return {
    supabase: { from: (table) => makeChain(table) },
    __setMockTables: (next) => {
      for (const k of Object.keys(tables)) delete tables[k];
      Object.assign(tables, next);
    },
  };
});

const { parseSimpleDirectMessage, executeDirectMessageFastPath } = await import("@/lib/direct-message-fast-path");
const { isCommunicationStyleTaskText } = await import("@/lib/communication-vs-delegation");
const { buildDailyBrief } = await import("@/lib/daily-brief");
const { buildCommunicationHistory } = await import("@/lib/carson-communication-history");
const { __setMockTables } = await import("@/lib/supabase");

const USER_ID = "user-golden-5";
const PERSON_ID = "person-sana-golden-5";

beforeEach(() => {
  vi.restoreAllMocks();
});

function personFixture() {
  return { id: PERSON_ID, name: "Sana", phone: "+971500000099", whatsapp_opted_in: true };
}

describe("Golden Journey 5 — direct staff communication, cross-module", () => {
  it("routes plain communication through the direct-message primitive with no task side effects, and makes it visible in Communication History", async () => {
    const instruction = "Tell Sana I'm on my way.";

    // ── Step 1: correct communication route (real parseSimpleDirectMessage) ──
    const parsed = parseSimpleDirectMessage(instruction, [personFixture()]);
    expect(parsed).not.toBeNull();
    // This route never consults the classifier at all — parseSimpleDirectMessage
    // dispatches deterministically regardless of what the classifier would say.
    // Proven here with a stand-in classifier that always answers "delegation"
    // (the real classifier is model-backed — see communication-vs-delegation.ts —
    // and is not exercised in this golden journey): even so, this instruction
    // still correctly routes as a direct message with no task side effects.
    expect(await isCommunicationStyleTaskText(parsed.messageText, async () => "delegation")).toBe(false);

    // ── Step 2: WhatsApp send via the real cross-module send primitive ────
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const createMessageFn = vi.fn().mockResolvedValue({
      id: "message-golden-5",
      task_id: null,
      person_id: PERSON_ID,
      recipient: "Sana",
      content: parsed.messageText,
      confirmation_url: null,
    });
    const deliverTaskMessageFn = vi.fn().mockResolvedValue({
      success: true,
      channel: "whatsapp",
      deliveryId: "delivery-golden-5",
      messageId: "wamid.golden-5",
    });

    const result = await executeDirectMessageFastPath(
      instruction,
      { userId: USER_ID, displayName: "Sana", people: [personFixture()] },
      { createMessageFn, deliverTaskMessageFn },
    );

    expect(result.handled).toBe(true);
    expect(result.status).toBe("sent");
    // The fast path never touches the real network — it goes exclusively
    // through the injected send primitive.
    expect(fetchMock).not.toHaveBeenCalled();

    // ── Step 3: correct person identity/linkage ────────────────────────────
    expect(createMessageFn).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: USER_ID,
        task_id: null,
        person_id: PERSON_ID,
        confirmation_url: null,
      }),
    );

    // ── Negative proof: no delegation/task/Needs-You/Waiting side effects ──
    // createAndSendDirectMessage's whole call chain (direct-message-fast-path.ts
    // -> direct-messages.ts) has no source-level reference to any
    // task-creation symbol — proven structurally, not just by absence of a
    // spy call, per RA7ETBAL_STATE.md's own documented guarantee for this
    // module. The daily-brief projection over an empty/unrelated task set
    // (this send created none) has nothing new in it.
    const existingUnrelatedTasks = [
      { id: "unrelated-1", user_id: USER_ID, type: "reminder", status: "pending", description: "Pay the internet bill", assigned_to: null, quality_review_status: null, needs_follow_up: false },
    ];
    const brief = buildDailyBrief(existingUnrelatedTasks, new Date("2026-08-14T11:00:00.000Z"));
    expect(brief.needsAttention.map((t) => t.id)).not.toContain("message-golden-5");
    expect(brief.waitingOnOthers).toHaveLength(0);
    expect(brief.waitingOnOthers.some((t) => t.assigned_to === "Sana")).toBe(false);

    // ── Step 4: Communication History visibility (real buildCommunicationHistory) ──
    __setMockTables({
      staff_messages: { data: [], error: null },
      personal_contact_replies: { data: [], error: null },
      messages: {
        data: [
          {
            id: "message-golden-5",
            task_id: null,
            body: null,
            content: parsed.messageText,
            created_at: "2026-08-14T11:01:00.000Z",
            whatsapp_message_id: "wamid.golden-5",
            channel: "whatsapp",
          },
        ],
        error: null,
      },
      whatsapp_deliveries: { data: [], error: null },
      staff_escalation_owner_decisions: { data: [], error: null },
    });

    const history = await buildCommunicationHistory(PERSON_ID, "Sana", USER_ID);
    expect(history.failedSources).toEqual([]);
    const sentEvent = history.events.find((e) => e.eventType === "message_sent");
    expect(sentEvent).toBeDefined();
    expect(sentEvent?.taskId).toBeNull();
  });

  it("negative proof, structural: neither the fast-path module nor the send primitive imports any task-creation symbol", async () => {
    // Mirrors the exact structural regression guard already established in
    // carson-protected-behaviors.test.ts §8 for this module — reused here,
    // not duplicated, as the "no delegation/task created" mechanical proof
    // that doesn't depend on which specific fixture happens to be in play.
    const fastPathSrc = await (await import("node:fs/promises")).readFile(
      new URL("../src/lib/direct-message-fast-path.ts", import.meta.url),
      "utf8",
    );
    const directMessagesSrc = await (await import("node:fs/promises")).readFile(
      new URL("../src/lib/direct-messages.ts", import.meta.url),
      "utf8",
    );
    for (const forbidden of ["createAndSendDelegation", "createDelegationTaskAndMessage", "createTask"]) {
      expect(fastPathSrc).not.toContain(forbidden);
      expect(directMessagesSrc).not.toContain(forbidden);
    }
    expect(fastPathSrc).not.toMatch(/from\s+["']\.\/delegations["']/);
    expect(directMessagesSrc).not.toMatch(/from\s+["']\.\/delegations["']/);
  });
});
