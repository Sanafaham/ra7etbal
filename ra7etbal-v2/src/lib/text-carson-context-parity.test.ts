import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 9A consistency — Text Carson must receive the same operational and
 * product context Voice Carson gets from App.tsx (automation status,
 * WhatsApp delivery diagnostics, notes, to-dos, household rules), so the two
 * surfaces never disagree about what Carson "knows".
 *
 * askTextCarson() self-fetches these via the same helpers App.tsx uses
 * (fetchAutomationDigest, fetchWhatsappDeliveryFailures, loadRecentNotes,
 * listActiveTodos, getHouseholdRules) and forwards the formatted blocks into
 * buildCarsonContext(). These tests assert each block actually reaches the
 * prompt sent to Anthropic.
 */

const fetchAutomationDigestMock = vi.fn();
const fetchWhatsappDeliveryFailuresMock = vi.fn();
const loadRecentNotesMock = vi.fn();
const listActiveTodosMock = vi.fn();
const getHouseholdRulesMock = vi.fn();

vi.mock("./automation-context", () => ({
  fetchAutomationDigest: fetchAutomationDigestMock,
  buildAutomationStatusBlock: (digest: { failed: unknown[] }) =>
    digest.failed.length > 0 ? "AUTOMATION STATUS:\nFailed (delivery or send failure — needs attention):\n- Daily check-in — failed 2h ago" : "AUTOMATION STATUS:\nNo active automation issues.",
}));

vi.mock("./whatsapp-delivery-context", () => ({
  fetchWhatsappDeliveryFailures: fetchWhatsappDeliveryFailuresMock,
  buildWhatsappDeliveryStatusBlock: (failures: unknown[]) =>
    failures.length > 0 ? "WHATSAPP DELIVERY ISSUES (last 48h):\n- Failed to Sana — 2h ago: ecosystem engagement throttle" : "",
}));

vi.mock("./carson-notes", () => ({
  loadRecentNotes: loadRecentNotesMock,
  formatNotesForContext: (notes: { content: string }[]) =>
    notes.length > 0 ? `SAVED NOTES:\n- ${notes[0].content}` : "",
}));

vi.mock("./carson-todos", () => ({
  listActiveTodos: listActiveTodosMock,
  formatTodosForContext: (todos: { title: string }[]) =>
    todos.length > 0 ? `ACTIVE TO-DOS:\n- ${todos[0].title}` : "",
}));

vi.mock("./household-rules", () => ({
  getHouseholdRules: getHouseholdRulesMock,
}));

vi.mock("./carson-facts", () => ({
  loadUserMemory: vi.fn().mockResolvedValue(""),
  upsertUserFacts: vi.fn(),
}));

vi.mock("./carson-memory", () => ({
  loadRecentMemory: vi.fn().mockResolvedValue("No previous sessions."),
  saveSessionMemory: vi.fn(),
}));

vi.mock("./tasks", () => ({
  listTasks: vi.fn().mockResolvedValue([]),
}));

vi.mock("./inbox", () => ({
  saveInboxItem: vi.fn(),
}));

vi.mock("./calendar", () => ({
  filterCalendarEventsByRange: vi.fn(),
  classifyCalendarEvent: vi.fn(),
  formatEventTime: vi.fn(),
  formatEventEndTime: vi.fn(),
}));

vi.mock("./save", () => ({
  savePending: vi.fn(),
  saveTaskAttachments: vi.fn(),
}));

vi.mock("./delivery", () => ({
  deliverTaskMessage: vi.fn(),
}));

vi.mock("./ai/extract", () => ({
  extractItems: vi.fn(),
}));

vi.mock("./image-upload", () => ({
  resizeImage: vi.fn(),
}));

vi.mock("./routine-detection", () => ({
  detectAllRecurringSchedules: vi.fn().mockReturnValue([]),
}));

vi.mock("../stores/tasks", () => ({
  useTasksStore: { getState: () => ({ loadFor: vi.fn().mockResolvedValue(undefined) }) },
}));

vi.mock("./carson-summarize", () => ({
  summarizeConversation: vi.fn().mockResolvedValue(null),
}));

vi.mock("./carson-fact-extract", () => ({
  extractDurableFacts: vi.fn().mockResolvedValue([]),
}));

vi.mock("./people-behavior", () => ({
  updatePeopleInsightsFromTasks: vi.fn().mockResolvedValue(undefined),
}));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchAutomationDigestMock.mockResolvedValue({
    pending: [],
    escalated: [],
    failed: [],
    confirmedToday: [],
    firingToday: [],
    firingTomorrow: [],
  });
  fetchWhatsappDeliveryFailuresMock.mockResolvedValue([]);
  loadRecentNotesMock.mockResolvedValue([]);
  listActiveTodosMock.mockResolvedValue([]);
  getHouseholdRulesMock.mockResolvedValue(null);

  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ content: [{ text: "Got it." }] }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastPromptSent(): string {
  const call = fetchMock.mock.calls.find(([url]) => String(url) === "/api/anthropic");
  const body = JSON.parse(call![1].body);
  return body.messages[0].content as string;
}

describe("askTextCarson — Phase 9A context parity with Voice Carson", () => {
  it("includes automation status (including a failure) in the prompt", async () => {
    fetchAutomationDigestMock.mockResolvedValue({
      pending: [],
      escalated: [],
      failed: [{ automationTitle: "Daily check-in", assignee: "Sana", sentAgoMs: 7_200_000, isFollowupSent: false, failureReason: "ecosystem engagement" }],
      confirmedToday: [],
      firingToday: [],
      firingTomorrow: [],
    });

    const { askTextCarson } = await import("./text-carson");
    await askTextCarson("what's going on", { displayName: "Sana", userId: "user-1", dailyBrief: "", people: [], tasks: [] });

    const prompt = lastPromptSent();
    expect(prompt).toContain("AUTOMATION STATUS");
    expect(prompt).toContain("Failed (delivery or send failure");
  });

  it("includes WhatsApp delivery diagnostics in the prompt", async () => {
    fetchWhatsappDeliveryFailuresMock.mockResolvedValue([
      { recipientName: "Sana", sourceType: "automation_message", failureReason: "ecosystem engagement throttle", failureCode: null, failedAgoMs: 7_200_000 },
    ]);

    const { askTextCarson } = await import("./text-carson");
    await askTextCarson("any delivery issues?", { displayName: "Sana", userId: "user-1", dailyBrief: "", people: [], tasks: [] });

    const prompt = lastPromptSent();
    expect(prompt).toContain("WHATSAPP DELIVERY ISSUES");
    expect(prompt).toContain("ecosystem engagement throttle");
  });

  it("includes saved notes in the prompt", async () => {
    loadRecentNotesMock.mockResolvedValue([{ content: "Loulya prefers afternoon calls." }]);

    const { askTextCarson } = await import("./text-carson");
    await askTextCarson("what did I save about Loulya?", { displayName: "Sana", userId: "user-1", dailyBrief: "", people: [], tasks: [] });

    const prompt = lastPromptSent();
    expect(prompt).toContain("SAVED NOTES");
    expect(prompt).toContain("Loulya prefers afternoon calls.");
  });

  it("includes active to-dos in the prompt", async () => {
    listActiveTodosMock.mockResolvedValue([{ title: "Renew passport" }]);

    const { askTextCarson } = await import("./text-carson");
    await askTextCarson("what's on my to-do list?", { displayName: "Sana", userId: "user-1", dailyBrief: "", people: [], tasks: [] });

    const prompt = lastPromptSent();
    expect(prompt).toContain("ACTIVE TO-DOS");
    expect(prompt).toContain("Renew passport");
  });

  it("includes household rules in the prompt", async () => {
    getHouseholdRulesMock.mockResolvedValue({ id: "r1", user_id: "user-1", rules: "Always loop Grace in for guest-related tasks.", created_at: "", updated_at: "" });

    const { askTextCarson } = await import("./text-carson");
    await askTextCarson("who should handle the dinner party?", { displayName: "Sana", userId: "user-1", dailyBrief: "", people: [], tasks: [] });

    const prompt = lastPromptSent();
    expect(prompt).toContain("HOUSEHOLD DELEGATION RULES");
    expect(prompt).toContain("Always loop Grace in for guest-related tasks.");
  });

  it("omits all five blocks cleanly when there is nothing to report (preserves existing behavior)", async () => {
    const { askTextCarson } = await import("./text-carson");
    await askTextCarson("hello", { displayName: "Sana", userId: "user-1", dailyBrief: "", people: [], tasks: [] });

    const prompt = lastPromptSent();
    expect(prompt).not.toContain("WHATSAPP DELIVERY ISSUES");
    expect(prompt).not.toContain("SAVED NOTES");
    expect(prompt).not.toContain("ACTIVE TO-DOS");
    expect(prompt).not.toContain("HOUSEHOLD DELEGATION RULES");
    expect(prompt).toContain("No active automation issues.");
  });
});
