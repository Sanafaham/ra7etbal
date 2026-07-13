import { useCarsonStore } from "../../stores/carson";

/**
 * Floating pill shown above the bottom nav when Carson has an active session.
 * Tapping it re-opens the Carson sheet.
 */
export default function CarsonLivePill() {
  const setOpen = useCarsonStore((s) => s.setOpen);
  const channel = useCarsonStore((s) => s.channel);
  const isText = channel === "text";

  return (
    <div
      className="fixed inset-x-0 z-40 flex justify-center"
      style={{ bottom: "calc(env(safe-area-inset-bottom) + 60px)" }}
    >
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-full border border-sage/30 bg-white/95 px-4 py-2 shadow-lg backdrop-blur-sm transition hover:bg-cream active:scale-95"
        aria-label={isText ? "Carson chat is active — tap to open" : "Carson is listening — tap to open"}
      >
        {/* Animated dot */}
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sage opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-sage" />
        </span>
        <span className="text-[12px] font-medium text-ink/80">
          {isText ? "Carson chat is active" : "Carson is listening"}
        </span>
        <span className="text-[11px] text-ink/40">{isText ? "· Open" : "· End call"}</span>
      </button>
    </div>
  );
}
