const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getConfig } = require('./whatsapp');

const TEMP_DIR = path.join(__dirname, '..', 'data', 'tmp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const GRAPH_API = 'https://graph.facebook.com/v19.0';

/**
 * Download media from WhatsApp by media ID
 */
async function downloadWhatsAppMedia(mediaId) {
  const token = getConfig('whatsapp_token') || process.env.WHATSAPP_TOKEN;
  if (!token || !mediaId) return null;

  try {
    const urlRes = await axios.get(`${GRAPH_API}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const mediaUrl = urlRes.data.url;
    const mimeType = urlRes.data.mime_type || '';

    const mediaRes = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer'
    });

    return { buffer: Buffer.from(mediaRes.data), mimeType };
  } catch (err) {
    console.error('[DOC] Media download error:', err.response?.data || err.message);
    return null;
  }
}

/**
 * Extract text from a PDF buffer
 */
async function extractPDF(buffer) {
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    return data.text || '';
  } catch (err) {
    console.error('[DOC] PDF parse error:', err.message);
    return null;
  }
}

/**
 * Extract text from a Word document (.docx) buffer
 */
async function extractWord(buffer) {
  try {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  } catch (err) {
    console.error('[DOC] Word parse error:', err.message);
    return null;
  }
}

/**
 * Analyze an image using Claude vision
 */
async function analyzeImage(buffer, mimeType, userPrompt) {
  const Anthropic = require('@anthropic-ai/sdk').default;
  const apiKey = getConfig('anthropic_api_key') || process.env.ANTHROPIC_API_KEY;
  const client = new Anthropic({ apiKey });

  // Ensure valid mime type for Claude
  const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  let mediaType = mimeType;
  if (!validTypes.includes(mediaType)) {
    // Try to convert or default to jpeg
    mediaType = 'image/jpeg';
  }

  const base64 = buffer.toString('base64');

  try {
    const response = await client.messages.create({
      model: getConfig('anthropic_model') || 'claude-sonnet-4-5-20250929',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 }
          },
          {
            type: 'text',
            text: userPrompt || 'Describe this image in detail. If it contains text, extract all the text. If it contains data, summarize the key information.'
          }
        ]
      }]
    });

    return response.content[0].text;
  } catch (err) {
    console.error('[DOC] Image analysis error:', err.message);
    return null;
  }
}

/**
 * Process any document/image attachment
 * Returns { type, text } where type is 'pdf'|'word'|'image'|'unknown'
 */
async function processAttachment(mediaId, mimeType, caption) {
  const media = await downloadWhatsAppMedia(mediaId);
  if (!media) return { type: 'error', text: null };

  const mime = mimeType || media.mimeType || '';

  // PDF
  if (mime.includes('pdf')) {
    const text = await extractPDF(media.buffer);
    if (text) {
      const truncated = text.length > 15000 ? text.substring(0, 15000) + '\n\n[...truncated, document continues]' : text;
      return { type: 'pdf', text: truncated, pageCount: text.length };
    }
    return { type: 'pdf', text: null };
  }

  // Word documents
  if (mime.includes('word') || mime.includes('docx') || mime.includes('msword') || mime.includes('openxmlformats-officedocument.wordprocessingml')) {
    const text = await extractWord(media.buffer);
    if (text) {
      const truncated = text.length > 15000 ? text.substring(0, 15000) + '\n\n[...truncated, document continues]' : text;
      return { type: 'word', text: truncated };
    }
    return { type: 'word', text: null };
  }

  // Images
  if (mime.startsWith('image/')) {
    const analysis = await analyzeImage(media.buffer, mime, caption || null);
    return { type: 'image', text: analysis };
  }

  // Plain text files
  if (mime.includes('text/plain') || mime.includes('text/csv')) {
    const text = media.buffer.toString('utf8');
    const truncated = text.length > 15000 ? text.substring(0, 15000) + '\n\n[...truncated]' : text;
    return { type: 'text', text: truncated };
  }

  return { type: 'unknown', text: null, mimeType: mime };
}

module.exports = { processAttachment, downloadWhatsAppMedia, extractPDF, extractWord, analyzeImage };
