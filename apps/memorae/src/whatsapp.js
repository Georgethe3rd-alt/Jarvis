const axios = require('axios');
const db = require('./db');

const GRAPH_API = 'https://graph.facebook.com/v19.0';

function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : process.env[key.toUpperCase().replace(/\./g, '_')];
}

async function sendMessage(to, text) {
  const token = getConfig('whatsapp_token') || process.env.WHATSAPP_TOKEN;
  const phoneId = getConfig('whatsapp_phone_number_id') || process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneId) {
    console.error('[WA] Not configured — missing token or phone_number_id');
    return null;
  }

  // WhatsApp has a 4096 char limit per message — split if needed
  const chunks = [];
  if (text.length <= 4096) {
    chunks.push(text);
  } else {
    for (let i = 0; i < text.length; i += 4000) {
      chunks.push(text.substring(i, i + 4000));
    }
  }

  let lastRes = null;
  for (const chunk of chunks) {
    try {
      const res = await axios.post(
        `${GRAPH_API}/${phoneId}/messages`,
        {
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: chunk }
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );
      lastRes = res.data;
    } catch (err) {
      console.error('[WA] Send error:', err.response?.data || err.message);
      return null;
    }
  }
  return lastRes;
}

async function markAsRead(messageId) {
  const token = getConfig('whatsapp_token') || process.env.WHATSAPP_TOKEN;
  const phoneId = getConfig('whatsapp_phone_number_id') || process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) return;

  try {
    await axios.post(
      `${GRAPH_API}/${phoneId}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch {}
}

function verifyWebhook(req, res) {
  const verifyToken = getConfig('whatsapp_verify_token') || process.env.WHATSAPP_VERIFY_TOKEN || 'jarvis-verify-2026';
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('[WA] Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
}

function parseWebhook(body) {
  try {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value?.messages?.[0]) return null;

    const msg = value.messages[0];
    const contact = value.contacts?.[0];

    return {
      from: msg.from,
      name: contact?.profile?.name || 'Unknown',
      type: msg.type,
      text: msg.text?.body || msg.image?.caption || msg.document?.caption || '',
      audioId: msg.audio?.id || msg.voice?.id || null,
      imageId: msg.image?.id || null,
      imageMime: msg.image?.mime_type || null,
      documentId: msg.document?.id || null,
      documentMime: msg.document?.mime_type || null,
      documentName: msg.document?.filename || null,
      timestamp: msg.timestamp,
      messageId: msg.id
    };
  } catch {
    return null;
  }
}

async function downloadMedia(mediaId) {
  const token = getConfig('whatsapp_token') || process.env.WHATSAPP_TOKEN;
  if (!token || !mediaId) return null;

  try {
    // Step 1: Get media URL
    const urlRes = await axios.get(`${GRAPH_API}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const mediaUrl = urlRes.data.url;

    // Step 2: Download the media
    const mediaRes = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer'
    });
    return Buffer.from(mediaRes.data);
  } catch (err) {
    console.error('[WA] Media download error:', err.response?.data || err.message);
    return null;
  }
}

async function sendAudioMessage(to, audioBuffer) {
  const token = getConfig('whatsapp_token') || process.env.WHATSAPP_TOKEN;
  const phoneId = getConfig('whatsapp_phone_number_id') || process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) return null;

  try {
    // Upload media first
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', audioBuffer, { filename: 'response.mp3', contentType: 'audio/mpeg' });
    form.append('messaging_product', 'whatsapp');
    form.append('type', 'audio/mpeg');

    const uploadRes = await axios.post(`${GRAPH_API}/${phoneId}/media`, form, {
      headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() }
    });
    const mediaId = uploadRes.data.id;

    // Send audio message
    const res = await axios.post(`${GRAPH_API}/${phoneId}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'audio',
      audio: { id: mediaId }
    }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    return res.data;
  } catch (err) {
    console.error('[WA] Audio send error:', err.response?.data || err.message);
    return null;
  }
}

async function sendImageMessage(to, imageUrl, caption) {
  const token = getConfig("whatsapp_token") || process.env.WHATSAPP_TOKEN;
  const phoneId = getConfig("whatsapp_phone_number_id") || process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) { console.error("[WA] Not configured"); return null; }
  try {
    const res = await axios.post(`${GRAPH_API}/${phoneId}/messages`, {
      messaging_product: "whatsapp",
      to: to.replace(/[^\d]/g, ""),
      type: "image",
      image: { link: imageUrl, caption: caption || "" }
    }, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
    console.log(`[WA] Image sent to ${to}`);
    return res.data;
  } catch (err) {
    console.error("[WA] Image send error:", err.response?.data || err.message);
    return null;
  }
}


async function sendTypingIndicator(to) {
  const token = getConfig('whatsapp_token') || process.env.WHATSAPP_TOKEN;
  const phoneId = getConfig('whatsapp_phone_number_id') || process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) return;
  try {
    await axios.post(`${GRAPH_API}/${phoneId}/messages`, {
      messaging_product: 'whatsapp',
      to: to.replace(/[^\d]/g, ''),
      type: 'reaction',
      status: 'typing'
    }, { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  } catch (e) {}
}


async function reactToMessage(to, messageId, emoji) {
  const token = getConfig('whatsapp_token') || process.env.WHATSAPP_TOKEN;
  const phoneId = getConfig('whatsapp_phone_number_id') || process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId || !messageId) return;
  try {
    await axios.post(`${GRAPH_API}/${phoneId}/messages`, {
      messaging_product: 'whatsapp',
      to: to.replace(/[^\d]/g, ''),
      type: 'reaction',
      reaction: { message_id: messageId, emoji: emoji || '' }
    }, { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {}
}

module.exports = { reactToMessage, sendTypingIndicator, sendMessage, sendImageMessage, sendAudioMessage, markAsRead, verifyWebhook, parseWebhook, downloadMedia, getConfig };
