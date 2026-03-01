const fs = require('fs');
const path = require('path');
const db = require('./db');

const TENANTS_DIR = path.join(__dirname, '..', 'data', 'tenants');

const DEFAULT_SOUL = `# Your AI Assistant - Jarvis

You are Jarvis, a personal AI assistant. You are helpful, proactive, and remember everything your human tells you.

## Core Traits
- Concise but thorough when needed
- You remember things — use the memory context provided
- Warm but not sycophantic
- Proactive — anticipate needs based on context
- You can save memories, set reminders, and organize information

## Capabilities
- Save and recall memories (things the user tells you to remember)
- Set reminders (the user can ask to be reminded about things)
- Organize information into categories
- Daily briefings summarizing pending reminders and recent context
- General AI assistance — answer questions, brainstorm, draft messages, etc.
`;

const DEFAULT_MEMORY = `# Memory

_Your long-term memory. Updated as you learn about your human._

## About My Human
- Name: {name}
- Phone: {phone}
- Joined: {date}

## Key Facts
_(Nothing saved yet — tell me things to remember!)_
`;

function getTenantDir(tenantId) {
  return path.join(TENANTS_DIR, String(tenantId));
}

function provisionTenant(phone, name) {
  // Check if already exists
  let tenant = db.prepare('SELECT * FROM tenants WHERE phone = ?').get(phone);
  if (tenant) {
    db.prepare('UPDATE tenants SET last_active = CURRENT_TIMESTAMP, name = COALESCE(?, name) WHERE id = ?')
      .run(name, tenant.id);
    return db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenant.id);
  }

  // Create new tenant
  const result = db.prepare(
    'INSERT INTO tenants (phone, name, display_name) VALUES (?, ?, ?)'
  ).run(phone, name, name);

  const tenantId = result.lastInsertRowid;
  const wsPath = getTenantDir(tenantId);

  // Create workspace directory structure
  fs.mkdirSync(wsPath, { recursive: true });
  fs.mkdirSync(path.join(wsPath, 'memory'), { recursive: true });

  // Write default files
  const now = new Date().toISOString().split('T')[0];
  fs.writeFileSync(path.join(wsPath, 'SOUL.md'), DEFAULT_SOUL);
  fs.writeFileSync(path.join(wsPath, 'MEMORY.md'),
    DEFAULT_MEMORY
      .replace('{name}', name || 'Unknown')
      .replace('{phone}', phone)
      .replace('{date}', now)
  );
  fs.writeFileSync(path.join(wsPath, 'memory', `${now}.md`),
    `# ${now}\n\n- Tenant provisioned. Welcome message sent.\n`
  );

  // Update workspace path
  db.prepare('UPDATE tenants SET workspace_path = ? WHERE id = ?').run(wsPath, tenantId);

  console.log(`[PROVISION] New tenant #${tenantId}: ${name} (${phone}) → ${wsPath}`);
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
}

function getTenantMemoryContext(tenant) {
  const wsPath = tenant.workspace_path || getTenantDir(tenant.id);

  let soul = '';
  let memory = '';
  let dailyNotes = '';

  try { soul = fs.readFileSync(path.join(wsPath, 'SOUL.md'), 'utf8'); } catch {}
  try { memory = fs.readFileSync(path.join(wsPath, 'MEMORY.md'), 'utf8'); } catch {}

  // Read today's and yesterday's daily notes
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  try { dailyNotes += fs.readFileSync(path.join(wsPath, 'memory', `${today}.md`), 'utf8'); } catch {}
  try { dailyNotes += '\n' + fs.readFileSync(path.join(wsPath, 'memory', `${yesterday}.md`), 'utf8'); } catch {}

  // DB memories
  const memories = db.prepare(
    'SELECT content, category, created_at FROM memories WHERE tenant_id = ? ORDER BY pinned DESC, created_at DESC LIMIT 30'
  ).all(tenant.id);

  // Pending reminders
  const reminders = db.prepare(
    'SELECT content, remind_at FROM reminders WHERE tenant_id = ? AND sent = 0 ORDER BY remind_at ASC LIMIT 20'
  ).all(tenant.id);

  return { soul, memory, dailyNotes, memories, reminders };
}

function appendDailyNote(tenant, note) {
  const wsPath = tenant.workspace_path || getTenantDir(tenant.id);
  const today = new Date().toISOString().split('T')[0];
  const file = path.join(wsPath, 'memory', `${today}.md`);

  try {
    fs.mkdirSync(path.join(wsPath, 'memory'), { recursive: true });
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, `# ${today}\n\n`);
    }
    fs.appendFileSync(file, `- ${note}\n`);
  } catch (e) {
    console.error('Daily note write error:', e.message);
  }
}

function updateMemoryFile(tenant, section, content) {
  const wsPath = tenant.workspace_path || getTenantDir(tenant.id);
  const memFile = path.join(wsPath, 'MEMORY.md');

  try {
    let mem = fs.readFileSync(memFile, 'utf8');
    // Append to key facts section
    if (mem.includes('## Key Facts')) {
      mem = mem.replace('## Key Facts\n', `## Key Facts\n- ${content}\n`);
    } else {
      mem += `\n## Key Facts\n- ${content}\n`;
    }
    fs.writeFileSync(memFile, mem);
  } catch (e) {
    console.error('Memory file update error:', e.message);
  }
}

module.exports = {
  provisionTenant,
  getTenantDir,
  getTenantMemoryContext,
  appendDailyNote,
  updateMemoryFile
};
