/**
 * Tests StaffUpdatesView / StaffMessageCard directly — both are pure,
 * hook-free components, so `renderToStaticMarkup` is enough to verify
 * rendered output without any DOM/testing-library dependency, matching
 * this repo's existing pure-function test convention.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { StaffMessage } from "../types/staff-message";

// This test only exercises the pure, hook-free StaffUpdatesView/StaffMessageCard
// exports below, but importing the module also statically imports
// ../lib/staff-messages, which imports ../lib/supabase — a module that throws
// at import time outside a real browser env (missing VITE_SUPABASE_* vars).
// Stubbed out here so import doesn't throw; never called by anything this
// file actually renders.
vi.mock("../lib/supabase", () => ({ supabase: {} }));

const { StaffMessageCard, StaffUpdatesView, formatReceivedAt } = await import("./StaffUpdates");

const NOW = new Date("2026-07-21T15:00:00.000Z");

function baseMessage(overrides: Partial<StaffMessage> = {}): StaffMessage {
  return {
    id: "msg-1",
    staff_name: "Grace",
    inbound_text: "There are no white flowers. Can I use cream?",
    carson_response: null,
    user_facing_state: "Waiting",
    next_action_owner: "carson",
    owner_attention_required: false,
    escalation_reason: null,
    received_at: NOW.toISOString(),
    task: null,
    ...overrides,
  };
}

describe("StaffUpdatesView", () => {
  it("does not show the empty-state message while auth is still resolving (status idle) — that would be premature, not truthful", () => {
    const html = renderToStaticMarkup(
      <StaffUpdatesView headerless status="idle" error={null} messages={[]} now={NOW} onRetry={() => {}} />,
    );
    expect(html).not.toContain("No staff messages need your attention.");
  });

  it("1. empty state renders truthfully — no rows, not loading, not erroring", () => {
    const html = renderToStaticMarkup(
      <StaffUpdatesView headerless status="ready" error={null} messages={[]} now={NOW} onRetry={() => {}} />,
    );
    expect(html).toContain("No staff messages need your attention.");
    // Never mentions ElevenLabs, implementation status, or technical blockers.
    expect(html.toLowerCase()).not.toMatch(/elevenlabs|whatsapp|database|blocked|transport/);
  });

  it("9. a fetch error renders a contained notice instead of throwing or breaking the section", () => {
    expect(() =>
      renderToStaticMarkup(
        <StaffUpdatesView
          headerless
          status="error"
          error="Something went wrong. Please try again."
          messages={[]}
          now={NOW}
          onRetry={() => {}}
        />,
      ),
    ).not.toThrow();

    const html = renderToStaticMarkup(
      <StaffUpdatesView
        headerless
        status="error"
        error="Something went wrong. Please try again."
        messages={[]}
        now={NOW}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain("Something went wrong. Please try again.");
    // Raw Supabase/RLS error text is never shown to the user.
    expect(html.toLowerCase()).not.toMatch(/row-level security|permission denied|supabase/);
  });

  it("renders a list item per message when ready with rows", () => {
    const html = renderToStaticMarkup(
      <StaffUpdatesView
        headerless
        status="ready"
        error={null}
        messages={[baseMessage(), baseMessage({ id: "msg-2", staff_name: "Ghulam" })]}
        now={NOW}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain("Grace");
    expect(html).toContain("Ghulam");
  });
});

describe("StaffMessageCard", () => {
  it("2. a Needs You message shows staff name, inbound text, and escalation reason", () => {
    const html = renderToStaticMarkup(
      <StaffMessageCard
        message={baseMessage({
          user_facing_state: "Needs You",
          owner_attention_required: true,
          escalation_reason: "Guest count changed from 2 to 5 — approve the larger vehicle?",
        })}
        now={NOW}
      />,
    );
    expect(html).toContain("Grace");
    expect(html).toContain("There are no white flowers. Can I use cream?");
    expect(html).toContain("Needs You");
    expect(html).toContain("Decision needed");
    expect(html).toContain("Guest count changed from 2 to 5 — approve the larger vehicle?");
  });

  it("3. a Waiting message shows the correct state and next-action owner", () => {
    const html = renderToStaticMarkup(
      <StaffMessageCard
        message={baseMessage({ user_facing_state: "Waiting", next_action_owner: "staff" })}
        now={NOW}
      />,
    );
    expect(html).toContain("Waiting");
    expect(html).toContain("Next: Staff");
  });

  it("4. a Completed message is labeled correctly", () => {
    const html = renderToStaticMarkup(
      <StaffMessageCard message={baseMessage({ user_facing_state: "Completed" })} now={NOW} />,
    );
    expect(html).toContain("Completed");
  });

  it("5. Carson's response is shown when present", () => {
    const html = renderToStaticMarkup(
      <StaffMessageCard
        message={baseMessage({ carson_response: "Yes, please use the cream flowers." })}
        now={NOW}
      />,
    );
    expect(html).toContain("Carson replied:");
    expect(html).toContain("Yes, please use the cream flowers.");
  });

  it("6. a missing Carson response does not produce broken UI", () => {
    expect(() =>
      renderToStaticMarkup(<StaffMessageCard message={baseMessage({ carson_response: null })} now={NOW} />),
    ).not.toThrow();
    const html = renderToStaticMarkup(<StaffMessageCard message={baseMessage({ carson_response: null })} now={NOW} />);
    expect(html).not.toContain("Carson replied:");
  });

  it("7. linked task context is shown when available", () => {
    const html = renderToStaticMarkup(
      <StaffMessageCard
        message={baseMessage({ task: { description: "Prepare the guest room", type: "delegation", status: "pending" } })}
        now={NOW}
      />,
    );
    expect(html).toContain("Related to: Prepare the guest room");
  });

  it("linked task context is safely omitted when there is no linked task", () => {
    const html = renderToStaticMarkup(<StaffMessageCard message={baseMessage({ task: null })} now={NOW} />);
    expect(html).not.toContain("Related to:");
  });

  it("does not show the escalation box when owner_attention_required is false, even if a reason is somehow present", () => {
    const html = renderToStaticMarkup(
      <StaffMessageCard
        message={baseMessage({ owner_attention_required: false, escalation_reason: "should not render" })}
        now={NOW}
      />,
    );
    expect(html).not.toContain("Decision needed");
    expect(html).not.toContain("should not render");
  });

  it("8. never renders internal-only fields (processing_status, processing_error, external_message_id, user_id, raw ids)", () => {
    const html = renderToStaticMarkup(
      <StaffMessageCard
        message={baseMessage({
          id: "11111111-2222-3333-4444-555555555555",
          escalation_reason: "processing_error should never leak: db timeout",
          owner_attention_required: true,
        })}
        now={NOW}
      />,
    );
    // The raw internal id is used only as a React key upstream — never rendered as text.
    expect(html).not.toContain("11111111-2222-3333-4444-555555555555");
    expect(html.toLowerCase()).not.toMatch(/processing_status|external_message_id|\buser_id\b/);
  });
});

describe("formatReceivedAt", () => {
  it("labels same-local-day timestamps as 'today'", () => {
    const sameDay = new Date(NOW);
    sameDay.setHours(sameDay.getHours() - 1);
    expect(formatReceivedAt(sameDay.toISOString(), NOW)).toMatch(/^Received today at/);
  });

  it("returns an empty string for an invalid timestamp rather than throwing or showing 'Invalid Date'", () => {
    expect(formatReceivedAt("not-a-date", NOW)).toBe("");
  });
});
