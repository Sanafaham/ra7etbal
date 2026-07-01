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
  detectHouseholdOutcome,
  executeProposedPlan,
  handlePendingPlanTurn,
  hasOperatingAuthority,
  isConfirmation,
  isRejection,
  isStatusQuestion,
  normalizeGuestPreparationPlan,
  resetExecutedPlanRegistryForTest,
  resolvePendingPlanDecision,
} = await import("./ops-intelligence");

beforeEach(() => {
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
    const tasks = buildDeterministicGuestPreparationTasks(guestTeam());

    expect(tasks).toEqual([
      expect.objectContaining({
        personName: "Christopher",
        message: "Please prepare the food and tea.",
      }),
      expect.objectContaining({
        personName: "Nasira",
        message: "Please handle the hospitality setup and table presentation.",
      }),
      expect.objectContaining({
        personName: "Grace",
        message: "Please coordinate with Christopher and Nasira and follow up that everything is ready.",
      }),
    ]);
  });

  it("repairs a collapsed single-owner guest plan before persistence or execution", () => {
    const collapsed = normalizeGuestPreparationPlan({
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

    expect(collapsed.tasks.map((task) => task.personName)).toEqual([
      "Christopher",
      "Nasira",
      "Grace",
    ]);
    expect(collapsed.tasks.map((task) => task.message)).toEqual([
      "Please prepare the food and tea.",
      "Please handle the hospitality setup and table presentation.",
      "Please coordinate with Christopher and Nasira and follow up that everything is ready.",
    ]);
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

    const savedItems = mocks.savePending.mock.calls[0][0] as ExtractedItem[];
    expect(savedItems.map((item) => [item.assignedTo, item.description])).toEqual([
      ["Christopher", "Please prepare the food and tea."],
      ["Nasira", "Please handle the hospitality setup and table presentation."],
      ["Grace", "Please coordinate with Christopher and Nasira and follow up that everything is ready."],
    ]);
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
    const tasks = buildDeterministicGuestPreparationTasks(realHousehold(), TEA);
    expect(tasks).toEqual([
      { personId: "christopher", personName: "Christopher", message: "Please prepare the food and tea." },
      {
        personId: "nasira",
        personName: "Nasira",
        message: "Please handle the hospitality setup and table presentation.",
      },
      {
        personId: "bahan",
        personName: "Bahan",
        message: "Please coordinate with Christopher and Nasira and follow up that everything is ready.",
      },
    ]);
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

  it("adds transport standby only when the request names transport", () => {
    const withTransport =
      "I have guests tomorrow for afternoon tea. Ghulam will collect them from the airport. Handle what you can.";
    const tasks = buildDeterministicGuestPreparationTasks(realHousehold(), withTransport);
    const ghulam = tasks.find((t) => t.personName === "Ghulam");
    expect(ghulam).toBeDefined();
    expect(ghulam?.message).toMatch(/transport|standby/i);
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
