import { describe, expect, it, vi } from 'vitest';
import { processStaffMessage } from './_staff-comms-engine.js';
import { handleInboundStaffMessage } from './whatsapp-webhook.js';

const EXPECTED_SUMMARY =
  'Christopher is asking for permission to buy a small bouquet of flowers for the dining table tonight.';

function jsonResponse(body, status = 200) {
  return { ok: status < 300, status, json: async () => body };
}

describe('owner WhatsApp decision message — live staff webhook production path', () => {
  it('persists and delivers the source-derived bouquet request even when the classifier invents household context', async () => {
    let completedArgs;
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const parsedUrl = new URL(String(url));
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : null;

      if (parsedUrl.hostname === 'api.anthropic.com') {
        return jsonResponse({
          content: [{
            text: JSON.stringify({
              classification: 'substitution_request',
              reply_to_staff: "I'm checking with the owner. I'll come back to you.",
              escalate: true,
              escalation_reason:
                "Christopher is asking for permission to buy a small bouquet of flowers for the dining table tonight — flowers fall under Nasira's ownership per household rules, and no pre-approval exists for Christopher to purchase or arrange flowers.",
              recommended_option: null,
              next_action_owner: 'owner',
              user_facing_state: 'Needs You',
              owner_attention_required: true,
            }),
          }],
        });
      }

      if (method === 'GET' && parsedUrl.pathname === '/rest/v1/whatsapp_health_state') {
        return jsonResponse([{ user_id: 'owner-a' }]);
      }
      if (method === 'GET' && parsedUrl.pathname === '/rest/v1/people') {
        if (parsedUrl.searchParams.get('select')?.includes('is_family')) {
          return jsonResponse([{
            id: 'person-a',
            user_id: 'owner-a',
            name: 'Christopher',
            phone: '+12025691377',
            role: 'staff',
            is_family: false,
            whatsapp_opted_in: true,
            whatsapp_consent_at: '2026-07-01T00:00:00Z',
            whatsapp_consent_method: 'reply',
          }]);
        }
        return jsonResponse([{
          id: 'person-a',
          name: 'Christopher',
          role: 'House Manager',
          responsibilities: 'Household purchasing',
          delegation_guidance: null,
          should_not_assign: null,
          reliability_level: 'high',
          communication_style: null,
          notes: null,
        }]);
      }
      if (method === 'GET' && parsedUrl.pathname === '/rest/v1/staff_messages') return jsonResponse([]);
      if (method === 'GET' && parsedUrl.pathname === '/rest/v1/household_rules') {
        return jsonResponse([{ rules: "Nasira owns flowers. Christopher has no pre-approval." }]);
      }
      if (method === 'GET' && parsedUrl.pathname === '/rest/v1/carson_memory') return jsonResponse([]);
      if (method === 'POST' && parsedUrl.pathname.endsWith('/rpc/claim_staff_message')) {
        return jsonResponse([{ message_id: 'staff-message-bouquet', is_new: true, processing_status: 'claimed' }]);
      }
      if (method === 'POST' && parsedUrl.pathname.endsWith('/rpc/complete_staff_message')) {
        completedArgs = body;
        return jsonResponse({
          id: body.p_id,
          classification: body.p_classification,
          carson_response: body.p_carson_response,
          next_action_owner: body.p_next_action_owner,
          user_facing_state: body.p_user_facing_state,
          owner_attention_required: body.p_owner_attention_required,
          escalation_reason: body.p_escalation_reason,
          task_id: null,
          response_delivery_status: 'not_attempted',
        });
      }
      if (method === 'POST' && parsedUrl.pathname.endsWith('/rpc/claim_staff_response_delivery')) {
        return jsonResponse([{ claimed: true, claim_token: 'staff-response-lease' }]);
      }
      if (method === 'POST' && parsedUrl.pathname.endsWith('/rpc/complete_staff_response_delivery')) {
        return jsonResponse({});
      }

      throw new Error(`Unexpected production-path request: ${method} ${parsedUrl.pathname}`);
    });

    const notifyOwner = vi.fn(async () => ({ attempted: true, status: 'sent' }));
    const sendStaffReply = vi.fn(async () => ({
      ok: true,
      messageId: 'wamid.staff-holding-reply',
      metaError: null,
    }));
    vi.stubGlobal('fetch', fetchImpl);

    const result = await handleInboundStaffMessage({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      msg: {
        phoneNumberId: 'meta-phone-id',
        from: '12025691377',
        body: 'Can I buy a small bouquet of flowers for the dining table tonight?',
        messageId: 'wamid.inbound-bouquet',
        timestamp: '1785273488',
      },
    }, {
      processStaffMessageImpl: (input, deps) => processStaffMessage(input, {
        ...deps,
        anthropicApiKey: 'anthropic-key',
        fetchImpl,
      }),
      notifyOwnerOfEscalationImpl: notifyOwner,
      sendMetaMessageImpl: sendStaffReply,
    });

    expect(result).toEqual({ handled: true, reason: 'delivered' });
    expect(completedArgs.p_escalation_reason).toBe(EXPECTED_SUMMARY);
    expect(completedArgs.p_escalation_reason).not.toMatch(/Nasira|ownership|pre-approval|arrang/i);
    expect(notifyOwner).toHaveBeenCalledOnce();
    expect(notifyOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        staffMessageId: 'staff-message-bouquet',
        staffName: 'Christopher',
        escalationReason: EXPECTED_SUMMARY,
      }),
      expect.objectContaining({
        supabaseUrl: 'https://example.supabase.co',
        serviceKey: 'service-key',
      }),
    );
    expect(sendStaffReply).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
