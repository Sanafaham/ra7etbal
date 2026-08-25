import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import './reserve-function-execute-grants.test.js';

const API_ROOT = new URL('.', import.meta.url).pathname;
const MIGRATIONS_ROOT = new URL('../supabase/migrations/', import.meta.url).pathname;
const REST_PATH = 'rest/v1/whatsapp_deliveries';

function apiSourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return apiSourceFiles(path);
    return /\.js$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

/**
 * Root cause of Incident 3 (2026-08-12): reserve_custom_instruction and
 * reserve_rejected_alternative — the worker-facing WhatsApp send after an
 * owner decision — created whatsapp_deliveries rows with no person_id at
 * all, permanently unreachable via Communication History's person_id-only
 * query once task_id was lost to a normal task deletion. Fixed once, in
 * 20260812_worker_notification_person_id.sql. Nothing before this test
 * proved it stays fixed as new migrations redefine these RPCs, or as new
 * writer files are added — this file is that proof.
 *
 * Investigated during the Carson whatsapp_deliveries writer-contract
 * review (2026-08-15): there are exactly 4 production writers that create
 * a NEW whatsapp_deliveries row today. Each is individually well-behaved
 * on person_id — either derives it from an already-resolved, trusted
 * identity with fail-closed conflict handling, or intentionally omits it
 * with a documented reason. A runtime single-writer RPC gatekeeper was
 * considered and rejected for now: it would mean rewriting
 * beginWhatsappDelivery's careful multi-table conflict resolution into
 * SQL, and collapsing two already narrow, lease-token-guarded,
 * transactional RPCs into a further layer of indirection, for no
 * behavioral improvement over what this static test already proves —
 * real rewrite risk for uncertain benefit, not a safety improvement. This
 * test is the smaller, safer, equally mechanical alternative.
 */
describe('whatsapp_deliveries writer authority', () => {
  const ALLOWED_WRITER_FILES = new Set([
    join(API_ROOT, '_whatsapp-delivery.js'),
    join(API_ROOT, '_owner-reminder-whatsapp.js'),
    // PATCH-only, id-scoped, compare-and-swap delivery-status update from
    // inbound Meta webhooks — never creates a row, never sets person_id.
    join(API_ROOT, 'whatsapp-webhook.js'),
  ]);

  it('confines every REST write into whatsapp_deliveries to the reviewed files', () => {
    const offenders = [];
    for (const path of apiSourceFiles(API_ROOT)) {
      const source = readFileSync(path, 'utf8');
      const writesToDeliveries = new RegExp(
        `${REST_PATH}[^\`'"]*\`?['"]?[\\s\\S]{0,300}?method:\\s*['"](POST|PATCH|PUT)['"]`,
      ).test(source);
      if (writesToDeliveries && !ALLOWED_WRITER_FILES.has(path)) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('beginWhatsappDelivery sets person_id from the resolved delivery context', () => {
    const source = readFileSync(join(API_ROOT, '_whatsapp-delivery.js'), 'utf8');
    expect(source).toContain('export async function beginWhatsappDelivery');
    expect(source).toMatch(/body:\s*JSON\.stringify\(\{[\s\S]{0,400}?person_id:\s*context\.personId/);
  });

  it('claimOwnerReminderDelivery intentionally never sets person_id (not a per-person event)', () => {
    const source = readFileSync(join(API_ROOT, '_owner-reminder-whatsapp.js'), 'utf8');
    const fnStart = source.indexOf('export async function claimOwnerReminderDelivery');
    expect(fnStart, 'claimOwnerReminderDelivery must exist unchanged').toBeGreaterThan(-1);
    const bodyStart = source.indexOf('body: JSON.stringify(', fnStart);
    const bodyEnd = source.indexOf('}),', bodyStart);
    const insertBody = source.slice(bodyStart, bodyEnd);
    expect(insertBody).not.toContain('person_id');
  });

  it('the current reserve_custom_instruction / reserve_rejected_alternative definitions thread p_person_id into both whatsapp_deliveries INSERTs', () => {
    // Migration filenames are date-prefixed, so lexical sort == chronological
    // order. The latest non-rollback migration that (re)defines a function
    // via CREATE OR REPLACE is the one Postgres actually runs today.
    const migrationFiles = readdirSync(MIGRATIONS_ROOT)
      .filter((name) => name.endsWith('.sql') && !name.endsWith('.rollback.sql'))
      .sort();

    for (const fnName of ['reserve_custom_instruction', 'reserve_rejected_alternative']) {
      let latestDefiningFile = null;
      let latestSource = null;
      for (const name of migrationFiles) {
        const source = readFileSync(join(MIGRATIONS_ROOT, name), 'utf8');
        if (source.includes(`CREATE OR REPLACE FUNCTION public.${fnName}(`)) {
          latestDefiningFile = name;
          latestSource = source;
        }
      }
      expect(latestDefiningFile, `no migration defines ${fnName}`).not.toBeNull();

      const fnStart = latestSource.indexOf(`CREATE OR REPLACE FUNCTION public.${fnName}(`);
      const fnEnd = latestSource.indexOf('\n$$;', fnStart);
      const fnBody = latestSource.slice(fnStart, fnEnd);

      expect(fnBody, `${fnName} (${latestDefiningFile}) must accept p_person_id`).toMatch(
        /p_person_id\s+uuid/,
      );
      const insertCount = (fnBody.match(/INSERT INTO whatsapp_deliveries/g) || []).length;
      expect(insertCount, `${fnName} (${latestDefiningFile}) must insert into whatsapp_deliveries exactly once`).toBe(1);
      const insertStart = fnBody.indexOf('INSERT INTO whatsapp_deliveries');
      const insertStatement = fnBody.slice(insertStart, fnBody.indexOf(';', insertStart));
      expect(
        insertStatement,
        `${fnName} (${latestDefiningFile})'s whatsapp_deliveries INSERT must thread p_person_id`,
      ).toMatch(/person_id[\s\S]*p_person_id/);
    }
  });
});
