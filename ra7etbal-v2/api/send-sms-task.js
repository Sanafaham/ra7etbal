/**
 * POST /api/send-sms-task
 *
 * SMS fallback delivery via Twilio Messages API.
 * Only called when WhatsApp delivery fails and SMS_FALLBACK_ENABLED=true.
 *
 * Body: { to: string, body: string, recipientName?: string }
 * Auth: None required — called only from server-side delivery layer (VITE env flag
 *       gates the client; the route itself validates required env vars).
 *
 * Required env vars:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_FROM_NUMBER   — E.164 format, e.g. +1xxxxxxxxxx
 *   SMS_FALLBACK_ENABLED — must be "true" to accept requests
 */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const smsFallbackEnabled = process.env.SMS_FALLBACK_ENABLED === "true";
  if (!smsFallbackEnabled) {
    return res.status(503).json({ success: false, error: "SMS fallback is not enabled." });
  }

  const accountSid  = process.env.TWILIO_ACCOUNT_SID;
  const authToken   = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber  = process.env.TWILIO_FROM_NUMBER;

  const missing = [];
  if (!accountSid)  missing.push("TWILIO_ACCOUNT_SID");
  if (!authToken)   missing.push("TWILIO_AUTH_TOKEN");
  if (!fromNumber)  missing.push("TWILIO_FROM_NUMBER");
  if (missing.length > 0) {
    console.error(`[send-sms-task] missing env: ${missing.join(", ")}`);
    return res.status(500).json({ success: false, error: `Missing config: ${missing.join(", ")}` });
  }

  const { to, body, recipientName } = req.body ?? {};

  if (!to || typeof to !== "string") {
    return res.status(400).json({ success: false, error: "'to' is required." });
  }
  if (!body || typeof body !== "string" || !body.trim()) {
    return res.status(400).json({ success: false, error: "'body' is required." });
  }

  const normalizedTo = normalizeSmsPhone(to);
  if (!normalizedTo) {
    return res.status(400).json({ success: false, error: `Invalid phone number: ${to}` });
  }

  const requestId = Math.random().toString(36).slice(2, 8);
  console.log(`[send-sms-task][${requestId}] to=${normalizedTo} recipient=${recipientName ?? "unknown"}`);

  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

  const formBody = new URLSearchParams({
    From: fromNumber,
    To:   normalizedTo,
    Body: body.trim(),
  });

  const twilioRes = await fetch(twilioUrl, {
    method:  "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formBody.toString(),
  });

  const data = await twilioRes.json().catch(() => null);

  if (!twilioRes.ok) {
    const detail = data?.message ?? data?.error_message ?? `Twilio error ${twilioRes.status}`;
    console.error(`[send-sms-task][${requestId}] Twilio error ${twilioRes.status}: ${detail}`);
    return res.status(502).json({ success: false, error: detail });
  }

  console.log(`[send-sms-task][${requestId}] sent OK sid=${data?.sid}`);
  return res.status(200).json({ success: true, sid: data?.sid });
}

function normalizeSmsPhone(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  // Already E.164
  if (/^\+\d{7,15}$/.test(trimmed)) return trimmed;
  // Strip everything except digits
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length < 7) return null;
  // Assume international if 10+ digits
  return `+${digits}`;
}
