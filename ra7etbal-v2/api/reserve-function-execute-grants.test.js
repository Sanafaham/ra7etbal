import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORWARD = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260825170000_reserve_functions_service_role_only.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260825170000_reserve_functions_service_role_only.rollback.sql'), 'utf8');
const customSignature = 'public.reserve_custom_instruction(uuid, uuid, uuid, text, text, text, text, uuid)';
const rejectedSignature = 'public.reserve_rejected_alternative(uuid, uuid, uuid, text, text, text, text, uuid)';

function executableStatements(sql) {
  return sql.replace(/--.*$/gm, '').split(';').map((statement) => statement.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

describe('reserve-function service-role-only migration', () => {
  it('revokes only anon/authenticated execution on the exact current signatures', () => {
    expect(executableStatements(FORWARD)).toEqual([
      `REVOKE EXECUTE ON FUNCTION ${customSignature} FROM anon, authenticated`,
      `REVOKE EXECUTE ON FUNCTION ${rejectedSignature} FROM anon, authenticated`,
    ]);
  });

  it('does not redefine functions, alter RLS, or change service_role', () => {
    expect(FORWARD).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
    expect(FORWARD).not.toMatch(/alter\s+table|create\s+policy|drop\s+policy/i);
    expect(FORWARD).not.toMatch(/from\s+service_role|to\s+service_role/i);
  });

  it('has an exact minimal emergency rollback', () => {
    expect(executableStatements(ROLLBACK)).toEqual([
      `GRANT EXECUTE ON FUNCTION ${customSignature} TO anon, authenticated`,
      `GRANT EXECUTE ON FUNCTION ${rejectedSignature} TO anon, authenticated`,
    ]);
  });
});
