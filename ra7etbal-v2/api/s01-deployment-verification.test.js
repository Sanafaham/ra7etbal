import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import handler from './send-whatsapp-task.js';
import { challengeTranscript, verifyDeploymentRequest } from './_s01-deployment-verification.js';
import { createOperatorChallenge } from '../scripts/s01-verification-operator.mjs';

const pair = generateKeyPairSync('ed25519');
const projectRef = 'abcdefghijklmnopqrst';
const deploymentId = 'dpl_syntheticdeployment001';
const commitSha = 'a'.repeat(40);
const now = Math.floor(Date.now() / 1000);
let env, transport, markers, calls;
const json = (result, ok = true) => ({ ok, json: async () => result });
function fresh() { return createOperatorChallenge({ privateKey: pair.privateKey, deploymentId, commitSha, projectRef, now }); }
function signed(change) { const body = fresh().request; Object.assign(body.s01Verification.challenge, change); body.s01Verification.signature = sign(null, challengeTranscript(body.s01Verification.challenge), pair.privateKey).toString('base64url'); return body; }
async function run(body, options = {}) { return verifyDeploymentRequest(body, { env, fetchImpl: transport, now, clock: () => now, ...options }); }
async function endpoint(body, headers = {}) {
  const res = { statusCode: 200, setHeader: vi.fn(), status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return value; } };
  await handler({ method: 'POST', headers, body }, res); return res;
}
beforeEach(() => {
  env = { S01_VERIFICATION_ENABLED: 'true', S01_VERIFICATION_PUBLIC_KEY: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    VERCEL_DEPLOYMENT_ID: deploymentId, VERCEL_GIT_COMMIT_SHA: commitSha,
    SUPABASE_URL: `https://${projectRef}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: 'synthetic-canonical-key',
    S01_NONCE_STORE_URL: 'https://synthetic-store.upstash.io', S01_NONCE_STORE_TOKEN: 'synthetic-nonce-only-token' };
  markers = new Set(); calls = [];
  transport = vi.fn(async (url, options) => {
    calls.push({ url, options });
    if (url !== env.S01_NONCE_STORE_URL) throw new Error('unexpected external operation');
    const command = JSON.parse(options.body);
    expect(command[0]).toBe('SET'); expect(command[3]).toBe('NX'); expect(command[4]).toBe('EX');
    if (markers.has(command[1])) return json({ result: null });
    markers.add(command[1]); return json({ result: 'OK' });
  });
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubGlobal('fetch', transport);
  vi.spyOn(console, 'log'); vi.spyOn(console, 'warn'); vi.spyOn(console, 'error');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('S01 default-disabled, isolated deployment verification', () => {
  it('proves synthetic credential equality with independent canonical input, and no delivery calls', async () => {
    const operator = fresh(); const res = await endpoint(operator.request);
    expect(res.statusCode).toBe(200); expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(operator.compare(res.body, { canonicalKey: 'synthetic-canonical-key', adminProjectRef: projectRef, adminPrivilege: 'service_role', now })).toBe(true);
    expect(calls).toHaveLength(1); expect(markers.size).toBe(1);
    expect(calls[0].options.redirect).toBe('error');
    expect(calls[0].options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(res.body)).not.toContain('synthetic-canonical-key');
    expect(JSON.stringify(res.body)).not.toContain('synthetic-nonce-only-token');
    expect(console.log).not.toHaveBeenCalled(); expect(console.warn).not.toHaveBeenCalled(); expect(console.error).not.toHaveBeenCalled();
  });
  it.each([undefined, 'false', 'TRUE', '1'])('disabled configuration %s denies without any side effect', async enabled => {
    vi.stubEnv('S01_VERIFICATION_ENABLED', enabled);
    const res = await endpoint(fresh().request); expect(res.statusCode).toBe(403); expect(calls).toHaveLength(0);
  });
  it('denies unsigned requests even with ordinary internal-secret authentication', async () => {
    vi.stubEnv('CRON_SECRET', 'synthetic-cron');
    const body = fresh().request; delete body.s01Verification.signature;
    const res = await endpoint(body, { 'x-ra7etbal-internal-secret': 'synthetic-cron', authorization: 'Bearer synthetic-user' });
    expect(res.statusCode).toBe(403); expect(calls).toHaveLength(0);
  });
  it('denies incorrect signature', async () => { const body=fresh().request; body.s01Verification.signature='A'.repeat(86); expect((await run(body)).status).toBe(403); expect(calls).toHaveLength(0); });
  it.each([{ expiresAt: now }, { issuedAt: now + 1 }, { expiresAt: now + 61 }, { commitSha: 'b'.repeat(40) }, { deploymentId: 'dpl_otherdeployment0001' }, { projectRef: 'z'.repeat(20) }, { purpose: 'send-whatsapp' }, { nonce: '../foreign' }])('denies invalid signed challenge %j', async change => {
    expect((await run(signed(change))).status).toBe(403); expect(calls).toHaveLength(0);
  });
  it.each(['S01_VERIFICATION_PUBLIC_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'S01_NONCE_STORE_URL', 'S01_NONCE_STORE_TOKEN', 'VERCEL_DEPLOYMENT_ID', 'VERCEL_GIT_COMMIT_SHA'])('missing %s denies without side effects', async key => {
    delete env[key]; expect((await run(fresh().request)).status).toBe(403); expect(calls).toHaveLength(0);
  });
  it.each([null, {}, [], 'unexpected'])('malformed verification envelope %j never enters delivery', async value => {
    expect((await endpoint({ s01Verification: value, to: 'synthetic-recipient', taskId: 'synthetic-task' })).statusCode).toBe(403); expect(calls).toHaveLength(0);
  });
  it('rejects valid signed proof combined with delivery parameters', async () => {
    expect((await endpoint({ ...fresh().request, messageText: 'must not send', imagePath: 'foreign' })).statusCode).toBe(403); expect(calls).toHaveLength(0);
  });
  it('rejects a wrong HTTP method with no effects', async () => {
    const res={status:vi.fn().mockReturnThis(),json:vi.fn()}; await handler({method:'GET',body:fresh().request},res);expect(res.status).toHaveBeenCalledWith(405);expect(calls).toHaveLength(0);
  });
  it('denies replay across isolated helper invocations sharing the atomic store', async () => {
    const body=fresh().request;expect((await run(body)).status).toBe(200);expect((await run(structuredClone(body))).status).toBe(409);expect(markers.size).toBe(1);
  });
  it('rejects replay after module reload with the same shared atomic store', async () => {
    const body=fresh().request; expect((await run(body)).status).toBe(200);
    vi.resetModules(); const isolated=await import('./_s01-deployment-verification.js');
    const result=await isolated.verifyDeploymentRequest(structuredClone(body),{env:structuredClone(env),fetchImpl:transport,now,clock:()=>now});
    expect(result.status).toBe(409);expect(markers.size).toBe(1);
  });
  it('concurrent replay allows exactly one proof', async () => {
    const body=fresh().request;const results=await Promise.all(Array.from({length:10},()=>run(structuredClone(body))));expect(results.filter(r=>r.status===200)).toHaveLength(1);expect(results.filter(r=>r.status===409)).toHaveLength(9);expect(markers.size).toBe(1);
  });
  it.each([json({error:'synthetic error'}),json({result:'QUEUED'}),json({result:1}),json({},false)])('store error denies proof and does not fall through', async response => {
    transport.mockResolvedValue(response); const res=await endpoint(fresh().request); expect(res.statusCode).toBe(503);expect(res.body.proof).toBeUndefined();expect(transport).toHaveBeenCalledTimes(1);
  });
  it('uncertain consumed write burns nonce, no retry/send or proof', async () => {
    const body=fresh().request; transport.mockImplementationOnce(async(url,options)=>{markers.add(JSON.parse(options.body)[1]);throw new Error('lost reply');});expect((await run(body)).status).toBe(403);expect((await run(body)).status).toBe(409);
  });
  it('challenge expiring during store operation returns no proof', async () => {
    const body=fresh().request;expect((await run(body,{clock:()=>now+61})).status).toBe(403);expect(markers.size).toBe(1);
  });
  it.each(['http://synthetic-store.upstash.io','https://evil.test','https://synthetic-store.upstash.io/path','https://synthetic-store.upstash.io?token=bad'])('refuses nonce-store destination %s', async url => {
    env.S01_NONCE_STORE_URL=url;expect((await run(fresh().request)).status).toBe(403);expect(calls).toHaveLength(0);
  });
  it('response cannot be reused as ordinary WhatsApp authentication', async () => {
    const proof=(await run(fresh().request)).body;calls.length=0;transport.mockClear();
    const res=await endpoint({to:'synthetic',messageText:'must not send'}, {'x-ra7etbal-internal-secret':proof.proof});expect(res.statusCode).toBe(401);expect(calls).toHaveLength(0);
  });
  it('operator rejects wrong key even if URL/project matches', async () => {
    const operator=fresh();const proof=(await run(operator.request)).body;expect(operator.compare(proof,{canonicalKey:'synthetic-other-key',adminProjectRef:projectRef,adminPrivilege:'service_role',now})).toBe(false);
  });
  it('transport mutation cannot replace the independently retained operator transcript', async () => {
    const operator=fresh();const original=structuredClone(operator.request);
    operator.request.s01Verification.challenge.nonce='B'.repeat(43);
    const proof=(await run(original)).body;
    const options={canonicalKey:'synthetic-canonical-key',adminProjectRef:projectRef,adminPrivilege:'service_role',now};
    expect(operator.compare(proof,options)).toBe(true);
    // The internal signed challenge is original, not the caller-mutated transport.
    const replaced=fresh();const foreign=(await run(replaced.request)).body;
    const freshVerifier=fresh();freshVerifier.request.s01Verification.challenge=structuredClone(replaced.request.s01Verification.challenge);
    expect(freshVerifier.compare(foreign,options)).toBe(false);
  });
  it('missing independent admin comparison evidence fails closed', async () => {
    const operator=fresh();const proof=(await run(operator.request)).body;expect(operator.compare(proof)).toBe(false);
  });
  it('operator cannot accept a proof twice', async () => {
    const operator=fresh();const proof=(await run(operator.request)).body;const options={canonicalKey:'synthetic-canonical-key',adminProjectRef:projectRef,adminPrivilege:'service_role',now};expect(operator.compare(proof,options)).toBe(true);expect(operator.compare(proof,options)).toBe(false);
  });
  it.each([{adminProjectRef:'z'.repeat(20)}, {adminPrivilege:'anon'}, {now:now+61}])('operator refuses insufficient admin evidence or expiry %j', async change => {
    const operator=fresh();const proof=(await run(operator.request)).body;expect(operator.compare(proof,{canonicalKey:'synthetic-canonical-key',adminProjectRef:projectRef,adminPrivilege:'service_role',now,...change})).toBe(false);
  });
});
