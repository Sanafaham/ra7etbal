import {
  markWhatsappDeliveryAccepted,
  markWhatsappDeliveryFailed,
} from './_whatsapp-delivery.js';
import {
  buildRoutineMessagePayload,
  sendMetaMessage,
} from './send-whatsapp-task.js';

const OWNER_REMINDER_SOURCE_TYPE = 'owner_reminder';
const DEFAULT_TEMPLATE_NAME = 'ra7etbal_routine_message';
const DEFAULT_TEMPLATE_LANGUAGE = 'en_US';
const DEFAULT_TIMEZONE = 'Europe/Istanbul';

/**
 * Claims and sends the WhatsApp channel for one existing reminder task.
 * The whatsapp_deliveries partial unique index is the authoritative claim;
 * callers may invoke this from primary, safety-net, retry, or reconciliation
 * paths without creating a second intended send.
 */
export async function deliverOwnerReminderWhatsapp({
  task,
  supabaseUrl,
  serviceRoleKey,
  fetchImpl = fetch,
}) {
  if (!task?.id || !task?.user_id || task.type !== 'reminder') {
    return { attempted: false, status: 'skipped', reason: 'invalid_reminder_task' };
  }

  const templateName = (
    process.env.WHATSAPP_ROUTINE_MESSAGE_TEMPLATE || DEFAULT_TEMPLATE_NAME
  ).trim();
  const templateLanguage = (
    process.env.WHATSAPP_TEMPLATE_LANGUAGE || DEFAULT_TEMPLATE_LANGUAGE
  ).trim();

  const delivery = await claimOwnerReminderDelivery({
    task,
    supabaseUrl,
    serviceRoleKey,
    templateName,
    templateLanguage,
    fetchImpl,
  });
  if (!delivery.claimed) {
    return {
      attempted: false,
      status: delivery.status || 'existing',
      deliveryId: delivery.deliveryId || null,
      reason: 'owner_reminder_delivery_already_claimed',
    };
  }

  const deliveryId = delivery.deliveryId;
  const fail = async (failureStage, reason, extra = {}) => {
    await markWhatsappDeliveryFailed({
      supabaseUrl,
      serviceKey: serviceRoleKey,
      deliveryId,
      failureStage,
      reason,
      templateName,
      metadata: {
        template_language: templateLanguage,
        send_mode: 'owner_reminder',
        ...extra,
      },
    });
    return { attempted: true, status: 'failed', deliveryId, reason };
  };

  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) {
    return fail('configuration', 'WhatsApp owner reminder delivery is not configured.');
  }

  const context = await loadOwnerReminderContext({
    supabaseUrl,
    serviceRoleKey,
    userId: task.user_id,
    fetchImpl,
  });
  if (!context.owner) {
    return fail('validation', context.reason || 'No unique household owner phone is configured.');
  }

  const recipientBound = await bindOwnerReminderRecipient({
    deliveryId,
    task,
    owner: context.owner,
    supabaseUrl,
    serviceRoleKey,
    fetchImpl,
  });
  if (!recipientBound) {
    return fail('storage', 'Could not bind owner reminder delivery to the household owner.');
  }

  const message = formatOwnerReminderMessage({
    description: task.description,
    dueAt: task.due_at,
    timezone: context.timezone,
  });
  const payload = buildRoutineMessagePayload({
    to: context.owner.phone,
    message,
    templateName,
    templateLanguage,
  });

  try {
    const result = await sendMetaMessage({
      url: `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
      accessToken,
      payload,
    });
    if (!result.ok) {
      const reason = result.metaError?.error_data?.details ||
        result.metaError?.message ||
        `Meta rejected owner reminder (${result.status}).`;
      await markWhatsappDeliveryFailed({
        supabaseUrl,
        serviceKey: serviceRoleKey,
        deliveryId,
        failureStage: 'meta_api',
        httpStatus: result.status,
        code: result.metaError?.code,
        subcode: result.metaError?.error_subcode,
        reason,
        templateName,
        metadata: {
          template_language: templateLanguage,
          send_mode: 'owner_reminder',
        },
      });
      return { attempted: true, status: 'failed', deliveryId, reason };
    }

    await markWhatsappDeliveryAccepted({
      supabaseUrl,
      serviceKey: serviceRoleKey,
      deliveryId,
      metaMessageId: result.messageId,
      templateName,
      metadata: {
        template_language: templateLanguage,
        send_mode: 'owner_reminder',
        owner_timezone: context.timezone,
      },
    });
    return {
      attempted: true,
      status: 'accepted',
      deliveryId,
      metaMessageId: result.messageId,
    };
  } catch (error) {
    return fail('network', error instanceof Error ? error.message : String(error));
  }
}

export async function claimOwnerReminderDelivery({
  task,
  supabaseUrl,
  serviceRoleKey,
  templateName,
  templateLanguage,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(`${supabaseUrl}/rest/v1/whatsapp_deliveries`, {
    method: 'POST',
    headers: {
      ...serviceHeaders(serviceRoleKey),
      Prefer: 'resolution=ignore-duplicates,return=representation',
    },
    body: JSON.stringify({
      user_id: task.user_id,
      task_id: task.id,
      source_type: OWNER_REMINDER_SOURCE_TYPE,
      message_kind: 'template',
      template_name: templateName,
      delivery_status: 'pending',
      metadata: {
        template_language: templateLanguage,
        send_mode: 'owner_reminder',
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Could not claim owner reminder WhatsApp delivery (${response.status}).`);
  }
  const inserted = await response.json().catch(() => []);
  if (Array.isArray(inserted) && inserted.length === 1) {
    return { claimed: true, deliveryId: inserted[0].id, status: inserted[0].delivery_status };
  }

  const existingResponse = await fetchImpl(
    `${supabaseUrl}/rest/v1/whatsapp_deliveries` +
      `?task_id=eq.${encodeURIComponent(task.id)}` +
      `&user_id=eq.${encodeURIComponent(task.user_id)}` +
      `&source_type=eq.${OWNER_REMINDER_SOURCE_TYPE}` +
      '&select=id,delivery_status&limit=1',
    { headers: serviceHeaders(serviceRoleKey) },
  );
  const existing = await existingResponse.json().catch(() => []);
  return {
    claimed: false,
    deliveryId: Array.isArray(existing) ? existing[0]?.id || null : null,
    status: Array.isArray(existing) ? existing[0]?.delivery_status || null : null,
  };
}

export async function loadOwnerReminderContext({
  supabaseUrl,
  serviceRoleKey,
  userId,
  fetchImpl = fetch,
}) {
  const [peopleResponse, profileResponse] = await Promise.all([
    fetchImpl(
      `${supabaseUrl}/rest/v1/people` +
        `?user_id=eq.${encodeURIComponent(userId)}` +
        '&select=id,name,role,phone',
      { headers: serviceHeaders(serviceRoleKey) },
    ),
    fetchImpl(
      `${supabaseUrl}/rest/v1/profiles` +
        `?id=eq.${encodeURIComponent(userId)}` +
        '&select=display_name,morning_brief_timezone&limit=1',
      { headers: serviceHeaders(serviceRoleKey) },
    ),
  ]);
  if (!peopleResponse.ok || !profileResponse.ok) {
    return { owner: null, timezone: DEFAULT_TIMEZONE, reason: 'Household owner lookup failed.' };
  }
  const people = await peopleResponse.json().catch(() => []);
  const profiles = await profileResponse.json().catch(() => []);
  const owners = (Array.isArray(people) ? people : []).filter((person) => {
    const name = String(person?.name || '').trim().toLowerCase();
    const role = String(person?.role || '').trim().toLowerCase();
    return (name === 'boss' || role === 'boss') && normalizePhone(person?.phone);
  });
  if (owners.length !== 1) {
    return {
      owner: null,
      timezone: resolveTimezone(profiles?.[0]?.morning_brief_timezone),
      reason: owners.length === 0
        ? 'No household owner phone is configured.'
        : 'Household owner phone is ambiguous.',
    };
  }
  return {
    owner: {
      id: owners[0].id,
      name: String(profiles?.[0]?.display_name || 'Owner').trim() || 'Owner',
      phone: normalizePhone(owners[0].phone),
    },
    timezone: resolveTimezone(profiles?.[0]?.morning_brief_timezone),
  };
}

async function bindOwnerReminderRecipient({
  deliveryId,
  task,
  owner,
  supabaseUrl,
  serviceRoleKey,
  fetchImpl,
}) {
  const response = await fetchImpl(
    `${supabaseUrl}/rest/v1/whatsapp_deliveries` +
      `?id=eq.${encodeURIComponent(deliveryId)}` +
      `&task_id=eq.${encodeURIComponent(task.id)}` +
      `&user_id=eq.${encodeURIComponent(task.user_id)}` +
      `&source_type=eq.${OWNER_REMINDER_SOURCE_TYPE}` +
      '&delivery_status=eq.pending&select=id',
    {
      method: 'PATCH',
      headers: { ...serviceHeaders(serviceRoleKey), Prefer: 'return=representation' },
      body: JSON.stringify({
        recipient_phone: owner.phone,
        recipient_name: owner.name,
      }),
    },
  );
  const rows = await response.json().catch(() => []);
  return response.ok && Array.isArray(rows) && rows.length === 1;
}

export function formatOwnerReminderMessage({ description, dueAt, timezone }) {
  const cleanDescription = String(description || '').trim().replace(/[.\s]+$/, '');
  const safeTimezone = resolveTimezone(timezone);
  const due = new Date(dueAt);
  const localDue = Number.isNaN(due.getTime())
    ? null
    : `${due.toLocaleString('en-US', {
        timeZone: safeTimezone,
        weekday: 'long',
      })} at ${due.toLocaleString('en-US', {
        timeZone: safeTimezone,
        hour: 'numeric',
        minute: '2-digit',
      })}`;
  return `Reminder: ${cleanDescription || 'Your reminder'}${localDue ? `. Due ${localDue}.` : '.'}`;
}

function resolveTimezone(value) {
  const timezone = String(value || '').trim() || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return timezone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function serviceHeaders(serviceRoleKey) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };
}
