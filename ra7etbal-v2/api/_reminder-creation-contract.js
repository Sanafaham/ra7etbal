export const REMINDER_CREATION_CONTRACT_VERSION = 'reminder-creation-v1';

const ALLOWED_SOURCES = new Set([
  'voice',
  'inbox',
  'todos',
  'save',
  'act_on_note',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateReminderCreationContract(value) {
  if (!value || typeof value !== 'object') return { valid: false, reasonCode: 'creation_contract_missing' };
  if (value.contract_version !== REMINDER_CREATION_CONTRACT_VERSION) {
    return { valid: false, reasonCode: 'creation_contract_version_invalid' };
  }
  if (!ALLOWED_SOURCES.has(value.source)) return { valid: false, reasonCode: 'creation_source_invalid' };
  if (!UUID_RE.test(value.operation_id ?? '')) return { valid: false, reasonCode: 'operation_id_invalid' };
  return { valid: true, reasonCode: 'accepted' };
}
