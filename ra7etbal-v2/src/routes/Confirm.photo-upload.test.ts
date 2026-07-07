import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "Confirm.tsx"), "utf-8");

function functionBlock(name: string): string {
  const start = SOURCE.indexOf(`function ${name}`);
  expect(start).toBeGreaterThan(-1);
  const nextFunction = SOURCE.indexOf("\n  function ", start + 1);
  const nextConst = SOURCE.indexOf("\n  const ", start + 1);
  const candidates = [nextFunction, nextConst].filter((i) => i > start);
  const end = candidates.length ? Math.min(...candidates) : SOURCE.length;
  return SOURCE.slice(start, end);
}

// Live production bug (P0): staff could only upload 1 proof photo, and
// resubmitting a corrected proof photo after a Quality Intelligence
// rejection failed with "Upload failed (400)" — root cause confirmed against
// the Supabase Storage signed-upload-URL API: the signing call never set
// x-upsert, so a second PUT to the same deterministic path was rejected as a
// conflict. This suite locks in the client-side half of the fix (multi-photo
// UI, honest per-photo failure reporting, rejection-state reset); the
// server-side half (x-upsert, task_attachments replace) is covered in
// api/task-confirm.test.js.
describe("Confirm — proof photo upload (up to 5, remove/replace, honest failure reporting)", () => {
  it("caps proof photos at 5 and defines the block-copy message", () => {
    expect(SOURCE).toContain("const MAX_PROOF_PHOTOS = 5");
    expect(SOURCE).toContain('const PROOF_LIMIT_MESSAGE = "You can attach up to 5 photos."');
  });

  it("the file input allows selecting more than one photo", () => {
    expect(SOURCE).toMatch(/type="file"[\s\S]{0,200}multiple/);
    expect(SOURCE).toContain('aria-label="Attach proof photos"');
  });

  it("selecting photos accumulates them instead of replacing the set, and blocks overflow", () => {
    const block = functionBlock("handleFileChange");
    expect(block).toContain("const availableSlots = Math.max(0, MAX_PROOF_PHOTOS - prev.length)");
    expect(block).toContain("const accepted = incoming.slice(0, availableSlots)");
    expect(block).toContain("setProofLimitWarning(incoming.length > accepted.length ? PROOF_LIMIT_MESSAGE : null)");
    expect(block).toContain("return [...prev, ...added]");
    expect(block).not.toContain("setProofFile(file)");
  });

  it("removing one proof photo revokes its preview URL and keeps the rest", () => {
    const block = functionBlock("removeProofPhoto");
    expect(block).toContain("URL.revokeObjectURL(removed.previewUrl)");
    expect(block).toContain("prev.filter((p) => p.id !== id)");
  });

  it("attach button disables once the cap is reached", () => {
    expect(SOURCE).toContain("disabled={isBusy || proofPhotos.length >= MAX_PROOF_PHOTOS}");
  });

  it("uploads each photo to its own signed slot, matched by index", () => {
    const block = functionBlock("handleConfirm");
    expect(block).toContain("const slot = activeProofUploadSlots[i]");
    expect(block).toContain('fetch(slot.uploadUrl, {\n            method: "PUT"');
    expect(block).toContain("savedProofPaths.push(slot.storagePath)");
  });

  it("refreshes signed upload slots synchronously before a corrected-proof retry", () => {
    const helperBlock = functionBlock("refreshProofUploadSlotsForRetry");
    expect(helperBlock).toContain("fetch(`/api/task-confirm?taskId=${encodeURIComponent(taskId)}`)");
    expect(helperBlock).toContain("proofUploadSlots: data.proofUploadSlots ?? prev.proofUploadSlots");
    expect(helperBlock).toContain('setProofError(data.error || "Could not prepare fresh upload slots. Please try again.")');

    const confirmBlock = functionBlock("handleConfirm");
    expect(confirmBlock).toContain('outcome === "correction_required"');
    expect(confirmBlock).toContain("await refreshProofUploadSlotsForRetry()");
    expect(confirmBlock).toContain("const slot = activeProofUploadSlots[i]");
    expect(confirmBlock).not.toContain("const slot = info.proofUploadSlots[i]");
  });

  it("a corrected-proof slot refresh failure shows a visible error and resets loading state", () => {
    const confirmBlock = functionBlock("handleConfirm");
    expect(confirmBlock).toContain("if (!activeProofUploadSlots) {");
    expect(confirmBlock).toContain("confirmedRef.current = false;\n        setConfirming(false);\n        return;");

    const helperBlock = functionBlock("refreshProofUploadSlotsForRetry");
    expect(helperBlock).toContain("setProofError(\"Network issue while preparing the upload. Please check your connection and try again.\")");
    expect(helperBlock).toContain("return null;");
  });

  it("aborts the whole submission and reports honestly which photo failed, instead of silently sending a partial set", () => {
    const block = functionBlock("handleConfirm");
    expect(block).toContain("throw new Error(`Upload failed (${uploadRes.status})`)");
    expect(block).toContain("`Photo ${i + 1} of ${proofPhotos.length}: ${err.message}`");
    // On failure it returns immediately — never falls through to the POST confirm call.
    const failureBranchIndex = block.indexOf("confirmedRef.current = false;\n          setConfirming(false);\n          return;");
    expect(failureBranchIndex).toBeGreaterThan(-1);
  });

  it("guards against a mismatched slot count rather than uploading against undefined", () => {
    const block = functionBlock("handleConfirm");
    expect(block).toContain("if (proofPhotos.length > activeProofUploadSlots.length) {");
  });

  it("a rejected submission clears the proof set and re-fetches fresh upload slots (Supabase signed URLs are single-use)", () => {
    const block = functionBlock("handleConfirm");
    expect(block).toContain('if (resolvedOutcome !== "approved") {');
    expect(block).toContain("confirmedRef.current = false;");
    expect(block).toContain("setProofPhotos([]);");
    expect(block).toContain("setProofLimitWarning(null);");
    expect(block).toContain("d.proofUploadSlots");
  });

  it("blocks Mark done after a correction_required verdict until a new photo is attached", () => {
    expect(SOURCE).toContain('outcome === "correction_required"');
    expect(SOURCE).toContain("disabled={isBusy || needsNewProof}");
  });

  it("blocks photo delegations from being marked done until proof is attached", () => {
    expect(SOURCE).toContain("proofRequired: data.proofRequired === true");
    expect(SOURCE).toContain("info?.proofRequired === true");
    expect(SOURCE).toContain("proofPhotos.length === 0");
    expect(SOURCE).toContain('({info.proofRequired ? "required" : "optional"}, up to 5)');
    expect(SOURCE).toContain("disabled={isBusy || needsNewProof}");
  });

  it("thumbnail grid renders and can remove any of up to 5 queued photos", () => {
    expect(SOURCE).toContain("proofPhotos.map((photo, i) => (");
    expect(SOURCE).toContain("onClick={() => removeProofPhoto(photo.id)}");
  });

  it("already-approved proof photos render as a grid when there are multiple", () => {
    expect(SOURCE).toContain('info.status === "done" && info.proofImageUrls.length > 0');
    expect(SOURCE).toContain('info.proofImageUrls.length === 1 ? "" : "grid grid-cols-2 gap-2"');
  });

  it("POST body sends the plural proofImagePaths field, matching the server contract", () => {
    const block = functionBlock("handleConfirm");
    expect(block).toContain("...(savedProofPaths.length > 0 ? { proofImagePaths: savedProofPaths } : {})");
  });

  it("non-JSON task-confirm failures show an HTTP-specific error and reset loading state", () => {
    const block = functionBlock("handleConfirm");
    expect(block).toContain("const rawBody = await res.text()");
    expect(block).toContain('console.error("[confirm] /api/task-confirm returned non-JSON"');
    expect(block).toContain('`Could not confirm (HTTP ${res.status}). Please try again.`');
    expect(block).toContain("confirmedRef.current = false;");
    expect(block).toContain("setConfirming(false);");
  });
});
