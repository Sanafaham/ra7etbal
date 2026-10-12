import { createPublicKey, verify, createHmac } from 'node:crypto';

// This protocol performs no application reads/writes. Its only network operation
// is atomic consumption of a verification nonce in an independently scoped store.
export const PURPOSE = 'ra7etbal-s01-deployment-identity-v1';
export const MAX_AGE_SECONDS = 60;
const FIELDS = ['purpose', 'nonce', 'issuedAt', 'expiresAt', 'deploymentId', 'commitSha', 'projectRef'];
const DENIAL = { success: false, code: 'verification_denied' };

export function challengeTranscript(challenge) {
  return Buffer.from(JSON.stringify(FIELDS.map(key => challenge[key])));
}

export function credentialProof(key, challenge, projectRef) {
  return createHmac('sha256', key)
    .update('ra7etbal-s01-credential-proof-v1\0')
    .update(challengeTranscript(challenge))
    .update('\0')
    .update(projectRef)
    .digest('hex');
}

function validChallenge(c, now) {
  return c && typeof c === 'object' && !Array.isArray(c)
    && Object.keys(c).length === FIELDS.length && FIELDS.every(key => Object.hasOwn(c, key))
    && c.purpose === PURPOSE
    && typeof c.nonce === 'string' && /^[A-Za-z0-9_-]{43}$/.test(c.nonce)
    && Buffer.from(c.nonce, 'base64url').length === 32
    && Buffer.from(c.nonce, 'base64url').toString('base64url') === c.nonce
    && Number.isSafeInteger(c.issuedAt) && Number.isSafeInteger(c.expiresAt)
    && c.issuedAt <= now && c.expiresAt > now
    && c.expiresAt > c.issuedAt && c.expiresAt - c.issuedAt <= MAX_AGE_SECONDS
    && typeof c.deploymentId === 'string' && /^dpl_[A-Za-z0-9]{10,80}$/.test(c.deploymentId)
    && typeof c.commitSha === 'string' && /^[a-f0-9]{40}$/.test(c.commitSha)
    && typeof c.projectRef === 'string' && /^[a-z0-9]{20}$/.test(c.projectRef);
}

function projectFromEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error();
  const match = /^([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname);
  if (!match) throw new Error();
  return match[1];
}

function storeEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || url.search || url.hash || !['', '/'].includes(url.pathname)
    || !/^[a-z0-9-]+\.upstash\.io$/.test(url.hostname)) throw new Error();
  return url.origin;
}

export async function verifyDeploymentRequest(body, {
  env = process.env, fetchImpl = globalThis.fetch,
  clock = () => Math.floor(Date.now() / 1000),
  now = clock(),
} = {}) {
  try {
    if (env.S01_VERIFICATION_ENABLED !== 'true') return { status: 403, body: DENIAL };
    // Verification bodies cannot carry delivery fields, even with a valid signature.
    if (!body || Array.isArray(body) || Object.keys(body).length !== 1
      || !Object.hasOwn(body, 's01Verification')) throw new Error();
    const envelope = body.s01Verification;
    if (!envelope || Array.isArray(envelope) || Object.keys(envelope).length !== 2
      || !Object.hasOwn(envelope, 'challenge') || !Object.hasOwn(envelope, 'signature')) throw new Error();
    const c = envelope.challenge;
    if (!validChallenge(c, now) || c.deploymentId !== env.VERCEL_DEPLOYMENT_ID
      || c.commitSha !== env.VERCEL_GIT_COMMIT_SHA) throw new Error();
    const publicKey = createPublicKey(env.S01_VERIFICATION_PUBLIC_KEY);
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error();
    if (typeof envelope.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)) throw new Error();
    const signature = Buffer.from(envelope.signature, 'base64url');
    if (signature.length !== 64 || signature.toString('base64url') !== envelope.signature
      || !verify(null, challengeTranscript(c), publicKey, signature)) throw new Error();
    const projectRef = projectFromEndpoint(env.SUPABASE_URL);
    if (projectRef !== c.projectRef || typeof env.SUPABASE_SERVICE_ROLE_KEY !== 'string'
      || !env.SUPABASE_SERVICE_ROLE_KEY.trim()) throw new Error();
    const endpoint = storeEndpoint(env.S01_NONCE_STORE_URL);
    const token = env.S01_NONCE_STORE_TOKEN;
    if (typeof token !== 'string' || !token.trim()) throw new Error();
    // No caller-selected URL/key, pipeline, fallback, or read-then-write race.
    // Retain the marker beyond expiry: crashes/lost replies burn the challenge.
    const response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', `s01:identity:v1:${c.deploymentId}:${c.nonce}`, 'consumed',
        'NX', 'EX', c.expiresAt - now + 30]),
    });
    if (!response.ok) return { status: 503, body: DENIAL };
    const result = await response.json();
    if (!result || Object.hasOwn(result, 'error')) return { status: 503, body: DENIAL };
    if (result.result === null) return { status: 409, body: DENIAL };
    if (result.result !== 'OK') return { status: 503, body: DENIAL };
    if (!validChallenge(c, Math.max(now, clock()))) return { status: 403, body: DENIAL };
    return { status: 200, body: {
      success: true, purpose: PURPOSE, deploymentId: c.deploymentId,
      commitSha: c.commitSha, projectRef, nonce: c.nonce, expiresAt: c.expiresAt,
      // One-time, authenticated challenge response, not a reusable key hash/token.
      proof: credentialProof(env.SUPABASE_SERVICE_ROLE_KEY, c, projectRef),
    } };
  } catch {
    // Never log exceptions, configuration, credentials, signatures or proof bodies.
    return { status: 403, body: DENIAL };
  }
}
