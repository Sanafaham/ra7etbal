import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CarsonTypedMessage } from "../../lib/carson-typed-messages";

interface TypedPhotoPreview {
  id: string;
  previewUrl: string;
  name: string;
}

interface Props {
  messages: CarsonTypedMessage[];
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onEnd: () => void;
  awaitingResponse: boolean;
  loadingHistory: boolean;
  error: string | null;
  photos: TypedPhotoPreview[];
  onAttachPhoto: () => void;
  onRemovePhoto: (id: string) => void;
  photoLimitReached: boolean;
  photoLimitMessage: string;
  clearingHistory: boolean;
  onClearHistory: () => void;
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
  photos,
  onAttachPhoto,
  onRemovePhoto,
  photoLimitReached,
  photoLimitMessage,
  clearingHistory,
  onClearHistory,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length, awaitingResponse]);

  useEffect(() => {
    if (messages.length === 0) setConfirmingClear(false);
  }, [messages.length]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <div className="flex min-h-0 w-full max-w-xl flex-1 flex-col pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
      {messages.length > 0 && (
        <div className="mb-2 flex min-h-8 items-center justify-end gap-2 px-1">
          {confirmingClear ? (
            <>
              <span className="mr-auto text-[11px] text-ink/55">
                Delete saved typed messages? Tasks and memory stay.
              </span>
              <button
                type="button"
                onClick={() => setConfirmingClear(false)}
                disabled={clearingHistory}
                className="rounded-full px-2.5 py-1.5 text-[11px] font-medium text-ink/55 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onClearHistory}
                disabled={clearingHistory || awaitingResponse}
                className="rounded-full border border-danger/25 bg-danger/5 px-2.5 py-1.5 text-[11px] font-semibold text-danger disabled:opacity-50"
              >
                {clearingHistory ? "Clearing…" : "Delete chat"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingClear(true)}
              disabled={awaitingResponse || clearingHistory}
              className="rounded-full px-2.5 py-1.5 text-[11px] font-medium text-ink/45 transition hover:bg-charcoal/5 hover:text-ink/70 disabled:opacity-40"
            >
              Clear chat
            </button>
          )}
        </div>
      )}

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

      {photos.length > 0 && (
        <div className="mt-2 rounded-2xl border border-border bg-white/90 px-2.5 py-2">
          <div className="flex items-center gap-2 overflow-x-auto">
            {photos.map((photo, index) => (
              <div key={photo.id} className="relative shrink-0">
                <img
                  src={photo.previewUrl}
                  alt={`Attached photo ${index + 1}: ${photo.name}`}
                  className="h-12 w-12 rounded-lg border border-border object-cover"
                />
                <button
                  type="button"
                  onClick={() => onRemovePhoto(photo.id)}
                  disabled={awaitingResponse}
                  aria-label={`Remove attached photo ${index + 1}`}
                  className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-ink/75 text-white shadow disabled:opacity-45"
                >
                  <svg width="7" height="7" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                    <line x1="1" y1="1" x2="9" y2="9" /><line x1="9" y1="1" x2="1" y2="9" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-ink/50">
            {photos.length} photo{photos.length === 1 ? "" : "s"} attached to this Carson session.
          </p>
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="sticky bottom-0 z-10 mt-3 flex items-end gap-2 bg-warm-white/95 pb-1 pt-2 backdrop-blur"
      >
        <button
          type="button"
          onClick={onAttachPhoto}
          disabled={awaitingResponse || photoLimitReached}
          aria-label={photoLimitReached ? photoLimitMessage : "Attach photo to typed Carson message"}
          title={photoLimitReached ? photoLimitMessage : "Attach photo"}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-charcoal/15 bg-white text-ink/55 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-35"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        </button>
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
