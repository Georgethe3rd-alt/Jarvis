/**
 * Image Understanding module for Jarvis
 * Uses OpenAI GPT-4o Vision API to analyze images
 */
const https = require('https');
const { getConfig } = require('./whatsapp');

/**
 * Analyze an image using OpenAI Vision
 * @param {string} imageUrl - URL of the image to analyze
 * @param {string} prompt - What to analyze/ask about the image
 * @returns {Promise<{description: string} | {error: string}>}
 */
async function analyzeImage(imageUrl, prompt = 'Describe this image in detail. What do you see?') {
  const apiKey = getConfig('openai_api_key') || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { error: 'OpenAI API key not configured' };
  }

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: imageUrl, detail: 'auto' } }
          ]
        }
      ],
      max_tokens: 1024,
    });

    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.choices && parsed.choices[0]) {
            resolve({ description: parsed.choices[0].message.content });
          } else if (parsed.error) {
            resolve({ error: parsed.error.message });
          } else {
            resolve({ error: 'Unexpected response format' });
          }
        } catch (e) {
          resolve({ error: 'Failed to parse response: ' + e.message });
        }
      });
    });

    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'Request timed out' }); });
    req.write(body);
    req.end();
  });
}

/**
 * Analyze an image from base64 data
 * @param {Buffer} imageBuffer - Image buffer
 * @param {string} mimeType - MIME type (image/jpeg, image/png, etc.)
 * @param {string} prompt - What to analyze
 */
async function analyzeImageBuffer(imageBuffer, mimeType = 'image/jpeg', prompt = 'Describe this image in detail.') {
  const base64 = imageBuffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64}`;
  return analyzeImage(dataUrl, prompt);
}

module.exports = { analyzeImage, analyzeImageBuffer };
