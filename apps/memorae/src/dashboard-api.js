const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { sendMessage, getConfig } = require('./whatsapp');
const { setBriefingTime } = require('./briefings');
const { PLANS } = require('./billing');

const router = express.Router();
const JWT_SECRET = process.env.DASHBOARD_JWT_SECRET || process.env.ADMIN_JWT_SECRET || 'dashboard-secret';

// Store pending login codes in memory (phone → {code, expires})
const pendingLogins = new Map();

// ─── Auth Middleware ─────────────────────────────────────────
function userAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── Login: Request Code ────────────────────────────────────
router.post('/login/request', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });

  const normalized = phone.replace(/[^\d]/g, '');
  const tenant = db.prepare("SELECT * FROM tenants WHERE phone = ? AND status = 'active'").get(normalized);
  if (!tenant) return res.status(404).json({ error: 'No account found for this number' });

  const code = crypto.randomInt(100000, 999999).toString();
  pendingLogins.set(normalized, { code, expires: Date.now() + 5 * 60 * 1000 });

  await sendMessage(normalized, `🔐 Your Jarvis dashboard login code: *${code}*\n\nThis code expires in 5 minutes.`);
  res.json({ success: true, message: 'Code sent via WhatsApp' });
});

// ─── Login: Verify Code ─────────────────────────────────────
router.post('/login/verify', (req, res) => {
  const { phone, code } = req.body;
  const normalized = phone.replace(/[^\d]/g, '');
  const pending = pendingLogins.get(normalized);

  if (!pending || pending.code !== code || Date.now() > pending.expires) {
    return res.status(401).json({ error: 'Invalid or expired code' });
  }

  pendingLogins.delete(normalized);
  const tenant = db.prepare("SELECT * FROM tenants WHERE phone = ? AND status = 'active'").get(normalized);
  if (!tenant) return res.status(404).json({ error: 'Account not found' });

  const token = jwt.sign({ tenantId: tenant.id, phone: normalized }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, name: tenant.display_name || tenant.name });
});

// ─── Profile ─────────────────────────────────────────────────
router.get('/profile', userAuth, (req, res) => {
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.user.tenantId);
  if (!tenant) return res.status(404).json({ error: 'Not found' });
  const plan = PLANS[tenant.plan || 'free'];
  res.json({
    name: tenant.display_name || tenant.name,
    phone: tenant.phone,
    plan: tenant.plan || 'free',
    planLabel: plan?.label || 'Free',
    messagesUsed: tenant.messages_this_month || 0,
    messagesLimit: plan?.messagesPerMonth === Infinity ? null : plan?.messagesPerMonth,
    planExpiresAt: tenant.plan_expires_at,
    briefingTime: tenant.preferred_briefing_time,
    memberSince: tenant.created_at
  });
});

// ─── Memories ────────────────────────────────────────────────
router.get('/memories', userAuth, (req, res) => {
  const memories = db.prepare('SELECT * FROM memories WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100')
    .all(req.user.tenantId);
  res.json(memories);
});

router.put('/memories/:id', userAuth, (req, res) => {
  const { content, category } = req.body;
  db.prepare('UPDATE memories SET content = ?, category = ? WHERE id = ? AND tenant_id = ?')
    .run(content, category, req.params.id, req.user.tenantId);
  res.json({ success: true });
});

router.delete('/memories/:id', userAuth, (req, res) => {
  db.prepare('DELETE FROM memories WHERE id = ? AND tenant_id = ?').run(req.params.id, req.user.tenantId);
  res.json({ success: true });
});

// ─── Reminders ───────────────────────────────────────────────
router.get('/reminders', userAuth, (req, res) => {
  const reminders = db.prepare('SELECT * FROM reminders WHERE tenant_id = ? ORDER BY remind_at ASC LIMIT 100')
    .all(req.user.tenantId);
  res.json(reminders);
});

router.delete('/reminders/:id', userAuth, (req, res) => {
  db.prepare('DELETE FROM reminders WHERE id = ? AND tenant_id = ?').run(req.params.id, req.user.tenantId);
  res.json({ success: true });
});

// ─── Conversations ───────────────────────────────────────────
router.get('/conversations', userAuth, (req, res) => {
  const conversations = db.prepare(
    'SELECT * FROM conversations WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200'
  ).all(req.user.tenantId);
  res.json(conversations);
});

// ─── Settings ────────────────────────────────────────────────
router.put('/settings/briefing', userAuth, (req, res) => {
  const { time } = req.body;
  if (!time) return res.status(400).json({ error: 'Time required' });
  const formatted = setBriefingTime(req.user.tenantId, time);
  if (!formatted) return res.status(400).json({ error: 'Invalid time format' });
  res.json({ success: true, briefingTime: formatted });
});

router.put('/settings/name', userAuth, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  db.prepare('UPDATE tenants SET display_name = ? WHERE id = ?').run(name, req.user.tenantId);
  res.json({ success: true });
});

module.exports = router;
