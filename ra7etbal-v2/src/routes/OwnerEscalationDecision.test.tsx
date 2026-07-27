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

  it("truthfully shows an already-answered state, distinct from the open state", () => {
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

  it("never tells the owner to bypass Carson — no instruction to reply, contact, or message staff directly (fixed: copy contradicted the Carson-owns-the-loop operating model)", () => {
    const html = renderToStaticMarkup(
      <OwnerEscalationDecisionView authStatus="signed_in" loadState="ready" loadError={null} detail={baseDetail()} now={NOW} />,
    );
    expect(html).not.toMatch(/reply[^.]*directly/i);
    expect(html).not.toMatch(/contact[^.]*directly/i);
    expect(html).not.toMatch(/message[^.]*directly/i);
    expect(html).not.toMatch(/reply to christopher/i);
  });
});
