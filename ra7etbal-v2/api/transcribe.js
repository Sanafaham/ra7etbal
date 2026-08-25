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

export async function requireUser(req) {
  const authHeader = req.headers?.authorization ?? req.headers?.Authorization ?? "";
  if (!authHeader.startsWith("Bearer ")) return { error: "Unauthorized" };

  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return { error: "Server configuration error." };

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: anonKey,
      Authorization: authHeader,
    },
  });
  if (!userRes.ok) return { error: "Unauthorized" };

  const user = await userRes.json().catch(() => null);
  return user?.id ? { uid: user.id } : { error: "Unauthorized" };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = await requireUser(req);
  if (auth.error) {
    return res.status(auth.error === "Unauthorized" ? 401 : 500).json({ error: auth.error });
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
      // Do not reflect provider payloads or implementation details to clients.
      const status = upstream.status >= 400 && upstream.status < 500 ? 400 : 502;
      return res.status(status).json({ error: "Transcription failed. Please try again." });
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
