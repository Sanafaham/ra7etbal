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
 * scripts/staff-instruction-live-evidence.ts for that evidence).
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

describe("review fixes (PR #422)", () => {
  it.each([
    ["DELEGATION.\nRECIPIENT: prepare lunch", "prepare lunch"],
    ["**DELEGATION**\nRECIPIENT: prepare lunch", "prepare lunch"],
    ["DELEGATION RECIPIENT: prepare lunch", "prepare lunch"],
  ])("tolerates a decorated verdict %j", async (answer, span) => {
    const { parseStaffInstructionAnswer } = await import("./communication-vs-delegation");
    expect(parseStaffInstructionAnswer(answer)).toEqual({ classification: "delegation", recipientSpan: span, failed: false });
  });

  it("a cut-off answer (stop_reason max_tokens) fails closed instead of grounding a partial instruction", async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: "jwt" } } });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ stop_reason: "max_tokens", content: [{ type: "text", text: "DELEGATION\nRECIPIENT: prepare lunch and then" }] }),
      }),
    );
    expect((await interpretStaffInstruction("Ask Christopher to prepare lunch and then set the table.", { recipientName: "Christopher" })).kind).toBe("unsafe");
  });

  it("drops the leftover 'to' of 'ask X to' so Carson never says 'asked X to to …'", async () => {
    expect(await decide("Ask Christopher to prepare lunch for me.", "to prepare lunch for me")).toEqual({
      kind: "delegation",
      recipientInstruction: "prepare lunch for me",
    });
  });

  it("recipient names ending in punctuation are still detected (fail closed)", () => {
    expect(groundRecipientInstruction("ask J.R. to clean the car", "ask J.R. to clean the car", "J.R.")).toBeNull();
  });
});

describe("coordinated actions: every action given to the recipient stays (live gate run 36768330026)", () => {
  it.each([
    ["Ask Christopher to prepare lunch and tell Grace it is ready.", "prepare lunch and tell Grace it is ready"],
    ["Ask Christopher to call the butcher and tell me what he says.", "call the butcher and tell me what he says"],
    ["Ask Christopher to collect the package and put it in my room.", "collect the package and put it in my room"],
    ["Ask Christopher to check the delivery and call the driver if it is late.", "check the delivery and call the driver if it is late"],
  ])("%j keeps %j whole", async (utterance, span) => {
    expect(await decide(utterance, span)).toEqual({ kind: "delegation", recipientInstruction: span });
  });

  it("the prompt assigns every joined action to the recipient and only oversight to Carson", async () => {
    const { buildClassificationPrompt } = await import("./communication-vs-delegation");
    const prompt = buildClassificationPrompt("Ask Christopher to prepare lunch and tell Grace it is ready.", "Christopher");
    expect(prompt).toMatch(/Every action the owner asks Christopher to do belongs to Christopher/);
    expect(prompt).toMatch(/gives Christopher both A and B/);
    expect(prompt).toMatch(/An action belongs to Carson only when it is about overseeing this assignment/);
    expect(prompt).toMatch(/never leave out any of Christopher's actions/);
    expect(prompt).toMatch(/RECIPIENT: UNCLEAR/);
    // The old exclusion of any "reporting back to the owner" is what pulled
    // recipient actions that inform someone into Carson's share.
    expect(prompt).not.toMatch(/reporting back to the owner/);
  });

  it("the axis text that decides COMMUNICATION vs DELEGATION (C-02) is unchanged", async () => {
    const { buildClassificationPrompt } = await import("./communication-vs-delegation");
    const prompt = buildClassificationPrompt("Tell Grace dinner is at eight.", "Grace");
    expect(prompt).toContain(
      "COMMUNICATION: the person only needs to receive this — come somewhere, wait somewhere, meet someone, receive information, or respond personally.",
    );
    expect(prompt).toContain("DELEGATION: the person is being directly instructed to complete, produce, or verify something as a piece of work.");
    expect(prompt).toContain("Answer on the first line with exactly one word: COMMUNICATION or DELEGATION.");
  });
});

describe("structured answer with a CARSON line and the UNCLEAR fail-closed answer", () => {
  it("reads RECIPIENT after a CARSON line", async () => {
    const { parseStaffInstructionAnswer } = await import("./communication-vs-delegation");
    expect(parseStaffInstructionAnswer("DELEGATION\nCARSON: track this until he confirms it\nRECIPIENT: prepare lunch for me")).toEqual({
      classification: "delegation",
      recipientSpan: "prepare lunch for me",
      failed: false,
    });
    expect(parseStaffInstructionAnswer("DELEGATION\nCARSON: NONE\nRECIPIENT: prepare lunch and tell Grace it is ready").recipientSpan).toBe(
      "prepare lunch and tell Grace it is ready",
    );
  });

  it.each(["UNCLEAR", "unclear.", "Unclear", "NONE"])(
    "RECIPIENT: %s → nothing is sent (recipient_instruction_not_grounded)",
    async (answer) => {
      getSessionMock.mockResolvedValue({ data: { session: { access_token: "jwt" } } });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: [{ type: "text", text: `DELEGATION\nCARSON: NONE\nRECIPIENT: ${answer}` }] }) }),
      );
      expect(
        await interpretStaffInstruction("Ask Christopher to follow up with the butcher and let me know what he says.", { recipientName: "Christopher" }),
      ).toEqual({ kind: "unsafe", reason: "recipient_instruction_not_grounded" });
    },
  );

  it("the single model call has room for both spans (max_tokens 200) and is still ONE request", async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: "jwt" } } });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: [{ type: "text", text: "DELEGATION\nCARSON: NONE\nRECIPIENT: check the pool pump" }] }) });
    vi.stubGlobal("fetch", fetchMock);
    await interpretStaffInstruction("Ask Christopher to check the pool pump.", { recipientName: "Christopher" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(200);
  });

  it("only a line that starts with RECIPIENT: is read (a CARSON line mentioning it is ignored)", async () => {
    const { parseStaffInstructionAnswer } = await import("./communication-vs-delegation");
    expect(
      parseStaffInstructionAnswer("DELEGATION\nCARSON: tell the recipient: track this\nRECIPIENT: prepare lunch").recipientSpan,
    ).toBe("prepare lunch");
  });

  it("the prompt keeps oversight Carson's even when joined with \"and\", and keeps recipient work that sounds like oversight", async () => {
    const { buildClassificationPrompt } = await import("./communication-vs-delegation");
    const prompt = buildClassificationPrompt("Ask Christopher to prepare lunch and track this until he confirms it.", "Christopher");
    expect(prompt).toMatch(/This stays Carson's even when it is joined to Christopher's actions with "and"\./);
    expect(prompt).toMatch(/Work that merely sounds like oversight is still Christopher's when Christopher does it/);
    expect(prompt).toMatch(/do not write this reasoning out/);
  });
});
