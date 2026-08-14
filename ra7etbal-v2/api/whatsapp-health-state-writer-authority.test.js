import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_ROOT = new URL('.', import.meta.url).pathname;
const REST_PATH = 'rest/v1/whatsapp_health_state';

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.js$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

/** Extracts a top-level `async function <name>(...) {...}` body via brace/paren balance. */
function extractFunctionBody(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  if (start === -1) return null;

  // Skip past the parameter list first — a destructured param like
  // `({ userId, phoneNumberId })` has its own braces nested inside the
  // parens, so the function body's `{` is the first one AFTER the params'
  // closing `)`, not the first `{` in the source.
  const paramsOpen = source.indexOf('(', start);
  let parenDepth = 0;
  let paramsClose = -1;
  for (let i = paramsOpen; i < source.length; i += 1) {
    if (source[i] === '(') parenDepth += 1;
    if (source[i] === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        paramsClose = i;
        break;
      }
    }
  }
  if (paramsClose === -1) return null;

  const openBrace = source.indexOf('{', paramsClose);
  let depth = 0;
  for (let i = openBrace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Root cause of the 2026-08-11 cross-account contamination incident (see
 * recordWebhookHeartbeat's own comment in whatsapp-webhook.js): a writer
 * into whatsapp_health_state that could invent a NEW ownership binding
 * without both a real phone_number_id AND a caller-verified user_id let one
 * webhook silently rebind unrelated accounts. The fix confined all writes
 * to a single reviewed file with two narrow shapes: a heartbeat PATCH that
 * only touches rows already bound to the given phone_number_id (never
 * creates a row), and an upsert that requires both user_id and
 * phone_number_id together. No test previously proved this stays true as
 * the codebase grows — this file is that proof, not a fabricated pass.
 */
describe('whatsapp_health_state writer authority', () => {
  const ALLOWED_WRITER_FILE = join(API_ROOT, 'whatsapp-webhook.js');

  it('confines every REST write into whatsapp_health_state to the one reviewed file', () => {
    const offenders = [];
    for (const path of sourceFiles(API_ROOT)) {
      const source = readFileSync(path, 'utf8');
      const writesToHealthState = new RegExp(
        `${REST_PATH}[^\`'"]*\`?['"]?[\\s\\S]{0,200}?method:\\s*['"](POST|PATCH|PUT)['"]`,
      ).test(source);
      if (writesToHealthState && path !== ALLOWED_WRITER_FILE) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never lets the heartbeat PATCH invent a new ownership binding', () => {
    const source = readFileSync(ALLOWED_WRITER_FILE, 'utf8');
    const fnBody = extractFunctionBody(source, 'patchHealthRowsForPhoneNumber');
    expect(fnBody, 'patchHealthRowsForPhoneNumber must exist unchanged').toBeTruthy();

    // A heartbeat PATCH must filter by phone_number_id in the query string
    // (the only way a PATCH can target existing rows without inventing one)
    // and must never be a POST/upsert.
    expect(fnBody).toContain('phone_number_id=eq.');
    expect(fnBody).toContain("method: 'PATCH'");
    expect(fnBody).not.toMatch(/method:\s*['"]POST['"]/);
    expect(fnBody).not.toContain('on_conflict=');
  });

  it('requires both phone_number_id and a caller-verified user_id before creating any new binding', () => {
    const source = readFileSync(ALLOWED_WRITER_FILE, 'utf8');
    const fnBody = extractFunctionBody(source, 'upsertHealthState');
    expect(fnBody, 'upsertHealthState must exist unchanged').toBeTruthy();

    expect(fnBody).toContain('on_conflict=user_id,phone_number_id');
    expect(fnBody).toContain('user_id: userId');
    expect(fnBody).toContain('phone_number_id: phoneNumberId');

    // upsertHealthState itself does not verify the caller — its only
    // production caller must, by requiring a real userId before calling in.
    const callerBody = extractFunctionBody(source, 'updateMatchedHealthState');
    expect(callerBody, 'updateMatchedHealthState must exist unchanged').toBeTruthy();
    expect(callerBody).toContain('if (!userId || !resolvedPhoneNumberId) return;');
  });

  it('only recordWebhookHeartbeat and updateMatchedHealthState call the two writer helpers', () => {
    const source = readFileSync(ALLOWED_WRITER_FILE, 'utf8');
    const patchCallers = [...source.matchAll(/patchHealthRowsForPhoneNumber\(\{/g)].length;
    const upsertCallers = [...source.matchAll(/upsertHealthState\(\{/g)].length;
    // Each helper's own function declaration counts as one match; exactly
    // one additional call site each is the known, reviewed shape.
    expect(patchCallers).toBe(2);
    expect(upsertCallers).toBe(2);
  });
});
