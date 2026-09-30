import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Content boundary for tracked delegations (2026-09-30, Production canary
 * 965f5963: "Ask Christopher to prepare lunch for me and track this until he
 * confirms it." reached Christopher verbatim).
 *
 * The existing C-02 model call names which of the owner's own words are the
 * recipient's work; groundRecipientInstruction deterministically accepts only
 * the owner's own contiguous words. Anything else is unsafe: nothing is sent.
 * These tests inject the model's answer; they prove the grounding and
 * fail-closed wiring, not the live model's judgment (see
 * scripts/staff-instruction-live-evidence.mjs for that evidence).
 */

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock("./supabase", () => ({ supabase: { auth: { getSession: getSessionMock } } }));

import {
  STAFF_INSTRUCTION_TIMEOUT_MS,
  groundRecipientInstruction,
  interpretStaffInstruction,
  interpretStaffInstructionViaModel,
  type StaffInstructionInterpretation,
} from "./communication-vs-delegation";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  getSessionMock.mockReset();
});

function delegationSpan(span: string | null) {
  return async (): Promise<StaffInstructionInterpretation> => ({
    classification: "delegation",
    recipientSpan: span,
    failed: false,
  });
}

async function decide(utterance: string, span: string | null, recipientName = "Christopher") {
  return interpretStaffInstruction(utterance, { recipientName, interpretFn: delegationSpan(span) });
}

describe("owner → Carson management language is not recipient content", () => {
  it.each([
    [
      "Ask Christopher to prepare lunch for me and track this until he confirms it.",
      "prepare lunch for me",
      "prepare lunch for me",
    ],
    ["Track this for me: ask Christopher to prepare lunch.", "prepare lunch", "prepare lunch"],
    [
      "Ask Christopher to prepare lunch, and once he confirms, remind me to call Grace.",
      "prepare lunch",
      "prepare lunch",
    ],
    [
      "Make sure this gets tracked — ask Christopher to prepare lunch.",
      "prepare lunch.",
      "prepare lunch",
    ],
  ])("%j → recipient %j", async (utterance, span, expected) => {
    expect(await decide(utterance, span)).toEqual({ kind: "delegation", recipientInstruction: expected });
  });
});

describe("legitimate staff content stays whole", () => {
  it.each([
    ["Ask Christopher to follow up with the butcher about the salmon.", "follow up with the butcher about the salmon"],
    ["Ask Christopher to track the grocery delivery.", "track the grocery delivery"],
    ["Ask Christopher to make sure the oven is turned off.", "make sure the oven is turned off"],
    ["Ask Christopher to confirm the florist booking.", "confirm the florist booking"],
    ["Ask Christopher to prepare lunch and tell Grace it is ready.", "prepare lunch and tell Grace it is ready"],
    ["Ask Christopher to check the pool pump.", "check the pool pump"],
  ])("%j keeps %j", async (utterance, span) => {
    expect(await decide(utterance, span)).toEqual({ kind: "delegation", recipientInstruction: span });
  });

  it("returns the owner's own words and casing, never the model's rendering of them", async () => {
    expect(await decide("Ask Christopher to Prepare the Guest Room.", "prepare the guest room")).toEqual({
      kind: "delegation",
      recipientInstruction: "Prepare the Guest Room",
    });
  });
});

describe("fail closed — nothing may be sent", () => {
  const utterance = "Ask Christopher to prepare lunch for me and track this until he confirms it.";

  it.each([
    ["invented model text", "prepare dinner for the guests"],
    ["reworded owner text", "make lunch for Sana"],
    ["reordered owner text", "for me prepare lunch"],
    ["empty span", ""],
    ["whitespace span", "   "],
    ["punctuation only", "..."],
    ["span still addressing the recipient", "ask Christopher to prepare lunch for me"],
    ["missing span", null],
  ])("%s → unsafe", async (_label, span) => {
    expect(await decide(utterance, span as string | null)).toEqual({
      kind: "unsafe",
      reason: "recipient_instruction_not_grounded",
    });
  });

  it("a failed interpretation (model error) → unsafe, never a default delegation", async () => {
    const decision = await interpretStaffInstruction(utterance, {
      recipientName: "Christopher",
      interpretFn: async () => ({ classification: "delegation", recipientSpan: null, failed: true }),
    });
    expect(decision).toEqual({ kind: "unsafe", reason: "interpretation_unavailable" });
  });
});

describe("the real model call (mocked proxy) parses the one structured answer", () => {
  function reply(text: string) {
    return { ok: true, json: async () => ({ content: [{ type: "text", text }] }) };
  }
  function signedIn() {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: "jwt" } } });
  }

  it("DELEGATION + RECIPIENT line → classification and verbatim span, in ONE request", async () => {
    signedIn();
    const fetchMock = vi.fn().mockResolvedValue(reply("DELEGATION\nRECIPIENT: prepare lunch for me"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await interpretStaffInstructionViaModel(
      "Ask Christopher to prepare lunch for me and track this until he confirms it.",
      "Christopher",
    );
    expect(result).toEqual({ classification: "delegation", recipientSpan: "prepare lunch for me", failed: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content as string;
    expect(prompt).toContain("RECIPIENT:");
    expect(prompt).toContain("Christopher");
  });

  it("COMMUNICATION needs no span", async () => {
    signedIn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply("COMMUNICATION")));
    expect(await interpretStaffInstructionViaModel("Tell Christopher to wait downstairs.", "Christopher")).toEqual({
      classification: "communication",
      recipientSpan: null,
      failed: false,
    });
  });

  it.each([
    ["DELEGATION without a RECIPIENT line", "DELEGATION"],
    ["empty RECIPIENT line", "DELEGATION\nRECIPIENT:"],
  ])("malformed structured output (%s) → unsafe through the full decision", async (_label, text) => {
    signedIn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(text)));
    const decision = await interpretStaffInstruction("Ask Christopher to prepare lunch.", { recipientName: "Christopher" });
    expect(decision.kind).toBe("unsafe");
  });

  it.each([
    ["unparseable first line", reply("I think this is work")],
    ["non-OK response", { ok: false, json: async () => ({}) }],
    ["error body", { ok: true, json: async () => ({ error: "rate_limited" }) }],
  ])("%s → failed → unsafe", async (_label, response) => {
    signedIn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    expect(await interpretStaffInstruction("Ask Christopher to prepare lunch.", { recipientName: "Christopher" })).toEqual({
      kind: "unsafe",
      reason: "interpretation_unavailable",
    });
  });

  it("network error → unsafe", async () => {
    signedIn();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect((await interpretStaffInstruction("Ask Christopher to prepare lunch.")).kind).toBe("unsafe");
  });

  it("timeout → unsafe (the proxy never answers)", async () => {
    vi.useFakeTimers();
    signedIn();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    const pending = interpretStaffInstruction("Ask Christopher to prepare lunch.", { recipientName: "Christopher" });
    await vi.advanceTimersByTimeAsync(STAFF_INSTRUCTION_TIMEOUT_MS + 1);
    expect(await pending).toEqual({ kind: "unsafe", reason: "interpretation_unavailable" });
  });

  it("a reported third-party desire still short-circuits to communication with no model call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await interpretStaffInstruction("Tell Loulya I would like her to call me.")).toEqual({ kind: "communication" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("groundRecipientInstruction — pure grounding", () => {
  it("accepts curly quotes and extra whitespace as the same owner words", () => {
    expect(groundRecipientInstruction("bring  Sana’s tea", "Ask Grace to bring Sana's tea now", "Grace")).toBe(
      "bring Sana's tea",
    );
  });
  it("treats regex metacharacters in names literally", () => {
    expect(groundRecipientInstruction("clean the car", "ask J.R. to clean the car", "J.R.")).toBe("clean the car");
  });
});
