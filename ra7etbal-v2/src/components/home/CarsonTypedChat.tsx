import { useEffect, useRef, type FormEvent } from "react";
import type { CarsonTypedMessage } from "../../lib/carson-typed-messages";

interface Props {
  messages: CarsonTypedMessage[];
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onEnd: () => void;
  awaitingResponse: boolean;
  loadingHistory: boolean;
  error: string | null;
}

export default function CarsonTypedChat({
  messages,
  value,
  onChange,
  onSubmit,
  onEnd,
  awaitingResponse,
  loadingHistory,
  error,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length, awaitingResponse]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <div className="flex min-h-0 w-full max-w-xl flex-1 flex-col">
      <div
        className="min-h-0 flex-1 space-y-2 overflow-y-auto rounded-2xl border border-charcoal/10 bg-white/70 p-3"
        aria-live="polite"
        aria-label="Carson conversation"
      >
        {loadingHistory && (
          <p className="py-6 text-center text-[12px] text-ink/45">Loading conversation…</p>
        )}

        {!loadingHistory && messages.length === 0 && (
          <div className="px-3 py-8 text-center">
            <p className="text-[13px] font-medium text-ink/75">Type naturally to Carson.</p>
            <p className="mt-1 text-[12px] leading-relaxed text-ink/45">
              Ask about your day, create a reminder, delegate, or manage a To-do.
            </p>
          </div>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={message.role === "user" ? "flex justify-end" : "flex justify-start"}
          >
            <div
              className={
                "max-w-[86%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed " +
                (message.role === "user"
                  ? "rounded-br-md bg-charcoal text-white"
                  : "rounded-bl-md border border-charcoal/10 bg-warm-white text-ink/80")
              }
            >
              <p className="whitespace-pre-wrap break-words">{message.content}</p>
              {message.role === "user" &&
                (message.delivery_status === "interrupted" || message.delivery_status === "failed") && (
                  <p className="mt-1 text-[10px] text-white/65">
                    {message.delivery_status === "interrupted"
                      ? "Interrupted before Carson replied. It was not resent."
                      : "Not delivered."}
                  </p>
                )}
            </div>
          </div>
        ))}

        {awaitingResponse && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-md border border-charcoal/10 bg-warm-white px-3.5 py-2.5 text-[12px] text-ink/50">
              Carson is working…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && (
        <p className="mt-2 rounded-xl border border-danger/20 bg-danger/5 px-3 py-2 text-[11px] text-danger">
          {error}
        </p>
      )}

      <form onSubmit={handleSubmit} className="mt-3 flex items-end gap-2">
        <label className="sr-only" htmlFor="carson-typed-message">
          Message Carson
        </label>
        <textarea
          id="carson-typed-message"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={1}
          maxLength={12_000}
          disabled={awaitingResponse}
          placeholder="Message Carson…"
          className="max-h-32 min-h-11 flex-1 resize-none rounded-2xl border border-charcoal/15 bg-white px-3.5 py-3 text-[14px] text-ink outline-none transition placeholder:text-ink/35 focus:border-sage disabled:opacity-60"
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              value.trim()
            ) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        <button
          type="submit"
          disabled={awaitingResponse || !value.trim()}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-charcoal text-white shadow-sm transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-35"
          aria-label="Send message"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m22 2-7 20-4-9-9-4Z" />
            <path d="M22 2 11 13" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onEnd}
          className="h-11 shrink-0 rounded-full border border-charcoal/15 bg-white px-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink/55 transition active:scale-95"
        >
          End
        </button>
      </form>
    </div>
  );
}
