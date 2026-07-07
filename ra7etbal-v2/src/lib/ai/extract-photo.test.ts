import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractItemsFromPhoto } from "./extract-photo";

vi.mock("../image-upload", () => ({
  resizeImage: vi.fn(async (file: File) => file),
}));

function mockPhotoExtraction(items: Array<Record<string, unknown>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: "Captured from photo.",
                extracted: items,
              }),
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    ),
  );
}

describe("extractItemsFromPhoto — Clear My Head image routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps reminder detection from image-only capture", async () => {
    mockPhotoExtraction([
      {
        id: "photo-reminder",
        type: "reminder",
        description: "Call the dentist",
        assignedTo: "__me__",
        dueAt: "2026-07-08T09:00:00.000Z",
        dueText: "tomorrow",
      },
    ]);

    const result = await extractItemsFromPhoto(
      new File(["image"], "note.jpg", { type: "image/jpeg" }),
      [],
      "Sana",
    );

    expect(result.extracted[0]).toMatchObject({
      type: "reminder",
      description: "Call the dentist",
      assignedTo: "__me__",
      dueAt: "2026-07-08T09:00:00.000Z",
    });
  });

  it("keeps delegation detection from image-only capture", async () => {
    mockPhotoExtraction([
      {
        id: "photo-delegation",
        type: "delegation",
        description: "Pick up the dry cleaning",
        assignedTo: "Grace",
        suggestedMessage: "Please pick up the dry cleaning.",
      },
    ]);

    const result = await extractItemsFromPhoto(
      new File(["image"], "delegation.jpg", { type: "image/jpeg" }),
      [{ id: "p1", name: "Grace", role: "assistant" } as any],
      "Sana",
    );

    expect(result.extracted[0]).toMatchObject({
      type: "delegation",
      assignedTo: "Grace",
    });
  });

  it("routes image-only personal actions to to-do instead of generic tasks", async () => {
    mockPhotoExtraction([
      {
        id: "photo-todo",
        type: "action",
        description: "Buy flowers",
        assignedTo: null,
        dueAt: null,
      },
    ]);

    const result = await extractItemsFromPhoto(
      new File(["image"], "todo.jpg", { type: "image/jpeg" }),
      [],
      "Sana",
    );

    expect(result.extracted[0].type).toBe("todo");
  });

  it("routes explicit note text from image-only capture to parked notes", async () => {
    mockPhotoExtraction([
      {
        id: "photo-note",
        type: "action",
        description: "Remember this idea for later",
        assignedTo: null,
        dueAt: null,
      },
    ]);

    const result = await extractItemsFromPhoto(
      new File(["image"], "note.jpg", { type: "image/jpeg" }),
      [],
      "Sana",
    );

    expect(result.extracted[0].type).toBe("parked");
  });

  it("surfaces broken image processing before routing", async () => {
    const { resizeImage } = await import("../image-upload");
    vi.mocked(resizeImage).mockRejectedValueOnce(new Error("Could not load image. Please try a different file."));

    await expect(
      extractItemsFromPhoto(new File(["broken"], "broken.jpg", { type: "image/jpeg" }), [], "Sana"),
    ).rejects.toThrow("Could not load image");
  });
});
