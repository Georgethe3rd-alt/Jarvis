require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { startHeartbeat, ensureTables } = require("./heartbeat");

['data', 'data/tenants', 'public'].forEach(d => {
  const p = path.join(__dirname, '..', d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

const db = require('./db');
const { verifyWebhook, parseWebhook, sendMessage, sendAudioMessage, markAsRead, downloadMedia } = require('./whatsapp');
const { processMessage } = require('./ai');
const { provisionTenant, getTenantDir } = require('./tenant');
const adminRouter = require('./admin');
const { router: signupRouter, normalizePhone } = require('./signup');
const { startReminderChecker } = require('./reminders');
const { transcribe, textToSpeech } = require('./voice');
const callRouter = require('./calls');
const { processAttachment } = require('./documents');
const { router: billingRouter, PLANS, canSendMessage, incrementMessageCount, getUpgradeMessage } = require('./billing');
const { startBriefingChecker } = require('./briefings');
const dashboardApiRouter = require('./dashboard-api');
const { updateMemoryFile, updateSoulFile, appendDailyNote, PERSONALITY_PRESETS } = require('./tenant');
const { publicLimiter, authLimiter, signupPhoneLimiter } = require('./ratelimit');
const { logError, installGlobalHandlers } = require('./monitor');
const { startBackupScheduler } = require('./backup');
const { sendWelcomeEmail } = require('./email');
const { startWinbackChecker } = require('./winback');
const QRCode = require('qrcode');
const { getConfig } = require('./whatsapp');

// ─── Global Error Handlers ──────────────────────────────────
installGlobalHandlers();

// ─── Onboarding Migration ───────────────────────────────────
const tenantCols = db.prepare("PRAGMA table_info(tenants)").all().map(c => c.name);
if (!tenantCols.includes('onboarding_step')) db.exec("ALTER TABLE tenants ADD COLUMN onboarding_step TEXT");

const app = express();
const PORT = process.env.PORT || 3003;

app.use(cors());

// ─── Favicon ────────────────────────────────────────────────
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'favicon.ico')));
app.get('/favicon.svg', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'favicon.svg')));

// ─── Raw body capture for webhook signature verification ────
app.use('/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  req.rawBody = req.body;
  try {
    req.body = JSON.parse(req.rawBody);
  } catch {
    req.body = {};
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Landing Page ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Sign-up API ────────────────────────────────────────────
app.use('/api/register', signupPhoneLimiter, publicLimiter);
app.use('/api', signupRouter);

// ─── Resend Activation Code ─────────────────────────────────
app.post('/api/resend', (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number required' });
  const normalized = phone.replace(/[^\d]/g, '');

  const pending = db.prepare(
    "SELECT * FROM signups WHERE phone = ? AND status = 'pending' AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
  ).get(normalized);

  if (pending) {
    return res.json({ success: true, activation_code: pending.activation_code, expires_at: pending.expires_at });
  }

  res.status(404).json({ error: 'No pending activation found for this number. Please sign up again.' });
});

// ─── Personalities API (public) ──────────────────────────────
app.get('/api/personalities', (req, res) => {
  const list = Object.entries(PERSONALITY_PRESETS).map(([key, val]) => ({
    key, name: val.name, description: val.description
  }));
  res.json(list);
});

// ─── QR Code API ────────────────────────────────────────────
app.get('/api/qr', async (req, res) => {
  try {
    const numberRow = db.prepare("SELECT value FROM config WHERE key = 'whatsapp_business_number'").get();
    if (!numberRow || !numberRow.value) return res.status(404).json({ error: 'No WhatsApp number configured' });
    const url = `https://wa.me/${numberRow.value.replace(/[^\d]/g, '')}`;
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 200 });
    res.type('image/svg+xml').send(svg);
  } catch (err) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// ─── WhatsApp Number API (for landing page) ─────────────────
app.get('/api/whatsapp-number', (req, res) => {
  const row = db.prepare("SELECT value FROM config WHERE key = 'whatsapp_business_number'").get();
  res.json({ number: row ? row.value : null });
});

// ─── Billing ────────────────────────────────────────────────
app.use('/billing', billingRouter);

// ─── User Dashboard ─────────────────────────────────────────
app.use('/dashboard/api/login', authLimiter);
app.use('/dashboard/api', dashboardApiRouter);
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html')));
app.get('/dashboard/*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html')));

// ─── WhatsApp Webhook ───────────────────────────────────────
app.get('/webhook', verifyWebhook);

let _appSecretWarned = false;
app.post('/webhook', publicLimiter, (req, res, next) => {
  try {
    const secretRow = db.prepare('SELECT value FROM config WHERE key = ?').get('whatsapp_app_secret');
    const appSecret = secretRow ? secretRow.value : null;
    if (appSecret && req.rawBody) {
      const sig = req.headers['x-hub-signature-256'];
      if (!sig) {
        console.warn('[WEBHOOK] Missing X-Hub-Signature-256 header');
        return res.status(403).json({ error: 'Missing signature' });
      }
      const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(req.rawBody).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        console.warn('[WEBHOOK] Invalid signature');
        return res.status(403).json({ error: 'Invalid signature' });
      }
    } else if (!appSecret && !_appSecretWarned) {
      console.warn('[WEBHOOK] No whatsapp_app_secret configured — signature verification disabled');
      _appSecretWarned = true;
    }
  } catch (err) {
    logError(err.message, err.stack, { handler: 'webhook-signature' });
  }
  next();
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = parseWebhook(req.body);
    if (!msg) return;

    // ─── FIX #1: Define phone FIRST, before any handlers use it ───
    const phone = msg.from;
    const text = (msg.text || '').trim();

    console.log(`[IN] ${phone} (${msg.name}): [${msg.type}] ${text || '(media)'}`);
    markAsRead(msg.messageId);

    // ─── Handle voice notes ───────────────────────────────
    if ((msg.type === 'audio' || msg.type === 'voice') && msg.audioId) {
      console.log(`[VOICE] Audio from ${phone}, downloading...`);
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

      console.log(`[VOICE] Transcribed: "${transcription.substring(0, 80)}..."`);

      const voiceTenant = db.prepare('SELECT * FROM tenants WHERE phone = ? AND status = ?').get(phone, 'active');
      if (!voiceTenant) {
        await sendMessage(phone, `I heard: "${transcription}"\n\nBut you need to activate first — send your 6-digit code to get started.`);
        return;
      }

      // Check billing
      if (!canSendMessage(voiceTenant)) {
        await sendMessage(phone, getUpgradeMessage(voiceTenant));
        return;
      }
      incrementMessageCount(voiceTenant.id);

      try {
        const reply = await processMessage(phone, msg.name, transcription);
        if (reply) {
          const ttsAudio = await textToSpeech(reply);
          if (ttsAudio) {
            const audioResult = await sendAudioMessage(phone, ttsAudio);
            console.log("[VOICE] Audio send result:", audioResult ? "SUCCESS" : "FAILED");
            if (!audioResult) await sendMessage(phone, reply);
            if (reply.length > 100) await sendMessage(phone, reply);
          } else {
            await sendMessage(phone, reply);
          }
        }
      } catch (err) {
        console.error('[VOICE ERROR]', err);
        logError(err.message, err.stack, { handler: 'voice-processing', phone });
        await sendMessage(phone, "Something went wrong processing your voice note. Try again?");
      }
      return;
    }

    // ─── Handle images ────────────────────────────────────
    if (msg.type === 'image' && msg.imageId) {
      console.log(`[DOC] Image from ${phone}`);
      const tenant = db.prepare('SELECT * FROM tenants WHERE phone = ? AND status = ?').get(phone, 'active');
      if (!tenant) {
        await sendMessage(phone, "You need to activate first before I can analyze images. Send your 6-digit code.");
        return;
      }
      if (!canSendMessage(tenant)) { await sendMessage(phone, getUpgradeMessage(tenant)); return; }
      incrementMessageCount(tenant.id);

      await sendMessage(phone, "🔍 Analyzing your image...");
      const result = await processAttachment(msg.imageId, msg.imageMime, text);
      if (result.text) {
        const contextMsg = text
          ? `[User sent an image with caption: "${text}"]\n\nImage analysis:\n${result.text}`
          : `[User sent an image]\n\nImage analysis:\n${result.text}`;
        const reply = await processMessage(phone, msg.name, contextMsg);
        if (reply) await sendMessage(phone, reply);
      } else {
        await sendMessage(phone, "I couldn't analyze that image. Try sending it again?");
      }
      return;
    }

    // ─── Handle documents ─────────────────────────────────
    if (msg.type === 'document' && msg.documentId) {
      console.log(`[DOC] ${msg.documentName} from ${phone} (${msg.documentMime})`);
      const tenant = db.prepare('SELECT * FROM tenants WHERE phone = ? AND status = ?').get(phone, 'active');
      if (!tenant) {
        await sendMessage(phone, "You need to activate first before I can read documents. Send your 6-digit code.");
        return;
      }
      if (!canSendMessage(tenant)) { await sendMessage(phone, getUpgradeMessage(tenant)); return; }
      incrementMessageCount(tenant.id);

      await sendMessage(phone, `📄 Reading "${msg.documentName || 'document'}"...`);
      const result = await processAttachment(msg.documentId, msg.documentMime, text);
      if (result.text) {
        const contextMsg = text
          ? `[User sent a ${result.type} document: "${msg.documentName}". Caption: "${text}"]\n\nExtracted content:\n${result.text}`
          : `[User sent a ${result.type} document: "${msg.documentName}"]\n\nExtracted content:\n${result.text}`;
        const reply = await processMessage(phone, msg.name, contextMsg);
        if (reply) await sendMessage(phone, reply);
      } else if (result.type === 'unknown') {
        await sendMessage(phone, `I can't read that file type yet (${result.mimeType}). I support PDFs, Word docs, images, and text files.`);
      } else {
        await sendMessage(phone, "I had trouble reading that document. It might be corrupted or password-protected.");
      }
      return;
    }

    // ─── Non-text, non-handled media ──────────────────────
    if (msg.type !== 'text' || !text) {
      await sendMessage(phone, "I can handle text, voice notes, images, and documents (PDF/Word). Send me one of those! 🤖");
      return;
    }

    // ─── Active tenant? ───────────────────────────────────
    const tenant = db.prepare('SELECT * FROM tenants WHERE phone = ? AND status = ?').get(phone, 'active');

    if (tenant) {
      // ─── Onboarding Flow ──────────────────────────────
      if (tenant.onboarding_step && tenant.onboarding_step !== 'complete') {
        try {
          await handleOnboarding(tenant, phone, msg.name, text);
        } catch (err) {
          console.error('[ONBOARDING ERROR]', err);
          logError(err.message, err.stack, { handler: 'onboarding', phone });
          await sendMessage(phone, "Something went wrong. Let's try that again — just re-type your answer.");
        }
        return;
      }

      // ─── Usage / Plan Command ─────────────────────────
      const textLower = text.toLowerCase();
      if (textLower === 'usage' || textLower === 'my plan' || textLower === 'plan') {
        const plan = PLANS[tenant.plan || 'free'];
        const used = tenant.messages_this_month || 0;
        const limit = plan.messagesPerMonth === Infinity ? '∞' : plan.messagesPerMonth;
        const resetDate = tenant.month_reset_date ? new Date(tenant.month_reset_date).toLocaleDateString() : 'the 1st of next month';
        await sendMessage(phone,
          `📊 *Your Plan Details*\n\n` +
          `Plan: *${plan.name}*\n` +
          `Messages used: ${used} / ${limit}\n` +
          `Resets: ${resetDate}\n` +
          `Member since: ${new Date(tenant.created_at).toLocaleDateString()}`
        );
        return;
      }

      // ─── Upgrade Command ─────────────────────────────
      if (textLower === 'upgrade' || textLower === 'plans' || textLower === 'pricing') {
        const base = getConfig('app_base_url') || 'https://jarvisproject.ai';
        const plan = PLANS[tenant.plan || 'free'];
        const used = tenant.messages_this_month || 0;
        const limit = plan.messagesPerMonth === Infinity ? '∞' : plan.messagesPerMonth;
        await sendMessage(phone,
          `💎 *Jarvis Plans*\n\n` +
          `Your current plan: *${plan.name}* (${used}/${limit} messages used)\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n\n` +
          `🆓 *Free* — $0/month\n` +
          `• 50 messages/month\n` +
          `• Text & voice notes\n` +
          `• Basic memory\n\n` +
          `⚡ *Pro* — $9.99/month\n` +
          `• 500 messages/month\n` +
          `• Priority responses\n` +
          `• Full memory & reminders\n` +
          `• Document analysis\n` +
          `👉 ${base}/billing/checkout/pro?phone=${tenant.phone}\n\n` +
          `🚀 *Unlimited* — $24.99/month\n` +
          `• Unlimited messages\n` +
          `• Everything in Pro\n` +
          `• Daily briefings\n` +
          `• Priority support\n` +
          `👉 ${base}/billing/checkout/unlimited?phone=${tenant.phone}\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `Tap a link above to upgrade instantly.`
        );
        return;
      }

      // ─── Help Command ─────────────────────────────────
      if (textLower === 'reset' || textLower === 'start over' || textLower === 'restart') {
        // Clear conversation history but keep memory
        db.prepare('DELETE FROM conversations WHERE tenant_id = ?').run(tenant.id);
        await sendMessage(phone,
          "🔄 *Fresh start!* Conversation history cleared.\n\n" +
          "Your memories and files are still safe — I just forgot our recent chat.\n" +
          "What can I help you with?"
        );
        return;
      }

      if (textLower === 'help' || textLower === 'commands') {
        await sendMessage(phone,
          `🤖 *Jarvis — Full Command List*\n\n` +
          `🌐 *Web Search*\n` +
          `"What's happening in Trinidad today?"\n` +
          `"Search for flights to Miami"\n\n` +
          `🧠 *Memory*\n` +
          `"Remember my anniversary is June 15th"\n` +
          `"What did I tell you about John?"\n\n` +
          `⏰ *Reminders & Scheduling*\n` +
          `"Remind me to call Mom at 5pm"\n` +
          `"Set my daily briefing for 8am"\n` +
          `"Every Monday at 9am, send me a motivational quote"\n\n` +
          `🎤 *Voice*\n` +
          `Send a voice note — I'll transcribe and reply\n` +
          `"Send me a voice note saying good morning"\n\n` +
          `📞 *Phone Calls*\n` +
          `"Call me" — I'll ring your phone\n` +
          `"Call +1868..." — I'll call any number for you\n\n` +
          `🎨 *Images*\n` +
          `"Generate an image of a tropical beach"\n` +
          `Send me a photo — I'll describe what I see\n\n` +
          `📁 *Files & Notes*\n` +
          `"Write down my grocery list"\n` +
          `"Show me my saved files"\n\n` +
          `📇 *Contacts*\n` +
          `"Save John's number: +1868..."\n` +
          `"Text John: running 10 min late"\n\n` +
          `🌐 *Web Browsing*\n` +
          `"Go to wikipedia.com and read about Trinidad"\n` +
          `"Summarise this article: https://..."\n\n` +
          `📊 *usage* — Check your plan\n` +
          `💎 *upgrade* — View plans & pricing\n` +
          `🎭 *"Be more casual"* — Change my personality\n` +
          `🌍 *"Speak to me in Spanish"* — Switch language\n\n` +
          `Or just talk to me naturally — I understand context. 🤖`
        );
        return;
      }

      // ─── Billing Check ────────────────────────────────
      if (!canSendMessage(tenant)) {
        await sendMessage(phone, getUpgradeMessage(tenant));
        return;
      }
      incrementMessageCount(tenant.id);

      // Mark as read (blue ticks) immediately
      try { 
        await markAsRead(msg.messageId || msg.id);
        if (msg.messageId) await reactToMessage(phone, msg.messageId, '🤔');
      } catch(e) {}

      // ─── Process Message ──────────────────────────────
      try {
        let reply = await processMessage(phone, msg.name, text);
        // Remove thinking reaction
        if (msg.messageId) try { await reactToMessage(phone, msg.messageId, ''); } catch(e) {}
        if (reply) {
          // Usage widget
          const freshTenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenant.id);
          const used = freshTenant.messages_this_month || 0;
          const plan = PLANS[freshTenant.plan || 'free'];
          const limit = plan.messagesPerMonth;

          if (limit !== Infinity) {
            if (used % 10 === 0 && used > 0) {
              reply += `\n\n_📊 ${used}/${limit} messages this month_`;
            }
            if (used === 40 && (freshTenant.plan || 'free') === 'free') {
              const base = getConfig('app_base_url') || `http://localhost:${PORT}`;
              reply += `\n\n⚠️ _You have 10 messages remaining this month. Upgrade at ${base}/billing/checkout/pro?phone=${freshTenant.phone}_`;
            }
          }

          await sendMessage(phone, reply);
          console.log(`[OUT → ${phone}] ${reply.substring(0, 80)}...`);
        }
      } catch (err) {
        console.error('[ERROR]', err);
        logError(err.message, err.stack, { handler: 'message-processing', phone });
        await sendMessage(phone, "Something went wrong on my end. Try again in a moment. 🤖");
      }
      return;
    }

    // ─── Activation Code ──────────────────────────────────
    const codeMatch = text.match(/^\d{6}$/);
    if (codeMatch) {
      const code = codeMatch[0];
      const signup = db.prepare(
        "SELECT * FROM signups WHERE (phone = ? OR phone = ? OR phone = ?) AND activation_code = ? AND status = 'pending' AND expires_at > datetime('now')"
      ).get(phone, phone.replace(/^1/, ''), '1' + phone, code);

      if (signup) {
        db.prepare("UPDATE signups SET status = 'activated', activated_at = CURRENT_TIMESTAMP WHERE id = ?").run(signup.id);
        const newTenant = provisionTenant(phone, signup.name);
        db.prepare('UPDATE tenants SET email = ? WHERE id = ?').run(signup.email, newTenant.id);
        db.prepare("UPDATE tenants SET display_name = ?, onboarding_step = 'complete' WHERE id = ?").run(signup.name, newTenant.id);

        console.log(`[ACTIVATE] ${signup.name} (${phone}) → Tenant #${newTenant.id}`);
        sendWelcomeEmail(signup.email, signup.name).catch(() => {});

        await sendMessage(phone,
          `✅ *Jarvis online.* Welcome, ${signup.name}! 🤖\n\n` +
          `Your personal AI workspace is ready. Here's what I can do:\n\n` +
          `🌐 *Search the web* — "What's the latest news?"\n` +
          `🧠 *Remember anything* — "Remember my wifi password is..."\n` +
          `⏰ *Set reminders* — "Remind me to call Mom at 5pm"\n` +
          `🎤 *Voice notes* — Send me one, I'll reply with voice!\n` +
          `🎨 *Generate images* — "Draw me a sunset over the Caribbean"\n` +
          `📞 *Phone calls* — "Call me" and I'll ring your phone\n` +
          `📁 *Save notes* — "Write down my grocery list"\n\n` +
          `Just talk to me naturally — or type *help* for the full menu.`
        );

        // Send welcome voice note
        try {
          const welcomeVoice = `Welcome aboard, ${signup.name}! I'm Jarvis, your personal AI assistant. I can search the web, set reminders, make phone calls, generate images, send voice notes, and much more. Just talk to me like you would a friend. I'm here whenever you need me.`;
          const welcomeAudio = await transcribe.textToSpeech ? null : null;
          const { textToSpeech: tts } = require('./voice');
          const audioBuffer = await tts(welcomeVoice);
          if (audioBuffer) {
            await sendAudioMessage(phone, audioBuffer);
          }
        } catch (voiceErr) {
          console.error('[ACTIVATE] Welcome voice note failed:', voiceErr.message);
        }
        return;
      }

      const svcStatus = getConfig('service_status') || 'live';
      if (svcStatus === 'off') {
        await sendMessage(phone,
          "👋 Jarvis is currently in *private beta*. Visit jarvisproject.ai to join the waitlist! 🚀"
        );
      } else {
        await sendMessage(phone,
          "❌ That activation code is invalid or expired.\n\n" +
          "Visit our website to sign up and get a new code, then send it here to activate."
        );
      }
      return;
    }

    // ─── Unknown User ─────────────────────────────────────
    const serviceStatus = getConfig('service_status') || 'live';
    if (serviceStatus === 'off') {
      await sendMessage(phone,
        "👋 Hey! Jarvis is currently in *private beta*.\n\n" +
        "We're onboarding users in batches. Visit jarvisproject.ai to join the waitlist and be first in line when we open up! 🚀"
      );
    } else {
      await sendMessage(phone,
        "👋 Hey there! I'm Jarvis, a personal AI assistant.\n\n" +
        "To get started:\n" +
        "1️⃣ Visit our website and register\n" +
        "2️⃣ You'll get a 6-digit activation code\n" +
        "3️⃣ Send that code here to activate\n\n" +
        "Already have a code? Just send it now!"
      );
    }

  } catch (err) {
    logError(err.message, err.stack, { handler: 'webhook-post' });
  }
});

// ─── Voice Calls (Twilio) ───────────────────────────────────
app.use('/voice', callRouter);

// ─── Admin Console ──────────────────────────────────────────
app.use('/admin/api/login', authLimiter);
app.use('/admin/api', adminRouter);
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.get('/admin/*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

// ─── Health ─────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const tenants = db.prepare('SELECT COUNT(*) as c FROM tenants').get().c;
  const pendingSignups = db.prepare("SELECT COUNT(*) as c FROM signups WHERE status = 'pending'").get().c;
  res.json({ status: 'ok', uptime: process.uptime(), tenants, pendingSignups, timestamp: new Date().toISOString() });
});

// ─── Onboarding Handler ─────────────────────────────────────
async function handleOnboarding(tenant, phone, name, text) {
  const step = tenant.onboarding_step;
  const PRESETS = PERSONALITY_PRESETS;

  if (step === 'name') {
    // Accept their name, skip straight to personality choice
    const displayName = text.trim();
    db.prepare("UPDATE tenants SET display_name = ?, onboarding_step = 'personality' WHERE id = ?")
      .run(displayName, tenant.id);
    updateMemoryFile(tenant, 'About My Human', 'Preferred name: ' + displayName);

    const presetList = Object.entries(PRESETS).map(function(entry, i) {
      return '*' + (i + 1) + '.* ' + entry[1].name + ' — ' + entry[1].description;
    }).join('\n');

    await sendMessage(phone,
      'Welcome, ' + displayName + '! 🤝\n\n' +
      'Quick — pick a personality style (or say *skip* for default):\n\n' +
      presetList
    );

  } else if (step === 'personality') {
    const keys = Object.keys(PRESETS);
    const choice = parseInt(text.trim());
    var selectedKey;

    if (text.trim().toLowerCase() === 'skip') {
      selectedKey = 'default';
    } else if (choice >= 1 && choice <= keys.length) {
      selectedKey = keys[choice - 1];
    } else {
      // Not a valid choice — just default and move on, don't loop
      selectedKey = 'default';
    }

    const preset = PRESETS[selectedKey];
    const wsPath = tenant.workspace_path || getTenantDir(tenant.id);
    fs.writeFileSync(path.join(wsPath, 'SOUL.md'), preset.soul + '\n\n## User Customizations\n');

    db.prepare("UPDATE tenants SET onboarding_step = 'complete' WHERE id = ?").run(tenant.id);
    appendDailyNote(tenant, 'Onboarding complete. Personality: ' + preset.name);

    const displayName = tenant.display_name || name || 'boss';
    await sendMessage(phone,
      '*' + preset.name + '* mode activated. ✅\n\n' +
      "Here's what I can do, " + displayName + ':\n\n' +
      '🧠 *Total Recall* — Tell me anything. I never forget.\n' +
      '⏰ *Reminders* — "Remind me to call Mom at 5pm"\n' +
      '📋 *Lists* — Shopping, tasks, ideas — all sorted.\n' +
      '💬 *Draft & Think* — Brainstorm, write emails, plan.\n' +
      '🎤 *Voice Notes* — Send me voice notes, I\'ll reply with voice!\n' +
      '📊 *Daily Briefing* — "Set my briefing for 8am"\n' +
      '💎 *upgrade* — View plans & upgrade\n' +
      '❓ *help* — Show all commands\n\n' +
      'Try me — ask anything or send a voice note!'
    );

  } else {
    // Unknown step — auto-complete onboarding and process as normal message
    db.prepare("UPDATE tenants SET onboarding_step = 'complete' WHERE id = ?").run(tenant.id);
    return false; // Signal to caller to process as normal message
  }
  return true;
}

// ─── Start ──────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  🤖 JARVIS — Multi-Tenant AI Assistant');
  console.log('  ─────────────────────────────────────');
  console.log(`  🌐 Landing Page     : http://0.0.0.0:${PORT}`);
  console.log(`  📱 WhatsApp Webhook : http://0.0.0.0:${PORT}/webhook`);
  console.log(`  🔧 Admin Console    : http://0.0.0.0:${PORT}/admin`);
  console.log(`  📞 Voice Calls      : http://0.0.0.0:${PORT}/voice/incoming`);
  console.log(`  🖥️  User Dashboard  : http://0.0.0.0:${PORT}/dashboard`);
  console.log(`  💚 Health Check     : http://0.0.0.0:${PORT}/health`);
  console.log('');
  startReminderChecker();
  startBriefingChecker();
  startBackupScheduler();
  startWinbackChecker();
});

// Start heartbeat system
try { ensureTables(); startHeartbeat(); } catch(e) { console.error("[HEARTBEAT] Failed to start:", e.message); }


// ─── Voice verification webhook (for Meta) ──────────────────
app.post('/voice/verify', (req, res) => {
  console.log('[VOICE-VERIFY] Incoming call from:', req.body.From);
  // Record the call so we can hear the code
  res.type('text/xml').send(`
    <Response>
      <Pause length="2"/>
      <Record maxLength="30" action="/voice/verify-done" transcribe="true" transcribeCallback="/voice/verify-transcribe"/>
    </Response>
  `);
});

app.post('/voice/verify-done', (req, res) => {
  console.log('[VOICE-VERIFY] Recording done:', req.body.RecordingUrl);
  res.type('text/xml').send('<Response><Say>Thank you.</Say></Response>');
});

app.post('/voice/verify-transcribe', (req, res) => {
  console.log('[VOICE-VERIFY] Transcription:', req.body.TranscriptionText);
  res.sendStatus(200);
});


// SMS verification endpoint
app.post("/sms/verify", (req, res) => {
  console.log("[SMS-VERIFY] From:", req.body.From, "Body:", req.body.Body);
  res.type("text/xml").send("<Response></Response>");
});
// ─── Twilio SMS webhook (for Meta verification) ─────────────
app.post('/sms/incoming', (req, res) => {
  console.log('[SMS]', JSON.stringify(req.body));
  res.type('text/xml').send('<Response></Response>');
});
