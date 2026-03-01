const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const path = require('path');
const fs = require('fs');

const router = express.Router();
const JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'change-me-in-production';

// Initialize default admin
function initAdmin() {
  const count = db.prepare('SELECT COUNT(*) as c FROM admin_users').get().c;
  if (count === 0) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASS || 'admin123', 10);
    db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)').run(
      process.env.ADMIN_USER || 'admin', hash
    );
    console.log('👤 Default admin user created');
  }
}
initAdmin();

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, username: user.username });
});

// Dashboard stats
router.get('/stats', auth, (req, res) => {
  const tenants = db.prepare('SELECT COUNT(*) as c FROM tenants').get().c;
  const active = db.prepare("SELECT COUNT(*) as c FROM tenants WHERE last_active > datetime('now', '-1 day')").get().c;
  const memories = db.prepare('SELECT COUNT(*) as c FROM memories').get().c;
  const reminders = db.prepare('SELECT COUNT(*) as c FROM reminders WHERE sent = 0').get().c;
  const conversations = db.prepare('SELECT COUNT(*) as c FROM conversations').get().c;
  const pendingSignups = db.prepare("SELECT COUNT(*) as c FROM signups WHERE status = 'pending' AND expires_at > datetime('now')").get().c;
  const todayTokens = db.prepare("SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as t FROM usage_log WHERE created_at > datetime('now', '-1 day')").get().t;
  const totalTokens = db.prepare('SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as t FROM usage_log').get().t;
  res.json({ tenants, active, memories, reminders, conversations, pendingSignups, todayTokens, totalTokens });
});

// Tenants list
router.get('/tenants', auth, (req, res) => {
  const tenants = db.prepare('SELECT * FROM tenants ORDER BY last_active DESC LIMIT 200').all();
  res.json(tenants);
});

// Single tenant detail
router.get('/tenants/:id', auth, (req, res) => {
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'Not found' });

  const memories = db.prepare('SELECT * FROM memories WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50').all(tenant.id);
  const reminders = db.prepare('SELECT * FROM reminders WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50').all(tenant.id);
  const conversations = db.prepare('SELECT * FROM conversations WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100').all(tenant.id);
  const usage = db.prepare('SELECT COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(output_tokens),0) as output FROM usage_log WHERE tenant_id = ?').get(tenant.id);

  // Read workspace files
  let soul = '', memory = '';
  if (tenant.workspace_path) {
    try { soul = fs.readFileSync(path.join(tenant.workspace_path, 'SOUL.md'), 'utf8'); } catch {}
    try { memory = fs.readFileSync(path.join(tenant.workspace_path, 'MEMORY.md'), 'utf8'); } catch {}
  }

  res.json({ ...tenant, memories, reminders, conversations, usage, soul, memory });
});

// Update tenant
router.put('/tenants/:id', auth, (req, res) => {
  const { status, model, max_tokens, display_name, system_prompt } = req.body;
  const sets = [];
  const vals = [];

  if (status) { sets.push('status = ?'); vals.push(status); }
  if (model) { sets.push('model = ?'); vals.push(model); }
  if (max_tokens) { sets.push('max_tokens = ?'); vals.push(max_tokens); }
  if (display_name) { sets.push('display_name = ?'); vals.push(display_name); }
  if (system_prompt !== undefined) { sets.push('system_prompt = ?'); vals.push(system_prompt); }

  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  vals.push(req.params.id);
  db.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ success: true });
});

// Update tenant workspace files
router.put('/tenants/:id/files', auth, (req, res) => {
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!tenant || !tenant.workspace_path) return res.status(404).json({ error: 'Not found' });

  const { soul, memory } = req.body;
  if (soul !== undefined) fs.writeFileSync(path.join(tenant.workspace_path, 'SOUL.md'), soul);
  if (memory !== undefined) fs.writeFileSync(path.join(tenant.workspace_path, 'MEMORY.md'), memory);
  res.json({ success: true });
});

// Config / API Keys
router.get('/config', auth, (req, res) => {
  const configs = db.prepare('SELECT * FROM config ORDER BY key').all();
  const masked = configs.map(c => ({
    ...c,
    display_value: c.key.includes('key') || c.key.includes('token') || c.key.includes('secret') || c.key.includes('pass')
      ? c.value.slice(0, 8) + '···' + c.value.slice(-4)
      : c.value,
    value: c.value
  }));
  res.json(masked);
});

router.put('/config', auth, (req, res) => {
  const { key, value } = req.body;
  if (!key || !value) return res.status(400).json({ error: 'Key and value required' });
  db.prepare('INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run(key, value);
  res.json({ success: true, key });
});

router.delete('/config/:key', auth, (req, res) => {
  db.prepare('DELETE FROM config WHERE key = ?').run(req.params.key);
  res.json({ success: true });
});

// Signups
router.get('/signups', auth, (req, res) => {
  const signups = db.prepare('SELECT * FROM signups ORDER BY created_at DESC LIMIT 200').all();
  res.json(signups);
});

router.delete('/signups/:id', auth, (req, res) => {
  db.prepare('DELETE FROM signups WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Manually create activation code (admin-generated)
router.post('/signups/generate', auth, (req, res) => {
  const { name, email, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });
  const crypto = require('crypto');
  const code = crypto.randomInt(100000, 999999).toString();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days for admin-generated
  const normalizedPhone = phone.replace(/[^\d]/g, '');
  db.prepare('INSERT INTO signups (name, email, phone, activation_code, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, email || '', normalizedPhone, code, expiresAt);
  res.json({ success: true, code, expires_at: expiresAt });
});

// Usage stats
router.get('/usage', auth, (req, res) => {
  const daily = db.prepare(`
    SELECT date(created_at) as day, SUM(input_tokens) as input, SUM(output_tokens) as output, COUNT(*) as requests
    FROM usage_log
    WHERE created_at > datetime('now', '-30 days')
    GROUP BY date(created_at)
    ORDER BY day DESC
  `).all();
  res.json(daily);
});

// Analytics
router.get('/analytics', auth, (req, res) => {
  // Message volume (last 30 days)
  const messageVolume = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as count
    FROM conversations WHERE created_at > datetime('now', '-30 days')
    GROUP BY date(created_at) ORDER BY day
  `).all();

  // Retention: users active in last 7 days vs total
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM tenants').get().c;
  const active7d = db.prepare("SELECT COUNT(*) as c FROM tenants WHERE last_active > datetime('now', '-7 days')").get().c;
  const active30d = db.prepare("SELECT COUNT(*) as c FROM tenants WHERE last_active > datetime('now', '-30 days')").get().c;

  // Cost per user (tokens)
  const costPerUser = db.prepare(`
    SELECT t.id, t.name, t.phone, COALESCE(SUM(u.input_tokens + u.output_tokens), 0) as total_tokens
    FROM tenants t LEFT JOIN usage_log u ON t.id = u.tenant_id
    GROUP BY t.id ORDER BY total_tokens DESC LIMIT 20
  `).all();

  // Top users by messages
  const topUsers = db.prepare(`
    SELECT t.id, t.name, t.phone, t.message_count, t.plan, t.last_active
    FROM tenants t ORDER BY t.message_count DESC LIMIT 20
  `).all();

  // Revenue
  const planCounts = db.prepare(`
    SELECT plan, COUNT(*) as count FROM tenants GROUP BY plan
  `).all();

  const revenue = planCounts.reduce((sum, p) => {
    if (p.plan === 'pro') return sum + p.count * 9.99;
    if (p.plan === 'unlimited') return sum + p.count * 24.99;
    return sum;
  }, 0);

  // New signups per day
  const signupVolume = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as count
    FROM signups WHERE created_at > datetime('now', '-30 days')
    GROUP BY date(created_at) ORDER BY day
  `).all();

  res.json({
    messageVolume, totalUsers, active7d, active30d,
    retention7d: totalUsers ? (active7d / totalUsers * 100).toFixed(1) : 0,
    retention30d: totalUsers ? (active30d / totalUsers * 100).toFixed(1) : 0,
    costPerUser, topUsers, planCounts, revenue: revenue.toFixed(2),
    signupVolume
  });
});

// ─── Error Monitoring ────────────────────────────────────────
const { getRecentErrors, getHourlyCounts } = require('./monitor');

router.get('/errors', auth, (req, res) => {
  const errors = getRecentErrors(100);
  const hourlyCounts = getHourlyCounts();
  res.json({ errors, hourlyCounts });
});

// ─── Backup Management ──────────────────────────────────────
const { listBackups, createBackup: runBackup } = require('./backup');

router.get('/backups', auth, (req, res) => {
  res.json(listBackups());
});

router.post('/backups/now', auth, (req, res) => {
  const filename = runBackup();
  if (filename) res.json({ success: true, filename });
  else res.status(500).json({ error: 'Backup failed' });
});

// Change password
router.put('/password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.admin.id);
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), user.id);
  res.json({ success: true });
});

// Serve admin UI
router.use('/', express.static(path.join(__dirname, '..', 'public')));

module.exports = router;
