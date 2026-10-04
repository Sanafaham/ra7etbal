import { describe, expect, it } from "vitest";
import { AI_TRANSFER_MANIFESTS } from "./ai-transfer-manifests";

describe("AI transfer manifests", () => {
  it("covers every approved provider path family with unique static identifiers", () => {
    const values = Object.values(AI_TRANSFER_MANIFESTS);
    expect(values).toHaveLength(15);
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
});
