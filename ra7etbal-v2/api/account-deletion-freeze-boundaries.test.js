import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');

describe('Tier 1 account deletion consequential freeze wiring', () => {
  it.each([
    ['send-whatsapp-task.js', 'const accountAccess = await checkAccountConsequentialAccess', 'const deliveryId = await beginWhatsappDelivery'],
    ['qstash-reminder.js', 'checkAccountConsequentialAccess', "if (action === 'create-and-schedule')"],
    ['automations.js', 'const accountAccess = await checkAccountConsequentialAccess', 'const body = req.body ?? {}'],
    ['google-calendar.js', 'checkAccountConsequentialAccess', 'exchangeGoogleRefreshToken'],
    ['send-due-reminder-pushes.js', 'checkAccountConsequentialAccess', 'attemptOwnerReminderWhatsapp'],
    ['_owner-command-executor.js', 'checkAccountConsequentialAccess', 'recordOwnerInbound'],
  ])('%s checks the canonical freeze before its consequential boundary', (file, guard, boundary) => {
    const text = source(`./${file}`);
    expect(text.indexOf(guard)).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(guard)).toBeLessThan(text.indexOf(boundary));
  });

  it('guards callbacks, delegations, routines, and automations per trusted row owner', () => {
    const text = source('./process-delegation-escalations.js');
    expect(text).toContain('userId: task.user_id');
    expect(text).toContain('userId: routine.user_id');
    expect(text).toContain('userId: automation.user_id');
    expect(text.match(/checkAccountConsequentialAccess/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it.each([
    ['_owner-whatsapp-routing.js', 'userId: row.user_id', 'handleInboundOwnerMessage'],
    ['_personal-contact-reply.js', 'userId: row.user_id', 'sendOwnerRelay'],
    ['_no-response-handoff.js', 'userId: task.user_id', 'const result = await notify'],
  ])('%s blocks scheduler retries before replaying an external action', (file, owner, boundary) => {
    const text = source(`./${file}`);
    const loopGuard = text.lastIndexOf('checkAccountConsequentialAccess', text.indexOf(boundary));
    expect(text).toContain(owner);
    expect(loopGuard).toBeGreaterThanOrEqual(0);
    expect(loopGuard).toBeLessThan(text.indexOf(boundary));
  });

  it('keeps cancellation available while blocking new QStash scheduling', () => {
    const text = source('./qstash-reminder.js');
    expect(text).toContain("if (action !== 'cancel')");
  });

  it('uses one shared fail-closed guard rather than per-path policy copies', () => {
    const guard = source('./_account-deletion-guard.js');
    expect(guard).toContain("return { allowed: false, code: 'account_state_unavailable' }");
    expect(guard).toContain("status=in.(in_progress,failed_retryable,failed_requires_review)");
  });
});
