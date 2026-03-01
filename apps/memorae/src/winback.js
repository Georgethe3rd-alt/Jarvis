// ─── Win-back / Welcome Back Messages ───────────────────────
// Checks hourly for active tenants who haven't messaged in 3+ days.
// Sends a personalized check-in. Only once per inactive period.

const db = require('./db');
const { sendMessage } = require('./whatsapp');

// ─── DB Migration ───────────────────────────────────────────
function migrateWinback() {
  const cols = db.prepare("PRAGMA table_info(tenants)").all().map(c => c.name);
  if (!cols.includes('last_winback_sent')) {
    db.exec("ALTER TABLE tenants ADD COLUMN last_winback_sent DATETIME");
  }
}
migrateWinback();

async function checkWinbacks() {
  const now = new Date();
  const hour = now.getUTCHours();

  // Don't send between 10pm-8am UTC
  if (hour >= 22 || hour < 8) return;

  // Find active tenants who haven't messaged in 3+ days
  // and either never got a winback, or got one before their last activity
  const tenants = db.prepare(`
    SELECT t.*, 
      (SELECT COUNT(*) FROM reminders WHERE tenant_id = t.id AND sent = 0) as pending_reminders
    FROM tenants t
    WHERE t.status = 'active'
      AND t.last_active < datetime('now', '-3 days')
      AND (t.last_winback_sent IS NULL OR t.last_winback_sent < t.last_active)
  `).all();

  for (const tenant of tenants) {
    try {
      const name = tenant.display_name || tenant.name || 'there';
      const reminderNote = tenant.pending_reminders > 0
        ? ` You have ${tenant.pending_reminders} pending reminder${tenant.pending_reminders > 1 ? 's' : ''}.`
        : '';

      const message = `Hey ${name}, it's been a few days! 👋 Anything I can help with?${reminderNote}`;

      await sendMessage(tenant.phone, message);
      db.prepare('UPDATE tenants SET last_winback_sent = CURRENT_TIMESTAMP WHERE id = ?').run(tenant.id);
      console.log(`[WINBACK] Sent to ${tenant.phone} (${name})`);
    } catch (err) {
      console.error(`[WINBACK ERROR] Tenant #${tenant.id}:`, err.message);
    }
  }
}

let winbackInterval = null;

function startWinbackChecker() {
  // Check every hour
  winbackInterval = setInterval(() => {
    checkWinbacks().catch(err => console.error('[WINBACK]', err.message));
  }, 60 * 60 * 1000);

  // Also run once on startup (after a short delay)
  setTimeout(() => {
    checkWinbacks().catch(err => console.error('[WINBACK]', err.message));
  }, 30000);

  console.log('👋 Win-back checker started (hourly)');
}

module.exports = { startWinbackChecker };
