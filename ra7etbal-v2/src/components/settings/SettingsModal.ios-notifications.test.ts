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
 * iOS Safari (and any other iOS browser — all iOS browsers use WebKit) only
 * exposes the Push API to an installed, standalone app. A regular browser
 * tab can never enable notifications, so the previous plain disabled toggle
 * looked broken with no explanation. This replaces it with install guidance
 * for that one case only — every other status (enabled, denied, idle,
 * error, non-iOS unsupported) keeps the original toggle row unchanged.
 */
describe("SettingsModal — iOS install guidance for unsupported push (UX only)", () => {
  it("imports needsIOSInstallGuidance from the standalone-detection module", () => {
    expect(SOURCE).toContain('import { needsIOSInstallGuidance } from "../../lib/pwa-standalone";');
  });

  it("only shows install guidance when unsupported AND iOS needs it — not for any other unsupported reason", () => {
    const rowBlock = blockBetween(
      "function ReminderNotificationsRow(",
      "function getReminderStatusText(",
    );
    expect(rowBlock).toContain(
      "const showIOSInstallPrompt = isUnsupported && needsIOSInstallGuidance();",
    );
  });

  it("renders the install-guidance card instead of the toggle row when showIOSInstallPrompt is true, and the original row otherwise", () => {
    const rowBlock = blockBetween(
      "function ReminderNotificationsRow(",
      "function getReminderStatusText(",
    );
    const ternaryIndex = rowBlock.indexOf("{showIOSInstallPrompt ? (");
    const cardIndex = rowBlock.indexOf("Install Ra7etBal to enable notifications on your iPhone or iPad.");
    const originalButtonIndex = rowBlock.indexOf(
      "onClick={() => void (isEnabled ? handleRefresh() : handleEnable())}",
    );
    expect(ternaryIndex).toBeGreaterThan(-1);
    expect(cardIndex).toBeGreaterThan(ternaryIndex);
    expect(originalButtonIndex).toBeGreaterThan(cardIndex);
  });

  it("frames the card and its action around installation, not around the word 'notifications'", () => {
    const rowBlock = blockBetween(
      "function ReminderNotificationsRow(",
      "function getReminderStatusText(",
    );
    expect(rowBlock).toContain("How to install Ra7etBal");
    expect(rowBlock).not.toContain("How to enable notifications");
  });

  it("the card branch never renders the generic statusText ('Not supported on this device') — it has its own dedicated copy, structurally, not just by wording choice", () => {
    const rowBlock = blockBetween(
      "function ReminderNotificationsRow(",
      "function getReminderStatusText(",
    );
    const cardBranch = rowBlock.slice(
      rowBlock.indexOf("{showIOSInstallPrompt ? ("),
      rowBlock.indexOf(") : ("),
    );
    expect(cardBranch).not.toContain("statusText");
    expect(cardBranch).not.toContain("Not supported on this device");
  });

  it("does not touch the existing 'denied' hint, the disable link, or the disabledMain/statusText logic", () => {
    const rowBlock = blockBetween(
      "function ReminderNotificationsRow(",
      "function getReminderStatusText(",
    );
    expect(rowBlock).toContain(
      "Open iOS Settings → Safari (or Ra7etBal app) → Notifications, then enable and return here to subscribe.",
    );
    expect(rowBlock).toContain("const disabledMain = busy || isUnsupported || !userId;");
    expect(rowBlock).toContain("const statusText = getReminderStatusText(status, busy, busyKind);");
  });

  it("opens a Modal with the exact 4-step Add to Home Screen instructions, triggered by a dedicated button", () => {
    const rowBlock = blockBetween(
      "function ReminderNotificationsRow(",
      "function getReminderStatusText(",
    );
    const buttonIndex = rowBlock.indexOf("How to install Ra7etBal");
    const modalIndex = rowBlock.indexOf("<Modal", buttonIndex);
    expect(buttonIndex).toBeGreaterThan(-1);
    expect(modalIndex).toBeGreaterThan(buttonIndex);

    const modalBlock = rowBlock.slice(modalIndex);
    expect(modalBlock).toContain('title="Install Ra7etBal on iPhone or iPad"');
    expect(modalBlock).toContain("Tap the Share button in Safari.");
    expect(modalBlock).toContain('Choose "Add to Home Screen."');
    expect(modalBlock).toContain("Open the installed Ra7etBal app.");
    expect(modalBlock).toContain('Return to Settings and tap "Enable Notifications."');
  });

  it("controls the Modal with its own dedicated open/close state, not reusing any other modal's state", () => {
    const rowBlock = blockBetween(
      "function ReminderNotificationsRow(",
      "function getReminderStatusText(",
    );
    expect(rowBlock).toContain(
      'const [showInstallGuidance, setShowInstallGuidance] = useState(false);',
    );
    expect(rowBlock).toContain("open={showInstallGuidance}");
    expect(rowBlock).toContain("onClose={() => setShowInstallGuidance(false)}");
    expect(rowBlock).toContain("onClick={() => setShowInstallGuidance(true)}");
  });

  it("does not modify push-notifications.ts, checkPushSupport, or any subscription/service-worker logic", () => {
    const pushLib = readFileSync(join(__dirname, "../../lib/push-notifications.ts"), "utf-8");
    // Sanity check: the feature-detection function this UX change must not
    // touch is still present, unmodified in shape.
    expect(pushLib).toContain("export function checkPushSupport(): PushSupportResult {");
    expect(pushLib).not.toContain("needsIOSInstallGuidance");
    expect(pushLib).not.toContain("pwa-standalone");
  });
});
