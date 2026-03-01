require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
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
const { processAttachment } = require('./documents');
const { router: billingRouter, canSendMessage, incrementMessageCount, getUpgradeMessage } = require('./billing');
const { startBriefingChecker } = require('./briefings');
const dashboardApiRouter = require('./dashboard-api');
const { updateMemoryFile, updateSoulFile, appendDailyNote } = require('./tenant');
const { publicLimiter, authLimiter, signupPhoneLimiter } = require('./ratelimit');
const { logError, installGlobalHandlers } = require('./monitor');
const { startBackupScheduler } = require('./backup');
const { sendWelcomeEmail } = require('./email');
const { startWinbackChecker } = require('./winback');
const { PERSONALITY_PRESETS } = require('./tenant');
const QRCode = require('qrcode');

// ─── Global Error Handlers ──────────────────────────────────
installGlobalHandlers();

// ─── Onboarding Migration ───────────────────────────────────
const tenantCols = db.prepare("PRAGMA table_info(tenants)").all().map(c => c.name);
if (!tenantCols.includes('onboarding_step')) db.exec("ALTER TABLE tenants ADD COLUMN onboarding_step TEXT");

const app = express();
const PORT = process.env.PORT || 3003;

app.use(cors());

// ─── Raw body capture for webhook signature verification ────
app.use('/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  // Store raw body for HMAC verification, then parse JSON
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

// ─── Billing ────────────────────────────────────────────────
app.use('/billing', billingRouter);

// ─── User Dashboard ─────────────────────────────────────────
app.use('/dashboard/api/login', authLimiter);
app.use('/dashboard/api', dashboardApiRouter);
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html')));
app.get('/dashboard/*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html')));

// ─── WhatsApp Webhook ───────────────────────────────────────
app.get('/webhook', verifyWebhook);

// Webhook signature verification + rate limiting
let _appSecretWarned = false;
app.post('/webhook', publicLimiter, (req, res, next) => {
  // Verify Meta webhook signature if app_secret is configured
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

  // Handle images
  if (msg.type === 'image' && msg.imageId) {
    console.log(`[DOC] Image from ${phone}`);
    const tenant = db.prepare('SELECT * FROM tenants WHERE phone = ? AND status = ?').get(phone, 'active');
    if (!tenant) {
      await sendMessage(phone, "You need to activate first before I can analyze images. Send your 6-digit code to get started.");
      return;
    }
    await sendMessage(phone, "🔍 Analyzing your image...");
    const result = await processAttachment(msg.imageId, msg.imageMime, msg.text);
    if (result.text) {
      const contextMsg = msg.text
        ? `[User sent an image with caption: "${msg.text}"]\n\nImage analysis:\n${result.text}`
        : `[User sent an image]\n\nImage analysis:\n${result.text}`;
      const reply = await processMessage(phone, msg.name, contextMsg);
      if (reply) await sendMessage(phone, reply);
    } else {
      await sendMessage(phone, "I couldn't analyze that image. Try sending it again?");
    }
    return;
  }

  // Handle documents (PDF, Word, etc.)
  if (msg.type === 'document' && msg.documentId) {
    console.log(`[DOC] Document from ${phone}: ${msg.documentName} (${msg.documentMime})`);
    const tenant = db.prepare('SELECT * FROM tenants WHERE phone = ? AND status = ?').get(phone, 'active');
    if (!tenant) {
      await sendMessage(phone, "You need to activate first before I can read documents. Send your 6-digit code to get started.");
      return;
    }
    await sendMessage(phone, `📄 Reading "${msg.documentName || 'document'}"...`);
    const result = await processAttachment(msg.documentId, msg.documentMime, msg.text);
    if (result.text) {
      const contextMsg = msg.text
        ? `[User sent a ${result.type} document: "${msg.documentName}". Caption: "${msg.text}"]\n\nExtracted content:\n${result.text}`
        : `[User sent a ${result.type} document: "${msg.documentName}"]\n\nExtracted content:\n${result.text}`;
      const reply = await processMessage(phone, msg.name, contextMsg);
      if (reply) await sendMessage(phone, reply);
    } else if (result.type === 'unknown') {
      await sendMessage(phone, `I can't read that file type yet (${result.mimeType}). I support PDFs, Word documents (.docx), images, and text files.`);
    } else {
      await sendMessage(phone, "I had trouble reading that document. The file might be corrupted or password-protected.");
    }
    return;
  }

  if (msg.type !== 'text') {
    await sendMessage(msg.from, "I can handle text, voice notes, images, and documents (PDF/Word). Send me one of those! 🤖");
    return;
  }

  const phone = msg.from;
  const text = msg.text.trim();

  console.log(`[IN] ${phone} (${msg.name}): ${text}`);
  markAsRead(msg.messageId);

  // Check if this is an active tenant
  const tenant = db.prepare('SELECT * FROM tenants WHERE phone = ? AND status = ?').get(phone, 'active');

  if (tenant) {
    // ─── Onboarding Flow ──────────────────────────────────
    if (tenant.onboarding_step && tenant.onboarding_step !== 'complete') {
      try {
        await handleOnboarding(tenant, phone, msg.name, text);
      } catch (err) {
        console.error('[ONBOARDING ERROR]', err);
        await sendMessage(phone, "Something went wrong. Let's try that again — just re-type your answer.");
      }
      return;
    }

    // ─── Usage / Plan Command ────────────────────────────
    const textLower = text.toLowerCase();
    if (textLower === 'usage' || textLower === 'my plan') {
      const plan = require('./billing').PLANS[tenant.plan || 'free'];
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

    // ─── Billing Check ───────────────────────────────────
    if (!canSendMessage(tenant)) {
      await sendMessage(phone, getUpgradeMessage(tenant));
      return;
    }
    incrementMessageCount(tenant.id);

    // Active tenant — process normally
    try {
      let reply = await processMessage(phone, msg.name, text);
      if (reply) {
        // ─── Usage Widget ────────────────────────────────
        const freshTenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenant.id);
        const used = freshTenant.messages_this_month || 0;
        const plan = require('./billing').PLANS[freshTenant.plan || 'free'];
        const limit = plan.messagesPerMonth;

        if (limit !== Infinity) {
          // Every 10th message: show usage
          if (used % 10 === 0 && used > 0) {
            reply += `\n\n_📊 ${used}/${limit} messages this month_`;
          }
          // At 40 messages on free plan (10 remaining): warn
          if (used === 40 && (freshTenant.plan || 'free') === 'free') {
            const base = require('./whatsapp').getConfig('app_base_url') || `http://localhost:${process.env.PORT || 3003}`;
            reply += `\n\n⚠️ _You have 10 messages remaining this month. Upgrade at ${base}/billing/checkout/pro?phone=${freshTenant.phone}_`;
          }
        }

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

      // Start onboarding
      db.prepare("UPDATE tenants SET onboarding_step = 'name' WHERE id = ?").run(newTenant.id);

      console.log(`[ACTIVATE] ${signup.name} (${phone}) → Tenant #${newTenant.id}`);
      sendWelcomeEmail(signup.email, signup.name).catch(() => {});

      await sendMessage(phone,
        `✅ *Jarvis online.* Welcome, ${signup.name}.\n\n` +
        `Your personal AI workspace has been provisioned. Let me get to know you — just 3 quick questions.\n\n` +
        `First: *What should I call you?* (A name, nickname, whatever you prefer)`
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

  if (step === 'name') {
    const displayName = text.trim();
    db.prepare("UPDATE tenants SET display_name = ?, onboarding_step = 'work' WHERE id = ?")
      .run(displayName, tenant.id);
    updateMemoryFile(tenant, 'About My Human', `Preferred name: ${displayName}`);
    await sendMessage(phone, `Nice to meet you, ${displayName}. 🤝\n\nNext: *What do you do for work?* (Or just say "skip" if you'd rather not say)`);
  } else if (step === 'work') {
    const work = text.trim().toLowerCase() === 'skip' ? null : text.trim();
    db.prepare("UPDATE tenants SET onboarding_step = 'goals' WHERE id = ?").run(tenant.id);
    if (work) {
      updateMemoryFile(tenant, 'About My Human', `Work: ${work}`);
    }
    await sendMessage(phone, `${work ? 'Got it.' : 'No problem.'}\n\nLast one: *What's the main thing you want me to help with?*\n\n(Productivity, reminders, brainstorming, daily planning — anything goes)`);
  } else if (step === 'goals') {
    const goal = text.trim();
    db.prepare("UPDATE tenants SET onboarding_step = 'personality' WHERE id = ?").run(tenant.id);
    updateMemoryFile(tenant, 'About My Human', `Primary goal: ${goal}`);
    updateSoulFile(tenant, `User's primary use case: ${goal}. Prioritize this in suggestions and proactive help.`);
    appendDailyNote(tenant, `Goal set: ${goal}`);

    const presetList = Object.entries(PERSONALITY_PRESETS).map(([key, val], i) =>
      `*${i + 1}.* ${val.name} — ${val.description}`
    ).join('\n');

    await sendMessage(phone,
      `Great! Last thing — pick a personality style:\n\n${presetList}\n\nJust send the number (1-6).`
    );
  } else if (step === 'personality') {
    const choice = parseInt(text.trim());
    const keys = Object.keys(PERSONALITY_PRESETS);
    const selectedKey = (choice >= 1 && choice <= keys.length) ? keys[choice - 1] : 'default';
    const preset = PERSONALITY_PRESETS[selectedKey];

    // Write the chosen personality to SOUL.md
    const wsPath = tenant.workspace_path || require('./tenant').getTenantDir(tenant.id);
    const fs = require('fs');
    const path = require('path');
    fs.writeFileSync(path.join(wsPath, 'SOUL.md'), preset.soul + '\n\n## User Customizations\n');

    db.prepare("UPDATE tenants SET onboarding_step = 'complete' WHERE id = ?").run(tenant.id);
    appendDailyNote(tenant, `Onboarding complete. Personality: ${preset.name}`);

    const displayName = tenant.display_name || name || 'boss';
    await sendMessage(phone,
      `${preset.name} mode activated. ✅\n\n` +
      `Here's what I can do, ${displayName}:\n\n` +
      `🧠 *Total Recall* — Tell me anything. I never forget.\n` +
      `⏰ *Reminders* — "Remind me to call Mom at 5pm"\n` +
      `📋 *Lists & Organization* — Shopping, tasks, ideas — all sorted.\n` +
      `💬 *Draft & Think* — Brainstorm, write emails, plan projects.\n` +
      `📊 *Daily Briefing* — "Set my daily briefing for 8am"\n` +
      `📨 *Sharing* — "Send my grocery list to +1868..."\n\n` +
      `Everything is private — your own isolated workspace.\n\n` +
      `I'm yours to customize anytime. Just say "be more casual", "speak French", or whatever suits you.\n\n` +
      `What can I help you with first?`
    );
  }
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
  console.log(`  💚 Health Check     : http://0.0.0.0:${PORT}/health`);
  console.log('');
  startReminderChecker();
  startBriefingChecker();
  startBackupScheduler();
  startWinbackChecker();
});
