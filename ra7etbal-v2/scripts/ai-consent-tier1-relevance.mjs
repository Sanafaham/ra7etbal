#!/usr/bin/env node

export const AI_CONSENT_TIER1_PATH = /^(?:\.github\/workflows\/carson-tier1-db-contracts\.yml|ra7etbal-v2\/(?:carson-protected-registry\.json|scripts\/ai-consent-tier1-relevance(?:\.test)?\.mjs|supabase\/migrations\/(?:20261004120000_ai_consent_authority_foundation(?:\.rollback)?\.sql|verification\/ai_consent_authority_(?:bootstrap|verification|rollback_verification)\.sql)))$/;

export function hasAiConsentTier1Change(paths) {
  return paths.some((path) => AI_CONSENT_TIER1_PATH.test(path.trim()));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const paths = input.split(/\r?\n/).filter(Boolean);
    process.stdout.write(hasAiConsentTier1Change(paths) ? "true" : "false");
  });
}
