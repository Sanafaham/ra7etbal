import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { validateOneTimeRoutingEvidence } from './_one-time-routing-contract.js';

const valid = {
  contract_version: 'one-time-routing-v1',
  destination: 'owner_reminder',
  decision_source: 'fresh_user_transcript',
  client_build: '35c71db848741082766ae9b960c704764f71336d',
  operation_id: '4c438c39-7b8f-43f6-9085-0b4b64905bf8',
};

describe('authoritative one-time routing contract', () => {
  it('accepts exact owner-reminder evidence for the reminder boundary', () => {
    expect(validateOneTimeRoutingEvidence(valid, 'owner_reminder')).toEqual({
      present: true,
      valid: true,
      reasonCode: 'accepted',
    });
  });

  it('rejects stale/reminder-shaped requests carrying authoritative automation intent', () => {
    expect(validateOneTimeRoutingEvidence(
      { ...valid, destination: 'one_time_automation' },
      'owner_reminder',
    )).toMatchObject({ valid: false, reasonCode: 'destination_mismatch' });
  });

  it('requires fresh transcript evidence on the authoritative creation action', () => {
    expect(validateOneTimeRoutingEvidence(null, 'owner_reminder')).toMatchObject({
      present: false,
      reasonCode: 'legacy_no_evidence',
    });
  });

  it('validates routing before the server inserts a routed reminder', () => {
    const source = fs.readFileSync(path.resolve('api/qstash-reminder.js'), 'utf8');
    const action = source.indexOf("if (action === 'create-and-schedule')");
    const validation = source.indexOf('validateOneTimeRoutingEvidence', action);
    const insert = source.indexOf("fetch(`${supabaseUrl}/rest/v1/tasks`", action);
    expect(action).toBeGreaterThan(-1);
    expect(validation).toBeGreaterThan(action);
    expect(insert).toBeGreaterThan(validation);
  });
});
