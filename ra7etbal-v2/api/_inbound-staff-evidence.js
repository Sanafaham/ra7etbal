const MAX_INBOUND_IMAGE_BYTES = 10 * 1024 * 1024;
// Quality Intelligence's protected image loader currently submits proof bytes
// to Anthropic as image/jpeg. Fail closed for other formats rather than
// persisting bytes that would later be reviewed under the wrong media type.
const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg']);

function imageExtension() { return '.jpg'; }

function safeMessageKey(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
}

function isJpeg(bytes) {
  return bytes.length >= 4 &&
    bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
}

/**
 * WhatsApp is only a transport here: resolve the Meta media object and
 * persist the original bytes in the existing task-images proof namespace.
 * Task state and Quality Intelligence remain owned by task-confirm.js.
 */
export async function persistInboundStaffImage(
  { mediaId, mimeType, userId, taskId, messageId, accessToken, supabaseUrl, serviceKey },
  { fetchImpl = fetch } = {},
) {
  const claimedMimeType = String(mimeType || '').toLowerCase();
  if (!mediaId || !userId || !taskId || !messageId) {
    return { ok: false, reason: 'missing_media_context' };
  }
  if (!SUPPORTED_IMAGE_TYPES.has(claimedMimeType)) {
    return { ok: false, reason: 'unsupported_media_type' };
  }

  const metadataResponse = await fetchImpl(
    `https://graph.facebook.com/v20.0/${encodeURIComponent(mediaId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!metadataResponse.ok) return { ok: false, reason: 'media_metadata_failed' };

  const metadata = await metadataResponse.json().catch(() => null);
  if (!metadata?.url) return { ok: false, reason: 'media_url_missing' };
  const actualMimeType = String(metadata.mime_type || claimedMimeType).toLowerCase();
  if (!SUPPORTED_IMAGE_TYPES.has(actualMimeType)) {
    return { ok: false, reason: 'unsupported_media_type' };
  }
  const declaredSize = Number(metadata.file_size || 0);
  if (declaredSize > MAX_INBOUND_IMAGE_BYTES) return { ok: false, reason: 'media_too_large' };

  const downloadResponse = await fetchImpl(metadata.url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!downloadResponse.ok) return { ok: false, reason: 'media_download_failed' };
  const bytes = Buffer.from(await downloadResponse.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_INBOUND_IMAGE_BYTES) {
    return { ok: false, reason: bytes.length ? 'media_too_large' : 'media_empty' };
  }
  if (!isJpeg(bytes)) return { ok: false, reason: 'media_signature_invalid' };

  const objectPath = `${userId}/${taskId}/proof/whatsapp-${safeMessageKey(messageId)}${imageExtension(actualMimeType)}`;
  const storagePath = `task-images/${objectPath}`;
  const uploadResponse = await fetchImpl(
    `${supabaseUrl}/storage/v1/object/task-images/${objectPath}`,
    {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': actualMimeType,
        'Cache-Control': '3600',
        'x-upsert': 'true',
      },
      body: bytes,
    },
  );
  if (!uploadResponse.ok) return { ok: false, reason: 'media_storage_failed' };

  return { ok: true, storagePath, mimeType: actualMimeType, size: bytes.length };
}

export { MAX_INBOUND_IMAGE_BYTES, SUPPORTED_IMAGE_TYPES };
