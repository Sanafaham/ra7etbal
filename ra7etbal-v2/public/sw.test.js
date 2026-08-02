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
    expect(source).toContain('data: { receipt: receipt }');
  });
});
