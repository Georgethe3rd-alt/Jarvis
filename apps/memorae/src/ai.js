const Anthropic = require('@anthropic-ai/sdk').default;
const db = require('./db');
const { getConfig, sendMessage: sendWhatsApp } = require('./whatsapp');
const { provisionTenant, getTenantMemoryContext, appendDailyNote, updateMemoryFile, updateSoulFile } = require('./tenant');
const { setBriefingTime } = require('./briefings');

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

function saveReminder(tenantId, content, remindAt) {
  db.prepare('INSERT INTO reminders (tenant_id, content, remind_at) VALUES (?, ?, ?)')
    .run(tenantId, content, remindAt);
}

function logUsage(tenantId, inputTokens, outputTokens, model) {
  db.prepare('INSERT INTO usage_log (tenant_id, input_tokens, output_tokens, model) VALUES (?, ?, ?, ?)')
    .run(tenantId, inputTokens, outputTokens, model);
}

async function processMessage(phone, name, text) {
  // Provision or retrieve tenant
  const tenant = provisionTenant(phone, name);
  const isNew = tenant.message_count === 0;

  saveConversation(tenant.id, 'user', text);

  // Get full context
  const ctx = getTenantMemoryContext(tenant);
  const history = getRecentConversation(tenant.id);
  const model = tenant.model || getConfig('anthropic_model') || 'claude-sonnet-4-5-20250514';

  const memoryBlock = ctx.memories.length > 0
    ? `\n\nSaved memories:\n${ctx.memories.map(m => `- [${m.category}] ${m.content}`).join('\n')}`
    : '';

  const reminderBlock = ctx.reminders.length > 0
    ? `\n\nPending reminders:\n${ctx.reminders.map(r => `- ${r.content} (due: ${r.remind_at})`).join('\n')}`
    : '';

  const systemPrompt = `${ctx.soul}

---
WORKSPACE CONTEXT:

${ctx.memory}

${ctx.dailyNotes ? `Recent notes:\n${ctx.dailyNotes}` : ''}
${memoryBlock}${reminderBlock}

---
INSTRUCTIONS:

Current time: ${new Date().toISOString()}
User: ${name || 'Unknown'} (${phone})
${isNew ? 'THIS IS A NEW USER — welcome them warmly and explain what you can do.' : ''}

When the user tells you to remember something, save it as a memory.
When the user asks to be reminded, save it as a reminder with a datetime.
When you learn something important about the user, update their memory file.

To perform actions, include JSON blocks at the END of your reply (they will be stripped before sending):

\`\`\`action
{"type": "save_memory", "content": "...", "category": "general|work|personal|health|finance|ideas|contacts|shopping|travel"}
\`\`\`

\`\`\`action
{"type": "save_reminder", "content": "...", "remind_at": "YYYY-MM-DD HH:MM"}
\`\`\`

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

When the user asks to send something to another phone number (like "send my grocery list to +1868..."), use send_to_contact.
When the user asks to remind someone else at another phone number, use send_to_contact with an appropriate message.
When the user asks to set a daily briefing time, use set_briefing_time.
When the user asks you to change your personality, tone, language, or name — use update_soul to persist that change.

LANGUAGE DETECTION:
- Detect the language the user writes in and respond in the same language. If they switch languages mid-conversation, follow their lead.
- If the user says "speak to me in [language]", switch to that language and save it as a preference via update_soul action.

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

    let reply = response.content[0].text;
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;

    logUsage(tenant.id, inputTokens, outputTokens, model);

    // Parse and execute actions
    const actionRegex = /```action\n([\s\S]*?)```/g;
    let match;
    while ((match = actionRegex.exec(reply)) !== null) {
      try {
        const action = JSON.parse(match[1]);
        switch (action.type) {
          case 'save_memory':
            saveMemory(tenant.id, action.content, action.category || 'general');
            appendDailyNote(tenant, `Memory saved: ${action.content}`);
            break;
          case 'save_reminder':
            saveReminder(tenant.id, action.content, action.remind_at);
            appendDailyNote(tenant, `Reminder set: ${action.content} at ${action.remind_at}`);
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
          case 'set_briefing_time':
            if (action.time) {
              const formatted = setBriefingTime(tenant.id, action.time);
              if (formatted) appendDailyNote(tenant, `Daily briefing set for ${formatted}`);
            }
            break;
        }
      } catch (e) {
        console.error('Action parse error:', e.message);
      }
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
