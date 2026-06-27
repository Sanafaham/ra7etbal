import { describe, it, expect, vi } from "vitest";
import type { Person } from "../types/person";

// carson-context transitively imports ./calendar -> ./supabase, whose module
// top-level throws without VITE_SUPABASE_* env vars. We only test pure context
// formatting, so stub the client.
vi.mock("./supabase", () => ({ supabase: {} }));

const { buildCarsonContext } = await import("./carson-context");

/**
 * Regression guard for People memory retrieval.
 *
 * Bug (commit 60b46a9, "Carson Household Knowledge V1"): the new structured
 * People block emitted a single abbreviated top-line for family members and
 * `continue`d before reaching the descriptive sub-fields — so family members'
 * Description / Notes were dropped from Carson's context. Carson could no longer
 * answer "What's Jewel's personality like?" even though it was stored in notes.
 *
 * Carson Intelligence fields must AUGMENT People notes, never replace them.
 */

function makePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: "p1",
    user_id: "u1",
    name: "Jewel",
    role: "",
    phone: null,
    notes: null,
    created_at: "2026-01-01T00:00:00Z",
    relationship: null,
    is_family: false,
    responsibilities: null,
    reliability_level: null,
    follow_up_level: null,
    delegation_guidance: null,
    should_not_assign: null,
    escalate_to: null,
    communication_style: null,
    whatsapp_opted_in: false,
    whatsapp_consent_at: null,
    whatsapp_consent_method: null,
    ...overrides,
  };
}

describe("buildCarsonContext — People memory retrieval", () => {
  it("includes a family member's notes/description", () => {
    const jewel = makePerson({
      name: "Jewel",
      relationship: "Sana's niece",
      is_family: true,
      notes: "Warm, bubbly, loves art and gets shy around new people.",
    });
    const out = buildCarsonContext({ tasks: [], people: [jewel] });
    expect(out).toContain("Jewel");
    expect(out).toContain("loves art");
  });

  it("includes family notes even when all Carson Intelligence fields are empty", () => {
    const jewel = makePerson({
      name: "Jewel",
      relationship: "Sana's niece",
      is_family: true,
      delegation_guidance: null,
      responsibilities: null,
      communication_style: null,
      notes: "Studying graphic design; quiet but very thoughtful.",
    });
    const out = buildCarsonContext({ tasks: [], people: [jewel] });
    expect(out).toContain("quiet but very thoughtful");
  });

  it("still includes notes for non-family staff members", () => {
    const grace = makePerson({
      name: "Grace",
      role: "Driver",
      is_family: false,
      notes: "Prefers short messages; very reliable with morning runs.",
    });
    const out = buildCarsonContext({ tasks: [], people: [grace] });
    expect(out).toContain("Grace");
    expect(out).toContain("Prefers short messages");
  });

  it("emits family descriptive fields alongside the FAMILY marker", () => {
    const jewel = makePerson({
      name: "Jewel",
      relationship: "Sana's niece",
      is_family: true,
      notes: "Loves painting.",
    });
    const out = buildCarsonContext({ tasks: [], people: [jewel] });
    expect(out).toContain("FAMILY");
    expect(out).toContain("Notes: Loves painting.");
  });
});

describe("buildCarsonContext — Phase 9A operational diagnostics", () => {
  it("includes the WhatsApp delivery status block when provided", () => {
    const out = buildCarsonContext({
      tasks: [],
      people: [],
      whatsappDeliveryStatusBlock: "WHATSAPP DELIVERY ISSUES (last 48h):\n- Failed to Sana — 2h ago: ecosystem engagement throttle",
    });
    expect(out).toContain("WHATSAPP DELIVERY ISSUES");
    expect(out).toContain("ecosystem engagement throttle");
  });

  it("omits the WhatsApp delivery status block when not provided (no recent failures)", () => {
    const out = buildCarsonContext({ tasks: [], people: [] });
    expect(out).not.toContain("WHATSAPP DELIVERY ISSUES");
  });

  it("includes the automation status block when provided, including a failed entry", () => {
    const out = buildCarsonContext({
      tasks: [],
      people: [],
      automationStatusBlock: "AUTOMATION STATUS:\nFailed (delivery or send failure — needs attention):\n- Daily check-in — Sana — failed 2h ago: ecosystem engagement throttle",
    });
    expect(out).toContain("AUTOMATION STATUS");
    expect(out).toContain("Failed (delivery or send failure");
  });
});
