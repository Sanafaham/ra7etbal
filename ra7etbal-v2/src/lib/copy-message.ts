/**
 * Build and copy a delegation message in the shape a recipient should
 * actually receive it.
 *
 * Plain text (always written): the body, a blank line, then
 *   `Click here when done: <url>`
 * The URL appears inline so messaging apps that paste plain text
 * (WhatsApp, iMessage, SMS) auto-linkify it.
 *
 * HTML (written alongside when ClipboardItem.write is available): the
 * body and a real `<a>Click here when done.</a>` link. Pastes into
 * rich-text targets (email, Notion, web forms, iOS rich paste) preserve
 * the link without exposing the URL string.
 *
 * For messages with no confirmation URL — plain content goes to plain
 * text, no HTML payload.
 */

export interface CopyPayload {
  /** The recipient-facing body text. */
  content: string;
  /** When present, append "Click here when done." with this URL. */
  confirmationUrl?: string | null;
}

export async function copyDelegationMessage(payload: CopyPayload): Promise<void> {
  const content = (payload.content ?? "").trim();
  if (!content) return;
  const url = payload.confirmationUrl?.trim() || null;

  const plain = url ? `${content}\n\nClick here when done: ${url}` : content;

  // Try the rich-text path first when we have a URL — preserves "Click here
  // when done" as a hyperlink in paste targets that support HTML.
  if (url && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      const html = buildHtml(content, url);
      const item = new ClipboardItem({
        "text/plain": new Blob([plain], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      });
      await navigator.clipboard.write([item]);
      return;
    } catch {
      // Fall through to plain text.
    }
  }

  await navigator.clipboard.writeText(plain);
}

function buildHtml(content: string, url: string): string {
  // Preserve user line breaks in the plain content; render the link inline.
  const escapedBody = escapeHtml(content).replace(/\n/g, "<br>");
  const escapedHref = escapeAttr(url);
  return `<div>${escapedBody}<br><br><a href="${escapedHref}">Click here when done.</a></div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
