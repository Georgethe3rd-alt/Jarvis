const express = require('express');
const { getConfig } = require('./whatsapp');
const { transcribe, textToSpeech } = require('./voice');
const { processMessage } = require('./ai');
const db = require('./db');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const router = express.Router();
const AUDIO_DIR = path.join(__dirname, '..', 'data', 'call-audio');
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

// Active call sessions
const callSessions = new Map();

/**
 * Twilio webhook — incoming call
 * POST /voice/incoming
 */
router.post('/incoming', (req, res) => {
  const from = req.body.From || '';
  const callSid = req.body.CallSid || '';

  // Normalize phone (strip +)
  const phone = from.replace('+', '');
  console.log(`[CALL] Incoming from ${from} (${callSid})`);

  // Check if this is an active tenant
  const tenant = db.prepare('SELECT * FROM tenants WHERE phone = ? AND status = ?').get(phone, 'active');

  if (!tenant) {
    // Not a registered user
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="man" language="en-GB">Welcome to Jarvis. You need to register on our website first before using voice calls. Visit our website to sign up. Goodbye.</Say>
  <Hangup/>
</Response>`);
    return;
  }

  // Initialize call session
  callSessions.set(callSid, { phone, tenantId: tenant.id, name: tenant.name });

  // Greet and start listening
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="man" language="en-GB">Hello ${tenant.name || 'there'}. Jarvis online. How can I help you?</Say>
  <Gather input="speech" timeout="5" speechTimeout="auto" action="/voice/process" method="POST" language="en-US">
    <Say voice="man" language="en-GB">I'm listening.</Say>
  </Gather>
  <Say voice="man" language="en-GB">I didn't catch that. Goodbye.</Say>
</Response>`);
});

/**
 * Process speech input from Twilio
 * POST /voice/process
 */
router.post('/process', async (req, res) => {
  const speechResult = req.body.SpeechResult || '';
  const callSid = req.body.CallSid || '';
  const confidence = req.body.Confidence || 0;

  const session = callSessions.get(callSid);
  if (!session) {
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="man" language="en-GB">Session expired. Goodbye.</Say><Hangup/></Response>`);
    return;
  }

  console.log(`[CALL] ${session.phone} said: "${speechResult}" (confidence: ${confidence})`);

  if (!speechResult || speechResult.toLowerCase() === 'goodbye' || speechResult.toLowerCase() === 'bye') {
    callSessions.delete(callSid);
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="man" language="en-GB">Until next time. Jarvis out.</Say><Hangup/></Response>`);
    return;
  }

  try {
    // Process through AI
    const reply = await processMessage(session.phone, session.name, speechResult);

    // Try ElevenLabs TTS
    const audioBuffer = await textToSpeech(reply);

    if (audioBuffer) {
      // Save audio file and serve it
      const audioId = crypto.randomBytes(8).toString('hex');
      const audioPath = path.join(AUDIO_DIR, `${audioId}.mp3`);
      fs.writeFileSync(audioPath, audioBuffer);

      // Clean up old files (keep last 100)
      cleanupAudioFiles();

      const baseUrl = getConfig('base_url') || process.env.BASE_URL || `http://${req.headers.host}`;

      res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/voice/audio/${audioId}.mp3</Play>
  <Gather input="speech" timeout="5" speechTimeout="auto" action="/voice/process" method="POST" language="en-US">
    <Say voice="man" language="en-GB">Anything else?</Say>
  </Gather>
  <Say voice="man" language="en-GB">I'll be here if you need me. Goodbye.</Say>
</Response>`);
    } else {
      // Fallback to Twilio TTS
      // Truncate for Twilio Say (max ~3000 chars practical)
      const sayText = reply.length > 2000 ? reply.substring(0, 2000) + '... I have sent the full response to your WhatsApp.' : reply;

      res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="man" language="en-GB">${escapeXml(sayText)}</Say>
  <Gather input="speech" timeout="5" speechTimeout="auto" action="/voice/process" method="POST" language="en-US">
    <Say voice="man" language="en-GB">Anything else?</Say>
  </Gather>
  <Say voice="man" language="en-GB">I'll be here if you need me. Goodbye.</Say>
</Response>`);
    }
  } catch (err) {
    console.error('[CALL] Processing error:', err);
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="man" language="en-GB">I had trouble processing that. Let me try again.</Say>
  <Gather input="speech" timeout="5" speechTimeout="auto" action="/voice/process" method="POST" language="en-US">
    <Say voice="man" language="en-GB">Go ahead.</Say>
  </Gather>
</Response>`);
  }
});

// Serve generated audio files
router.get('/audio/:file', (req, res) => {
  const filePath = path.join(AUDIO_DIR, req.params.file);
  if (fs.existsSync(filePath)) {
    res.type('audio/mpeg').sendFile(filePath);
  } else {
    res.sendStatus(404);
  }
});

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cleanupAudioFiles() {
  try {
    const files = fs.readdirSync(AUDIO_DIR)
      .map(f => ({ name: f, time: fs.statSync(path.join(AUDIO_DIR, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    files.slice(100).forEach(f => fs.unlinkSync(path.join(AUDIO_DIR, f.name)));
  } catch {}
}

module.exports = router;
