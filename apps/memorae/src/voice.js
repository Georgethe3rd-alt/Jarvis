const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getConfig } = require('./whatsapp');

const TEMP_DIR = path.join(__dirname, '..', 'data', 'tmp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

/**
 * Transcribe audio buffer to text using OpenAI Whisper
 */
async function transcribe(audioBuffer) {
  const openaiKey = getConfig('openai_api_key') || process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    console.error('[VOICE] No OpenAI API key for transcription');
    return null;
  }

  const tmpFile = path.join(TEMP_DIR, `voice_${Date.now()}.ogg`);
  fs.writeFileSync(tmpFile, audioBuffer);

  try {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', fs.createReadStream(tmpFile), { filename: 'audio.ogg', contentType: 'audio/ogg' });
    form.append('model', 'whisper-1');

    const res = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        ...form.getHeaders()
      },
      maxContentLength: 50 * 1024 * 1024
    });

    console.log(`[VOICE] Transcribed: "${res.data.text?.substring(0, 80)}..."`);
    return res.data.text;
  } catch (err) {
    console.error('[VOICE] Transcription error:', err.response?.data || err.message);
    return null;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Generate speech from text using ElevenLabs
 * Returns OGG audio buffer
 */
async function textToSpeech(text) {
  const apiKey = getConfig('elevenlabs_api_key') || process.env.ELEVENLABS_API_KEY;
  const voiceId = getConfig('elevenlabs_voice_id') || process.env.ELEVENLABS_VOICE_ID || 'onwK4e9ZLuTAKqWW03F9';

  if (!apiKey) {
    console.error('[VOICE] No ElevenLabs API key for TTS');
    return null;
  }

  // Truncate very long texts for voice (keep it conversational)
  const maxChars = 2000;
  let voiceText = text;
  if (voiceText.length > maxChars) {
    voiceText = voiceText.substring(0, maxChars) + '... I\'ve sent the full response as text as well.';
  }

  try {
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        text: voiceText,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: 0.7,
          similarity_boost: 0.8,
          style: 0.2,
          use_speaker_boost: true
        },
        output_format: 'mp3_44100_128'
      },
      {
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg'
        },
        responseType: 'arraybuffer'
      }
    );

    console.log(`[VOICE] TTS generated: ${res.data.byteLength} bytes`);
    return Buffer.from(res.data);
  } catch (err) {
    console.error('[VOICE] TTS error:', err.response?.data || err.message);
    return null;
  }
}

module.exports = { transcribe, textToSpeech };
