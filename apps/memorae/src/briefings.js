const db = require('./db');
const { sendMessage } = require('./whatsapp');
const { processMessage } = require('./ai');

// ─── DB Migration ───────────────────────────────────────────
function migrateBriefings() {
  const cols = db.prepare("PRAGMA table_info(tenants)").all().map(c => c.name);
  if (!cols.includes('preferred_briefing_time')) db.exec("ALTER TABLE tenants ADD COLUMN preferred_briefing_time TEXT");
}
migrateBriefings();

// ─── Set Briefing Time ──────────────────────────────────────
function setBriefingTime(tenantId, timeStr) {
  // Parse "8am", "08:00", "8:30pm", etc.
  let hours, minutes = 0;
  const match = timeStr.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)?/i);
  if (!match) return null;

  hours = parseInt(match[1]);
  if (match[2]) minutes = parseInt(match[2]);
  if (match[3]) {
    const period = match[3].toLowerCase();
    if (period === 'pm' && hours !== 12) hours += 12;
    if (period === 'am' && hours === 12) hours = 0;
  }

  const formatted = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  db.prepare('UPDATE tenants SET preferred_briefing_time = ? WHERE id = ?').run(formatted, tenantId);
  return formatted;
}

// ─── Briefing Checker (runs every minute) ───────────────────
let lastCheckedMinute = null;

function startBriefingChecker() {
  setInterval(() => {
    const now = new Date();
    const currentMinute = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // Only check once per minute
    if (currentMinute === lastCheckedMinute) return;
    lastCheckedMinute = currentMinute;

    const tenants = db.prepare(
      "SELECT * FROM tenants WHERE preferred_briefing_time = ? AND status = 'active'"
    ).all(currentMinute);

    for (const tenant of tenants) {
      sendBriefing(tenant).catch(err => {
        console.error(`[BRIEFING ERROR] Tenant #${tenant.id}:`, err.message);
      });
    }
  }, 30000); // Check every 30 seconds

  console.log('⏰ Briefing checker started');
}

async function sendBriefing(tenant) {
  console.log(`[BRIEFING] Sending daily briefing to ${tenant.phone}`);
  try {
    const reply = await processMessage(
      tenant.phone,
      tenant.name,
      '[SYSTEM] Generate my daily briefing. Include: pending reminders, recent memories, any tasks or notes from the last 24 hours. Be concise and actionable.'
    );
    if (reply) {
      await sendMessage(tenant.phone, `☀️ *Daily Briefing*\n\n${reply}`);
    }
  } catch (err) {
    console.error(`[BRIEFING] Failed for tenant #${tenant.id}:`, err.message);
  }
}

module.exports = { startBriefingChecker, setBriefingTime };
