import { describe, expect, it } from "vitest";
import { evaluateAiConsentAuthority, type AiConsentGrant, type AiTransferRequirement } from "./ai-consent-authority";

const requirement: AiTransferRequirement = { contractVersion: "ai-v1", provider: "anthropic", providerCategory: "ai_model_provider", purpose: "carson_reasoning", requiredDataCategories: ["user_text", "carson_memory"] };
const grant: AiConsentGrant = { id: "grant-a", contractVersion: "ai-v1", purpose: "carson_reasoning", providerScopeKind: "provider", providerScope: "anthropic", dataCategories: ["user_text", "carson_memory"], withdrawn: false, superseded: false };

describe("AI consent authority evaluator", () => {
  it("denies missing authority and allows only an exact covering grant", () => {
    expect(evaluateAiConsentAuthority(requirement, [])).toEqual({ authorized: false, reason: "missing_grant", grantEventId: null });
    expect(evaluateAiConsentAuthority(requirement, [grant])).toEqual({ authorized: true, reason: "authorized", grantEventId: "grant-a" });
  });
  it.each([
    [{ ...grant, providerScope: "openai" }, "wrong_provider"],
    [{ ...grant, purpose: "audio_transcription" }, "wrong_purpose"],
    [{ ...grant, dataCategories: ["user_text"] }, "missing_data_category"],
    [{ ...grant, contractVersion: "ai-v0" }, "stale_version"],
    [{ ...grant, withdrawn: true }, "withdrawn"],
    [{ ...grant, superseded: true }, "superseded"],
  ] as const)("fails closed for %s", (candidate, reason) => {
    expect(evaluateAiConsentAuthority(requirement, [candidate])).toMatchObject({ authorized: false, reason });
  });
  it("supports provider-category grants without broadening data categories", () => {
    const categoryGrant = { ...grant, providerScopeKind: "provider_category" as const, providerScope: "ai_model_provider" };
    expect(evaluateAiConsentAuthority(requirement, [categoryGrant]).authorized).toBe(true);
    expect(evaluateAiConsentAuthority({ ...requirement, requiredDataCategories: ["user_text", "audio"] }, [categoryGrant])).toMatchObject({ authorized: false, reason: "missing_data_category" });
  });
  it("rejects malformed or empty requirements", () => {
    expect(evaluateAiConsentAuthority({ ...requirement, purpose: "BAD VALUE" }, [grant])).toMatchObject({ authorized: false, reason: "malformed_requirement" });
    expect(evaluateAiConsentAuthority({ ...requirement, requiredDataCategories: [] }, [grant])).toMatchObject({ authorized: false, reason: "malformed_requirement" });
    expect(evaluateAiConsentAuthority({ ...requirement, requiredDataCategories: ["user_text", "user_text"] }, [grant])).toMatchObject({ authorized: false, reason: "malformed_requirement" });
  });
  it("a new version requires its own explicit grant", () => {
    const next = { ...requirement, contractVersion: "ai-v2" };
    expect(evaluateAiConsentAuthority(next, [grant])).toMatchObject({ authorized: false, reason: "stale_version" });
    expect(evaluateAiConsentAuthority(next, [{ ...grant, id: "grant-b", contractVersion: "ai-v2" }]).authorized).toBe(true);
  });
  it("keeps OpenAI attention authority purpose- and category-scoped", () => {
    const attentionRequirement: AiTransferRequirement = {
      contractVersion: "ai-v1",
      provider: "openai",
      providerCategory: "ai_model_provider",
      purpose: "operational_attention_reasoning",
      requiredDataCategories: ["user_text", "task_data", "people_data", "operational_context"],
    };
    const attentionGrant: AiConsentGrant = {
      ...grant,
      id: "grant-openai-attention",
      providerScope: "openai",
      purpose: "operational_attention_reasoning",
      dataCategories: ["user_text", "task_data", "people_data", "operational_context"],
    };

    expect(evaluateAiConsentAuthority(attentionRequirement, [attentionGrant])).toEqual({
      authorized: true,
      reason: "authorized",
      grantEventId: "grant-openai-attention",
    });
    expect(evaluateAiConsentAuthority({ ...attentionRequirement, purpose: "audio_transcription" }, [attentionGrant])).toMatchObject({ authorized: false, reason: "wrong_purpose" });
    expect(evaluateAiConsentAuthority({ ...attentionRequirement, requiredDataCategories: [...attentionRequirement.requiredDataCategories, "audio"] }, [attentionGrant])).toMatchObject({ authorized: false, reason: "missing_data_category" });
    expect(evaluateAiConsentAuthority({ ...attentionRequirement, provider: "anthropic" }, [attentionGrant])).toMatchObject({ authorized: false, reason: "wrong_provider" });
  });
});
