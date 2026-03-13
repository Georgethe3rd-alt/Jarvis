/**
 * Heartbeat system for Jarvis
 * Proactive check-ins, daily briefings, weather alerts, follow-ups
 */
const db = require('./db');
const { getConfig, sendMessage } = require('./whatsapp');
const { sendAudioMessage } = require('./whatsapp');
const { textToSpeech } = require('./voice');
const { webSearch } = require('./web-search');
const fs = require('fs');
const path = require('path');

const TENANTS_DIR = path.join(__dirname, '..', 'data', 'tenants');

/**
 * Get all active tenants with heartbeat enabled
 */
function getHeartbeatTenants() {
  return db.prepare(`
    SELECT t.*, 
           (SELECT value FROM tenant_settings WHERE tenant_id = t.id AND key = 'heartbeat_enabled') as heartbeat_enabled,
           (SELECT value FROM tenant_settings WHERE tenant_id = t.id AND key = 'heartbeat_interval') as heartbeat_interval,
           (SELECT value FROM tenant_settings WHERE tenant_id = t.id AND key = 'timezone') as timezone
    FROM tenants t 
    WHERE t.status = 'active'
  `).all().filter(t => t.heartbeat_enabled === '1' || t.heartbeat_enabled === 'true');
}

/**
 * Check if tenant has been inactive and might need a check-in
 */
function needsCheckIn(tenant) {
  const lastMsg = db.prepare(
    'SELECT created_at FROM conversations WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(tenant.id);
  
  if (!lastMsg) return false;
  
  const lastActive = new Date(lastMsg.created_at);
  const hoursSinceActive = (Date.now() - lastActive.getTime()) / (1000 * 60 * 60);
  
  // Check in if inactive for more than 24 hours but less than 7 days
  return hoursSinceActive > 24 && hoursSinceActive < 168;
}

/**
 * Get pending reminders that are due
 */
function getDueReminders() {
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return db.prepare(
    'SELECT r.*, t.phone, t.name FROM reminders r JOIN tenants t ON r.tenant_id = t.id WHERE r.remind_at <= ? AND r.sent = 0'
  ).all(now);
}

/**
 * Process due reminders
 */
async function processReminders() {
  const due = getDueReminders();
  for (const reminder of due) {
    try {
      if (reminder.voice) {
        // Send as voice note
        const audio = await textToSpeech(reminder.content);
        if (audio) {
          await sendAudioMessage(reminder.phone, audio);
        } else {
          await sendMessage(reminder.phone, `⏰ Reminder: ${reminder.content}`);
        }
      } else {
        await sendMessage(reminder.phone, `⏰ Reminder: ${reminder.content}`);
      }
      
      db.prepare('UPDATE reminders SET sent = 1 WHERE id = ?').run(reminder.id);
      console.log(`[HEARTBEAT] Sent reminder to ${reminder.phone}: ${reminder.content.substring(0, 50)}`);
    } catch (err) {
      console.error(`[HEARTBEAT] Reminder failed for ${reminder.phone}:`, err.message);
    }
  }
  return due.length;
}

/**
 * Run cron jobs
 */
async function processCronJobs() {
  // Ensure cron_jobs table exists
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS cron_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      schedule TEXT NOT NULL,
      action TEXT NOT NULL,
      last_run TEXT,
      next_run TEXT,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    )`);
  } catch (e) { /* table exists */ }

  const now = new Date();
  const jobs = db.prepare(
    'SELECT c.*, t.phone, t.name FROM cron_jobs c JOIN tenants t ON c.tenant_id = t.id WHERE c.enabled = 1 AND (c.next_run IS NULL OR c.next_run <= ?)'
  ).all(now.toISOString());

  for (const job of jobs) {
    try {
      const action = JSON.parse(job.action);
      
      switch (action.type) {
        case 'send_message':
          await sendMessage(job.phone, action.message);
          break;
        case 'send_voice':
          const audio = await textToSpeech(action.text);
          if (audio) await sendAudioMessage(job.phone, audio);
          break;
        case 'web_search_alert':
          const results = await webSearch(action.query);
          if (results.results) {
            await sendMessage(job.phone, `🔍 ${action.label || 'Search update'}:\n\n${results.results.substring(0, 1500)}`);
          }
          break;
      }
      
      // Calculate next run based on schedule
      const nextRun = calculateNextRun(job.schedule, now);
      db.prepare('UPDATE cron_jobs SET last_run = ?, next_run = ? WHERE id = ?')
        .run(now.toISOString(), nextRun.toISOString(), job.id);
      
      console.log(`[CRON] Executed job "${job.name}" for tenant #${job.tenant_id}`);
    } catch (err) {
      console.error(`[CRON] Job "${job.name}" failed:`, err.message);
    }
  }
  return jobs.length;
}

/**
 * Calculate next run time from a simple schedule string
 * Supports: "daily HH:MM", "hourly", "weekly DAY HH:MM", "every Xh", "every Xm"
 */
function calculateNextRun(schedule, fromDate) {
  const now = new Date(fromDate);
  
  if (schedule.startsWith('daily')) {
    const time = schedule.split(' ')[1] || '09:00';
    const [hours, minutes] = time.split(':').map(Number);
    const next = new Date(now);
    next.setUTCHours(hours, minutes, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }
  
  if (schedule === 'hourly') {
    return new Date(now.getTime() + 60 * 60 * 1000);
  }
  
  if (schedule.startsWith('every')) {
    const match = schedule.match(/every (\d+)(h|m)/);
    if (match) {
      const value = parseInt(match[1]);
      const unit = match[2] === 'h' ? 60 * 60 * 1000 : 60 * 1000;
      return new Date(now.getTime() + value * unit);
    }
  }
  
  if (schedule.startsWith('weekly')) {
    const parts = schedule.split(' ');
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const targetDay = dayNames.indexOf((parts[1] || 'monday').toLowerCase());
    const time = parts[2] || '09:00';
    const [hours, minutes] = time.split(':').map(Number);
    const next = new Date(now);
    next.setUTCHours(hours, minutes, 0, 0);
    const daysUntil = (targetDay - now.getUTCDay() + 7) % 7 || 7;
    next.setDate(next.getDate() + daysUntil);
    return next;
  }
  
  // Default: 24 hours from now
  return new Date(now.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * Ensure tenant_settings table exists
 */
function ensureTables() {
  db.exec(`CREATE TABLE IF NOT EXISTS tenant_settings (
    tenant_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (tenant_id, key),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  )`);
  
  db.exec(`CREATE TABLE IF NOT EXISTS cron_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    schedule TEXT NOT NULL,
    action TEXT NOT NULL,
    last_run TEXT,
    next_run TEXT,
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  )`);
}

/**
 * Main heartbeat tick — runs every minute
 */
let heartbeatInterval = null;

function startHeartbeat() {
  ensureTables();
  
  // Run every minute
  heartbeatInterval = setInterval(async () => {
    try {
      // Process reminders
      const reminders = await processReminders();
      if (reminders > 0) console.log(`[HEARTBEAT] Processed ${reminders} reminders`);
      
      // Process cron jobs
      const crons = await processCronJobs();
      if (crons > 0) console.log(`[HEARTBEAT] Processed ${crons} cron jobs`);
    } catch (err) {
      console.error('[HEARTBEAT] Error:', err.message);
    }
  }, 60 * 1000); // Every minute
  
  console.log('💓 Heartbeat system started (1 min interval)');
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

module.exports = { startHeartbeat, stopHeartbeat, processReminders, processCronJobs, ensureTables };
