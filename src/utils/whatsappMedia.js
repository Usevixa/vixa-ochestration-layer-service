const WHATSAPP_API_VERSION = "v25.0";

/** WhatsApp's own voice-note ceiling. OpenAI's is 25MB; this is stricter. */
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

/** Above this, warn the user before the transcription pause. ~15s of Opus. */
export const SLOW_TRANSCRIBE_BYTES = 200 * 1024;


export async function downloadWhatsAppMedia(mediaId) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token || !mediaId) return null;

  try {
    const metaRes = await fetch(
      `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${mediaId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!metaRes.ok) {
      console.error("media meta failed:", metaRes.status, await metaRes.text());
      return null;
    }

    const { url, mime_type, file_size } = await metaRes.json();

    if (file_size && file_size > MAX_MEDIA_BYTES) {
      console.error("media too large:", file_size);
      return null;
    }

    const binRes = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!binRes.ok) {
      console.error("media download failed:", binRes.status);
      return null;
    }

    return {
      buffer: Buffer.from(await binRes.arrayBuffer()),
      mimeType: mime_type,       // usually "audio/ogg; codecs=opus"
      fileSize: file_size || 0,
    };
  } catch (err) {
    console.error("downloadWhatsAppMedia threw:", err?.message || err);
    return null;
  }
}