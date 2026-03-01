/**
 * AgentMail Integration Handler
 * Processes incoming emails and sends responses via AgentMail API
 */

const AGENTMAIL_API_KEY = process.env.AGENTMAIL_API_KEY || '[CONFIGURE_IN_ENV]';
const INBOX_ID = 'george-openclaw@agentmail.to';

/**
 * Fetch unread messages from AgentMail
 */
async function checkInbox() {
    const response = await fetch(`https://api.agentmail.to/v0/inboxes/${INBOX_ID}/messages?limit=10`, {
        headers: {
            'Authorization': `Bearer ${AGENTMAIL_API_KEY}`,
            'Content-Type': 'application/json'
        }
    });

    const data = await response.json();
    return data.messages || [];
}

/**
 * Send email via AgentMail
 */
async function sendEmail(to, subject, body) {
    const response = await fetch(`https://api.agentmail.to/v0/inboxes/${INBOX_ID}/messages`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${AGENTMAIL_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            to: to,
            subject: subject,
            text: body
        })
    });

    return response.json();
}

/**
 * Process webhook payload from AgentMail
 */
function processWebhook(payload) {
    const { message_id, from, subject, text } = payload;

    console.log(`New email from ${from}`);
    console.log(`Subject: ${subject}`);
    console.log(`Message ID: ${message_id}`);

    // Process email content here
    // Could trigger OpenClaw actions, forward to Wayne, etc.

    return {
        processed: true,
        message_id: message_id
    };
}

module.exports = {
    checkInbox,
    sendEmail,
    processWebhook
};
