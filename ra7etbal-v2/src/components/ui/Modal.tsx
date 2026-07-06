import { useEffect } from "react";
import { createPortal } from "react-dom";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Disable Escape + backdrop dismissal while a save is in-flight. */
  dismissable?: boolean;
  children: React.ReactNode;
}

/**
 * Mobile-first dismissable sheet. On phones it slides up from the bottom and
 * spans the full width; on tablets/desktop it's a centered card. Escape and
 * a backdrop click close it (unless `dismissable={false}`).
 *
 * iOS Safari hardening:
 *   1. Body scroll lock uses the position-fixed pattern (not overflow:hidden)
 *      — iOS respects this and won't trigger a reflow on keyboard open.
 *   2. Container sized with `h-dvh`, not `inset-0` (= 100vh). Dynamic
 *      viewport height shrinks when the keyboard appears so the panel stays
 *      anchored above it instead of being pushed off-screen.
 *   3. Panel is `max-h: calc(100dvh - 2rem)` with internal `overflow-y-auto`
 *      so tall content scrolls inside the modal — the page itself never moves.
 *   4. No auto-focus. iOS scrollIntoView from .focus() on a bottom-aligned
 *      element causes a visible jump on tap. Users tap their target directly.
 */
export default function Modal({
  open,
  onClose,
  title,
  dismissable = true,
  children,
}: Props) {
  useEffect(() => {
    if (!open) return;

    // iOS-safe body lock: position:fixed with the current scrollY pinned to
    // `top`. Visually the page doesn't move; iOS doesn't fight the modal.
    const scrollY = window.scrollY;
    const prev = {
      position: document.body.style.position,
      top: document.body.style.top,
      left: document.body.style.left,
      right: document.body.style.right,
      width: document.body.style.width,
    };
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.left = "0";
    document.body.style.right = "0";
    document.body.style.width = "100%";

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && dismissable) onClose();
    }
    window.addEventListener("keydown", onKey);

    return () => {
      document.body.style.position = prev.position;
      document.body.style.top = prev.top;
      document.body.style.left = prev.left;
      document.body.style.right = prev.right;
      document.body.style.width = prev.width;
      window.scrollTo(0, scrollY);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, dismissable, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-x-0 top-0 z-50 flex h-dvh items-end justify-center sm:items-center"
    >
      <button
        type="button"
        aria-label="Close dialog"
        onClick={() => dismissable && onClose()}
        className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
      />
      <div
        className="relative z-10 flex w-full max-w-md flex-col overflow-hidden rounded-t-3xl border border-border bg-cream shadow-xl sm:rounded-3xl"
        style={{ maxHeight: "calc(100dvh - 1rem)" }}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 pt-5 pb-3">
          <h2 style={{ fontFamily: "var(--font-display)" }} className="text-[22px] font-semibold text-ink">{title}</h2>
          {dismissable && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-1 rounded-full p-1 text-ink/60 transition hover:bg-ink/5 hover:text-ink"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M6 6l12 12M18 6L6 18"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
        </header>
        <div
          className="overflow-y-auto px-5 pt-4"
          // Respect iOS home-indicator safe area at the bottom of the inner
          // scroll area so the last button never sits under the bar.
          style={{ paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom))" }}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
