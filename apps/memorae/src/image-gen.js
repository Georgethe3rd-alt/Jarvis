/**
 * Image Generation module for Jarvis
 * Uses OpenAI DALL-E API to generate images
 * Sends via WhatsApp as image messages
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { getConfig } = require('./whatsapp');

/**
 * Generate an image using DALL-E
 * @param {string} prompt - Description of the image to generate
 * @param {string} size - Image size: "1024x1024", "1024x1792", "1792x1024"
 * @param {string} quality - "standard" or "hd"
 * @returns {Promise<{url: string, revised_prompt: string} | {error: string}>}
 */
async function generateImage(prompt, size = '1024x1024', quality = 'standard') {
  const apiKey = getConfig('openai_api_key') || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { error: 'OpenAI API key not configured' };
  }

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size,
      quality,
      response_format: 'url',
    });

    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/images/generations',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 60000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.data && parsed.data[0]) {
            resolve({
              url: parsed.data[0].url,
              revised_prompt: parsed.data[0].revised_prompt || prompt,
            });
          } else if (parsed.error) {
            resolve({ error: parsed.error.message });
          } else {
            resolve({ error: 'Unexpected response' });
          }
        } catch (e) {
          resolve({ error: 'Parse error: ' + e.message });
        }
      });
    });

    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'Request timed out (image generation can take up to 60s)' }); });
    req.write(body);
    req.end();
  });
}

/**
 * Download an image from URL to a local buffer
 */
function downloadImage(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImage(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

module.exports = { generateImage, downloadImage };
