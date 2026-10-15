import { verifyDeploymentRequest } from './_s01-deployment-verification.js';

const DENIAL = { success: false, code: 'verification_denied' };
const MAX_BODY = 4096;
// Only the isolated Build Output artifact imports this adapter. Normal Carson
// builds never select it. No application module, client or provider is imported.
export async function handleVerifierOnly(req, res, { commitSha, projectRef }, {
  env = process.env, fetchImpl = globalThis.fetch,
} = {}) {
  res.setHeader('Cache-Control', 'no-store');
  const reply = (status, body = DENIAL) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };
  try {
    if (env.S01_VERIFIER_ONLY !== 'true' || env.S01_VERIFICATION_ENABLED !== 'true'
      || env.VERCEL_GIT_COMMIT_SHA !== commitSha
      || req.url !== '/api/send-whatsapp-task' || req.method !== 'POST'
      || !/^application\/json(?:;|$)/i.test(req.headers?.['content-type'] ?? '')) return reply(403);
    // Ignore framework-parsed body objects: read and bound the actual transport.
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BODY) return reply(403);
      chunks.push(bytes);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body?.s01Verification?.challenge?.projectRef !== projectRef) return reply(403);
    // Explicit projection: ordinary integration credentials cannot reach verifier
    // code. The sole fetch is the existing fixed nonce-store SET NX EX operation.
    const isolated = Object.fromEntries([
      'S01_VERIFICATION_ENABLED', 'S01_VERIFICATION_PUBLIC_KEY',
      'VERCEL_DEPLOYMENT_ID', 'VERCEL_GIT_COMMIT_SHA', 'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY', 'S01_NONCE_STORE_URL', 'S01_NONCE_STORE_TOKEN',
    ].map(key => [key, env[key]]));
    const result = await verifyDeploymentRequest(body, { env: isolated, fetchImpl });
    return reply(result.status, result.body);
  } catch {
    return reply(403);
  }
}
