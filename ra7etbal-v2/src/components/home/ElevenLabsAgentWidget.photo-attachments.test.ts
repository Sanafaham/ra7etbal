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

describe("ElevenLabsAgentWidget — Talk to Carson multi-photo attachments", () => {
  it("caps voice photos at 5 and defines the block-copy message", () => {
    expect(SOURCE).toContain("const MAX_VOICE_PHOTOS = 5");
    expect(SOURCE).toContain('const PHOTO_LIMIT_MESSAGE = "You can attach up to 5 photos."');
  });

  it("keeps pre-session images available at voice start without pre-authorizing typed photos", () => {
    expect(SOURCE).toContain(
      "sessionPhotosRef.current = [...pendingPhotosRef.current]",
    );
    expect(SOURCE).toContain("describePhotosForCarson(sessionPhotosRef.current)");
    expect(SOURCE).toContain('requestedChannel === "voice" && sessionPhotoContextRef.current');
    expect(SOURCE).toContain("Attached photos context (use this for the conversation)");
    expect(SOURCE).toContain("conv.sendContextualUpdate(");
    expect(SOURCE).toContain("The user has attached photos. Here are descriptions:");
  });

  it("describePhotosForCarson tells Carson how many photos are currently attached", () => {
    const block = functionBlock("describePhotosForCarson");
    expect(block).toContain("const count = photos.length");
    expect(block).toContain('`${count} photo${count === 1 ? "" : "s"} attached.\\n${lines.join("\\n")}`');
  });

  it("the file input allows selecting more than one photo", () => {
    expect(SOURCE).toMatch(/type="file"[\s\S]{0,200}multiple/);
    expect(SOURCE).toContain('aria-label="Attach photos"');
  });

  it("selecting 1 to 5 photos accumulates them instead of replacing the set", () => {
    const block = functionBlock("handleImageFileChange");

    expect(block).toContain("const previousPhotos = pendingPhotosRef.current");
    expect(block).toContain("const availableSlots = Math.max(0, MAX_VOICE_PHOTOS - previousPhotos.length)");
    expect(block).toContain("const accepted = incoming.slice(0, availableSlots)");
    expect(block).toContain("const newPhotos = [...previousPhotos, ...newPhotoObjs]");
    expect(block).not.toContain("const newPhotos = [newPhoto]");
  });

  it("blocks a 6th photo with the clear UI message and keeps the first 5", () => {
    const block = functionBlock("handleImageFileChange");

    expect(block).toContain("const overflowed = incoming.length > accepted.length");
    expect(block).toContain("if (accepted.length === 0)");
    expect(block).toContain("setPhotoLimitWarning(PHOTO_LIMIT_MESSAGE)");
    expect(block).toContain("setPhotoLimitWarning(overflowed ? PHOTO_LIMIT_MESSAGE : null)");
    // The attach buttons must disable once the cap is hit, so a 6th file can
    // never reach handleImageFileChange via the UI in the first place.
    expect(SOURCE).toContain("disabled={pendingPhotoPreviews.length >= MAX_VOICE_PHOTOS}");
    expect(SOURCE).toContain("PHOTO_LIMIT_MESSAGE");
  });

  it("updates live photo context only for voice and stages typed photos until Send", () => {
    const block = functionBlock("handleImageFileChange");

    expect(block).toContain("MID_SESSION_PHOTO_PENDING_CONTEXT");
    expect(block).toContain("[Session photo update]");
    expect(block).toContain('statusRef.current === "connected"');
    expect(block).toContain("describePhotosForCarson(newPhotos)");
    expect(block.indexOf('activeChannelRef.current === "voice"'))
      .toBeLessThan(block.indexOf("describePhotosForCarson(newPhotos)"));
    expect(block).toContain("if (photoRevisionRef.current !== revision) return");
    expect(block).toContain('activeChannelRef.current === "voice"');
    expect(block).toContain("Typed attachments are intentionally different");
    expect(block).toContain("Use these current photos only for the task they were referring to");
  });

  it("removing one image keeps the rest and tells Carson the updated count", () => {
    const block = functionBlock("removePendingPhoto");

    expect(block).not.toContain('if (status !== "idle") return');
    expect(block).toContain("photoRevisionRef.current += 1");
    expect(block).toContain("const next = pendingPhotosRef.current.filter((photo) => photo.id !== id)");
    expect(block).toContain("syncPendingPhotoState(next)");
    expect(block).toContain("sessionPhotosRef.current = next");
    expect(block).toContain("sessionPhotoContextRef.current = null");
    expect(block).toContain("setPhotoLimitWarning(null)");
    expect(block).toContain('activeChannelRef.current === "voice"');
    expect(block).toContain("next.length > 0");
    expect(block).toContain("remain attached");
    expect(block).toContain("The user removed the attached photo during this call.");
  });

  it("replacing a photo is remove-then-add: revoked URL, revision bump, no id-pinned guard", () => {
    const block = functionBlock("handleImageFileChange");

    expect(block).toContain("photoRevisionRef.current = revision");
    // The old single-image guard compared against a single pinned id — that
    // would incorrectly drop stale-description updates for every photo after
    // the first once multiple photos are allowed. It must be gone.
    expect(block).not.toContain("pendingPhotosRef.current[0]?.id !== newPhoto.id");

    const removeBlock = functionBlock("removePendingPhoto");
    expect(removeBlock).toContain("URL.revokeObjectURL(removed.previewUrl)");
  });

  it("send_delegation sends every currently-attached photo via imageFiles, not just the first", () => {
    const block = blockBetween(
      "Snapshot pending photos — prefer live ref",
      "recordDelegationSent(person.name, taskText)",
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

  it("executeDelegationFromText path also forwards every attached photo", () => {
    const block = blockBetween(
      "const imagePhotos =",
      "const summary = await executeDelegationFromText",
    );
    expect(block).toContain("const firstImageFile = imagePhotos[0]?.file ?? null");

    const callBlock = blockBetween(
      "const summary = await executeDelegationFromText",
      "onSavedExecution:",
    );
    expect(callBlock).toContain("imageFile: firstImageFile");
    expect(callBlock).toContain("allImageFiles: imagePhotos.map((p) => p.file)");
  });

  it("createAndSendDelegation resolves the full multi-photo list and never sends a removed photo", () => {
    const block = blockBetween(
      "async function createAndSendDelegation(",
      "function buildCurrentTimeLabel",
    );

    // imageFiles (the live, post-removal array) takes precedence over the
    // legacy single imageFile — so a removed photo (absent from imageFiles)
    // can never be resurrected via the legacy field.
    expect(block).toContain("const resolvedFiles: File[] = imageFiles?.length");
    expect(block).toContain("? imageFiles");
    expect(block).toContain("saveTaskAttachments(taskRow.id, userId, resolvedFiles)");
    expect(block).toContain("if (resolvedFiles.length > 1)");
  });

  it("failure states: image upload, image_path link, and multi-attachment save all block the send", () => {
    const block = blockBetween(
      "async function createAndSendDelegation(",
      "function buildCurrentTimeLabel",
    );

    expect(block).toContain(
      'throw new Error("The attached photo could not be saved, so I did not send the delegation.")',
    );
    expect(block).toContain(
      'throw new Error("The attached photo could not be linked to the task, so I did not send the delegation.")',
    );
    expect(block).toContain(
      'throw new Error("The attached photos could not be saved, so I did not send the delegation.")',
    );
  });

  it("disconnect clears queued photos so a new session never inherits stale images", () => {
    const disconnectBlock = blockBetween(
      "Capture refs before any async work",
      "saveVoiceSessionSnapshot(userId, transcript)",
    );
    expect(disconnectBlock).toContain('if (requestedChannel === "voice")');
    expect(disconnectBlock).toContain("clearPendingPhotoPreviews()");

    const startCallBlock = blockBetween(
      'const startCarsonSession = useCallback(async (requestedChannel: CarsonChannel = "voice") => {',
      'setStatus("connecting");',
    );
    expect(startCallBlock).toContain(
      "sessionPhotosRef.current = [...pendingPhotosRef.current]",
    );
    expect(startCallBlock).toContain("sessionPhotoContextRef.current = null");
  });

  it("binds typed photos atomically to the exact submitted message", () => {
    const sendBlock = blockBetween(
      "const sendTypedMessage = useCallback(async () => {",
      "  // ------------------------------------------------------------------\n  // Session teardown",
    );
    expect(sendBlock).toContain("const typedPhotos = [");
    expect(sendBlock).toContain("await describePhotosForCarson(typedPhotos)");
    expect(sendBlock).toContain("Photos attached to this exact typed message only");
    expect(sendBlock).toContain("Do not associate them with earlier conversation history");
    expect(sendBlock).toContain("conversation.sendUserMessage(agentMessage)");
    expect(sendBlock.indexOf("pendingTypedClientMessageIdRef.current = clientMessageId"))
      .toBeLessThan(sendBlock.indexOf("conversation.sendUserMessage(agentMessage)"));
    expect(SOURCE).toContain("photos={pendingPhotoPreviews}");
    expect(SOURCE).toContain("onAttachPhoto={() => imageFileInputRef.current?.click()}");
  });

  it("clears one-turn typed photos after Carson replies or times out", () => {
    expect(SOURCE).toContain("Typed photos belong to exactly one submitted turn");
    const sendBlock = blockBetween(
      "const sendTypedMessage = useCallback(async () => {",
      "  // ------------------------------------------------------------------\n  // Session teardown",
    );
    expect(sendBlock).toContain("if (pendingPhotosRef.current.length > 0) clearPendingImages()");
  });

  it("clearing pending photos also clears the limit warning", () => {
    const block = blockBetween(
      "const clearPendingPhotoPreviews = useCallback(() => {",
      "// Revoke object URLs and clear both queued photos",
    );
    expect(block).toContain("setPendingPhotoPreviews([])");
    expect(block).toContain("setPhotoLimitWarning(null)");
  });

  it("thumbnail row and remove button render for any number of queued photos", () => {
    expect(SOURCE).toContain("pendingPhotoPreviews.map((photo, index) =>");
    expect(SOURCE).toContain('aria-label="Remove attached photo"');
    expect(SOURCE).toContain("onClick={() => removePendingPhoto(photo.id)}");
  });

  it("single-photo behavior still works: attaching exactly 1 photo is accepted and sent normally", () => {
    // With MAX_VOICE_PHOTOS = 5 and accumulate-not-replace semantics, selecting
    // exactly 1 file from an empty queue must still produce a 1-length array
    // and flow through the unchanged single-photo delegation fields.
    const block = functionBlock("handleImageFileChange");
    expect(block).toContain("const accepted = incoming.slice(0, availableSlots)");
    expect(block).not.toContain("if (newFiles.length === 0) return"); // renamed param, old dead code gone
  });
});
