import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractedItem } from "../types/extraction";
import type { Message } from "../types/message";
import type { Person } from "../types/person";

// ops-intelligence.ts imports ./supabase at module top level (for plan persistence).
// Stub it with a minimal chainable query builder — the pure detection functions
// under test (isConfirmation, isRejection, isStatusQuestion) never call Supabase,
// and read-path tests (resolveHostingOperationRecall) configure per-table results
// via mocks.supabaseTables.
const mocks = vi.hoisted(() => ({
  savePending: vi.fn(),
  deliverTaskMessage: vi.fn(),
  sendDirectMessageRecord: vi.fn(),
  supabaseGetUser: vi.fn(async (): Promise<{ data: { user: { id: string } | null } }> => ({
    data: { user: null },
  })),
  supabaseFrom: vi.fn(),
}));

function queryStub(result: { data: unknown; error: unknown } = { data: null, error: null }) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    update: () => builder,
    insert: () => builder,
    delete: () => builder,
    eq: () => builder,
    gt: () => builder,
    order: () => builder,
    limit: () => builder,
    in: () => builder,
    maybeSingle: async () => result,
    single: async () => result,
    then: (resolve: (value: typeof result) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

vi.mock("./supabase", () => ({
  supabase: {
    auth: { getUser: mocks.supabaseGetUser },
    from: mocks.supabaseFrom,
  },
}));

vi.mock("./save", () => ({ savePending: mocks.savePending }));
vi.mock("./delivery", () => ({ deliverTaskMessage: mocks.deliverTaskMessage }));
vi.mock("./direct-messages", () => ({ sendDirectMessageRecord: mocks.sendDirectMessageRecord }));
vi.mock("./delegation-message", () => ({
  buildDelegationMessage: ({ taskText }: { taskText: string }) => taskText,
}));

const {
  answerHostingOperationRecall,
  buildDeterministicGuestPreparationTasks,
  buildHostingEventBrief,
  detectHouseholdOutcome,
  evaluateHostingPlanningGate,
  executeProposedPlan,
  handlePendingPlanTurn,
  hasLeadingConfirmationLanguage,
  hasOperatingAuthority,
  isConfirmation,
  isRejection,
  isStatusQuestion,
  isVerifiedWorkerConfirmation,
  mustRouteGuestEventToPlanner,
  normalizeGuestPreparationPlan,
  normalizeHostingClarificationAnswer,
  prepareOperationalPlanTurn,
  ACTION_CONTINUATION_SLOT_REGISTRY,
  runActionContinuation,
  reconstructHostingContinuationFromTypedHistory,
  resetExecutedPlanRegistryForTest,
  resolveGuestOutcomeAction,
  resolveHostingOperationRecall,
  resolvePendingPlanDecision,
} = await import("./ops-intelligence");

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetExecutedPlanRegistryForTest();
  mocks.supabaseGetUser.mockResolvedValue({ data: { user: null } });
  mocks.supabaseFrom.mockImplementation(() => queryStub());
});

describe("isConfirmation", () => {
  it.each(["yes", "yes.", "yeah", "yep", "ok", "okay", "sure", "go ahead", "do it", "send it", "sounds good", "perfect", "great", "please do", "go for it", "confirmed", "correct", "absolutely", "definitely"])(
    "returns true for '%s'",
    (text) => { expect(isConfirmation(text)).toBe(true); },
  );

  it.each(["no", "not yet", "cancel", "did you send it?", "was it delivered?", "Yes and please also ask Grace"])(
    "returns false for '%s'",
    (text) => { expect(isConfirmation(text)).toBe(false); },
  );
});

describe("isRejection", () => {
  it.each(["no", "nope", "not yet", "cancel", "don't send", "do not send", "hold off", "wait", "never mind", "nevermind", "skip it", "don't do it"])(
    "returns true for '%s'",
    (text) => { expect(isRejection(text)).toBe(true); },
  );

  it.each(["yes", "go ahead", "send it", "was it sent?"])(
    "returns false for '%s'",
    (text) => { expect(isRejection(text)).toBe(false); },
  );
});

describe("hasLeadingConfirmationLanguage", () => {
  it.each([
    "Yes, and please coordinate the table setup for dinner tomorrow at 8:00 PM. Four guests, no shellfish.",
    "Okay, also send Grace the details for the dinner.",
    "Go ahead, and confirm with Grace too.",
    "Yes, also let Christopher know about the shellfish allergy.",
    // Reproduced in production: "both" isn't covered by CONFIRMATION_RE's own
    // "send" alternative (only it/them/those/the messages), so this never
    // resolves as a bare confirmation either — it must be caught here.
    "Yes, send both.\nPlease coordinate table setup for dinner tomorrow at 8:00 PM for 4 guests. No shellfish. Ensure everything is ready before guests arrive.",
    "Yes, send both.",
  ])("returns true for compound reply '%s'", (text) => {
    expect(hasLeadingConfirmationLanguage(text)).toBe(true);
  });

  it.each([
    "yes",
    "Yes.",
    "yeah",
    "go ahead",
    "no",
    "Prepare dinner for four tomorrow",
    "Please coordinate the table setup for dinner tomorrow at 8:00 PM.",
  ])("returns false for '%s'", (text) => {
    expect(hasLeadingConfirmationLanguage(text)).toBe(false);
  });
});

describe("isStatusQuestion", () => {
  it.each([
    "did you send it?",
    "Did you send it?",
    "was it sent?",
    "Was it delivered?",
    "did it go through?",
    "Did it go through?",
    "has it been sent?",
    "did Christopher get it?",
    "did he get it?",
    "was the message sent?",
    "was it received?",
    "has Christopher received it?",
    "did you reach him?",
    "was Christopher messaged?",
    "did you send that?",
    "did you send the photo?",
    "can you confirm it was sent?",
    "is it sent?",
    "did it went through",
    "was it delivered to him?",
  ])("returns true for '%s'", (text) => {
    expect(isStatusQuestion(text)).toBe(true);
  });

  // Must NOT fire on real delegation commands or social turns
  it.each([
    "ask Christopher to prepare dinner",
    "send this to Christopher",
    "tell Grace to bring the car",
    "yes",
    "ok thanks",
    "what's pending?",
    "what am I waiting on?",
    "remind me tomorrow at 9",
    "Yes.",
    "go ahead",
    "You're all set",
  ])("returns false for delegation/social input: '%s'", (text) => {
    expect(isStatusQuestion(text)).toBe(false);
  });
});

describe("truthful hosting confirmation evidence", () => {
  it("requires both done status and a confirmation timestamp", () => {
    expect(isVerifiedWorkerConfirmation({ status: "done", confirmed_at: "2026-07-24T10:15:00Z" })).toBe(true);
    expect(isVerifiedWorkerConfirmation({ status: "done", confirmed_at: null })).toBe(false);
    expect(isVerifiedWorkerConfirmation({ status: "pending", confirmed_at: "2026-07-24T10:15:00Z" })).toBe(false);
    expect(isVerifiedWorkerConfirmation({ status: "pending", confirmed_at: null })).toBe(false);
  });
});

describe("guest preparation operational planning", () => {
  it("detects operating authority for broad guest preparation", () => {
    expect(hasOperatingAuthority("I have guests tomorrow. Handle what you can.")).toBe(true);
    expect(hasOperatingAuthority("I have guests tomorrow.")).toBe(false);
  });

  it("creates separate dinner, hospitality, and coordinator delegations", () => {
    const tasks = buildDeterministicGuestPreparationTasks(
      guestTeam(),
      "Afternoon tea today at 4:30 PM in the garden for three guests. Serve sandwiches, scones, cakes, tea, coffee, and water. No dietary restrictions. Use the blue china and simple flowers.",
    );

    expect(tasks.map((task) => task.personName)).toEqual(["Christopher", "Nasira", "Grace"]);
    for (const task of tasks) {
      expect(task.message).toContain("Sana is hosting afternoon tea for three guests today at 4:30 PM in the garden.");
      expect(task.message).toMatch(/today/);
      expect(task.message).toMatch(/4:30 PM/);
      expect(task.message).toMatch(/garden/);
    }
    expect(tasks[0].message).toContain("Please prepare sandwiches, scones, cakes, tea, coffee, and water.");
    expect(tasks[1].message).toMatch(/blue china|flowers/i);
    expect(tasks[2].message).toMatch(/coordinate with Christopher and Nasira/i);
  });

  it("formats hosting worker messages naturally for relative dates and indoor locations", () => {
    const tasks = buildDeterministicGuestPreparationTasks(
      guestTeam(),
      "Afternoon tea today at 4:00 PM inside for three guests. Serve mini sandwiches, mini cakes, pastries, tea, coffee, and water. No dietary restrictions. Use the pink floral china, pink flowers, and silver cutlery.",
    );

    for (const task of tasks) {
      expect(task.message).toContain("Sana is hosting afternoon tea for three guests today at 4:00 PM inside.");
      expect(task.message).not.toMatch(/\bon today\b/i);
      expect(task.message).not.toMatch(/\bin inside\b/i);
      expect(task.message).not.toMatch(/\bsana is hosting\b/);
    }
    expect(tasks[0].message).toContain("Sana is hosting afternoon tea for three guests today at 4:00 PM inside.");
    expect(tasks[1].message).toContain("pink floral china");
    expect(tasks[1].message).toContain("pink flowers");
  });

  it("repairs a collapsed single-owner guest plan before persistence or execution", () => {
    const collapsed = normalizeGuestPreparationPlan({
      outcomeType: "guest_arrival",
      sourceText: "I have guests tomorrow at 6 PM in the dining room. Serve tea and sandwiches. Handle what you can.",
      createdAt: Date.now(),
      proposalSpeech: "I can ask Christopher to handle it. Should I send it?",
      tasks: [
        {
          personId: "christopher",
          personName: "Christopher",
          message: "Confirm menu, prepare dinner, arrange flowers, and coordinate everyone.",
        },
      ],
    }, guestTeam());

    expect(collapsed.tasks.map((task) => task.personName)).toEqual([
      "Christopher",
      "Nasira",
      "Grace",
    ]);
    expect(collapsed.tasks.map((task) => task.message).join("\n")).toContain("tomorrow at 6 PM in the dining room");
    expect(collapsed.tasks[0].message).toContain("Please prepare tea and sandwiches.");
    expect(collapsed.tasks[2].message).toContain("Please coordinate with Christopher and Nasira");
  });

  it("executes multi-owner guest plans as three separate delegation items, messages, and confirmations", async () => {
    mocks.savePending.mockImplementationOnce(async (items: ExtractedItem[]) => ({
      tasks: items.map((item, index) => ({
        id: `task-${index + 1}`,
        type: "delegation",
        assigned_to: item.assignedTo,
        description: item.description,
      })),
      messages: items.map((item, index) => ({
        id: `message-${index + 1}`,
        task_id: `task-${index + 1}`,
        recipient: item.assignedTo,
        content: item.suggestedMessage ?? item.description,
        confirmation_url: `https://ra7etbal.test/confirm?task=task-${index + 1}`,
      })) as Message[],
      todos: [],
      notesSaved: 0,
      skipped: 0,
      imagePathsByTaskId: new Map(),
    }));
    mocks.deliverTaskMessage.mockResolvedValue({ success: true, channel: "whatsapp" });

    const plan = normalizeGuestPreparationPlan({
      outcomeType: "guest_arrival",
      sourceText: "I have guests tomorrow at 6 PM in the dining room. Serve tea and sandwiches. Handle what you can.",
      createdAt: Date.now(),
      proposalSpeech: "I can ask Christopher to handle it. Should I send it?",
      tasks: [
        {
          personId: "christopher",
          personName: "Christopher",
          message: "Confirm menu, prepare dinner, arrange flowers, and coordinate everyone.",
        },
      ],
    }, guestTeam());

    const result = await executeProposedPlan(plan, {
      displayName: "Sana",
      userId: "user-1",
      people: guestTeam(),
    });

    const savedItems = mocks.savePending.mock.calls[0][0] as ExtractedItem[];
    expect(savedItems.map((item) => item.assignedTo)).toEqual(["Christopher", "Nasira", "Grace"]);
    for (const item of savedItems) {
      expect(item.description).toContain("tomorrow at 6 PM in the dining room");
    }
    expect(savedItems[0].description).toContain("Please prepare tea and sandwiches.");
    expect(savedItems[2].description).toContain("Please coordinate with Christopher and Nasira");
    expect(mocks.deliverTaskMessage).toHaveBeenCalledTimes(3);
    expect(mocks.deliverTaskMessage.mock.calls.map(([payload]) => payload.recipientName)).toEqual([
      "Christopher",
      "Nasira",
      "Grace",
    ]);
    expect(result).toContain("Christopher, Nasira, Grace have the plan. I'll watch for confirmations.");
    expect(result).toContain("Christopher: Sana is hosting tea tomorrow at 6 PM");
  });

  it("reports exactly who succeeded and failed when one multi-owner send fails", async () => {
    mocks.savePending.mockImplementationOnce(async (items: ExtractedItem[]) => ({
      tasks: items.map((item, index) => ({
        id: `task-${index + 1}`,
        type: "delegation",
        assigned_to: item.assignedTo,
        description: item.description,
      })),
      messages: items.map((item, index) => ({
        id: `message-${index + 1}`,
        task_id: `task-${index + 1}`,
        recipient: item.assignedTo,
        content: item.suggestedMessage ?? item.description,
        confirmation_url: `https://ra7etbal.test/confirm?task=task-${index + 1}`,
      })) as Message[],
      todos: [],
      notesSaved: 0,
      skipped: 0,
      imagePathsByTaskId: new Map(),
    }));
    mocks.deliverTaskMessage
      .mockResolvedValueOnce({ success: true, channel: "whatsapp" })
      .mockResolvedValueOnce({ success: false, channel: "whatsapp", error: "Meta rejected the message" })
      .mockResolvedValueOnce({ success: true, channel: "whatsapp" });

    const plan = normalizeGuestPreparationPlan({
      outcomeType: "guest_arrival",
      sourceText: "I have guests tomorrow. Handle what you can.",
      createdAt: Date.now(),
      proposalSpeech: "I can ask Christopher to handle it. Should I send it?",
      tasks: [
        {
          personId: "christopher",
          personName: "Christopher",
          message: "Confirm menu, prepare dinner, arrange flowers, and coordinate everyone.",
        },
      ],
    }, guestTeam());

    const result = await executeProposedPlan(plan, {
      displayName: "Sana",
      userId: "user-1",
      people: guestTeam(),
    });

    expect(mocks.deliverTaskMessage).toHaveBeenCalledTimes(3);
    expect(result).toContain("Christopher, Grace have the plan");
    expect(result).toContain("Nasira was NOT messaged — Meta rejected the message");
  });
});

// ── Guest event planning — rebuilt safely (real household roles) ──────────────
// Mirrors the production roster: Christopher=Cook, Nasira=Housekeeper,
// Bahan=Coordinator, Grace=Nanny, Ghulam=Driver. Encodes the explicit rules:
//   - Coordination: Coordinator → House Manager → Assistant → else Grace.
//   - Transport standby: ONLY when the request names transport/Ghulam.
//   - Never assign the assistant (Carson).
//   - Never give one person the whole plan.
// Guardrail: a direct per-person delegation must be diverted to the deterministic
// planner whenever the current user context is a guest/hosting event — so the
// agent can never fan a guest event out into its own per-person delegations
// (the live failure: Grace "follow up with all", Ghulam "standby", etc.).
// Operating authority means EXECUTE, not just plan. The confirm-before-send
// rebuild regressed this: guest outcomes always proposed, even when the user
// granted operating authority. These lock in "authority → execute immediately;
// hosting without authority → propose; ordinary command → none".
describe("operating authority executes immediately", () => {
  const AUTH_DINNER =
    "we're having dinner at home tomorrow night. Handle what you can and make sure everything is ready.";

  function stubSavePendingWithSeparateRowsAndLinks() {
    mocks.savePending.mockImplementationOnce(async (items: ExtractedItem[]) => ({
      tasks: items.map((item, i) => ({
        id: `task-${i + 1}`,
        type: "delegation",
        assigned_to: item.assignedTo,
        description: item.description,
      })),
      messages: items.map((item, i) => ({
        id: `message-${i + 1}`,
        task_id: `task-${i + 1}`,
        recipient: item.assignedTo,
        content: item.suggestedMessage ?? item.description,
        confirmation_url: `https://ra7etbal.test/confirm?task=task-${i + 1}`,
      })) as Message[],
      todos: [],
      notesSaved: 0,
      skipped: 0,
      imagePathsByTaskId: new Map(),
    }));
  }

  it("routes an operating-authority request to execute (not propose)", () => {
    expect(resolveGuestOutcomeAction(AUTH_DINNER)).toBe("execute");
    expect(resolveGuestOutcomeAction("Take care of it.")).toBe("execute");
    expect(resolveGuestOutcomeAction("Make tonight run smoothly.")).toBe("execute");
    expect(resolveGuestOutcomeAction("I have afternoon tea at home today. Handle what you can.")).toBe("execute");
  });

  it("proposes a hosting event when no operating authority is given", () => {
    expect(resolveGuestOutcomeAction("we're having dinner at home tomorrow night.")).toBe("propose");
    expect(resolveGuestOutcomeAction("I have afternoon tea at home today.")).toBe("propose");
  });

  it("leaves ordinary single-person commands alone", () => {
    expect(resolveGuestOutcomeAction("Tell Christopher to make shrimp poke bowl.")).toBe("none");
    expect(resolveGuestOutcomeAction("Remind me to buy milk.")).toBe("none");
    expect(resolveGuestOutcomeAction("")).toBe("none");
    expect(resolveGuestOutcomeAction(null)).toBe("none");
  });

  it("detects a hosting dinner at home (but not a plain 'make dinner')", () => {
    expect(detectHouseholdOutcome("we're having dinner at home tomorrow night.")).toBe("guest_arrival");
    expect(detectHouseholdOutcome("dinner at home tomorrow")).toBe("guest_arrival");
    expect(detectHouseholdOutcome("make dinner")).toBeNull();
    expect(detectHouseholdOutcome("cook dinner tonight")).toBeNull();
  });

  it("executes the deterministic plan and reports only tool-confirmed results", async () => {
    stubSavePendingWithSeparateRowsAndLinks();
    mocks.deliverTaskMessage.mockResolvedValue({ success: true, channel: "whatsapp" });

    const plan = normalizeGuestPreparationPlan({
      outcomeType: "guest_arrival",
      sourceText: AUTH_DINNER,
      createdAt: Date.now(),
      proposalSpeech: "Proposal.",
      tasks: [{ personId: "christopher", personName: "Christopher", message: "Handle everything." }],
    }, guestTeam());

    const summary = await executeProposedPlan(plan, {
      displayName: "Sana",
      userId: "user-1",
      people: guestTeam(),
    });

    // Real sends happened for every planned recipient.
    expect(mocks.deliverTaskMessage.mock.calls.map(([p]) => p.recipientName)).toEqual([
      "Christopher",
      "Nasira",
      "Grace",
    ]);
    expect(summary).toContain("have the plan");
  });

  it("does NOT claim messages were sent when delivery fails", async () => {
    stubSavePendingWithSeparateRowsAndLinks();
    mocks.deliverTaskMessage.mockResolvedValue({
      success: false,
      channel: "failed",
      error: "recipient phone number is missing",
    });

    const plan = normalizeGuestPreparationPlan({
      outcomeType: "guest_arrival",
      sourceText: AUTH_DINNER,
      createdAt: Date.now(),
      proposalSpeech: "Proposal.",
      tasks: [{ personId: "christopher", personName: "Christopher", message: "Handle everything." }],
    }, guestTeam());

    const summary = await executeProposedPlan(plan, {
      displayName: "Sana",
      userId: "user-1",
      people: guestTeam(),
    });

    expect(summary).not.toMatch(/have the plan/i);
    expect(summary).toMatch(/NOT messaged/i);
  });
});

describe("direct-delegation guardrail for guest/hosting events", () => {
  it.each([
    "I have afternoon tea at home today.",
    "We're hosting a dinner party tomorrow.",
    "Guests are coming for lunch.",
    "We're having friends over tonight.",
  ])("diverts a guest/hosting event to the planner: '%s'", (text) => {
    expect(mustRouteGuestEventToPlanner(text)).toBe(true);
  });

  it.each([
    "Tell Christopher to make shrimp poke bowl.",
    "Ask Ghulam to bring the car at 5.",
    "Remind me to buy milk.",
    "Text Grace the flowers look nice.",
    "",
    "   ",
  ])("allows ordinary single-person commands through direct delegation: '%s'", (text) => {
    expect(mustRouteGuestEventToPlanner(text)).toBe(false);
  });

  it("treats null/undefined context as allow-direct (no diversion)", () => {
    expect(mustRouteGuestEventToPlanner(null)).toBe(false);
    expect(mustRouteGuestEventToPlanner(undefined)).toBe(false);
  });
});

describe("household outcome detection — hosting events without the word 'guests'", () => {
  it.each([
    "I have afternoon tea at home today.",
    "We're hosting a dinner party tomorrow.",
    "I have a luncheon at home on Friday.",
    "We're having friends over this evening.",
  ])("detects a hosting event: '%s'", (text) => {
    expect(detectHouseholdOutcome(text)).toBe("guest_arrival");
  });

  it.each([
    "Guests are coming tomorrow.",
    "We're expecting visitors this evening.",
  ])("still detects explicit guest phrasing: '%s'", (text) => {
    expect(detectHouseholdOutcome(text)).toBe("guest_arrival");
  });

  it.each([
    "Ask Christopher to make dinner.",
    "Remind me to buy milk.",
    "Tell Grace the flowers look nice.",
    "I had a cup of tea.",
  ])("does not trigger guest planning on ordinary input: '%s'", (text) => {
    expect(detectHouseholdOutcome(text)).toBeNull();
  });

  it("runs the deterministic planner for the exact failed utterance → Christopher, Nasira, Bahan (no Grace, no Ghulam)", () => {
    const team = [
      person({ id: "christopher", name: "Christopher", role: "Cook", responsibilities: "food" }),
      person({ id: "nasira", name: "Nasira", role: "Housekeeper", responsibilities: "hospitality" }),
      person({ id: "bahan", name: "Bahan", role: "Coordinator", responsibilities: "coordinate" }),
      person({ id: "grace", name: "Grace", role: "Nanny", responsibilities: "childcare" }),
      person({ id: "ghulam", name: "Ghulam", role: "Driver", responsibilities: "transport" }),
    ];
    const tasks = buildDeterministicGuestPreparationTasks(team, "I have afternoon tea at home today.");
    expect(tasks.map((t) => t.personName)).toEqual(["Christopher", "Nasira", "Bahan"]);
  });
});

describe("guest event planning — safety rules", () => {
  const TEA = "I have guests tomorrow for afternoon tea. Handle what you can.";
  const COMPLETE_TEA =
    "I have afternoon tea at home today for three guests at 4:30 PM in the garden. Serve finger sandwiches, scones, small cakes, tea, coffee, and water. No dietary restrictions. Use the blue china and simple flowers. Handle what you can.";

  function realHousehold(): Person[] {
    return [
      person({ id: "christopher", name: "Christopher", role: "Cook", responsibilities: "Dinner, menu, kitchen, food." }),
      person({ id: "nasira", name: "Nasira", role: "Housekeeper", responsibilities: "Flowers, hospitality, table setup, guest rooms." }),
      person({ id: "bahan", name: "Bahan", role: "Coordinator", responsibilities: "Coordinate staff and follow up." }),
      person({ id: "grace", name: "Grace", role: "Nanny", responsibilities: "Childcare." }),
      person({ id: "ghulam", name: "Ghulam", role: "Driver", responsibilities: "Transport, car, airport pickups." }),
    ];
  }

  it("splits the afternoon-tea plan into exact recipient/task pairs", () => {
    const tasks = buildDeterministicGuestPreparationTasks(realHousehold(), COMPLETE_TEA);
    expect(tasks.map((task) => [task.personId, task.personName])).toEqual([
      ["christopher", "Christopher"],
      ["nasira", "Nasira"],
      ["bahan", "Bahan"],
    ]);
    for (const task of tasks) {
      expect(task.message).toContain("Sana is hosting afternoon tea for three guests today at 4:30 PM in the garden.");
      expect(task.message).not.toMatch(/\bMenu:|\bDrinks:|\bDietary requirements:|\bRequired result:/);
      expect(task.message).not.toMatch(/Tell Carson|Report .* to Carson/i);
    }
    expect(tasks[0].message).toContain("Please prepare finger sandwiches, scones, small cakes, tea, coffee, and water.");
    expect(tasks[1].message).toContain("blue china");
    expect(tasks[1].message).toContain("flowers");
    expect(tasks[2].message).toContain("Please coordinate with Christopher and Nasira");
  });

  it("never assigns anything to Carson, even when Carson holds the only coordinator role", () => {
    const team = [
      person({ id: "christopher", name: "Christopher", role: "Cook", responsibilities: "food" }),
      person({ id: "nasira", name: "Nasira", role: "Housekeeper", responsibilities: "hospitality" }),
      person({ id: "carson", name: "Carson", role: "Coordinator", responsibilities: "Coordinate everything." }),
      person({ id: "grace", name: "Grace", role: "Nanny", responsibilities: "childcare" }),
    ];
    const tasks = buildDeterministicGuestPreparationTasks(team, TEA);
    expect(tasks.some((t) => /carson/i.test(t.personName))).toBe(false);
    // Coordination falls back past the filtered assistant to Grace.
    expect(tasks.find((t) => /coordinate/i.test(t.message))?.personName).toBe("Grace");
  });

  it("assigns coordination to the Coordinator (Bahan), never the Nanny (Grace)", () => {
    const tasks = buildDeterministicGuestPreparationTasks(realHousehold(), TEA);
    expect(tasks.find((t) => /coordinate/i.test(t.message))?.personName).toBe("Bahan");
    expect(tasks.some((t) => t.personName === "Grace")).toBe(false);
  });

  it("falls back to Grace for coordination when no coordinator-type role exists", () => {
    const team = [
      person({ id: "christopher", name: "Christopher", role: "Cook", responsibilities: "food" }),
      person({ id: "nasira", name: "Nasira", role: "Housekeeper", responsibilities: "hospitality" }),
      person({ id: "grace", name: "Grace", role: "Nanny", responsibilities: "childcare" }),
    ];
    const tasks = buildDeterministicGuestPreparationTasks(team, TEA);
    expect(tasks.find((t) => /coordinate/i.test(t.message))?.personName).toBe("Grace");
  });

  it("does not add transport standby for plain afternoon tea", () => {
    const tasks = buildDeterministicGuestPreparationTasks(realHousehold(), TEA);
    expect(tasks.some((t) => t.personName === "Ghulam")).toBe(false);
    expect(tasks.some((t) => /transport|standby/i.test(t.message))).toBe(false);
  });

  it("adds transport standby only when the request names a real transport action", () => {
    const withTransport =
      "I have guests tomorrow for afternoon tea. Ghulam will collect them from the airport. Handle what you can.";
    const tasks = buildDeterministicGuestPreparationTasks(realHousehold(), withTransport);
    const ghulam = tasks.find((t) => t.personName === "Ghulam");
    expect(ghulam).toBeDefined();
    expect(ghulam?.message).toMatch(/transport|standby/i);
  });

  it("does NOT add Ghulam for the agent's boilerplate 'standby for transport' (no real action)", () => {
    // Exact text the ElevenLabs agent injected in production — it names
    // "transport" and "Ghulam" but describes no actual pickup/dropoff. Ghulam
    // must stay out; Grace (Nanny) must stay out; result is the core three.
    const agentDecomposition =
      "Guests are coming for afternoon tea today at home. Christopher should prepare the food and tea. " +
      "Nasira should handle the hospitality setup and table presentation. Bahan coordinates the event. " +
      "Ghulam should be on standby for transport. Grace should follow up with all to make sure everything is ready on time.";
    const tasks = buildDeterministicGuestPreparationTasks(realHousehold(), agentDecomposition);
    expect(tasks.map((t) => t.personName)).toEqual(["Christopher", "Nasira", "Bahan"]);
  });

  it("never gives one person the whole plan", () => {
    const tasks = buildDeterministicGuestPreparationTasks(realHousehold(), TEA);
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    for (const t of tasks) {
      const bundlesEverything =
        /food/i.test(t.message) && /hospitality/i.test(t.message) && /coordinate/i.test(t.message);
      expect(bundlesEverything).toBe(false);
    }
    expect(new Set(tasks.map((t) => t.personName)).size).toBe(tasks.length);
  });
});

describe("hosting planning gate", () => {
  const GUEST_MISSING = "I have afternoon tea at home today. Handle it\n\nClarification details: At 4 PM. No shellfish";
  const TIME_MISSING = "I have afternoon tea at home today. Handle it\n\nClarification details: Six guests. No shellfish";
  const BOTH_MISSING = "I have afternoon tea at home today. Handle it";

  it.each(["6", "six", "6 guests", "six guests", "6 people", "six people", "there are 6", "we are 6", "for 6"])(
    "normalizes '%s' as guest count when guest count is the only missing numeric field",
    (answer) => {
      const normalized = normalizeHostingClarificationAnswer(answer, GUEST_MISSING);
      const gate = evaluateHostingPlanningGate(`${GUEST_MISSING}\n\nClarification details: ${normalized}`);
      expect(gate.brief.guestCount, answer).toBe("six guests");
    },
  );

  it.each(["6 and no shellfish", "six and no shellfish"])(
    "preserves '%s' guest count and dietary restriction together",
    (answer) => {
      const normalized = normalizeHostingClarificationAnswer(answer, GUEST_MISSING);
      const gate = evaluateHostingPlanningGate(`${GUEST_MISSING}\n\nClarification details: ${normalized}`);
      expect(gate.status).toBe("ready");
      expect(gate.brief.guestCount).toBe("six guests");
      expect(gate.brief.dietaryRequirements).toBe("No shellfish");
    },
  );

  it.each(["4", "four", "4pm", "4 pm", "at 4", "at four", "4:00", "4:00pm", "4:00 pm", "16:00", "today at 4"])(
    "normalizes '%s' as time when time is the only missing numeric field",
    (answer) => {
      const normalized = normalizeHostingClarificationAnswer(answer, TIME_MISSING);
      const gate = evaluateHostingPlanningGate(`${TIME_MISSING}\n\nClarification details: ${normalized}`);
      expect(gate.brief.startTime, answer).toMatch(/4(?::00)?\s*PM|16:00/i);
    },
  );

  it.each([
    ["4pm. 6 guests and no shellfish", "4:00 PM", "six guests"],
    ["4pm and 6", "4:00 PM", "six guests"],
    ["six at four", "4:00 PM", "six guests"],
  ])("parses combined clarification '%s' into time and guests", (answer, expectedTime, expectedGuests) => {
    const normalized = normalizeHostingClarificationAnswer(answer, BOTH_MISSING);
    const gate = evaluateHostingPlanningGate(`${BOTH_MISSING}\n\nClarification details: ${normalized}`);
    expect(gate.brief.startTime).toContain(expectedTime);
    expect(gate.brief.guestCount).toBe(expectedGuests);
    if (/shellfish/i.test(answer)) expect(gate.brief.dietaryRequirements).toMatch(/no shellfish/i);
  });

  it("does not guess a bare number when both time and guest count are missing", () => {
    const normalized = normalizeHostingClarificationAnswer("4", BOTH_MISSING);
    const gate = evaluateHostingPlanningGate(`${BOTH_MISSING}\n\nClarification details: ${normalized}`);
    expect(normalized).toBe("4");
    expect(gate.brief.startTime).toBeNull();
    expect(gate.brief.guestCount).toBeNull();
    expect(gate.question).toMatch(/what time should I plan for/i);
    expect(gate.question).toContain("how many guests are coming");
  });
  it("answers worker and deadline recall from the exact completed hosting operation", () => {
    const operation = {
      outcomeType: "guest_arrival" as const,
      sourceText: "I have afternoon tea at 4:00 PM today for six guests. No shellfish.",
      createdAt: Date.now(),
      proposalSpeech: "Full plan",
      executionStatus: "completed" as const,
      executionSummary: "Christopher and Grace have the plan.",
      tasks: [
        { personId: "c", personName: "Christopher", message: "Prepare finger sandwiches, scones, mini cakes, and tea with no shellfish. Have everything ready by 3:45 PM.", deliveryStatus: "sent" as const },
        { personId: "g", personName: "Grace", message: "Coordinate the table setup and confirm readiness by 3:30 PM.", deliveryStatus: "sent" as const },
      ],
    };

    expect(answerHostingOperationRecall("What did you ask Christopher to prepare?", operation)).toContain("finger sandwiches, scones, mini cakes, and tea");
    expect(answerHostingOperationRecall("What did you ask Grace to do?", operation)).toContain("Coordinate the table setup");
    expect(answerHostingOperationRecall("What time did you tell them to be ready?", operation)).toBe("I told them to be ready by 3:45 PM.");
    expect(answerHostingOperationRecall("Who received the plan?", operation)).toBe("Christopher and Grace received the plan.");
    expect(answerHostingOperationRecall("Ask Christopher what he is making", operation)).toBeNull();
  });

  it("normalizes bare and labeled guest counts from one through twenty only in clarification context", () => {
    const words = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
    const original = "I have afternoon tea at 4:00 PM today. Handle everything.";
    for (let index = 0; index < words.length; index += 1) {
      for (const answer of [String(index + 1), `${index + 1} guest`, `${index + 1} guests`, words[index], `${words[index]} guest`, `${words[index]} guests`]) {
        const gate = evaluateHostingPlanningGate(`${original}\n\nClarification details: ${answer}`);
        expect(gate.brief.guestCount, answer).toBe(`${words[index]} guests`);
      }
    }
    expect(buildHostingEventBrief("I have afternoon tea at 4:00 PM today. Handle everything.").guestCount).toBeNull();
    expect(buildHostingEventBrief("At 6 PM in room 6 on July 6.").guestCount).toBeNull();
  });

  it("combines guest count and dietary answers in one pending clarification", () => {
    const original = "I have afternoon tea at 4:00 PM today. Handle everything.";
    for (const answer of ["6 and no shellfish", "six and no shellfish", "6 guests and no shellfish", "six guests and no shellfish", "1 and no shellfish", "one guest and no shellfish", "12 and no shellfish", "twelve guests and no shellfish", "20 and no shellfish", "twenty guests and no shellfish"]) {
      const gate = evaluateHostingPlanningGate(`${original}\n\nClarification details: ${answer}`);
      expect(gate.status, answer).toBe("ready");
      expect(gate.brief.dietaryRequirements, answer).toMatch(/no shellfish/i);
    }
  });

  it("parses bare guest counts from the latest answer even after an earlier clarification", () => {
    const accumulated =
      "I have afternoon tea at 4:00 PM today. Handle everything.\n\n" +
      "Clarification details: I have afternoon tea at home today. Handle it\n\n" +
      "Clarification details: 6 and no shellfish";
    const gate = evaluateHostingPlanningGate(accumulated);

    expect(gate.status).toBe("ready");
    expect(gate.brief.guestCount).toBe("six guests");
    expect(gate.brief.dietaryRequirements).toBe("no shellfish");
  });

  it("never treats an afternoon-tea instruction as drinks or proposal copy", () => {
    const source =
      "I have afternoon tea at 4:00 PM today. Handle everything.\n\n" +
      "Clarification details: I have afternoon tea at home today. Handle it\n\n" +
      "Clarification details: Six guests. No shellfish.";
    const brief = buildHostingEventBrief(source);

    expect(brief.drinks).toBe("tea, coffee, and water");
    expect(brief.menu).toBe("finger sandwiches, scones, and mini cakes");
    expect(brief.menu).not.toContain("I have afternoon tea");
  });

  it("removes duplicated conjunctions when formatting generated menu details", () => {
    const gate = evaluateHostingPlanningGate("I have afternoon tea at 4:00 PM today. Handle everything.");
    expect(gate.brief.menu).toBe("finger sandwiches, scones, and mini cakes");
    expect(gate.brief.menu).not.toContain("and and");
  });

  it("makes one compact first proposal when authority and time are already supplied", () => {
    const gate = evaluateHostingPlanningGate("I have afternoon tea at 4:00 PM today. Handle everything.");

    expect(gate.status).toBe("needs_clarification");
    expect(gate.brief.startTime).toBe("4:00 PM");
    expect(gate.brief.date).toBe("today");
    expect(gate.brief.menu).toBe("finger sandwiches, scones, and mini cakes");
    expect(gate.brief.location).toBe("home");
    expect(gate.question).toBe("How many guests are coming, and is there anything I should avoid serving?");
    expect(gate.question).not.toMatch(/what time|where|what you would like served/i);
  });

  it("uses Chief-of-Staff defaults and asks only essential questions when time is missing", () => {
    const gate = evaluateHostingPlanningGate("I have afternoon tea at home today. Handle it");

    expect(gate.status).toBe("needs_clarification");
    expect(gate.brief.location).toBe("home");
    expect(gate.brief.menu).toBe("finger sandwiches, scones, and mini cakes");
    expect(gate.brief.drinks).toBe("tea, coffee, and water");
    expect(gate.brief.unresolvedRequiredFields).toEqual([
      "start_time",
      "guest_count",
      "dietary_requirements",
    ]);
    expect(gate.question).toBe(
      "What time should I plan for, how many guests are coming, and are there any dietary restrictions?",
    );
    expect(gate.question).not.toMatch(/where|what you would like served|food|drinks|staff/i);
  });

  it("keeps one operation through partial essentials and a final bare guest count", () => {
    const source =
      "I have afternoon tea at home today. Handle it\n\n" +
      "Clarification details: At 4 PM. Inside. No shellfish\n\n" +
      "Clarification details: 6";
    const gate = evaluateHostingPlanningGate(source);

    expect(gate.status).toBe("ready");
    expect(gate.brief.startTime).toBe("4 PM");
    expect(gate.brief.location).toBe("inside");
    expect(gate.brief.guestCount).toBe("six guests");
    expect(gate.brief.dietaryRequirements).toBe("No shellfish");
    expect(gate.brief.menu).toBe("finger sandwiches, scones, and mini cakes");
    expect(gate.brief.drinks).toBe("tea, coffee, and water");
  });

  it("asks only for guest count after the other essentials are answered", () => {
    const gate = evaluateHostingPlanningGate(
      "I have afternoon tea at home today. Handle it\n\n" +
      "Clarification details: At 4 PM. Inside. No shellfish",
    );

    expect(gate.status).toBe("needs_clarification");
    expect(gate.brief.unresolvedRequiredFields).toEqual(["guest_count"]);
    expect(gate.question).toBe("How many guests are coming?");
  });

  it("uses supplied guest count and restrictions without reopening known fields", () => {
    const gate = evaluateHostingPlanningGate(
      "I have afternoon tea at 4:00 PM today for five guests. No dietary restrictions. Handle everything.",
    );

    expect(gate.status).toBe("ready");
    expect(gate.brief.guestCount).toBe("five guests");
    expect(gate.brief.dietaryRequirements).toBe("No dietary restrictions");
    expect(gate.question).toBeNull();
  });
  it("treats a concrete no-food restriction as a complete dietary answer", () => {
    const gate = evaluateHostingPlanningGate("I have afternoon tea at 4:00 PM today. Handle everything.\n\nClarification details: Six guests. No shellfish.");
    expect(gate.status).toBe("ready");
    expect(gate.brief.guestCount).toBe("six guests");
    expect(gate.brief.dietaryRequirements).toBe("No shellfish");
    expect(gate.question).toBeNull();
  });

  it.each(["No garlic", "No onions", "No dairy", "Vegetarian", "Allergic to peanuts"])(
    "accepts natural dietary clarification '%s' without repeating the question",
    (restriction) => {
      const gate = evaluateHostingPlanningGate(
        `I have afternoon tea at 4:00 PM today for six guests. Handle everything.\n\nClarification details: ${restriction}`,
      );
      expect(gate.status).toBe("ready");
      expect(gate.brief.dietaryRequirements).toMatch(new RegExp(restriction, "i"));
      expect(gate.question).toBeNull();
    },
  );

  it("preserves time, guest count, and a natural restriction together", () => {
    const gate = evaluateHostingPlanningGate(
      "I have afternoon tea today. Handle everything.\n\nClarification details: 4pm. 6 guests and no garlic",
    );
    expect(gate.status).toBe("ready");
    expect(gate.brief.startTime).toMatch(/4:00 PM/i);
    expect(gate.brief.guestCount).toBe("six guests");
    expect(gate.brief.dietaryRequirements).toMatch(/no garlic/i);
  });

  it.each([
    ["4pm. 6 guests and no shellfish", "no shellfish"],
    ["six at four and no nuts", "no nuts"],
    ["16:00, 8 people, allergic to peanuts", "allergic to peanuts"],
  ])("extracts only the dietary span from '%s'", (answer, dietary) => {
    const gate = evaluateHostingPlanningGate(
      `I have afternoon tea today. Handle everything.\n\nClarification details: ${answer}`,
    );
    expect(gate.brief.dietaryRequirements).toBe(dietary);
    expect(gate.brief.dietaryRequirements).not.toMatch(/guests?|people|four|six|eight/i);
  });
  it("blocks the exact afternoon-tea failure when time, menu, and specific location are missing", () => {
    const gate = evaluateHostingPlanningGate("Handle afternoon tea at home today for me and three guests.");

    expect(gate.status).toBe("needs_clarification");
    expect(gate.brief.occasion).toBe("afternoon tea");
    expect(gate.brief.date).toBe("today");
    expect(gate.brief.guestCount).toBe("three guests");
    expect(gate.brief.location).toBe("home");
    expect(gate.brief.unresolvedRequiredFields).toEqual(["start_time", "menu", "location", "dietary_requirements"]);
    expect(gate.question).toMatch(/what time/i);
    expect(gate.question).toMatch(/where at home/i);
    expect(gate.question).toMatch(/what you would like served/i);
    expect(gate.question).toMatch(/dietary restrictions/i);
    expect(gate.question).not.toMatch(/china or flowers/i);
  });

  it("asks for menu or permission to suggest one when menu is missing", () => {
    const gate = evaluateHostingPlanningGate("Afternoon tea today at 4 PM in the garden for three guests.");

    expect(gate.status).toBe("needs_clarification");
    expect(gate.brief.unresolvedRequiredFields).toEqual(["menu", "dietary_requirements"]);
    expect(gate.question).toMatch(/what you would like served|suggest a menu/i);
  });

  it("preserves supplied date, location, and guest count in the structured brief", () => {
    const brief = buildHostingEventBrief(
      "Afternoon tea today at 4:30 PM in the garden for three guests. Serve sandwiches and tea.",
    );

    expect(brief.date).toBe("today");
    expect(brief.location).toBe("the garden");
    expect(brief.guestCount).toBe("three guests");
    expect(brief.startTime).toBe("4:30 PM");
    expect(brief.menu).toBe("sandwiches and tea");
  });

  it("lets a complete hosting brief proceed to shared worker-message generation", () => {
    const gate = evaluateHostingPlanningGate(
      "Afternoon tea today at 4:30 PM in the garden for three guests. Serve sandwiches, scones, cakes, tea, coffee, and water. No dietary restrictions. Use the blue china and flowers.",
    );

    expect(gate.status).toBe("ready");
    expect(gate.brief.unresolvedRequiredFields).toEqual([]);
  });

  it("preserves partial clarification details and asks only for time and dietary restrictions", () => {
    const original = "Handle afternoon tea for tomorrow at home for 5 guests";
    const answer =
      "Mini sandwiches, mini cakes, pastries and food finger. It should be indoors and use the pink floral China, pink flowers and the silver cutlery. Luxury setting";
    const linkedAnswer = evaluateHostingPlanningGate(`${original}\n\nClarification details: ${answer}`);

    expect(linkedAnswer.status).toBe("needs_clarification");
    expect(linkedAnswer.brief.occasion).toBe("afternoon tea");
    expect(linkedAnswer.brief.date).toBe("tomorrow");
    expect(linkedAnswer.brief.guestCount).toBe("five guests");
    expect(linkedAnswer.brief.startTime).toBeNull();
    expect(linkedAnswer.brief.location).toBe("inside");
    expect(linkedAnswer.brief.menu).toBe("Mini sandwiches, mini cakes, pastries and food finger");
    expect(linkedAnswer.brief.dietaryRequirements).toBeNull();
    expect(linkedAnswer.brief.china).toBe("pink floral China");
    expect(linkedAnswer.brief.flowers).toBe("pink flowers");
    expect(linkedAnswer.brief.unresolvedRequiredFields).toEqual(["start_time", "dietary_requirements"]);
    expect(linkedAnswer.question).toBe("What time should it begin, and are there any dietary restrictions?");
  });

  it("accumulates the exact three-turn hosting clarification into one complete brief", () => {
    const turn1 = "Handle afternoon tea at home today for me and three guests.";
    const turn2 =
      "Mini sandwiches, mini cakes, pastries and finger food. It should be indoors and use the pink floral china, pink flowers and the silver cutlery. Luxury setting.";
    const turn3 = "4:00 PM and no dietary restrictions";
    const afterTurn2 = evaluateHostingPlanningGate(`${turn1}\n\nClarification details: ${turn2}`);
    const afterTurn3 = evaluateHostingPlanningGate(
      `${turn1}\n\nClarification details: ${turn2}\n\nClarification details: ${turn3}`,
    );

    expect(afterTurn2.question).toBe("What time should it begin, and are there any dietary restrictions?");
    expect(afterTurn3.status).toBe("ready");
    expect(afterTurn3.brief.occasion).toBe("afternoon tea");
    expect(afterTurn3.brief.date).toBe("today");
    expect(afterTurn3.brief.guestCount).toBe("three guests");
    expect(afterTurn3.brief.startTime).toBe("4:00 PM");
    expect(afterTurn3.brief.location).toBe("inside");
    expect(afterTurn3.brief.menu).toBe("Mini sandwiches, mini cakes, pastries and finger food");
    expect(afterTurn3.brief.dietaryRequirements).toBe("no dietary restrictions");
    expect(afterTurn3.brief.china).toBe("pink floral china");
    expect(afterTurn3.brief.flowers).toBe("pink flowers");
    expect(afterTurn3.brief.unresolvedRequiredFields).toEqual([]);
  });

  it("does not ask again for fields already answered across clarification turns", () => {
    const gate = evaluateHostingPlanningGate(
      "Handle afternoon tea at home today for me and three guests.\n\n" +
      "Clarification details: Mini sandwiches, mini cakes, pastries and finger food. It should be indoors and use the pink floral china, pink flowers and the silver cutlery. Luxury setting.\n\n" +
      "Clarification details: 4:00 PM and no dietary restrictions",
    );

    expect(gate.question).toBeNull();
    expect(gate.brief.unresolvedRequiredFields).toEqual([]);
  });

  it("treats bare pavilion garden clarification as the specific hosting location", () => {
    const gate = evaluateHostingPlanningGate(
      "Handle afternoon tea for 3 guests today at home.\n\n" +
      "Clarification details: 4:00 PM\n" +
      "garden under the pavilion\n" +
      "finger sandwiches\n" +
      "scones with clotted cream and jam\n" +
      "mini cakes and pastries\n" +
      "tea and refreshments\n" +
      "no dietary restrictions",
    );

    expect(gate.status).toBe("ready");
    expect(gate.brief.location).toBe("garden under the pavilion");
    expect(gate.brief.unresolvedRequiredFields).toEqual([]);
    expect(gate.question).toBeNull();
  });

  it("treats the exact comma-separated production clarification as complete", () => {
    const gate = evaluateHostingPlanningGate(
      "Handle afternoon tea for 3 guests today at home.\n\n" +
      "Clarification details: 4:00 PM, garden under the pavilion, finger sandwiches, scones with clotted cream and jam, mini cakes and pastries, tea and refreshments, no dietary restrictions.",
    );

    expect(gate.status).toBe("ready");
    expect(gate.brief.location).toBe("garden under the pavilion");
    expect(gate.brief.startTime).toBe("4:00 PM");
    expect(gate.brief.dietaryRequirements).toBe("no dietary restrictions");
    expect(gate.brief.unresolvedRequiredFields).toEqual([]);
    expect(gate.question).toBeNull();
  });

  it("treats the exact clarification answer as needing only dietary info when linked to the original request", () => {
    const original = "Handle afternoon tea for me and three guests today at home.";
    const answer =
      "At 4 PM in the garden. Finger sandwiches, cakes and tea. Use the floral china and simple white flowers.";
    const linkedAnswer = evaluateHostingPlanningGate(`${original}\n\nClarification details: ${answer}`);

    expect(resolveGuestOutcomeAction(answer)).toBe("none");
    expect(resolveGuestOutcomeAction(`${original}\n\nClarification details: ${answer}`)).toBe("propose");
    expect(linkedAnswer.status).toBe("needs_clarification");
    expect(linkedAnswer.brief.occasion).toBe("afternoon tea");
    expect(linkedAnswer.brief.date).toBe("today");
    expect(linkedAnswer.brief.guestCount).toBe("three guests");
    expect(linkedAnswer.brief.startTime).toBe("4:00 PM");
    expect(linkedAnswer.brief.location).toBe("the garden");
    expect(linkedAnswer.brief.menu).toBe("Finger sandwiches, cakes and tea");
    expect(linkedAnswer.brief.dietaryRequirements).toBeNull();
    expect(linkedAnswer.brief.china).toBe("floral china");
    expect(linkedAnswer.brief.flowers).toBe("simple white flowers");
    expect(linkedAnswer.brief.unresolvedRequiredFields).toEqual(["dietary_requirements"]);
    expect(linkedAnswer.question).toBe("For afternoon tea, are there any dietary restrictions?");
  });

  it("shows a clear operational plan before approval after the exact clarification answer", () => {
    const sourceText =
      "Handle afternoon tea for me and three guests today at home.\n\n" +
      "Clarification details: At 4 PM in the garden. Finger sandwiches, cakes and tea. No dietary restrictions. Use the floral china and simple white flowers.";
    const plan = normalizeGuestPreparationPlan({
      outcomeType: "guest_arrival",
      sourceText,
      createdAt: Date.now(),
      proposalSpeech: "I can split this between the team. Should I send it?",
      tasks: [
        { personId: "christopher", personName: "Christopher", message: "Handle everything." },
      ],
    }, [
      person({ id: "christopher", name: "Christopher", role: "Cook", responsibilities: "Dinner, menu, kitchen, food." }),
      person({ id: "nasira", name: "Nasira", role: "Housekeeper", responsibilities: "Flowers, hospitality, table setup, guest rooms." }),
      person({ id: "bahan", name: "Bahan", role: "Coordinator", responsibilities: "Coordinate staff and follow up." }),
      person({ id: "grace", name: "Grace", role: "Nanny", responsibilities: "Childcare." }),
      person({ id: "ghulam", name: "Ghulam", role: "Driver", responsibilities: "Transport, car, airport pickups." }),
    ]);

    expect(plan.proposalSpeech).toBe(
      "Here is the plan for afternoon tea: 4 PM today in the garden for three guests. " +
      "The menu is Finger sandwiches, cakes and tea. " +
      "There are no dietary restrictions. " +
      "Setup will use floral china and simple white flowers. " +
      "Christopher handles food and drinks, Nasira handles setup, china, flowers, and table presentation, and Bahan coordinates readiness. Shall I send the plan?",
    );
    expect(plan.proposalSpeech).toContain("4 PM");
    expect(plan.proposalSpeech).toContain("today");
    expect(plan.proposalSpeech).toContain("the garden");
    expect(plan.proposalSpeech).toContain("three guests");
    expect(plan.proposalSpeech).toContain("Finger sandwiches, cakes and tea");
    expect(plan.proposalSpeech).toContain("floral china");
    expect(plan.proposalSpeech).toContain("simple white flowers");
    expect(plan.proposalSpeech).toContain("Christopher handles food and drinks");
    expect(plan.proposalSpeech).toContain("Nasira handles setup, china, flowers, and table presentation");
    expect(plan.proposalSpeech).toContain("Bahan coordinates readiness");
    expect(plan.proposalSpeech).not.toContain("Clarification details");
    expect(plan.proposalSpeech.match(/dietary restrictions/gi)).toHaveLength(1);
    expect(plan.proposalSpeech.match(/\?/g)).toHaveLength(1);
    expect(plan.proposalSpeech).toMatch(/Shall I send the plan\?$/);
  });

  it("preserves the exact production afternoon-tea details in the plan and worker messages", () => {
    const sourceText =
      "Handle afternoon tea for 3 guests today at home.\n\n" +
      "Clarification details: 4:00 PM, garden under the pavilion, finger sandwiches, scones with clotted cream and jam, mini cakes and pastries, tea and refreshments, no dietary restrictions.";
    const plan = normalizeGuestPreparationPlan({
      outcomeType: "guest_arrival",
      sourceText,
      createdAt: Date.now(),
      proposalSpeech: "I can send the afternoon tea plan. Shall I send it?",
      tasks: [
        { personId: "christopher", personName: "Christopher", message: "Please handle the food." },
      ],
    }, [
      person({ id: "christopher", name: "Christopher", role: "Cook", responsibilities: "Dinner, menu, kitchen, food." }),
      person({ id: "nasira", name: "Nasira", role: "Housekeeper", responsibilities: "Flowers, hospitality, table setup, guest rooms." }),
      person({ id: "bahan", name: "Bahan", role: "Coordinator", responsibilities: "Coordinate staff and follow up." }),
    ]);

    expect(plan.brief?.startTime).toBe("4:00 PM");
    expect(plan.brief?.location).toBe("garden under the pavilion");
    expect(plan.brief?.menu).toBe("finger sandwiches, scones with clotted cream and jam, mini cakes and pastries");
    expect(plan.brief?.drinks).toBe("tea and refreshments");
    expect(plan.brief?.dietaryRequirements).toBe("no dietary restrictions");
    expect(plan.brief?.menu).not.toMatch(/no dietary restrictions/i);

    expect(plan.proposalSpeech).toBe(
      "Here is the plan for afternoon tea: 4:00 PM today in the garden under the pavilion for three guests. " +
      "The menu is finger sandwiches, scones with clotted cream and jam, and mini cakes and pastries, with tea and refreshments. " +
      "There are no dietary restrictions. " +
      "Christopher handles food and drinks, Nasira handles setup, china, flowers, and table presentation, and Bahan coordinates readiness. Shall I send the plan?",
    );
    expect(plan.proposalSpeech.match(/dietary restrictions/gi)).toHaveLength(1);
    expect(plan.proposalSpeech).not.toContain("Setup will use garden");
    expect(plan.proposalSpeech).not.toContain("Clarification details");

    expect(plan.tasks.map((task) => task.personName)).toEqual(["Christopher", "Nasira", "Bahan"]);
    for (const task of plan.tasks) {
      expect(task.message).toContain("Sana is hosting afternoon tea for three guests today at 4:00 PM in the garden under the pavilion.");
      expect(task.message).not.toContain("Clarification details");
      expect(task.message).not.toMatch(/\bsana is hosting\b/);
      expect(task.message).not.toMatch(/\bMenu:|\bDrinks:|\bDietary requirements:|\bRequired result:/);
      expect(task.message).not.toMatch(/Tell Carson|Report .* to Carson/i);
    }
    expect(plan.tasks[0].message).toBe(
      "Sana is hosting afternoon tea for three guests today at 4:00 PM in the garden under the pavilion. " +
      "Please prepare finger sandwiches, scones with clotted cream and jam, mini cakes and pastries, tea, and refreshments. " +
      "There are no dietary restrictions. Please have everything ready by 3:45 PM.",
    );
    expect(plan.tasks[1].message).toBe(
      "Sana is hosting afternoon tea for three guests today at 4:00 PM in the garden under the pavilion. " +
      "Please prepare the table and guest area with suitable china, cups, plates, napkins, clean linens, water glasses, serving pieces, seating, and simple flowers if available. " +
      "Please have the setup ready by 3:30 PM.",
    );
    expect(plan.tasks[1].message.match(/serving pieces/g)).toHaveLength(1);
    expect(plan.tasks[2].message).toBe(
      "Sana is hosting afternoon tea for three guests today at 4:00 PM in the garden under the pavilion. " +
      "Please coordinate with Christopher and Nasira and confirm that the food, drinks, table setup, flowers, seating, and guest area are ready by 3:30 PM.",
    );
  });

  it("uses the unified operation lifecycle to preserve clarification state before planning", async () => {
    const firstTurn = await prepareOperationalPlanTurn({
      message: "Handle afternoon tea at home today for me and three guests.",
      people: [],
      askedAtClientMessageId: "typed-1",
    });

    expect(firstTurn.status).toBe("needs_clarification");
    expect(firstTurn.draft?.sourceText).toBe("Handle afternoon tea at home today for me and three guests.");
    expect(firstTurn.draft?.askedAtClientMessageId).toBe("typed-1");
    expect(firstTurn.question).toMatch(/what time/i);

    const secondTurn = await prepareOperationalPlanTurn({
      message: "Mini sandwiches, mini cakes, pastries and finger food. It should be indoors and use the pink floral china, pink flowers and the silver cutlery. Luxury setting.",
      people: [],
      pendingDraft: firstTurn.draft,
      askedAtClientMessageId: "typed-2",
    });

    expect(secondTurn.status).toBe("needs_clarification");
    expect(secondTurn.draft?.sourceText).toContain("Clarification details: Mini sandwiches");
    expect(secondTurn.question).toBe("What time should it begin, and are there any dietary restrictions?");
  });

  it("supersedes an active draft when the next message is a fresh hosting request", async () => {
    const turn = await prepareOperationalPlanTurn({
      message: "I have dinner at home tomorrow. Handle it.",
      people: [],
      pendingDraft: {
        operationId: "old-operation",
        operationType: "guest_arrival",
        sourceText: "I have afternoon tea at 4:00 PM today. Handle everything.",
        askedAtClientMessageId: "old-message",
      },
      askedAtClientMessageId: "new-message",
    });

    expect(turn.status).toBe("needs_clarification");
    expect(turn.sourceText).toBe("I have dinner at home tomorrow. Handle it.");
    expect(turn.sourceText).not.toContain("afternoon tea");
    expect(turn.draft?.operationId).not.toBe("old-operation");
  });

  it("keeps the same canonical operation ID across clarification turns", async () => {
    const turn = await prepareOperationalPlanTurn({
      message: "Use the garden.",
      people: [],
      pendingDraft: {
        operationId: "operation-123",
        operationType: "guest_arrival",
        sourceText: "I have afternoon tea at home today. Handle it.",
        askedAtClientMessageId: "message-1",
      },
      askedAtClientMessageId: "message-2",
    });

    expect(turn.status).toBe("needs_clarification");
    expect(turn.draft?.operationId).toBe("operation-123");
    expect(turn.draft?.sourceText).toContain("Clarification details: Use the garden.");
  });

  it("uses the unified operation lifecycle to create one stored plan from the complete brief", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        content: [{
          text: JSON.stringify({
            tasks: [
              { person_name: "Christopher", message: "Please handle the food." },
              { person_name: "Nasira", message: "Please handle the table." },
              { person_name: "Grace", message: "Please coordinate readiness." },
            ],
            proposal_speech: "I can send the afternoon tea plan. Shall I send it?",
          }),
        }],
      }),
    })));

    const turn = await prepareOperationalPlanTurn({
      message:
        "Handle afternoon tea at home today for me and three guests.\n\n" +
        "Clarification details: At 4 PM in the garden. Finger sandwiches, cakes and tea. No dietary restrictions. Use the floral china and simple white flowers.",
      people: guestTeam(),
      askedAtClientMessageId: "typed-3",
    });

    expect(turn.status).toBe("ready");
    expect(turn.action).toBe("propose");
    expect(turn.plan?.sourceText).toContain("Clarification details: At 4 PM");
    expect(turn.plan?.brief?.startTime).toBe("4 PM");
    expect(turn.plan?.brief?.location).toBe("the garden");
    expect(turn.plan?.brief?.menu).toBe("Finger sandwiches, cakes and tea");
    expect(turn.plan?.brief?.dietaryRequirements).toBe("No dietary restrictions");
    expect(turn.plan?.tasks.map((task) => task.personName)).toEqual(["Christopher", "Nasira", "Grace"]);
  });

  it("proposes Carson-selected afternoon-tea menu and drinks after the final essential answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        content: [{
          text: JSON.stringify({
            tasks: [
              { person_name: "Christopher", message: "Please handle the food." },
              { person_name: "Nasira", message: "Please handle the table." },
              { person_name: "Grace", message: "Please coordinate readiness." },
            ],
            proposal_speech: "Draft proposal.",
          }),
        }],
      }),
    })));

    const turn = await prepareOperationalPlanTurn({
      message:
        "I have afternoon tea at home today. Handle it\n\n" +
        "Clarification details: At 4 PM. Inside. No shellfish\n\n" +
        "Clarification details: 6",
      people: guestTeam(),
    });

    expect(turn.status).toBe("ready");
    expect(turn.plan?.brief?.menu).toBe("finger sandwiches, scones, and mini cakes");
    expect(turn.plan?.brief?.drinks).toBe("tea, coffee, and water");
    expect(turn.plan?.proposalSpeech).toContain(
      "The menu is finger sandwiches, scones, and mini cakes, with tea, coffee, and water.",
    );
    expect(turn.plan?.proposalSpeech).not.toContain("I have afternoon tea at home today");
  });
});

// ── Confirm-before-send: propose → verbatim "Yes" → execute once ─────────────
describe("guest plan confirm-before-send", () => {
  function stubSavePending() {
    mocks.savePending.mockImplementationOnce(async (items: ExtractedItem[]) => ({
      tasks: items.map((item, i) => ({
        id: `task-${i + 1}`,
        type: "delegation",
        assigned_to: item.assignedTo,
        description: item.description,
      })),
      messages: items.map((item, i) => ({
        id: `message-${i + 1}`,
        task_id: `task-${i + 1}`,
        recipient: item.assignedTo,
        content: item.suggestedMessage ?? item.description,
        confirmation_url: `https://ra7etbal.test/confirm?task=task-${i + 1}`,
      })) as Message[],
      todos: [],
      notesSaved: 0,
      skipped: 0,
      imagePathsByTaskId: new Map(),
    }));
  }

  function storedPlan() {
    // The plan Carson proposes and stores when it asks "Should I send it?"
    return normalizeGuestPreparationPlan({
      outcomeType: "guest_arrival",
      sourceText: "I have guests tomorrow for afternoon tea. Handle what you can.",
      createdAt: Date.now(),
      proposalSpeech: "I can split this between the team. Should I send it?",
      tasks: [
        { personId: "christopher", personName: "Christopher", message: "Handle everything." },
      ],
    }, guestTeam());
  }

  it("resolves a verbatim confirmation to confirm, even if a later source is noisy", () => {
    expect(resolvePendingPlanDecision("Yes.")).toBe("confirm");
    expect(resolvePendingPlanDecision("Yes send it")).toBe("confirm");
    expect(resolvePendingPlanDecision("go ahead")).toBe("confirm");
    // Robust to EL routing: confirm if EITHER source is a confirmation.
    expect(resolvePendingPlanDecision("send the messages to everyone", "yes")).toBe("confirm");
    expect(resolvePendingPlanDecision("no", "yes")).toBe("reject"); // rejection wins
    expect(resolvePendingPlanDecision("cancel")).toBe("reject");
  });

  it("holds (never sends) on an empty or noisy reply", () => {
    expect(resolvePendingPlanDecision("")).toBe("hold");
    expect(resolvePendingPlanDecision("um what were we saying")).toBe("hold");
  });

  it("executes the exact stored plan on 'Yes' and sends every recipient once", async () => {
    stubSavePending();
    mocks.deliverTaskMessage.mockResolvedValue({ success: true, channel: "whatsapp" });

    const plan = storedPlan();
    const turn = await handlePendingPlanTurn(["Yes."], plan, {
      displayName: "Sana",
      userId: "user-1",
      people: guestTeam(),
    });

    expect(turn.action).toBe("executed");
    expect(turn.clearPlan).toBe(true);
    const saved = mocks.savePending.mock.calls[0][0] as ExtractedItem[];
    expect(saved.map((i) => i.assignedTo)).toEqual(["Christopher", "Nasira", "Grace"]);
    expect(mocks.deliverTaskMessage.mock.calls.map(([p]) => p.recipientName)).toEqual([
      "Christopher",
      "Nasira",
      "Grace",
    ]);
  });

  it("executes every approved hosting assignment for Christopher, Nasira, and Bahan on 'Yes send it'", async () => {
    const people = [
      person({ id: "christopher", name: "Christopher", role: "Cook", responsibilities: "Food and drinks." }),
      person({ id: "nasira", name: "Nasira", role: "Housekeeper", responsibilities: "Setup, china, flowers, and table presentation." }),
      person({ id: "bahan", name: "Bahan", role: "Coordinator", responsibilities: "Coordinate readiness." }),
    ];
    const plan = {
      outcomeType: "guest_arrival" as const,
      sourceText:
        "Handle afternoon tea at home today for three guests.\n\n" +
        "Clarification details: At 4 PM in the garden. Finger sandwiches, cakes and tea. No dietary restrictions. Use the floral china and simple white flowers.",
      createdAt: Date.now(),
      proposalSpeech:
        "Christopher handles food and drinks, Nasira handles setup, china, flowers, and table presentation, and Bahan coordinates readiness. Shall I send the plan?",
      tasks: [
        { personId: "christopher", personName: "Christopher", message: "Food assignment." },
        { personId: "nasira", personName: "Nasira", message: "Setup assignment." },
        { personId: "bahan", personName: "Bahan", message: "Coordination assignment." },
      ],
    };
    mocks.savePending.mockImplementationOnce(async (items: ExtractedItem[]) => ({
      tasks: items.map((item, i) => ({
        id: `task-${i + 1}`,
        type: "delegation",
        assigned_to: item.assignedTo,
        description: item.description,
      })),
      messages: items.map((item, i) => ({
        id: `message-${i + 1}`,
        task_id: `task-${i + 1}`,
        recipient: item.assignedTo,
        content: item.suggestedMessage ?? item.description,
        confirmation_url: `https://ra7etbal.test/confirm?task=task-${i + 1}`,
      })) as Message[],
      todos: [],
      notesSaved: 0,
      skipped: 0,
      imagePathsByTaskId: new Map(),
    }));
    mocks.deliverTaskMessage.mockResolvedValue({ success: true, channel: "whatsapp" });

    const turn = await handlePendingPlanTurn(["Yes send it"], plan, {
      displayName: "Sana",
      userId: "user-1",
      people,
    });

    expect(turn.action).toBe("executed");
    expect((mocks.savePending.mock.calls[0][0] as ExtractedItem[]).map((item) => item.assignedTo)).toEqual([
      "Christopher",
      "Nasira",
      "Bahan",
    ]);
    expect(mocks.deliverTaskMessage.mock.calls.map(([payload]) => payload.recipientName)).toEqual([
      "Christopher",
      "Nasira",
      "Bahan",
    ]);
    expect(mocks.deliverTaskMessage.mock.calls.map(([payload]) => payload.confirmationLink)).toEqual([
      "https://ra7etbal.test/confirm?task=task-1",
      "https://ra7etbal.test/confirm?task=task-2",
      "https://ra7etbal.test/confirm?task=task-3",
    ]);
    expect(turn.summary).toContain("Christopher, Nasira, Bahan have the plan");
  });

  it("reports an approved assignment explicitly if task/message creation omits it", async () => {
    const people = [
      person({ id: "christopher", name: "Christopher", role: "Cook", responsibilities: "Food and drinks." }),
      person({ id: "nasira", name: "Nasira", role: "Housekeeper", responsibilities: "Setup." }),
      person({ id: "bahan", name: "Bahan", role: "Coordinator", responsibilities: "Coordinate readiness." }),
    ];
    const plan = {
      outcomeType: "guest_arrival" as const,
      sourceText: "Afternoon tea today at 4 PM in the garden for three guests.",
      createdAt: Date.now(),
      proposalSpeech: "Plan.",
      tasks: [
        { personId: "christopher", personName: "Christopher", message: "Food assignment." },
        { personId: "nasira", personName: "Nasira", message: "Setup assignment." },
        { personId: "bahan", personName: "Bahan", message: "Coordination assignment." },
      ],
    };
    mocks.savePending.mockImplementationOnce(async (items: ExtractedItem[]) => {
      const savedItems = items.filter((item) => item.assignedTo !== "Nasira");
      return {
        tasks: savedItems.map((item, i) => ({
          id: `task-${i + 1}`,
          type: "delegation",
          assigned_to: item.assignedTo,
          description: item.description,
        })),
        messages: savedItems.map((item, i) => ({
          id: `message-${i + 1}`,
          task_id: `task-${i + 1}`,
          recipient: item.assignedTo,
          content: item.suggestedMessage ?? item.description,
          confirmation_url: `https://ra7etbal.test/confirm?task=task-${i + 1}`,
        })) as Message[],
        todos: [],
        notesSaved: 0,
        skipped: 0,
        imagePathsByTaskId: new Map(),
      };
    });
    mocks.deliverTaskMessage.mockResolvedValue({ success: true, channel: "whatsapp" });

    const turn = await handlePendingPlanTurn(["Yes send it"], plan, {
      displayName: "Sana",
      userId: "user-1",
      people,
    });

    expect(mocks.deliverTaskMessage.mock.calls.map(([payload]) => payload.recipientName)).toEqual([
      "Christopher",
      "Bahan",
    ]);
    expect(turn.summary).toContain("Christopher, Bahan have the plan");
    expect(turn.summary).toContain("Nasira was NOT messaged — approved assignment was not created in Ra7etBal");
  });

  it("does not send when the reply is held", async () => {
    const turn = await handlePendingPlanTurn(["um, hang on"], storedPlan(), {
      displayName: "Sana",
      userId: "user-1",
      people: guestTeam(),
    });
    expect(turn.action).toBe("held");
    expect(turn.clearPlan).toBe(false);
    expect(mocks.savePending).not.toHaveBeenCalled();
    expect(mocks.deliverTaskMessage).not.toHaveBeenCalled();
  });

  it("cancels on a verbatim rejection without sending", async () => {
    const turn = await handlePendingPlanTurn(["no"], storedPlan(), {
      displayName: "Sana",
      userId: "user-1",
      people: guestTeam(),
    });
    expect(turn.action).toBe("cancelled");
    expect(turn.clearPlan).toBe(true);
    expect(mocks.deliverTaskMessage).not.toHaveBeenCalled();
  });

  it("is idempotent: a duplicate 'Yes' for the same plan sends nothing more", async () => {
    stubSavePending();
    mocks.deliverTaskMessage.mockResolvedValue({ success: true, channel: "whatsapp" });
    const plan = storedPlan();
    plan.dbId = "plan-db-1";

    await handlePendingPlanTurn(["Yes."], plan, { displayName: "Sana", userId: "user-1", people: guestTeam() });
    expect(mocks.deliverTaskMessage).toHaveBeenCalledTimes(3);

    const again = await handlePendingPlanTurn(["Yes."], plan, { displayName: "Sana", userId: "user-1", people: guestTeam() });
    expect(again.summary).toMatch(/already sent/i);
    expect(mocks.deliverTaskMessage).toHaveBeenCalledTimes(3);
    expect(mocks.savePending).toHaveBeenCalledTimes(1);
  });
});

// ── Production baseline lock-in (RA7ETBAL_STATE.md verified hosting loop) ─────
// Exact verified phrases from the production-confirmed afternoon-tea flow.
describe("production baseline — verified afternoon-tea hosting loop", () => {
  const TRIGGER = "I have afternoon tea at home tomorrow. Handle it.";

  it("routes the exact verified trigger phrase to the hosting engine, not ordinary delegation", () => {
    expect(detectHouseholdOutcome(TRIGGER)).toBe("guest_arrival");
    expect(mustRouteGuestEventToPlanner(TRIGGER)).toBe(true);
    expect(resolveGuestOutcomeAction(TRIGGER)).not.toBe("none");
  });

  it("asks one combined clarification and does not create an operation before it is answered", async () => {
    const gate = evaluateHostingPlanningGate(TRIGGER);
    expect(gate.status).toBe("needs_clarification");
    expect(gate.question).toMatch(/what time/i);
    expect(gate.question).toMatch(/how many guests/i);
    expect(gate.question).toMatch(/dietary restrictions/i);

    const turn = await prepareOperationalPlanTurn({ message: TRIGGER, people: [] });
    expect(turn.status).toBe("needs_clarification");
    expect(turn.plan).toBeNull();
    expect(mocks.savePending).not.toHaveBeenCalled();
    expect(mocks.deliverTaskMessage).not.toHaveBeenCalled();
    expect(mocks.sendDirectMessageRecord).not.toHaveBeenCalled();
  });

  it.each([
    ["4:00pm for 6 people, no garlic", "4:00 PM", "six guests", /no garlic/i],
    ["4pm, 6 guests and no garlic", "4:00 PM", "six guests", /no garlic/i],
  ])(
    "parses the exact combined clarification '%s' into clean independent fields",
    (answer, expectedTime, expectedGuests, dietaryPattern) => {
      const normalized = normalizeHostingClarificationAnswer(answer, TRIGGER);
      const gate = evaluateHostingPlanningGate(`${TRIGGER}\n\nClarification details: ${normalized}`);

      expect(gate.status).toBe("ready");
      expect(gate.brief.startTime).toContain(expectedTime);
      expect(gate.brief.guestCount).toBe(expectedGuests);
      expect(gate.brief.dietaryRequirements).toMatch(dietaryPattern);
      // The dietary value must never absorb guest count, time, or connector fragments.
      expect(gate.brief.dietaryRequirements).not.toMatch(/\bguests?\b|\bpeople\b|\b4(:00)?\s*(pm)?\b|\bsix\b/i);
    },
  );

  it("presents one complete proposal with correct worker responsibilities after the combined answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        content: [{
          text: JSON.stringify({
            tasks: [
              { person_name: "Christopher", message: "Please handle the food." },
              { person_name: "Nasira", message: "Please handle the table." },
              { person_name: "Grace", message: "Please coordinate readiness." },
            ],
            proposal_speech: "Draft.",
          }),
        }],
      }),
    })));

    const firstTurn = await prepareOperationalPlanTurn({ message: TRIGGER, people: [] });
    const turn = await prepareOperationalPlanTurn({
      message: "4:00pm for 6 people, no garlic",
      people: guestTeam(),
      pendingDraft: firstTurn.draft,
    });

    expect(turn.status).toBe("ready");
    expect(turn.plan?.brief?.occasion).toBe("afternoon tea");
    expect(turn.plan?.brief?.startTime).toBe("4:00 PM");
    expect(turn.plan?.brief?.guestCount).toBe("six guests");
    expect(turn.plan?.brief?.dietaryRequirements).toMatch(/no garlic/i);
    expect(turn.plan?.tasks.map((task) => task.personName)).toEqual(["Christopher", "Nasira", "Grace"]);
    expect(turn.plan?.tasks[0].message).toMatch(/no garlic/i);
    expect(turn.plan?.tasks[1].message).toMatch(/table and guest area/i);
    expect(turn.plan?.tasks[2].message).toMatch(/coordinate with Christopher and Nasira/i);
    // Exactly one approval question in the proposal.
    expect((turn.plan?.proposalSpeech.match(/\?/g) ?? []).length).toBe(1);
  });

  it("reports truthful per-recipient delivery when one worker has no phone number on file", async () => {
    mocks.savePending.mockImplementationOnce(async (items: ExtractedItem[]) => ({
      tasks: items.map((item, i) => ({
        id: `task-${i + 1}`,
        type: "delegation",
        assigned_to: item.assignedTo,
        description: item.description,
      })),
      messages: items.map((item, i) => ({
        id: `message-${i + 1}`,
        task_id: `task-${i + 1}`,
        recipient: item.assignedTo,
        content: item.suggestedMessage ?? item.description,
        confirmation_url: `https://ra7etbal.test/confirm?task=task-${i + 1}`,
      })) as Message[],
      todos: [],
      notesSaved: 0,
      skipped: 0,
      imagePathsByTaskId: new Map(),
    }));
    mocks.deliverTaskMessage.mockImplementation(async (payload: { to: string | null }) => (
      payload.to
        ? { success: true, channel: "whatsapp" }
        : { success: false, channel: "failed", error: "recipient phone number is missing" }
    ));

    const teamWithMissingPhone = guestTeam().map((p) =>
      p.name === "Nasira" ? { ...p, phone: null, whatsapp_opted_in: false } : p,
    );

    const plan = normalizeGuestPreparationPlan({
      outcomeType: "guest_arrival",
      sourceText: `${TRIGGER}\n\nClarification details: 4:00pm for 6 people, no garlic`,
      createdAt: Date.now(),
      proposalSpeech: "Plan.",
      tasks: [{ personId: "christopher", personName: "Christopher", message: "Handle it." }],
    }, teamWithMissingPhone);

    const summary = await executeProposedPlan(plan, {
      displayName: "Sana",
      userId: "user-1",
      people: teamWithMissingPhone,
    });

    expect(summary).toContain("Christopher, Grace have the plan");
    expect(summary).toMatch(/Nasira was NOT messaged/i);
    expect(summary).not.toMatch(/everyone|all workers|all staff/i);
  });

  it("answers 'What did you ask Christopher?' from the stored operation with no new send and no new operation", async () => {
    mocks.supabaseGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    const operationRow = {
      id: "op-1",
      type: "guest_arrival",
      tasks: [
        { personId: "c", personName: "Christopher", taskId: "task-c", deliveryStatus: "sent", message: "Prepare finger sandwiches, scones, and tea with no garlic. Have everything ready by 3:45 PM." },
        { personId: "n", personName: "Nasira", taskId: null, deliveryStatus: "not_created", message: "Prepare the table and guest area." },
        { personId: "g", personName: "Grace", taskId: "task-g", deliveryStatus: "sent", message: "Coordinate with Christopher and Nasira." },
      ],
      summary: "Christopher, Grace have the plan. Nasira was NOT messaged — approved assignment was not created in Ra7etBal.",
      source_text: `${TRIGGER}\n\nClarification details: 4:00pm for 6 people, no garlic`,
      created_at: "2026-07-24T10:00:00.000Z",
    };
    const writeLog: string[] = [];
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "carson_pending_operations") {
        return queryStubWithWriteTracking(table, { data: operationRow, error: null }, writeLog);
      }
      return queryStubWithWriteTracking(table, { data: null, error: null }, writeLog);
    });

    const answer = await resolveHostingOperationRecall("What did you ask Christopher?");

    expect(answer).toContain("Christopher was told: Prepare finger sandwiches, scones, and tea with no garlic");
    expect(writeLog).toEqual([]); // no insert/update/delete during recall — no duplicate operation
    expect(mocks.savePending).not.toHaveBeenCalled();
    expect(mocks.deliverTaskMessage).not.toHaveBeenCalled();
    expect(mocks.sendDirectMessageRecord).not.toHaveBeenCalled();
  });

  it("answers a worker-confirmation recall from verified task rows only, with no new send", async () => {
    mocks.supabaseGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    const operationRow = {
      id: "op-1",
      type: "guest_arrival",
      tasks: [
        { personId: "c", personName: "Christopher", taskId: "task-c", deliveryStatus: "sent", message: "Prepare food." },
        { personId: "g", personName: "Grace", taskId: "task-g", deliveryStatus: "sent", message: "Coordinate readiness." },
      ],
      summary: "Christopher, Grace have the plan.",
      source_text: TRIGGER,
      created_at: "2026-07-24T10:00:00.000Z",
    };
    const taskRows = [
      { id: "task-c", assigned_to: "Christopher", status: "done", confirmed_at: "2026-07-24T12:00:00Z" },
      { id: "task-g", assigned_to: "Grace", status: "pending", confirmed_at: null },
    ];
    const writeLog: string[] = [];
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === "carson_pending_operations") {
        return queryStubWithWriteTracking(table, { data: operationRow, error: null }, writeLog);
      }
      if (table === "tasks") {
        return queryStubWithWriteTracking(table, { data: taskRows, error: null }, writeLog);
      }
      return queryStubWithWriteTracking(table, { data: null, error: null }, writeLog);
    });

    const answer = await resolveHostingOperationRecall("Has Christopher confirmed?");

    expect(answer).toBe("Christopher has confirmed.");
    expect(writeLog).toEqual([]);
    expect(mocks.deliverTaskMessage).not.toHaveBeenCalled();
    expect(mocks.sendDirectMessageRecord).not.toHaveBeenCalled();
  });

  it("returns null (no fabricated answer) when there is no completed hosting operation to recall", async () => {
    mocks.supabaseGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    mocks.supabaseFrom.mockImplementation(() => queryStub({ data: null, error: null }));

    await expect(resolveHostingOperationRecall("What did you ask Christopher?")).resolves.toBeNull();
  });
});

// ── Production baseline lock-in (RA7ETBAL_STATE.md verified dinner loop) ──────
// Exact verified phrases from the production-confirmed dinner flow: Christopher
// (food) and Grace (coordination) delivered; Nasira was assigned but not
// reached because her phone number was missing; Carson reported each
// recipient's real outcome truthfully; no duplicate send occurred on repeated
// approval. See RA7ETBAL_STATE.md for the full verified transcript.
describe("production baseline — verified dinner hosting loop (Christopher, Grace; missing Nasira number)", () => {
  const TRIGGER = "I have a dinner at home tomorrow for 4 people. Handle it.";

  it("routes the exact verified trigger phrase to the hosting engine, not ordinary delegation", () => {
    expect(detectHouseholdOutcome(TRIGGER)).toBe("guest_arrival");
    expect(mustRouteGuestEventToPlanner(TRIGGER)).toBe(true);
    expect(resolveGuestOutcomeAction(TRIGGER)).not.toBe("none");
  });

  it("asks only for time and dietary restrictions — guest count is already known from the trigger", () => {
    const gate = evaluateHostingPlanningGate(TRIGGER);
    expect(gate.status).toBe("needs_clarification");
    expect(gate.question).toMatch(/what time/i);
    expect(gate.question).toMatch(/dietary restrictions/i);
    expect(gate.question).not.toMatch(/how many guests/i);
  });

  it("parses the combined clarification into clean independent fields", () => {
    const normalized = normalizeHostingClarificationAnswer("8:00pm, no shellfish", TRIGGER);
    const gate = evaluateHostingPlanningGate(`${TRIGGER}\n\nClarification details: ${normalized}`);

    expect(gate.status).toBe("ready");
    expect(gate.brief.startTime).toContain("8:00 PM");
    expect(gate.brief.guestCount).toBe("four people");
    expect(gate.brief.dietaryRequirements).toMatch(/no shellfish/i);
    expect(gate.brief.dietaryRequirements).not.toMatch(/\bpeople\b|\b8(:00)?\s*(pm)?\b|\bfour\b/i);
  });

  it("assigns Christopher the food instruction, Grace the coordination instruction, and Nasira the setup instruction", () => {
    const sourceText = `${TRIGGER}\n\nClarification details: 8:00 PM and no shellfish`;
    const plan = normalizeGuestPreparationPlan({
      outcomeType: "guest_arrival",
      sourceText,
      createdAt: Date.now(),
      proposalSpeech: "Draft.",
      tasks: [{ personId: "christopher", personName: "Christopher", message: "Handle it." }],
    }, guestTeam());

    expect(plan.tasks.map((task) => task.personName)).toEqual(["Christopher", "Nasira", "Grace"]);
    expect(plan.tasks[0].message).toMatch(/prepare the agreed food/i);
    expect(plan.tasks[0].message).toMatch(/no shellfish/i);
    expect(plan.tasks[1].message).toMatch(/table and guest area/i);
    expect(plan.tasks[2].message).toMatch(/coordinate with Christopher and Nasira/i);
    // Exactly one approval question in the proposal.
    expect((plan.proposalSpeech.match(/\?/g) ?? []).length).toBe(1);
  });

  it("delivers to Christopher and Grace once each; a missing Nasira phone number does not block either of them, and Carson reports each recipient truthfully", async () => {
    mocks.savePending.mockImplementationOnce(async (items: ExtractedItem[]) => ({
      tasks: items.map((item, i) => ({
        id: `task-${i + 1}`,
        type: "delegation",
        assigned_to: item.assignedTo,
        description: item.description,
      })),
      messages: items.map((item, i) => ({
        id: `message-${i + 1}`,
        task_id: `task-${i + 1}`,
        recipient: item.assignedTo,
        content: item.suggestedMessage ?? item.description,
        confirmation_url: `https://ra7etbal.test/confirm?task=task-${i + 1}`,
      })) as Message[],
      todos: [],
      notesSaved: 0,
      skipped: 0,
      imagePathsByTaskId: new Map(),
    }));
    mocks.deliverTaskMessage.mockImplementation(async (payload: { to: string | null }) => (
      payload.to
        ? { success: true, channel: "whatsapp" }
        : { success: false, channel: "failed", error: "recipient phone number is missing" }
    ));

    const teamWithMissingPhone = guestTeam().map((p) =>
      p.name === "Nasira" ? { ...p, phone: null, whatsapp_opted_in: false } : p,
    );

    const plan = normalizeGuestPreparationPlan({
      outcomeType: "guest_arrival",
      sourceText: `${TRIGGER}\n\nClarification details: 8:00 PM and no shellfish`,
      createdAt: Date.now(),
      proposalSpeech: "Plan.",
      tasks: [{ personId: "christopher", personName: "Christopher", message: "Handle it." }],
    }, teamWithMissingPhone);

    const summary = await executeProposedPlan(plan, {
      displayName: "Sana",
      userId: "user-1",
      people: teamWithMissingPhone,
    });

    // Christopher and Grace each get exactly one delivery attempt, and it succeeds.
    const deliveredTo = mocks.deliverTaskMessage.mock.calls.map(([payload]) => payload.recipientName);
    expect(deliveredTo.filter((name: string) => name === "Christopher")).toHaveLength(1);
    expect(deliveredTo.filter((name: string) => name === "Grace")).toHaveLength(1);
    expect(deliveredTo.filter((name: string) => name === "Nasira")).toHaveLength(1); // attempted, not skipped

    expect(summary).toContain("Christopher, Grace have the plan");
    expect(summary).toMatch(/Nasira was NOT messaged/i);
    // Never claims the unreachable recipient was actually contacted.
    expect(summary).not.toMatch(/Nasira (?:has|have) the plan/i);
    expect(summary).not.toMatch(/everyone|all workers|all staff/i);
  });

  it("is idempotent: a duplicate approval for the same plan sends nothing more", async () => {
    mocks.savePending.mockImplementationOnce(async (items: ExtractedItem[]) => ({
      tasks: items.map((item, i) => ({
        id: `task-${i + 1}`,
        type: "delegation",
        assigned_to: item.assignedTo,
        description: item.description,
      })),
      messages: items.map((item, i) => ({
        id: `message-${i + 1}`,
        task_id: `task-${i + 1}`,
        recipient: item.assignedTo,
        content: item.suggestedMessage ?? item.description,
        confirmation_url: `https://ra7etbal.test/confirm?task=task-${i + 1}`,
      })) as Message[],
      todos: [],
      notesSaved: 0,
      skipped: 0,
      imagePathsByTaskId: new Map(),
    }));
    mocks.deliverTaskMessage.mockResolvedValue({ success: true, channel: "whatsapp" });

    const plan = normalizeGuestPreparationPlan({
      outcomeType: "guest_arrival",
      sourceText: `${TRIGGER}\n\nClarification details: 8:00 PM and no shellfish`,
      createdAt: Date.now(),
      proposalSpeech: "Draft.",
      tasks: [{ personId: "christopher", personName: "Christopher", message: "Handle it." }],
    }, guestTeam());
    plan.dbId = "plan-db-dinner-1";

    const first = await handlePendingPlanTurn(["Yes."], plan, { displayName: "Sana", userId: "user-1", people: guestTeam() });
    expect(first.action).toBe("executed");
    expect(mocks.deliverTaskMessage).toHaveBeenCalledTimes(3);

    const again = await handlePendingPlanTurn(["Yes."], plan, { displayName: "Sana", userId: "user-1", people: guestTeam() });
    expect(again.summary).toMatch(/already sent/i);
    expect(mocks.deliverTaskMessage).toHaveBeenCalledTimes(3); // no additional attempts
    expect(mocks.savePending).toHaveBeenCalledTimes(1); // no duplicate operation created
  });

  it("protects the exact reproduced 'Yes, send both' phrasing as a leading-confirmation-with-no-plan case", () => {
    // The exact production reply that exposed the Guard C gap (fixed in a
    // prior pass): when no plan is persisted yet, this must not be misread
    // as a fresh hosting request.
    expect(hasLeadingConfirmationLanguage("Yes, send both.")).toBe(true);
    expect(hasLeadingConfirmationLanguage(
      "Yes, send both.\nPlease coordinate table setup for dinner tomorrow at 8:00 PM for 4 guests. No shellfish. Ensure everything is ready before guests arrive.",
    )).toBe(true);
  });
});

/** Query-builder stub that records insert/update/delete calls for a given table. */
function queryStubWithWriteTracking(
  table: string,
  result: { data: unknown; error: unknown },
  writeLog: string[],
) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    update: () => { writeLog.push(`update:${table}`); return builder; },
    insert: () => { writeLog.push(`insert:${table}`); return builder; },
    delete: () => { writeLog.push(`delete:${table}`); return builder; },
    eq: () => builder,
    gt: () => builder,
    order: () => builder,
    limit: () => builder,
    in: () => builder,
    maybeSingle: async () => result,
    single: async () => result,
    then: (resolve: (value: typeof result) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

function guestTeam(): Person[] {
  return [
    person({
      id: "christopher",
      name: "Christopher",
      role: "Cook",
      responsibilities: "Dinner, menu, kitchen, and food preparation.",
    }),
    person({
      id: "nasira",
      name: "Nasira",
      role: "Housekeeper",
      responsibilities: "Flowers, hospitality setup, guest rooms, and table setup.",
    }),
    person({
      id: "grace",
      name: "Grace",
      role: "House Manager",
      responsibilities: "Coordinate staff and follow up on household tasks.",
    }),
  ];
}

function person(overrides: Partial<Person> & Pick<Person, "id" | "name" | "role">): Person {
  return {
    user_id: "user-1",
    phone: `+97150000000${overrides.id.length}`,
    notes: null,
    created_at: "2026-07-01T00:00:00.000Z",
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
    whatsapp_consent_at: "2026-07-01T00:00:00.000Z",
    whatsapp_consent_method: "owner_confirmed",
    ...overrides,
  };
}

describe("Action Continuation Slot Registry", () => {
  it("registers hosting with its reconstruction, validation, fallback, and regression responsibilities", () => {
    expect(ACTION_CONTINUATION_SLOT_REGISTRY).toHaveLength(1);
    expect(ACTION_CONTINUATION_SLOT_REGISTRY[0]).toMatchObject({
      slotId: "hosting",
      reconstructionStrategy: "structured_pending_operation_then_linked_typed_history",
      fallbackBehavior: "return_error_without_free_form_fallthrough",
    });
    expect(ACTION_CONTINUATION_SLOT_REGISTRY[0].validationRules.length).toBeGreaterThan(0);
    expect(ACTION_CONTINUATION_SLOT_REGISTRY[0].regressionTestResponsibility).toContain(
      "exactly-once approval execution",
    );
  });

  it("claims a pending clarification answer before free-form handling and asks only for the missing dietary detail", async () => {
    const result = await runActionContinuation({
      message: "6",
      people: [],
      pendingState: {
        kind: "clarification",
        draft: {
          operationId: null,
          operationType: "guest_arrival",
          sourceText: "I have afternoon tea at 4:00 PM today. Handle everything.",
          askedAtClientMessageId: "typed-1",
        },
      },
    });

    expect(result.status).toBe("needs_clarification");
    expect(result.slotId).toBe("hosting");
    expect(result.state?.kind).toBe("clarification");
    expect(result.message).toBe("Are there any dietary restrictions?");
  });

  it("returns not_hosting when no registered slot claims the turn", async () => {
    await expect(runActionContinuation({
      message: "What is the weather?",
      people: [],
    })).resolves.toEqual({
      status: "not_hosting",
      slotId: null,
      state: null,
      message: null,
    });
  });

  it.each([
    "How many guests are coming, and is there anything I should avoid serving?",
    "How many guests are coming?",
    "Before I continue, what time should it begin, where should we host it, what would you like served, how many guests are coming, and are there any dietary restrictions?",
  ])("restores linked typed hosting history for clarification wording: %s", (clarification) => {
    const state = reconstructHostingContinuationFromTypedHistory([
      {
        role: "user",
        content: "I have afternoon tea at 4:00 PM today. Handle everything.",
        client_message_id: "owner-1",
        reply_to_client_message_id: null,
      },
      {
        role: "agent",
        content: clarification,
        client_message_id: null,
        reply_to_client_message_id: "owner-1",
      },
    ]);
    expect(state?.kind).toBe("clarification");
    if (state?.kind === "clarification") {
      expect(state.draft.sourceText).toContain("afternoon tea");
      expect(state.draft.askedAtClientMessageId).toBe("owner-1");
    }
  });

  it.each([
    "The hosting plan was sent.",
    "Okay, I'll hold off.",
    "The hosting plan is complete.",
  ])("does not restore a terminal typed hosting workflow: %s", (terminal) => {
    expect(reconstructHostingContinuationFromTypedHistory([
      {
        role: "user",
        content: "I have afternoon tea at 4:00 PM today. Handle everything.",
        client_message_id: "owner-1",
        reply_to_client_message_id: null,
      },
      {
        role: "agent",
        content: "How many guests are coming?",
        client_message_id: null,
        reply_to_client_message_id: "owner-1",
      },
      {
        role: "agent",
        content: terminal,
        client_message_id: null,
        reply_to_client_message_id: "owner-2",
      },
    ])).toBeNull();
  });
});
