const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const { sendActivationCode } = require('./email');

const router = express.Router();

function generateCode() {
  return crypto.randomInt(100000, 999999).toString();
}

function normalizePhone(phone) {
  // Strip everything except digits and leading +
  let p = phone.replace(/[^\d+]/g, '');
  if (!p.startsWith('+')) p = '+' + p;
  // Remove the + for storage (WhatsApp uses plain digits)
  return p.replace('+', '');
}

// Sign up — generate activation code
router.post('/register', (req, res) => {
  // Check service status
    const db2 = require('./db');
    const svcRow = db2.prepare("SELECT value FROM config WHERE key = 'service_status'").get();
    if (svcRow && svcRow.value === 'off') {
      return res.status(503).json({ error: 'Jarvis is currently in private beta. Join the waitlist!' });
    }
    const { name, email, phone } = req.body;

  if (!name || !email || !phone) {
    return res.status(400).json({ error: 'Name, email, and phone number are required.' });
  }

  const normalizedPhone = normalizePhone(phone);

  // Check if already an active tenant
  const existing = db.prepare('SELECT * FROM tenants WHERE phone = ? AND status = ?').get(normalizedPhone, 'active');
  if (existing) {
    return res.status(409).json({ error: 'This phone number is already registered and active.' });
  }

  // Check for existing pending signup (not expired)
  const pending = db.prepare(
    "SELECT * FROM signups WHERE phone = ? AND status = 'pending' AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
  ).get(normalizedPhone);

  if (pending) {
    // Return existing code
    return res.json({
      success: true,
      message: 'You already have a pending activation. Check your previous code or use the one below.',
      activation_code: pending.activation_code,
      expires_at: pending.expires_at
    });
  }

  // Generate new code
  const code = generateCode();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h

  db.prepare(
    'INSERT INTO signups (name, email, phone, activation_code, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(name, email, normalizedPhone, code, expiresAt);

  console.log(`[SIGNUP] ${name} (${email}) phone:${normalizedPhone} code:${code}`);

  // Send activation code via email (non-blocking, best-effort)
  sendActivationCode(email, name, code).catch(() => {});

  res.json({
    success: true,
    activation_code: code,
    expires_at: expiresAt,
    message: `Your activation code is ${code}. Send this code to our WhatsApp number to activate your Jarvis assistant.`
  });
});

// Check signup status
router.get('/status/:phone', (req, res) => {
  const phone = normalizePhone(req.params.phone);
  const tenant = db.prepare('SELECT id, name, status, plan, created_at FROM tenants WHERE phone = ?').get(phone);
  if (tenant) {
    return res.json({ registered: true, active: tenant.status === 'active', tenant });
  }

  const signup = db.prepare(
    "SELECT status, activation_code, expires_at FROM signups WHERE phone = ? ORDER BY created_at DESC LIMIT 1"
  ).get(phone);

  if (signup) {
    return res.json({ registered: false, signup });
  }

  res.json({ registered: false, signup: null });
});

module.exports = { router, normalizePhone, generateCode };
