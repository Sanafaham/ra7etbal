/**
 * CARSON PROTECTED BEHAVIORS — permanent regression suite.
 *
 * Confirmed production regression: "Ask Grace to call me now.", "Ask Suresh
 * to call me.", and "Tell Ghulam to wait for me." were wrongly routed to
 * the tracked-delegation path (staff received a confirmation link and a
 * task was created) on both Type to Carson and Talk to Carson. A staff
 * message does not become a tracked task merely because it contains a verb
 * — the distinction is whether Ra7etBal needs to track completed work.
 *
 * Root cause: neither Type to Carson's fast-path parsers nor Talk to
 * Carson's send_delegation tool handler had any check for whether a task's
 * text actually targets the OWNER (a communication act) rather than
 * describing trackable operational work. The fix adds one shared,
 * verb-agnostic classifier (isCommunicationStyleTaskText, in
 * communication-vs-delegation.ts) and wires it into the single function
 * both channels' delegation-creation paths converge on — sendDelegation()
 * in ElevenLabsAgentWidget.tsx, called by Talk to Carson's send_delegation
 * clientTool AND by Type to Carson's delegation fast path
 * (executeDelegationFastPath's injected sendDelegationFn). One guard, both
 * channels — Type and Talk cannot diverge because there is only one
 * sendDelegation implementation.
 *
 * This suite is a mandatory CI gate — see the "carson-protected-behaviors"
 * workflow. Every confirmed production regression against Carson's
 * communication/delegation routing becomes a permanent test here. See
 * "CARSON PROTECTED BEHAVIORS" in AGENTS.md for the full contract.
 *
 * C-02 CORRECTION (2026-09-05 product decision, partial reversal of the
 * paragraph above): a confirmed Production regression showed "Ask
 * Christopher to bring the car around at 6." — a person being asked to
 * perform an action and owing a result — was misrouted to a fire-and-forget
 * WhatsApp message via this same classifier, with no tracked task and no
 * accountability. On reconciliation, "Ask Grace to call me now.", "Ask
 * Suresh to call me.", and "Tell Ghulam to wait for me." are the same shape
 * (a person is asked to do something and owes an action/result) and are
 * now, by explicit product decision, tracked operational work too — see the
 * "Shared handler wiring" describe block below (viaDeterministicFastPath).
 * The classifier itself (communication-vs-delegation.ts) is untouched and
 * remains the sole authority for send_delegation calls that do NOT arrive
 * through the deterministic parser (the legacy clientTool, called directly
 * by the model with its own composed name/task).
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// direct-message-fast-path.ts transitively imports ./messages -> ./supabase,
// which throws outside a real browser env (missing VITE_SUPABASE_* vars).
// Same mock as direct-message-fast-path.test.ts — nothing here calls it.
vi.mock("./messages", () => ({ createMessage: vi.fn() }));

// direct-messages.ts imports ./delivery -> ./whatsapp -> ./supabase (real
// client). Every call site below supplies its own deliverTaskMessageFn
// override, so the real implementation is never invoked — this only
// prevents the unrelated import chain from loading at module init.
vi.mock("./delivery", () => ({ deliverTaskMessage: vi.fn() }));

// communication-vs-delegation.ts imports ./anthropic-client -> ./supabase
// (real client). Every call site in this file injects its own deterministic
// fakeClassify, so classifyStaffInstructionViaModel (and the real Anthropic
// call) is never invoked — this only prevents the unrelated import chain
// from loading at module init.
vi.mock("./anthropic-client", () => ({ callAnthropicProxy: vi.fn() }));

import { isCommunicationStyleTaskText } from "./communication-vs-delegation";
import type { StaffInstructionClassification } from "./communication-vs-delegation";
import { parseDelegationFastPath, executeDelegationFastPath } from "./delegation-fast-path";
import { parseSimpleDirectMessage } from "./direct-message-fast-path";
import { createAndSendDirectMessage, createDirectMessageRecord } from "./direct-messages";
import type { Person } from "../types/person";

// ── Deterministic classifier fixture ────────────────────────────────────────
// The real classifier (classifyStaffInstructionViaModel, see
// communication-vs-delegation.ts) is model-backed — this fixture stands in
// for it via isCommunicationStyleTaskText's injectable classifyFn parameter,
// so this suite tests the WIRING and the correct semantic answer for every
// confirmed protected phrase and grammatical form, deterministically and
// without hitting the network. The model call's own plumbing (prompt
// construction, response parsing, fail-safe default) is tested separately in
// communication-vs-delegation.model.test.ts.
//
// COMMUNICATION: Carson's responsibility ends once the message is
// delivered — no outcome to track afterward. DELEGATION (the default for
// anything not listed here): the recipient owes a verifiable outcome and
// Carson must keep tracking it. Deliberately NOT keyed on imperative mood,
// "to + verb", whether the owner is named, or any fixed verb list — see
// communication-vs-delegation.ts's module doc for why that approach failed.
const KNOWN_COMMUNICATION_TASK_TEXTS = new Set(
  [
    // Owner-target communication — confirmed production regressions (PR #49-53).
    "call me",
    "call me now.",
    "call me now",
    "contact me.",
    "contact me",
    "text me when you arrive",
    "message me when you arrive",
    "wait for me.",
    "wait for me in the kitchen. i'm on my way.",
    "wait for me in the kitchen.",
    "let me know when you arrive",
    "give me a call",
    "give us a ring",
    "wait in the kitchen for me.",
    "wait by the car for me.",
    "call me from the office.",
    "wait until 8.",
    "wait outside for me",
    "wait inside for us",
    "call me.",
    // Third-party direct communication — no owner-target marker at all.
    // Confirmed production incident (2026-08-16): "Christopher, come to the
    // kitchen now." was misclassified as delegation because the old
    // owner-target-only regex had no signal for this at all.
    "come to the kitchen now.",
    "come to the kitchen now",
    "wait downstairs.",
    "come upstairs.",
    "meet me outside.",
    "dinner is at eight.",
    "i'm running late.",
  ].map((text) => text.toLowerCase()),
);

async function fakeClassify(text: string): Promise<StaffInstructionClassification> {
  return KNOWN_COMMUNICATION_TASK_TEXTS.has(text.trim().toLowerCase())
    ? "communication"
    : "delegation";
}

function classify(text: string): Promise<boolean> {
  return isCommunicationStyleTaskText(text, fakeClassify);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: "person-1",
    user_id: "user-1",
    name: "Nasira",
    role: "staff",
    phone: "+971500000001",
    notes: null,
    created_at: "2026-06-24T00:00:00.000Z",
    relationship: null,
    is_family: false,
    responsibilities: null,
    reliability_level: null,
    follow_up_level: null,
    delegation_guidance: null,
    should_not_assign: null,
    escalate_to: null,
    communication_style: null,
    whatsapp_opted_in: true,
    whatsapp_consent_at: "2026-06-24T00:00:00.000Z",
    whatsapp_consent_method: "owner_confirmed",
    ...overrides,
  };
}

function roster(): Person[] {
  return [
    person({ id: "p-grace", name: "Grace", phone: "+971500000001" }),
    person({ id: "p-ghulam", name: "Ghulam", phone: "+971500000002" }),
    person({ id: "p-suresh", name: "Suresh", phone: "+971500000003" }),
    person({ id: "p-nasira", name: "Nasira", phone: "+971500000004" }),
    person({ id: "p-christopher", name: "Christopher", phone: "+971500000005" }),
  ];
}

const WIDGET_SOURCE = readFileSync(
  join(__dirname, "../components/home/ElevenLabsAgentWidget.tsx"),
  "utf-8",
);

function blockBetween(startNeedle: string, endNeedle: string): string {
  const start = WIDGET_SOURCE.indexOf(startNeedle);
  const end = WIDGET_SOURCE.indexOf(endNeedle, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return WIDGET_SOURCE.slice(start, end);
}

// ── 1. The shared classifier — verb-agnostic, target-of-action based ───────

describe("isCommunicationStyleTaskText — the one shared classifier", () => {
  it.each([
    "call me",
    "call me now.",
    "call me now",
    "contact me.",
    "contact me",
    "text me when you arrive",
    "message me when you arrive",
    "wait for me.",
    "wait for me in the kitchen. I'm on my way.",
    "let me know when you arrive",
    "give me a call",
    "give us a ring",
    // Production regression (post-PR #49): a location/time qualifier
    // inserted BETWEEN "wait" and "for me/us" bypassed the classifier,
    // since the original pattern required them adjacent.
    "wait in the kitchen for me.",
    "wait by the car for me.",
    "call me from the office.",
    "wait until 8.",
    // CodeRabbit finding on PR #50 (2nd round): "outside"/"inside" are
    // adverbs that can stand alone before "for me/us" — unlike "in"/"at"/
    // "by"/"near", which need a following location word. The qualifier
    // grammar must not silently require a word after them.
    "wait outside for me",
    "wait inside for us",
    // Third-party direct communication — no owner-target marker at all.
    // Confirmed production incident (2026-08-16, "Christopher, come to the
    // kitchen now."): the old owner-target-only regex had no signal for
    // this, so it fell through to tracked delegation. See "grammatical
    // form parity" below for the full-phrase (vocative/Tell/Ask/Have)
    // variants that all resolve to these same task texts.
    "come to the kitchen now.",
    "wait downstairs.",
    "come upstairs.",
    "meet me outside.",
    "dinner is at eight.",
    "i'm running late.",
  ])("%s -> communication (does not create a tracked task)", async (text) => {
    expect(await classify(text)).toBe(true);
  });

  it.each([
    "bring the car out.",
    "bring the car out and confirm when done.",
    "clean the guest room.",
    "make the pizza.",
    "buying groceries",
    // Same verb as the communication cases above ("call") — the target
    // (a third party, not the owner) is what makes this trackable work.
    // Proves the classifier is not a fixed phrase list.
    "call the mechanic.",
    "call the doctor and book an appointment.",
    // CodeRabbit finding on PR #50: the "wait" location/time qualifier must
    // not be able to absorb a real trailing task. A coordinating conjunction
    // ("and") inside the would-be location clause, or real content after a
    // "wait until TIME" clause, means this is compound delegated work, not
    // pure communication — the whole instruction must not be rerouted.
    "wait at the store and buy milk for me",
    "wait until 8, then clean the kitchen",
    // CodeRabbit finding on PR #50 (2nd round): "wait until TIME" was only
    // anchored to the end of the string, so it could still match as the
    // trailing fragment of a leading compound instruction.
    "clean the kitchen, then wait until 8",
    // Genuine work/outcome requests — same expected outcome across every
    // grammatical form (see "grammatical form parity" below).
    "clean the kitchen.",
    "prepare dinner.",
    "buy milk.",
    "check whether the guest room is ready.",
  ])("%s -> tracked delegated work (%s)", async (text) => {
    expect(await classify(text)).toBe(false);
  });

  // KNOWN, DOCUMENTED LIMITATION — flagged by independent review, not fixed
  // here (see communication-vs-delegation.ts's doc comment and
  // RA7ETBAL_STATE.md). A compound instruction pairing real trackable work
  // with a trailing communication clause is misclassified as fully
  // communication-style, so sendDelegation() would reroute the ENTIRE
  // instruction to a plain message and never create the trackable task.
  // Not proven by any confirmed production incident; fixing it correctly
  // needs conjunction/clause-boundary detection, not a small regex tweak,
  // so it is deliberately out of scope for this fix.
  it.todo(
    "'clean the kitchen and let me know when done' should stay tracked delegated work — currently misclassifies as communication-only and loses the task entirely (see communication-vs-delegation.ts)",
  );

  // Mirror of the above, raised by CodeRabbit on PR #50 (2nd round): real
  // work AFTER a location-qualified "wait ... for me" communication clause.
  // Not fixable by end-anchoring the "wait ... for me" alternative, since
  // that would break the confirmed regression "wait for me in the kitchen.
  // I'm on my way." (trailing descriptive content, not compound work) —
  // same deliberate-deferral reasoning as the todo above.
  it.todo(
    "'wait in the kitchen for me and then clean the garage' should stay tracked delegated work — currently misclassifies as communication-only and loses the task entirely (see communication-vs-delegation.ts)",
  );
});

// ── 2. Confirmed production regressions — exact evidence, permanently locked ──

describe("Regression: confirmed production evidence must never reproduce", () => {
  it("'Ask Grace to call me now.' task text is communication, not trackable work", async () => {
    expect(await classify("call me now.")).toBe(true);
  });

  it("'Ask Suresh to call me.' task text is communication, not trackable work", async () => {
    expect(await classify("call me.")).toBe(true);
  });

  it("'Tell Ghulam to wait for me.' task text is communication, not trackable work", async () => {
    expect(await classify("wait for me.")).toBe(true);
  });

  it("'Ask Ghulam to bring the car out.' remains tracked delegated work (must not change)", async () => {
    expect(await classify("bring the car out.")).toBe(false);
  });

  // Production regression found after PR #49 shipped: a location/short
  // qualifier inserted between "wait" and "for me/us" ("wait IN THE KITCHEN
  // for me") bypassed the classifier, which required them adjacent. Talk to
  // Carson sent Christopher a confirmation-link task message; Type to
  // Carson replied "Okay, I'm on it." instead of the plain-message path.
  it("'Tell Christopher to wait in the kitchen for me.' task text is communication, not trackable work", async () => {
    expect(await classify("wait in the kitchen for me.")).toBe(true);
  });

  it("'Tell Ghulam to wait by the car for me.' task text is communication, not trackable work", async () => {
    expect(await classify("wait by the car for me.")).toBe(true);
  });

  it("'Ask Grace to call me from the office.' task text is communication, not trackable work", async () => {
    expect(await classify("call me from the office.")).toBe(true);
  });

  it("'Tell Nasira to wait until 8.' task text is communication, not trackable work", async () => {
    expect(await classify("wait until 8.")).toBe(true);
  });

  it("'Ask Christopher to clean the kitchen.' remains tracked delegated work — a location word ('kitchen') alone must not trigger the communication classifier", async () => {
    expect(await classify("clean the kitchen.")).toBe(false);
  });

  // Confirmed production incident (2026-08-16): a real live journey ("Christopher,
  // come to the kitchen now.") created a real tracked task, confirmation link, and
  // Waiting item for a plain positional instruction with no owner-target marker.
  // This is the regression this rewrite fixes.
  it("'Christopher, come to the kitchen now.' task text is communication, not trackable work", async () => {
    expect(await classify("come to the kitchen now.")).toBe(true);
  });
});

// ── 2b. Grammatical form parity — the SAME task text must classify the SAME
//        way regardless of which surface form (vocative, Tell, Ask, Have,
//        Get, informational relay) delivered it. This is the direct proof
//        for the product rule: classification is keyed on whether Carson
//        must track an outcome after delivery, never on sentence shape.

describe("Grammatical form parity — surface form must never change the classification", () => {
  it.each([
    ["Christopher, come to the kitchen now.", "come to the kitchen now."],
    ["Christopher, wait downstairs.", "wait downstairs."],
    ["Tell Christopher to come upstairs.", "come upstairs."],
    ["Ask Christopher to meet me outside.", "meet me outside."],
    ["Let Christopher know dinner is at eight.", "dinner is at eight."],
    ["Tell Christopher I'm running late.", "i'm running late."],
    ["Tell Christopher to wait for me in the kitchen.", "wait for me in the kitchen."],
  ])("direct communication: %s -> task text %s classifies as communication", async (_phrase, taskText) => {
    expect(await classify(taskText)).toBe(true);
  });

  it.each([
    ["Christopher, clean the kitchen.", "clean the kitchen."],
    ["Ask Christopher to clean the kitchen.", "clean the kitchen."],
    ["Christopher, prepare dinner.", "prepare dinner."],
    ["Have Christopher buy milk.", "buy milk."],
    ["Ask Christopher to check whether the guest room is ready.", "check whether the guest room is ready."],
  ])("delegation: %s -> task text %s classifies as tracked delegated work", async (_phrase, taskText) => {
    expect(await classify(taskText)).toBe(false);
  });
});

// ── 3. Typed fast-path parsers — deterministic entry points for Type to Carson ──

describe("Type to Carson — fast-path routing", () => {
  const people = roster();

  it("'Tell Ghulam I'm on my way.' resolves as a direct message (currently correct, must stay unchanged)", () => {
    expect(parseSimpleDirectMessage("Tell Ghulam I'm on my way.", people)).toEqual({
      recipientName: "Ghulam",
      messageText: "I'm on my way.",
    });
  });

  it("'Tell Ghulam to wait for me.' resolves as a direct message", () => {
    const parsed = parseSimpleDirectMessage("Tell Ghulam to wait for me.", people);
    expect(parsed).not.toBeNull();
    expect(parsed?.recipientName).toBe("Ghulam");
  });

  it("C-02 (2026-09-05): 'Ask Grace to call me now.' is matched by the generic ask-X-to-Y delegation regex; its raw task text still classifies as communication-style, but the deterministic match itself is now the final word — Grace owes an action (the call), so this is tracked operational work and must not be downgraded", async () => {
    const parsed = parseDelegationFastPath("Ask Grace to call me now.", people);
    expect(parsed).toEqual({ personName: "Grace", taskText: "call me now." });
    // The classifier's own raw judgment on this text fragment is unchanged
    // (still "communication" — communication-vs-delegation.ts is untouched
    // by C-02). What changed is that sendDelegation no longer consults it
    // for a call that arrived via this deterministic match — see the
    // "Shared handler wiring" describe block below.
    expect(await classify(parsed!.taskText)).toBe(true);
  });

  it("'Ask Ghulam to bring the car out.' is matched by the delegation fast path and is not communication-style", async () => {
    const parsed = parseDelegationFastPath("Ask Ghulam to bring the car out.", people);
    expect(parsed).toEqual({ personName: "Ghulam", taskText: "bring the car out." });
    expect(await classify(parsed!.taskText)).toBe(false);
  });

  it("'Ask Ghulam to bring the car out and confirm when done.' remains tracked delegated work", async () => {
    const parsed = parseDelegationFastPath(
      "Ask Ghulam to bring the car out and confirm when done.",
      people,
    );
    expect(parsed).not.toBeNull();
    expect(await classify(parsed!.taskText)).toBe(false);
  });

  it("'Ask Christopher to make the pizza.' remains tracked delegated work (isCommunicationStyleTaskText correctly says no)", async () => {
    const parsed = parseDelegationFastPath("Ask Christopher to make the pizza.", people);
    expect(parsed).not.toBeNull();
    expect(await classify(parsed!.taskText)).toBe(false);
  });

  // KNOWN, PRE-EXISTING, SEPARATE GAP — not fixed by this suite. "Tell X to
  // make Y" (as opposed to "Ask X to make Y" above) loses to
  // parseSimpleDirectMessage first, because DELEGATION_BODY_START's verb
  // whitelist does not include "make" — see the it.fails documentation in
  // direct-message-fast-path.test.ts ("7. 'Tell Christopher to make
  // lunch.'"). This is a narrower, separate bug from the confirmed
  // call-me/contact-me/wait-for-me production regression this suite exists
  // to protect, and closing it safely needs its own scoped change (recorded
  // in RA7ETBAL_STATE.md) — not folded in here to keep this fix minimal.
  it.todo("'Tell Christopher to make the pizza.' should remain tracked delegated work — currently misroutes to a direct message (separate pre-existing gap, see direct-message-fast-path.test.ts)");
});

// ── 3b. C-02 (2026-09-05): deterministic-fast-path-matched work always
//        reaches the tracked-delegation lifecycle — the shared classifier
//        never gets a second, overriding vote once the grammar has already
//        recognized a person owing an action/result. Confirmed Production
//        regression: "Ask Christopher to bring the car around at 6." was
//        rerouted to a fire-and-forget WhatsApp message (task_id: null,
//        send_mode: "direct_message") instead of creating a tracked task.

describe("C-02 — tracked operational work is never downgraded once the deterministic fast path recognizes it", () => {
  const people = roster();

  it("TEST 1 — the exact Production canary: 'Ask Christopher to bring the car around at 6.' reaches sendDelegation marked as tracked work, bypassing the communication classifier", async () => {
    const sendDelegationFn = vi.fn().mockResolvedValue("Done. I asked Christopher to bring the car around at 6.");

    const result = await executeDelegationFastPath(
      "Ask Christopher to bring the car around at 6.",
      { people, userId: "user-1", displayName: "Sana" },
      { sendDelegationFn },
    );

    expect(result).toMatchObject({
      handled: true,
      status: "sent",
      personName: "Christopher",
      taskText: "bring the car around at 6.",
    });
    // The flag that makes sendDelegation skip isCommunicationStyleTaskText
    // entirely for this call (see ElevenLabsAgentWidget.tsx) — this is the
    // proof the tracked lifecycle is reached instead of the direct-message
    // reroute, independent of whatever the model-backed classifier would
    // have said about this exact task text.
    expect(sendDelegationFn).toHaveBeenCalledWith(
      { name: "Christopher", task: "bring the car around at 6." },
      { viaDeterministicFastPath: true },
    );
  });

  it("TEST 2 — equivalent tracked staff work: 'Ask Christopher to prepare dinner at 7.' also bypasses the classifier via the deterministic match", async () => {
    const sendDelegationFn = vi.fn().mockResolvedValue("Done. I asked Christopher to prepare dinner at 7.");

    const result = await executeDelegationFastPath(
      "Ask Christopher to prepare dinner at 7.",
      { people, userId: "user-1", displayName: "Sana" },
      { sendDelegationFn },
    );

    expect(result).toMatchObject({ handled: true, status: "sent", personName: "Christopher" });
    expect(sendDelegationFn).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ viaDeterministicFastPath: true }),
    );
  });

  it("TEST 3 — 'Ask Ghulam to bring the car out.' (pre-existing protected example) is unaffected — still reaches the tracked lifecycle the same way", async () => {
    const sendDelegationFn = vi.fn().mockResolvedValue("Done. I asked Ghulam to bring the car out.");

    const result = await executeDelegationFastPath(
      "Ask Ghulam to bring the car out.",
      { people, userId: "user-1", displayName: "Sana" },
      { sendDelegationFn },
    );

    expect(result).toMatchObject({ handled: true, status: "sent", personName: "Ghulam" });
    expect(sendDelegationFn).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ viaDeterministicFastPath: true }),
    );
  });

  it("TEST 4 — genuine direct communication is untouched: 'Tell Christopher I'll be home at 7.' never matches the deterministic delegation grammar, so it never reaches sendDelegation or the viaDeterministicFastPath flag at all", () => {
    expect(parseDelegationFastPath("Tell Christopher I'll be home at 7.", people)).toBeNull();
    // Falls to the direct-message fast path instead (parseSimpleDirectMessage),
    // which is unrelated to and unchanged by C-02.
    expect(parseSimpleDirectMessage("Tell Christopher I'll be home at 7.", people)).toEqual({
      recipientName: "Christopher",
      messageText: "I'll be home at 7.",
    });
  });

  it("TEST 5 — voice/text convergence: both executeInstruction's (Talk) and sendTypedMessage's (Type) delegation fast-path call sites inject the exact same sendDelegation, so this fix applies identically to both channels", () => {
    const occurrences = WIDGET_SOURCE.match(/\{\s*sendDelegationFn:\s*sendDelegation\s*\}/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });
});

// ── 4. Shared handler wiring — sendDelegation() is the one place both channels
//       converge, and it must reroute communication-style text before ever
//       creating a task. Structural checks on the real source, matching this
//       file's own established convention for testing a non-exported
//       in-component handler (see ElevenLabsAgentWidget.delegation-duplicate-guard.test.ts).

describe("Shared handler wiring — sendDelegation() reroutes communication-style text before creating a task", () => {
  it("checks isCommunicationStyleTaskText after resolving the person and phone, before the delegation cooldown/send", () => {
    // Anchored on "const person = matches[0];" (unique to sendDelegation),
    // not "if (!person.phone) {" — that exact string also appears in
    // sendFollowup earlier in the file, so indexOf would have matched there
    // first and captured a far wider span than sendDelegation alone.
    const block = blockBetween(
      "const person = matches[0];",
      "// 3. Cooldown.",
    );
    expect(block).toContain("isCommunicationStyleTaskText(taskText)");
    expect(block).toContain("createAndSendDirectMessage(");
  });

  it("the communication-guard block never calls createAndSendDelegation — no task is created for a reroute", () => {
    const block = blockBetween(
      "if (!internal?.viaDeterministicFastPath && await isCommunicationStyleTaskText(taskText)) {",
      "// 3. Cooldown.",
    );
    expect(block).not.toContain("createAndSendDelegation(");
  });

  it("C-02 (2026-09-05): a deterministic-fast-path-recognized delegation skips the communication classifier entirely — the guard is not merely bypassed at runtime, it is not even evaluated", () => {
    const block = blockBetween(
      "const person = matches[0];",
      "// 3. Cooldown.",
    );
    expect(block).toContain("!internal?.viaDeterministicFastPath && await isCommunicationStyleTaskText(taskText)");
  });

  it("imports the shared classifier from the shared module exactly once", () => {
    const importOccurrences =
      WIDGET_SOURCE.match(/from "\.\.\/\.\.\/lib\/communication-vs-delegation"/g) ?? [];
    expect(importOccurrences).toHaveLength(1);
  });

  // CodeRabbit finding, PR #398: viaDeterministicFastPath previously lived on
  // sendDelegation's first `params` argument — the same object type the
  // legacy send_delegation clientTool exposes to the model
  // (`Parameters<typeof sendDelegation>[0]`). A model-composed tool call
  // could in principle have included that field in its own JSON arguments
  // and bypassed the classifier for a non-deterministic call. Fixed by
  // moving it to a genuinely separate second function argument that no
  // client-tool JSON payload can ever populate.
  it("C-02 hardening: viaDeterministicFastPath cannot be supplied by a model tool call — it is a second function argument, not a params field", () => {
    const paramsBlock = blockBetween(
      "const sendDelegation = useCallback(\n    async (params: {",
      "    },\n    /**",
    );
    expect(paramsBlock).not.toContain("viaDeterministicFastPath");

    const signatureBlock = blockBetween(
      "const sendDelegation = useCallback(",
      "): Promise<string> => {",
    );
    expect(signatureBlock).toContain("internal?: { viaDeterministicFastPath?: boolean }");

    // The legacy clientTool passes exactly one argument — sendDelegation(params) —
    // so `internal` is always undefined there, regardless of what the model's
    // own tool-call JSON contains as `params`.
    const legacyToolBlock = blockBetween(
      "send_delegation: async (params: Parameters<typeof sendDelegation>[0]) => {",
      "const existing = canonicalConsequentialResultRef.current;",
    );
    expect(legacyToolBlock).toContain("sendDelegation(params)");
    expect(legacyToolBlock).not.toMatch(/sendDelegation\(params,/);
  });
});

// ── 5. Type and Talk parity — one shared sendDelegation function protects both ──

describe("Type and Talk parity", () => {
  it("there is exactly one sendDelegation implementation — Type and Talk cannot diverge", () => {
    const occurrences = WIDGET_SOURCE.match(/const sendDelegation = useCallback\(/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it("Talk to Carson's send_delegation clientTool calls the shared sendDelegation function", () => {
    const block = blockBetween("send_delegation: async (params", "create_reminder:");
    expect(block).toContain("sendDelegation(params)");
  });

  it("Type to Carson's delegation fast path (both call sites) injects the exact same sendDelegation function", () => {
    const occurrences = WIDGET_SOURCE.match(/\{\s*sendDelegationFn:\s*sendDelegation\s*\}/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });
});

// ── 6. Communication sends never carry a confirmation link ──────────────────

describe("Direct-message send path never generates a confirmation link", () => {
  it("createAndSendDirectMessage always sets confirmation_url / confirmationLink to null and never references the confirmation URL/route", () => {
    const source = readFileSync(join(__dirname, "direct-messages.ts"), "utf-8");
    expect(source).toContain("confirmation_url: null");
    expect(source).toContain("confirmationLink: null");
    expect(source).not.toContain("CANONICAL_CONFIRMATION_ORIGIN");
    expect(source).not.toMatch(/\/confirm\?task=/);
  });
});

// ── 7. Acknowledgement wording — communication reroute vs. real delegation ──
//       Production regression: after the reroute correctly stopped creating a
//       task/confirmation-link for plain staff communication ("Tell
//       Christopher to wait in the kitchen for me."), Carson still replied
//       "Christopher has it." — task-style wording for a plain message. Since
//       Type to Carson's typed fast path displays sendDelegation()'s returned
//       string verbatim (no LLM paraphrase — see executeDelegationFastPath's
//       `response` field), and Talk to Carson's voice model is explicitly
//       steered by CARSON_VOICE_SESSION_GUARD's example phrasing (both
//       channels call the one shared sendDelegation() — see "Type and Talk
//       parity" above), the fix touches only these two wording sources: the
//       reroute's successText string, and the guard's example phrases. No
//       classification, routing, WhatsApp delivery, task-creation, or
//       confirmation-link logic changed.

describe("Acknowledgement wording — communication reroute keeps message-style, real delegation keeps task-style", () => {
  it("the communication-reroute successText uses message-style wording ('I let X know'), never delegation-style ('has it')", () => {
    const block = blockBetween(
      "if (!internal?.viaDeterministicFastPath && await isCommunicationStyleTaskText(taskText)) {",
      "// 3. Cooldown.",
    );
    expect(block).toContain("const successText = `I sent ${person.name} the message.`;");
    expect(block).not.toMatch(/\$\{person\.name\}\s+has it/);
  });

  it("the real delegation successText remains task-style ('Done. I asked ... to ...'), unchanged by the wording fix", () => {
    const block = blockBetween("// 3. Cooldown.", "return successText;");
    expect(block).toContain("const successText = `Done. I asked ${person.name} to ${taskText}.`;");
  });

  it("CARSON_VOICE_SESSION_GUARD preserves the canonical returned wording for both real delegations and plain messages", async () => {
    const { CARSON_VOICE_SESSION_GUARD } = await import("./carson-status-policy");
    // The tool result already carries the approved task-style or message-style
    // wording. Voice must use that same canonical result instead of creating a
    // second paraphrase or adding a lifecycle promise the result did not make.
    expect(CARSON_VOICE_SESSION_GUARD).toContain(
      "speak the returned result text exactly, word-for-word",
    );
    expect(CARSON_VOICE_SESSION_GUARD).toContain(
      "If the result describes a plain message sent on the user's behalf, speak that returned delivery result exactly as well",
    );
    expect(CARSON_VOICE_SESSION_GUARD).toContain(
      "Never add reply-tracking or follow-up language unless the returned result itself says it is guaranteed",
    );
    expect(CARSON_VOICE_SESSION_GUARD).not.toContain(
      "[Name] has it. I'll follow up if they don't confirm.",
    );
  });
});

// ── 8. Typed direct-message dispatch — deterministic, not model-dependent ──
//       Production regression: "Tell Christopher to wait for me in the
//       kitchen" correctly matched parseSimpleDirectMessage (so it correctly
//       skipped the delegation fast path — "never reclassify a direct
//       message"), but nothing then deterministically sent it. It fell
//       through to conversation.sendUserMessage(), and the free-form
//       ElevenLabs model replied "Okay, I'm on it." without calling any
//       tool — confirmed via production Supabase evidence: no `messages`
//       row, no `tasks` row, for either of two identical test turns. The fix
//       dispatches deterministically through the same executeDirectMessageFastPath
//       already used inside executeInstruction's own model-driven tool
//       handler, before the free-form turn ever starts, so delivery can no
//       longer depend on the model's own tool-selection judgement.

describe("Typed direct-message dispatch — deterministic, before the free-form turn starts", () => {
  it("dispatches through executeDirectMessageFastPath when parseSimpleDirectMessage matches, before the delegation fast path", () => {
    const block = blockBetween(
      "const typedIsDirectMessage = Boolean(",
      "if (!typedHasPendingPhoto && !typedIsRecurring && !typedIsDirectMessage) {",
    );
    expect(block).toContain("if (typedDirectMessageParsed && !typedHasPendingPhoto && !typedIsRecurring) {");
    expect(block).toContain("await executeDirectMessageFastPath(");
    expect(block).toContain("normalizeOwnerReference: true");
  });

  it("the typed direct-message dispatch block never reaches conversation.sendUserMessage", () => {
    const block = blockBetween(
      "if (typedDirectMessageParsed && !typedHasPendingPhoto && !typedIsRecurring) {",
      "if (!typedHasPendingPhoto && !typedIsRecurring && !typedIsDirectMessage) {",
    );
    expect(block).not.toContain("conversation.sendUserMessage");
    expect(block).not.toContain("createAndSendDelegation(");
    expect(block).not.toContain("executeDelegationFastPath(");
  });

  it("persists Carson's reply and returns immediately when the dispatch is handled — the turn never falls through to ElevenLabs", () => {
    const block = blockBetween(
      "if (typedDirectMessageParsed && !typedHasPendingPhoto && !typedIsRecurring) {",
      "if (!typedHasPendingPhoto && !typedIsRecurring && !typedIsDirectMessage) {",
    );
    const handledIndex = block.indexOf("if (typedDirectMessageFastPath.handled) {");
    const replyIndex = block.indexOf("await persistLocalTypedAgentReply({", handledIndex);
    const contentIndex = block.indexOf("content: typedDirectMessageFastPath.response", replyIndex);
    const returnIndex = block.indexOf("return;", contentIndex);

    expect(handledIndex).toBeGreaterThan(-1);
    expect(replyIndex).toBeGreaterThan(handledIndex);
    expect(contentIndex).toBeGreaterThan(replyIndex);
    expect(returnIndex).toBeGreaterThan(contentIndex);
  });

  it("this new block is the only new occurrence — the existing delegation fast path's guard, comment marker, and exclusions are unchanged", () => {
    const occurrences = WIDGET_SOURCE.match(/Deterministic typed delegation fast path/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(WIDGET_SOURCE).toContain(
      "if (!typedHasPendingPhoto && !typedIsRecurring && !typedIsDirectMessage) {",
    );
  });

  it("real delegation ('Ask Christopher to clean the kitchen.') is not affected — parseSimpleDirectMessage does not match ask-phrasing", () => {
    const people = roster();
    expect(parseSimpleDirectMessage("Ask Christopher to clean the kitchen.", people)).toBeNull();
    const parsed = parseDelegationFastPath("Ask Christopher to clean the kitchen.", people);
    expect(parsed).toEqual({ personName: "Christopher", taskText: "clean the kitchen." });
  });

  it("executeDirectMessageFastPath's success wording is message-style ('I let X know'), matching the approved communication acknowledgement", () => {
    const source = readFileSync(join(__dirname, "direct-message-fast-path.ts"), "utf-8");
    expect(source).toContain("response: `I sent ${person.name} the message.`,");
    expect(source).not.toMatch(/response:\s*`\$\{person\.name\}\s+has it/);
  });

  // CodeRabbit finding on PR #53: executeDirectMessageFastPath has no
  // recent-send protection of its own, and this dispatch is now
  // deterministic (not model-dependent), so an identical resubmission —
  // exactly what happened in the confirmed production test (the same
  // phrase submitted twice, ~70s apart) — would otherwise reliably
  // double-send. Guarded at this call site by reusing the same
  // recentDirectWhatsappMessagesRef mechanism sendDelegation()'s own
  // communication reroute already uses, before executeDirectMessageFastPath
  // is ever called.
  it("checks for a recent duplicate before calling executeDirectMessageFastPath, and records a send only after it actually succeeds", () => {
    const block = blockBetween(
      "if (typedDirectMessageParsed && !typedHasPendingPhoto && !typedIsRecurring) {",
      "if (!typedHasPendingPhoto && !typedIsRecurring && !typedIsDirectMessage) {",
    );
    const duplicateCheckIndex = block.indexOf("isRecentDirectWhatsappDuplicate(");
    const executorIndex = block.indexOf("await executeDirectMessageFastPath(");
    const recordIndex = block.indexOf("recordDirectWhatsappSent(", executorIndex);

    expect(duplicateCheckIndex).toBeGreaterThan(-1);
    expect(duplicateCheckIndex).toBeLessThan(executorIndex);
    expect(block).toContain("recentDirectWhatsappMessagesRef.current");
    expect(recordIndex).toBeGreaterThan(executorIndex);
    // Recording is gated on an actual successful send, not merely "handled"
    // (which also covers blocked/failed outcomes).
    expect(block).toContain('typedDirectMessageFastPath.status === "sent"');
  });

  // Locks the same guarantee "Shared handler wiring" already proves for
  // sendDelegation()'s communication reroute (never calls
  // createAndSendDelegation) onto this newer, second dispatcher. Both
  // sendTypedMessage's deterministic typed dispatch and executeInstruction's
  // model-driven call site share this one module — if a future refactor ever
  // pulled task/delegation creation into it, plain staff communication would
  // silently start creating tracked tasks. Source-level, not just
  // call-site-level, so it can never be bypassed by adding a third caller.
  it("direct-message-fast-path.ts never imports or references task/delegation creation — a future refactor cannot silently merge the two paths", () => {
    const source = readFileSync(join(__dirname, "direct-message-fast-path.ts"), "utf-8");
    // Symbol-name check is quote/aliasing-agnostic by construction — an
    // import alias ("createTask as ct") still contains the literal exported
    // name at the import site, so this catches it regardless of what it's
    // renamed to locally.
    expect(source).not.toMatch(/createAndSendDelegation|createDelegationTaskAndMessage|\bcreateTask\b/);
    // Import-path check, tolerant of single/double quotes and both static
    // and dynamic import syntax — not just one literal quote style.
    expect(source).not.toMatch(/(?:from\s+|import\(\s*)['"]\.\/(?:delegations|tasks)['"]/);
  });
});

// ── 9. Owner-reference normalization — applies at the shared delivery
//       boundary, regardless of Talk or Type. Confirmed production
//       regression: "Ask Grace to call me now." was correctly classified as
//       communication (section 2 above), correctly created no task and no
//       confirmation link (section 6), but the plain message itself still
//       shipped to Grace as the literal text "call me now" — "me" read as
//       Grace herself, not Sana. Section 4 above already proves
//       sendDelegation()'s communication reroute calls
//       createAndSendDirectMessage(); Talk's send_direct_whatsapp_message
//       tool and Type's executeDirectMessageFastPath call the same
//       function. None of the three pass a channel of any kind into it —
//       normalizing once, inside createDirectMessageRecord (see
//       direct-messages.ts), is therefore the one shared boundary that
//       fixes this identically for Talk and Type, by construction, without
//       touching classification, task creation, confirmation links, or
//       delivery transport at all.
//
//       This supersedes the previous assumption (see the now-corrected
//       "typed-only" tests in ElevenLabsAgentWidget.direct-message-parity.test.ts)
//       that Talk to Carson's own voice-composed text never needed this
//       step — production evidence proved the model does not reliably
//       self-normalize object-pronoun phrasing like "call me now".

describe("Owner-reference normalization at the shared direct-message delivery boundary", () => {
  it("the exact confirmed-regression phrase is normalized before the message row is created", async () => {
    const createMessageFn = vi.fn(async (draft: any) => ({ id: "message-1", ...draft }));
    await createDirectMessageRecord({
      source: "send_delegation_communication_reroute",
      userId: "user-1",
      recipient: "Grace",
      messageText: "call me now.",
      ownerName: "Sana",
      createMessageFn,
    });
    expect(createMessageFn).toHaveBeenCalledWith(
      expect.objectContaining({ content: "call Sana now." }),
    );
  });

  it("'Tell Ghulam to wait for me.' is normalized the same way", async () => {
    const createMessageFn = vi.fn(async (draft: any) => ({ id: "message-1", ...draft }));
    await createDirectMessageRecord({
      source: "send_delegation_communication_reroute",
      userId: "user-1",
      recipient: "Ghulam",
      messageText: "wait for me.",
      ownerName: "Sana",
      createMessageFn,
    });
    expect(createMessageFn).toHaveBeenCalledWith(
      expect.objectContaining({ content: "wait for Sana." }),
    );
  });

  it("real delegation task text ('bring the car out.') is never touched by this normalization — it has no owner-relative wording to begin with", async () => {
    const createMessageFn = vi.fn(async (draft: any) => ({ id: "message-1", ...draft }));
    await createDirectMessageRecord({
      source: "send_delegation_communication_reroute",
      userId: "user-1",
      recipient: "Ghulam",
      messageText: "bring the car out.",
      ownerName: "Sana",
      createMessageFn,
    });
    expect(createMessageFn).toHaveBeenCalledWith(
      expect.objectContaining({ content: "bring the car out." }),
    );
  });

  it("still creates no task and no confirmation link — classification and task creation are untouched by this fix", async () => {
    const createMessageFn = vi.fn(async (draft: any) => ({ id: "message-1", ...draft }));
    const message = await createDirectMessageRecord({
      source: "send_delegation_communication_reroute",
      userId: "user-1",
      recipient: "Grace",
      messageText: "call me now.",
      ownerName: "Sana",
      createMessageFn,
    });
    expect(createMessageFn).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: null, confirmation_url: null }),
    );
    expect(message.task_id).toBeNull();
    expect(message.confirmation_url).toBeNull();
  });

  it("Talk and Type parity: createAndSendDirectMessage takes no channel parameter, so normalization cannot differ by channel", async () => {
    const source = readFileSync(join(__dirname, "direct-messages.ts"), "utf-8");
    expect(source).not.toMatch(/\bchannel\b/i);

    // Two independent calls, exactly like Talk's send_direct_whatsapp_message
    // tool and Type's executeDirectMessageFastPath would each make — same
    // result either way, since there is nothing here for a channel to gate.
    const createMessageFnA = vi.fn(async (draft: any) => ({ id: "message-1", ...draft }));
    const createMessageFnB = vi.fn(async (draft: any) => ({ id: "message-2", ...draft }));

    await createAndSendDirectMessage({
      source: "send_direct_whatsapp_message",
      userId: "user-1",
      recipient: "Grace",
      messageText: "call me now.",
      phone: "+971500000001",
      ownerName: "Sana",
      createMessageFn: createMessageFnA,
      deliverTaskMessageFn: vi.fn(async () => ({ success: true, channel: "whatsapp" as const })),
    });
    await createAndSendDirectMessage({
      source: "direct-message-fast-path",
      userId: "user-1",
      recipient: "Grace",
      messageText: "call me now.",
      phone: "+971500000001",
      ownerName: "Sana",
      createMessageFn: createMessageFnB,
      deliverTaskMessageFn: vi.fn(async () => ({ success: true, channel: "whatsapp" as const })),
    });

    expect(createMessageFnA).toHaveBeenCalledWith(expect.objectContaining({ content: "call Sana now." }));
    expect(createMessageFnB).toHaveBeenCalledWith(expect.objectContaining({ content: "call Sana now." }));
  });
});
