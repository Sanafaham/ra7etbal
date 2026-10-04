import { describe, expect, it } from "vitest";
import { hasAiConsentTier1Change } from "./ai-consent-tier1-relevance.mjs";

describe("required Tier-1 AI-consent DB-contract routing", () => {
  it.each([
    "ra7etbal-v2/supabase/migrations/20261004120000_ai_consent_authority_foundation.sql",
    "ra7etbal-v2/supabase/migrations/20261004120000_ai_consent_authority_foundation.rollback.sql",
    "ra7etbal-v2/supabase/migrations/verification/ai_consent_authority_bootstrap.sql",
    "ra7etbal-v2/supabase/migrations/verification/ai_consent_authority_verification.sql",
    "ra7etbal-v2/supabase/migrations/verification/ai_consent_authority_rollback_verification.sql",
    "ra7etbal-v2/carson-protected-registry.json",
    ".github/workflows/carson-tier1-db-contracts.yml",
    "ra7etbal-v2/scripts/ai-consent-tier1-relevance.mjs",
  ])("routes %s through the required real-Postgres proof", (path) => {
    expect(hasAiConsentTier1Change([path])).toBe(true);
  });

  it("does not run the consent database proof for unrelated frontend-only changes", () => {
    expect(hasAiConsentTier1Change(["ra7etbal-v2/src/routes/Home.tsx"])).toBe(false);
  });
});
