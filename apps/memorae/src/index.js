require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

['data', 'data/tenants', 'public'].forEach(d => {
  const p = path.join(__dirname, '..', d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

const db = require('./db');
const { verifyWebhook, parseWebhook, sendMessage, sendAudioMessage, markAsRead, downloadMedia } = require('./whatsapp');
const { processMessage } = require('./ai');
const { provisionTenant } = require('./tenant');
const adminRouter = require('./admin');
const { router: signupRouter, normalizePhone } = require('./signup');
const { startReminderChecker } = require('./reminders');
const { transcribe, textToSpeech } = require('./voice');
const callRouter = require('./calls');

const app = express();
const PORT = process.env.PORT || 3003;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Landing Page ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Sign-up API ────────────────────────────────────────────
app.use('/api', signupRouter);

// ─── WhatsApp Webhook ───────────────────────────────────────
app.get('/webhook', verifyWebhook);

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const msg = parseWebhook(req.body);
  if (!msg || !msg.text) return;

  // Handle voice notes
  if ((msg.type === 'audio' || msg.type === 'voice') && msg.audioId) {
    console.log(`[VOICE] Audio message from ${phone}, downloading...`);
    const audioBuffer = await downloadMedia(msg.audioId);
    if (!audioBuffer) {
      await sendMessage(phone, "I couldn't process that voice note. Try again?");
      return;
    }

    const transcription = await transcribe(audioBuffer);
    if (!transcription) {
      await sendMessage(phone, "I couldn't understand that voice note. Could you try again or type it out?");
      return;
    }

    console.log(`[VOICE] Transcribed from ${phone}: "${transcription.substring(0, 80)}..."`);

    // Check if active tenant (same logic as text)
    const voiceTenant = db.prepare('SELECT * FROM tenants WHERE phone = ? AND status = ?').get(phone, 'active');
    if (!voiceTenant) {
      await sendMessage(phone, `I heard: "${transcription}"\n\nBut you need to activate first — send your 6-digit code to get started.`);
      return;
    }

    try {
      const reply = await processMessage(phone, msg.name, transcription);
      if (reply) {
        // Try to reply with voice note back
        const ttsAudio = await textToSpeech(reply);
        if (ttsAudio) {
          await sendAudioMessage(phone, ttsAudio);
          // Also send as text for reference
          if (reply.length > 100) {
            await sendMessage(phone, reply);
          }
        } else {
          await sendMessage(phone, reply);
        }
      }
    } catch (err) {
      console.error('[VOICE ERROR]', err);
      await sendMessage(phone, "Something went wrong processing your voice note. Try again?");
    }
    return;
  }

  if (msg.type !== 'text') {
    await sendMessage(msg.from, "I can handle text and voice notes for now — images coming soon! 🤖");
    return;
  }

  const phone = msg.from;
  const text = msg.text.trim();

  console.log(`[IN] ${phone} (${msg.name}): ${text}`);
  markAsRead(msg.messageId);

  // Check if this is an active tenant
  const tenant = db.prepare('SELECT * FROM tenants WHERE phone = ? AND status = ?').get(phone, 'active');

  if (tenant) {
    // Active tenant — process normally
    try {
      const reply = await processMessage(phone, msg.name, text);
      if (reply) {
        await sendMessage(phone, reply);
        console.log(`[OUT → ${phone}] ${reply.substring(0, 80)}...`);
      }
    } catch (err) {
      console.error('[ERROR]', err);
      await sendMessage(phone, "Something went wrong on my end. Try again in a moment. 🤖");
    }
    return;
  }

  // Not an active tenant — check if they're sending an activation code
  const codeMatch = text.match(/^\d{6}$/);
  if (codeMatch) {
    const code = codeMatch[0];
    const signup = db.prepare(
      "SELECT * FROM signups WHERE phone = ? AND activation_code = ? AND status = 'pending' AND expires_at > datetime('now')"
    ).get(phone, code);

    if (signup) {
      // Activate!
      db.prepare("UPDATE signups SET status = 'activated', activated_at = CURRENT_TIMESTAMP WHERE id = ?").run(signup.id);
      const newTenant = provisionTenant(phone, signup.name);
      db.prepare('UPDATE tenants SET email = ? WHERE id = ?').run(signup.email, newTenant.id);

      console.log(`[ACTIVATE] ${signup.name} (${phone}) → Tenant #${newTenant.id}`);

      await sendMessage(phone,
        `✅ *Jarvis online.* Welcome, ${signup.name}.\n\n` +
        `Your personal AI workspace has been provisioned. Here's what I can do:\n\n` +
        `🧠 *Total Recall* — Tell me anything. I never forget.\n` +
        `⏰ *Reminders* — "Remind me to call Mom at 5pm"\n` +
        `📋 *Lists & Organization* — Shopping, tasks, ideas — all sorted.\n` +
        `💬 *Draft & Think* — Brainstorm, write emails, plan projects.\n` +
        `📊 *Daily Briefing* — Ask me "What's on my plate today?"\n\n` +
        `Everything is private — your own isolated workspace that no one else can access.\n\n` +
        `One more thing: I come with a default personality (think Jarvis from Iron Man — dry wit, proactive, gets things done). But I'm *yours* to customize.\n\n` +
        `Want to change how I talk? Just tell me:\n` +
        `• "Be more casual" or "Be more formal"\n` +
        `• "Speak to me in French"\n` +
        `• "Be more like a coach"\n` +
        `• "Call me [nickname]"\n\n` +
        `Or just start using me as-is. What can I help you with?`
      );
      return;
    }

    // Invalid or expired code
    await sendMessage(phone,
      "❌ That activation code is invalid or expired.\n\n" +
      "Visit our website to sign up and get a new code, then send it here to activate your assistant."
    );
    return;
  }

  // Unknown user, no valid code
  await sendMessage(phone,
    "👋 Hey there! I'm Jarvis, a personal AI assistant.\n\n" +
    "To get started, you need to sign up first:\n" +
    "1️⃣ Visit our website and register\n" +
    "2️⃣ You'll receive a 6-digit activation code\n" +
    "3️⃣ Send that code here to activate\n\n" +
    "Already have a code? Just send it now!"
  );
});

// ─── Voice Calls (Twilio) ───────────────────────────────────
app.use('/voice', callRouter);

// ─── Admin Console ──────────────────────────────────────────
app.use('/admin/api', adminRouter);
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.get('/admin/*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

// ─── Health ─────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const tenants = db.prepare('SELECT COUNT(*) as c FROM tenants').get().c;
  const pendingSignups = db.prepare("SELECT COUNT(*) as c FROM signups WHERE status = 'pending'").get().c;
  res.json({ status: 'ok', uptime: process.uptime(), tenants, pendingSignups, timestamp: new Date().toISOString() });
});

// ─── Start ──────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  🤖 JARVIS — Multi-Tenant AI Assistant');
  console.log('  ─────────────────────────────────────');
  console.log(`  🌐 Landing Page     : http://0.0.0.0:${PORT}`);
  console.log(`  📱 WhatsApp Webhook : http://0.0.0.0:${PORT}/webhook`);
  console.log(`  🔧 Admin Console    : http://0.0.0.0:${PORT}/admin`);
  console.log(`  📞 Voice Calls      : http://0.0.0.0:${PORT}/voice/incoming`);
  console.log(`  💚 Health Check     : http://0.0.0.0:${PORT}/health`);
  console.log('');
  startReminderChecker();
});
