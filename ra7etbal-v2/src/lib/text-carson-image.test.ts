import { beforeEach, describe, expect, it, vi } from "vitest";
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
  listTasks: vi.fn(),
}));

vi.mock("./image-upload", () => ({
  resizeImage: vi.fn(),
}));

vi.mock("./calendar", () => ({
  filterCalendarEventsByRange: vi.fn(),
}));

vi.mock("./routines", () => ({
  listRoutines: vi.fn(),
}));

vi.mock("../stores/tasks", () => ({
  useTasksStore: {
    getState: () => ({
      loadFor: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

vi.mock("./carson-facts", () => ({
  loadUserMemory: vi.fn(),
  upsertUserFacts: vi.fn(),
}));

vi.mock("./carson-memory", () => ({
  loadRecentMemory: vi.fn(),
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
    expect(deliverTaskMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        imagePath: "task-images/user-1/task-1/photo.jpg",
        messageText: expect.stringContaining("Attached photo context:"),
      }),
    );
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
});
