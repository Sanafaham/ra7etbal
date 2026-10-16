import { test, beforeAll, afterAll, beforeEach, vi, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { startLocalAdapter, tokenFor, OWNER_A, OWNER_B } from './fixtures/owner-learning-local.mjs';
const real = process.env.CARSON464_REAL_DB === '1';
let adapter, a, b, active;
async function client(owner) {
  const result=createClient(adapter.url,'isolated-local-anon',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  const {error}=await result.auth.setSession({access_token:tokenFor(owner),refresh_token:'local-only'});
  if(error)throw error;
  return result;
}
async function session(using=a) {
  active=using;vi.resetModules();
  vi.doMock('../src/lib/supabase',()=>({supabase:new Proxy({}, {get:(_,key)=>typeof active[key]==='function'?active[key].bind(active):active[key]})}));
  return import('../src/lib/carson-persistent-memory');
}
beforeAll(async()=>{if(!real)return;adapter=await startLocalAdapter();a=await client(OWNER_A);b=await client(OWNER_B);});
beforeEach(async()=>{if(!real)return;for(const c of [a,b]){const {error}=await c.from('carson_persistent_memory').delete().neq('id','00000000-0000-0000-0000-000000000000');if(error)throw error;}});
afterAll(async()=>{if(adapter)await adapter.close();});

test.skipIf(!real)('real database: saved, corrected and removed instructions survive fresh authenticated clients',async()=>{
  let api=await session();await api.savePersistentInstruction('preference','Offer three travel options.');
  api=await session(await client(OWNER_A));expect(await api.loadPersistentMemory()).toContain('three travel options');
  await api.replaceOwnerInstruction((await api.listOwnerInstructions())[0].id,'Offer two travel options.');
  api=await session(await client(OWNER_A));expect(await api.loadPersistentMemory()).toContain('two travel options');expect(await api.loadPersistentMemory()).not.toContain('three travel options');
  await api.removeOwnerInstruction((await api.listOwnerInstructions())[0].id);
  api=await session(await client(OWNER_A));expect(await api.loadPersistentMemory()).toBe('');
  const {data}=await a.from('carson_persistent_memory').select('*');expect(data).toHaveLength(1);expect(data[0].source).toBe('owner_removal');expect(data[0].instruction).toBe('Removed instruction');
});

test.skipIf(!real)('real JWT-bound RLS: other owner and anonymous clients cannot read or mutate the rule',async()=>{
  let api=await session();await api.savePersistentInstruction('general','Keep answers concise.');const [row]=await api.listOwnerInstructions();
  api=await session(b);expect(await api.listOwnerInstructions()).toEqual([]);await expect(api.replaceOwnerInstruction(row.id,'Use long answers.')).rejects.toThrow();await expect(api.removeOwnerInstruction(row.id)).rejects.toThrow();
  const wrongOwner=await b.from('carson_persistent_memory').insert({user_id:OWNER_A,instruction:'Cross-owner write',category:'general'});expect(wrongOwner.error).toBeTruthy();
  const anonymous=createClient(adapter.url,'local-anon',{auth:{persistSession:false,autoRefreshToken:false}});expect((await anonymous.from('carson_persistent_memory').select('*')).error).toBeTruthy();
  expect((await a.from('carson_persistent_memory').select('*')).data).toHaveLength(1);
});

test.skipIf(!real)('real database: concurrent corrections remain conflicts until the owner explicitly resolves them',async()=>{
  const api=await session();await api.savePersistentInstruction('general','Keep recommendations concise.');const [row]=await api.listOwnerInstructions();adapter.control.barrier=true;
  const results=await Promise.allSettled([api.replaceOwnerInstruction(row.id,'Offer two options.'),api.replaceOwnerInstruction(row.id,'Offer four options.')]);
  expect(results.some(r=>r.status==='rejected')).toBe(true);
  const heads=await api.listOwnerInstructions();expect(heads).toHaveLength(2);expect(heads.every(r=>r.conflicted)).toBe(true);
  const context=await api.loadPersistentMemory();expect(context).not.toContain('Offer two');expect(context).not.toContain('Offer four');
  await api.replaceOwnerInstruction(heads[0].id,'Offer five options.');
  expect(await api.loadPersistentMemory()).toContain('Offer five');expect((await api.listOwnerInstructions())).toHaveLength(1);
});

test.skipIf(!real)('real database: failed writes preserve the valid rule; failed text deletion stays recoverable',async()=>{
  const api=await session();await api.savePersistentInstruction('general','Keep answers concise.');let [row]=await api.listOwnerInstructions();
  adapter.control.failInsert=true;await expect(api.replaceOwnerInstruction(row.id,'Offer two options.')).rejects.toBeTruthy();expect(await api.loadPersistentMemory()).toContain('Keep answers concise');
  adapter.control.failDelete=true;await expect(api.removeOwnerInstruction(row.id)).rejects.toThrow('stored text');
  expect(await api.loadPersistentMemory()).not.toContain('Keep answers concise');[row]=await api.listOwnerInstructions();expect(row.removalPending).toBe(true);await api.removeOwnerInstruction(row.id);expect(await api.listOwnerInstructions()).toEqual([]);
});

test.skipIf(!real)('real database: correction beyond the default 1000-row window cannot resurrect an old version',async()=>{
  const root='owner_rule:46400000-0000-4000-8000-000000000099';
  const rows=Array.from({length:1005},(_,i)=>({
    id:`46400000-0000-4000-8001-${String(i+1).padStart(12,'0')}`,
    category:i?`${root}/after/46400000-0000-4000-8001-${String(i).padStart(12,'0')}`:root,
    instruction:i===1004?'Newest instruction beyond the result window.':`Old instruction ${i}.`,source:'owner_directive',
  }));
  const {error}=await a.from('carson_persistent_memory').insert(rows);if(error)throw error;
  const api=await session();expect(await api.listOwnerInstructions()).toHaveLength(1);
  expect(await api.loadPersistentMemory()).toContain('Newest instruction beyond');expect(await api.loadPersistentMemory()).not.toContain('Old instruction');
});
