import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const widgetSource = readFileSync(
  join(__dirname, "../home/ElevenLabsAgentWidget.tsx"),
  "utf8",
);
const appSource = readFileSync(join(__dirname, "../../App.tsx"), "utf8");
const coreSource = readFileSync(join(__dirname, "CarsonVisualCore.tsx"), "utf8");
const ambientSource = readFileSync(join(__dirname, "CarsonAmbientBackground.tsx"), "utf8");
const settingsSource = readFileSync(join(__dirname, "../settings/SettingsModal.tsx"), "utf8");
const modalSource = readFileSync(join(__dirname, "../ui/Modal.tsx"), "utf8");
const moreSheetSource = readFileSync(join(__dirname, "../nav/MoreSheet.tsx"), "utf8");
const globalsSource = readFileSync(join(__dirname, "../../styles/globals.css"), "utf8");

describe("Carson V1 final presentation", () => {
  it("hides both live voice transcript surfaces without removing their stored state", () => {
    expect(widgetSource).toContain("const [lastCarsonMessage, setLastCarsonMessage]");
    expect(widgetSource).toContain("const [lastUserTranscript, setLastUserTranscript]");
    expect(widgetSource).toContain('channel === "voice" && status !== "connected" && lastUserTranscript');
    expect(widgetSource).toContain("shouldShowCarsonVoiceTranscript({");
  });

  it("uses the approved dark surface tokens whenever the finalized voice response is displayed", () => {
    expect(widgetSource).toContain("rounded-2xl border border-border bg-surface");
    expect(widgetSource).toContain("text-[12px] leading-relaxed text-ink");
    expect(widgetSource).not.toContain("text-[12px] leading-relaxed text-text-soft");
    expect(widgetSource).not.toContain("border border-charcoal/10 bg-white/90");
  });

  it("keeps the existing image input and live-session attachment path", () => {
    expect(widgetSource).toContain('accept="image/*"');
    expect(widgetSource).toContain("onChange={handleImageFileChange}");
    expect(widgetSource).toContain("pendingPhotoPreviews.map((photo, index)");
    expect(widgetSource).toContain("onClick={() => removePendingPhoto(photo.id)}");
    expect(widgetSource).toContain("imageFileInputRef.current?.click()");
  });

  it("uses the single text-free portrait asset for faint app and immersive voice layers", () => {
    expect(appSource.match(/carson-ambient-subject-v1\.png/g)).toHaveLength(1);
    expect(ambientSource.match(/carson-ambient-subject-v1\.png/g)).toHaveLength(1);
    expect(ambientSource).toContain('bg-cover bg-[center_18%]');
    expect(ambientSource).toContain('density === "content" ? "opacity-[0.15]" : "opacity-[0.26]"');
    expect(ambientSource).toContain('brightness-[0.78] contrast-[1.18] saturate-[1.08] sepia-[0.18]');
    expect(ambientSource).toContain('sm:bg-[center_14%]');
    expect(appSource).toContain('["/updates", "/active", "/inbox", "/actions", "/messages", "/notes", "/people", "/notifications", "/history"].includes(pathname)');
    expect(appSource).toContain('<CarsonAmbientBackground />');
    expect(appSource).toContain('opacity-[0.28]');
    expect(appSource).toContain('brightness-[0.92] contrast-[1.16] saturate-[0.72]');
    expect(appSource).toContain('md:bg-contain md:bg-center md:bg-no-repeat');
    expect(appSource).toContain('radial-gradient(ellipse_58%_50%_at_50%_32%');
    expect(appSource).toContain('carsonChannel === "voice"');
    expect(appSource).toContain('carsonOpen && (carsonCallStatus === "idle" || carsonCallStatus === "connecting")');
  });

  it("renders the approved ambient identity inside the complete Settings sheet", () => {
    expect(settingsSource).toContain('const settingsAmbientLayer = <CarsonAmbientBackground className="z-[1]" />');
    expect(settingsSource).not.toContain("bg-cream/24");
    expect(settingsSource).toContain("backgroundLayer={settingsAmbientLayer}");
    expect(settingsSource).toContain("<SettingsList");
    expect(settingsSource).toContain("<ConfirmPane");
    expect(modalSource).toContain("{backgroundLayer}");
    expect(modalSource).toContain('backgroundLayer ? "carson-light-sheet-surface" : "bg-cream"');
    expect(modalSource).toContain('className="relative z-10 overflow-y-auto px-5 pt-4"');
  });

  it("places the approved portrait inside the dark pre-connect Core card", () => {
    expect(coreSource).not.toContain('src="/carson-ambient-subject-v1.png"');
    expect(coreSource).toContain('radial-gradient(ellipse_42%_90%_at_50%_45%');
    expect(coreSource).toContain('minSide * (immersive ? 0.25 : 0.19)');
    expect(coreSource).toContain('mt-[10px] h-[100px]');
    expect(coreSource).toContain('md:mt-[clamp(260px,30dvh,340px)]');
  });

  it("renders Carson directly inside the actual Settings and Sign out sheet", () => {
    expect(moreSheetSource).toContain('aria-label="More options"');
    expect(moreSheetSource).toContain('<CarsonAmbientBackground />');
    expect(moreSheetSource).toContain('carson-light-sheet-surface fixed inset-0');
    expect(moreSheetSource).not.toContain('fixed inset-x-0 bottom-0');
    expect(moreSheetSource).toContain('relative z-10 px-4 pb-2');
  });

  it("keeps the preview card mounted through idle channel changes and Opening Carson", () => {
    expect(widgetSource).toContain('(status === "idle" || status === "connecting" || channel === "voice")');
    expect(widgetSource).toContain('"mb-3 mt-20 w-full px-3 sm:px-5"');
    expect(widgetSource).toContain('immersive={status !== "idle" && channel === "voice"}');
  });

  it("uses the shared clean ivory tokens across app light surfaces", () => {
    expect(globalsSource).toContain("--color-cream: #151310;");
    expect(globalsSource).toContain("--color-warm-white: #26221E;");
    expect(globalsSource).toContain(".carson-light-sheet-surface");
    expect(globalsSource).toContain("background: rgba(21, 19, 16, 0.992)");
    expect(globalsSource).toContain("isolation: isolate");
    expect(ambientSource).toContain('pointer-events-none ${fixed ? "fixed" : "absolute"}');
    expect(appSource).toContain('top: carsonCallStatus === "idle" ? "0"');
    expect(appSource).not.toContain('carsonCallStatus === "idle" ? "48dvh"');
  });

  it("keeps the immersive state pill attached to the Visual Core", () => {
    expect(coreSource).toContain('mt-[clamp(148px,19dvh,176px)] h-[clamp(280px,40dvh,360px)]');
    expect(coreSource).toContain('minSide * (immersive ? 0.25 : 0.19)');
    expect(coreSource).toContain('visualState === "speaking"');
    expect(coreSource).toContain('visualState === "listening"');
    expect(coreSource).toContain('visualState === "thinking"');
    expect(coreSource).toContain('0.34 + smoothedEnergy * 0.22');
    expect(coreSource).toContain('0.3 + smoothedEnergy * 0.12');
    expect(coreSource).toContain('radial-gradient(ellipse_42%_90%_at_50%_45%');
    expect(widgetSource).toContain('<span className="sr-only">');
    expect(widgetSource).not.toContain('className="truncate text-[11px] font-semibold uppercase tracking-[0.16em]"');
  });
});
