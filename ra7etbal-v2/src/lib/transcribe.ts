/**
 * Client-side wrapper for /api/transcribe.
 *
 * Builds a FormData with the audio blob + the `whisper-1` model field and
 * POSTs it to our serverless function (which forwards to OpenAI). Returns
 * the trimmed transcript text. Throws an Error with a friendly message on
 * failure — callers display `err.message` as-is.
 */

export async function transcribeAudio(blob: Blob): Promise<string> {
  if (!blob || blob.size === 0) {
    throw new Error("No audio recorded.");
  }

  const filename = filenameForBlob(blob);
  const form = new FormData();
  form.append("file", blob, filename);
  form.append("model", "whisper-1");

  let res: Response;
  try {
    res = await fetch("/api/transcribe", {
      method: "POST",
      body: form,
    });
  } catch (err) {
    throw err instanceof TypeError
      ? new Error("Network issue. Please check your connection.")
      : err;
  }

  let body: { text?: string; error?: string };
  try {
    body = (await res.json()) as { text?: string; error?: string };
  } catch {
    throw new Error("Couldn't read the transcription response.");
  }

  if (!res.ok) {
    throw new Error(body.error || `Transcription failed (${res.status}).`);
  }

  const text = (body.text ?? "").trim();
  if (!text) throw new Error("Couldn't understand that. Try again.");
  return text;
}

/** Pick a sensible filename for the upload based on the blob's mime type. */
function filenameForBlob(blob: Blob): string {
  const type = (blob.type || "").toLowerCase();
  if (type.includes("mp4") || type.includes("m4a") || type.includes("aac")) return "voice.mp4";
  if (type.includes("webm")) return "voice.webm";
  if (type.includes("ogg")) return "voice.ogg";
  if (type.includes("wav")) return "voice.wav";
  if (type.includes("mp3") || type.includes("mpeg")) return "voice.mp3";
  // Whisper accepts m4a/mp3/mp4/webm/wav. Default to mp4 — iOS Safari's
  // most-common output and a common desktop fallback.
  return "voice.mp4";
}
