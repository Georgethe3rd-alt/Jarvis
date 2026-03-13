const db = require('./db');
const { sendMessage } = require('./whatsapp');
const { textToSpeech } = require('./voice');
const { sendAudioMessage } = require('./whatsapp');

function startReminderChecker() {
  setInterval(async () => {
    const now = new Date().toISOString();
    
    const due = db.prepare(`
      SELECT r.*, t.phone FROM reminders r
      JOIN tenants t ON r.tenant_id = t.id
      WHERE r.sent = 0 AND r.remind_at <= datetime('now')
      AND t.status = 'active'
    `).all();

    if (due.length === 0) {
      console.log(`[REMINDER] ${now} - No reminders due`);
      return;
    }

    console.log(`[REMINDER] ${now} - Found ${due.length} due reminder(s)`);

    for (const reminder of due) {
      try {
        // Send as voice note if voice=1, otherwise text
        if (reminder.voice === 1) {
          const audioBuffer = await textToSpeech(reminder.content);
          if (audioBuffer) {
            await sendAudioMessage(reminder.phone, audioBuffer);
            console.log(`[REMINDER] Sent voice note to ${reminder.phone}: ${reminder.content}`);
          } else {
            // Fallback to text if TTS fails
            await sendMessage(reminder.phone, `⏰ Reminder: ${reminder.content}`);
            console.log(`[REMINDER] TTS failed, sent text to ${reminder.phone}: ${reminder.content}`);
          }
        } else {
          await sendMessage(reminder.phone, `⏰ Reminder: ${reminder.content}`);
          console.log(`[REMINDER] Sent text to ${reminder.phone}: ${reminder.content}`);
        }
        
        db.prepare('UPDATE reminders SET sent = 1 WHERE id = ?').run(reminder.id);
      } catch (err) {
        console.error('[REMINDER] Send error:', err.message);
      }
    }
  }, 300000); // Check every 5 minutes (300000ms)

  console.log('⏰ Reminder checker started (5 min interval with debug logging)');
}

module.exports = { startReminderChecker };
