import { useId, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAuth } from "../hooks/useAuth";
import { useDraftStore } from "../stores/draft";

/**
 * Home / Clear My Head — the entry surface for offloading thoughts.
 *
 * Step 6 scope: date header + greeting + freeform textarea + char count.
 * The text is held in `useDraftStore` so it survives in-app navigation but
 * NOT refresh (it's an unsaved draft). AI extraction, the "Next" action,
 * and voice input are deferred to their own steps so we don't ship stubs.
 */
export default function Home() {
  const { user } = useAuth();
  const textareaId = useId();

  const { text, setText } = useDraftStore(
    useShallow((s) => ({ text: s.text, setText: s.setText })),
  );

  const today = useMemo(() => {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(new Date());
  }, []);

  const greetingName = useMemo(() => {
    if (!user?.email) return null;
    // Use the part before "@" as a light personal touch; users can adjust their
    // display later when a profile screen exists.
    const local = user.email.split("@")[0] ?? "";
    if (!local) return null;
    return local.charAt(0).toUpperCase() + local.slice(1);
  }, [user?.email]);

  const charCount = text.length;
  const wordCount = useMemo(() => {
    const trimmed = text.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }, [text]);

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-ink/50">
          {today}
        </p>
        <h1 className="text-2xl font-semibold text-ink">
          {greetingName ? `Hi ${greetingName}.` : "Welcome."}
        </h1>
        <p className="text-sm text-ink/60">
          What's on your mind? Type it the way you'd say it — Ra7etBal will sort
          it out next.
        </p>
      </header>

      <div className="rounded-2xl border border-sage/30 bg-white/80 p-4 shadow-sm sm:p-5">
        <label htmlFor={textareaId} className="sr-only">
          Clear my head
        </label>
        <textarea
          id={textareaId}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Tell Christopher dinner is at 9. Ask Ghulam to drop Loulya at school. Order more rice."
          autoComplete="off"
          spellCheck
          rows={8}
          // `field-sizing: content` is supported on iOS 17+ / modern Chrome and
          // makes the box grow with content. Browsers without it fall back to
          // the `rows` height + native scroll.
          style={{ fieldSizing: "content" } as React.CSSProperties}
          className="block min-h-[180px] w-full resize-y rounded-xl bg-transparent text-base leading-relaxed text-ink outline-none placeholder:text-ink/35 focus:outline-none"
        />

        <div className="mt-3 flex items-center justify-between border-t border-sage/15 pt-3 text-xs text-ink/55">
          <span>
            {wordCount} {wordCount === 1 ? "word" : "words"}
          </span>
          <span aria-live="polite">{charCount} characters</span>
        </div>
      </div>

      <p className="text-xs text-ink/45">
        Your draft stays on this device only and is cleared when you sign out.
      </p>
    </section>
  );
}
