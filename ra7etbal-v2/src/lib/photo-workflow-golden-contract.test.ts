/**
 * Golden regression contract — client-side half of the protected photo
 * workflow (production baseline commit 447a685). See
 * api/photo-workflow-golden-contract.test.js for the server-side half.
 *
 * This suite exists because the same production incident recurred three
 * times in one day across this exact pipeline (PRs #78, #79, #80/#81, #82) —
 * a private handwritten note's photo leaked to staff, then a legitimate
 * visual-reference photo was silently dropped, then real WhatsApp media
 * never sent for 2+ photos, then a second reference photo was dropped from
 * Quality Intelligence review. Each fix was correct in isolation but the
 * class of regression kept recurring because no single test suite locked
 * the *whole* photo journey together. This file (and its server-side pair)
 * is that lock. It calls the real production functions — not source-text
 * scans — so a future change that breaks any of these scenarios fails CI
 * on every PR (wired into package.json's test:carson-protected script),
 * regardless of which file the change touches.
 *
 * Scenario labels match the ones in RA7ETBAL_STATE.md's protected-workflow
 * note and the task that created this suite:
 *   H — mixed private note image withheld
 *   I — explicit "send this photo" preserves the attachment
 *   L — cross-recipient image authorization isolated per task item
 *   A (client half) — a single genuinely-referenced photo is attached for
 *     persistence (the server half, in the paired file, proves it then
 *     reaches the real WhatsApp payload)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractedItem } from "../types/extraction";
import { shouldForwardAttachedImage } from "./image-forwarding-guard";

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

function person(name: string) {
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
    whatsapp_consent_at: "2026-07-26T00:00:00.000Z",
    whatsapp_consent_method: "owner_confirmed",
    created_at: "2026-07-26T00:00:00.000Z",
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
      created_at: "2026-07-26T00:00:00.000Z",
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
      created_at: "2026-07-26T00:00:00.000Z",
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

describe("Golden contract — protected photo workflow (client half, baseline 447a685)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("[H] mixed private note image: withheld — no image handed to savePending", async () => {
    const { executeDelegationFromText } = await import("./text-carson");
    const groceriesItem: ExtractedItem = {
      id: "item-groceries",
      type: "delegation",
      description: "buy groceries",
      assignedTo: "Christopher",
      dueAt: null,
      dueText: null,
      suggestedMessage: "Please buy groceries.",
      personalNote: null,
      needsPerson: false,
      needsClarification: false,
      clarificationQuestion: null,
    };
    extractItemsMock.mockResolvedValue({ extracted: [groceriesItem], summary: "" });
    savePendingMock.mockResolvedValue(saveResultForItems([groceriesItem]));
    deliverTaskMessageMock.mockResolvedValue({ success: true, channel: "whatsapp" });

    await executeDelegationFromText("Ask Christopher to buy groceries", {
      displayName: "Sana",
      userId: "user-1",
      dailyBrief: "",
      people: [person("Christopher")],
      tasks: [],
      imageFile: new File(["note-bytes"], "note.jpg", { type: "image/jpeg" }),
      imageDescription: "A handwritten note with several personal items.",
    });

    expect(savePendingMock.mock.calls[0][4]).toBeUndefined();
  });

  it("[I] explicit \"send this photo\": preserves the attachment", async () => {
    const { executeDelegationFromText } = await import("./text-carson");
    const item: ExtractedItem = {
      id: "item-send-photo",
      type: "delegation",
      description: "send this photo",
      assignedTo: "Christopher",
      dueAt: null,
      dueText: null,
      suggestedMessage: "Here is the photo.",
      personalNote: null,
      needsPerson: false,
      needsClarification: false,
      clarificationQuestion: null,
    };
    const photo = new File(["photo-bytes"], "photo.jpg", { type: "image/jpeg" });
    extractItemsMock.mockResolvedValue({ extracted: [item], summary: "" });
    savePendingMock.mockResolvedValue(saveResultForItems([item]));
    deliverTaskMessageMock.mockResolvedValue({ success: true, channel: "whatsapp" });

    await executeDelegationFromText("Send this photo to Christopher", {
      displayName: "Sana",
      userId: "user-1",
      dailyBrief: "",
      people: [person("Christopher")],
      tasks: [],
      imageFile: photo,
    });

    const imageMap = savePendingMock.mock.calls[0][4] as Map<string, File>;
    expect(imageMap?.get("item-send-photo")).toBe(photo);
  });

  it("[A-client] single genuinely-referenced photo: attached for persistence when the instruction names the photographed subject", async () => {
    const { executeDelegationFromText } = await import("./text-carson");
    const item: ExtractedItem = {
      id: "item-pizza",
      type: "delegation",
      description: "make this pizza",
      assignedTo: "Christopher",
      dueAt: null,
      dueText: null,
      suggestedMessage: "Please make this pizza.",
      personalNote: null,
      needsPerson: false,
      needsClarification: false,
      clarificationQuestion: null,
    };
    const pizzaPhoto = new File(["pizza-bytes"], "pizza.jpg", { type: "image/jpeg" });
    extractItemsMock.mockResolvedValue({ extracted: [item], summary: "" });
    savePendingMock.mockResolvedValue(saveResultForItems([item]));
    deliverTaskMessageMock.mockResolvedValue({ success: true, channel: "whatsapp" });

    await executeDelegationFromText("Tell Christopher to make this pizza", {
      displayName: "Sana",
      userId: "user-1",
      dailyBrief: "",
      people: [person("Christopher")],
      tasks: [],
      imageFile: pizzaPhoto,
    });

    const imageMap = savePendingMock.mock.calls[0][4] as Map<string, File>;
    expect(imageMap?.get("item-pizza")).toBe(pizzaPhoto);
  });

  it("[L] cross-recipient isolation: a visual reference in one recipient's clause never authorizes forwarding to a different, unrelated recipient", async () => {
    const { executeDelegationFromText } = await import("./text-carson");
    const groceriesItem: ExtractedItem = {
      id: "item-groceries",
      type: "delegation",
      description: "buy groceries",
      assignedTo: "Christopher",
      dueAt: null,
      dueText: null,
      suggestedMessage: "Please buy groceries.",
      personalNote: null,
      needsPerson: false,
      needsClarification: false,
      clarificationQuestion: null,
    };
    const pizzaItem: ExtractedItem = {
      id: "item-pizza",
      type: "delegation",
      description: "make this pizza",
      assignedTo: "Grace",
      dueAt: null,
      dueText: null,
      suggestedMessage: "Please make this pizza.",
      personalNote: null,
      needsPerson: false,
      needsClarification: false,
      clarificationQuestion: null,
    };
    const pizzaPhoto = new File(["pizza-bytes"], "pizza.jpg", { type: "image/jpeg" });
    extractItemsMock.mockResolvedValue({ extracted: [groceriesItem, pizzaItem], summary: "" });
    savePendingMock.mockResolvedValue(saveResultForItems([groceriesItem, pizzaItem]));
    deliverTaskMessageMock.mockResolvedValue({ success: true, channel: "whatsapp" });

    await executeDelegationFromText(
      "Ask Christopher to buy groceries, and ask Grace to make this pizza",
      {
        displayName: "Sana",
        userId: "user-1",
        dailyBrief: "",
        people: [person("Christopher"), person("Grace")],
        tasks: [],
        imageFile: pizzaPhoto,
      },
    );

    const imageMap = savePendingMock.mock.calls[0][4] as Map<string, File>;
    expect(imageMap?.get("item-pizza")).toBe(pizzaPhoto);
    expect(imageMap?.has("item-groceries")).toBe(false);
  });

  it("[guard unit] shouldForwardAttachedImage: the exact boundary the above scenarios depend on", () => {
    // Private note / no visual reference — deny.
    expect(shouldForwardAttachedImage("Ask Christopher to buy groceries")).toBe(false);
    // Bare demonstrative referencing the photographed subject — allow.
    expect(shouldForwardAttachedImage("Tell Christopher to make this pizza")).toBe(true);
    // Non-demonstrative "shown in the photo" phrasing — allow (regression, PR #79).
    expect(shouldForwardAttachedImage("Make the pizza shown in the attached photo for dinner.")).toBe(true);
    // Explicit send/share/forward/show — allow regardless of demonstrative wording.
    expect(shouldForwardAttachedImage("Send this photo to Christopher")).toBe(true);
  });
});
