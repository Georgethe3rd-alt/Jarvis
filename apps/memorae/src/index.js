require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Ensure directories
['data', 'data/tenants', 'public'].forEach(d => {
  const p = path.join(__dirname, '..', d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

const { verifyWebhook, parseWebhook, sendMessage, markAsRead } = require('./whatsapp');
const { processMessage } = require('./ai');
const adminRouter = require('./admin');
const { startReminderChecker } = require('./reminders');

const app = express();
const PORT = process.env.PORT || 3003;

app.use(cors());
app.use(express.json());

// ─── WhatsApp Webhook ───────────────────────────────────────
app.get('/webhook', verifyWebhook);

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Always respond fast

  const msg = parseWebhook(req.body);
  if (!msg || !msg.text) return;

  // Only handle text messages for now
  if (msg.type !== 'text') {
    await sendMessage(msg.from, "I can read text messages for now — voice and images coming soon! 🤖");
    return;
  }

  console.log(`[IN] ${msg.from} (${msg.name}): ${msg.text}`);
  markAsRead(msg.messageId);

  try {
    const reply = await processMessage(msg.from, msg.name, msg.text);
    if (reply) {
      await sendMessage(msg.from, reply);
      console.log(`[OUT → ${msg.from}] ${reply.substring(0, 80)}...`);
    }
  } catch (err) {
    console.error('[ERROR]', err);
    await sendMessage(msg.from, "Something went wrong on my end. Try again in a moment. 🤖");
  }
});

// ─── Admin Console ──────────────────────────────────────────
app.use('/admin/api', adminRouter);
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.get('/admin/*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

// ─── Health ─────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const db = require('./db');
  const tenants = db.prepare('SELECT COUNT(*) as c FROM tenants').get().c;
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    tenants,
    timestamp: new Date().toISOString()
  });
});

// ─── Start ──────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  🤖 JARVIS — Multi-Tenant AI Assistant');
  console.log('  ─────────────────────────────────────');
  console.log(`  📱 WhatsApp Webhook : http://0.0.0.0:${PORT}/webhook`);
  console.log(`  🔧 Admin Console    : http://0.0.0.0:${PORT}/admin`);
  console.log(`  💚 Health Check     : http://0.0.0.0:${PORT}/health`);
  console.log('');
  startReminderChecker();
});
