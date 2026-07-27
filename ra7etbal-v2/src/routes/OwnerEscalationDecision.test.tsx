/**
 * Tests OwnerEscalationDecisionView directly — a pure, hook-free component,
 * so renderToStaticMarkup is enough to verify rendered output without any
 * DOM/testing-library dependency, matching StaffUpdates.test.tsx's
 * existing convention.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { OwnerEscalationDetail } from "../types/staff-message";

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

/**
 * The Carson-bypass regression below must never false-positive on the
 * staff member's own words (detail.inboundText / detail.escalationReason
 * are free text from a real WhatsApp message and can legitimately contain
 * words like "call" or "contact" as part of the request itself — e.g. "Can
 * I call the plumber?"). Stripping that quoted content before matching
 * means the forbidden-pattern check only ever applies to this app's own
 * copy, never to what a staff member happened to write.
 */
function appAuthoredCopy(html: string, detail: OwnerEscalationDetail): string {
  let stripped = html;
  if (detail.escalationReason) stripped = stripped.split(detail.escalationReason).join("");
  stripped = stripped.split(detail.inboundText).join("");
  return stripped;
}

/**
 * Every wording a bypass-copy regression could take: an instruction verb
 * (reply/message/text/contact/call/WhatsApp) paired with "directly", the
 * staff member's name, or "staff"/"staff member"; plus the standalone
 * "outside Carson" / "manually" framings. Matched against appAuthoredCopy
 * only — see that helper's doc comment for why.
 */
function expectNoCarsonBypassCopy(appCopy: string) {
  expect(appCopy).not.toMatch(/\b(reply|message|text|contact|call|whatsapp)\b[^.]*\bdirectly\b/i);
  expect(appCopy).not.toMatch(/\b(reply to|message|text|contact|call|whatsapp)\s+christopher\b/i);
  expect(appCopy).not.toMatch(/\b(reply|message|text|contact|call|whatsapp)\b[^.]*\bstaff( member)?\b/i);
  expect(appCopy).not.toMatch(/\boutside\s+carson\b/i);
  expect(appCopy).not.toMatch(/\bmanually\b/i);
}

describe("OwnerEscalationDecisionView", () => {
  it("shows a sign-in prompt, not the escalation, when signed out", () => {
    const html = renderToStaticMarkup(
      <OwnerEscalationDecisionView authStatus="signed_out" loadState="idle" loadError={null} detail={null} now={NOW} />,
    );
    expect(html).toContain("Sign in as the household owner");
    expect(html).not.toContain("Decision needed");
  });

  it("shows a loading state while auth is still resolving", () => {
    const html = renderToStaticMarkup(
      <OwnerEscalationDecisionView authStatus="loading" loadState="idle" loadError={null} detail={null} now={NOW} />,
    );
    expect(html).not.toContain("Sign in as the household owner");
    expect(html).not.toContain("Decision needed");
  });

  it("9. shows a safe not-found state for an invalid token, without any private data", () => {
    const html = renderToStaticMarkup(
      <OwnerEscalationDecisionView authStatus="signed_in" loadState="not_found" loadError={null} detail={null} now={NOW} />,
    );
    expect(html).toContain("This link is invalid, expired, or not associated with your account.");
    expect(html).not.toContain("Christopher");
  });

  it("shows a truthful error state distinct from not-found", () => {
    const html = renderToStaticMarkup(
      <OwnerEscalationDecisionView authStatus="signed_in" loadState="error" loadError="Network issue. Please check your connection." detail={null} now={NOW} />,
    );
    expect(html).toContain("Network issue. Please check your connection.");
  });

  it("7. a valid, open escalation shows staff member, request, and decision reason", () => {
    const html = renderToStaticMarkup(
      <OwnerEscalationDecisionView authStatus="signed_in" loadState="ready" loadError={null} detail={baseDetail()} now={NOW} />,
    );
    expect(html).toContain("Christopher");
    expect(html).toContain("Needs approval for the substitution.");
    expect(html).toContain("Can I buy red wine vinegar instead?");
    expect(html).toContain("Needs You");
  });

  it("1. an open decision shows the exact open-state copy", () => {
    const html = renderToStaticMarkup(
      <OwnerEscalationDecisionView authStatus="signed_in" loadState="ready" loadError={null} detail={baseDetail()} now={NOW} />,
    );
    expect(html).toContain("Decision controls are coming next.");
    expect(html).toContain("This request will remain in Needs You until you respond through Carson.");
    expect(html).toContain("Status: Needs You — awaiting your decision.");
  });

  it("2. an answered decision does not show the open-state copy (fixed: the footer used to render unconditionally, claiming the request was still pending even after the owner had already responded)", () => {
    const html = renderToStaticMarkup(
      <OwnerEscalationDecisionView
        authStatus="signed_in"
        loadState="ready"
        loadError={null}
        detail={baseDetail({ alreadyAnswered: true, status: "answered" })}
        now={NOW}
      />,
    );
    expect(html).not.toContain("Decision controls are coming next.");
    expect(html).not.toContain("This request will remain in Needs You until you respond through Carson.");
  });

  it("3. an answered decision shows truthful already-responded copy, distinct from the open state, and never exposes owner_reply_text", () => {
    const html = renderToStaticMarkup(
      <OwnerEscalationDecisionView
        authStatus="signed_in"
        loadState="ready"
        loadError={null}
        detail={baseDetail({ alreadyAnswered: true, status: "answered" })}
        now={NOW}
      />,
    );
    expect(html).toContain("You already responded to this request.");
    expect(html).not.toContain("awaiting your decision");
    // OwnerEscalationDetail has no owner_reply_text field at all — this is
    // a structural guarantee, not just a rendering choice; see
    // src/types/staff-message.ts.
  });

  it("4. an invalid, not-found, or errored lookup shows neither the open-state nor the already-responded copy", () => {
    const notFoundHtml = renderToStaticMarkup(
      <OwnerEscalationDecisionView authStatus="signed_in" loadState="not_found" loadError={null} detail={null} now={NOW} />,
    );
    const errorHtml = renderToStaticMarkup(
      <OwnerEscalationDecisionView authStatus="signed_in" loadState="error" loadError="Network issue. Please check your connection." detail={null} now={NOW} />,
    );
    for (const html of [notFoundHtml, errorHtml]) {
      expect(html).not.toContain("Decision controls are coming next.");
      expect(html).not.toContain("This request will remain in Needs You until you respond through Carson.");
      expect(html).not.toContain("You already responded to this request.");
    }
  });

  it("5. the page renders no form, button, or decision control in any state — read-only throughout", () => {
    const states: Array<[string, ReturnType<typeof renderToStaticMarkup>]> = [
      ["signed_out", renderToStaticMarkup(<OwnerEscalationDecisionView authStatus="signed_out" loadState="idle" loadError={null} detail={null} now={NOW} />)],
      ["loading", renderToStaticMarkup(<OwnerEscalationDecisionView authStatus="loading" loadState="idle" loadError={null} detail={null} now={NOW} />)],
      ["not_found", renderToStaticMarkup(<OwnerEscalationDecisionView authStatus="signed_in" loadState="not_found" loadError={null} detail={null} now={NOW} />)],
      ["error", renderToStaticMarkup(<OwnerEscalationDecisionView authStatus="signed_in" loadState="error" loadError="Network issue." detail={null} now={NOW} />)],
      ["ready-open", renderToStaticMarkup(<OwnerEscalationDecisionView authStatus="signed_in" loadState="ready" loadError={null} detail={baseDetail()} now={NOW} />)],
      ["ready-answered", renderToStaticMarkup(<OwnerEscalationDecisionView authStatus="signed_in" loadState="ready" loadError={null} detail={baseDetail({ alreadyAnswered: true, status: "answered" })} now={NOW} />)],
    ];
    for (const [, html] of states) {
      expect(html).not.toContain("<form");
      expect(html).not.toMatch(/<button/i);
      expect(html).not.toMatch(/<input/i);
      expect(html).not.toMatch(/approve|reject|answer_escalation_owner_decision/i);
    }
  });

  it("11. renders no form, no interactive decision button, no answer/approve/reject control — read-only for this Phase C slice", () => {
    const html = renderToStaticMarkup(
      <OwnerEscalationDecisionView authStatus="signed_in" loadState="ready" loadError={null} detail={baseDetail()} now={NOW} />,
    );
    expect(html).not.toContain("<form");
    expect(html).not.toMatch(/<button/i);
    expect(html).not.toMatch(/approve|reject|answer_escalation_owner_decision/i);
    expect(html).toContain("Decision controls are coming next.");
    expect(html).toContain("This request will remain in Needs You until you respond through Carson.");
  });

  it("never tells the owner to bypass Carson in any reachable state — no instruction to reply, contact, message, text, call, or WhatsApp Christopher or staff directly, manually, or outside Carson (fixed: copy contradicted the Carson-owns-the-loop operating model; broadened per independent review to cover every equivalent manual-contact phrasing, not just 'directly')", () => {
    const openDetail = baseDetail();
    const answeredDetail = baseDetail({ alreadyAnswered: true, status: "answered" });
    const openHtml = renderToStaticMarkup(
      <OwnerEscalationDecisionView authStatus="signed_in" loadState="ready" loadError={null} detail={openDetail} now={NOW} />,
    );
    const answeredHtml = renderToStaticMarkup(
      <OwnerEscalationDecisionView authStatus="signed_in" loadState="ready" loadError={null} detail={answeredDetail} now={NOW} />,
    );
    expectNoCarsonBypassCopy(appAuthoredCopy(openHtml, openDetail));
    expectNoCarsonBypassCopy(appAuthoredCopy(answeredHtml, answeredDetail));
  });

  it("the bypass-copy guard does not false-positive on the staff member's own quoted request text", () => {
    // A staff message can legitimately contain words like "call" or
    // "contact" as part of what the staff member is asking about — that is
    // never app-authored guidance telling the owner to bypass Carson.
    const detail = baseDetail({
      inboundText: "Should I call the plumber directly, or message him myself?",
      escalationReason: "Christopher wants to contact the plumber outside of Carson.",
    });
    const html = renderToStaticMarkup(
      <OwnerEscalationDecisionView authStatus="signed_in" loadState="ready" loadError={null} detail={detail} now={NOW} />,
    );
    // The raw HTML legitimately contains this staff-authored bypass-shaped
    // text (quoted verbatim, not app guidance) ...
    expect(html).toContain("Should I call the plumber directly, or message him myself?");
    // ... but once that quoted content is stripped out, nothing app-authored
    // remains that instructs the owner to bypass Carson.
    expectNoCarsonBypassCopy(appAuthoredCopy(html, detail));
  });
});
