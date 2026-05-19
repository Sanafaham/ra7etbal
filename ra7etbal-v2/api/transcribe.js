/**
 * /api/transcribe — Vercel serverless function.
 *
 * Accepts a multipart/form-data POST containing one audio file (form field
 * `file`) and forwards it to OpenAI's Whisper transcription endpoint. The
 * raw multipart body is streamed through unchanged — no parsing, no
 * re-encoding, no disk writes, no logging of audio bytes. Returns
 * `{ text: "..." }` on success.
 *
 * Privacy:
 *   - The audio bytes are held in memory only for the duration of the
 *     forward request, then released to GC.
 *   - We never persist, never log the body, never echo it back.
 *   - The OPENAI_API_KEY is server-only; never exposed to the browser.
 *
 * Limits:
 *   - Vercel default body limit is 4.5 MB. Client caps recording at 60s
 *     which keeps payloads well under that.
 *   - 25 s function timeout aligns with the Anthropic proxy.
 */

export const config = {
  api: {
    // We forward the raw multipart body to OpenAI as-is; Vercel must not
    // parse / mutate it.
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "Voice unavailable — OPENAI_API_KEY not configured on the server.",
    });
  }

  const contentType = req.headers["content-type"];
  if (!contentType || !contentType.toLowerCase().startsWith("multipart/form-data")) {
    return res.status(400).json({ error: "Expected multipart/form-data." });
  }

  // Read the raw multipart body into a single buffer. The browser's FormData
  // includes the boundary in the Content-Type header; we pass the same
  // header to OpenAI so it can parse the body unchanged.
  let buffer;
  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    buffer = Buffer.concat(chunks);
  } catch {
    return res.status(400).json({ error: "Could not read audio payload." });
  }

  if (buffer.length === 0) {
    return res.status(400).json({ error: "Empty audio payload." });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const upstream = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": contentType,
      },
      body: buffer,
      signal: controller.signal,
    });

    const data = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      const message =
        (data && data.error && data.error.message) ||
        "Transcription failed. Please try again.";
      return res.status(upstream.status).json({ error: message });
    }

    const text = (data && typeof data.text === "string") ? data.text.trim() : "";
    return res.status(200).json({ text });
  } catch (err) {
    if (err && err.name === "AbortError") {
      return res.status(504).json({ error: "Transcription timed out. Please try again." });
    }
    return res.status(500).json({ error: "Could not reach the transcription service." });
  } finally {
    clearTimeout(timeout);
  }
}
