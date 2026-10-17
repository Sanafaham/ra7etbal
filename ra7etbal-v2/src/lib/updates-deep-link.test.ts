import { describe, expect, it } from "vitest";
import { resolveTaskDeepLinkTab } from "./updates-deep-link";

const sections = (needsYou: string[], waiting: string[]) => ({
  needsYouIds: new Set(needsYou),
  waitingIds: new Set(waiting),
});

describe("resolveTaskDeepLinkTab", () => {
  it("moves an escalation link aimed at Needs You to Waiting when the task is waiting", () => {
    expect(resolveTaskDeepLinkTab("needs-you", "salmon", sections([], ["salmon"]))).toBe("waiting");
  });

  it("keeps the requested tab when the task is already there", () => {
    expect(resolveTaskDeepLinkTab("needs-you", "t1", sections(["t1"], []))).toBeNull();
    expect(resolveTaskDeepLinkTab("waiting", "t1", sections([], ["t1"]))).toBeNull();
  });

  it("moves a Waiting link to Needs You once the task genuinely needs the owner", () => {
    expect(resolveTaskDeepLinkTab("waiting", "t1", sections(["t1"], []))).toBe("needs-you");
  });

  it("does nothing for unknown tasks, missing ids, or other tabs", () => {
    expect(resolveTaskDeepLinkTab("needs-you", "gone", sections([], []))).toBeNull();
    expect(resolveTaskDeepLinkTab("needs-you", null, sections([], ["t1"]))).toBeNull();
    expect(resolveTaskDeepLinkTab("history", "t1", sections([], ["t1"]))).toBeNull();
  });
});
