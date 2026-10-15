import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const verifierRoutes = [
  { src: '^/api/send-whatsapp-task$', methods: ['POST'], dest: '/api/send-whatsapp-task' },
  { src: '^/assets/[A-Za-z0-9_-]+\\.js$', methods: ['GET', 'HEAD'], check: true },
  { src: '.*', status: 403, headers: { 'Cache-Control': 'no-store' } },
];
// Offline packaging only. Never reads environment variables or credentials,
// executes repository hooks/builds, queries platforms, or deploys anything.
export async function buildVerifierArtifact({ output, browserAssets, commitSha, projectRef }) {
  if (!/^[a-f0-9]{40}$/.test(commitSha ?? '') || !/^[a-z0-9]{20}$/.test(projectRef ?? '')
    || !output || !browserAssets) throw new Error('Invalid nonsecret artifact inputs');
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  if (git(['rev-parse', 'HEAD']) !== commitSha
    || git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Commit/clean-checkout provenance denied');
  const out = resolve(output);
  // Fresh destination only: refuse rather than mix in stale functions or secrets.
  await mkdir(out, { recursive: false });
  const functionPath = resolve(out, 'functions/api/send-whatsapp-task.func');
  await mkdir(functionPath, { recursive: true });
  const files = {};
  const put = async (path, data) => {
    await mkdir(dirname(resolve(out, path)), { recursive: true });
    await writeFile(resolve(out, path), data);
    files[path] = digest(data);
  };
  for (const name of ['_s01-deployment-verification.js', '_s01-verifier-only.js']) {
    await put('functions/api/send-whatsapp-task.func/' + name, execFileSync('git', ['show', `${commitSha}:ra7etbal-v2/api/${name}`], { cwd: root }));
  }
  await put('functions/api/send-whatsapp-task.func/package.json', '{"type":"module"}');
  await put('functions/api/send-whatsapp-task.func/index.js',
    `import { handleVerifierOnly } from './_s01-verifier-only.js';\nexport default (req,res) => handleVerifierOnly(req,res,${JSON.stringify({ commitSha, projectRef })});\n`);
  await put('functions/api/send-whatsapp-task.func/.vc-config.json', JSON.stringify({
    runtime: 'nodejs22.x', handler: 'index.js', launcherType: 'Nodejs', maxDuration: 10,
    shouldAddHelpers: false, shouldAddSourcemapSupport: false,
  }));
  const assets = resolve(browserAssets);
  if (!(await lstat(assets)).isDirectory() || (await lstat(assets)).isSymbolicLink()) throw new Error('Invalid assets');
  let count = 0, projectFound = false;
  for (const entry of await readdir(assets, { withFileTypes: true })) {
    if (!entry.name.endsWith('.js')) continue;
    if (!entry.isFile() || !/^[A-Za-z0-9_-]+\.js$/.test(entry.name)) throw new Error('Unsafe browser asset');
    const data = await readFile(resolve(assets, entry.name));
    const references = [...data.toString().matchAll(/https:\/\/([a-z0-9]{20})\.supabase\.co/g)].map(match => match[1]);
    if (references.some(value => value !== projectRef)) throw new Error('Conflicting browser project reference');
    projectFound ||= references.includes(projectRef);
    await put('static/assets/' + entry.name, data);
    count++;
  }
  if (!count || !projectFound) throw new Error('Missing intended browser binding');
  await put('config.json', JSON.stringify({ version: 3, routes: verifierRoutes, crons: [] }, null, 2));
  const manifest = { kind: 's01-verifier-only-NOT-a-release-artifact', commitSha, projectRef, files,
    browserEvidence: 'Asset hashes/reference scan only; clean pinned Vite build origin must be independently recorded' };
  await writeFile(resolve(out, 's01-artifact-manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [output, browserAssets, commitSha, projectRef] = process.argv.slice(2);
  try { await buildVerifierArtifact({ output, browserAssets, commitSha, projectRef }); }
  catch { console.error('Verifier artifact preparation denied; discard incomplete output.'); process.exitCode = 1; }
}
