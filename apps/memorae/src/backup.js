// ─── Automated DB Backups ───────────────────────────────────
// Copies jarvis.db every 6 hours, keeps last 7 days.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'jarvis.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function createBackup() {
  ensureBackupDir();
  if (!fs.existsSync(DB_PATH)) {
    console.log('[BACKUP] No database file found, skipping.');
    return null;
  }

  const now = new Date();
  const stamp = now.toISOString().slice(0, 13).replace(/[T:]/g, '-'); // YYYY-MM-DD-HH
  const filename = `jarvis-${stamp}.db`;
  const dest = path.join(BACKUP_DIR, filename);

  try {
    fs.copyFileSync(DB_PATH, dest);
    console.log(`[BACKUP] Created: ${filename}`);
    return filename;
  } catch (err) {
    console.error('[BACKUP ERROR]', err.message);
    return null;
  }
}

function cleanOldBackups(maxAgeDays = 7) {
  ensureBackupDir();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  try {
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('jarvis-') && f.endsWith('.db'));
    for (const file of files) {
      const filePath = path.join(BACKUP_DIR, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        console.log(`[BACKUP] Deleted old backup: ${file}`);
      }
    }
  } catch (err) {
    console.error('[BACKUP CLEANUP ERROR]', err.message);
  }
}

function listBackups() {
  ensureBackupDir();
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('jarvis-') && f.endsWith('.db'));
    return files.map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return {
        filename: f,
        size: stat.size,
        sizeHuman: (stat.size / 1024 / 1024).toFixed(2) + ' MB',
        created: stat.mtime.toISOString()
      };
    }).sort((a, b) => b.created.localeCompare(a.created));
  } catch {
    return [];
  }
}

let backupInterval = null;

function startBackupScheduler() {
  // Initial backup on start
  createBackup();
  cleanOldBackups();

  // Every 6 hours
  backupInterval = setInterval(() => {
    createBackup();
    cleanOldBackups();
  }, 6 * 60 * 60 * 1000);

  console.log('[BACKUP] Scheduler started (every 6 hours)');
}

module.exports = { createBackup, cleanOldBackups, listBackups, startBackupScheduler };
