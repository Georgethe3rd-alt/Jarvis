const Anthropic = require('@anthropic-ai/sdk').default;
const db = require('./db');
const { getConfig, sendMessage: sendWhatsApp } = require('./whatsapp');
const { provisionTenant, getTenantMemoryContext, appendDailyNote, updateMemoryFile, updateSoulFile } = require('./tenant');
const { setBriefingTime } = require('./briefings');
const { textToSpeech } = require('./voice');
const { sendAudioMessage } = require('./whatsapp');
const { webSearch } = require('./web-search');
const { fetchUrl } = require('./url-fetch');
const { analyzeImage } = require('./vision');
const { generateImage, downloadImage } = require('./image-gen');
const { saveContact, searchContacts, listContacts, deleteContact, ensureContactsTable } = require('./contacts');
const { browse, fillForm, screenshot: takeScreenshot } = require('./browser');
const workspace = require('./workspace');
const { makeCall } = require('./outbound-call');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function getClient() {
  const apiKey = getConfig('anthropic_api_key') || process.env.ANTHROPIC_API_KEY;
  return new Anthropic({ apiKey });
}

function getRecentConversation(tenantId, limit = 20) {
  return db.prepare(
    'SELECT role, content FROM conversations WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(tenantId, limit).reverse();
}

function saveConversation(tenantId, role, content, tokens = 0) {
  db.prepare('INSERT INTO conversations (tenant_id, role, content, tokens_used) VALUES (?, ?, ?, ?)')
    .run(tenantId, role, content, tokens);
  db.prepare('UPDATE tenants SET message_count = message_count + 1, last_active = CURRENT_TIMESTAMP WHERE id = ?')
    .run(tenantId);
}

function saveMemory(tenantId, content, category = 'general') {
  db.prepare('INSERT INTO memories (tenant_id, content, category) VALUES (?, ?, ?)')
    .run(tenantId, content, category);
  db.prepare('UPDATE tenants SET memory_count = memory_count + 1 WHERE id = ?').run(tenantId);
}

function saveReminder(tenantId, content, remindAt, voice = false) {
  db.prepare('INSERT INTO reminders (tenant_id, content, remind_at, voice) VALUES (?, ?, ?, ?)')
    .run(tenantId, content, remindAt, voice ? 1 : 0);
}

function logUsage(tenantId, inputTokens, outputTokens, model) {
  db.prepare('INSERT INTO usage_log (tenant_id, input_tokens, output_tokens, model) VALUES (?, ?, ?, ?)')
    .run(tenantId, inputTokens, outputTokens, model);
}

// Tool functions for advanced actions (tenant_id=2 only)
function executeCommand(command, tenantId) {
  if (tenantId !== 2) {
    return { error: 'Permission denied: exec is only available for admin user' };
  }
  
  // Block dangerous commands
  const dangerous = ['rm -rf /', 'mkfs', 'dd if=', '> /dev/', 'format', 'fdisk'];
  if (dangerous.some(d => command.includes(d))) {
    return { error: 'Blocked: potentially dangerous command' };
  }
  
  try {
    const output = execSync(command, { 
      timeout: 10000,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024
    });
    const truncated = output.length > 4000 ? output.substring(0, 4000) + '\n\n[... truncated]' : output;
    return { output: truncated };
  } catch (err) {
    return { error: err.message, stderr: err.stderr?.toString() || '' };
  }
}

function readFile(filePath, tenantId) {
  if (tenantId !== 2) {
    return { error: 'Permission denied: read_file is only available for admin user' };
  }
  
  if (!filePath.startsWith('/root/jarvis/')) {
    return { error: 'Permission denied: can only read files under /root/jarvis/' };
  }
  
  try {
    let content = fs.readFileSync(filePath, 'utf8');
    if (content.length > 8000) {
      content = content.substring(0, 8000) + '\n\n[... truncated to 8000 chars]';
    }
    return { content };
  } catch (err) {
    return { error: err.message };
  }
}

function writeFile(filePath, content, tenantId) {
  if (tenantId !== 2) {
    return { error: 'Permission denied: write_file is only available for admin user' };
  }
  
  if (!filePath.startsWith('/root/jarvis/')) {
    return { error: 'Permission denied: can only write files under /root/jarvis/' };
  }
  
  try {
    // Create backup if file exists
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, filePath + '.bak');
    }
    
    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(filePath, content, 'utf8');
    
    // Auto-restart if it's a src file
    if (filePath.includes('/src/')) {
      try {
        execSync('systemctl restart jarvis-memorae', { timeout: 5000 });
        return { success: true, message: 'File written and service restarted' };
      } catch (e) {
        return { success: true, message: 'File written, but service restart failed: ' + e.message };
      }
    }
    
    return { success: true, message: 'File written successfully' };
  } catch (err) {
    return { error: err.message };
  }
}

function editFile(filePath, oldText, newText, tenantId) {
  if (tenantId !== 2) {
    return { error: 'Permission denied: edit_file is only available for admin user' };
  }
  
  if (!filePath.startsWith('/root/jarvis/')) {
    return { error: 'Permission denied: can only edit files under /root/jarvis/' };
  }
  
  try {
    // Create backup
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, filePath + '.bak');
    } else {
      return { error: 'File does not exist' };
    }
    
    let content = fs.readFileSync(filePath, 'utf8');
    
    if (!content.includes(oldText)) {
      return { error: 'Old text not found in file' };
    }
    
    content = content.replace(oldText, newText);
    fs.writeFileSync(filePath, content, 'utf8');
    
    // Auto-restart if it's a src file
    if (filePath.includes('/src/')) {
      try {
        execSync('systemctl restart jarvis-memorae', { timeout: 5000 });
        return { success: true, message: 'File edited and service restarted' };
      } catch (e) {
        return { success: true, message: 'File edited, but service restart failed: ' + e.message };
      }
    }
    
    return { success: true, message: 'File edited successfully' };
  } catch (err) {
    return { error: err.message };
  }
}

// webSearch imported from ./web-search module

/**
 * Create or manage cron jobs for a tenant
 */
function manageCronJob(tenantId, action, jobData) {
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
  } catch (e) { /* exists */ }

  if (action === 'create') {
    db.prepare('INSERT INTO cron_jobs (tenant_id, name, schedule, action) VALUES (?, ?, ?, ?)')
      .run(tenantId, jobData.name, jobData.schedule, JSON.stringify(jobData.action));
    return { success: true, message: `Cron job "${jobData.name}" created (${jobData.schedule})` };
  } else if (action === 'list') {
    const jobs = db.prepare('SELECT id, name, schedule, enabled, last_run FROM cron_jobs WHERE tenant_id = ?').all(tenantId);
    return { jobs };
  } else if (action === 'delete') {
    db.prepare('DELETE FROM cron_jobs WHERE tenant_id = ? AND id = ?').run(tenantId, jobData.id);
    return { success: true, message: 'Cron job deleted' };
  } else if (action === 'toggle') {
    db.prepare('UPDATE cron_jobs SET enabled = CASE WHEN enabled = 1 THEN 0 ELSE 1 END WHERE tenant_id = ? AND id = ?').run(tenantId, jobData.id);
    return { success: true, message: 'Cron job toggled' };
  }
  return { error: 'Unknown cron action' };
}

function restartService() {
  try {
    execSync('systemctl restart jarvis-memorae', { timeout: 5000 });
    return { success: true, message: 'Service restarted successfully' };
  } catch (err) {
    return { error: err.message };
  }
}

async function processMessage(phone, name, text) {
  // Provision or retrieve tenant
  const tenant = provisionTenant(phone, name);
  const isNew = tenant.message_count === 0;

  saveConversation(tenant.id, 'user', text);

  // Get full context
  const ctx = getTenantMemoryContext(tenant);
  const history = getRecentConversation(tenant.id);
  const model = tenant.model || getConfig('anthropic_model') || 'claude-sonnet-4-5-20250929';

  const memoryBlock = ctx.memories.length > 0
    ? `\n\nSaved memories:\n${ctx.memories.map(m => `- [${m.category}] ${m.content}`).join('\n')}`
    : '';

  const reminderBlock = ctx.reminders.length > 0
    ? `\n\nPending reminders:\n${ctx.reminders.map(r => `- ${r.content} (due: ${r.remind_at})`).join('\n')}`
    : '';

  const timezone = 'America/New_York (EST/EDT, UTC-5/UTC-4)';
  const currentUTC = new Date().toISOString();
  const currentEST = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

  const systemPrompt = `${ctx.soul}

---
WORKSPACE CONTEXT:

${ctx.memory}

${ctx.dailyNotes ? `Recent notes:\n${ctx.dailyNotes}` : ''}
${memoryBlock}${reminderBlock}

---
INSTRUCTIONS:

Current time (UTC): ${currentUTC}
Current time (User's timezone EST): ${currentEST}
User timezone: ${timezone}
User: ${name || 'Unknown'} (${phone})
${isNew ? `THIS IS A NEW USER. Give them a brief, warm welcome. Keep it SHORT — 2-3 sentences max. Example:
"Welcome aboard! I'm Jarvis — your personal AI assistant. I can search the web, set reminders, make calls, generate images, and much more. Just ask me anything."
Do NOT ask them a bunch of setup questions. Do NOT ask "who are you" or "what should I call you" — you already have their name. Do NOT run through a long onboarding. Just welcome them and be ready to help. They can customise you later if they want.` : ''}

When the user tells you to remember something, save it as a memory.
When the user asks to be reminded, save it as a reminder with a datetime.
When you learn something important about the user, update their memory file.

To perform actions, include JSON blocks at the END of your reply (they will be stripped before sending):

\`\`\`action
{"type": "save_memory", "content": "...", "category": "general|work|personal|health|finance|ideas|contacts|shopping|travel"}
\`\`\`

\`\`\`action
{"type": "save_reminder", "content": "...", "remind_at": "YYYY-MM-DD HH:MM", "voice": false}
\`\`\`
**IMPORTANT:** The remind_at time MUST be in UTC! Convert from the user's timezone (EST/EDT) to UTC before saving.
Example: If user says "6am tomorrow" and they're in EST (UTC-5), save as "YYYY-MM-DD 11:00" (6am + 5 hours).
The "voice" field is optional (default false). Set to true to send reminder as a voice note instead of text.

\`\`\`action
{"type": "update_profile", "content": "fact about the user to remember long-term"}
\`\`\`

\`\`\`action
{"type": "daily_note", "content": "brief note about what happened in this conversation"}
\`\`\`

\`\`\`action
{"type": "update_soul", "content": "new personality instruction or preference to add to SOUL.md"}
\`\`\`

\`\`\`action
{"type": "send_to_contact", "phone": "+1868XXXXXXX", "message": "text to send"}
\`\`\`

\`\`\`action
{"type": "set_briefing_time", "time": "8am"}
\`\`\`

TOOLS AVAILABLE TO YOU:

\`\`\`action
{"type": "web_search", "query": "latest news about..."}
\`\`\`
Search the web for real-time information. Use this whenever the user asks about current events, facts you're unsure of, prices, weather, sports scores, or anything that benefits from live data. ALWAYS search rather than guess.

\`\`\`action
{"type": "fetch_url", "url": "https://example.com/article"}
\`\`\`
Fetch and read a web page. Use when the user shares a URL or asks you to read/summarise an article, blog post, or any web page. Returns the text content.

\`\`\`action
{"type": "analyze_image", "url": "https://...", "prompt": "What is in this image?"}
\`\`\`
Analyze an image using vision AI. Use when the user sends a photo/image and asks about it, or wants you to describe, read text from, or answer questions about an image. The prompt is optional — defaults to describing the image.

\`\`\`action
{"type": "generate_image", "prompt": "A sunset over the Caribbean ocean with palm trees", "size": "1024x1024"}
\`\`\`
Generate an image using DALL-E 3. Use when the user asks you to create, draw, design, or generate any image. Sizes: "1024x1024" (square), "1024x1792" (portrait), "1792x1024" (landscape). Be descriptive in your prompts for best results.

\`\`\`action
{"type": "save_contact", "name": "John", "phone": "+18681234567", "email": "john@email.com", "notes": "Wayne's business partner", "category": "work"}
\`\`\`
Save or update a contact in the user's address book. Phone and email are optional. Categories: general, work, personal, family, business.

\`\`\`action
{"type": "search_contacts", "query": "John"}
\`\`\`
Search the user's contacts by name, phone, or notes.

\`\`\`action
{"type": "list_contacts"}
\`\`\`
List all saved contacts. Optionally add "category": "work" to filter.

\`\`\`action
{"type": "delete_contact", "name": "John"}
\`\`\`
Delete a contact by name.

\`\`\`action
{"type": "call_user", "message": "Good morning Mr. Wayne. Just calling to remind you about your meeting in 30 minutes."}
\`\`\`
Call the current user on their phone and speak a message using your British voice (ElevenLabs). Use when the user says "call me", "ring me", "give me a call", or when a reminder/alert is urgent enough to warrant a phone call instead of a text. The call uses Twilio and speaks via ElevenLabs TTS.

\`\`\`action
{"type": "call_phone", "phone": "+18681234567", "message": "Hello, this is Jarvis calling on behalf of Mr. Wayne.", "gather": true}
\`\`\`
Call any phone number and deliver a message. Set "gather": true to listen for a response and have a conversation. Use when the user says "call John" or "phone this number". Searches contacts first if a name is given.

\`\`\`action
{"type": "send_voice_note", "text": "Hello! Here's your update..."}
\`\`\`
Send a voice note to the user. Use when they ask for voice, when delivering long content, or when it feels more natural than text. You have a British voice (Daniel).

\`\`\`action
{"type": "multi_step", "steps": [{"type": "web_search", "query": "best hotels in Tobago 2026"}, {"type": "web_search", "query": "Tobago hotel prices March 2026"}, {"type": "fetch_url", "url": "https://example.com/tobago-hotels"}]}
\`\`\`
Execute multiple tool actions in sequence and get all results back at once. Use for complex research tasks that need multiple searches, fetches, or analyses combined. Each step can be any action type (web_search, fetch_url, analyze_image, etc.).

\`\`\`action
{"type": "browse", "url": "https://example.com", "screenshot": false}
\`\`\`
Open a website in a real browser, extract all visible text. Use for pages that need JavaScript rendering, or when fetch_url doesn't work well. Set "screenshot": true to capture a screenshot. More powerful than fetch_url but slower.

\`\`\`action
{"type": "browse_fill_form", "url": "https://example.com/form", "fields": [{"selector": "input#name", "value": "John"}, {"selector": "input#email", "value": "john@email.com"}], "submit": "button[type=submit]"}
\`\`\`
Fill out and submit a form on a website. Provide CSS selectors for each field and the submit button.

\`\`\`action
{"type": "browse_screenshot", "url": "https://example.com"}
\`\`\`
Take a screenshot of a webpage and send it to the user.

\`\`\`action
{"type": "workspace_write", "path": "notes/shopping-list.md", "content": "# Shopping List\\n- Milk\\n- Eggs\\n- Bread"}
\`\`\`
Create or overwrite a file in the user's personal workspace. Use for notes, lists, documents, project files. Paths are relative to the user's workspace root.

\`\`\`action
{"type": "workspace_read", "path": "notes/shopping-list.md"}
\`\`\`
Read a file from the user's workspace.

\`\`\`action
{"type": "workspace_append", "path": "journal/2026-03.md", "content": "\\n## March 9\\nHad a great meeting today."}
\`\`\`
Append content to an existing file. Creates the file if it doesn't exist. Great for journals, logs, running lists.

\`\`\`action
{"type": "workspace_list", "path": "/"}
\`\`\`
List files and folders in the user's workspace. Path defaults to root.

\`\`\`action
{"type": "workspace_delete", "path": "old-notes.txt"}
\`\`\`
Delete a file from the workspace.

\`\`\`action
{"type": "workspace_edit", "path": "notes/list.md", "old_text": "- Milk", "new_text": "- Milk (2%)"}
\`\`\`
Edit a file by finding and replacing text. Use for precise updates.

FILE WORKSPACE GUIDELINES:
- Every user has their own isolated workspace. Files are private and persistent.
- Use the workspace for: notes, lists, journals, project docs, saved research, templates.
- When a user says "write this down", "save this", "keep a note" — write to their workspace.
- Organize files into folders: notes/, lists/, projects/, journal/, etc.
- When a user asks "what did I save?" or "show me my files" — list their workspace.

\`\`\`action
{"type": "create_cron", "name": "Morning briefing", "schedule": "daily 13:00", "action": {"type": "send_message", "message": "Good morning! Here's your daily briefing..."}}
\`\`\`
Create scheduled recurring tasks. Schedules: "daily HH:MM" (UTC), "hourly", "every Xh", "every Xm", "weekly DAY HH:MM".
Use for daily briefings, periodic reminders, recurring alerts.

\`\`\`action
{"type": "list_crons"}
\`\`\`
List all scheduled cron jobs for this user.

\`\`\`action
{"type": "delete_cron", "id": 1}
\`\`\`
Delete a scheduled cron job by ID.

${tenant.id === 2 ? `
ADMIN-ONLY TOOLS:

\`\`\`action
{"type": "exec", "command": "ls -la /root/jarvis"}
\`\`\`
Execute shell commands on the VPS.

\`\`\`action
{"type": "read_file", "path": "/root/jarvis/apps/memorae/src/ai.js"}
\`\`\`
Read file contents under /root/jarvis/.

\`\`\`action
{"type": "write_file", "path": "...", "content": "..."}
\`\`\`
Write/overwrite a file. Auto-restarts service for src/ files.

\`\`\`action
{"type": "edit_file", "path": "...", "old_text": "...", "new_text": "..."}
\`\`\`
Surgical find-and-replace edit.

\`\`\`action
{"type": "restart_service"}
\`\`\`
Restart the jarvis-memorae systemd service.
` : ''}

When the user asks to send something to another phone number (like "send my grocery list to +1868..."), use send_to_contact.
When the user asks to remind someone else at another phone number, use send_to_contact with an appropriate message.
When the user asks to set a daily briefing time, use set_briefing_time.
VOICE NOTES: You CAN and SHOULD send voice notes! When the user asks for a voice note, or when it feels natural, include a send_voice_note action. This generates real audio via ElevenLabs TTS (British Daniel voice) and sends it as a WhatsApp voice message. You MUST use this when asked. Never say you cannot send voice notes — you absolutely can.
When the user asks you to change your personality, tone, language, or name — use update_soul to persist that change.

HANDLING URLs AND LINKS:
- When a user sends ANY URL (Instagram, TikTok, YouTube, Twitter/X, Facebook, news articles, etc.) — NEVER say you can't access it. You HAVE tools to handle it.
- For social media links (Instagram reels, TikTok, tweets, etc.): Use "browse" to open the page in a real browser and extract whatever text/captions/comments are visible. If there's an image or thumbnail, describe it.
- For articles and web pages: Use "fetch_url" first (faster). If it returns nothing useful, fall back to "browse".
- For YouTube: Browse the page to get the title, description, and comments.
- NEVER tell the user "I can't access that" or "I can't play videos" — instead, browse the page, extract everything you can (caption, description, comments, thumbnail), and summarise what you find.
- If the page requires login, say "That page requires login so I can only see the public preview" — but still share whatever you DID find.

SMART REMINDER DEFAULTS:
- When the user says "morning" or "in the morning" — default to 7:00 AM their time. Don't ask.
- "Evening" or "tonight" — default to 6:00 PM. Don't ask.
- "Afternoon" — default to 2:00 PM. Don't ask.
- "Lunchtime" or "lunch" — default to 12:00 PM. Don't ask.
- "End of day" or "after work" — default to 5:00 PM. Don't ask.
- "Night" or "before bed" — default to 9:00 PM. Don't ask.
- "Tomorrow" without a time — default to 8:00 AM. Don't ask.
- Only ask for a specific time if the user's request is genuinely ambiguous (e.g. "remind me about this later").
- When setting multiple reminders at once, set them all in one go. Don't ask one by one.
- Confirm what you set briefly: "Done — reminders set for 7am tomorrow: pack gym bag, fill water, peppermint tea, make bed."

GENDER & FORMS OF ADDRESS:
- NEVER assume a user's gender. Don't use "sir" or "madam" until you know.
- If unsure, use neutral language: "Got it", "Done", "Right away" — no gendered honorifics.
- If a user tells you their gender or preferred form of address, save it to their MEMORY.md immediately so you never forget.
- Check the user's MEMORY.md at the start of each conversation for stored preferences.

NAME CORRECTION:
- Your name is Jarvis. Users often send voice notes that get transcribed incorrectly.
- Common mistranscriptions: "Travis", "Chavez", "Javis", "Jarvy", "Jarvus", "Chavis", "Jarves"
- If the user addresses you by a wrong name that sounds like Jarvis, respond naturally but gently correct once: "It's Jarvis, by the way 😉" — then don't correct again. They know.
- If they intentionally give you a nickname, that's fine — go with it.

LANGUAGE DETECTION:
- Detect the language the user writes in and respond in the same language. If they switch languages mid-conversation, follow their lead.
- If the user says "speak to me in [language]", switch to that language and save it as a preference via update_soul action.

PROACTIVE FOLLOW-UPS:
- When a user mentions they're waiting on something, planning something, or asks you to "check back" or "follow up" — create a cron job to do it.
- Example: "I'm waiting for an email from John" → create a cron to remind them in 24h to check.
- Example: "I have a flight next Friday" → create a daily cron for that week to provide countdown/reminders.
- Be proactive: if the user mentions something time-sensitive, offer to set up a follow-up without being asked.
- When the user says "remind me to check on X tomorrow" — use create_cron with a send_message action, not just a reminder.

CONTACT MANAGEMENT:
- When the user mentions someone's phone number, email, or contact details — offer to save them.
- When the user says "text John" or "message Sarah" — search contacts first to find their number.
- Build the address book naturally through conversation.

You can include multiple action blocks. Keep your spoken reply natural and concise.`;

  // Build messages array with proper alternation
  const messages = [];
  let lastRole = null;
  for (const h of history) {
    const role = h.role === 'user' ? 'user' : 'assistant';
    if (role !== lastRole) {
      messages.push({ role, content: h.content });
      lastRole = role;
    }
  }
  // Ensure it ends with user message (it should since we just added one)
  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: text });
  }

  try {
    const client = getClient();
    const response = await client.messages.create({
      model,
      max_tokens: tenant.max_tokens || 4096,
      system: systemPrompt,
      messages
    });

    let reply = (response.content[0] && response.content[0].text) || "";
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;

    logUsage(tenant.id, inputTokens, outputTokens, model);

    // Parse and execute actions
    const actionRegex = /```action\n([\s\S]*?)```/g;
    let match;
    const actionOutputs = []; // Collect outputs from tool actions
    
    while ((match = actionRegex.exec(reply)) !== null) {
      try {
        const action = JSON.parse(match[1]);
        switch (action.type) {
          case 'save_memory':
            saveMemory(tenant.id, action.content, action.category || 'general');
            appendDailyNote(tenant, `Memory saved: ${action.content}`);
            break;
          case 'save_reminder':
            saveReminder(tenant.id, action.content, action.remind_at, action.voice);
            appendDailyNote(tenant, `Reminder set: ${action.content} at ${action.remind_at}${action.voice ? ' (voice)' : ''}`);
            break;
          case 'update_profile':
            updateMemoryFile(tenant, 'Key Facts', action.content);
            break;
          case 'daily_note':
            appendDailyNote(tenant, action.content);
            break;
          case 'update_soul':
            updateSoulFile(tenant, action.content);
            appendDailyNote(tenant, `Personality updated: ${action.content}`);
            break;
          case 'send_to_contact':
            if (action.phone && action.message) {
              const contactPhone = action.phone.replace(/[^\d]/g, '');
              await sendWhatsApp(contactPhone, `📨 Message from ${name || phone}:\n\n${action.message}`);
              appendDailyNote(tenant, `Sent message to ${action.phone}: ${action.message.substring(0, 80)}`);
            }
            break;
          case 'send_voice_note':
            if (action.text) {
              const audioBuffer = await textToSpeech(action.text);
              if (audioBuffer) {
                await sendAudioMessage(phone, audioBuffer);
                appendDailyNote(tenant, 'Sent voice note to user');
              }
            }
            break;
          case 'set_briefing_time':
            if (action.time) {
              const formatted = setBriefingTime(tenant.id, action.time);
              if (formatted) appendDailyNote(tenant, `Daily briefing set for ${formatted}`);
            }
            break;
          case 'exec':
            if (action.command) {
              const result = executeCommand(action.command, tenant.id);
              actionOutputs.push(`Command: ${action.command}\nResult: ${JSON.stringify(result, null, 2)}`);
            }
            break;
          case 'read_file':
            if (action.path) {
              const result = readFile(action.path, tenant.id);
              actionOutputs.push(`File: ${action.path}\nContent: ${JSON.stringify(result, null, 2)}`);
            }
            break;
          case 'write_file':
            if (action.path && action.content) {
              const result = writeFile(action.path, action.content, tenant.id);
              actionOutputs.push(`Write to: ${action.path}\nResult: ${JSON.stringify(result, null, 2)}`);
            }
            break;
          case 'edit_file':
            if (action.path && action.old_text && action.new_text) {
              const result = editFile(action.path, action.old_text, action.new_text, tenant.id);
              actionOutputs.push(`Edit: ${action.path}\nResult: ${JSON.stringify(result, null, 2)}`);
            }
            break;
          case 'web_search':
            if (action.query) {
              const result = await webSearch(action.query);
              actionOutputs.push(`Search: ${action.query}\nResults: ${JSON.stringify(result, null, 2)}`);
            }
            break;
          case 'fetch_url':
            if (action.url) {
              const result = await fetchUrl(action.url);
              if (result.error) {
                actionOutputs.push(`Fetch URL: ${action.url}\nError: ${result.error}`);
              } else {
                actionOutputs.push(`Fetch URL: ${action.url}${result.title ? '\nTitle: ' + result.title : ''}\nContent:\n${result.content}`);
              }
            }
            break;
          case 'analyze_image':
            if (action.url) {
              const result = await analyzeImage(action.url, action.prompt || 'Describe this image in detail. What do you see?');
              if (result.error) {
                actionOutputs.push(`Image analysis error: ${result.error}`);
              } else {
                actionOutputs.push(`Image analysis:\n${result.description}`);
              }
            }
            break;
          case 'call_user':
            if (action.message) {
              const callResult = await makeCall(phone, action.message, { voice: true, gather: action.gather || false });
              if (callResult.error) {
                actionOutputs.push(`Call failed: ${callResult.error}`);
              } else {
                actionOutputs.push(`Call initiated to user (${phone}). Call SID: ${callResult.callSid}`);
                appendDailyNote(tenant, `Outbound call to user: ${action.message.substring(0, 80)}`);
              }
            }
            break;
          case 'call_phone':
            if (action.phone && action.message) {
              // If a name is given instead of number, search contacts
              let targetPhone = action.phone;
              if (!/\d{7,}/.test(targetPhone)) {
                const contacts = searchContacts(tenant.id, targetPhone);
                if (contacts.length > 0 && contacts[0].phone) {
                  targetPhone = contacts[0].phone;
                } else {
                  actionOutputs.push(`Could not find phone number for "${targetPhone}". Save their contact first.`);
                  break;
                }
              }
              const callResult = await makeCall(targetPhone, action.message, { voice: true, gather: action.gather || false });
              if (callResult.error) {
                actionOutputs.push(`Call to ${targetPhone} failed: ${callResult.error}`);
              } else {
                actionOutputs.push(`Call initiated to ${targetPhone}. Call SID: ${callResult.callSid}`);
                appendDailyNote(tenant, `Outbound call to ${targetPhone}: ${action.message.substring(0, 80)}`);
              }
            }
            break;
          case 'generate_image':
            if (action.prompt) {
              const imgResult = await generateImage(action.prompt, action.size || '1024x1024', action.quality || 'standard');
              if (imgResult.error) {
                actionOutputs.push(`Image generation error: ${imgResult.error}`);
              } else {
                // Download and send as WhatsApp image
                try {
                  const imgBuffer = await downloadImage(imgResult.url);
                  const { sendImageMessage } = require('./whatsapp');
                  if (typeof sendImageMessage === 'function') {
                    await sendImageMessage(phone, imgResult.url, imgResult.revised_prompt || action.prompt);
                  } else {
                    // Fallback: send URL as text
                    actionOutputs.push(`Image generated successfully.\nURL: ${imgResult.url}\nPrompt used: ${imgResult.revised_prompt || action.prompt}`);
                  }
                  actionOutputs.push(`Image generated and sent to user.\nPrompt used: ${imgResult.revised_prompt || action.prompt}`);
                } catch (dlErr) {
                  actionOutputs.push(`Image generated but failed to send: ${dlErr.message}\nURL: ${imgResult.url}`);
                }
              }
            }
            break;
          case 'save_contact':
            if (action.name) {
              const contactResult = saveContact(tenant.id, { name: action.name, phone: action.phone, email: action.email, notes: action.notes, category: action.category });
              actionOutputs.push(`Contact: ${JSON.stringify(contactResult)}`);
              appendDailyNote(tenant, `Contact saved: ${action.name}${action.phone ? ' (' + action.phone + ')' : ''}`);
            }
            break;
          case 'search_contacts':
            if (action.query) {
              const contacts = searchContacts(tenant.id, action.query);
              actionOutputs.push(`Contact search "${action.query}":\n${contacts.length > 0 ? contacts.map(c => `- ${c.name}${c.phone ? ' | ' + c.phone : ''}${c.email ? ' | ' + c.email : ''}${c.notes ? ' | ' + c.notes : ''}`).join('\n') : 'No contacts found'}`);
            }
            break;
          case 'list_contacts': {
            const allContacts = listContacts(tenant.id, action.category);
            actionOutputs.push(`Contacts${action.category ? ' (' + action.category + ')' : ''}:\n${allContacts.length > 0 ? allContacts.map(c => `- ${c.name}${c.phone ? ' | ' + c.phone : ''}${c.email ? ' | ' + c.email : ''}${c.category ? ' [' + c.category + ']' : ''}`).join('\n') : 'No contacts saved yet'}`);
            break;
          }
          case 'delete_contact':
            if (action.name || action.id) {
              const delContactResult = deleteContact(tenant.id, action.id || action.name);
              actionOutputs.push(`Delete contact: ${JSON.stringify(delContactResult)}`);
            }
            break;
          case 'browse':
            if (action.url) {
              const browseResult = await browse(action.url, { screenshot: action.screenshot || false });
              if (browseResult.error) {
                actionOutputs.push(`Browse error: ${browseResult.error}`);
              } else {
                actionOutputs.push(`Browse: ${browseResult.url}\nTitle: ${browseResult.title}\n\n${browseResult.text}`);
                if (browseResult.screenshot) {
                  try {
                    const { sendImageMessage } = require('./whatsapp');
                    // Save screenshot temporarily and send
                    const tmpPath = `/tmp/screenshot-${Date.now()}.jpg`;
                    require('fs').writeFileSync(tmpPath, browseResult.screenshot);
                    // Can't send local file via WhatsApp API link, note it
                    actionOutputs.push('(Screenshot captured but WhatsApp requires URL for images)');
                  } catch (e) {}
                }
              }
            }
            break;
          case 'browse_fill_form':
            if (action.url && action.fields) {
              const formResult = await fillForm(action.url, action.fields, action.submit);
              if (formResult.error) {
                actionOutputs.push(`Form error: ${formResult.error}`);
              } else {
                actionOutputs.push(`Form submitted successfully.\nResult URL: ${formResult.resultUrl}\nPage text:\n${formResult.resultText}`);
              }
            }
            break;
          case 'browse_screenshot':
            if (action.url) {
              const ssResult = await takeScreenshot(action.url);
              if (ssResult.error) {
                actionOutputs.push(`Screenshot error: ${ssResult.error}`);
              } else {
                actionOutputs.push(`Screenshot of "${ssResult.title}" captured. (Note: WhatsApp image sending requires a public URL)`);
              }
            }
            break;
          case 'workspace_write':
            if (action.path && action.content !== undefined) {
              const wsResult = workspace.writeFile(tenant.id, action.path, action.content);
              actionOutputs.push(`Workspace write: ${JSON.stringify(wsResult)}`);
              if (wsResult.success) appendDailyNote(tenant, `File saved: ${action.path}`);
            }
            break;
          case 'workspace_read':
            if (action.path) {
              const wsResult = workspace.readFile(tenant.id, action.path);
              if (wsResult.error) {
                actionOutputs.push(`Workspace read error: ${wsResult.error}`);
              } else {
                actionOutputs.push(`File: ${action.path}${wsResult.truncated ? ' (truncated)' : ''}\n\n${wsResult.content}`);
              }
            }
            break;
          case 'workspace_append':
            if (action.path && action.content) {
              const wsResult = workspace.appendFile(tenant.id, action.path, action.content);
              actionOutputs.push(`Workspace append: ${JSON.stringify(wsResult)}`);
            }
            break;
          case 'workspace_list': {
            const wsResult = workspace.listFiles(tenant.id, action.path || '/');
            if (wsResult.error) {
              actionOutputs.push(`Workspace list error: ${wsResult.error}`);
            } else if (wsResult.files.length === 0) {
              actionOutputs.push('Workspace is empty. No files or folders yet.');
            } else {
              const listing = wsResult.files.map(f => 
                f.type === 'dir' ? `📁 ${f.name}/` : `📄 ${f.name} (${f.size} bytes)`
              ).join('\n');
              actionOutputs.push(`Workspace files (${action.path || '/'}):\n${listing}`);
            }
            break;
          }
          case 'workspace_delete':
            if (action.path) {
              const wsResult = workspace.deleteFile(tenant.id, action.path);
              actionOutputs.push(`Workspace delete: ${JSON.stringify(wsResult)}`);
              if (wsResult.success) appendDailyNote(tenant, `File deleted: ${action.path}`);
            }
            break;
          case 'workspace_edit':
            if (action.path && action.old_text && action.new_text) {
              const wsResult = workspace.editFile(tenant.id, action.path, action.old_text, action.new_text);
              actionOutputs.push(`Workspace edit: ${JSON.stringify(wsResult)}`);
            }
            break;
          case 'multi_step':
            if (action.steps && Array.isArray(action.steps)) {
              const stepResults = [];
              for (let i = 0; i < Math.min(action.steps.length, 5); i++) {
                const step = action.steps[i];
                try {
                  if (step.type === 'web_search' && step.query) {
                    const r = await webSearch(step.query);
                    stepResults.push(`Step ${i+1} [search: ${step.query}]:\n${r.results || r.error || 'No results'}`);
                  } else if (step.type === 'fetch_url' && step.url) {
                    const r = await fetchUrl(step.url);
                    stepResults.push(`Step ${i+1} [fetch: ${step.url}]:\n${r.content || r.error || 'No content'}`);
                  } else if (step.type === 'analyze_image' && step.url) {
                    const r = await analyzeImage(step.url, step.prompt || 'Describe this image.');
                    stepResults.push(`Step ${i+1} [image: ${step.url}]:\n${r.description || r.error || 'No result'}`);
                  } else {
                    stepResults.push(`Step ${i+1}: Unknown step type "${step.type}"`);
                  }
                } catch (stepErr) {
                  stepResults.push(`Step ${i+1} error: ${stepErr.message}`);
                }
              }
              actionOutputs.push(`Multi-step results:\n\n${stepResults.join('\n\n---\n\n')}`);
            }
            break;
          case 'create_cron':
            if (action.name && action.schedule) {
              const cronResult = manageCronJob(tenant.id, 'create', { name: action.name, schedule: action.schedule, action: action.action || { type: 'send_message', message: action.message || action.name } });
              actionOutputs.push(`Create cron: ${JSON.stringify(cronResult)}`);
            }
            break;
          case 'list_crons': {
            const cronList = manageCronJob(tenant.id, 'list', {});
            actionOutputs.push(`Cron jobs: ${JSON.stringify(cronList, null, 2)}`);
            break;
          }
          case 'delete_cron':
            if (action.id) {
              const delResult = manageCronJob(tenant.id, 'delete', { id: action.id });
              actionOutputs.push(`Delete cron: ${JSON.stringify(delResult)}`);
            }
            break;
          case 'restart_service':
            const result = restartService();
            actionOutputs.push(`Restart service\nResult: ${JSON.stringify(result, null, 2)}`);
            break;
        }
      } catch (e) {
        console.error('Action parse error:', e.message);
      }
    }

    // If there were tool outputs, make a second AI call so it can see the results
    if (actionOutputs.length > 0) {
      const toolResultsMessage = `Tool execution results:\n\n${actionOutputs.join('\n\n---\n\n')}`;
      
      // Build messages: original conversation + assistant action + tool results
      const followUpMessages = [...messages];
      followUpMessages.push({ role: 'assistant', content: reply || 'Executing requested tools now.' });
      followUpMessages.push({ role: 'user', content: '[TOOL_RESULTS] ' + toolResultsMessage + '\nNow respond naturally to the user based on these results. Do NOT include any action blocks.' });
      
      // Make second AI call
      const response2 = await client.messages.create({
        model,
        max_tokens: tenant.max_tokens || 4096,
        system: systemPrompt,
        messages: followUpMessages
      });
      
      reply = (response2.content[0] && response2.content[0].text) || "";
      reply = reply.replace(/```action\n[\s\S]*?```/g, '').trim();
      logUsage(tenant.id, response2.usage?.input_tokens || 0, response2.usage?.output_tokens || 0, model);
    }

    // Strip action blocks from reply
    reply = reply.replace(/```action\n[\s\S]*?```/g, '').trim();

    saveConversation(tenant.id, 'assistant', reply, outputTokens);

    console.log(`[AI] Tenant #${tenant.id} | in:${inputTokens} out:${outputTokens} | ${model}`);
    return reply;
  } catch (err) {
    console.error('AI error:', err.message);
    return "I'm having a moment — give me a sec and try again. 🤖";
  }
}

module.exports = { processMessage };
