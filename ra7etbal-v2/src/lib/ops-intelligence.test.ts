import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractedItem } from "../types/extraction";
import type { Message } from "../types/message";
import type { Person } from "../types/person";

// ops-intelligence.ts imports ./supabase at module top level (for plan persistence),
// which throws without VITE_SUPABASE_* env vars. Stub it — the pure detection
// functions under test (isConfirmation, isRejection, isStatusQuestion) never call Supabase.
vi.mock("./supabase", () => ({ supabase: {} }));
const mocks = vi.hoisted(() => ({
  savePending: vi.fn(),
  deliverTaskMessage: vi.fn(),
  sendDirectMessageRecord: vi.fn(),
}));

vi.mock("./save", () => ({ savePending: mocks.savePending }));
vi.mock("./delivery", () => ({ deliverTaskMessage: mocks.deliverTaskMessage }));
vi.mock("./direct-messages", () => ({ sendDirectMessageRecord: mocks.sendDirectMessageRecord }));
vi.mock("./delegation-message", () => ({
  buildDelegationMessage: ({ taskText }: { taskText: string }) => taskText,
}));

const {
  buildDeterministicGuestPreparationTasks,
  buildHostingEventBrief,
  detectHouseholdOutcome,
  evaluateHostingPlanningGate,
  executeProposedPlan,
  handlePendingPlanTurn,
  hasOperatingAuthority,
  isConfirmation,
  isRejection,
  isStatusQuestion,
  mustRouteGuestEventToPlanner,
  normalizeGuestPreparationPlan,
  prepareOperationalPlanTurn,
  resetExecutedPlanRegistryForTest,
  resolveGuestOutcomeAction,
  resolvePendingPlanDecision,
} = await import("./ops-intelligence");

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetExecutedPlanRegistryForTest();
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
    expect(tasks[0].message).toMatch(/sandwiches, scones, cakes, tea, coffee, and water/i);
    expect(tasks[1].message).toMatch(/blue china|flowers/i);
    expect(tasks[2].message).toMatch(/Checkpoints: confirm with Christopher.*confirm with Nasira/i);
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
    expect(tasks[0].message).toContain("afternoon tea today at 4:00 PM inside");
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
    expect(collapsed.tasks[0].message).toContain("Menu/service: tea and sandwiches");
    expect(collapsed.tasks[2].message).toContain("Checkpoints");
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
    expect(savedItems[0].description).toContain("Menu/service: tea and sandwiches");
    expect(savedItems[2].description).toContain("Checkpoints");
    expect(mocks.deliverTaskMessage).toHaveBeenCalledTimes(3);
    expect(mocks.deliverTaskMessage.mock.calls.map(([payload]) => payload.recipientName)).toEqual([
      "Christopher",
      "Nasira",
      "Grace",
    ]);
    expect(result).toBe("Christopher, Nasira, Grace have the plan. I'll watch for confirmations.");
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
      expect(task.message).toMatch(/Required result:/);
      expect(task.message).toMatch(/Tell Carson immediately|Report any missing item/);
    }
    expect(tasks[0].message).toContain("finger sandwiches, scones, small cakes, tea, coffee, and water");
    expect(tasks[1].message).toContain("blue china");
    expect(tasks[1].message).toContain("flowers");
    expect(tasks[2].message).toContain("Checkpoints: confirm with Christopher");
    expect(tasks[2].message).toContain("confirm with Nasira");
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
    expect(linkedAnswer.brief.guestCount).toBe("5 guests");
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
    expect(linkedAnswer.brief.startTime).toBe("4 PM");
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
