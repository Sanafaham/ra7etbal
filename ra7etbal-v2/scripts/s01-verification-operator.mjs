import { randomBytes, sign, timingSafeEqual } from 'node:crypto';
import { PURPOSE, challengeTranscript, credentialProof } from '../api/_s01-deployment-verification.js';

// Library only: no CLI output, credential loading, network, or filesystem access.
// The caller must acquire the canonical key from project-specific Supabase admin
// evidence. Equality alone does not assert issuer provenance or key privilege.
export function createOperatorChallenge({ privateKey, deploymentId, commitSha, projectRef, now = Math.floor(Date.now() / 1000) }) {
  const challenge = { purpose: PURPOSE, nonce: randomBytes(32).toString('base64url'),
    issuedAt: now, expiresAt: now + 60, deploymentId, commitSha, projectRef };
  const signature = sign(null, challengeTranscript(challenge), privateKey).toString('base64url');
  let consumed = false;
  return {
    request: { s01Verification: { challenge, signature } },
    compare(proof, { canonicalKey, adminProjectRef, adminPrivilege, now: checkedAt = Math.floor(Date.now() / 1000) }) {
      if (consumed) return false;
      consumed = true; // Even a bad/missing response requires a fresh challenge.
      if (checkedAt < challenge.issuedAt || checkedAt >= challenge.expiresAt
        || adminProjectRef !== projectRef || !['service_role', 'secret'].includes(adminPrivilege)
        || typeof canonicalKey !== 'string' || !canonicalKey
        || !proof || proof.success !== true || proof.purpose !== PURPOSE
        || proof.deploymentId !== deploymentId || proof.commitSha !== commitSha
        || proof.projectRef !== projectRef || proof.nonce !== challenge.nonce
        || proof.expiresAt !== challenge.expiresAt || typeof proof.proof !== 'string'
        || !/^[a-f0-9]{64}$/.test(proof.proof)) return false;
      return timingSafeEqual(Buffer.from(proof.proof, 'hex'), Buffer.from(credentialProof(canonicalKey, challenge, projectRef), 'hex'));
    },
  };
}
