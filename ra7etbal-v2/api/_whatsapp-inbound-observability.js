/**
 * Persist the minimum immutable evidence needed to audit inbound WhatsApp
 * correlation. This deliberately excludes message bodies and the full Meta
 * webhook payload.
 */
export async function persistWhatsappInboundEvidence({
  supabaseUrl,
  serviceKey,
  evidence,
  normalizedMessage,
}) {
  if (!supabaseUrl || !serviceKey || !evidence?.inboundMetaMessageId) {
    return { ok: false, reason: 'missing_required_field' };
  }

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/record_whatsapp_inbound_evidence`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_inbound_meta_message_id: evidence.inboundMetaMessageId,
        p_context_present: evidence.contextPresent,
        p_raw_context_id: evidence.rawContextId,
        p_raw_context_from: evidence.rawContextFrom,
        p_message_type: evidence.messageType,
        p_sender_phone: evidence.senderPhone,
        p_business_number_id: evidence.businessNumberId,
        p_webhook_received_at: evidence.webhookReceivedAt,
        p_normalized_context_message_id: normalizedMessage?.contextMessageId || null,
      }),
    });
    if (!response.ok) {
      const details = await response.text().catch(() => '');
      return { ok: false, reason: details || `http_${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error?.message || String(error) };
  }
}
