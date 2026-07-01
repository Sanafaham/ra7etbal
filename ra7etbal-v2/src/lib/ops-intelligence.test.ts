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
  hasOperatingAuthority,
  isConfirmation,
  isRejection,
  isStatusQuestion,
  normalizeGuestPreparationPlan,
} = await import("./ops-intelligence");

beforeEach(() => {
  vi.clearAllMocks();
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
        message: "Confirm menu and prepare dinner.",
      }),
      expect.objectContaining({
        personName: "Nasira",
        message: "Prepare flowers and hospitality setup.",
      }),
      expect.objectContaining({
        personName: "Grace",
        message: "Coordinate and follow up with Christopher and Nasira.",
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
      "Confirm menu and prepare dinner.",
      "Prepare flowers and hospitality setup.",
      "Coordinate and follow up with Christopher and Nasira.",
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
      ["Christopher", "Confirm menu and prepare dinner."],
      ["Nasira", "Prepare flowers and hospitality setup."],
      ["Grace", "Coordinate and follow up with Christopher and Nasira."],
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
