/**
 * Outbound calling module for Jarvis
 * Allows Jarvis to initiate calls to users via Twilio
 */
const { getConfig } = require('./whatsapp');
const { textToSpeech } = require('./voice');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUDIO_DIR = path.join(__dirname, '..', 'data', 'call-audio');
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

/**
 * Make an outbound call and speak a message
 * @param {string} toPhone - Phone number to call (with country code)
 * @param {string} message - What Jarvis should say
 * @param {object} options - { voice: bool (use ElevenLabs), gather: bool (listen for response) }
 */
async function makeCall(toPhone, message, options = {}) {
  const accountSid = getConfig('twilio_account_sid') || process.env.TWILIO_ACCOUNT_SID;
  const authToken = getConfig('twilio_auth_token') || process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = getConfig('twilio_phone_number') || process.env.TWILIO_PHONE_NUMBER;
  const baseUrl = getConfig('base_url') || process.env.BASE_URL || 'https://jarvisproject.ai';

  if (!accountSid || !authToken || !fromNumber) {
    return { error: 'Twilio credentials not configured' };
  }

  // Normalize phone number
  const to = toPhone.startsWith('+') ? toPhone : '+' + toPhone.replace(/[^\d]/g, '');

  try {
    let twiml;

    if (options.voice !== false) {
      // Generate ElevenLabs audio
      const audioBuffer = await textToSpeech(message);
      if (audioBuffer) {
        const audioId = crypto.randomBytes(8).toString('hex');
        const audioPath = path.join(AUDIO_DIR, `${audioId}.mp3`);
        fs.writeFileSync(audioPath, audioBuffer);

        if (options.gather) {
          twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/voice/audio/${audioId}.mp3</Play>
  <Gather input="speech" timeout="5" speechTimeout="auto" action="/voice/process" method="POST" language="en-US">
    <Say voice="man" language="en-GB">I'm listening.</Say>
  </Gather>
  <Say voice="man" language="en-GB">I'll be here if you need me. Goodbye.</Say>
</Response>`;
        } else {
          twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/voice/audio/${audioId}.mp3</Play>
  <Say voice="man" language="en-GB">Goodbye.</Say>
</Response>`;
        }
      } else {
        // Fallback to Twilio TTS
        const escaped = escapeXml(message);
        twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="man" language="en-GB">${escaped}</Say>
  ${options.gather ? '<Gather input="speech" timeout="5" speechTimeout="auto" action="/voice/process" method="POST" language="en-US"><Say voice="man" language="en-GB">I\'m listening.</Say></Gather>' : ''}
</Response>`;
      }
    } else {
      const escaped = escapeXml(message);
      twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="man" language="en-GB">${escaped}</Say>
  ${options.gather ? '<Gather input="speech" timeout="5" speechTimeout="auto" action="/voice/process" method="POST" language="en-US"><Say voice="man" language="en-GB">I\'m listening.</Say></Gather>' : ''}
</Response>`;
    }

    // Make the call via Twilio REST API
    const https = require('https');
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    
    const postData = new URLSearchParams({
      To: to,
      From: fromNumber,
      Twiml: twiml,
    }).toString();

    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.twilio.com',
        path: `/2010-04-01/Accounts/${accountSid}/Calls.json`,
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: 15000,
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve(data);
          } catch (e) {
            resolve({ error: body });
          }
        });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    if (result.sid) {
      console.log(`[CALL] Outbound call initiated to ${to} — SID: ${result.sid}`);
      return { success: true, callSid: result.sid, to, status: result.status };
    } else {
      console.error('[CALL] Outbound call failed:', result);
      return { error: result.message || result.error || 'Call failed' };
    }
  } catch (err) {
    console.error('[CALL] Outbound error:', err.message);
    return { error: err.message };
  }
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { makeCall };
