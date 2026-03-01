const db = require('./db');
const { sendMessage } = require('./whatsapp');

function startReminderChecker() {
  setInterval(async () => {
    const due = db.prepare(`
      SELECT r.*, t.phone FROM reminders r
      JOIN tenants t ON r.tenant_id = t.id
      WHERE r.sent = 0 AND r.remind_at <= datetime('now')
      AND t.status = 'active'
    `).all();

    for (const reminder of due) {
      try {
        await sendMessage(reminder.phone, `⏰ Reminder: ${reminder.content}`);
        db.prepare('UPDATE reminders SET sent = 1 WHERE id = ?').run(reminder.id);
        console.log(`[REMINDER] Sent to ${reminder.phone}: ${reminder.content}`);
      } catch (err) {
        console.error('[REMINDER] Send error:', err.message);
      }
    }
  }, 60000);

  console.log('⏰ Reminder checker started (60s interval)');
}

module.exports = { startReminderChecker };
