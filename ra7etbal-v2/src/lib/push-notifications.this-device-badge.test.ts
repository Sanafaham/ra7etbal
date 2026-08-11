import { describe, expect, it, vi } from "vitest";

// isCurrentDeviceRow is pure and never touches Supabase, but this module's
// top-level `import { supabase } from "./supabase"` still executes on
// import — mocked here purely so that import doesn't throw for missing env
// vars, matching every other push-notifications test file's convention.
vi.mock("./supabase", () => ({ supabase: {} }));

import { isCurrentDeviceRow, type PushSubscriptionDeviceInfo } from "./push-notifications";

/**
 * Push Subscription Installation Management / Orphan Resolution follow-up —
 * "This device" badge. isCurrentDeviceRow is a pure predicate (no DOM, no
 * Supabase), so it's tested directly rather than through SettingsModal.tsx's
 * source text — matching this codebase's established pattern of extracting
 * pure, hook-free logic to unit-test around the lack of a
 * @testing-library/react dependency in this project.
 */

function device(overrides: Partial<PushSubscriptionDeviceInfo> = {}): PushSubscriptionDeviceInfo {
  return {
    id: "row-1",
    platform: "iPhone",
    userAgent: "Mozilla/5.0",
    installationId: null,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    lastConfirmedDeliveredAt: null,
    ...overrides,
  };
}

describe("isCurrentDeviceRow — 'This device' badge matching", () => {
  it("returns true when the row's installationId exactly matches the current browser's stored id", () => {
    const currentId = "15967456-64f4-4bec-b86f-3990b96a617c";
    expect(isCurrentDeviceRow(device({ installationId: currentId }), currentId)).toBe(true);
  });

  it("returns false when the row's installationId does not match the current browser's stored id", () => {
    const currentId = "15967456-64f4-4bec-b86f-3990b96a617c";
    const otherId = "6c559300-0000-0000-0000-000000000000";
    expect(isCurrentDeviceRow(device({ installationId: otherId }), currentId)).toBe(false);
  });

  it("returns false for a row whose installationId is null, even when the current browser has a real stored id", () => {
    const currentId = "15967456-64f4-4bec-b86f-3990b96a617c";
    expect(isCurrentDeviceRow(device({ installationId: null }), currentId)).toBe(false);
  });

  it("returns false when the current browser has no stored installation id, regardless of the row's own value", () => {
    expect(isCurrentDeviceRow(device({ installationId: "some-id" }), null)).toBe(false);
  });

  it("never matches a null row against a null current id — two rows both lacking an id are not evidence they're the same device", () => {
    expect(isCurrentDeviceRow(device({ installationId: null }), null)).toBe(false);
  });

  it("across several same-platform rows, marks exactly the one whose installationId matches — never zero, never more than one", () => {
    const currentId = "8fcce355-0000-0000-0000-000000000000";
    const devices: PushSubscriptionDeviceInfo[] = [
      device({ id: "mac-1", platform: "MacIntel", installationId: null }),
      device({ id: "mac-2", platform: "MacIntel", installationId: "ffa31fe8-0000-0000-0000-000000000000" }),
      device({ id: "iphone-current", platform: "iPhone", installationId: currentId }),
      device({ id: "mac-3", platform: "MacIntel", installationId: "6c559300-0000-0000-0000-000000000000" }),
    ];

    const matches = devices.filter((d) => isCurrentDeviceRow(d, currentId));
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe("iphone-current");
  });

  it("marks no row when none of the listed devices match the current installation id (e.g. the current device predates the migration)", () => {
    const currentId = null; // this device's subscription predates installation_id and localStorage has never stored one
    const devices: PushSubscriptionDeviceInfo[] = [
      device({ id: "legacy-1", platform: "iPhone", installationId: null }),
      device({ id: "legacy-2", platform: "MacIntel", installationId: null }),
    ];

    const matches = devices.filter((d) => isCurrentDeviceRow(d, currentId));
    expect(matches).toHaveLength(0);
  });
});
