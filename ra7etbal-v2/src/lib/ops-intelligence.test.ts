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
  executeProposedPlan,
  handlePendingPlanTurn,
  hasOperatingAuthority,
  isAssistantRecipientName,
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
        message: "Please confirm the menu and prepare dinner.",
      }),
      expect.objectContaining({
        personName: "Nasira",
        message: "Please prepare the flowers and hospitality setup.",
      }),
      expect.objectContaining({
        personName: "Grace",
        message: "Please coordinate with Christopher and Nasira and confirm everything is ready.",
      }),
    ]);
  });

  it("prepends shared event context to every guest-prep message", () => {
    const tasks = buildDeterministicGuestPreparationTasks(
      guestTeam(),
      "I have guests coming tomorrow for afternoon tea. Handle what you can.",
    );

    const sharedContext = "We have guests coming tomorrow for afternoon tea";
    for (const task of tasks) {
      expect(task.message.startsWith(sharedContext)).toBe(true);
    }

    expect(tasks).toEqual([
      expect.objectContaining({
        personName: "Christopher",
        message: `${sharedContext}. Please confirm the menu and prepare dinner.`,
      }),
      expect.objectContaining({
        personName: "Nasira",
        message: `${sharedContext}. Please prepare the flowers and hospitality setup.`,
      }),
      expect.objectContaining({
        personName: "Grace",
        message: `${sharedContext}. Please coordinate with Christopher and Nasira and confirm everything is ready.`,
      }),
    ]);
  });

  it("gives Christopher only dinner responsibilities, never Nasira's or Grace's", () => {
    const tasks = buildDeterministicGuestPreparationTasks(
      guestTeam(),
      "I have guests coming tomorrow for afternoon tea. Handle what you can.",
    );
    const christopherMessage = tasks.find((t) => t.personName === "Christopher")?.message ?? "";

    expect(christopherMessage).toContain("confirm the menu and prepare dinner");
    expect(christopherMessage).not.toMatch(/flowers|hospitality setup|coordinate with/i);
  });

  it("gives Nasira only hospitality responsibilities, never Christopher's or Grace's", () => {
    const tasks = buildDeterministicGuestPreparationTasks(
      guestTeam(),
      "I have guests coming tomorrow for afternoon tea. Handle what you can.",
    );
    const nasiraMessage = tasks.find((t) => t.personName === "Nasira")?.message ?? "";

    expect(nasiraMessage).toContain("prepare the flowers and hospitality setup");
    expect(nasiraMessage).not.toMatch(/prepare dinner|confirm the menu|coordinate with/i);
  });

  it("has Grace coordinate only, never owning food or flowers herself", () => {
    const tasks = buildDeterministicGuestPreparationTasks(
      guestTeam(),
      "I have guests coming tomorrow for afternoon tea. Handle what you can.",
    );
    const graceMessage = tasks.find((t) => t.personName === "Grace")?.message ?? "";

    expect(graceMessage).toContain("coordinate with Christopher and Nasira and confirm everything is ready");
    expect(graceMessage).not.toMatch(/prepare dinner|confirm the menu|prepare the flowers/i);
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
      "We have guests tomorrow. Please confirm the menu and prepare dinner.",
      "We have guests tomorrow. Please prepare the flowers and hospitality setup.",
      "We have guests tomorrow. Please coordinate with Christopher and Nasira and confirm everything is ready.",
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
      ["Christopher", "We have guests tomorrow. Please confirm the menu and prepare dinner."],
      ["Nasira", "We have guests tomorrow. Please prepare the flowers and hospitality setup."],
      ["Grace", "We have guests tomorrow. Please coordinate with Christopher and Nasira and confirm everything is ready."],
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

// Mirrors the savePending shape used above — every saved item becomes a task +
// message row with a confirmation URL, so executeProposedPlan can send each one.
function stubSavePendingWithSeparateRowsAndLinks() {
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
}

describe("P0 — pending plan approval execution", () => {
  const SOURCE = "I have guests coming tomorrow for afternoon tea. Handle what you can.";

  function storedPlan(team = guestTeam()) {
    // The plan Carson stores when it asks "Shall I send it?" — the deterministic
    // normalizer expands the collapsed proposal into per-owner tasks.
    return normalizeGuestPreparationPlan({
      outcomeType: "guest_arrival",
      sourceText: SOURCE,
      createdAt: Date.now(),
      proposalSpeech: "I can split this between the team. Shall I send it?",
      tasks: [
        {
          personId: "christopher",
          personName: "Christopher",
          message: "Handle everything for the afternoon tea.",
        },
      ],
    }, team);
  }

  // Safety net 1 — a stored plan awaiting approval carries every owner as its
  // own task, so nothing is lost between "Shall I send it?" and "Yes".
  it("stores a complete multi-owner plan when Carson proposes it", () => {
    const plan = storedPlan();
    expect(plan.tasks.map((t) => t.personName)).toEqual(["Christopher", "Nasira", "Grace"]);
    expect(plan.proposalSpeech).toMatch(/send it\?/i);
  });

  // Safety net 2 — a verbatim "Yes" resolves to confirm and executes the EXACT
  // stored plan, even though the LLM would have rephrased the tool instruction.
  it("resolves a verbatim 'Yes' to confirm regardless of any LLM rephrase", () => {
    expect(resolvePendingPlanDecision("Yes.")).toBe("confirm");
    expect(resolvePendingPlanDecision("yes")).toBe("confirm");
    expect(resolvePendingPlanDecision("go ahead")).toBe("confirm");
    expect(resolvePendingPlanDecision("send it")).toBe("confirm");
    expect(resolvePendingPlanDecision("no")).toBe("reject");
    expect(resolvePendingPlanDecision("cancel")).toBe("reject");
  });

  // Safety nets 2 + 3 — "Yes" sends every planned WhatsApp and clears the plan.
  it("executes the exact stored plan and sends all WhatsApps on 'Yes'", async () => {
    stubSavePendingWithSeparateRowsAndLinks();
    mocks.deliverTaskMessage.mockResolvedValue({ success: true, channel: "whatsapp" });

    const plan = storedPlan();
    const turn = await handlePendingPlanTurn("Yes.", plan, {
      displayName: "Sana",
      userId: "user-1",
      people: guestTeam(),
    });

    expect(turn.action).toBe("executed");
    expect(turn.clearPlan).toBe(true);

    const savedItems = mocks.savePending.mock.calls[0][0] as ExtractedItem[];
    expect(savedItems.map((item) => item.assignedTo)).toEqual([
      "Christopher",
      "Nasira",
      "Grace",
    ]);
    expect(mocks.deliverTaskMessage).toHaveBeenCalledTimes(3);
    expect(mocks.deliverTaskMessage.mock.calls.map(([p]) => p.recipientName)).toEqual([
      "Christopher",
      "Nasira",
      "Grace",
    ]);
    expect(turn.summary).toBe("Christopher, Nasira, Grace have the plan. I'll watch for confirmations.");
  });

  // Safety net 4 — partial send failure reports exactly who failed and who
  // succeeded, routed through the approval handler end to end.
  it("reports exactly who failed and who succeeded on partial send failure", async () => {
    stubSavePendingWithSeparateRowsAndLinks();
    mocks.deliverTaskMessage
      .mockResolvedValueOnce({ success: true, channel: "whatsapp" })
      .mockResolvedValueOnce({ success: false, channel: "whatsapp", error: "Meta rejected the message" })
      .mockResolvedValueOnce({ success: true, channel: "whatsapp" });

    const plan = storedPlan();
    const turn = await handlePendingPlanTurn("go ahead", plan, {
      displayName: "Sana",
      userId: "user-1",
      people: guestTeam(),
    });

    expect(turn.action).toBe("executed");
    expect(turn.summary).toContain("Christopher, Grace have the plan");
    expect(turn.summary).toContain("Nasira was NOT messaged — Meta rejected the message");
  });

  // Safety net 6 — an empty or noisy transcript holds the plan: it is neither
  // executed nor cleared, so the user can still confirm on the next turn.
  it("holds (never clears or sends) the plan on an empty or noisy transcript", async () => {
    expect(resolvePendingPlanDecision("")).toBe("hold");
    expect(resolvePendingPlanDecision("   ")).toBe("hold");
    expect(resolvePendingPlanDecision(null)).toBe("hold");
    expect(resolvePendingPlanDecision("um, what were we talking about")).toBe("hold");

    const plan = storedPlan();
    const turn = await handlePendingPlanTurn("um, hang on", plan, {
      displayName: "Sana",
      userId: "user-1",
      people: guestTeam(),
    });

    expect(turn.action).toBe("held");
    expect(turn.clearPlan).toBe(false);
    expect(turn.summary).toBeNull();
    expect(mocks.savePending).not.toHaveBeenCalled();
    expect(mocks.deliverTaskMessage).not.toHaveBeenCalled();
  });

  // Safety net 7 — Ghulam's transport standby survives normalization and is
  // sent alongside the core prep owners when the household has a driver.
  it("keeps Ghulam's transport standby in the guest plan and sends it", async () => {
    const tasks = buildDeterministicGuestPreparationTasks(guestTeamWithDriver(), SOURCE);
    const ghulam = tasks.find((t) => t.personName === "Ghulam");
    expect(ghulam).toBeDefined();
    expect(ghulam?.message).toContain("stand by for transport");
    // Christopher/Nasira/Grace must not be turned into transport standby.
    expect(tasks.find((t) => t.personName === "Christopher")?.message).not.toMatch(/stand by for transport/i);

    stubSavePendingWithSeparateRowsAndLinks();
    mocks.deliverTaskMessage.mockResolvedValue({ success: true, channel: "whatsapp" });

    const plan = storedPlan(guestTeamWithDriver());
    expect(plan.tasks.map((t) => t.personName)).toContain("Ghulam");

    const turn = await handlePendingPlanTurn("Yes.", plan, {
      displayName: "Sana",
      userId: "user-1",
      people: guestTeamWithDriver(),
    });

    expect(turn.action).toBe("executed");
    expect(mocks.deliverTaskMessage.mock.calls.map(([p]) => p.recipientName)).toContain("Ghulam");
  });

  // A stale plan (older than the 5-minute window) is discarded on approval
  // rather than executed — the caller clears its cache and speaks nothing here.
  it("holds and clears an expired plan instead of executing it", async () => {
    const plan = storedPlan();
    plan.createdAt = Date.now() - 6 * 60 * 1000;

    const turn = await handlePendingPlanTurn("Yes.", plan, {
      displayName: "Sana",
      userId: "user-1",
      people: guestTeam(),
    });

    expect(turn.action).toBe("held");
    expect(turn.clearPlan).toBe(true);
    expect(mocks.deliverTaskMessage).not.toHaveBeenCalled();
  });
});

describe("P0 — Carson execution safety", () => {
  const SOURCE = "I have guests coming tomorrow for afternoon tea. Handle what you can.";

  function storedPlan(team = guestTeam()) {
    return normalizeGuestPreparationPlan({
      outcomeType: "guest_arrival",
      sourceText: SOURCE,
      createdAt: Date.now(),
      proposalSpeech: "I can split this between the team. Shall I send it?",
      tasks: [
        {
          personId: "christopher",
          personName: "Christopher",
          message: "Handle everything for the afternoon tea.",
        },
      ],
    }, team);
  }

  // Safety: "Carson" (the assistant) can never be selected as a recipient.
  it("never selects Carson as a recipient", () => {
    expect(isAssistantRecipientName("Carson")).toBe(true);
    expect(isAssistantRecipientName(" carson ")).toBe(true);
    expect(isAssistantRecipientName("assistant")).toBe(true);
    expect(isAssistantRecipientName("Christopher")).toBe(false);

    const teamWithCarson: Person[] = [
      ...guestTeam(),
      person({ id: "carson", name: "Carson", role: "House Manager", responsibilities: "Coordinate everything." }),
    ];
    const tasks = buildDeterministicGuestPreparationTasks(teamWithCarson, SOURCE);
    expect(tasks.some((t) => t.personName.toLowerCase() === "carson")).toBe(false);
    // Grace (the real House Manager) still owns coordination.
    expect(tasks.some((t) => t.personName === "Grace")).toBe(true);
  });

  it("filters a Carson task out of execution and never messages it", async () => {
    stubSavePendingWithSeparateRowsAndLinks();
    mocks.deliverTaskMessage.mockResolvedValue({ success: true, channel: "whatsapp" });

    const plan = storedPlan();
    plan.tasks.push({ personId: "carson", personName: "Carson", message: "Do the rest yourself." });

    const summary = await executeProposedPlan(plan, {
      displayName: "Sana",
      userId: "user-1",
      people: guestTeam(),
    });

    const recipients = mocks.deliverTaskMessage.mock.calls.map(([p]) => p.recipientName);
    expect(recipients).not.toContain("Carson");
    expect(recipients).toEqual(["Christopher", "Nasira", "Grace"]);
    expect(summary).not.toMatch(/carson/i);
  });

  // Safety: a failed send is reported exactly and NOT auto-retried.
  it("does not auto-retry a failed send — one attempt per recipient, then stop", async () => {
    stubSavePendingWithSeparateRowsAndLinks();
    mocks.deliverTaskMessage
      .mockResolvedValueOnce({ success: true, channel: "whatsapp" })
      .mockResolvedValueOnce({ success: false, channel: "failed", error: "recipient phone number is missing" })
      .mockResolvedValueOnce({ success: true, channel: "whatsapp" });

    const summary = await executeProposedPlan(storedPlan(), {
      displayName: "Sana",
      userId: "user-1",
      people: guestTeam(),
    });

    // Exactly one attempt per recipient — no retry of the failed send.
    expect(mocks.deliverTaskMessage).toHaveBeenCalledTimes(3);
    expect(summary).toContain("Nasira was NOT messaged — recipient phone number is missing");
    expect(summary).not.toMatch(/keep trying|try again/i);
  });

  // Safety: only the plan's own recipients are messaged — unrelated household
  // members (memory/context bleed) never enter the current execution.
  it("does not pull unrelated people into the current task", async () => {
    stubSavePendingWithSeparateRowsAndLinks();
    mocks.deliverTaskMessage.mockResolvedValue({ success: true, channel: "whatsapp" });

    const peopleWithExtras: Person[] = [
      ...guestTeam(),
      person({ id: "squishy", name: "Squishy", role: "Nanny", responsibilities: "Unrelated errand." }),
    ];

    await executeProposedPlan(storedPlan(), {
      displayName: "Sana",
      userId: "user-1",
      people: peopleWithExtras,
    });

    const recipients = mocks.deliverTaskMessage.mock.calls.map(([p]) => p.recipientName);
    expect(recipients).toEqual(["Christopher", "Nasira", "Grace"]);
    expect(recipients).not.toContain("Squishy");
  });

  // Safety net 5 — an incomplete/empty transcript never executes.
  it("does not execute on an incomplete transcript", async () => {
    const turn = await handlePendingPlanTurn("", storedPlan(), {
      displayName: "Sana",
      userId: "user-1",
      people: guestTeam(),
    });
    expect(turn.action).toBe("held");
    expect(mocks.deliverTaskMessage).not.toHaveBeenCalled();
    expect(mocks.savePending).not.toHaveBeenCalled();
  });

  // Safety net 7 — the same pending plan can execute only once. A duplicate
  // approval (EL double-fire) sends nothing the second time.
  it("executes a plan only once — duplicate approval sends no second WhatsApp", async () => {
    stubSavePendingWithSeparateRowsAndLinks();
    mocks.deliverTaskMessage.mockResolvedValue({ success: true, channel: "whatsapp" });

    const plan = storedPlan();

    const first = await handlePendingPlanTurn("Yes.", plan, {
      displayName: "Sana",
      userId: "user-1",
      people: guestTeam(),
    });
    expect(first.action).toBe("executed");
    expect(mocks.deliverTaskMessage).toHaveBeenCalledTimes(3);

    // Second approval of the SAME plan — no additional sends.
    const second = await handlePendingPlanTurn("Yes.", plan, {
      displayName: "Sana",
      userId: "user-1",
      people: guestTeam(),
    });
    expect(second.action).toBe("executed");
    expect(second.summary).toMatch(/already sent/i);
    expect(mocks.deliverTaskMessage).toHaveBeenCalledTimes(3); // unchanged
    expect(mocks.savePending).toHaveBeenCalledTimes(1);
  });

  it("blocks a concurrent duplicate execution of the same plan", async () => {
    stubSavePendingWithSeparateRowsAndLinks();
    mocks.deliverTaskMessage.mockResolvedValue({ success: true, channel: "whatsapp" });

    const plan = storedPlan();
    const [a, b] = await Promise.all([
      executeProposedPlan(plan, { displayName: "Sana", userId: "user-1", people: guestTeam() }),
      executeProposedPlan(plan, { displayName: "Sana", userId: "user-1", people: guestTeam() }),
    ]);

    const summaries = [a, b];
    expect(summaries.filter((s) => /already sent/i.test(s))).toHaveLength(1);
    // Only one real execution reached savePending / delivery.
    expect(mocks.savePending).toHaveBeenCalledTimes(1);
    expect(mocks.deliverTaskMessage).toHaveBeenCalledTimes(3);
  });
});

// Operating-authority auto-execute (execute_instruction outcome leg).
//
// Regression context: 9d100c8 made guest outcomes propose-only, so authorized
// plans stuck at `pending` and never sent. This restores the 0eaaa0d behavior —
// an utterance that grants operating authority builds the deterministic plan and
// executes it immediately — while keeping every 9d100c8 guard. The building
// blocks below are exactly what the widget's outcome leg runs:
//   hasOperatingAuthority(text) → executeProposedPlan(normalize(...plan))
describe("operating-authority guest auto-execute", () => {
  const AUTHORITY_UTTERANCE = "I have guests tomorrow for afternoon tea. Handle what you can.";

  function planFromUtterance(team = guestTeam()) {
    // Mirrors buildOperationalPlanFromOutcome → normalizeGuestPreparationPlan,
    // with a dbId so completion (markPlanCompleted) is exercised.
    const plan = normalizeGuestPreparationPlan({
      outcomeType: "guest_arrival",
      sourceText: AUTHORITY_UTTERANCE,
      createdAt: Date.now(),
      proposalSpeech: "I can split this between the team. Shall I send it?",
      tasks: [
        { personId: "christopher", personName: "Christopher", message: "Handle everything for the afternoon tea." },
      ],
    }, team);
    plan.dbId = "plan-db-1";
    return plan;
  }

  // Net 1 — the target utterance grants operating authority (the widget gate).
  it("recognizes operating authority in the afternoon-tea utterance", () => {
    expect(hasOperatingAuthority(AUTHORITY_UTTERANCE)).toBe(true);
    // A bare outcome with no authority must NOT auto-execute.
    expect(hasOperatingAuthority("I have guests tomorrow for afternoon tea.")).toBe(false);
  });

  // Nets 2–5 — execute runs, creates task rows, and attempts every send.
  it("auto-executes immediately: task rows created and all recipients messaged", async () => {
    stubSavePendingWithSeparateRowsAndLinks();
    mocks.deliverTaskMessage.mockResolvedValue({ success: true, channel: "whatsapp" });

    const plan = planFromUtterance();
    const summary = await executeProposedPlan(plan, {
      displayName: "Sana",
      userId: "user-1",
      people: guestTeam(),
    });

    // Net 4 — savePending was called with a task per planned recipient.
    expect(mocks.savePending).toHaveBeenCalledTimes(1);
    const savedItems = mocks.savePending.mock.calls[0][0] as ExtractedItem[];
    expect(savedItems.map((i) => i.assignedTo)).toEqual(["Christopher", "Nasira", "Grace"]);
    expect(savedItems.every((i) => i.type === "delegation")).toBe(true);

    // Net 5 — a WhatsApp send attempted for every planned recipient.
    expect(mocks.deliverTaskMessage).toHaveBeenCalledTimes(3);
    expect(mocks.deliverTaskMessage.mock.calls.map(([p]) => p.recipientName)).toEqual([
      "Christopher",
      "Nasira",
      "Grace",
    ]);

    // Nets 2–3 — execution completed and returned the confirmation summary
    // (the widget uses this as the spoken result; the plan is not left pending).
    expect(summary).toBe("Christopher, Nasira, Grace have the plan. I'll watch for confirmations.");
  });

  // Net 6 — a re-fired authorized utterance for the same plan sends nothing new.
  it("is idempotent: re-running the same authorized plan sends no duplicate", async () => {
    stubSavePendingWithSeparateRowsAndLinks();
    mocks.deliverTaskMessage.mockResolvedValue({ success: true, channel: "whatsapp" });

    const plan = planFromUtterance();
    await executeProposedPlan(plan, { displayName: "Sana", userId: "user-1", people: guestTeam() });
    expect(mocks.deliverTaskMessage).toHaveBeenCalledTimes(3);

    const again = await executeProposedPlan(plan, { displayName: "Sana", userId: "user-1", people: guestTeam() });
    expect(again).toMatch(/already sent/i);
    expect(mocks.deliverTaskMessage).toHaveBeenCalledTimes(3); // unchanged
    expect(mocks.savePending).toHaveBeenCalledTimes(1);
  });

  // Net 7 — the assistant recipient filter still blocks "Carson" on this path.
  it("still filters Carson out of an auto-executed authorized plan", async () => {
    stubSavePendingWithSeparateRowsAndLinks();
    mocks.deliverTaskMessage.mockResolvedValue({ success: true, channel: "whatsapp" });

    const plan = planFromUtterance();
    plan.tasks.push({ personId: "carson", personName: "Carson", message: "Do the rest yourself." });

    const summary = await executeProposedPlan(plan, {
      displayName: "Sana",
      userId: "user-1",
      people: guestTeam(),
    });

    const recipients = mocks.deliverTaskMessage.mock.calls.map(([p]) => p.recipientName);
    expect(recipients).not.toContain("Carson");
    expect(summary).not.toMatch(/carson/i);
  });

  // Net 8 — partial failure names exactly who failed and who succeeded.
  it("reports exact failed recipients on partial failure", async () => {
    stubSavePendingWithSeparateRowsAndLinks();
    mocks.deliverTaskMessage
      .mockResolvedValueOnce({ success: true, channel: "whatsapp" })
      .mockResolvedValueOnce({ success: false, channel: "failed", error: "Meta rejected the message" })
      .mockResolvedValueOnce({ success: true, channel: "whatsapp" });

    const summary = await executeProposedPlan(planFromUtterance(), {
      displayName: "Sana",
      userId: "user-1",
      people: guestTeam(),
    });

    expect(summary).toContain("Christopher, Grace have the plan");
    expect(summary).toContain("Nasira was NOT messaged — Meta rejected the message");
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

function guestTeamWithDriver(): Person[] {
  return [
    ...guestTeam(),
    person({
      id: "ghulam",
      name: "Ghulam",
      role: "Driver",
      responsibilities: "Transport, car, airport pickups, and errands.",
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
