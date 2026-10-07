import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AI_TRANSFER_MANIFESTS } from "./ai-transfer-manifests";

const readSource = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("AI transfer manifests", () => {
  it("covers every approved provider path family with unique static identifiers", () => {
    const values = Object.values(AI_TRANSFER_MANIFESTS);
    expect(values).toHaveLength(16);
    expect(new Set(values.map((value) => value.id)).size).toBe(values.length);
    expect(new Set(values.map((value) => value.provider))).toEqual(new Set(["anthropic", "elevenlabs", "openai"]));
  });
  it("keeps typed and voice Carson under the same purpose while audio stays explicit", () => {
    expect(AI_TRANSFER_MANIFESTS.elevenlabsTypedCarson.purpose).toBe(AI_TRANSFER_MANIFESTS.elevenlabsVoiceCarson.purpose);
    expect(AI_TRANSFER_MANIFESTS.elevenlabsTypedCarson.possibleDataCategories).not.toContain("audio");
    expect(AI_TRANSFER_MANIFESTS.elevenlabsVoiceCarson.possibleDataCategories).toContain("audio");
  });
  it("marks every raw image/audio path and no text-only path as raw bytes", () => {
    const raw = Object.values(AI_TRANSFER_MANIFESTS).filter((value) => value.rawBytesMayLeave).map((value) => value.id);
    expect(raw).toEqual(expect.arrayContaining(["anthropic.proof_photo", "anthropic.owner_whatsapp_image", "elevenlabs.voice_carson", "openai.audio_transcription"]));
  });
  it("keeps OpenAI transcription and attention as distinct least-authority call families", () => {
    expect(AI_TRANSFER_MANIFESTS.openaiAudioTranscription).toEqual({
      id: "openai.audio_transcription",
      provider: "openai",
      purpose: "audio_transcription",
      possibleDataCategories: ["audio"],
      inputModes: ["audio_upload"],
      rawBytesMayLeave: true,
      conversationContextMayBeIncluded: false,
      memoryMayBeIncluded: false,
    });
    expect(AI_TRANSFER_MANIFESTS.openaiAttentionReasoning).toEqual({
      id: "openai.attention_reasoning",
      provider: "openai",
      purpose: "operational_attention_reasoning",
      possibleDataCategories: [
        "user_text",
        "task_data",
        "reminder_data",
        "delegation_data",
        "people_data",
        "operational_context",
      ],
      inputModes: ["text"],
      rawBytesMayLeave: false,
      conversationContextMayBeIncluded: false,
      memoryMayBeIncluded: false,
    });
    expect(AI_TRANSFER_MANIFESTS.openaiAttentionReasoning.possibleDataCategories).not.toEqual(
      expect.arrayContaining(["audio", "image", "file", "conversation_history", "carson_memory"]),
    );
  });
  it("binds the flag-gated OpenAI attention source family to a static manifest", () => {
    const routeSource = readSource("../../api/carson-turn.js");
    const agentSource = readSource("../../api/_carson-attention-agent.js");

    expect(routeSource).toContain('process.env.CARSON_OPENAI_AGENT_ATTENTION_V1 === "1"');
    expect(routeSource).toContain("createAttentionAgentCoordinator");
    expect(agentSource).toContain('export const DEFAULT_ATTENTION_AGENT_MODEL = "gpt-5.6-sol"');
    expect(agentSource).toContain("result = await runAgent(agent, ownerTurn.transcript)");
    expect(agentSource).toContain("assignee: item.assignee");
    expect(AI_TRANSFER_MANIFESTS.openaiAttentionReasoning.id).toBe("openai.attention_reasoning");
  });
  it("does not add consent authority evaluation to either OpenAI runtime path", () => {
    const sources = [
      readSource("../../api/carson-turn.js"),
      readSource("../../api/_carson-attention-agent.js"),
      readSource("../../api/transcribe.js"),
    ];

    for (const source of sources) {
      expect(source).not.toContain("evaluateAiConsentAuthority");
      expect(source).not.toContain("ai-consent-authority");
    }
  });
});
