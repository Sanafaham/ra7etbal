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
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// direct-message-fast-path.ts transitively imports ./messages -> ./supabase,
// which throws outside a real browser env (missing VITE_SUPABASE_* vars).
// Same mock as direct-message-fast-path.test.ts — nothing here calls it.
vi.mock("./messages", () => ({ createMessage: vi.fn() }));

import { isCommunicationStyleTaskText } from "./communication-vs-delegation";
import { parseDelegationFastPath } from "./delegation-fast-path";
import { parseSimpleDirectMessage } from "./direct-message-fast-path";
import type { Person } from "../types/person";

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
  ])("%s -> communication (does not create a tracked task)", (text) => {
    expect(isCommunicationStyleTaskText(text)).toBe(true);
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
  ])("%s -> tracked delegated work (%s)", (text) => {
    expect(isCommunicationStyleTaskText(text)).toBe(false);
  });
});

// ── 2. Confirmed production regressions — exact evidence, permanently locked ──

describe("Regression: confirmed production evidence must never reproduce", () => {
  it("'Ask Grace to call me now.' task text is communication, not trackable work", () => {
    expect(isCommunicationStyleTaskText("call me now.")).toBe(true);
  });

  it("'Ask Suresh to call me.' task text is communication, not trackable work", () => {
    expect(isCommunicationStyleTaskText("call me.")).toBe(true);
  });

  it("'Tell Ghulam to wait for me.' task text is communication, not trackable work", () => {
    expect(isCommunicationStyleTaskText("wait for me.")).toBe(true);
  });

  it("'Ask Ghulam to bring the car out.' remains tracked delegated work (must not change)", () => {
    expect(isCommunicationStyleTaskText("bring the car out.")).toBe(false);
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

  it("'Ask Grace to call me now.' is matched by the generic ask-X-to-Y delegation regex, but its task text is communication-style — interception happens in the shared sendDelegation handler, not by narrowing this regex, so both channels are protected by one guard", () => {
    const parsed = parseDelegationFastPath("Ask Grace to call me now.", people);
    expect(parsed).toEqual({ personName: "Grace", taskText: "call me now." });
    expect(isCommunicationStyleTaskText(parsed!.taskText)).toBe(true);
  });

  it("'Ask Ghulam to bring the car out.' is matched by the delegation fast path and is not communication-style", () => {
    const parsed = parseDelegationFastPath("Ask Ghulam to bring the car out.", people);
    expect(parsed).toEqual({ personName: "Ghulam", taskText: "bring the car out." });
    expect(isCommunicationStyleTaskText(parsed!.taskText)).toBe(false);
  });

  it("'Ask Ghulam to bring the car out and confirm when done.' remains tracked delegated work", () => {
    const parsed = parseDelegationFastPath(
      "Ask Ghulam to bring the car out and confirm when done.",
      people,
    );
    expect(parsed).not.toBeNull();
    expect(isCommunicationStyleTaskText(parsed!.taskText)).toBe(false);
  });

  it("'Ask Christopher to make the pizza.' remains tracked delegated work (isCommunicationStyleTaskText correctly says no)", () => {
    const parsed = parseDelegationFastPath("Ask Christopher to make the pizza.", people);
    expect(parsed).not.toBeNull();
    expect(isCommunicationStyleTaskText(parsed!.taskText)).toBe(false);
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

// ── 4. Shared handler wiring — sendDelegation() is the one place both channels
//       converge, and it must reroute communication-style text before ever
//       creating a task. Structural checks on the real source, matching this
//       file's own established convention for testing a non-exported
//       in-component handler (see ElevenLabsAgentWidget.delegation-duplicate-guard.test.ts).

describe("Shared handler wiring — sendDelegation() reroutes communication-style text before creating a task", () => {
  it("checks isCommunicationStyleTaskText after resolving the person and phone, before the delegation cooldown/send", () => {
    const block = blockBetween(
      "if (!person.phone) {",
      "// 3. Cooldown.",
    );
    expect(block).toContain("isCommunicationStyleTaskText(taskText)");
    expect(block).toContain("createAndSendDirectMessage(");
  });

  it("the communication-guard block never calls createAndSendDelegation — no task is created for a reroute", () => {
    const block = blockBetween(
      "if (isCommunicationStyleTaskText(taskText)) {",
      "// 3. Cooldown.",
    );
    expect(block).not.toContain("createAndSendDelegation(");
  });

  it("imports the shared classifier from the shared module exactly once", () => {
    const importOccurrences =
      WIDGET_SOURCE.match(/from "\.\.\/\.\.\/lib\/communication-vs-delegation"/g) ?? [];
    expect(importOccurrences).toHaveLength(1);
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
