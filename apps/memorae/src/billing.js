const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const db = require('./db');
const { getConfig } = require('./whatsapp');

const router = express.Router();

// ─── Plans ──────────────────────────────────────────────────
const PLANS = {
  free:      { name: 'Free',      price: 0,     messagesPerMonth: 50,   label: '50 messages/month' },
  pro:       { name: 'Pro',       price: 9.99,  messagesPerMonth: 500,  label: '500 messages/month' },
  unlimited: { name: 'Unlimited', price: 24.99, messagesPerMonth: Infinity, label: 'Unlimited messages' }
};

// ─── DB Migrations ──────────────────────────────────────────
function migrateBilling() {
  const cols = db.prepare("PRAGMA table_info(tenants)").all().map(c => c.name);
  if (!cols.includes('plan_expires_at'))    db.exec("ALTER TABLE tenants ADD COLUMN plan_expires_at DATETIME");
  if (!cols.includes('messages_this_month'))db.exec("ALTER TABLE tenants ADD COLUMN messages_this_month INTEGER DEFAULT 0");
  if (!cols.includes('month_reset_date'))   db.exec("ALTER TABLE tenants ADD COLUMN month_reset_date TEXT");
}
migrateBilling();

// ─── WiPay Config ───────────────────────────────────────────
function getWiPayConfig() {
  return {
    account_number: getConfig('wipay_account_number') || '1234567890',
    api_key: getConfig('wipay_api_key') || '123',
    environment: getConfig('wipay_environment') || 'sandbox',
    base_url: getConfig('app_base_url') || `http://localhost:${process.env.PORT || 3003}`
  };
}

// ─── Check Message Limits ───────────────────────────────────
function checkAndResetMonth(tenant) {
  const now = new Date();
  const resetDate = tenant.month_reset_date ? new Date(tenant.month_reset_date) : null;
  if (!resetDate || now >= resetDate) {
    const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
    db.prepare('UPDATE tenants SET messages_this_month = 0, month_reset_date = ? WHERE id = ?')
      .run(nextReset, tenant.id);
    tenant.messages_this_month = 0;
    tenant.month_reset_date = nextReset;
  }
}

function canSendMessage(tenant) {
  checkAndResetMonth(tenant);
  const plan = PLANS[tenant.plan || 'free'];
  if (!plan) return true;
  if (plan.messagesPerMonth === Infinity) return true;

  // Check if plan expired
  if (tenant.plan !== 'free' && tenant.plan_expires_at) {
    if (new Date() > new Date(tenant.plan_expires_at)) {
      db.prepare("UPDATE tenants SET plan = 'free' WHERE id = ?").run(tenant.id);
      tenant.plan = 'free';
      return tenant.messages_this_month < PLANS.free.messagesPerMonth;
    }
  }

  return tenant.messages_this_month < plan.messagesPerMonth;
}

function incrementMessageCount(tenantId) {
  db.prepare('UPDATE tenants SET messages_this_month = messages_this_month + 1 WHERE id = ?').run(tenantId);
}

function getUpgradeMessage(tenant) {
  const plan = PLANS[tenant.plan || 'free'];
  const base = getWiPayConfig().base_url;
  return `⚠️ You've used all ${plan.messagesPerMonth} messages for this month on the *${plan.name}* plan.\n\n` +
    `Upgrade to keep chatting:\n` +
    `📦 *Pro* — $9.99/mo (500 msgs): ${base}/billing/checkout/pro?phone=${tenant.phone}\n` +
    `🚀 *Unlimited* — $24.99/mo: ${base}/billing/checkout/unlimited?phone=${tenant.phone}\n\n` +
    `Your limit resets on ${tenant.month_reset_date ? new Date(tenant.month_reset_date).toLocaleDateString() : 'the 1st of next month'}.`;
}

// ─── Routes ─────────────────────────────────────────────────

// GET /billing/plans
router.get('/plans', (req, res) => {
  res.json(PLANS);
});

// GET /billing/checkout/:plan?phone=XXXX
router.get('/checkout/:plan', (req, res) => {
  const planKey = req.params.plan;
  const phone = req.query.phone;
  const plan = PLANS[planKey];

  if (!plan || planKey === 'free') return res.status(400).send('Invalid plan');
  if (!phone) return res.status(400).send('Phone number required');

  const tenant = db.prepare('SELECT * FROM tenants WHERE phone = ?').get(phone);
  if (!tenant) return res.status(404).send('User not found');

  const wp = getWiPayConfig();
  const orderId = `jarvis-${tenant.id}-${planKey}-${Date.now()}`;

  // Build WiPay form and auto-submit
  res.send(`
    <!DOCTYPE html><html><head><title>Redirecting to payment...</title></head>
    <body style="background:#0a0a0a;color:#0f0;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh">
      <div>
        <p>🔄 Redirecting to WiPay checkout...</p>
        <form id="wpform" method="POST" action="https://tt.wipayfinancial.com/plugins/payments/request">
          <input type="hidden" name="account_number" value="${wp.account_number}">
          <input type="hidden" name="country_code" value="TT">
          <input type="hidden" name="currency" value="USD">
          <input type="hidden" name="environment" value="${wp.environment}">
          <input type="hidden" name="fee_structure" value="customer_pay">
          <input type="hidden" name="method" value="credit_card">
          <input type="hidden" name="order_id" value="${orderId}">
          <input type="hidden" name="origin" value="Jarvis">
          <input type="hidden" name="total" value="${plan.price.toFixed(2)}">
          <input type="hidden" name="addr_email" value="${tenant.email || ''}">
          <input type="hidden" name="url" value="${wp.base_url}/billing/callback">
          <input type="hidden" name="response_url" value="${wp.base_url}/billing/webhook">
        </form>
        <script>document.getElementById('wpform').submit();</script>
      </div>
    </body></html>
  `);
});

// GET /billing/callback — user redirect after payment
router.get('/callback', (req, res) => {
  const { status, order_id, transaction_id } = req.query;
  if (status === 'success' && order_id) {
    activatePlan(order_id);
    res.send(`
      <!DOCTYPE html><html><head><title>Payment Successful</title></head>
      <body style="background:#0a0a0a;color:#0f0;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column">
        <h1>✅ Payment Successful</h1>
        <p>Your plan has been upgraded. You can close this page and return to WhatsApp.</p>
      </body></html>
    `);
  } else {
    res.send(`
      <!DOCTYPE html><html><head><title>Payment Failed</title></head>
      <body style="background:#0a0a0a;color:#f00;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column">
        <h1>❌ Payment Failed</h1>
        <p>Something went wrong. Please try again from WhatsApp.</p>
      </body></html>
    `);
  }
});

// POST /billing/webhook — server-to-server confirmation from WiPay
router.post('/webhook', (req, res) => {
  const { status, order_id, transaction_id } = req.body;
  console.log(`[WIPAY WEBHOOK] status=${status} order=${order_id} txn=${transaction_id}`);
  if (status === 'success' && order_id) {
    activatePlan(order_id);
  }
  res.sendStatus(200);
});

function activatePlan(orderId) {
  // Parse order_id: jarvis-{tenantId}-{plan}-{timestamp}
  const parts = orderId.split('-');
  if (parts.length < 3) return;
  const tenantId = parseInt(parts[1]);
  const planKey = parts[2];
  if (!PLANS[planKey] || planKey === 'free') return;

  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + 1);

  db.prepare('UPDATE tenants SET plan = ?, plan_expires_at = ?, messages_this_month = 0 WHERE id = ?')
    .run(planKey, expiresAt.toISOString(), tenantId);
  console.log(`[BILLING] Tenant #${tenantId} upgraded to ${planKey} until ${expiresAt.toISOString()}`);
}

module.exports = { router, PLANS, canSendMessage, incrementMessageCount, getUpgradeMessage };
