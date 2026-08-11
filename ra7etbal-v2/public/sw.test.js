import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('reminder service-worker observability contract', () => {
  it('keeps push display inside waitUntil and reports every durable client stage', async () => {
    const source = await readFile(new URL('./sw.js', import.meta.url), 'utf8');
    expect(source).toContain('event.waitUntil(');
    expect(source).toContain('self.registration.showNotification');
    for (const stage of [
      'service_worker_received',
      'show_notification_attempted',
      'show_notification_resolved',
      'show_notification_failed',
      'notification_clicked',
    ]) {
      expect(source).toContain(`"${stage}"`);
    }
    expect(source).toContain('receipt: receipt');
    expect(source).toContain('notificationId: payload.notificationId');
    expect(source).toContain('url: safeInternalRoute(payload.url)');
  });

  it('navigates an existing client, opens a target without one, and rejects unsafe URLs', async () => {
    const source = await readFile(new URL('./sw.js', import.meta.url), 'utf8');
    expect(source).toContain('client.navigate(targetUrl)');
    expect(source).toContain('client.focus()');
    expect(source).toContain('self.clients.openWindow(targetUrl)');
    expect(source).toContain('resolved.origin !== self.location.origin');
    expect(source).toContain('value.startsWith("//")');
    expect(source).toContain('return "/notifications"');
  });
});

describe('pushsubscriptionchange handler — resubscribes and reports the new subscription to open clients', () => {
  it('resubscribes using the original VAPID key and never hardcodes a new one', async () => {
    const source = await readFile(new URL('./sw.js', import.meta.url), 'utf8');
    expect(source).toContain('addEventListener("pushsubscriptionchange"');
    expect(source).toContain('event.waitUntil(');
    expect(source).toContain('oldSubscription.options.applicationServerKey');
    expect(source).toContain('self.registration.pushManager');
    expect(source).toContain('.subscribe(');
  });

  it('posts the new subscription to every open client, never silently drops it', async () => {
    const source = await readFile(new URL('./sw.js', import.meta.url), 'utf8');
    expect(source).toContain('"ra7etbal:push-subscription-changed"');
    expect(source).toContain('newSubscription.toJSON()');
    expect(source).toContain('clients.matchAll(');
  });

  it('no-ops when the browser does not supply oldSubscription, rather than guessing a key', async () => {
    const source = await readFile(new URL('./sw.js', import.meta.url), 'utf8');
    expect(source).toContain('if (!applicationServerKey) return;');
  });
});
