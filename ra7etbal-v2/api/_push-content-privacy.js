export const GENERIC_PUSH_TITLE = 'Ra7etBal';
export const GENERIC_PUSH_BODY = 'You have an update in Ra7etBal.';

/**
 * Treat every external push payload as observable outside the authenticated app.
 * Keep only generic display copy plus the opaque routing/evidence fields that the
 * current service worker needs. Authoritative notification content remains in the
 * tenant-scoped owner_notifications/task records and is never rewritten here.
 */
export function buildPrivacySafePushPayload({ notificationId, url, receipt } = {}) {
  return {
    title: GENERIC_PUSH_TITLE,
    body: GENERIC_PUSH_BODY,
    ...(notificationId ? { notificationId } : {}),
    ...(url ? { url } : {}),
    ...(receipt ? { receipt } : {}),
  };
}
