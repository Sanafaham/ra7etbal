import { useNavigate } from "react-router-dom";
import { signOut } from "../../lib/session";

interface Props {
  open: boolean;
  onClose: () => void;
  onSettings: () => void;
}

/**
 * More sheet — bottom sheet for secondary navigation.
 * Triggered by tapping the avatar/logo in the Home header.
 * Contains: People, Routines, Settings, Sign out.
 */
export default function MoreSheet({ open, onClose, onSettings }: Props) {
  const navigate = useNavigate();

  function nav(to: string) {
    onClose();
    navigate(to);
  }

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="More options"
        className="fixed inset-x-0 bottom-0 z-50 rounded-t-3xl bg-warm-white shadow-2xl"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 8px)" }}
      >
        {/* Drag handle */}
        <div className="flex justify-center pb-2 pt-3">
          <div className="h-1 w-10 rounded-full bg-ink/15" aria-hidden="true" />
        </div>

        <div className="px-4 pb-2">
          <ul className="divide-y divide-sage/10">
            <li>
              <button
                type="button"
                className="flex w-full items-center gap-4 py-4 text-left transition hover:bg-sage/5 active:bg-sage/10 rounded-xl px-2"
                onClick={() => nav("/people")}
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-sage/10">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                </span>
                <span className="text-base font-medium text-ink">People</span>
              </button>
            </li>
            <li>
              <button
                type="button"
                className="flex w-full items-center gap-4 py-4 text-left transition hover:bg-sage/5 active:bg-sage/10 rounded-xl px-2"
                onClick={() => nav("/routines")}
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-gold/15">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                </span>
                <span className="text-base font-medium text-ink">Routines</span>
              </button>
            </li>
            <li>
              <button
                type="button"
                className="flex w-full items-center gap-4 py-4 text-left transition hover:bg-sage/5 active:bg-sage/10 rounded-xl px-2"
                onClick={() => { onClose(); onSettings(); }}
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-stone/30">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M19.14 12.94a7.49 7.49 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.51 7.51 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.14.55-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.65 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.49 7.49 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.49.39 1.04.7 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54a7.51 7.51 0 0 0 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64Z" />
                    <circle cx="12" cy="12" r="2.6" />
                  </svg>
                </span>
                <span className="text-base font-medium text-ink">Settings</span>
              </button>
            </li>
            <li>
              <button
                type="button"
                className="flex w-full items-center gap-4 py-4 text-left transition hover:bg-rose-50 active:bg-rose-100 rounded-xl px-2"
                onClick={() => { onClose(); void signOut(); }}
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-rose-50">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <polyline points="16 17 21 12 16 7" />
                    <line x1="21" y1="12" x2="9" y2="12" />
                  </svg>
                </span>
                <span className="text-base font-medium text-rose-700">Sign out</span>
              </button>
            </li>
          </ul>
        </div>
      </div>
    </>
  );
}
