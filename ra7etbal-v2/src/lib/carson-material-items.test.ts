import { describe, expect, it, vi } from "vitest";

// carson-material-items.ts -> morning-brief.ts -> automation-context.ts imports
// ./supabase at module top level, which throws without VITE_SUPABASE_* env vars.
// Stub it the same way automation-context.test.ts does — only pure functions
// are exercised here, no real Supabase client is ever used.
vi.mock("./supabase", () => ({ supabase: {} }));

const {
  diffMaterialItems,
  resolveOpeningMaterialState,
  deriveMorningBriefMaterialItems,
  deriveNightSweepMaterialItems,
  resolveBriefAnchorDateStr,
} = await import("./carson-material-items");

import type { MaterialItem, KeyValueStore } from "./carson-material-items";
import type { AutomationDigest, AutomationScheduleSummary } from "./automation-context";
import type { Task } from "../types/task";

const NOW = new Date("2026-08-17T14:41:00.000Z");

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    user_id: "user-1",
    description: "Buy milk",
    type: "action",
    assigned_to: null,
    status: "pending",
    needs_follow_up: false,
    confirmation_url: null,
    confirmed_at: null,
    due_at: null,
    archived_at: null,
    created_at: "2026-08-17T10:00:00.000Z",
    qstash_message_id: null,
    followup_sent_at: null,
    escalated_at: null,
    image_path: null,
    proof_image_path: null,
    quality_review_status: null,
    quality_review_note: null,
    quality_reviewed_at: null,
    worker_reply: null,
    ...overrides,
  };
}

function emptyDigest(overrides: Partial<AutomationDigest> = {}): AutomationDigest {
  return { pending: [], escalated: [], failed: [], confirmedToday: [], firingToday: [], firingTomorrow: [], routineAutomationTaskIds: new Set(), ...overrides };
}

function makeFiringToday(overrides: Partial<AutomationScheduleSummary> = {}): AutomationScheduleSummary {
  return { id: "auto-1", title: "Daily reminder test", assignee: null, nextRunAt: "2026-08-17T15:00:00.000Z", ...overrides };
}

class FakeStorage implements KeyValueStore {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe("diffMaterialItems", () => {
  it("flags a brand-new item (no prior signature) as changed", () => {
    const current: MaterialItem[] = [{ id: "a", signature: "s1", text: "A." }];
    const { changed } = diffMaterialItems(current, {});
    expect(changed.map((c) => c.id)).toEqual(["a"]);
  });

  it("does not flag an item whose signature is unchanged", () => {
    const current: MaterialItem[] = [{ id: "a", signature: "s1", text: "A." }];
    const { changed } = diffMaterialItems(current, { a: "s1" });
    expect(changed).toEqual([]);
  });

  it("flags an existing item whose signature changed (e.g. escalated)", () => {
    const current: MaterialItem[] = [{ id: "a", signature: "waiting:escalated", text: "A." }];
    const { changed } = diffMaterialItems(current, { a: "waiting:open" });
    expect(changed.map((c) => c.id)).toEqual(["a"]);
  });

  it("an item disappearing does not cause a remaining unchanged item to be flagged", () => {
    // "b" was present before and is gone now; "a" is unchanged.
    const current: MaterialItem[] = [{ id: "a", signature: "s1", text: "A." }];
    const { changed, nextMap } = diffMaterialItems(current, { a: "s1", b: "s2" });
    expect(changed).toEqual([]);
    expect(nextMap).toEqual({ a: "s1" }); // b dropped, not carried forward
  });
});

describe("deriveMorningBriefMaterialItems — PR #24 recurring-reminder inclusion", () => {
  it("includes an active, unassigned, non-message automation firing within 24h", () => {
    const digest = emptyDigest({ firingToday: [makeFiringToday()] });
    const items = deriveMorningBriefMaterialItems([], [], digest, [], NOW);
    const reminder = items.find((i) => i.id === "automation:auto-1");
    expect(reminder).toBeDefined();
    expect(reminder!.text).toContain("Daily reminder test");
  });

  it("excludes an assigned (staff) firingToday automation — not an owner reminder", () => {
    const digest = emptyDigest({ firingToday: [makeFiringToday({ assignee: "Christopher" })] });
    const items = deriveMorningBriefMaterialItems([], [], digest, [], NOW);
    expect(items.find((i) => i.id === "automation:auto-1")).toBeUndefined();
  });
});

describe("opening waiting-state presentation", () => {
  it("reports the real outstanding recipient without reciting the stored staff instruction", () => {
    const hostingTask = makeTask({
      assigned_to: "Christopher",
      type: "delegation",
      needs_follow_up: true,
      escalated_at: "2026-08-17T13:00:00.000Z",
      description:
        "Christopher, we have 6 guests for dinner tomorrow at 8:00 PM. Please plan and prepare a full dinner menu with NO shellfish.",
    });

    const morning = deriveMorningBriefMaterialItems([hostingTask], [], emptyDigest(), [], NOW);
    const night = deriveNightSweepMaterialItems([hostingTask], emptyDigest(), [], NOW);

    expect(morning.find((item) => item.id === hostingTask.id)?.text).toBe(
      "Christopher still hasn't confirmed.",
    );
    expect(night.find((item) => item.id === hostingTask.id)?.text).toBe(
      "Christopher still hasn't confirmed.",
    );
    expect(JSON.stringify([...morning, ...night])).not.toContain("6 guests");
    expect(JSON.stringify([...morning, ...night])).not.toContain("NO shellfish");
  });
});

describe("resolveOpeningMaterialState", () => {
  const storage = () => new FakeStorage();
  const todayStr = "2026-08-17";

  it("first Morning Brief of the day: isFirstSessionToday=true, no changed items surfaced separately", () => {
    const s = storage();
    const items: MaterialItem[] = [{ id: "t1", signature: "sig1", text: "One thing." }];
    const result = resolveOpeningMaterialState("morning", todayStr, items, s);
    expect(result.isFirstSessionToday).toBe(true);
    expect(result.changed).toEqual([]); // full brief already covers it
  });

  it("later same-day session, nothing materially new: changed is empty", () => {
    const s = storage();
    const items: MaterialItem[] = [{ id: "t1", signature: "sig1", text: "One thing." }];
    resolveOpeningMaterialState("morning", todayStr, items, s); // session 1 (first)
    const result = resolveOpeningMaterialState("morning", todayStr, items, s); // session 2, unchanged
    expect(result.isFirstSessionToday).toBe(false);
    expect(result.changed).toEqual([]);
  });

  it("later same-day session, a newly material item appears: it is surfaced", () => {
    const s = storage();
    const first: MaterialItem[] = [{ id: "t1", signature: "sig1", text: "One thing." }];
    resolveOpeningMaterialState("morning", todayStr, first, s);
    const second: MaterialItem[] = [
      ...first,
      { id: "automation:auto-1", signature: "firing:15:00", text: "You have a reminder scheduled — Daily reminder test." },
    ];
    const result = resolveOpeningMaterialState("morning", todayStr, second, s);
    expect(result.changed.map((c) => c.id)).toEqual(["automation:auto-1"]);
  });

  it("later same-day session, an existing item's state changed: it is surfaced", () => {
    const s = storage();
    const first: MaterialItem[] = [{ id: "t1", signature: "waiting:open", text: "Waiting on Christopher." }];
    resolveOpeningMaterialState("morning", todayStr, first, s);
    const second: MaterialItem[] = [{ id: "t1", signature: "waiting:escalated", text: "Christopher still hasn't confirmed." }];
    const result = resolveOpeningMaterialState("morning", todayStr, second, s);
    expect(result.changed.map((c) => c.id)).toEqual(["t1"]);
  });

  it("an old item disappearing does not resurface remaining unchanged items", () => {
    const s = storage();
    const first: MaterialItem[] = [
      { id: "t1", signature: "sig1", text: "Item one." },
      { id: "t2", signature: "sig2", text: "Item two." },
    ];
    resolveOpeningMaterialState("morning", todayStr, first, s);
    const second: MaterialItem[] = [{ id: "t1", signature: "sig1", text: "Item one." }]; // t2 gone, t1 unchanged
    const result = resolveOpeningMaterialState("morning", todayStr, second, s);
    expect(result.changed).toEqual([]);
  });

  it("Morning Brief and Night Sweep use separate delivery state — a Morning session does not consume Night Sweep's first-session flag", () => {
    const s = storage();
    resolveOpeningMaterialState("morning", todayStr, [], s); // morning session happens first
    const nightResult = resolveOpeningMaterialState("night", todayStr, [], s); // first Night Sweep of the day
    expect(nightResult.isFirstSessionToday).toBe(true);
  });

  it("repeated same-day Night Sweep with nothing new: short greeting only (no repeat)", () => {
    const s = storage();
    const items: MaterialItem[] = [{ id: "t1", signature: "sig1", text: "Waiting item." }];
    resolveOpeningMaterialState("night", todayStr, items, s); // first Night Sweep
    const second = resolveOpeningMaterialState("night", todayStr, items, s); // later Night Sweep, unchanged
    expect(second.isFirstSessionToday).toBe(false);
    expect(second.changed).toEqual([]);
  });

  it("new material after the first Night Sweep is surfaced on a later Night Sweep session", () => {
    const s = storage();
    resolveOpeningMaterialState("night", todayStr, [], s); // first Night Sweep, nothing yet
    const second = resolveOpeningMaterialState(
      "night",
      todayStr,
      [{ id: "automation:auto-2", signature: "run:failed", text: "The nightly sync automation failed to send." }],
      s,
    );
    expect(second.isFirstSessionToday).toBe(false);
    expect(second.changed.map((c) => c.id)).toEqual(["automation:auto-2"]);
  });
});

describe("resolveBriefAnchorDateStr", () => {
  // Production incident (2026-08-18): a session at 01:01 local was
  // classified as the day's first Morning Brief, discarding all
  // dedup state from the Night Sweep session a couple hours earlier.
  it("morning kind always anchors to the current calendar date, regardless of hour", () => {
    expect(resolveBriefAnchorDateStr("morning", new Date("2026-08-18T01:01:00"))).toBe("2026-08-18");
    expect(resolveBriefAnchorDateStr("morning", new Date("2026-08-18T14:00:00"))).toBe("2026-08-18");
  });

  it("night kind at or after MORNING_START_HOUR anchors to the current calendar date", () => {
    expect(resolveBriefAnchorDateStr("night", new Date("2026-08-17T21:00:00"))).toBe("2026-08-17");
  });

  it("night kind before MORNING_START_HOUR anchors to the PREVIOUS calendar date — same 'night' as the evening before", () => {
    expect(resolveBriefAnchorDateStr("night", new Date("2026-08-18T01:01:00"))).toBe("2026-08-17");
    expect(resolveBriefAnchorDateStr("night", new Date("2026-08-18T05:59:00"))).toBe("2026-08-17");
  });

  it("night kind exactly at MORNING_START_HOUR anchors to the current calendar date (boundary is inclusive of morning)", () => {
    expect(resolveBriefAnchorDateStr("night", new Date("2026-08-18T06:00:00"))).toBe("2026-08-18");
  });

  it("a Night Sweep session at 11 PM followed by a continuation session at 1 AM share the same anchor date, so the 1 AM session is correctly a follow-up, not a fresh first session", () => {
    const s = new FakeStorage();
    const elevenPmAnchor = resolveBriefAnchorDateStr("night", new Date("2026-08-17T23:00:00"));
    const items: MaterialItem[] = [{ id: "t1", signature: "waiting:open", text: "Waiting item." }];
    const first = resolveOpeningMaterialState("night", elevenPmAnchor, items, s);
    expect(first.isFirstSessionToday).toBe(true);

    const oneAmAnchor = resolveBriefAnchorDateStr("night", new Date("2026-08-18T01:01:00"));
    const second = resolveOpeningMaterialState("night", oneAmAnchor, items, s);
    expect(second.isFirstSessionToday).toBe(false);
    expect(second.changed).toEqual([]); // unchanged item is not replayed
  });
});

// Chief-of-Staff contract (2026-08-18): routine pending automation runs must
// not leak into follow-up sessions as "new/changed material" even though the
// main brief text no longer speaks about them — both paths share the same
// underlying digest, so both must exclude routine "unconfirmed" state.
describe("deriveMorningBriefMaterialItems / deriveNightSweepMaterialItems — routine automation exclusion", () => {
  it("a routine pending automation run does not become material (Morning)", () => {
    const digest = emptyDigest({
      pending: [{ id: "auto-1", automationTitle: "Daily reminder test", assignee: null, sentAgoMs: 0, isFollowupSent: false }],
    });
    const items = deriveMorningBriefMaterialItems([], [], digest, [], NOW);
    expect(items.find((i) => i.id === "automation:auto-1")).toBeUndefined();
  });

  it("a routine pending automation run does not become material (Night)", () => {
    const digest = emptyDigest({
      pending: [{ id: "auto-1", automationTitle: "Daily reminder test", assignee: null, sentAgoMs: 0, isFollowupSent: false }],
    });
    const items = deriveNightSweepMaterialItems([], digest, [], NOW);
    expect(items.find((i) => i.id === "automation:auto-1")).toBeUndefined();
  });

  it("an escalated automation run still becomes material", () => {
    const digest = emptyDigest({
      escalated: [{ id: "auto-1", automationTitle: "Daily reminder test", assignee: null, sentAgoMs: 0, isFollowupSent: false }],
    });
    const items = deriveMorningBriefMaterialItems([], [], digest, [], NOW);
    expect(items.find((i) => i.id === "automation:auto-1")).toBeDefined();
  });
});

describe("deriveMorningBriefMaterialItems / deriveNightSweepMaterialItems — Needs You", () => {
  const escalation = {
    id: "esc-1",
    staffName: "Christopher",
    inboundText: "done?",
    escalationReason: null,
    receivedAt: NOW.toISOString(),
    taskId: null,
    decisionId: "dec-1",
    deepLinkToken: "tok",
  };

  it("a genuine owner decision becomes a material item (Morning)", () => {
    const items = deriveMorningBriefMaterialItems([], [], undefined, [], NOW, [escalation]);
    const item = items.find((i) => i.id === "needs_you:dec-1");
    expect(item).toBeDefined();
    expect(item!.text).toContain("Christopher is waiting on an answer");
  });

  it("a genuine owner decision becomes a material item (Night)", () => {
    const items = deriveNightSweepMaterialItems([], undefined, [], NOW, [escalation]);
    expect(items.find((i) => i.id === "needs_you:dec-1")).toBeDefined();
  });

  it("an unchanged Needs You item is suppressed on a follow-up session", () => {
    const s = new FakeStorage();
    const items = deriveMorningBriefMaterialItems([], [], undefined, [], NOW, [escalation]);
    const first = resolveOpeningMaterialState("morning", "2026-08-17", items, s);
    expect(first.isFirstSessionToday).toBe(true);

    const second = resolveOpeningMaterialState("morning", "2026-08-17", items, s);
    expect(second.isFirstSessionToday).toBe(false);
    expect(second.changed).toEqual([]);
  });
});

// Production incident (2026-08-18, live acceptance round 2): the automation
// relevance contract was correctly enforced in the first-session spoken
// brief, but the SAME routine automation-linked task bypassed suppression
// through the follow-up material-item path — Carson still said "One task
// needs your attention — ..." on a non-first session because
// deriveMorningBriefMaterialItems iterates brief.needsAttention, and
// buildMorningBrief's own gate is the single, canonical place this is now
// fixed (see morning-brief.test.ts's parallel coverage for the underlying
// gate itself). This proves the fix reaches this path too, not just the
// first-session brief.
describe("deriveMorningBriefMaterialItems — automation-linked task inherits automation relevance (E)", () => {
  it("a task linked to a routine automation run does not become a material item, so it cannot resurface via the follow-up 'changed' path either", () => {
    const task = makeTask({ id: "task-linked-1", type: "action", description: "Update the Rahet Bal master plan." });
    const digest = emptyDigest({ routineAutomationTaskIds: new Set(["task-linked-1"]) });
    const items = deriveMorningBriefMaterialItems([task], [], digest, [], NOW);
    expect(items.find((i) => i.id === "task-linked-1")).toBeUndefined();
  });

  it("an ordinary, non-automation-linked task still becomes a material item as before", () => {
    const task = makeTask({ id: "task-ordinary-1", type: "action", description: "Book the vet appointment." });
    const digest = emptyDigest({ routineAutomationTaskIds: new Set() });
    const items = deriveMorningBriefMaterialItems([task], [], digest, [], NOW);
    expect(items.find((i) => i.id === "task-ordinary-1")).toBeDefined();
  });
});
