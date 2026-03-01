// ─── Email Notifications ────────────────────────────────────
// Uses nodemailer with SMTP config from admin console config keys.
// If SMTP not configured, all send functions silently skip.

const nodemailer = require('nodemailer');
const db = require('./db');

let _transporter = null;
let _configured = null; // null = unchecked, true/false = checked

function getSmtpConfig() {
  try {
    const get = (key) => {
      const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
      return row ? row.value : null;
    };
    const host = get('smtp_host');
    const port = get('smtp_port');
    const user = get('smtp_user');
    const pass = get('smtp_pass');
    const from = get('smtp_from');
    if (!host || !user || !pass) return null;
    return { host, port: parseInt(port) || 587, user, pass, from: from || user };
  } catch {
    return null;
  }
}

function getTransporter() {
  const config = getSmtpConfig();
  if (!config) {
    _configured = false;
    return null;
  }
  _configured = true;
  // Recreate transporter each time in case config changed
  _transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.pass }
  });
  _transporter._fromAddress = config.from;
  return _transporter;
}

async function sendEmail(to, subject, html, text) {
  const transport = getTransporter();
  if (!transport) return false;
  try {
    await transport.sendMail({
      from: transport._fromAddress,
      to,
      subject,
      html,
      text: text || subject
    });
    console.log(`[EMAIL] Sent "${subject}" to ${to}`);
    return true;
  } catch (err) {
    console.error('[EMAIL ERROR]', err.message);
    return false;
  }
}

// ─── Template Emails ────────────────────────────────────────

async function sendActivationCode(email, name, code) {
  if (!email) return false;
  return sendEmail(email, `Your Jarvis Activation Code: ${code}`,
    `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#0a0a1a;color:#c8dce8;padding:2rem;border:1px solid #1a3a5a;border-radius:8px">
      <h1 style="color:#0af;font-size:1.4rem;margin-bottom:1rem">J.A.R.V.I.S. Activation</h1>
      <p>Hello ${name},</p>
      <p>Your activation code is:</p>
      <div style="text-align:center;font-size:2.5rem;font-weight:bold;color:#00e5ff;letter-spacing:8px;margin:1.5rem 0;font-family:monospace">${code}</div>
      <p>Send this code to our WhatsApp number to bring your personal AI assistant online.</p>
      <p style="color:#4a6a80;font-size:0.85rem;margin-top:2rem">This code expires in 24 hours.</p>
    </div>`,
    `Your Jarvis activation code is: ${code}. Send this code to our WhatsApp number to activate.`
  );
}

async function sendWelcomeEmail(email, name) {
  if (!email) return false;
  return sendEmail(email, `Welcome to Jarvis, ${name}!`,
    `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#0a0a1a;color:#c8dce8;padding:2rem;border:1px solid #1a3a5a;border-radius:8px">
      <h1 style="color:#0af;font-size:1.4rem;margin-bottom:1rem">Welcome Online, ${name}</h1>
      <p>Your Jarvis instance has been activated and is ready to serve.</p>
      <p>Here's what you can do:</p>
      <ul style="color:#4a6a80;line-height:2">
        <li>🧠 <strong style="color:#c8dce8">Total Recall</strong> — Tell me anything. I never forget.</li>
        <li>⏰ <strong style="color:#c8dce8">Reminders</strong> — Natural language scheduling.</li>
        <li>📊 <strong style="color:#c8dce8">Daily Briefing</strong> — Your morning report.</li>
        <li>💬 <strong style="color:#c8dce8">Draft & Think</strong> — Brainstorm and write together.</li>
      </ul>
      <p>Simply send a WhatsApp message to get started.</p>
      <p style="color:#4a6a80;font-size:0.85rem;margin-top:2rem">— J.A.R.V.I.S.</p>
    </div>`,
    `Welcome to Jarvis, ${name}! Your AI assistant is online and ready. Send a WhatsApp message to get started.`
  );
}

async function sendPlanUpgradeEmail(email, name, plan) {
  if (!email) return false;
  const planNames = { pro: 'Pro', unlimited: 'Unlimited' };
  const planLabel = planNames[plan] || plan;
  return sendEmail(email, `Plan Upgraded to ${planLabel}`,
    `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#0a0a1a;color:#c8dce8;padding:2rem;border:1px solid #1a3a5a;border-radius:8px">
      <h1 style="color:#0af;font-size:1.4rem;margin-bottom:1rem">Plan Upgrade Confirmed</h1>
      <p>Hello ${name},</p>
      <p>Your Jarvis plan has been upgraded to <strong style="color:#00e5ff">${planLabel}</strong>.</p>
      <p>Thank you for your support. Enjoy the expanded capabilities!</p>
      <p style="color:#4a6a80;font-size:0.85rem;margin-top:2rem">— J.A.R.V.I.S.</p>
    </div>`,
    `Your Jarvis plan has been upgraded to ${planLabel}. Thank you!`
  );
}

module.exports = { sendEmail, sendActivationCode, sendWelcomeEmail, sendPlanUpgradeEmail };
