/**
 * WhatsApp Carson memory — buildOwnerContextText against a PostgREST-shaped
 * fetch mock that enforces the REAL column lists.
 *
 * Column lists were verified read-only against the production schema on
 * 2026-10-17 (information_schema, column names only — no row content).
 * Selecting a column that does not exist returns PostgREST's error object
 * (code 42703), exactly like production. The original WhatsApp code selected
 * carson_memory.session_recap/session_date, which do not exist, so its recap
 * list was always empty; the recap test below fails against that code.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildOwnerContextText } from './_carson-agent-turn.js';
import { buildCarsonMemoryContext } from '../shared/carson-memory-selection.js';

const OWNER = 'owner-a';
const OTHER = 'owner-b';
const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();

const REAL_COLUMNS = {
  carson_memory: ['id', 'user_id', 'created_at', 'summary'],
  carson_facts: ['id', 'user_id', 'category', 'key', 'value', 'confidence', 'source', 'created_at', 'updated_at', 'last_seen_at', 'archived_at'],
  carson_persistent_memory: ['id', 'user_id', 'category', 'instruction', 'created_at', 'updated_at', 'source', 'confirmed_at'],
  people: ['id', 'user_id', 'name', 'role', 'emoji', 'contact_method', 'phone', 'created_at', 'updated_at', 'notes', 'relationship', 'is_family', 'responsibilities', 'reliability_level', 'follow_up_level', 'delegation_guidance', 'should_not_assign', 'escalate_to', 'communication_style', 'whatsapp_opted_in', 'whatsapp_consent_at', 'whatsapp_consent_method'],
  profiles: ['id', 'display_name', 'morning_brief_timezone'],
  tasks: ['id', 'user_id', 'type', 'description', 'status', 'due_at', 'created_at'],
};

let tables;
let requests;

function pgError(message) {
  return { code: '42703', details: null, hint: null, message };
}

/** Minimal PostgREST: eq / is.null / like filters, select, order, limit. */
function fakeFetch(url, init = {}) {
  const u = new URL(url);
  const table = u.pathname.split('/').pop();
  requests.push({ table, method: init.method ?? 'GET', url: u });
  const select = (u.searchParams.get('select') ?? '*').split(',');
  const unknown = select.find((c) => c !== '*' && !REAL_COLUMNS[table]?.includes(c));
  if (unknown) {
    return Promise.resolve({ json: async () => pgError(`column ${table}.${unknown} does not exist`) });
  }
  let rows = [...(tables[table] ?? [])];
  for (const [key, raw] of u.searchParams.entries()) {
    if (['select', 'order', 'limit'].includes(key)) continue;
    const [op, ...rest] = raw.split('.');
    const value = rest.join('.');
    if (op === 'eq') rows = rows.filter((r) => String(r[key]) === value);
    if (op === 'is' && value === 'null') rows = rows.filter((r) => r[key] == null);
    if (op === 'in') {
      const list = value.replace(/^\(|\)$/g, '').split(',');
      rows = rows.filter((r) => list.includes(String(r[key])));
    }
    if (op === 'like') {
      const prefix = value.replace(/[%*]$/, '');
      rows = rows.filter((r) => typeof r[key] === 'string' && r[key].startsWith(prefix));
    }
  }
  const order = u.searchParams.get('order');
  if (order) {
    const [col, dir] = order.split('.');
    rows.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (dir === 'desc' ? -1 : 1));
  }
  const limit = Number(u.searchParams.get('limit') ?? 1000);
  rows = rows.slice(0, limit).map((r) => Object.fromEntries(select.map((c) => [c, r[c]])));
  return Promise.resolve({ json: async () => rows });
}

function manyFacts(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `f-${i}`,
    user_id: OWNER,
    category: 'communication_style',
    key: `a_rule_${String(i).padStart(3, '0')}`,
    value: `Style rule ${i}.`,
    confidence: 0.9,
    updated_at: daysAgo(10 + (i % 30)),
    archived_at: null,
  }));
}

beforeEach(() => {
  requests = [];
  tables = {
    tasks: [{ id: 't1', user_id: OWNER, type: 'delegation', description: 'Grace: fold laundry', status: 'pending', created_at: daysAgo(1) }],
    people: [
      { id: 'p-c', user_id: OWNER, name: 'Christopher', role: 'Driver', whatsapp_opted_in: true, notes: 'Long-time driver.\nprefers receiving dinner instructions before 3 PM.' },
      { id: 'p-g', user_id: OWNER, name: 'Grace', role: 'Housekeeper', whatsapp_opted_in: true, notes: null },
      { id: 'p-x', user_id: OTHER, name: 'Stranger', role: 'Other tenant', notes: 'SECRET other-tenant note' },
    ],
    carson_persistent_memory: [
      { id: 'i-4', user_id: OWNER, category: 'general', instruction: 'Christopher prefers receiving dinner instructions before 4 PM.', source: 'owner_directive', created_at: daysAgo(10), confirmed_at: daysAgo(10) },
      ...Array.from({ length: 12 }, (_, i) => ({
        id: `i-x${i}`, user_id: OWNER, category: 'general', instruction: `Standing rule number ${i} about topic${i}.`, source: 'owner_directive', created_at: daysAgo(9 - i * 0.1), confirmed_at: daysAgo(9),
      })),
      { id: 'i-3', user_id: OWNER, category: 'general', instruction: 'Actually, Christopher now prefers receiving dinner instructions before 3 PM.', source: 'owner_directive', created_at: daysAgo(1), confirmed_at: daysAgo(1) },
      { id: 'i-other', user_id: OTHER, category: 'general', instruction: 'Other tenant secret rule.', source: 'owner_directive', created_at: daysAgo(0), confirmed_at: daysAgo(0) },
    ],
    profiles: [{ id: OWNER, display_name: 'Sana', morning_brief_timezone: 'Asia/Dubai' }],
    carson_memory: [
      { id: 'm1', user_id: OWNER, created_at: daysAgo(1), summary: '• Session recap: asked Grace to fold laundry' },
      { id: 'm2', user_id: OWNER, created_at: daysAgo(0.5), summary: 'Durable note that is NOT a recap' },
      { id: 'm3', user_id: OTHER, created_at: daysAgo(0.2), summary: '• Session recap: other tenant secret' },
    ],
    carson_facts: [
      ...manyFacts(380),
      { id: 'f-chris', user_id: OWNER, category: 'relationship', key: 'christopher_route_changes', value: 'Christopher wants route changes sent as voice notes.', confidence: 0.95, updated_at: daysAgo(40), archived_at: null },
      { id: 'f-chris-dup', user_id: OWNER, category: 'relationship', key: 'christopher_dinner_instruction_time', value: 'Christopher prefers dinner instructions before 3 PM.', confidence: 0.95, updated_at: daysAgo(40), archived_at: null },
      { id: 'f-archived', user_id: OWNER, category: 'relationship', key: 'christopher_old', value: 'Christopher prefers dinner instructions before 5 PM.', updated_at: daysAgo(1), archived_at: daysAgo(1) },
      { id: 'f-other', user_id: OTHER, category: 'relationship', key: 'x', value: 'Other tenant secret fact about Christopher.', updated_at: daysAgo(0) },
    ],
  };
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const build = (ownerText = '') =>
  buildOwnerContextText('https://db.example.test', 'service-key', OWNER, { ownerText, now: NOW });

describe('WhatsApp Carson memory — real carson_memory columns', () => {
  it('retrieves session recaps using created_at/summary (fails against the old session_recap/session_date query)', async () => {
    const vars = await build('hi');
    expect(vars.recent_memory).toContain('asked Grace to fold laundry');
    expect(vars.recent_memory).toContain('[Most recent session');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('never presents a non-recap row or another owner\'s recap as session history', async () => {
    const vars = await build('hi');
    expect(vars.recent_memory).not.toContain('NOT a recap');
    expect(vars.recent_memory).not.toContain('other tenant');
  });

  it('a failed query is logged by table, not silently treated as success', async () => {
    tables.carson_memory = undefined;
    vi.mocked(fetch).mockImplementation((url, init) =>
      String(url).includes('/carson_memory?')
        ? Promise.resolve({ json: async () => pgError('relation does not exist') })
        : fakeFetch(url, init));
    const vars = await build('hi');
    expect(vars.recent_memory).toContain('No previous sessions.');
    expect(console.warn).toHaveBeenCalledWith(
      'Owner conversational bridge: context query failed',
      expect.objectContaining({ table: 'carson_memory' }),
    );
  });
});

describe('WhatsApp Carson memory — instructions and facts', () => {
  it('uses the current 3 PM instruction, not the corrected 4 PM one, even with more than 10 instructions', async () => {
    const vars = await build('Send Christopher the dinner plan');
    expect(vars.persistent_instructions).toContain('before 3 PM');
    expect(vars.persistent_instructions).not.toContain('before 4 PM');
    expect(vars.persistent_instructions).toContain('Standing rule number 0');
    expect(vars.persistent_instructions).toContain('Standing rule number 11');
  });

  it('retrieves the relevant Christopher fact from beyond 380 other facts, ranked by the owner\'s message', async () => {
    const vars = await build('Please send Christopher the dinner plan');
    expect(vars.ra7etbal_state).toContain('Christopher wants route changes sent as voice notes.');
    expect(vars.ra7etbal_state).not.toContain('5 PM'); // archived
  });

  it('an older fact restating a newer instruction is shown once, through the instruction', async () => {
    const vars = await build('Please send Christopher the dinner plan');
    expect(vars.ra7etbal_state).not.toContain('christopher_dinner_instruction_time');
    expect(vars.persistent_instructions).toContain('before 3 PM');
  });

  it('includes person notes (newest lines) so voice-taught person memory reaches WhatsApp', async () => {
    const vars = await build('hi');
    expect(vars.ra7etbal_state).toContain('Notes: Long-time driver. / prefers receiving dinner instructions before 3 PM.');
  });
});

describe('WhatsApp Carson memory — tenant isolation and read-only', () => {
  it('every query is owner-scoped and only GETs are issued', async () => {
    await build('Christopher');
    expect(requests.length).toBe(6);
    for (const r of requests) {
      expect(r.method).toBe('GET');
      const scope = r.table === 'profiles' ? r.url.searchParams.get('id') : r.url.searchParams.get('user_id');
      expect(scope).toBe(`eq.${OWNER}`);
    }
  });

  it('rows from another owner never reach Carson even if the database returned them', async () => {
    // Simulate a mis-scoped response: ignore filters and return every row.
    vi.mocked(fetch).mockImplementation((url) => {
      const u = new URL(url);
      const table = u.pathname.split('/').pop();
      return Promise.resolve({ json: async () => tables[table] ?? [] });
    });
    const vars = await build('Christopher');
    const all = Object.values(vars).join('\n');
    expect(all).not.toContain('Other tenant secret');
    expect(all).not.toContain('other tenant secret');
    expect(all).not.toContain('SECRET other-tenant note');
    expect(all).not.toContain('Stranger');
  });

  it('a network failure on one query does not drop the other memory blocks', async () => {
    vi.mocked(fetch).mockImplementation((url, init) =>
      String(url).includes('/carson_facts?') ? Promise.reject(new Error('socket hang up')) : fakeFetch(url, init));
    const vars = await build('Send Christopher the dinner plan');
    expect(vars.persistent_instructions).toContain('before 3 PM');
    expect(vars.recent_memory).toContain('asked Grace to fold laundry');
    expect(console.warn).toHaveBeenCalledWith(
      'Owner conversational bridge: context query failed',
      expect.objectContaining({ table: 'carson_facts', error: 'socket hang up' }),
    );
  });

  it('a total database failure still returns safe, empty memory (Carson can answer)', async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve({ json: async () => { throw new Error('bad json'); } }));
    const vars = await build('hi');
    expect(vars.persistent_instructions).toBe('');
    expect(vars.recent_memory).toContain('No previous sessions.');
  });
});

describe('cross-channel continuity', () => {
  it('WhatsApp and Talk/Type Carson produce the same standing instructions from the same rows', async () => {
    const vars = await build('anything');
    const ownerRows = tables.carson_persistent_memory.filter((r) => r.user_id === OWNER);
    const app = buildCarsonMemoryContext({
      instructions: ownerRows,
      facts: tables.carson_facts.filter((r) => r.user_id === OWNER && !r.archived_at),
      people: tables.people.filter((p) => p.user_id === OWNER),
      now: NOW,
    });
    expect(vars.persistent_instructions).toBe(app.persistentInstructions);
  });

  it('a correction taught by voice (saved as an instruction) is used on WhatsApp', async () => {
    const vars = await build('What time should Christopher get dinner instructions?');
    expect(vars.persistent_instructions).toMatch(/Christopher now prefers receiving dinner instructions before 3 PM/);
  });
});
