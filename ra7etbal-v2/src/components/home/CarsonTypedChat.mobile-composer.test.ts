import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(__dirname, "CarsonTypedChat.tsx"), "utf8");

describe("Type to Carson mobile composer", () => {
  it("auto-grows from its content and scrolls internally only after its CSS maximum", () => {
    expect(SOURCE).toContain("const textareaRef = useRef<HTMLTextAreaElement>(null)");
    expect(SOURCE).toContain("useLayoutEffect(() => {");
    expect(SOURCE).toContain('textarea.style.height = "auto"');
    expect(SOURCE).toContain("Math.min(textarea.scrollHeight, maxHeight)");
    expect(SOURCE).toContain('textarea.style.overflowY = Number.isFinite(maxHeight) && textarea.scrollHeight > maxHeight');
    expect(SOURCE).toContain("}, [value]);");
  });

  it("provides a readable multi-line mobile entry area without triggering iOS focus zoom", () => {
    expect(SOURCE).toContain("min-h-[3.25rem] max-h-[11rem]");
    expect(SOURCE).toContain("min-w-0 flex-1 resize-none overflow-y-hidden");
    expect(SOURCE).toContain("px-3.5 py-3 text-base leading-6 text-ink");
    expect(SOURCE).not.toContain("text-[14px] text-ink");
  });

  it("keeps the focused composer visible as the iPhone visual viewport changes", () => {
    expect(SOURCE).toContain("const viewport = window.visualViewport");
    expect(SOURCE).toContain('viewport.addEventListener("resize", keepFocusedComposerVisible)');
    expect(SOURCE).toContain('viewport.addEventListener("scroll", keepFocusedComposerVisible)');
    expect(SOURCE).toContain('scrollIntoView({ block: "nearest" })');
    expect(SOURCE).toContain('viewport.removeEventListener("resize", keepFocusedComposerVisible)');
    expect(SOURCE).toContain('viewport.removeEventListener("scroll", keepFocusedComposerVisible)');
  });

  it("preserves the attachment, submit, and End controls around the shared textarea", () => {
    expect(SOURCE).toContain('aria-label={photoLimitReached ? photoLimitMessage : "Attach photo to typed Carson message"}');
    expect(SOURCE).toContain('aria-label="Send message"');
    expect(SOURCE).toContain("onClick={onEnd}");
    expect(SOURCE).toContain("onChange={(event) => onChange(event.target.value)}");
    expect(SOURCE).toContain("maxLength={12_000}");
  });
});
