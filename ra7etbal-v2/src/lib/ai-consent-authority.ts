export type AiProvider = "anthropic" | "elevenlabs" | "openai";
export type AiProviderCategory = "ai_model_provider";
export type AiInputMode = "text" | "voice" | "whatsapp" | "audio_upload" | "mixed" | "system" | "not_applicable";
export type AiDataCategory =
  | "user_text" | "conversation_history" | "carson_memory" | "people_data"
  | "task_data" | "reminder_data" | "delegation_data" | "calendar_data"
  | "image" | "file" | "audio" | "account_identifier" | "operational_context"
  | "staff_message" | "household_rules" | "weather_data" | "persistent_instructions";

export interface AiTransferRequirement {
  contractVersion: string;
  provider: AiProvider;
  providerCategory: AiProviderCategory;
  purpose: string;
  requiredDataCategories: readonly AiDataCategory[];
}

export interface AiConsentGrant {
  id: string;
  contractVersion: string;
  purpose: string;
  providerScopeKind: "provider" | "provider_category";
  providerScope: string;
  dataCategories: readonly AiDataCategory[];
  withdrawn: boolean;
  superseded: boolean;
}

export type AiAuthorityReason =
  | "authorized" | "malformed_requirement" | "missing_grant" | "wrong_provider"
  | "wrong_purpose" | "missing_data_category" | "withdrawn" | "superseded" | "stale_version";

export type AiAuthorityDecision =
  | { authorized: true; reason: "authorized"; grantEventId: string }
  | { authorized: false; reason: Exclude<AiAuthorityReason, "authorized">; grantEventId: null };

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,79}$/;

export function evaluateAiConsentAuthority(
  requirement: AiTransferRequirement,
  grants: readonly AiConsentGrant[],
): AiAuthorityDecision {
  const categories = [...new Set(requirement.requiredDataCategories)];
  if (!IDENTIFIER.test(requirement.contractVersion) || !IDENTIFIER.test(requirement.provider)
      || !IDENTIFIER.test(requirement.providerCategory) || !IDENTIFIER.test(requirement.purpose)
      || categories.length === 0 || categories.length > 32
      || categories.length !== requirement.requiredDataCategories.length
      || categories.some((value) => !IDENTIFIER.test(value))) {
    return { authorized: false, reason: "malformed_requirement", grantEventId: null };
  }
  if (grants.length === 0) return { authorized: false, reason: "missing_grant", grantEventId: null };
  const providerMatches = (grant: AiConsentGrant) =>
    grant.providerScopeKind === "provider"
      ? grant.providerScope === requirement.provider
      : grant.providerScope === requirement.providerCategory;
  const relevant = grants.filter(providerMatches);
  if (relevant.length === 0) return { authorized: false, reason: "wrong_provider", grantEventId: null };
  const purpose = relevant.filter((grant) => grant.purpose === requirement.purpose);
  if (purpose.length === 0) return { authorized: false, reason: "wrong_purpose", grantEventId: null };
  const version = purpose.filter((grant) => grant.contractVersion === requirement.contractVersion);
  if (version.length === 0) return { authorized: false, reason: "stale_version", grantEventId: null };
  const category = version.filter((grant) => categories.every((item) => grant.dataCategories.includes(item)));
  if (category.length === 0) return { authorized: false, reason: "missing_data_category", grantEventId: null };
  const current = category.find((grant) => !grant.withdrawn && !grant.superseded);
  if (current) return { authorized: true, reason: "authorized", grantEventId: current.id };
  if (category.some((grant) => grant.superseded)) return { authorized: false, reason: "superseded", grantEventId: null };
  if (category.some((grant) => grant.withdrawn)) return { authorized: false, reason: "withdrawn", grantEventId: null };
  return { authorized: false, reason: "missing_grant", grantEventId: null };
}
