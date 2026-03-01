// ─── Error Monitoring ───────────────────────────────────────
// Simple built-in error logger. No external dependencies.
// Logs to data/errors.log in JSON lines format.

const fs = require('fs');
const path = require('path');

const ERROR_LOG = path.join(__dirname, '..', 'data', 'errors.log');
const hourlyCounts = new Map(); // "YYYY-MM-DD-HH" → count

function logError(message, stack, context = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    message: String(message || 'Unknown error'),
    stack: stack || null,
    context
  };

  try {
    fs.appendFileSync(ERROR_LOG, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('[MONITOR] Failed to write error log:', e.message);
  }

  // Track hourly count
  const hourKey = new Date().toISOString().slice(0, 13); // "2026-03-01T12"
  hourlyCounts.set(hourKey, (hourlyCounts.get(hourKey) || 0) + 1);

  // Keep only last 48 hours of counts
  if (hourlyCounts.size > 48) {
    const keys = [...hourlyCounts.keys()].sort();
    while (keys.length > 48) {
      hourlyCounts.delete(keys.shift());
    }
  }

  console.error(`[MONITOR] ${entry.message}`);
}

function getRecentErrors(limit = 100) {
  try {
    if (!fs.existsSync(ERROR_LOG)) return [];
    const content = fs.readFileSync(ERROR_LOG, 'utf8').trim();
    if (!content) return [];
    const lines = content.split('\n');
    const recent = lines.slice(-limit);
    return recent.map(line => {
      try { return JSON.parse(line); } catch { return { message: line, timestamp: null }; }
    }).reverse(); // newest first
  } catch {
    return [];
  }
}

function getHourlyCounts() {
  const result = {};
  for (const [key, count] of hourlyCounts) {
    result[key] = count;
  }
  return result;
}

/**
 * Wrap an async function with error logging
 */
function monitored(fn, context = '') {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      logError(err.message, err.stack, { handler: context });
      throw err; // re-throw so caller can handle
    }
  };
}

/**
 * Install global error handlers
 */
function installGlobalHandlers() {
  process.on('uncaughtException', (err) => {
    logError(err.message, err.stack, { type: 'uncaughtException' });
    // Don't exit — keep server running
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : null;
    logError(msg, stack, { type: 'unhandledRejection' });
  });

  console.log('[MONITOR] Global error handlers installed');
}

module.exports = { logError, getRecentErrors, getHourlyCounts, monitored, installGlobalHandlers };
