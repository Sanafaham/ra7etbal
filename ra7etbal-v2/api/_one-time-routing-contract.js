export const ONE_TIME_ROUTING_CONTRACT_VERSION = 'one-time-routing-v1';

const DESTINATIONS = new Set(['owner_reminder', 'one_time_automation']);

export function validateOneTimeRoutingEvidence(evidence, expectedDestination) {
  if (evidence == null) return { present: false, valid: true, reasonCode: 'legacy_no_evidence' };
  if (typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { present: true, valid: false, reasonCode: 'evidence_not_object' };
  }
  if (evidence.contract_version !== ONE_TIME_ROUTING_CONTRACT_VERSION) {
    return { present: true, valid: false, reasonCode: 'contract_version_invalid' };
  }
  if (!DESTINATIONS.has(evidence.destination)) {
    return { present: true, valid: false, reasonCode: 'destination_invalid' };
  }
  if (evidence.destination !== expectedDestination) {
    return { present: true, valid: false, reasonCode: 'destination_mismatch' };
  }
  if (evidence.decision_source !== 'fresh_user_transcript') {
    return { present: true, valid: false, reasonCode: 'decision_source_invalid' };
  }
  if (typeof evidence.client_build !== 'string' || evidence.client_build.length < 1 || evidence.client_build.length > 64) {
    return { present: true, valid: false, reasonCode: 'client_build_invalid' };
  }
  if (typeof evidence.operation_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(evidence.operation_id)) {
    return { present: true, valid: false, reasonCode: 'operation_id_invalid' };
  }
  return { present: true, valid: true, reasonCode: 'accepted' };
}

export function safeBuildForLog(evidence) {
  const value = evidence?.client_build;
  return typeof value === 'string' && /^(?:[a-f0-9]{7,64}|local|unknown)$/i.test(value)
    ? value
    : 'invalid';
}
