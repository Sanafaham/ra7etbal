import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "TaskCard.tsx"), "utf-8");

function headerLifecycleBlock(): string {
  return SOURCE.slice(
    SOURCE.indexOf('<div className="flex items-center gap-2 text-xs text-ink/55">'),
    SOURCE.indexOf("{reminderDue?.overdue", SOURCE.indexOf('<div className="flex items-center gap-2 text-xs text-ink/55">')),
  );
}

function manualOptionsBlock(): string {
  return SOURCE.slice(
    SOURCE.indexOf("{isWaitingDelegation && ("),
    SOURCE.indexOf("</article>", SOURCE.indexOf("{isWaitingDelegation && (")),
  );
}

describe("TaskCard — Quality Intelligence owner surface", () => {
  it("uses the shared lifecycle resolver as the badge source of truth", () => {
    expect(SOURCE).toContain('import { resolveQualityLifecycle } from "../../lib/quality-lifecycle"');
    expect(SOURCE).toContain("const qualityLifecycle = resolveQualityLifecycle(task)");
    expect(SOURCE).not.toContain("const hasSubmittedProof = Boolean(task.proof_image_path)");
    expect(SOURCE).not.toContain("const isFlaggedProofForOwnerReview");
    expect(SOURCE).not.toContain("const isProofSubmittedForOwnerReview");
  });

  it("does not show correction-required proof or correction detail on owner active cards", () => {
    expect(SOURCE).toContain('task.quality_review_status === "correction_required"');
    expect(SOURCE).toContain('task.quality_review_status === "fraud_suspected"');
    expect(SOURCE).toContain("const showProofImage = Boolean(signedProofImageUrl && !isOperationalProofCorrection)");
    expect(SOURCE).not.toContain('task.quality_review_status === "correction_required" && (');
    expect(SOURCE).not.toContain("Correction requested");
  });

  it("keeps only true owner-review uncertainty visible on owner cards", () => {
    expect(SOURCE).toContain('task.quality_review_status === "uncertain"');
    expect(SOURCE).toContain("Carson is unsure");
    expect(SOURCE).not.toContain("Possible issue with this proof photo");
  });

  it("renders exactly one lifecycle badge branch before non-lifecycle badges", () => {
    const block = headerLifecycleBlock();
    expect(block).toContain('qualityLifecycle.badge === "Needs your review"');
    expect(block).toContain('qualityLifecycle.badge === "Proof submitted"');
    expect(block).toContain('qualityLifecycle.badge === "Waiting for confirmation"');
    expect(block).toContain('qualityLifecycle.badge === "Completed"');
    expect(block.indexOf('qualityLifecycle.badge === "Needs your review"')).toBeLessThan(
      block.indexOf('qualityLifecycle.badge === "Proof submitted"'),
    );
    expect(block.indexOf('qualityLifecycle.badge === "Proof submitted"')).toBeLessThan(
      block.indexOf('qualityLifecycle.badge === "Waiting for confirmation"'),
    );
    expect(block.indexOf('qualityLifecycle.badge === "Waiting for confirmation"')).toBeLessThan(
      block.indexOf('qualityLifecycle.badge === "Completed"'),
    );
  });

  it("proof-submitted branch appears before waiting-for-confirmation branch", () => {
    const block = headerLifecycleBlock();
    expect(block.indexOf("Proof submitted")).toBeLessThan(
      block.indexOf("Waiting for confirmation"),
    );
  });

  it("completed QI proof does not also render the normal delegation done badge", () => {
    const block = headerLifecycleBlock();
    expect(block).toContain('qualityLifecycle.badge === "Completed"');
    expect(block).toContain(": isDone && task.type === \"delegation\" &&");
  });

  it("uses a controlled Manual options disclosure for waiting delegations", () => {
    const block = manualOptionsBlock();
    expect(SOURCE).toContain("const [manualOptionsOpen, setManualOptionsOpen] = useState(false)");
    expect(block).toContain('type="button"');
    expect(block).toContain("aria-expanded={manualOptionsOpen}");
    expect(block).toContain("onClick={() => setManualOptionsOpen((open) => !open)}");
    expect(block).toContain("Manual options");
    expect(block).toContain("{manualOptionsOpen &&");
    expect(block).toContain("Mark done manually");
    expect(block).not.toContain("<details");
    expect(block).not.toContain("<summary");
  });
});
