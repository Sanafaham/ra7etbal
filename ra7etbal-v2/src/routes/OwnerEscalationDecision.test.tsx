/**
 * Tests OwnerEscalationDecisionView directly — a pure, hook-free component,
 * so renderToStaticMarkup is enough to verify rendered output without any
 * DOM/testing-library dependency, matching StaffUpdates.test.tsx's
 * existing convention. Interaction (clicking buttons, typing) is not
 * exercised here — see api/task-confirm.test.js for the server-side
 * behavior these buttons ultimately call into, and
 * src/lib/escalation-answer.test.ts for the client wrapper itself.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { OwnerEscalationDetail } from "../types/staff-message";
import type { OwnerEscalationDecisionViewProps } from "./OwnerEscalationDecision";

// See ConfirmRouter.test.tsx for why this stub is needed on import.
vi.mock("../lib/supabase", () => ({ supabase: {} }));

const { OwnerEscalationDecisionView } = await import("./OwnerEscalationDecision");

const NOW = new Date("2026-07-27T01:00:00.000Z");

function baseDetail(overrides: Partial<OwnerEscalationDetail> = {}): OwnerEscalationDetail {
  return {
    id: "decision-1",
    status: "open",
    createdAt: "2026-07-27T00:33:32.000Z",
    alreadyAnswered: false,
    staffName: "Christopher",
    inboundText: "Can I buy red wine vinegar instead?",
    escalationReason: "Needs approval for the substitution.",
    receivedAt: "2026-07-27T00:33:23.000Z",
    ...overrides,
  };
}

function baseProps(overrides: Partial<OwnerEscalationDecisionViewProps> = {}): OwnerEscalationDecisionViewProps {
  return {
    authStatus: "signed_in",
    loadState: "ready",
    loadError: null,
    detail: baseDetail(),
    now: NOW,
    submitPhase: "idle",
    pendingDecision: null,
    customText: "",
    submitError: null,
    deliverySentUnconfirmed: false,
    onSelectDecision: () => {},
    onCustomTextChange: () => {},
    onContinueCustom: () => {},
    onCancel: () => {},
    onConfirmSend: () => {},
    onRetryDelivery: () => {},
    ...overrides,
  };
}

function render(overrides: Partial<OwnerEscalationDecisionViewProps> = {}): string {
  return renderToStaticMarkup(<OwnerEscalationDecisionView {...baseProps(overrides)} />);
}

describe("OwnerEscalationDecisionView — load/auth states", () => {
  it("shows a sign-in prompt, not the escalation, when signed out", () => {
    const html = render({ authStatus: "signed_out", loadState: "idle", detail: null });
    expect(html).toContain("Sign in as the household owner");
    expect(html).not.toContain("Decision needed");
  });

  it("shows a loading state while auth is still resolving", () => {
    const html = render({ authStatus: "loading", loadState: "idle", detail: null });
    expect(html).not.toContain("Sign in as the household owner");
    expect(html).not.toContain("Decision needed");
  });

  it("9. shows a safe not-found state for an invalid token, without any private data", () => {
    const html = render({ loadState: "not_found", detail: null });
    expect(html).toContain("This link is invalid, expired, or not associated with your account.");
    expect(html).not.toContain("Christopher");
  });

  it("shows a truthful error state distinct from not-found", () => {
    const html = render({ loadState: "error", loadError: "Network issue. Please check your connection.", detail: null });
    expect(html).toContain("Network issue. Please check your connection.");
  });
});

describe("OwnerEscalationDecisionView — open-state copy and decision controls", () => {
  it("1. an open decision shows the exact open-state copy and staff request", () => {
    const html = render();
    expect(html).toContain("Status: Needs You — awaiting your decision.");
    expect(html).toContain("Christopher");
    expect(html).toContain("Needs approval for the substitution.");
    expect(html).toContain("Can I buy red wine vinegar instead?");
  });

  it("shows Approve, Reject, and Custom instruction controls for an open, idle escalation", () => {
    const html = render();
    expect(html).toContain(">Approve<");
    expect(html).toContain(">Reject<");
    expect(html).toContain(">Custom instruction<");
  });

  it("does not show decision controls once the escalation is no longer open", () => {
    const html = render({ detail: baseDetail({ status: "delivered_to_staff", alreadyAnswered: true }) });
    expect(html).not.toContain(">Approve<");
    expect(html).not.toContain(">Reject<");
    expect(html).not.toContain(">Custom instruction<");
  });

  it("custom_editing phase shows a textarea and a disabled Continue button until text is entered", () => {
    const emptyHtml = render({ submitPhase: "custom_editing", pendingDecision: "custom_instruction", customText: "" });
    expect(emptyHtml).toContain("<textarea");
    expect(emptyHtml).toMatch(/<button[^>]*\sdisabled(=|\s|>)[^>]*>Continue/);

    const filledHtml = render({ submitPhase: "custom_editing", pendingDecision: "custom_instruction", customText: "Ask Christopher to wait." });
    expect(filledHtml).not.toMatch(/<button[^>]*\sdisabled(=|\s|>)[^>]*>Continue/);
  });

  it("confirming phase for Approve shows an escalation-specific preview built from the actual staff name and request — never a fixed string", () => {
    const html = render({ submitPhase: "confirming", pendingDecision: "approved" });
    expect(html).toContain("Send this to Christopher?");
    expect(html).toContain("Christopher, this was approved:");
    expect(html).toContain("Can I buy red wine vinegar instead?");
    expect(html).toContain("please go ahead.");
    expect(html).toContain(">Send<");
    expect(html).toContain(">Cancel<");
  });

  it("confirming phase for Reject shows the correct escalation-specific rejection preview, distinct from Approve", () => {
    const html = render({ submitPhase: "confirming", pendingDecision: "rejected" });
    expect(html).toContain("Christopher, this was not approved:");
    expect(html).toContain("Can I buy red wine vinegar instead?");
    expect(html).toContain("please hold off for now.");
  });

  it("CRITICAL: an unrelated escalation's Approve/Reject preview reflects that escalation, never another escalation's wording", () => {
    const unrelatedDetail = baseDetail({ staffName: "Ghulam", inboundText: "Should I pick up dry cleaning today or tomorrow?" });
    const approveHtml = render({ detail: unrelatedDetail, submitPhase: "confirming", pendingDecision: "approved" });
    expect(approveHtml).toContain("Ghulam, this was approved:");
    expect(approveHtml).toContain("Should I pick up dry cleaning today or tomorrow?");
    expect(approveHtml).not.toMatch(/vinegar/i);
    expect(approveHtml).not.toContain("Christopher");
  });

  it("confirming phase for Custom instruction shows the owner's own typed text, quoted, not a built sentence", () => {
    const html = render({ submitPhase: "confirming", pendingDecision: "custom_instruction", customText: "Please wait until Friday." });
    expect(html).toContain("Please wait until Friday.");
    expect(html).not.toContain("this was approved");
    expect(html).not.toContain("this was not approved");
  });

  it("sending phase shows a truthful in-progress state, never 'Sent'", () => {
    const html = render({ submitPhase: "sending" });
    expect(html).toContain("Sending to Christopher…");
    expect(html).not.toMatch(/\bSent\b/);
  });

  it("a submitError is shown above the controls without losing the read-only card", () => {
    const html = render({ submitError: "Could not send the message. Please retry." });
    expect(html).toContain("Could not send the message. Please retry.");
    expect(html).toContain("Christopher");
  });
});

describe("OwnerEscalationDecisionView — answered/delivering state (5)", () => {
  it("2 & 3. an answered-but-not-yet-delivered decision shows a distinct, truthful pending state — not the open-state copy, not 'already responded'", () => {
    const html = render({ detail: baseDetail({ status: "answered", alreadyAnswered: true }) });
    expect(html).toContain("Your answer is saved. Sending to Christopher…");
    expect(html).not.toContain("Status: Needs You — awaiting your decision.");
    expect(html).not.toContain("You already responded to this request.");
    expect(html).not.toContain(">Approve<");
  });

  it("a delivering decision shows the same truthful pending state as answered", () => {
    const html = render({ detail: baseDetail({ status: "delivering", alreadyAnswered: true }) });
    expect(html).toContain("Your answer is saved. Sending to Christopher…");
  });
});

describe("OwnerEscalationDecisionView — failed delivery stays visible and retryable (14, 15)", () => {
  it("a failed delivery shows a truthful failure notice and a Retry action, never silently disappears", () => {
    const html = render({ detail: baseDetail({ status: "failed", alreadyAnswered: true }) });
    expect(html).toContain("Your answer was saved, but Christopher");
    expect(html).toContain("been notified yet.");
    expect(html).toContain("safely try again");
    expect(html).toContain(">Retry<");
    expect(html).not.toContain(">Approve<");
  });

  it("retrying (sending phase on a failed escalation) shows the truthful in-progress state, not the retry button", () => {
    const html = render({ detail: baseDetail({ status: "failed", alreadyAnswered: true }), submitPhase: "sending" });
    expect(html).toContain("Sending to Christopher…");
    expect(html).not.toContain(">Retry<");
  });
});

describe("OwnerEscalationDecisionView — delivered (already-answered) truthfulness", () => {
  it("truthfully shows an already-answered/delivered state, distinct from every other state", () => {
    const html = render({ detail: baseDetail({ status: "delivered_to_staff", alreadyAnswered: true }) });
    expect(html).toContain("You already responded to this request.");
    expect(html).not.toContain("awaiting your decision");
    expect(html).not.toContain("Sending to Christopher");
    expect(html).not.toContain("hasn't been notified yet");
  });

  it("a bookkeeping-failure-after-Meta-acceptance banner is shown distinctly and never claims failure", () => {
    const html = render({ deliverySentUnconfirmed: true, detail: baseDetail({ status: "answered", alreadyAnswered: true }) });
    expect(html).toContain("Your answer was sent to Christopher, but we couldn");
    expect(html).toContain("confirm it in our records");
    expect(html).not.toContain("been notified yet");
  });
});

describe("OwnerEscalationDecisionView — read-only for every state except open (5, 11)", () => {
  it("11. renders no form and no submit-input element in any state — this file never itself POSTs; it only calls the same PATCH the button handlers are responsible for", () => {
    const states: Array<Partial<OwnerEscalationDecisionViewProps>> = [
      { authStatus: "signed_out", loadState: "idle", detail: null },
      { authStatus: "loading", loadState: "idle", detail: null },
      { loadState: "not_found", detail: null },
      { loadState: "error", loadError: "Network issue.", detail: null },
      { detail: baseDetail() },
      { detail: baseDetail({ status: "answered", alreadyAnswered: true }) },
      { detail: baseDetail({ status: "failed", alreadyAnswered: true }) },
      { detail: baseDetail({ status: "delivered_to_staff", alreadyAnswered: true }) },
    ];
    for (const overrides of states) {
      const html = render(overrides);
      expect(html).not.toContain("<form");
      expect(html).not.toMatch(/answer_escalation_owner_decision/i);
    }
  });

  it("never tells the owner to bypass Carson in any reachable state — no instruction to reply, contact, message, text, call, or WhatsApp Christopher or staff directly, manually, or outside Carson", () => {
    const openDetail = baseDetail();
    const answeredDetail = baseDetail({ status: "answered", alreadyAnswered: true });
    for (const detail of [openDetail, answeredDetail]) {
      const html = render({ detail });
      const appCopy = appAuthoredCopy(html, detail);
      expectNoCarsonBypassCopy(appCopy);
    }
  });

  it("the bypass-copy guard does not false-positive on the staff member's own quoted request text", () => {
    const detail = baseDetail({
      inboundText: "Should I call the plumber directly, or message him myself?",
      escalationReason: "Christopher wants to contact the plumber outside of Carson.",
    });
    const html = render({ detail });
    expect(html).toContain("Should I call the plumber directly, or message him myself?");
    expectNoCarsonBypassCopy(appAuthoredCopy(html, detail));
  });
});

/**
 * Same stripping approach as the earlier bypass-copy regression (PR #91) —
 * see that helper's original doc comment for why matching must exclude the
 * staff member's own quoted words.
 */
function appAuthoredCopy(html: string, detail: OwnerEscalationDetail): string {
  let stripped = html;
  if (detail.escalationReason) stripped = stripped.split(detail.escalationReason).join("");
  stripped = stripped.split(detail.inboundText).join("");
  return stripped;
}

function expectNoCarsonBypassCopy(appCopy: string) {
  expect(appCopy).not.toMatch(/\b(reply|message|text|contact|call|whatsapp)\b[^.]*\bdirectly\b/i);
  expect(appCopy).not.toMatch(/\b(reply to|message|text|contact|call|whatsapp)\s+christopher\b/i);
  expect(appCopy).not.toMatch(/\b(reply|message|text|contact|call|whatsapp)\b[^.]*\bstaff( member)?\b/i);
  expect(appCopy).not.toMatch(/\boutside\s+carson\b/i);
  expect(appCopy).not.toMatch(/\bmanually\b/i);
}
