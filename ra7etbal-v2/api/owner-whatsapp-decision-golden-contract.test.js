import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { isDecisionShapedMessage, normalizeOwnerDecisionReply } from './_owner-whatsapp-routing.js';

const CRITICAL_FILES = [
  '_owner-whatsapp-routing.js',
  'whatsapp-webhook.js',
  '_escalation-notify.js',
  'task-confirm.js',
  '../src/routes/OwnerEscalationDecision.tsx',
  '../src/lib/needs-you-staff-escalations.ts',
  '../src/lib/staff-messages.ts',
  '../supabase/migrations/20260726_staff_escalation_owner_decisions.sql',
  '../supabase/migrations/20260727_phase_d_escalation_answer_delivery_message_id.sql',
  '../supabase/migrations/20260727_owner_whatsapp_reply_receipts.sql',
  '../supabase/migrations/20260728_owner_whatsapp_safe_routing_slice_1.sql',
];

describe('golden owner WhatsApp decision-reply contract', () => {
  it.each([
    ['Yes', 'approved', null],
    ['No', 'rejected', null],
    ['Approve it', 'approved', null],
    ["Don't approve it", 'rejected', null],
    ['Yes, but do not serve it to guests', 'custom_instruction', 'Yes, but do not serve it to guests'],
    ['Buy the red wine vinegar', 'custom_instruction', 'Buy the red wine vinegar'],
    ['No, use another substitute', 'custom_instruction', 'No, use another substitute'],
    ['Ask Christopher for more information', 'custom_instruction', 'Ask Christopher for more information'],
  ])('normalizes %s without losing exact conditional or free text', (text, decision, instructionText) => {
    expect(normalizeOwnerDecisionReply(text)).toEqual({ decision, instructionText });
  });

  it('keeps unrelated owner commands out of decision matching', () => {
    expect(isDecisionShapedMessage('Yes')).toBe(true);
    expect(isDecisionShapedMessage('Ask Christopher for more information')).toBe(true);
    expect(isDecisionShapedMessage('Ask Grace to call me')).toBe(false);
    expect(isDecisionShapedMessage('Remind me tomorrow')).toBe(false);
    expect(isDecisionShapedMessage('What still needs my attention?')).toBe(false);
  });

  it('locks ordered correlation, ambiguity, exact audit, and duplicate suppression', async () => {
    const routing = await readFile(new URL('_owner-whatsapp-routing.js', import.meta.url), 'utf8');
    const quote = routing.indexOf('if (msg.contextMessageId)');
    const identifier = routing.indexOf('const explicitId = extractDecisionIdentifier');
    const recent = routing.indexOf('if (!isDecisionShapedMessage(msg.body))');
    expect(quote).toBeGreaterThan(-1);
    expect(identifier).toBeGreaterThan(quote);
    expect(recent).toBeGreaterThan(identifier);
    expect(routing).toContain('&status=eq.open&created_at=gte.');
    expect(routing).toContain("requireOwnerNotification: true");
    expect(routing).toContain(
      'I have two pending decisions from ${staff}. Which one do you mean, ${topics[0]} or ${topics[1]}?',
    );
    expect(routing).toContain('exact_reply: instructionText');
    expect(routing).toContain('duplicate_resolution_ignored: true');
    expect(routing).toContain("replyChannel: 'whatsapp'");
    expect(routing).toContain("acknowledgement_status === 'accepted'");
  });

  it('keeps app and WhatsApp on one answer and delivery state machine', async () => {
    const sources = Object.fromEntries(await Promise.all(CRITICAL_FILES.map(async (file) => [
      file, await readFile(new URL(file, import.meta.url), 'utf8'),
    ])));
    const phaseD = sources['task-confirm.js'];
    expect(sources['_owner-whatsapp-routing.js']).toContain('resolveAndDeliverEscalationAnswer');
    expect(phaseD).toContain('export async function resolveAndDeliverEscalationAnswer');
    expect(phaseD).toContain('claim_escalation_answer_delivery');
    expect(phaseD).toContain('complete_escalation_answer_delivery');
    expect(phaseD).toContain('delivery_transport_message_id');
    expect(phaseD).toContain("replyChannel: 'app'");
    expect(phaseD).toContain('p_owner_reply_channel: replyChannel');
    expect(sources['whatsapp-webhook.js'].indexOf('await handleInboundOwnerMessage'))
      .toBeLessThan(sources['whatsapp-webhook.js'].indexOf('await handleInboundConsentReply'));
  });

  it('keeps owner decision requests reply-first without removing the independent app flow', async () => {
    const notification = await readFile(new URL('_escalation-notify.js', import.meta.url), 'utf8');
    const appRoute = await readFile(new URL('../src/routes/OwnerEscalationDecision.tsx', import.meta.url), 'utf8');
    expect(notification).toContain('buildDirectMessagePayload');
    expect(notification).toContain('Reply to this message with your decision.');
    expect(notification).not.toContain('buildOwnerDecisionTemplatePayload');
    expect(notification).not.toContain("taskUuid: deepLinkToken");
    expect(notification).toContain(".replace(/[\\r\\n\\t]+/g, ' ')");
    expect(appRoute).toContain('submitEscalationDecision');
    expect(appRoute).toContain('deepLinkToken');
  });

  it('protects the focused contract and direct behavior suites in Carson CI', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const gate = packageJson.scripts['test:carson-protected'];
    for (const test of [
      'api/owner-whatsapp-decision-golden-contract.test.js',
      'api/_owner-whatsapp-routing.test.js',
      'api/task-confirm.test.js',
      'api/staff-escalation-phase-b-golden-contract.test.js',
      'src/routes/OwnerEscalationDecision.test.tsx',
      'src/lib/staff-messages.test.ts',
      'src/lib/needs-you-staff-escalations.test.ts',
    ]) expect(gate).toContain(test);
    const workflow = await readFile(
      new URL('../../.github/workflows/carson-protected-behaviors.yml', import.meta.url), 'utf8',
    );
    expect(workflow).toContain('npm run test:carson-protected');
    expect(workflow).not.toMatch(/^\s+paths:/m);
  });
});
