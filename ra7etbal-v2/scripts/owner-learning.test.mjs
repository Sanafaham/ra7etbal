import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

// Execute the actual TypeScript service with an isolated in-memory transport.
// This verifies application behavior, not deployed Postgres RLS or model behavior.
async function fixture() {
  const db = { rows: [], owner: 'owner-a', failInsert: false, failDelete: false, clock: 0 };
  const supabase = {
    auth: { getUser: async () => ({ data: { user: db.owner ? { id: db.owner } : null }, error: null }) },
    from(table) {
      assert.equal(table, 'carson_persistent_memory');
      const filters = []; let operation = 'read'; let payload;
      const execute = () => {
        if (!db.owner) return { data: null, error: { message: 'Not signed in.' } };
        if (operation === 'insert') {
          db.beforeInsert?.();
          if (db.failInsert) return { data: null, error: { message: 'Write failed' } };
          if (payload.user_id && payload.user_id !== db.owner) return { data: null, error: { message: 'RLS denied' } };
          db.rows.push({ ...payload, id: webcrypto.randomUUID(), user_id: db.owner,
            created_at: new Date(1800000000000 + db.clock++).toISOString() });
          return { data: null, error: null };
        }
        const rows = db.rows.filter(row => row.user_id === db.owner && filters.every(([k,v]) => row[k] === v));
        if (operation === 'delete') {
          if (db.failDelete) return { data: null, error: { message: 'Delete failed' } };
          db.rows = db.rows.filter(row => !rows.includes(row));
        }
        return { data: rows, error: null };
      };
      const q = {
        select() { return q; }, order() { return q; }, eq(k,v) { filters.push([k,v]); return q; },
        insert(value) { operation = 'insert'; payload = value; return q; },
        delete() { operation = 'delete'; return q; },
        single() { const r = execute(); return Promise.resolve({ ...r, data: r.data?.[0] ?? null }); },
        then(resolve,reject) { return Promise.resolve(execute()).then(resolve,reject); },
      };
      return q;
    },
  };
  const context = createContext({ console: { error() {}, warn() {} }, TextEncoder, Date, crypto: webcrypto });
  const transport = new SyntheticModule(['supabase'], function() { this.setExport('supabase', supabase); }, { context });
  const gate = new SourceTextModule(stripTypeScriptTypes(readFileSync(new URL('../src/lib/carson-epistemic-gate.ts', import.meta.url),'utf8')), { context });
  const serviceSource = stripTypeScriptTypes(readFileSync(new URL('../src/lib/carson-persistent-memory.ts', import.meta.url),'utf8'));
  async function freshSession() {
    const module = new SourceTextModule(serviceSource, { context });
    await module.link(specifier => specifier === './supabase' ? transport : gate);
    await module.evaluate();
    return module.namespace;
  }
  return { db, api: await freshSession(), freshSession };
}

test('teaching survives a new service/session and correction replaces its context', async () => {
  const {api, db, freshSession} = await fixture();
  await api.savePersistentInstruction('preference', 'Limit travel recommendations to three options.');
  const tomorrow = await freshSession();
  assert.match(await tomorrow.loadPersistentMemory(), /three options/);
  const [rule] = await tomorrow.listOwnerInstructions();
  await tomorrow.replaceOwnerInstruction(rule.id, 'Limit travel recommendations to two options.');
  assert.equal(db.rows.length, 2, 'old version remains historical evidence');
  const later = await freshSession();
  const context = await later.loadPersistentMemory();
  assert.match(context, /two options/);
  assert.doesNotMatch(context, /three options/);
  assert.match(context, /current authenticated owner's instruction takes priority/);
});

test('removal deletes every version and prevents an older preference resurfacing', async () => {
  const {api, db, freshSession} = await fixture();
  await api.savePersistentInstruction('preference', 'Keep answers under three sentences.');
  await api.replaceOwnerInstruction((await api.listOwnerInstructions())[0].id, 'Keep answers under two sentences.');
  await api.removeOwnerInstruction((await api.listOwnerInstructions())[0].id);
  assert.equal(db.rows.length, 0);
  assert.equal(await (await freshSession()).loadPersistentMemory(), '');
});

test('failed correction leaves the original active and reports failure', async () => {
  const {api, db} = await fixture();
  await api.savePersistentInstruction('general', 'Always keep recommendations concise.');
  const [row] = await api.listOwnerInstructions(); db.failInsert = true;
  await assert.rejects(api.replaceOwnerInstruction(row.id, 'Use two options.'), error => error.message === "Write failed");
  assert.equal((await api.listOwnerInstructions())[0].instruction, row.instruction);
});

test('failed removal does not report success or hide the stored rule', async () => {
  const {api, db} = await fixture();
  await api.savePersistentInstruction('general', 'Use concise answers.'); db.failDelete = true;
  await assert.rejects(api.removeOwnerInstruction((await api.listOwnerInstructions())[0].id));
  assert.equal((await api.listOwnerInstructions()).length, 1);
});

test('uncertain inference is rejected before it can be saved as an owner instruction', async () => {
  const {api, db} = await fixture();
  await assert.rejects(api.savePersistentInstruction('preference', 'Prefers short answers.', 'session_inference'), /confirm/);
  assert.equal(db.rows.length, 0);
  db.rows.push({ id: 'x', user_id: db.owner, category: 'preference', instruction: 'Unverified assumption.', source: 'session_inference' });
  assert.equal(await api.loadPersistentMemory(), '');
});

test('another owner cannot review, correct or remove the first owner instruction through this service', async () => {
  const {api, db} = await fixture();
  await api.savePersistentInstruction('general', 'Use concise answers.');
  const id = (await api.listOwnerInstructions())[0].id; db.owner = 'owner-b';
  assert.equal((await api.listOwnerInstructions()).length, 0);
  await assert.rejects(api.replaceOwnerInstruction(id, 'Use long answers.'));
  await assert.rejects(api.removeOwnerInstruction(id));
  assert.equal(db.rows.length, 1);
  db.owner = null;
  await assert.rejects(api.savePersistentInstruction('general', 'Use concise answers.'));
  await assert.rejects(api.removeOwnerInstruction(id), /signed in/);
});

test('legacy rules remain separate and are removable without unsafe multi-write replacement', async () => {
  const {api, db} = await fixture();
  db.rows.push(...['First rule.', 'Second rule.'].map((instruction,i) => ({id: String(i), user_id: db.owner, category: 'always', instruction, source: 'owner_directive'})));
  assert.equal((await api.listOwnerInstructions()).length, 2);
  await assert.rejects(api.replaceOwnerInstruction('0', 'Replacement rule.'), /Remove this older/);
  await api.removeOwnerInstruction('0');
  assert.equal(db.rows[0].instruction, 'Second rule.');
});

test('stale correction cannot replace a version already changed', async () => {
  const {api} = await fixture();
  await api.savePersistentInstruction('general', 'Use concise answers.');
  const [first] = await api.listOwnerInstructions();
  await api.replaceOwnerInstruction(first.id, 'Use two options.');
  await assert.rejects(api.replaceOwnerInstruction(first.id, 'Use four options.'), /changed/);
});


test('an account switch during correction cannot copy the first owner rule into the new account', async () => {
  const {api, db} = await fixture();
  await api.savePersistentInstruction('general', 'Use concise answers.');
  const [rule] = await api.listOwnerInstructions();
  db.beforeInsert = () => { db.owner = 'owner-b'; };
  await assert.rejects(api.replaceOwnerInstruction(rule.id, 'Use two options.'), error => error.message === 'RLS denied');
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].user_id, 'owner-a');
});
