/**
 * Twilio Voice Integration
 * Handles voice calls with ElevenLabs TTS integration
 */

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '[CONFIGURE_IN_ENV]';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '[CONFIGURE_IN_ENV]';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '[CONFIGURE_IN_ENV]';
const ELEVENLABS_VOICE_ID = 'onwK4e9ZLuTAKqWW03F9'; // Daniel voice

/**
 * Generate TwiML response with ElevenLabs audio
 */
async function generateTwiMLWithElevenLabs(text) {
    // First, generate audio with ElevenLabs
    const audioUrl = await generateElevenLabsAudio(text);

    // Create TwiML response
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Play>${audioUrl}</Play>
    <Gather input="speech" timeout="3" speechTimeout="auto">
        <Say>I'm listening...</Say>
    </Gather>
</Response>`;
}

/**
 * Generate audio using ElevenLabs
 */
async function generateElevenLabsAudio(text) {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
        method: 'POST',
        headers: {
            'Accept': 'audio/mpeg',
            'Content-Type': 'application/json',
            'xi-api-key': ELEVENLABS_API_KEY
        },
        body: JSON.stringify({
            text: text,
            model_id: 'eleven_multilingual_v2',
            voice_settings: {
                stability: 0.75,
                similarity_boost: 0.75
            }
        })
    });

    // In production, save to S3/CDN and return public URL
    // For now, return placeholder
    return 'https://your-cdn.com/audio/response.mp3';
}

/**
 * Make outbound call
 */
async function makeCall(to, message) {
    const client = require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    const call = await client.calls.create({
        to: to,
        from: process.env.TWILIO_PHONE_NUMBER || '[CONFIGURE_IN_ENV]',
        twiml: `<Response><Say voice="man" language="en-GB">${message}</Say></Response>`
    });

    return call.sid;
}

module.exports = {
    generateTwiMLWithElevenLabs,
    generateElevenLabsAudio,
    makeCall
};
