import { supabase } from "./supabase";

export type PushNotificationStatus =
  | "idle"
  | "enabled"
  | "denied"
  | "unsupported"
  | "error";

export interface PushSupportResult {
  supported: boolean;
  reason: "supported" | "unsupported";
}

interface PushSubscriptionRow {
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expiration_time: string | null;
  user_agent: string;
  platform: string;
  enabled: boolean;
}

type PushSupportFlags = ReturnType<typeof getPushSupportFlags>;

interface PushDebugSnapshot {
  finalStatus?: PushNotificationStatus;
  errorName?: string;
  errorMessage?: string;
  permissionResult?: NotificationPermission | "unavailable";
  supportFlags?: PushSupportFlags;
  serviceWorkerScope?: string;
  serviceWorkerActive?: boolean;
  hasRegistrationPushManager?: boolean;
  vapidKeyLength?: number;
  convertedKeyLength?: number;
  subscribePhase?: "before" | "during" | "after";
}

const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
const debugPrefix = "[Push Slice 2]";
const debugSnapshot: PushDebugSnapshot = {};

export function checkPushSupport(): PushSupportResult {
  const flags = getPushSupportFlags();
  debugSnapshot.supportFlags = flags;
  debugLog("support flags", flags);

  if (
    !flags.hasWindow ||
    !flags.isSecureContext ||
    !flags.hasNotification ||
    !flags.hasServiceWorker ||
    !flags.hasPushManager
  ) {
    return { supported: false, reason: "unsupported" };
  }

  return { supported: true, reason: "supported" };
}

export async function getExistingPushSubscription(): Promise<PushSubscription | null> {
  const support = checkPushSupport();
  if (!support.supported) return null;

  const registration = await getOrRegisterServiceWorker();
  return registration.pushManager.getSubscription();
}

export async function enableReminderNotifications(userId: string): Promise<PushNotificationStatus> {
  const support = checkPushSupport();
  debugLog("standalone state", getStandaloneState());
  debugLog("initial permission", getNotificationPermission());

  if (!support.supported || !vapidPublicKey) {
    noteFinalStatus("unsupported");
    return "unsupported";
  }

  if (Notification.permission === "denied") {
    noteFinalStatus("denied");
    return "denied";
  }

  let permission: NotificationPermission;
  try {
    if (Notification.permission === "granted") {
      permission = "granted";
      debugSnapshot.permissionResult = permission;
    } else {
      debugLog("before requestPermission");
      permission = await Notification.requestPermission();
      debugSnapshot.permissionResult = permission;
      debugLog("permission result", permission);
    }
  } catch (error) {
    notePushDebugError(error);
    debugLog("permission thrown", errorSummary(error));
    throw error;
  }

  if (permission === "denied") {
    noteFinalStatus("denied");
    return "denied";
  }
  if (permission !== "granted") {
    noteFinalStatus("error");
    return "error";
  }

  const registration = await getOrRegisterServiceWorker();
  const existingSubscription = await registration.pushManager.getSubscription();
  const subscription =
    existingSubscription ??
    (await subscribeToPush(registration));

  await savePushSubscription(userId, subscription);
  noteFinalStatus("enabled");
  return "enabled";
}

export function notePushDebugError(error: unknown): void {
  const summary = errorSummary(error);
  debugSnapshot.errorName = summary.name;
  debugSnapshot.errorMessage = summary.message;
}

export function getPushDebugText(): string {
  const flags = debugSnapshot.supportFlags;
  const supportText = flags
    ? `s:${bool(flags.isSecureContext)} n:${bool(flags.hasNotification)} sw:${bool(flags.hasServiceWorker)} p:${bool(flags.hasPushManager)}`
    : "s:na";
  const parts = [
    `status:${debugSnapshot.finalStatus ?? "na"}`,
    `perm:${debugSnapshot.permissionResult ?? "na"}`,
    `phase:${debugSnapshot.subscribePhase ?? "na"}`,
    `err:${shorten(debugSnapshot.errorName ?? "none", 18)}`,
    `msg:${shorten(debugSnapshot.errorMessage ?? "none", 96)}`,
    `scope:${shorten(debugSnapshot.serviceWorkerScope ?? "na", 40)}`,
    `active:${debugSnapshot.serviceWorkerActive === undefined ? "na" : bool(debugSnapshot.serviceWorkerActive)}`,
    `rpm:${debugSnapshot.hasRegistrationPushManager === undefined ? "na" : bool(debugSnapshot.hasRegistrationPushManager)}`,
    `vlen:${debugSnapshot.vapidKeyLength ?? "na"}`,
    `klen:${debugSnapshot.convertedKeyLength ?? "na"}`,
    supportText,
  ];

  return parts.join(" | ");
}

async function getOrRegisterServiceWorker(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing?.active) {
    debugLog("service worker registration", registrationSummary(existing));
    return existing;
  }
  if (existing) {
    const readyRegistration = await navigator.serviceWorker.ready;
    debugLog("service worker registration", registrationSummary(readyRegistration));
    return readyRegistration;
  }

  await navigator.serviceWorker.register("/sw.js");
  const readyRegistration = await navigator.serviceWorker.ready;
  debugLog("service worker registration", registrationSummary(readyRegistration));
  return readyRegistration;
}

async function subscribeToPush(
  registration: ServiceWorkerRegistration,
): Promise<PushSubscription> {
  const registrationDebug = {
    scope: registration.scope,
    active: Boolean(registration.active),
    waiting: Boolean(registration.waiting),
    installing: Boolean(registration.installing),
    hasPushManager: Boolean(registration.pushManager),
  };
  debugSnapshot.serviceWorkerScope = registrationDebug.scope;
  debugSnapshot.serviceWorkerActive = registrationDebug.active;
  debugSnapshot.hasRegistrationPushManager = registrationDebug.hasPushManager;
  debugSnapshot.vapidKeyLength = vapidPublicKey.length;
  debugSnapshot.subscribePhase = "before";
  debugLog("subscribe registration state", registrationDebug);
  debugLog("vapid public key length", debugSnapshot.vapidKeyLength);

  const applicationServerKey = urlBase64ToArrayBuffer(vapidPublicKey);
  debugSnapshot.convertedKeyLength = applicationServerKey.byteLength;
  debugLog("converted applicationServerKey length", debugSnapshot.convertedKeyLength);
  debugLog("before pushManager.subscribe");

  try {
    debugSnapshot.subscribePhase = "during";
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
    debugSnapshot.subscribePhase = "after";
    debugLog("subscribe success", { endpointExists: Boolean(subscription.endpoint) });
    return subscription;
  } catch (error) {
    notePushDebugError(error);
    debugLog("subscribe error", errorSummary(error));
    throw error;
  }
}

async function savePushSubscription(
  userId: string,
  subscription: PushSubscription,
): Promise<void> {
  const key = subscription.getKey("p256dh");
  const auth = subscription.getKey("auth");
  debugLog("key presence", { hasP256dh: Boolean(key), hasAuth: Boolean(auth) });

  if (!key || !auth) {
    throw new Error("Browser did not provide the full push subscription.");
  }

  const row: PushSubscriptionRow = {
    user_id: userId,
    endpoint: subscription.endpoint,
    p256dh: arrayBufferToBase64Url(key),
    auth: arrayBufferToBase64Url(auth),
    expiration_time: subscription.expirationTime
      ? new Date(subscription.expirationTime).toISOString()
      : null,
    user_agent: navigator.userAgent,
    platform: navigator.platform || "unknown",
    enabled: true,
  };

  debugLog("supabase save start", { endpointExists: Boolean(subscription.endpoint) });
  const lookup = await supabase
    .from("push_subscriptions")
    .select("id")
    .eq("user_id", userId)
    .eq("endpoint", subscription.endpoint)
    .maybeSingle();

  if (lookup.error) {
    debugLog("supabase select error", supabaseErrorSummary(lookup.error));
    throw lookup.error;
  }

  const result = lookup.data
    ? await supabase.from("push_subscriptions").update(row).eq("id", lookup.data.id)
    : await supabase.from("push_subscriptions").insert(row);

  if (result.error) {
    debugLog(
      lookup.data ? "supabase update error" : "supabase insert error",
      supabaseErrorSummary(result.error),
    );
    throw result.error;
  }
}

function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputBuffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(outputBuffer);

  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputBuffer;
}

function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";

  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }

  return window
    .btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function getPushSupportFlags() {
  const hasWindow = typeof window !== "undefined";
  const hasNavigator = typeof navigator !== "undefined";

  return {
    hasWindow,
    isSecureContext: hasWindow ? window.isSecureContext : false,
    hasNotification: hasWindow && "Notification" in window,
    hasNavigator,
    hasServiceWorker: hasNavigator && "serviceWorker" in navigator,
    hasPushManager: hasWindow && "PushManager" in window,
  };
}

function getStandaloneState() {
  const standaloneNavigator = navigator as Navigator & { standalone?: boolean };

  return {
    navigatorStandalone: standaloneNavigator.standalone ?? null,
    displayModeStandalone:
      typeof window !== "undefined" && "matchMedia" in window
        ? window.matchMedia("(display-mode: standalone)").matches
        : null,
  };
}

function getNotificationPermission(): NotificationPermission | "unavailable" {
  return typeof window !== "undefined" && "Notification" in window
    ? Notification.permission
    : "unavailable";
}

function registrationSummary(registration: ServiceWorkerRegistration) {
  return {
    scope: registration.scope,
    active: Boolean(registration.active),
    waiting: Boolean(registration.waiting),
    installing: Boolean(registration.installing),
  };
}

function errorSummary(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }

  return { name: typeof error, message: String(error) };
}

function supabaseErrorSummary(error: {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}) {
  return {
    code: error.code,
    message: error.message,
    details: error.details,
    hint: error.hint,
  };
}

function noteFinalStatus(status: PushNotificationStatus): void {
  debugSnapshot.finalStatus = status;
  debugLog("final status", status);
}

function debugLog(message: string, details?: unknown): void {
  if (details === undefined) {
    console.info(debugPrefix, message);
    return;
  }

  console.info(debugPrefix, message, details);
}

function bool(value: boolean): "1" | "0" {
  return value ? "1" : "0";
}

function shorten(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}
