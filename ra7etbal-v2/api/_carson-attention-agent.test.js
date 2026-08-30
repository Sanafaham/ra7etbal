import { describe, expect, it, vi } from "vitest";
import { createAttentionAgentCoordinator, describeEvidenceForAgent, DEFAULT_ATTENTION_AGENT_MODEL } from "./_carson-attention-agent.js";

const EVIDENCE = {
  ok: true,
  code: "attention_read_succeeded",
  generatedAt: "2026-08-30T12:00:00.000Z",
  completeness: "full",
  needsYou: [{ id: "t1", label: "sign the lease", type: "decision", status: "pending", dueAt: null, dueDescription: null, assignee: null, category: "needsYou" }],
  overdueReminders: [{ id: "t2", label: "call the dentist", type: "reminder", status: "pending", dueAt: "2026-08-27T10:00:00.000Z", dueDescription: "Overdue by 3 days", assignee: null, category: "overdueReminders" }],
  upcomingReminders: [{ id: "t3", label: "pay electricity bill", type: "reminder", status: "pending", dueAt: "2026-09-02T10:00:00.000Z", dueDescription: "Due in 3 days", assignee: null, category: "upcomingReminders" }],
  waiting: [{ id: "t4", label: "Grace: kitchen", type: "delegation", status: "pending", dueAt: null, dueDescription: null, assignee: "Grace", category: "waiting" }],
  later: [{ id: "t5", label: "read that book", type: "reminder", status: "pending", dueAt: null, dueDescription: null, assignee: null, category: "later" }],
  unresolvedCaptures: [{ id: "t6", label: "buy groceries", type: "todo", status: "pending", dueAt: null, dueDescription: null, assignee: null, category: "unresolvedCaptures" }],
};
const GROUNDED_RESULT = { evidence: EVIDENCE, text: "irrelevant deterministic text — the agent never sees this" };

const OWNER_TURN = {
  accountId: "account-a",
  authorization: "Bearer session-a",
  turnId: "turn-1",
  transcript: "What can wait?",
};

// A fake buildAgent that records what it was constructed with and returns
// a stub agent object identifying which tool(s) it was given — lets tests
// assert the coordinator wires the real tool in without invoking the real
// @openai/agents Agent constructor (no network dependency).
function fakeBuildAgent(captured) {
  return (opts) => {
    captured.agentOpts = opts;
    return { __fakeAgent: true, ...opts };
  };
}

describe("createAttentionAgentCoordinator", () => {
  it("throws if fetchEvidence is not provided", () => {
    expect(() => createAttentionAgentCoordinator({})).toThrow();
  });

  it("does not handle a turn missing accountId or transcript", async () => {
    const fetchEvidence = vi.fn();
    const coordinate = createAttentionAgentCoordinator({ fetchEvidence, runAgent: vi.fn() });
    expect(await coordinate({ accountId: "a", transcript: "" })).toEqual({ handled: false, status: 400, code: "invalid_owner_turn" });
    expect(await coordinate({ accountId: "", transcript: "hi" })).toEqual({ handled: false, status: 400, code: "invalid_owner_turn" });
  });

  it("builds the agent with the default model, the one narrow tool, and calls runAgent with the transcript", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const runAgent = vi.fn().mockResolvedValue({ finalOutput: "Here's what's active.", newItems: [], lastResponseId: "resp_1" });
    const captured = {};
    const coordinate = createAttentionAgentCoordinator({ fetchEvidence, runAgent, buildAgent: fakeBuildAgent(captured) });

    const result = await coordinate(OWNER_TURN);

    expect(captured.agentOpts.model).toBe(DEFAULT_ATTENTION_AGENT_MODEL);
    expect(captured.agentOpts.tools).toHaveLength(1);
    expect(captured.agentOpts.tools[0].name).toBe("get_ra7etbal_attention_state");
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({ __fakeAgent: true }), "What can wait?", expect.any(Object));
    expect(result.handled).toBe(true);
    expect(result.ownerResult).toBe("Here's what's active.");
    expect(result.capability).toBe("attention_summary_read");
    expect(result.groundingStatus).toBe("grounded");
  });

  it("uses CARSON_AGENT_MODEL when configured, instead of the default", async () => {
    vi.stubEnv("CARSON_AGENT_MODEL", "some-other-model-id");
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const runAgent = vi.fn().mockResolvedValue({ finalOutput: "ok", newItems: [], lastResponseId: null });
    const captured = {};
    const coordinate = createAttentionAgentCoordinator({ fetchEvidence, runAgent, buildAgent: fakeBuildAgent(captured) });

    await coordinate(OWNER_TURN);

    expect(captured.agentOpts.model).toBe("some-other-model-id");
    vi.unstubAllEnvs();
  });

  it("passes previousResponseId through to runAgent when the owner turn carries one, and omits it when absent", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const runAgent = vi.fn().mockResolvedValue({ finalOutput: "ok", newItems: [], lastResponseId: "resp_2" });
    const coordinate = createAttentionAgentCoordinator({ fetchEvidence, runAgent, buildAgent: fakeBuildAgent({}) });

    await coordinate({ ...OWNER_TURN, previousResponseId: "resp_1" });
    expect(runAgent.mock.calls[0][2]).toMatchObject({ previousResponseId: "resp_1" });

    runAgent.mockClear();
    await coordinate(OWNER_TURN);
    expect(runAgent.mock.calls[0][2].previousResponseId).toBeUndefined();
  });

  it("returns the new lastResponseId for the next turn's continuity", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const runAgent = vi.fn().mockResolvedValue({ finalOutput: "ok", newItems: [], lastResponseId: "resp_next" });
    const coordinate = createAttentionAgentCoordinator({ fetchEvidence, runAgent, buildAgent: fakeBuildAgent({}) });

    const result = await coordinate(OWNER_TURN);

    expect(result.previousResponseId).toBe("resp_next");
  });

  it("counts tool_call_item entries in newItems as the tool-call count for observability (never exposed to the owner)", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const runAgent = vi.fn().mockResolvedValue({
      finalOutput: "ok",
      newItems: [{ type: "tool_call_item" }, { type: "message_output_item" }, { type: "tool_call_output_item" }],
      lastResponseId: null,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const coordinate = createAttentionAgentCoordinator({ fetchEvidence, runAgent, buildAgent: fakeBuildAgent({}) });

    await coordinate(OWNER_TURN);

    const logged = JSON.parse(logSpy.mock.calls[0][0]);
    expect(logged.toolCallCount).toBe(1);
    expect(logged.runSuccess).toBe(true);
    logSpy.mockRestore();
  });

  it("returns an honest failure message (never a fabricated answer) when the agent run throws", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const runAgent = vi.fn().mockRejectedValue(new Error("network down"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const coordinate = createAttentionAgentCoordinator({ fetchEvidence, runAgent, buildAgent: fakeBuildAgent({}) });

    const result = await coordinate(OWNER_TURN);

    expect(result.ownerResult).toBe("I couldn't check your live Ra7etBal state right now — please try again in a moment.");
    expect(result.groundingStatus).toBe("failed");
    const logged = JSON.parse(logSpy.mock.calls[0][0]);
    expect(logged.runSuccess).toBe(false);
    logSpy.mockRestore();
  });

  it("returns an honest failure message when the run resolves but produces no final output text", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const runAgent = vi.fn().mockResolvedValue({ finalOutput: undefined, newItems: [], lastResponseId: null });
    const coordinate = createAttentionAgentCoordinator({ fetchEvidence, runAgent, buildAgent: fakeBuildAgent({}) });

    const result = await coordinate(OWNER_TURN);

    expect(result.ownerResult).toContain("couldn't check");
    expect(result.groundingStatus).toBe("failed");
  });

  it("the safe diagnostic log never contains the owner's transcript or the model's final answer text", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const runAgent = vi.fn().mockResolvedValue({ finalOutput: "call the dentist is overdue by 3 days", newItems: [], lastResponseId: null });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const coordinate = createAttentionAgentCoordinator({ fetchEvidence, runAgent, buildAgent: fakeBuildAgent({}) });

    await coordinate({ ...OWNER_TURN, transcript: "a very specific private question about my lease" });

    const serialized = logSpy.mock.calls[0][0];
    expect(serialized).not.toContain("a very specific private question about my lease");
    expect(serialized).not.toContain("call the dentist is overdue by 3 days");
    logSpy.mockRestore();
  });
});

describe("get_ra7etbal_attention_state tool (constructed indirectly via the coordinator, exercised through buildAgent capture)", () => {
  function captureTool() {
    const captured = {};
    const buildAgent = (opts) => {
      captured.opts = opts;
      return { __fakeAgent: true };
    };
    return { captured, buildAgent };
  }

  it("returns ok:true with structured evidence (including raw dueAt and asOf) when the live fetch succeeds", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue(GROUNDED_RESULT);
    const { captured, buildAgent } = captureTool();
    const runAgent = vi.fn().mockResolvedValue({ finalOutput: "ok", newItems: [], lastResponseId: null });
    const coordinate = createAttentionAgentCoordinator({ fetchEvidence, runAgent, buildAgent });

    await coordinate(OWNER_TURN);

    const rawTool = captured.opts.tools[0];
    expect(rawTool.name).toBe("get_ra7etbal_attention_state");
    const toolResult = await rawTool.invoke({}, "{}");
    expect(toolResult.ok).toBe(true);
    expect(toolResult.asOf).toBe("2026-08-30T12:00:00.000Z");
    expect(toolResult.overdueReminders[0]).toMatchObject({ id: "t2", dueAt: "2026-08-27T10:00:00.000Z" });
    expect(fetchEvidence).toHaveBeenCalledWith({ accountId: "account-a", authorization: "Bearer session-a" });
  });

  it("returns ok:false with an honest message (never fabricated data) when the live evidence fetch fails", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue({ evidence: { ok: false, code: "attention_read_failed" } });
    const { captured, buildAgent } = captureTool();
    const runAgent = vi.fn().mockResolvedValue({ finalOutput: "I could not confirm.", newItems: [], lastResponseId: null });
    const coordinate = createAttentionAgentCoordinator({ fetchEvidence, runAgent, buildAgent });

    await coordinate(OWNER_TURN);

    const toolResult = await captured.opts.tools[0].invoke({}, "{}");
    expect(toolResult.ok).toBe(false);
    expect(toolResult.message).toMatch(/could not confirm|did not complete/i);
    expect(toolResult).not.toHaveProperty("needsYou");
  });

  it("returns ok:false when fetchEvidence itself throws, never letting the exception escape the tool", async () => {
    const fetchEvidence = vi.fn().mockRejectedValue(new Error("network down"));
    const { captured, buildAgent } = captureTool();
    const runAgent = vi.fn().mockResolvedValue({ finalOutput: "ok", newItems: [], lastResponseId: null });
    const coordinate = createAttentionAgentCoordinator({ fetchEvidence, runAgent, buildAgent });

    await coordinate(OWNER_TURN);

    const toolResult = await captured.opts.tools[0].invoke({}, "{}");
    expect(toolResult.ok).toBe(false);
  });
});

describe("describeEvidenceForAgent", () => {
  it("includes the raw dueAt timestamp and the evidence's own generatedAt as asOf, for every category", () => {
    const described = describeEvidenceForAgent(EVIDENCE);

    expect(described.asOf).toBe("2026-08-30T12:00:00.000Z");
    expect(described.overdueReminders[0]).toMatchObject({ id: "t2", dueAt: "2026-08-27T10:00:00.000Z" });
    expect(described.needsYou[0]).toMatchObject({ id: "t1", dueAt: null });
    expect(described.waiting[0]).toMatchObject({ assignee: "Grace" });
    expect(described.later[0]).toMatchObject({ id: "t5", category: "later" });
  });

  it("never invents fields not present on the source item", () => {
    const described = describeEvidenceForAgent(EVIDENCE);
    for (const category of ["needsYou", "overdueReminders", "upcomingReminders", "waiting", "later", "unresolvedCaptures"]) {
      for (const item of described[category]) {
        expect(Object.keys(item).sort()).toEqual(["assignee", "category", "dueAt", "dueDescription", "id", "label", "status", "type"]);
      }
    }
  });
});

describe("First acceptance journey (2026-08-30) — wiring proof across the four required owner turns", () => {
  // This exercises the COORDINATOR's wiring (tool gets called with fresh
  // evidence, distinct honest text comes back per question, continuity
  // threads through) using a small deterministic runAgent fake that
  // simulates a tool-calling loop — it does not and cannot prove the real
  // model's actual reasoning quality (that requires the real API, verified
  // separately via a live production golden journey). What IS proven here:
  // the tool is always called before any operational claim, the same live
  // evidence backs every turn, and nothing here special-cases any of the
  // four phrasings — one generic loop answers all of them.
  function makeConversationalRunAgentFake() {
    return vi.fn(async (agent, transcript) => {
      const toolResult = await agent.tools[0].invoke({}, "{}");
      if (!toolResult.ok) {
        return { finalOutput: "I could not confirm your live state right now.", newItems: [{ type: "tool_call_item" }], lastResponseId: "resp_fake" };
      }
      let finalOutput;
      if (/what needs me|needs my attention/i.test(transcript)) {
        finalOutput = toolResult.needsYou.length > 0
          ? `You need to decide: ${toolResult.needsYou.map((i) => i.label).join(", ")}.`
          : "Nothing needs your direct decision right now.";
      } else if (/what can wait/i.test(transcript)) {
        const nowMs = new Date(toolResult.asOf).getTime();
        const notDueYet = [...toolResult.overdueReminders, ...toolResult.upcomingReminders, ...toolResult.later, ...toolResult.needsYou].filter(
          (i) => i.dueAt && new Date(i.dueAt).getTime() > nowMs,
        );
        finalOutput = notDueYet.length > 0
          ? `Not due yet: ${notDueYet.map((i) => i.label).join(", ")}. Timing alone doesn't mean these are unimportant.`
          : "Nothing is clearly safe to postpone based on due dates alone.";
      } else if (/waiting on/i.test(transcript)) {
        finalOutput = toolResult.waiting.length > 0
          ? `You're waiting on: ${toolResult.waiting.map((i) => `${i.label} (${i.assignee})`).join(", ")}.`
          : "You're not waiting on anyone right now.";
      } else {
        finalOutput = toolResult.needsYou.length > 0 || toolResult.overdueReminders.length > 0
          ? "Yes — there are things that need you now."
          : "No, nothing needs your attention right now.";
      }
      return { finalOutput, newItems: [{ type: "tool_call_item" }], lastResponseId: "resp_fake" };
    });
  }

  const JOURNEY_EVIDENCE = {
    ok: true,
    code: "attention_read_succeeded",
    generatedAt: "2026-08-30T12:00:00.000Z",
    completeness: "full",
    needsYou: [{ id: "j1", label: "approve the invoice", type: "decision", status: "pending", dueAt: null, dueDescription: null, assignee: null, category: "needsYou" }],
    overdueReminders: [{ id: "j2", label: "call the dentist", type: "reminder", status: "pending", dueAt: "2026-08-27T10:00:00.000Z", dueDescription: "Overdue by 3 days", assignee: null, category: "overdueReminders" }],
    upcomingReminders: [{ id: "j3", label: "pay electricity bill", type: "reminder", status: "pending", dueAt: "2026-09-05T10:00:00.000Z", dueDescription: "Due in 6 days", assignee: null, category: "upcomingReminders" }],
    waiting: [{ id: "j4", label: "the school: field trip form", type: "delegation", status: "pending", dueAt: null, dueDescription: null, assignee: "the school", category: "waiting" }],
    later: [],
    unresolvedCaptures: [],
  };

  it("[1] 'What needs me?' names the actual needsYou item, grounded in the live tool result", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue({ evidence: JOURNEY_EVIDENCE, text: "unused" });
    const runAgent = makeConversationalRunAgentFake();
    const coordinate = createAttentionAgentCoordinator({ fetchEvidence, runAgent, buildAgent: (opts) => opts });

    const result = await coordinate({ accountId: "a", authorization: "Bearer s", turnId: "t1", transcript: "What needs me?" });

    expect(fetchEvidence).toHaveBeenCalledTimes(1);
    expect(result.ownerResult).toBe("You need to decide: approve the invoice.");
  });

  it("[2] 'What can wait?' distinguishes not-yet-due from overdue using real due dates, states the timing caveat, never claims later-filed items are automatically safe", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue({ evidence: JOURNEY_EVIDENCE, text: "unused" });
    const runAgent = makeConversationalRunAgentFake();
    const coordinate = createAttentionAgentCoordinator({ fetchEvidence, runAgent, buildAgent: (opts) => opts });

    const result = await coordinate({ accountId: "a", authorization: "Bearer s", turnId: "t2", transcript: "What can wait?" });

    expect(fetchEvidence).toHaveBeenCalledTimes(1);
    expect(result.ownerResult).toContain("pay electricity bill");
    expect(result.ownerResult).not.toContain("call the dentist");
    expect(result.ownerResult).toContain("doesn't mean these are unimportant");
  });

  it("[3] 'What am I waiting on?' reflects actual live Waiting state, not an invented one", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue({ evidence: JOURNEY_EVIDENCE, text: "unused" });
    const runAgent = makeConversationalRunAgentFake();
    const coordinate = createAttentionAgentCoordinator({ fetchEvidence, runAgent, buildAgent: (opts) => opts });

    const result = await coordinate({ accountId: "a", authorization: "Bearer s", turnId: "t3", transcript: "What am I waiting on?" });

    expect(result.ownerResult).toBe("You're waiting on: the school: field trip form (the school).");
  });

  it("[4] 'Do I actually need to deal with anything now?' is answered as a genuine yes/no from live evidence, still grounded via the same tool", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue({ evidence: JOURNEY_EVIDENCE, text: "unused" });
    const runAgent = makeConversationalRunAgentFake();
    const coordinate = createAttentionAgentCoordinator({ fetchEvidence, runAgent, buildAgent: (opts) => opts });

    const result = await coordinate({ accountId: "a", authorization: "Bearer s", turnId: "t4", transcript: "Do I actually need to deal with anything now?" });

    expect(result.ownerResult).toBe("Yes — there are things that need you now.");
  });

  it("every turn in the journey independently calls the live tool — no answer is ever produced without a fresh grounded result", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue({ evidence: JOURNEY_EVIDENCE, text: "unused" });
    const runAgent = makeConversationalRunAgentFake();
    const coordinate = createAttentionAgentCoordinator({ fetchEvidence, runAgent, buildAgent: (opts) => opts });
    const transcripts = ["What needs me?", "What can wait?", "What am I waiting on?", "Do I actually need to deal with anything now?"];

    for (const transcript of transcripts) {
      await coordinate({ accountId: "a", authorization: "Bearer s", turnId: `t-${transcript}`, transcript });
    }

    expect(fetchEvidence).toHaveBeenCalledTimes(4);
  });

  it("says it cannot confirm the live state — never a fabricated answer — for any of the four questions when the live tool fails", async () => {
    const fetchEvidence = vi.fn().mockResolvedValue({ evidence: { ok: false, code: "attention_read_failed" } });
    const runAgent = makeConversationalRunAgentFake();
    const coordinate = createAttentionAgentCoordinator({ fetchEvidence, runAgent, buildAgent: (opts) => opts });

    const result = await coordinate({ accountId: "a", authorization: "Bearer s", turnId: "t-fail", transcript: "What can wait?" });

    expect(result.ownerResult).toBe("I could not confirm your live state right now.");
  });
});
