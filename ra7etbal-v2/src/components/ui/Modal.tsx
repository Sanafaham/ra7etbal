import { useEffect, useRef } from "react";
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
 * a backdrop click close it (unless `dismissable={false}`). Background scroll
 * is locked while open.
 */
export default function Modal({
  open,
  onClose,
  title,
  dismissable = true,
  children,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && dismissable) onClose();
    }
    window.addEventListener("keydown", onKey);

    // Focus the first focusable inside the panel.
    queueMicrotask(() => {
      const focusable = panelRef.current?.querySelector<HTMLElement>(
        'input, textarea, select, button, [tabindex]:not([tabindex="-1"])',
      );
      focusable?.focus();
    });

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, dismissable, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
    >
      <button
        type="button"
        aria-label="Close dialog"
        onClick={() => dismissable && onClose()}
        className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        className="relative z-10 w-full max-w-md rounded-t-3xl border border-sage/30 bg-cream p-5 shadow-xl sm:rounded-3xl"
        // Respect iOS home indicator safe area when sheet pins to bottom.
        style={{ paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom))" }}
      >
        <header className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold text-ink">{title}</h2>
          {dismissable && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-full p-1 text-ink/60 transition hover:bg-ink/5 hover:text-ink"
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
        {children}
      </div>
    </div>,
    document.body,
  );
}
