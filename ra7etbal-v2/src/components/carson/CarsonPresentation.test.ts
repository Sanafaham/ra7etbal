import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const widgetSource = readFileSync(
  join(__dirname, "../home/ElevenLabsAgentWidget.tsx"),
  "utf8",
);
const appSource = readFileSync(join(__dirname, "../../App.tsx"), "utf8");

describe("Carson V1 final presentation", () => {
  it("hides both live voice transcript surfaces without removing their stored state", () => {
    expect(widgetSource).toContain("const [lastCarsonMessage, setLastCarsonMessage]");
    expect(widgetSource).toContain("const [lastUserTranscript, setLastUserTranscript]");
    expect(widgetSource).toContain('channel === "voice" && status !== "connected" && lastUserTranscript');
    expect(widgetSource).toContain("shouldShowCarsonVoiceTranscript({");
  });

  it("keeps the existing image input and live-session attachment path", () => {
    expect(widgetSource).toContain('accept="image/*"');
    expect(widgetSource).toContain("onChange={handleImageFileChange}");
    expect(widgetSource).toContain("pendingPhotoPreviews.map((photo, index)");
    expect(widgetSource).toContain("onClick={() => removePendingPhoto(photo.id)}");
    expect(widgetSource).toContain("imageFileInputRef.current?.click()");
  });

  it("uses the single text-free portrait asset for faint app and immersive voice layers", () => {
    expect(appSource.match(/carson-ambient-portrait-v1\.jpg/g)).toHaveLength(2);
    expect(appSource).toContain('opacity-[0.06]');
    expect(appSource).toContain('opacity-[0.16]');
    expect(appSource).toContain('carsonChannel === "voice"');
  });
});
