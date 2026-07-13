import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractedItem } from "../types/extraction";

const extractItemsMock = vi.fn();
const savePendingMock = vi.fn();
const deliverTaskMessageMock = vi.fn();

vi.mock("./ai/extract", () => ({
  extractItems: extractItemsMock,
}));

vi.mock("./save", () => ({
  savePending: savePendingMock,
  saveTaskAttachments: vi.fn(),
}));

vi.mock("./delivery", () => ({
  deliverTaskMessage: deliverTaskMessageMock,
}));

vi.mock("./inbox", () => ({
  saveInboxItem: vi.fn(),
}));

vi.mock("./tasks", () => ({
  listTasks: vi.fn().mockResolvedValue([]),
}));

vi.mock("./image-upload", () => ({
  resizeImage: vi.fn(async (file: File) => new Blob([await file.arrayBuffer()], { type: "image/jpeg" })),
}));

vi.mock("./calendar", () => ({
  filterCalendarEventsByRange: vi.fn(),
  fetchCalendarEvents: vi.fn().mockResolvedValue({ connected: false, events: [] }),
  deriveCalendarConnectionStatus: vi.fn().mockReturnValue("unknown"),
  buildCalendarConnectionStatusBlock: vi.fn().mockReturnValue(""),
}));

vi.mock("./routines", () => ({
  listRoutines: vi.fn(),
}));

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
    },
  },
}));

// Phase 9A consistency fix: askTextCarson() now self-fetches the same
// operational/product context blocks Voice Carson gets from App.tsx
// (automation status, WhatsApp delivery diagnostics, notes, to-dos,
// household rules). All five modules import ./supabase at module top
// level, which throws without VITE_SUPABASE_* env vars — mock them the
// same way ./calendar is already mocked above.
vi.mock("./automation-context", () => ({
  fetchAutomationDigest: vi.fn().mockResolvedValue(null),
  buildAutomationStatusBlock: vi.fn().mockReturnValue(""),
}));

vi.mock("./whatsapp-delivery-context", () => ({
  fetchWhatsappDeliveryFailures: vi.fn().mockResolvedValue([]),
  buildWhatsappDeliveryStatusBlock: vi.fn().mockReturnValue(""),
}));

vi.mock("./carson-notes", () => ({
  loadRecentNotes: vi.fn().mockResolvedValue([]),
  formatNotesForContext: vi.fn().mockReturnValue(""),
}));

vi.mock("./carson-todos", () => ({
  listActiveTodos: vi.fn().mockResolvedValue([]),
  formatTodosForContext: vi.fn().mockReturnValue(""),
}));

vi.mock("./household-rules", () => ({
  getHouseholdRules: vi.fn().mockResolvedValue(null),
}));

vi.mock("../stores/tasks", () => ({
  useTasksStore: {
    getState: () => ({
      loadFor: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

vi.mock("./carson-facts", () => ({
  loadUserMemory: vi.fn().mockResolvedValue(""),
  upsertUserFacts: vi.fn(),
}));

vi.mock("./carson-memory", () => ({
  loadRecentMemory: vi.fn().mockResolvedValue("No previous sessions."),
  saveSessionMemory: vi.fn(),
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

describe("executeDelegationFromText image pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sanitizes text Carson answers before returning them to the bubble", async () => {
    const { askTextCarson } = await import("./text-carson");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            text: "One moment. Grace has it. Are you still there?",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await askTextCarson("status", {
      displayName: "Sana",
      userId: "user-1",
      dailyBrief: "",
      people: [],
      tasks: [],
    });

    expect(response).toBe("Grace has it");
    expect(response).not.toMatch(/one moment|are you still there|are you there|still there/i);
  });

  it("passes an attached photo through savePending and into WhatsApp delivery", async () => {
    const { executeDelegationFromText } = await import("./text-carson");

    const extractedItem: ExtractedItem = {
      id: "item-1",
      type: "delegation",
      description: "prepare these",
      assignedTo: "Christopher",
      dueAt: null,
      dueText: null,
      suggestedMessage: "Please prepare these.",
      personalNote: null,
      needsPerson: false,
      needsClarification: false,
      clarificationQuestion: null,
    };
    const file = new File(["image-bytes"], "photo.jpg", { type: "image/jpeg" });

    extractItemsMock.mockResolvedValue({
      extracted: [extractedItem],
      summary: "Found one delegation.",
    });
    savePendingMock.mockResolvedValue({
      tasks: [
        {
          id: "task-1",
          user_id: "user-1",
          description: "prepare these",
          type: "delegation",
          assigned_to: "Christopher",
          status: "pending",
          needs_follow_up: true,
          confirmation_url: "https://app.test/confirm?task=task-1",
          confirmed_at: null,
          due_at: null,
          archived_at: null,
          created_at: "2026-06-25T00:00:00.000Z",
          qstash_message_id: null,
          followup_sent_at: null,
          escalated_at: null,
          image_path: "task-images/user-1/task-1/photo.jpg",
          proof_image_path: null,
        },
      ],
      messages: [
        {
          id: "message-1",
          user_id: "user-1",
          task_id: "task-1",
          recipient: "Christopher",
          content: "Please prepare these.",
          confirmation_url: "https://app.test/confirm?task=task-1",
          status: "pending",
          created_at: "2026-06-25T00:00:00.000Z",
          sent_at: null,
          confirmed_at: null,
          whatsapp_message_id: null,
          whatsapp_delivery_status: null,
          whatsapp_status_updated_at: null,
          whatsapp_failure_reason: null,
        },
      ],
      skipped: 0,
      imagePathsByTaskId: new Map([
        ["task-1", "task-images/user-1/task-1/photo.jpg"],
      ]),
    });
    deliverTaskMessageMock.mockResolvedValue({
      success: true,
      channel: "whatsapp",
      deliveryId: "delivery-1",
      messageId: "wamid.1",
    });

    await executeDelegationFromText("Tell Christopher to prepare these", {
      displayName: "Sana",
      userId: "user-1",
      dailyBrief: "",
      people: [
        {
          id: "person-1",
          user_id: "user-1",
          name: "Christopher",
          role: "chef",
          phone: "+971500000000",
          notes: null,
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
          whatsapp_consent_at: "2026-06-25T00:00:00.000Z",
          whatsapp_consent_method: "owner_confirmed",
          created_at: "2026-06-25T00:00:00.000Z",
        },
      ],
      tasks: [],
      imageFile: file,
      imageDescription: "The photo shows items to prepare.",
    });

    const imageMap = savePendingMock.mock.calls[0][4] as Map<string, File>;
    expect(imageMap.get("item-1")).toBe(file);

    // imagePath must be passed so the server can send the photo via the
    // WhatsApp image template or the confirm-page photo grid.
    const deliveryCall = deliverTaskMessageMock.mock.calls[0][0];
    expect(deliveryCall.taskId).toBe("task-1");
    expect(deliveryCall.imagePath).toBe("task-images/user-1/task-1/photo.jpg");

    // The raw AI vision description must never reach the staff WhatsApp message.
    expect(deliveryCall.messageText).not.toContain("Attached photo context:");
    expect(deliveryCall.messageText).not.toContain("# Image Description");
    // UUID filenames (e.g. "abc.jpeg:") must not appear
    expect(deliveryCall.messageText).not.toMatch(/[a-f0-9-]{8,}\.jpe?g:/i);
  });

  it("attaches the photo to a delegation item, not an earlier message-type item in the same batch", async () => {
    // Regression: when extraction returns a plain "message" item before the
    // "delegation" item, the old code picked whichever matched first
    // (type === "delegation" || "message"). A "message" row has task_id: null
    // and save.ts never reads imageFiles for it, so the photo was silently
    // dropped even though a real delegation existed in the same batch.
    const { executeDelegationFromText } = await import("./text-carson");

    const messageItem: ExtractedItem = {
      id: "item-message",
      type: "message",
      description: "dinner is at 9",
      assignedTo: "Grace",
      dueAt: null,
      dueText: null,
      suggestedMessage: "Dinner is at 9.",
      personalNote: null,
      needsPerson: false,
      needsClarification: false,
      clarificationQuestion: null,
    };
    const delegationItem: ExtractedItem = {
      id: "item-delegation",
      type: "delegation",
      description: "prepare these",
      assignedTo: "Christopher",
      dueAt: null,
      dueText: null,
      suggestedMessage: "Please prepare these.",
      personalNote: null,
      needsPerson: false,
      needsClarification: false,
      clarificationQuestion: null,
    };
    const file = new File(["image-bytes"], "photo.jpg", { type: "image/jpeg" });

    extractItemsMock.mockResolvedValue({
      extracted: [messageItem, delegationItem],
      summary: "Found a message and a delegation.",
    });
    savePendingMock.mockResolvedValue({
      tasks: [],
      messages: [],
      skipped: 0,
      imagePathsByTaskId: new Map(),
    });

    await executeDelegationFromText("Tell Grace dinner is at 9, and ask Christopher to prepare these", {
      displayName: "Sana",
      userId: "user-1",
      dailyBrief: "",
      people: [],
      tasks: [],
      imageFile: file,
      imageDescription: "The photo shows items to prepare.",
    });

    const imageMap = savePendingMock.mock.calls[0][4] as Map<string, File>;
    expect(imageMap.get("item-delegation")).toBe(file);
    expect(imageMap.has("item-message")).toBe(false);
  });

  it("returns success string when delivery completes within the race window", async () => {
    const { executeDelegationFromText } = await import("./text-carson");

    const extractedItem: ExtractedItem = {
      id: "item-1",
      type: "delegation",
      description: "make lunch",
      assignedTo: "Christopher",
      dueAt: null,
      dueText: null,
      suggestedMessage: "Please make lunch.",
      personalNote: null,
      needsPerson: false,
      needsClarification: false,
      clarificationQuestion: null,
    };

    extractItemsMock.mockResolvedValue({ extracted: [extractedItem], summary: "" });
    savePendingMock.mockResolvedValue({
      tasks: [
        {
          id: "task-1",
          user_id: "user-1",
          description: "make lunch",
          type: "delegation",
          assigned_to: "Christopher",
          status: "pending",
          needs_follow_up: true,
          confirmation_url: "https://app.test/confirm?task=task-1",
          confirmed_at: null,
          due_at: null,
          archived_at: null,
          created_at: "2026-06-30T00:00:00.000Z",
          qstash_message_id: null,
          followup_sent_at: null,
          escalated_at: null,
          image_path: "task-images/user-1/task-1/photo.jpg",
          proof_image_path: null,
        },
      ],
      messages: [
        {
          id: "msg-1",
          user_id: "user-1",
          task_id: "task-1",
          recipient: "Christopher",
          content: "Please make lunch.",
          confirmation_url: "https://app.test/confirm?task=task-1",
          status: "pending",
          created_at: "2026-06-30T00:00:00.000Z",
          sent_at: null,
          confirmed_at: null,
          whatsapp_message_id: null,
          whatsapp_delivery_status: null,
          whatsapp_status_updated_at: null,
          whatsapp_failure_reason: null,
        },
      ],
      skipped: 0,
      imagePathsByTaskId: new Map([["task-1", "task-images/user-1/task-1/photo.jpg"]]),
    });
    // Delivery resolves immediately with success.
    deliverTaskMessageMock.mockResolvedValue({ success: true, channel: "whatsapp", deliveryId: "d-1", messageId: "wamid.1" });

    const result = await executeDelegationFromText("Ask Christopher to make lunch", {
      displayName: "Sana",
      userId: "user-1",
      dailyBrief: "",
      people: [
        {
          id: "p-1",
          user_id: "user-1",
          name: "Christopher",
          role: "staff",
          phone: "+971500000000",
          notes: null,
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
          whatsapp_consent_at: "2026-06-30T00:00:00.000Z",
          whatsapp_consent_method: "owner_confirmed",
          created_at: "2026-06-30T00:00:00.000Z",
        },
      ],
      tasks: [],
      imageFile: new File(["x"], "photo.jpg", { type: "image/jpeg" }),
      imageDescription: "Photo 1 (abc123.jpeg): # Image Description\nA bowl of food.",
    });

    // Success — no failure wording.
    expect(result).not.toMatch(/wasn.t able/i);
    expect(result).not.toMatch(/timed out/i);
    expect(result).not.toMatch(/could not/i);
    expect(result).toMatch(/Christopher/i);
  });

  it("reports an unconfirmed send as failed when delivery takes longer than the race window", async () => {
    vi.useFakeTimers();
    const { executeDelegationFromText } = await import("./text-carson");

    const extractedItem: ExtractedItem = {
      id: "item-1",
      type: "delegation",
      description: "make lunch",
      assignedTo: "Christopher",
      dueAt: null,
      dueText: null,
      suggestedMessage: "Please make lunch.",
      personalNote: null,
      needsPerson: false,
      needsClarification: false,
      clarificationQuestion: null,
    };

    extractItemsMock.mockResolvedValue({ extracted: [extractedItem], summary: "" });
    savePendingMock.mockResolvedValue({
      tasks: [
        {
          id: "task-1",
          user_id: "user-1",
          description: "make lunch",
          type: "delegation",
          assigned_to: "Christopher",
          status: "pending",
          needs_follow_up: true,
          confirmation_url: "https://app.test/confirm?task=task-1",
          confirmed_at: null,
          due_at: null,
          archived_at: null,
          created_at: "2026-06-30T00:00:00.000Z",
          qstash_message_id: null,
          followup_sent_at: null,
          escalated_at: null,
          image_path: null,
          proof_image_path: null,
        },
      ],
      messages: [
        {
          id: "msg-1",
          user_id: "user-1",
          task_id: "task-1",
          recipient: "Christopher",
          content: "Please make lunch.",
          confirmation_url: "https://app.test/confirm?task=task-1",
          status: "pending",
          created_at: "2026-06-30T00:00:00.000Z",
          sent_at: null,
          confirmed_at: null,
          whatsapp_message_id: null,
          whatsapp_delivery_status: null,
          whatsapp_failure_reason: null,
          whatsapp_status_updated_at: null,
        },
      ],
      skipped: 0,
      imagePathsByTaskId: new Map(),
    });
    // Delivery never resolves — simulates Meta image upload hanging past EL timeout.
    deliverTaskMessageMock.mockReturnValue(new Promise(() => {}));

    const resultPromise = executeDelegationFromText("Ask Christopher to make lunch", {
      displayName: "Sana",
      userId: "user-1",
      dailyBrief: "",
      people: [
        {
          id: "p-1",
          user_id: "user-1",
          name: "Christopher",
          role: "staff",
          phone: "+971500000000",
          notes: null,
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
          whatsapp_consent_at: "2026-06-30T00:00:00.000Z",
          whatsapp_consent_method: "owner_confirmed",
          created_at: "2026-06-30T00:00:00.000Z",
        },
      ],
      tasks: [],
    });

    // Advance past the 12 s delivery race timeout.
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toContain("Christopher was NOT messaged");
    expect(result).toContain("Delivery was not confirmed before the timeout");

    vi.useRealTimers();
  });

  it("staff WhatsApp message never contains vision metadata or UUID filenames", async () => {
    const { executeDelegationFromText } = await import("./text-carson");

    const extractedItem: ExtractedItem = {
      id: "item-1",
      type: "delegation",
      description: "make the dish in the photo",
      assignedTo: "Christopher",
      dueAt: null,
      dueText: null,
      suggestedMessage: "Please make the dish in the photo.",
      personalNote: null,
      needsPerson: false,
      needsClarification: false,
      clarificationQuestion: null,
    };

    extractItemsMock.mockResolvedValue({ extracted: [extractedItem], summary: "" });
    savePendingMock.mockResolvedValue({
      tasks: [
        {
          id: "task-1",
          user_id: "user-1",
          description: "make the dish in the photo",
          type: "delegation",
          assigned_to: "Christopher",
          status: "pending",
          needs_follow_up: true,
          confirmation_url: "https://app.test/confirm?task=task-1",
          confirmed_at: null,
          due_at: null,
          archived_at: null,
          created_at: "2026-06-30T00:00:00.000Z",
          qstash_message_id: null,
          followup_sent_at: null,
          escalated_at: null,
          image_path: "task-images/user-1/task-1/photo.jpg",
          proof_image_path: null,
        },
      ],
      messages: [
        {
          id: "msg-1",
          user_id: "user-1",
          task_id: "task-1",
          recipient: "Christopher",
          content: "Please make the dish in the photo.",
          confirmation_url: "https://app.test/confirm?task=task-1",
          status: "pending",
          created_at: "2026-06-30T00:00:00.000Z",
          sent_at: null,
          confirmed_at: null,
          whatsapp_message_id: null,
          whatsapp_delivery_status: null,
          whatsapp_failure_reason: null,
          whatsapp_status_updated_at: null,
        },
      ],
      skipped: 0,
      imagePathsByTaskId: new Map([["task-1", "task-images/user-1/task-1/photo.jpg"]]),
    });
    deliverTaskMessageMock.mockResolvedValue({ success: true, channel: "whatsapp" });

    await executeDelegationFromText("Ask Christopher to make this", {
      displayName: "Sana",
      userId: "user-1",
      dailyBrief: "",
      people: [
        {
          id: "p-1",
          user_id: "user-1",
          name: "Christopher",
          role: "staff",
          phone: "+971500000000",
          notes: null,
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
          whatsapp_consent_at: "2026-06-30T00:00:00.000Z",
          whatsapp_consent_method: "owner_confirmed",
          created_at: "2026-06-30T00:00:00.000Z",
        },
      ],
      tasks: [],
      imageFile: new File(["x"], "a3f1b2c9-dead-beef-1234-abc.jpeg", { type: "image/jpeg" }),
      // Realistic AI vision description with UUID filename
      imageDescription:
        "Photo 1 (a3f1b2c9-dead-beef-1234-abc.jpeg): # Image Description\n## Content\nA plate of food.",
    });

    // messageText sent to deliverTaskMessage must contain none of the internal metadata.
    const deliveryCall = deliverTaskMessageMock.mock.calls[0][0];
    expect(deliveryCall.messageText).not.toContain("Attached photo context:");
    expect(deliveryCall.messageText).not.toContain("# Image Description");
    expect(deliveryCall.messageText).not.toContain("## Content");
    expect(deliveryCall.messageText).not.toContain("a3f1b2c9-dead-beef-1234-abc.jpeg");
    expect(deliveryCall.messageText).not.toContain("Photo 1 (");
  });

  it("single-recipient delegation still uses the existing extraction path", async () => {
    const { executeDelegationFromText } = await import("./text-carson");

    const extractedItem: ExtractedItem = {
      id: "item-1",
      type: "delegation",
      description: "prepare the table",
      assignedTo: "Grace",
      dueAt: null,
      dueText: null,
      suggestedMessage: "Please prepare the table.",
      personalNote: null,
      needsPerson: false,
      needsClarification: false,
      clarificationQuestion: null,
    };
    extractItemsMock.mockResolvedValue({ extracted: [extractedItem], summary: "" });
    savePendingMock.mockResolvedValue(saveResultForItems([extractedItem]));
    deliverTaskMessageMock.mockResolvedValue({ success: true, channel: "whatsapp" });

    await executeDelegationFromText("Ask Grace to prepare the table", {
      displayName: "Sana",
      userId: "user-1",
      dailyBrief: "",
      people: [person("Grace")],
      tasks: [],
    });

    expect(extractItemsMock).toHaveBeenCalledTimes(1);
    expect(savePendingMock).toHaveBeenCalledTimes(1);
    expect(deliverTaskMessageMock).toHaveBeenCalledTimes(1);
  });

  it("multi-recipient delegation creates separate records and sends every intended WhatsApp", async () => {
    const { executeDelegationFromText } = await import("./text-carson");
    const people = ["Grace", "Christopher", "Nasira", "Ghulam"].map(person);

    savePendingMock.mockImplementationOnce(async (items: ExtractedItem[]) => saveResultForItems(items));
    deliverTaskMessageMock.mockResolvedValue({ success: true, channel: "whatsapp" });

    const result = await executeDelegationFromText(
      "Ask Grace to prepare the table, Christopher to prepare lunch, Nasira to arrange flowers, and Ghulam to be on standby.",
      {
        displayName: "Sana",
        userId: "user-1",
        dailyBrief: "",
        people,
        tasks: [],
      },
    );

    expect(extractItemsMock).not.toHaveBeenCalled();
    const savedItems = savePendingMock.mock.calls[0][0] as ExtractedItem[];
    expect(savedItems.map((item) => [item.assignedTo, item.description])).toEqual([
      ["Grace", "prepare the table"],
      ["Christopher", "prepare lunch"],
      ["Nasira", "arrange flowers"],
      ["Ghulam", "be on standby."],
    ]);
    expect(deliverTaskMessageMock).toHaveBeenCalledTimes(4);
    expect(deliverTaskMessageMock.mock.calls.map(([payload]) => payload.recipientName)).toEqual([
      "Grace",
      "Christopher",
      "Nasira",
      "Ghulam",
    ]);
    expect(deliverTaskMessageMock.mock.calls.map(([payload]) => payload.messageText)).toEqual([
      "prepare the table",
      "prepare lunch",
      "arrange flowers",
      "be on standby.",
    ]);
    expect(result).toContain("Grace, Christopher, Nasira, Ghulam have it");
  });

  it("typed image multi-recipient incident routes three instructions and attaches the photo only to Christopher", async () => {
    const { executeDelegationFromText } = await import("./text-carson");
    const people = ["Christopher", "Nasira", "Ghulam"].map(person);
    const file = new File(["pizza"], "pizza.jpg", { type: "image/jpeg" });

    savePendingMock.mockImplementationOnce(async (items: ExtractedItem[]) => {
      const result = saveResultForItems(items);
      (result.tasks[0] as { image_path: string | null }).image_path =
        "task-images/user-1/task-1/photo.jpg";
      result.imagePathsByTaskId = new Map([
        ["task-1", "task-images/user-1/task-1/photo.jpg"],
      ]);
      return result;
    });
    deliverTaskMessageMock.mockResolvedValue({ success: true, channel: "whatsapp" });

    const result = await executeDelegationFromText(
      "Ask Christopher to do this for snack now and tell Nasira to call me now and tell Ghulam to bring the car out",
      {
        displayName: "Sana",
        userId: "user-1",
        dailyBrief: "",
        people,
        tasks: [],
        imageFile: file,
        allImageFiles: [file],
        imageDescription: "A pepperoni pizza.",
      },
    );

    expect(extractItemsMock).not.toHaveBeenCalled();
    const savedItems = savePendingMock.mock.calls[0][0] as ExtractedItem[];
    expect(savedItems.map((item) => [item.assignedTo, item.description])).toEqual([
      ["Christopher", "do this for snack now"],
      ["Nasira", "call me now"],
      ["Ghulam", "bring the car out"],
    ]);

    const imageMap = savePendingMock.mock.calls[0][4] as Map<string, File>;
    expect(imageMap.get(savedItems[0].id)).toBe(file);
    expect(imageMap.has(savedItems[1].id)).toBe(false);
    expect(imageMap.has(savedItems[2].id)).toBe(false);

    expect(deliverTaskMessageMock).toHaveBeenCalledTimes(3);
    expect(deliverTaskMessageMock.mock.calls.map(([payload]) => [
      payload.recipientName,
      payload.messageText,
      payload.imagePath,
    ])).toEqual([
      ["Christopher", "do this for snack now", "task-images/user-1/task-1/photo.jpg"],
      ["Nasira", "call me now", null],
      ["Ghulam", "bring the car out", null],
    ]);
    expect(result).toContain("Christopher, Nasira, Ghulam have it");
  });

  it("does not let one recipient receive another person's instruction", async () => {
    const { executeDelegationFromText } = await import("./text-carson");
    const people = ["Grace", "Christopher"].map(person);

    savePendingMock.mockImplementationOnce(async (items: ExtractedItem[]) => saveResultForItems(items));
    deliverTaskMessageMock.mockResolvedValue({ success: true, channel: "whatsapp" });

    await executeDelegationFromText(
      "Ask Grace to prepare the table, and Christopher to prepare lunch.",
      {
        displayName: "Sana",
        userId: "user-1",
        dailyBrief: "",
        people,
        tasks: [],
      },
    );

    const deliveries = deliverTaskMessageMock.mock.calls.map(([payload]) => payload);
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toMatchObject({
      recipientName: "Grace",
      messageText: "prepare the table",
    });
    expect(deliveries[0].messageText).not.toContain("prepare lunch");
    expect(deliveries[1]).toMatchObject({
      recipientName: "Christopher",
      messageText: "prepare lunch.",
    });
    expect(deliveries[1].messageText).not.toContain("prepare the table");
  });

  it("multi-recipient delegation reports failed recipients without hiding successful sends", async () => {
    const { executeDelegationFromText } = await import("./text-carson");
    const people = ["Grace", "Christopher", "Nasira", "Ghulam"].map(person);

    savePendingMock.mockImplementationOnce(async (items: ExtractedItem[]) => saveResultForItems(items));
    deliverTaskMessageMock
      .mockResolvedValueOnce({ success: true, channel: "whatsapp" })
      .mockResolvedValueOnce({ success: true, channel: "whatsapp" })
      .mockResolvedValueOnce({ success: false, channel: "whatsapp", error: "Meta rejected the message" })
      .mockResolvedValueOnce({ success: true, channel: "whatsapp" });

    const result = await executeDelegationFromText(
      "Ask Grace to prepare the table, Christopher to prepare lunch, Nasira to arrange flowers, and Ghulam to be on standby.",
      {
        displayName: "Sana",
        userId: "user-1",
        dailyBrief: "",
        people,
        tasks: [],
      },
    );

    expect(deliverTaskMessageMock).toHaveBeenCalledTimes(4);
    expect(result).toContain("Grace, Christopher, Ghulam have it");
    expect(result).toContain("Nasira was NOT messaged — Meta rejected the message");
    expect(result).not.toContain("task created for Nasira");
  });

  it("missing phone does not claim success or call the delivery boundary", async () => {
    const { executeDelegationFromText } = await import("./text-carson");
    const extractedItem: ExtractedItem = {
      id: "item-1",
      type: "delegation",
      description: "prepare lunch",
      assignedTo: "Christopher",
      dueAt: null,
      dueText: null,
      suggestedMessage: "Please prepare lunch.",
      personalNote: null,
      needsPerson: false,
      needsClarification: false,
      clarificationQuestion: null,
    };

    extractItemsMock.mockResolvedValue({ extracted: [extractedItem], summary: "" });
    savePendingMock.mockResolvedValue(saveResultForItems([extractedItem]));

    const result = await executeDelegationFromText("Ask Christopher to prepare lunch", {
      displayName: "Sana",
      userId: "user-1",
      dailyBrief: "",
      people: [person("Christopher", { phone: "" })],
      tasks: [],
    });

    expect(deliverTaskMessageMock).not.toHaveBeenCalled();
    expect(result).toContain("Christopher was NOT messaged");
    expect(result).toContain("No phone number is saved");
  });

  it("photo delegation does not send when multi-photo attachment persistence fails", async () => {
    const { saveTaskAttachments } = await import("./save");
    vi.mocked(saveTaskAttachments).mockRejectedValueOnce(new Error("storage unavailable"));
    const { executeDelegationFromText } = await import("./text-carson");
    const extractedItem: ExtractedItem = {
      id: "item-1",
      type: "delegation",
      description: "make this",
      assignedTo: "Christopher",
      dueAt: null,
      dueText: null,
      suggestedMessage: "Please make this.",
      personalNote: null,
      needsPerson: false,
      needsClarification: false,
      clarificationQuestion: null,
    };

    extractItemsMock.mockResolvedValue({ extracted: [extractedItem], summary: "" });
    savePendingMock.mockResolvedValue({
      ...saveResultForItems([extractedItem]),
      imagePathsByTaskId: new Map([["task-1", "task-images/user-1/task-1/photo.jpg"]]),
    });

    const result = await executeDelegationFromText("Ask Christopher to make this", {
      displayName: "Sana",
      userId: "user-1",
      dailyBrief: "",
      people: [person("Christopher")],
      tasks: [],
      allImageFiles: [
        new File(["one"], "one.jpg", { type: "image/jpeg" }),
        new File(["two"], "two.jpg", { type: "image/jpeg" }),
      ],
    });

    expect(deliverTaskMessageMock).not.toHaveBeenCalled();
    expect(result).toContain("Christopher was NOT messaged");
    expect(result).toContain("attached photos could not be saved");
  });

  // ── Live failure reproduction: cross-path duplicate delegation send ───────
  // Production incident: attaching 2 photos and asking Carson to delegate
  // produced TWO real, delivered WhatsApp sends to Christopher 9 seconds
  // apart (confirmed via tasks/messages/whatsapp_deliveries — both had a real
  // meta_message_id and reached delivery_status "read"), because the
  // send_delegation tool's cooldown was never consulted by this
  // (executeDelegationFromText) path, and the two attempts used slightly
  // different task text ("make these for dinner." vs "make these for dinner.
  // I'll attach the photos.") so an exact-text cooldown could not have caught
  // it anyway. isDuplicateDelegation/onDelegationSent close that gap.
  describe("cross-path duplicate delegation guard", () => {
    it("2-photo delegation still sends successfully when no duplicate is recorded", async () => {
      const { executeDelegationFromText } = await import("./text-carson");
      const extractedItem: ExtractedItem = {
        id: "item-1",
        type: "delegation",
        description: "make these for dinner",
        assignedTo: "Christopher",
        dueAt: null,
        dueText: null,
        suggestedMessage: "Please make these for dinner.",
        personalNote: null,
        needsPerson: false,
        needsClarification: false,
        clarificationQuestion: null,
      };
      extractItemsMock.mockResolvedValue({ extracted: [extractedItem], summary: "" });
      savePendingMock.mockResolvedValue(saveResultForItems([extractedItem]));
      deliverTaskMessageMock.mockResolvedValue({ success: true, channel: "whatsapp", deliveryId: "d-1", messageId: "wamid.1" });

      const onDelegationSent = vi.fn();
      const result = await executeDelegationFromText("Ask Christopher to make these for dinner", {
        displayName: "Sana",
        userId: "user-1",
        dailyBrief: "",
        people: [person("Christopher")],
        tasks: [],
        allImageFiles: [
          new File(["one"], "one.jpg", { type: "image/jpeg" }),
          new File(["two"], "two.jpg", { type: "image/jpeg" }),
        ],
        isDuplicateDelegation: () => false,
        onDelegationSent,
      });

      expect(deliverTaskMessageMock).toHaveBeenCalledTimes(1);
      expect(result).toContain("Christopher has it");
      // The caller's tracker must learn about this real send so a later call
      // through a different path can detect it as a duplicate.
      expect(onDelegationSent).toHaveBeenCalledWith("Christopher", "make these for dinner");
    });

    it("skips the WhatsApp send and reports truthfully when the shared guard recognizes a recent duplicate", async () => {
      const { executeDelegationFromText } = await import("./text-carson");
      const extractedItem: ExtractedItem = {
        id: "item-1",
        type: "delegation",
        description: "make these for dinner. I'll attach the photos.",
        assignedTo: "Christopher",
        dueAt: null,
        dueText: null,
        suggestedMessage: "Please make these for dinner.",
        personalNote: null,
        needsPerson: false,
        needsClarification: false,
        clarificationQuestion: null,
      };
      extractItemsMock.mockResolvedValue({ extracted: [extractedItem], summary: "" });
      savePendingMock.mockResolvedValue(saveResultForItems([extractedItem]));

      // Simulates: the first send already happened through send_delegation
      // (the tool path), so the shared guard now recognizes this as a repeat.
      const isDuplicateDelegation = vi.fn().mockReturnValue(true);
      const onDelegationSent = vi.fn();
      const result = await executeDelegationFromText(
        "Ask Christopher to make these for dinner. I'll attach the photos.",
        {
          displayName: "Sana",
          userId: "user-1",
          dailyBrief: "",
          people: [person("Christopher")],
          tasks: [],
          isDuplicateDelegation,
          onDelegationSent,
        },
      );

      // The real defect reproduced live: Carson must never claim success
      // ("Christopher has it") when the actual WhatsApp send never fired.
      expect(deliverTaskMessageMock).not.toHaveBeenCalled();
      expect(result).not.toContain("Christopher has it");
      expect(result).toContain("Christopher was NOT messaged");
      expect(result).toContain("already sent this delegation moments ago");
      // The guard must never be told a send happened when none did.
      expect(onDelegationSent).not.toHaveBeenCalled();
      expect(isDuplicateDelegation).toHaveBeenCalledWith(
        "Christopher",
        "make these for dinner. I'll attach the photos.",
      );
    });

    it("single-photo delegation still works when no duplicate guard is supplied (TextCarsonPanel behavior unchanged)", async () => {
      const { executeDelegationFromText } = await import("./text-carson");
      const extractedItem: ExtractedItem = {
        id: "item-1",
        type: "delegation",
        description: "make this for lunch",
        assignedTo: "Christopher",
        dueAt: null,
        dueText: null,
        suggestedMessage: "Please make this for lunch.",
        personalNote: null,
        needsPerson: false,
        needsClarification: false,
        clarificationQuestion: null,
      };
      extractItemsMock.mockResolvedValue({ extracted: [extractedItem], summary: "" });
      savePendingMock.mockResolvedValue(saveResultForItems([extractedItem]));
      deliverTaskMessageMock.mockResolvedValue({ success: true, channel: "whatsapp" });

      // No isDuplicateDelegation/onDelegationSent supplied at all — must
      // behave exactly as before this fix (TextCarsonPanel never passes these).
      const result = await executeDelegationFromText("Ask Christopher to make this for lunch", {
        displayName: "Sana",
        userId: "user-1",
        dailyBrief: "",
        people: [person("Christopher")],
        tasks: [],
        imageFile: new File(["x"], "photo.jpg", { type: "image/jpeg" }),
      });

      expect(deliverTaskMessageMock).toHaveBeenCalledTimes(1);
      expect(result).toContain("Christopher has it");
    });
  });

  // ── describeImageForTextCarson — exact brand/product text preservation ────
  // Production bug (2026-07-10): a reference photo of "TEREA Silver" produced
  // the task "Buy OTEREA Silver cigarettes." This is the highest-risk point
  // in the pipeline for that class of bug — Home.tsx's text+image submission
  // branch summarizes the photo here BEFORE the main extraction model ever
  // runs, so the main model never sees the actual image, only this one
  // sentence. Any brand/product text altered here can never be recovered
  // downstream.
  describe("describeImageForTextCarson — exact brand/product text preservation", () => {
    it("sends a prompt requiring exact, character-for-character transcription of visible text", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ content: [{ text: "A pack of TEREA Silver cigarettes." }] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const { describeImageForTextCarson } = await import("./text-carson");
      const file = new File(["bytes"], "photo.jpg", { type: "image/jpeg" });
      const result = await describeImageForTextCarson(file);

      expect(result).toBe("A pack of TEREA Silver cigarettes.");
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const promptText = body.messages[0].content.find((c: { type: string }) => c.type === "text").text;
      expect(promptText).toMatch(/transcribe it exactly as printed, character-for-character/i);
      expect(promptText).toMatch(/never invent characters, correct spelling, or substitute/i);
      expect(promptText).toMatch(/this description is the only thing the task-extraction step will ever see/i);
    });

    it("still asks for one concise sentence — the fix does not change output format or length expectations", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ content: [{ text: "A bowl of soup." }] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const { describeImageForTextCarson } = await import("./text-carson");
      await describeImageForTextCarson(new File(["bytes"], "photo.jpg", { type: "image/jpeg" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const promptText = body.messages[0].content.find((c: { type: string }) => c.type === "text").text;
      expect(promptText).toMatch(/describe this image in one sentence/i);
      expect(promptText).toMatch(/be concise/i);
      expect(body.max_tokens).toBe(120);
      expect(body.model).toBe("claude-haiku-4-5-20251001");
    });

    it("directs unclear reads to be flagged rather than guessed", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ content: [{ text: "text" }] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const { describeImageForTextCarson } = await import("./text-carson");
      await describeImageForTextCarson(new File(["bytes"], "photo.jpg", { type: "image/jpeg" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const promptText = body.messages[0].content.find((c: { type: string }) => c.type === "text").text;
      expect(promptText).toMatch(/too unclear to read with confidence.*say so plainly.*rather than guessing/is);
    });

    it("unchanged: returns null on a failed request, unaffected by the prompt change", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
      const { describeImageForTextCarson } = await import("./text-carson");
      const result = await describeImageForTextCarson(new File(["bytes"], "photo.jpg", { type: "image/jpeg" }));
      expect(result).toBeNull();
    });
  });
});

function person(name: string, overrides?: Record<string, unknown> | number) {
  const safeOverrides =
    overrides && typeof overrides === "object" && !Array.isArray(overrides)
      ? overrides
      : {};
  return {
    id: `person-${name.toLowerCase()}`,
    user_id: "user-1",
    name,
    role: "staff",
    phone: `+9715000000${name.length}`,
    notes: null,
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
    whatsapp_consent_at: "2026-06-30T00:00:00.000Z",
    whatsapp_consent_method: "owner_confirmed",
    created_at: "2026-06-30T00:00:00.000Z",
    ...safeOverrides,
  };
}

function saveResultForItems(items: ExtractedItem[]) {
  return {
    tasks: items.map((item, index) => ({
      id: `task-${index + 1}`,
      user_id: "user-1",
      description: item.description,
      type: item.type,
      assigned_to: item.assignedTo,
      status: "pending",
      needs_follow_up: true,
      confirmation_url: `https://app.test/confirm?task=task-${index + 1}`,
      confirmed_at: null,
      due_at: null,
      archived_at: null,
      created_at: "2026-06-30T00:00:00.000Z",
      qstash_message_id: null,
      followup_sent_at: null,
      escalated_at: null,
      image_path: null,
      proof_image_path: null,
    })),
    messages: items.map((item, index) => ({
      id: `msg-${index + 1}`,
      user_id: "user-1",
      task_id: `task-${index + 1}`,
      recipient: item.assignedTo,
      content: item.suggestedMessage ?? item.description,
      confirmation_url: `https://app.test/confirm?task=task-${index + 1}`,
      status: "pending",
      created_at: "2026-06-30T00:00:00.000Z",
      sent_at: null,
      confirmed_at: null,
      whatsapp_message_id: null,
      whatsapp_delivery_status: null,
      whatsapp_failure_reason: null,
      whatsapp_status_updated_at: null,
    })),
    todos: [],
    notesSaved: 0,
    skipped: 0,
    imagePathsByTaskId: new Map(),
  };
}
