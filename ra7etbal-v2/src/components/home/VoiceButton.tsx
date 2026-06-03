import { useCallback, useEffect, useRef, useState } from "react";
import Spinner from "../Spinner";
import { transcribeAudio } from "../../lib/transcribe";

interface Props {
  /** Called once with the transcribed text after the user stops recording. */
  onTranscript: (text: string) => void;
  /** Surface an error message to the parent (Home renders the notice). */
  onError: (message: string) => void;
  /** Hide / disable the button while extraction is running. */
  disabled?: boolean;
  /** Hard cap on recording length, in seconds. */
  maxSeconds?: number;
}

type Mode = "idle" | "recording" | "processing";

/**
 * Microphone button.
 *
 * Tap once to start recording, tap again to stop and transcribe via
 * /api/transcribe (OpenAI Whisper). On success the parent receives the
 * transcript via `onTranscript`. Audio bytes never persist anywhere.
 *
 * Hidden on browsers without MediaRecorder so the keyboard path still works.
 */
export default function VoiceButton({
  onTranscript,
  onError,
  disabled = false,
  maxSeconds = 60,
}: Props) {
  const supported =
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices &&
    !!navigator.mediaDevices.getUserMedia;

  const [mode, setMode] = useState<Mode>("idle");
  const [elapsed, setElapsed] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);

  /** Release everything we hold — mic stream, recorder, timer. */
  const teardown = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  // Always tear down on unmount — even if recording is in flight.
  useEffect(() => {
    return () => teardown();
  }, [teardown]);

  async function startRecording() {
    if (disabled || mode !== "idle") return;
    chunksRef.current = [];
    setElapsed(0);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.addEventListener("dataavailable", (e: BlobEvent) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      });
      recorder.addEventListener("stop", () => {
        void finalize();
      });
      recorder.addEventListener("error", () => {
        teardown();
        setMode("idle");
        onError("Recording failed. Please try again.");
      });

      recorder.start();
      setMode("recording");
      startTimeRef.current = Date.now();
      timerRef.current = window.setInterval(() => {
        const sec = Math.floor((Date.now() - startTimeRef.current) / 1000);
        setElapsed(sec);
        if (sec >= maxSeconds) {
          // Auto-stop at the cap. The stop handler kicks off finalize().
          stopIfRecording();
        }
      }, 250);
    } catch (err) {
      teardown();
      setMode("idle");
      onError(messageForGetUserMediaError(err));
    }
  }

  function stopIfRecording() {
    if (recorderRef.current && recorderRef.current.state === "recording") {
      // dataavailable + stop events fire after this. finalize() runs in stop.
      try {
        recorderRef.current.stop();
      } catch {
        teardown();
        setMode("idle");
        onError("Recording failed. Please try again.");
      }
    }
  }

  async function finalize() {
    // Snapshot what the recorder produced, then release resources.
    const mimeType =
      (recorderRef.current && recorderRef.current.mimeType) ||
      (chunksRef.current[0] as Blob | undefined)?.type ||
      "audio/mp4";
    const blob = new Blob(chunksRef.current, { type: mimeType });
    teardown();

    if (blob.size === 0) {
      setMode("idle");
      setElapsed(0);
      onError("Couldn't hear anything. Try again.");
      return;
    }

    setMode("processing");
    try {
      const text = await transcribeAudio(blob);
      onTranscript(text);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Transcription failed.");
    } finally {
      setMode("idle");
      setElapsed(0);
    }
  }

  function handleTap() {
    if (mode === "idle") {
      void startRecording();
      return;
    }
    if (mode === "recording") {
      stopIfRecording();
      return;
    }
    // mode === "processing": ignore taps while uploading.
  }

  if (!supported) return null;

  const label =
    mode === "recording"
      ? `Stop (${formatElapsed(elapsed)})`
      : mode === "processing"
        ? "Transcribing…"
        : "Voice";

  const ariaLabel =
    mode === "recording"
      ? "Stop recording"
      : mode === "processing"
        ? "Transcribing"
        : "Record Dictate note";

  const baseCls =
    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50";
  const stateCls =
    mode === "recording"
      ? "border-rose-300 bg-rose-50 text-rose-800"
      : mode === "processing"
        ? "border-sage/30 bg-white text-ink/70"
        : "border-sage/30 bg-white text-ink hover:bg-cream";

  return (
    <button
      type="button"
      onClick={handleTap}
      disabled={disabled || mode === "processing"}
      aria-label={ariaLabel}
      aria-pressed={mode === "recording"}
      className={baseCls + " " + stateCls}
    >
      {mode === "processing" ? (
        <Spinner size={12} />
      ) : mode === "recording" ? (
        // Pulsing red dot.
        <span className="relative inline-flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500 opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-600" />
        </span>
      ) : (
        // Microphone glyph.
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"
            stroke="currentColor"
            strokeWidth="1.7"
          />
          <path
            d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </svg>
      )}
      <span>{label}</span>
    </button>
  );
}

function formatElapsed(s: number): string {
  const mm = Math.floor(s / 60)
    .toString()
    .padStart(1, "0");
  const ss = (s % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

function messageForGetUserMediaError(err: unknown): string {
  if (err && typeof err === "object" && "name" in err) {
    const name = (err as { name?: string }).name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      return "Microphone access denied. Allow it in your browser settings to record.";
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      return "No microphone found.";
    }
    if (name === "NotReadableError") {
      return "Microphone is in use by another app.";
    }
  }
  return "Couldn't start the microphone. Please try again.";
}
