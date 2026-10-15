import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildVerifierArtifact, verifierRoutes } from './s01-verifier-artifact.mjs';
import { createOperatorChallenge } from './s01-verification-operator.mjs';
import { handleVerifierOnly } from '../api/_s01-verifier-only.js';

const sha = 'a'.repeat(40), ref = 'abcdefghijklmnopqrst';
const pair = generateKeyPairSync('ed25519');
const roots = [];
beforeEach(() => {
  vi.mocked(execFileSync).mockImplementation((_command, args) => {
    if (args[0] === 'rev-parse') return sha;
    if (args[0] === 'status') return '';
    if (args[0] === 'show') return readFileSync(new URL('../api/' + args[1].split('/').at(-1), import.meta.url));
    throw Error('Unexpected subprocess');
  });
});
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const env = () => ({ S01_VERIFIER_ONLY: 'true', S01_VERIFICATION_ENABLED: 'true',
  S01_VERIFICATION_PUBLIC_KEY: pair.publicKey.export({ type: 'spki', format: 'pem' }),
  VERCEL_DEPLOYMENT_ID: 'dpl_syntheticcontainment001', VERCEL_GIT_COMMIT_SHA: sha,
  SUPABASE_URL: `https://${ref}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: 'synthetic-canonical-key',
  S01_NONCE_STORE_URL: 'https://synthetic-store.upstash.io', S01_NONCE_STORE_TOKEN: 'synthetic-store-token',
  WHATSAPP_ACCESS_TOKEN: 'synthetic-provider', TWILIO_AUTH_TOKEN: 'synthetic-provider',
  CRON_SECRET: 'synthetic-internal', ANTHROPIC_API_KEY: 'synthetic-provider', QSTASH_TOKEN: 'synthetic-provider' });
const fresh = () => createOperatorChallenge({ privateKey: pair.privateKey,
  deploymentId: env().VERCEL_DEPLOYMENT_ID, commitSha: sha, projectRef: ref });
async function request(body, { path = '/api/send-whatsapp-task', method = 'POST', configuration = env(), contentType = 'application/json', chunks, transport = vi.fn(() => { throw Error('prohibited external side effect'); }) } = {}) {
  const req = Readable.from(chunks ?? [typeof body === 'string' ? body : JSON.stringify(body)]);
  req.url = path; req.method = method; req.headers = { 'content-type': contentType,
    authorization: 'Bearer synthetic-user', 'x-ra7etbal-internal-secret': 'synthetic-internal' };
  const res = { setHeader: vi.fn(), end(value) { this.body = JSON.parse(value); } };
  await handleVerifierOnly(req, res, { commitSha: sha, projectRef: ref }, { env: configuration, fetchImpl: transport });
  return { res, transport };
}
function route(path, method = 'POST') {
  return verifierRoutes.find(r => new RegExp(r.src).test(path) && (!r.methods || r.methods.includes(method)));
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 's01-artifact-test-')); roots.push(dir);
  const assets = join(dir, 'assets'); await mkdir(assets);
  await writeFile(join(assets, 'index-synthetic.js'), `const binding="https://${ref}.supabase.co";`);
  return { dir, assets, output: join(dir, 'output') };
}
describe('isolated verifier Build Output containment', () => {
  it('packages exactly one verifier function, no ordinary runtime, UI, hooks, crons, secrets or dependencies', async () => {
    const f = await fixture();
    const manifest = await buildVerifierArtifact({ output: f.output, browserAssets: f.assets, commitSha: sha, projectRef: ref });
    expect(await readdir(join(f.output, 'functions/api'))).toEqual(['send-whatsapp-task.func']);
    expect(await readdir(join(f.output, 'functions/api/send-whatsapp-task.func'))).toEqual([
      '.vc-config.json', '_s01-deployment-verification.js', '_s01-verifier-only.js', 'index.js', 'package.json']);
    expect(await readdir(join(f.output, 'static'))).toEqual(['assets']);
    const config = JSON.parse(await readFile(join(f.output, 'config.json'), 'utf8'));
    expect(config).toEqual({ version: 3, routes: verifierRoutes, crons: [] });
    expect(manifest.kind).toContain('NOT-a-release-artifact');
    for (const [file, hash] of Object.entries(manifest.files)) {
      const data = await readFile(join(f.output, file));
      expect(createHash('sha256').update(data).digest('hex')).toBe(hash);
      expect(data.toString()).not.toContain('synthetic-canonical-key');
      expect(data.toString()).not.toContain('synthetic-store-token');
    }
    const generated = await import(pathToFileURL(join(f.output, 'functions/api/send-whatsapp-task.func/index.js')));
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const res = { setHeader: vi.fn(), end: vi.fn() };
    await generated.default({ url: '/api/send-whatsapp-task', method: 'POST' }, res);
    expect(res.statusCode).toBe(403); expect(fetch).not.toHaveBeenCalled();
  });
  it('denies every current ordinary API path, webhook, cron and browser navigation', async () => {
    const apiFiles = (await readdir(new URL('../api/', import.meta.url))).filter(p => p.endsWith('.js') && !p.startsWith('_') && !p.includes('.test.'));
    for (const file of apiFiles) {
      const path = '/api/' + file.slice(0, -3);
      if (path === '/api/send-whatsapp-task') continue;
      expect(route(path).status, path).toBe(403);
      const { res, transport } = await request(fresh().request, { path });
      expect(res.statusCode).toBe(403); expect(transport).not.toHaveBeenCalled();
    }
    for (const path of ['/', '/index.html', '/chat/completions', '/sw.js', '/api/send-whatsapp-task/', '/api/send-whatsapp-task.js', '/api/%73end-whatsapp-task', '/assets/../api/whatsapp-webhook', '/assets/index.js.map']) {
      expect(route(path, 'GET').status, path).toBe(403);
    }
    expect(route('/assets/index-synthetic.js', 'GET').check).toBe(true);
    expect(route('/assets/index-synthetic.js', 'POST').status).toBe(403);
  });
  it.each(['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('denies method %s with zero external side effects', async method => {
    const { res, transport } = await request(fresh().request, { method });
    expect(res.statusCode).toBe(403); expect(transport).not.toHaveBeenCalled();
  });
  it.each([undefined, 'false', 'TRUE', '1'])('missing/invalid verifier-only activation %s fails closed', async value => {
    const configuration = env(); configuration.S01_VERIFIER_ONLY = value;
    const { res, transport } = await request(fresh().request, { configuration });
    expect(res.statusCode).toBe(403); expect(transport).not.toHaveBeenCalled();
  });
  it.each([{ to: 'synthetic', messageText: 'send' }, {}, { s01Verification: {} }])('ordinary/malformed body denied even with internal and session auth', async body => {
    const { res, transport } = await request(body);
    expect(res.statusCode).toBe(403); expect(transport).not.toHaveBeenCalled();
  });
  it('denies mixed delivery fields before nonce/network access', async () => {
    const body = fresh().request; body.to = 'synthetic';
    const { res, transport } = await request(body);
    expect(res.statusCode).toBe(403); expect(transport).not.toHaveBeenCalled();
  });
  it.each(['application/x-www-form-urlencoded', 'text/plain', ''])('denies content type %s', async contentType => {
    const { res, transport } = await request(fresh().request, { contentType });
    expect(res.statusCode).toBe(403); expect(transport).not.toHaveBeenCalled();
  });
  it('denies oversized/invalid JSON, query-path requests, missing configuration and commit mismatch without side effects', async () => {
    const configurations = [env(), { ...env(), VERCEL_GIT_COMMIT_SHA: 'b'.repeat(40) }, { ...env(), S01_VERIFICATION_PUBLIC_KEY: undefined }, { ...env(), S01_NONCE_STORE_TOKEN: undefined }];
    for (const options of [{ chunks: [' '.repeat(4097)] }, { path: '/api/send-whatsapp-task?testMode=true' }, ...configurations.slice(1).map(configuration => ({ configuration }))]) {
      const { res, transport } = await request(fresh().request, options);
      expect(res.statusCode).toBe(403); expect(transport).not.toHaveBeenCalled();
    }
    const { res, transport } = await request('{invalid'); expect(res.statusCode).toBe(403); expect(transport).not.toHaveBeenCalled();
  });
  it('allows only a signed proof and nonce write; rejects replay without any database/provider operation', async () => {
    let consumed = false;
    const transport = vi.fn(async (url, options) => {
      expect(url).toBe(env().S01_NONCE_STORE_URL);
      expect(JSON.parse(options.body)[0]).toBe('SET');
      const result = consumed ? null : 'OK'; consumed = true;
      return { ok: true, json: async () => ({ result }) };
    });
    const operator = fresh();
    const { res } = await request(operator.request, { transport });
    expect(res.statusCode).toBe(200);
    expect(operator.compare(res.body, { canonicalKey: env().SUPABASE_SERVICE_ROLE_KEY, adminProjectRef: ref, adminPrivilege: 'service_role' })).toBe(true);
    expect((await request(operator.request, { transport })).res.statusCode).toBe(409);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('refuses an unverified commit, dirty checkout and conflicting browser references before deployable config exists', async () => {
    const f = await fixture();
    const args = { output: f.output, browserAssets: f.assets, commitSha: 'b'.repeat(40), projectRef: ref };
    await expect(buildVerifierArtifact(args)).rejects.toThrow('provenance');
    vi.mocked(execFileSync).mockImplementationOnce(() => sha).mockImplementationOnce(() => ' M api/file.js');
    await expect(buildVerifierArtifact({ ...args, commitSha: sha })).rejects.toThrow('provenance');
    await writeFile(join(f.assets, 'foreign.js'), 'const foreign="https://zzzzzzzzzzzzzzzzzzzz.supabase.co"');
    await expect(buildVerifierArtifact({ ...args, commitSha: sha })).rejects.toThrow('Conflicting');
    await expect(readFile(join(f.output, 'config.json'))).rejects.toThrow();
  });
  it('refuses stale output, symlink browser assets and missing binding; never mixes ordinary functions', async () => {
    const f = await fixture(); const args = { output: f.output, browserAssets: f.assets, commitSha: sha, projectRef: ref };
    await buildVerifierArtifact(args);
    await expect(buildVerifierArtifact(args)).rejects.toThrow();
    const g = await fixture(); await symlink(join(g.assets, 'index-synthetic.js'), join(g.assets, 'evil.js'));
    await expect(buildVerifierArtifact({ ...args, output: g.output, browserAssets: g.assets })).rejects.toThrow();
    const h = await fixture(); await writeFile(join(h.assets, 'index-synthetic.js'), 'no binding');
    await expect(buildVerifierArtifact({ ...args, output: h.output, browserAssets: h.assets })).rejects.toThrow();
  });
});
