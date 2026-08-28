import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "SettingsModal.tsx"), "utf-8");

function blockBetween(startNeedle: string, endNeedle: string): string {
  const start = SOURCE.indexOf(startNeedle);
  const end = SOURCE.indexOf(endNeedle, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

/**
 * Push Subscription Installation Management / Orphan Resolution — the
 * Settings "manage notification devices" surface. Source-text assertions,
 * matching this file's existing testing convention (no
 * @testing-library/react dependency in this project — see
 * SettingsModal.ios-notifications.test.ts).
 */
describe("SettingsModal — notification devices management (Orphan Resolution)", () => {
  it("imports the list/remove functions and device-info type from push-notifications", () => {
    expect(SOURCE).toContain("listPushSubscriptionDevices");
    expect(SOURCE).toContain("removePushSubscriptionDevice");
    expect(SOURCE).toContain("PushSubscriptionDeviceInfo");
  });

  it("adds a dedicated 'notification-devices' View state, distinct from delegation-rules", () => {
    expect(SOURCE).toContain(
      'type View = "list" | "confirm-clear" | "confirm-archive" | "confirm-calendar-disconnect" | "delegation-rules" | "notification-devices";',
    );
  });

  it("renders NotificationDevicesPanel for the notification-devices view, passing userId and a back handler", () => {
    const branch = blockBetween(
      'if (view === "notification-devices")',
      'return (\n    <Modal open={open} onClose={close} title="Settings" backgroundLayer={settingsAmbientLayer}>\n        <SettingsList',
    );
    expect(branch).toContain("<NotificationDevicesPanel userId={userId} onBack={() => setView(\"list\")} />");
  });

  it("wires a 'Manage notification devices' entry point from ReminderNotificationsRow, independent of this device's own enabled state", () => {
    const rowBlock = blockBetween(
      "function ReminderNotificationsRow(",
      "function getReminderStatusText(",
    );
    expect(rowBlock).toContain("onClickManageDevices: () => void;");
    expect(rowBlock).toContain("Manage notification devices");
    // Must not be gated behind isEnabled — other installations can exist
    // regardless of this device's own toggle state. The button's own
    // immediate wrapping condition is "{userId && (", not "isEnabled".
    const wrappingConditionIndex = rowBlock.indexOf("{userId && (");
    expect(wrappingConditionIndex).toBeGreaterThan(-1);
    const blockAfterCondition = rowBlock.slice(wrappingConditionIndex, wrappingConditionIndex + 400);
    expect(blockAfterCondition).toContain("Manage notification devices");
    expect(blockAfterCondition).not.toContain("isEnabled");
  });

  it("threads onClickManageDevices from SettingsModal through SettingsList to ReminderNotificationsRow", () => {
    expect(SOURCE).toContain('onClickManageDevices={() => setView("notification-devices")}');
    expect(SOURCE).toContain("onClickManageDevices: () => void;");
    expect(SOURCE).toContain(
      "<ReminderNotificationsRow userId={userId} onClickManageDevices={onClickManageDevices} />",
    );
  });

  it("NotificationDevicesPanel never auto-classifies a device as dead — no age/inactivity comparison, only an explicit remove action", () => {
    const panelBlock = blockBetween(
      "function NotificationDevicesPanel(",
      "function formatDeviceDate(",
    );
    // No Date.now()/age-based comparison anywhere in the panel.
    expect(panelBlock).not.toContain("Date.now()");
    expect(panelBlock).not.toContain("daysSince");
    // The copy must not claim absence of delivery evidence means the device
    // is dead/broken.
    expect(panelBlock).toContain("No confirmed delivery yet");
    expect(panelBlock).toContain("doesn't mean a device is broken");
  });

  it("NotificationDevicesPanel's remove action calls removePushSubscriptionDevice and requires userId", () => {
    const panelBlock = blockBetween(
      "function NotificationDevicesPanel(",
      "function formatDeviceDate(",
    );
    expect(panelBlock).toContain("async function handleRemove(deviceId: string)");
    expect(panelBlock).toContain("await removePushSubscriptionDevice(userId, deviceId)");
    expect(panelBlock).toContain("if (!userId || removingId) return;");
  });

  it("NotificationDevicesPanel loads via listPushSubscriptionDevices scoped to the signed-in owner", () => {
    const panelBlock = blockBetween(
      "function NotificationDevicesPanel(",
      "function formatDeviceDate(",
    );
    expect(panelBlock).toContain("const list = await listPushSubscriptionDevices(userId)");
  });

  it("never renders the raw push endpoint — only platform, user agent, and dates", () => {
    const panelBlock = blockBetween(
      "function NotificationDevicesPanel(",
      "function formatDeviceDate(",
    );
    expect(panelBlock).not.toContain(".endpoint");
    expect(panelBlock).not.toContain("push.apple.com");
  });

  it("does not modify the existing Disable notifications link or the RPC-based save path", () => {
    expect(SOURCE).toContain("Disable notifications");
    expect(SOURCE).toContain('onClick={() => void handleDisable()}');
  });

  it("uses the read-only getStoredInstallationId, never the mint-on-read getOrCreateInstallationId, to determine the current device", () => {
    const panelBlock = blockBetween(
      "function NotificationDevicesPanel(",
      "function formatDeviceDate(",
    );
    expect(panelBlock).toContain("getStoredInstallationId()");
    // getOrCreateInstallationId is the internal, unexported save-path
    // helper that mints and persists a fresh id when none exists — it must
    // never be reachable from a read-only "which device is this" panel,
    // since opening Settings must not have the side effect of creating a
    // new installation identity.
    expect(panelBlock).not.toContain("getOrCreateInstallationId");
  });

  it("renders the 'This device' badge only via isCurrentDeviceRow, not an inline platform/user-agent heuristic", () => {
    const panelBlock = blockBetween(
      "function NotificationDevicesPanel(",
      "function formatDeviceDate(",
    );
    expect(panelBlock).toContain("isCurrentDeviceRow(device, currentInstallationId)");
    expect(panelBlock).toContain("This device");
    // Must not infer device identity from platform/user-agent text alone.
    expect(panelBlock).not.toMatch(/device\.platform\s*===/);
    expect(panelBlock).not.toMatch(/device\.userAgent\s*===/);
  });

  it("imports getStoredInstallationId and isCurrentDeviceRow from push-notifications", () => {
    expect(SOURCE).toContain("getStoredInstallationId");
    expect(SOURCE).toContain("isCurrentDeviceRow");
  });
});
