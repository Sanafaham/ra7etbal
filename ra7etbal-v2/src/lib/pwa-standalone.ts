/**
 * Detects whether the app needs to tell the user to "Add to Home Screen"
 * before notifications can work. iOS only exposes the Push API to a page
 * running as an installed, standalone PWA — never to a regular Safari (or
 * any other iOS browser, since all iOS browsers use WebKit) tab. This is a
 * fixed platform restriction, not something feature-detection on its own
 * (checkPushSupport in push-notifications.ts) can explain to the user.
 */

export function isIOSDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ reports as "MacIntel" with touch support, unlike a real Mac.
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

export function isStandaloneDisplayMode(): boolean {
  if (typeof navigator === "undefined") return false;
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const displayModeStandalone =
    typeof matchMedia === "function" ? matchMedia("(display-mode: standalone)").matches : false;
  return iosStandalone || displayModeStandalone;
}

/** True only when the user is on iOS and not running the installed app. */
export function needsIOSInstallGuidance(): boolean {
  return isIOSDevice() && !isStandaloneDisplayMode();
}
