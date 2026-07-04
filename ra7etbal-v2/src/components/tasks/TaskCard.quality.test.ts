import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "TaskCard.tsx"), "utf-8");

describe("TaskCard — Quality Intelligence owner surface", () => {
  it("does not show correction-required proof or status on owner active cards", () => {
    expect(SOURCE).toContain('const isCorrectionRequired = task.quality_review_status === "correction_required"');
    expect(SOURCE).toContain("const showProofImage = Boolean(signedProofImageUrl && !isCorrectionRequired)");
    expect(SOURCE).not.toContain('task.quality_review_status === "correction_required" && (');
    expect(SOURCE).not.toContain("Correction requested");
  });

  it("keeps owner-review states visible for uncertain and fraud-suspected proof", () => {
    expect(SOURCE).toContain('task.quality_review_status === "uncertain"');
    expect(SOURCE).toContain('task.quality_review_status === "fraud_suspected"');
    expect(SOURCE).toContain("Carson is unsure");
    expect(SOURCE).toContain("Possible issue with this proof photo");
  });
});
