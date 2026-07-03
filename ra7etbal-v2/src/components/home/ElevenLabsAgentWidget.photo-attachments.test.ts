import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(__dirname, "ElevenLabsAgentWidget.tsx"),
  "utf-8",
);

function blockBetween(startNeedle: string, endNeedle: string): string {
  const start = SOURCE.indexOf(startNeedle);
  const end = SOURCE.indexOf(endNeedle, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

function functionBlock(name: string): string {
  const start = SOURCE.indexOf(`function ${name}`);
  expect(start).toBeGreaterThan(-1);
  const nextFunction = SOURCE.indexOf("\n  function ", start + 1);
  const nextComment = SOURCE.indexOf("\n  //", start + 1);
  const candidates = [nextFunction, nextComment].filter((i) => i > start);
  const end = candidates.length ? Math.min(...candidates) : SOURCE.length;
  return SOURCE.slice(start, end);
}

describe("ElevenLabsAgentWidget — Talk to Carson photo attachments", () => {
  it("keeps the pre-session image available to Carson at session start", () => {
    expect(SOURCE).toContain("sessionPhotosRef.current = [...pendingPhotosRef.current]");
    expect(SOURCE).toContain("describePhotosForCarson(sessionPhotosRef.current)");
    expect(SOURCE).toContain("Attached photos context (use this for the conversation)");
    expect(SOURCE).toContain("conv.sendContextualUpdate(");
    expect(SOURCE).toContain("The user has attached photos. Here are descriptions:");
  });

  it("attaching during an active session replaces the current image and updates Carson context", () => {
    const block = functionBlock("handleImageFileChange");

    expect(block).toContain("const file = newFiles.slice(0, MAX_VOICE_PHOTOS)[0]");
    expect(block).toContain("if (!file) return");
    expect(block).toContain("syncPendingPhotoState(newPhotos)");
    expect(block).toContain("sessionPhotosRef.current = newPhotos");
    expect(block).toContain("MID_SESSION_PHOTO_PENDING_CONTEXT");
    expect(block).toContain("[Session photo update]");
    expect(SOURCE).toContain("The current photo is available for delegation");
    expect(block).toContain('statusRef.current === "connected"');
    expect(block).toContain("describePhotosForCarson(newPhotos)");
    expect(block).toContain("The user just attached or replaced the photo during this call.");
    expect(block).toContain("Use this current photo only");
    expect(block).toContain("Ignore any earlier attached photo");
  });

  it("removing an image clears live session image state and tells Carson not to use it", () => {
    const block = functionBlock("removePendingPhoto");

    expect(block).not.toContain('if (status !== "idle") return');
    expect(block).toContain("photoRevisionRef.current += 1");
    expect(block).toContain("syncPendingPhotoState(next)");
    expect(block).toContain("sessionPhotosRef.current = next");
    expect(block).toContain("sessionPhotoContextRef.current = null");
    expect(block).toContain("The user removed the attached photo during this call.");
    expect(block).toContain("Do not use any previously attached photo");
  });

  it("replacing an image uses the newest image only and ignores stale vision results", () => {
    const block = functionBlock("handleImageFileChange");

    expect(block).toContain("for (const photo of previousPhotos)");
    expect(block).toContain("URL.revokeObjectURL(photo.previewUrl)");
    expect(block).toContain("photoRevisionRef.current = revision");
    expect(block).toContain("photoRevisionRef.current !== revision");
    expect(block).toContain("pendingPhotosRef.current[0]?.id !== newPhoto.id");
    expect(block).not.toContain("appendPhotoContextDescription");
    expect(block).not.toContain("sessionPhotosRef.current = [...sessionPhotosRef.current, ...newPhotos]");
    expect(block).not.toContain("syncPendingPhotoState([...existing, ...newPhotos])");
  });

  it("delegation sends the current image from the live ref and clears it after success", () => {
    const block = blockBetween(
      "Snapshot pending photos — prefer live ref",
      "lastSentRef.current.set(cooldownKey",
    );

    expect(block).toContain("pendingPhotosRef.current.length > 0");
    expect(block).toContain("? pendingPhotosRef.current");
    expect(block).toContain(": sessionPhotosRef.current");
    expect(block).toContain("const delegationImageFile = delegationPhotos[0]?.file ?? null");
    expect(block).toContain("const delegationImageFiles = delegationPhotos.map((p) => p.file)");
    expect(block).toContain("imageFile: delegationImageFile");
    expect(block).toContain("imageFiles: delegationImageFiles");
    expect(block).toContain("if (delegationPhotos.length > 0) clearPendingImages()");
  });

  it("wrong or removed images cannot be sent by the Talk to Carson UI", () => {
    expect(SOURCE).toContain("const MAX_VOICE_PHOTOS = 1");
    expect(SOURCE).not.toMatch(/type="file"[\s\S]{0,120}multiple/);
    expect(SOURCE).toContain('aria-label="Remove attached photo"');
    expect(SOURCE).toContain("Replace photo for Carson");
    expect(SOURCE).not.toContain("disabled={pendingPhotoPreviews.length >= 5}");
  });
});
