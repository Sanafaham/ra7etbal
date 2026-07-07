import { describe, expect, it } from "vitest";
import { getNeedsAttentionItems } from "./attention";
import type { Task } from "../types/task";

function delegation(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    user_id: "user-1",
    description: "plate the chicken",
    type: "delegation",
    assigned_to: "Christopher",
    status: "pending",
    needs_follow_up: true,
    confirmation_url: "https://ra7etbal.com/confirm?task=task-1",
    confirmed_at: null,
    due_at: null,
    archived_at: null,
    created_at: "2026-07-08T10:00:00.000Z",
    qstash_message_id: null,
    followup_sent_at: null,
    escalated_at: null,
    image_path: "task-images/user-1/task-1/photo.jpg",
    proof_image_path: null,
    quality_review_status: null,
    quality_review_note: null,
    quality_reviewed_at: null,
    ...overrides,
  };
}

describe("Home attention — Quality Intelligence lifecycle labels", () => {
  it("normal pending delegation still shows Waiting for confirmation", () => {
    const [item] = getNeedsAttentionItems([delegation()]);

    expect(item.label).toBe("Waiting for confirmation");
    expect(item.state).toBe("waiting_confirmation");
  });

  it("normal proof submitted does not show Waiting for confirmation", () => {
    const [item] = getNeedsAttentionItems([
      delegation({ proof_image_path: "task-images/u/t/proof/0.jpg" }),
    ]);

    expect(item.label).toBe("Proof submitted");
    expect(item.state).toBe("proof_submitted");
  });

  it("flagged proof shows Needs your review", () => {
    const [item] = getNeedsAttentionItems([
      delegation({
        proof_image_path: "task-images/u/t/proof/0.jpg",
        quality_review_status: "correction_required",
      }),
    ]);

    expect(item.label).toBe("Needs your review");
    expect(item.state).toBe("needs_owner_review");
  });
});
