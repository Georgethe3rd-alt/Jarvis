# J.A.R.V.I.S. — Multi-Tenant AI Assistant Platform

> **Just A Rather Very Intelligent System**
>
> A WhatsApp-native AI assistant that gives every user their own isolated, persistent AI workspace with memory, reminders, voice, document understanding, and more.

Built on Node.js, Express, SQLite, Anthropic Claude, OpenAI Whisper, ElevenLabs TTS, and WiPay payments.

---

## Table of Contents

- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [User Flow](#user-flow)
- [Features](#features)
- [API Reference](#api-reference)
- [Admin Console](#admin-console)
- [User Dashboard](#user-dashboard)
- [Billing & Plans](#billing--plans)
- [Voice & Calls](#voice--calls)
- [Document Processing](#document-processing)
- [Deployment](#deployment)
- [File Structure](#file-structure)

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    JARVIS PLATFORM                    │
├─────────────────────────────────────────────────────┤
│                                                       │
│  ┌───────────┐  ┌───────────┐  ┌──────────────────┐ │
│  │  WhatsApp  │  │  Twilio   │  │   Web Browser    │ │
│  │ Cloud API  │  │  Voice    │  │  (Landing/Admin/ │ │
│  │  Webhook   │  │  Webhook  │  │   Dashboard)     │ │
│  └─────┬─────┘  └─────┬─────┘  └────────┬─────────┘ │
│        │              │                   │           │
│  ┌─────▼─────────────▼───────────────────▼─────────┐ │
│  │              EXPRESS SERVER (:3003)               │ │
│  ├──────────────────────────────────────────────────┤ │
│  │                                                    │ │
│  │  ┌────────┐ ┌─────────┐ ┌──────────┐ ┌────────┐ │ │
│  │  │Webhook │ │ Tenant  │ │    AI    │ │ Voice  │ │ │
│  │  │Handler │ │Provision│ │ Engine   │ │Process │ │ │
│  │  └────┬───┘ └────┬────┘ └────┬─────┘ └───┬────┘ │ │
│  │       │          │           │            │       │ │
│  │  ┌────▼──────────▼───────────▼────────────▼────┐ │ │
│  │  │              SQLite Database                  │ │ │
│  │  │  tenants | conversations | memories          │ │ │
│  │  │  reminders | signups | config | usage_log    │ │ │
│  │  └──────────────────────────────────────────────┘ │ │
│  │                                                    │ │
│  │  ┌──────────────────────────────────────────────┐ │ │
│  │  │         Tenant Workspaces (filesystem)        │ │ │
│  │  │  data/tenants/{id}/SOUL.md                    │ │ │
│  │  │  data/tenants/{id}/MEMORY.md                  │ │ │
│  │  │  data/tenants/{id}/memory/YYYY-MM-DD.md       │ │ │
│  │  └──────────────────────────────────────────────┘ │ │
│  └──────────────────────────────────────────────────┘ │
│                                                       │
│  External Services:                                   │
│  • Anthropic Claude (AI + Vision)                     │
│  • OpenAI Whisper (Speech-to-Text)                    │
│  • ElevenLabs (Text-to-Speech)                        │
│  • WiPay (Payments)                                   │
│  • Meta WhatsApp Cloud API                            │
│  • Twilio (Voice Calls)                               │
│                                                       │
└─────────────────────────────────────────────────────┘
```

---

## Quick Start

### Prerequisites
- Node.js 18+
- npm or pnpm

### Install & Run

```bash
cd apps/memorae
cp .env.example .env    # Edit with your API keys
npm install
mkdir -p data/tenants data/tmp data/call-audio
node src/index.js
```

Server starts on port 3003 (configurable via `PORT` env var).

### Endpoints After Start
| URL | Description |
|-----|-------------|
| `http://HOST:3003` | Landing page (sign-up) |
| `http://HOST:3003/admin` | Admin console |
| `http://HOST:3003/dashboard` | User dashboard |
| `http://HOST:3003/webhook` | WhatsApp webhook |
| `http://HOST:3003/voice/incoming` | Twilio voice webhook |
| `http://HOST:3003/billing/plans` | Plans JSON |
| `http://HOST:3003/health` | Health check |

---

## Configuration

### Environment Variables (`.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | ✅ | Claude API key for AI processing |
| `WHATSAPP_TOKEN` | ✅* | Meta WhatsApp Cloud API token |
| `WHATSAPP_PHONE_NUMBER_ID` | ✅* | Your WhatsApp Business phone number ID |
| `WHATSAPP_VERIFY_TOKEN` | ✅* | Webhook verification token (you choose this) |
| `OPENAI_API_KEY` | ✅ | For Whisper speech-to-text transcription |
| `ELEVENLABS_API_KEY` | ⬚ | For voice note replies (Daniel voice) |
| `ELEVENLABS_VOICE_ID` | ⬚ | Default: `onwK4e9ZLuTAKqWW03F9` (Daniel) |
| `ADMIN_JWT_SECRET` | ✅ | JWT signing key for admin console |
| `ADMIN_USER` | ✅ | Admin login username |
| `ADMIN_PASS` | ✅ | Admin login password |
| `PORT` | ⬚ | Server port (default: 3003) |
| `BASE_URL` | ⬚ | Public URL for callbacks (e.g., `https://jarvis.yourdomain.com`) |

*\*Can also be set via Admin Console → API Keys (stored in DB)*

### Dynamic Configuration (Admin Console)

All API keys can be updated at runtime via the Admin Console without restarting the server. Keys stored in the `config` DB table override environment variables.

| Config Key | Description |
|------------|-------------|
| `whatsapp_token` | WhatsApp Cloud API token |
| `whatsapp_phone_number_id` | WhatsApp phone number ID |
| `whatsapp_verify_token` | Webhook verify token |
| `anthropic_api_key` | Anthropic API key |
| `anthropic_model` | Model name (default: `claude-sonnet-4-5-20250514`) |
| `openai_api_key` | OpenAI API key (for Whisper) |
| `elevenlabs_api_key` | ElevenLabs API key |
| `elevenlabs_voice_id` | ElevenLabs voice ID |
| `wipay_account_number` | WiPay merchant account number |
| `wipay_api_key` | WiPay API key |
| `wipay_environment` | `sandbox` or `live` |
| `app_base_url` | Public base URL for payment callbacks |

---

## User Flow

### 1. Sign Up
```
User visits landing page → Enters name, email, WhatsApp number
→ Receives 6-digit activation code (valid 24h)
```

### 2. Activate
```
User texts activation code to WhatsApp number
→ Jarvis verifies code → Provisions isolated workspace
→ Starts 3-step onboarding
```

### 3. Onboarding (3 questions)
```
Step 1: "What should I call you?" → Saves display name + MEMORY.md
Step 2: "What do you do for work?" → Saves to MEMORY.md
Step 3: "What's the main thing you want help with?" → Saves to MEMORY.md + SOUL.md
→ "You're all set!" → Normal AI mode begins
```

### 4. Normal Usage
```
Text messages → AI responds with full memory context
Voice notes → Whisper transcribes → AI responds → ElevenLabs voice reply
Images → Claude Vision analyzes → AI responds with context
Documents → Extracted text fed to AI for summarization/Q&A
Phone calls → Twilio STT → AI → ElevenLabs TTS → live conversation
```

### 5. Message Limits
```
Free: 50 messages/month
Pro ($9.99): 500 messages/month
Unlimited ($24.99): No limit
Exceeded? → Upgrade link sent → WiPay checkout → Plan activates instantly
```

---

## Features

### Core AI
- **Persistent Memory** — Each user has their own SOUL.md, MEMORY.md, and daily notes. AI reads these for every response.
- **Memory Actions** — AI automatically saves important facts, sets reminders, updates user profiles.
- **Personality Customization** — Users can change Jarvis's tone, language, name. Persisted to SOUL.md.
- **Conversation History** — Last 20 messages used as context. Full history stored in DB.

### Communication
- **Text Messages** — Standard WhatsApp text processing.
- **Voice Notes** — Inbound: Whisper transcription. Outbound: ElevenLabs TTS as voice note.
- **Phone Calls** — Twilio-powered live voice conversations with AI.
- **Document Reading** — PDF text extraction, Word (.docx) parsing, image OCR/analysis.
- **Image Analysis** — Claude Vision describes images, extracts text, summarizes data.

### Productivity
- **Smart Reminders** — Natural language: "Remind me to call Mom at 5pm". Auto-delivered via WhatsApp.
- **Daily Briefings** — Scheduled morning summaries. User sets time: "Set my briefing for 8am".
- **Lists & Organization** — AI categorizes memories: work, personal, health, finance, ideas, shopping, etc.
- **Sharing** — "Send my grocery list to +1868XXXXXXX" — delivers via WhatsApp.

### Business
- **Multi-Tenant** — Each user gets isolated workspace, DB records, and file storage.
- **WiPay Billing** — Free/Pro/Unlimited plans. Caribbean payment processing via WiPay.
- **Admin Console** — Full management: users, configs, analytics, signups.
- **User Dashboard** — Web portal for memories, reminders, settings, plan management.

---

## API Reference

### Public Endpoints

#### `POST /api/register`
Register a new user and get activation code.
```json
// Request
{ "name": "John", "email": "john@example.com", "phone": "+18681234567" }

// Response
{ "success": true, "activation_code": "482910", "expires_at": "2026-03-02T..." }
```

#### `GET /webhook`
WhatsApp webhook verification (Meta).

#### `POST /webhook`
WhatsApp incoming message handler. Processes text, voice, images, documents.

#### `POST /voice/incoming`
Twilio voice call webhook. Returns TwiML for live conversation.

#### `GET /billing/plans`
Returns available plans and pricing.

#### `GET /billing/checkout/:plan?phone=XXXX`
Redirects to WiPay checkout for the specified plan.

#### `GET /health`
```json
{ "status": "ok", "uptime": 3600, "tenants": 42, "pendingSignups": 3 }
```

### Admin API (`/admin/api`)
*All require `Authorization: Bearer <token>` header.*

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/login` | Admin login → JWT token |
| `GET` | `/stats` | Dashboard statistics |
| `GET` | `/tenants` | List all tenants |
| `GET` | `/tenants/:id` | Tenant detail (conversations, memories, files) |
| `PUT` | `/tenants/:id` | Update tenant (status, model, plan) |
| `PUT` | `/tenants/:id/files` | Edit tenant's SOUL.md / MEMORY.md |
| `GET` | `/signups` | List all signups |
| `POST` | `/signups/generate` | Manually generate activation code |
| `GET` | `/config` | List all config keys (masked values) |
| `PUT` | `/config` | Set a config key |
| `DELETE` | `/config/:key` | Delete a config key |
| `GET` | `/usage` | Token usage by day (30 days) |
| `GET` | `/analytics` | Full analytics (retention, revenue, top users) |

### User Dashboard API (`/dashboard/api`)
*All require `Authorization: Bearer <token>` header (except login).*

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/login/request` | Request login code (sent via WhatsApp) |
| `POST` | `/login/verify` | Verify code → JWT token |
| `GET` | `/profile` | User profile + plan info |
| `GET` | `/memories` | List user's memories |
| `PUT` | `/memories/:id` | Edit a memory |
| `DELETE` | `/memories/:id` | Delete a memory |
| `GET` | `/reminders` | List user's reminders |
| `DELETE` | `/reminders/:id` | Delete a reminder |
| `GET` | `/conversations` | Conversation history |
| `PUT` | `/settings/briefing` | Set daily briefing time |
| `PUT` | `/settings/name` | Update display name |

---

## Admin Console

**URL:** `http://HOST:3003/admin`

### Pages
- **Dashboard** — Total tenants, active today, messages, memories, reminders, pending signups, token usage.
- **Tenants** — List all users. Click to view: conversations, memories, reminders, SOUL.md/MEMORY.md editor, settings (model, max tokens, status, plan).
- **Signups** — All registrations with activation codes. Generate codes manually for VIP access.
- **API Keys** — Add/update/delete all config keys from the UI. Sensitive values are masked.
- **Usage** — Daily token usage breakdown (input/output/total).
- **Analytics** — Message volume trends, 7d/30d retention, cost per user, top users, plan distribution, MRR.

### Default Login
- **Username:** Set via `ADMIN_USER` env var
- **Password:** Set via `ADMIN_PASS` env var

---

## User Dashboard

**URL:** `http://HOST:3003/dashboard`

### Login Flow
1. User enters their WhatsApp phone number
2. Jarvis sends a 6-digit code via WhatsApp
3. User enters code → logged in for 7 days

### Pages
- **Overview** — Plan status, messages used, member since
- **Memories** — Search, edit, delete saved memories
- **Reminders** — View pending/sent reminders, delete
- **Conversations** — Full chat history
- **Plan & Billing** — Current plan, upgrade links (WiPay checkout)
- **Settings** — Change display name, set daily briefing time

---

## Billing & Plans

### Plans

| Plan | Price | Messages/Month |
|------|-------|---------------|
| Free | $0 | 50 |
| Pro | $9.99/mo | 500 |
| Unlimited | $24.99/mo | Unlimited |

### Payment Flow (WiPay)

```
User hits limit → Jarvis sends upgrade message with link
→ User clicks link → /billing/checkout/:plan
→ Auto-redirects to WiPay hosted checkout
→ User pays with card
→ WiPay redirects to /billing/callback (user sees success/fail page)
→ WiPay POSTs to /billing/webhook (server confirms payment)
→ Plan activates immediately, message count resets
```

### WiPay Configuration

| Setting | Sandbox Value | Live Value |
|---------|--------------|------------|
| `wipay_account_number` | `1234567890` | Your WiPay account number |
| `wipay_api_key` | `123` | Your WiPay API key |
| `wipay_environment` | `sandbox` | `live` |

Set via Admin Console → API Keys, or in `.env`.

### Monthly Reset
- Message counts reset on the 1st of each month automatically.
- If a paid plan expires, user falls back to Free tier.

---

## Voice & Calls

### WhatsApp Voice Notes
- **Inbound:** User sends voice note → downloaded from WhatsApp → transcribed via OpenAI Whisper → processed as text message → AI responds → reply converted to audio via ElevenLabs → sent back as voice note (+ text for long responses).
- **Requirements:** `OPENAI_API_KEY` (Whisper), `ELEVENLABS_API_KEY` (TTS)

### Twilio Voice Calls
- **Inbound:** User calls Twilio number → Twilio webhook hits `/voice/incoming` → greeting → Twilio `<Gather>` captures speech → `/voice/process` handles AI response → ElevenLabs generates audio → `<Play>` sends it back → conversation loops until "goodbye".
- **Twilio Setup:**
  1. Get a Twilio phone number
  2. Set Voice webhook URL to: `https://YOUR_DOMAIN:3003/voice/incoming`
  3. Method: HTTP POST
- **Only registered tenants** can use voice calls. Unregistered callers hear a sign-up prompt.

### Voice ID
Default voice: **Daniel** (`onwK4e9ZLuTAKqWW03F9`) — British, formal, Jarvis-like.
Change via `elevenlabs_voice_id` config key.

---

## Document Processing

### Supported Formats

| Format | How It Works |
|--------|-------------|
| **Images** (JPEG, PNG, WebP, GIF) | Claude Vision analyzes content, extracts text, describes scenes |
| **PDF** | Full text extraction via `pdf-parse`, fed to AI |
| **Word (.docx)** | Text extraction via `mammoth`, fed to AI |
| **Plain text / CSV** | Direct read, fed to AI |

### Limits
- Documents are truncated to 15,000 characters to stay within AI context limits.
- Very large files will note `[...truncated, document continues]`.

### User Experience
```
User sends PDF → "📄 Reading 'report.pdf'..."
→ AI processes extracted text → responds with summary/analysis

User sends image → "🔍 Analyzing your image..."
→ Claude Vision describes it → AI responds in context
```

---

## Deployment

### Systemd Service

```bash
# Create service file
cat > /etc/systemd/system/jarvis-memorae.service << EOF
[Unit]
Description=Jarvis Memorae AI Assistant
After=network.target

[Service]
Type=simple
WorkingDirectory=/root/jarvis/apps/memorae
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
EnvironmentFile=/root/jarvis/apps/memorae/.env

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable jarvis-memorae
systemctl start jarvis-memorae
```

### Nginx Reverse Proxy (with SSL)

```nginx
server {
    listen 80;
    server_name jarvis.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3003;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Then: `certbot --nginx -d jarvis.yourdomain.com`

### Meta WhatsApp Business Setup

1. Go to [Meta Business Suite](https://business.facebook.com)
2. Create a Business App → Add WhatsApp product
3. Get your **Permanent Token** and **Phone Number ID**
4. Set webhook URL: `https://jarvis.yourdomain.com/webhook`
5. Set verify token to match your `WHATSAPP_VERIFY_TOKEN`
6. Subscribe to: `messages`, `messaging_postbacks`
7. Enter token + phone ID in Admin Console → API Keys

---

## File Structure

```
apps/memorae/
├── .env                    # Environment variables (secrets)
├── .env.example            # Template
├── package.json
├── README.md               # This file
│
├── public/
│   ├── index.html          # Landing page (sign-up, Jarvis HUD theme)
│   ├── admin.html          # Admin console (SPA)
│   └── dashboard.html      # User dashboard (SPA)
│
├── src/
│   ├── index.js            # Main server — routes, webhook handler, onboarding
│   ├── db.js               # SQLite database init + schema
│   ├── whatsapp.js         # WhatsApp Cloud API — send/receive/media
│   ├── ai.js               # Anthropic Claude — message processing, actions
│   ├── tenant.js           # Tenant provisioning, workspace management
│   ├── signup.js           # Registration + activation code generation
│   ├── billing.js          # WiPay payment integration, plan management
│   ├── admin.js            # Admin API routes + auth
│   ├── dashboard-api.js    # User dashboard API routes + phone auth
│   ├── voice.js            # Whisper transcription + ElevenLabs TTS
│   ├── calls.js            # Twilio voice call handling
│   ├── documents.js        # PDF/Word/Image processing
│   ├── reminders.js        # Reminder delivery checker
│   └── briefings.js        # Scheduled daily briefings
│
└── data/                   # Runtime data (gitignored)
    ├── jarvis.db           # SQLite database
    ├── tmp/                # Temporary files (voice processing)
    ├── call-audio/         # Generated TTS audio for calls
    └── tenants/            # Per-user workspaces
        └── {id}/
            ├── SOUL.md     # AI personality for this user
            ├── MEMORY.md   # Long-term memory
            └── memory/
                └── YYYY-MM-DD.md  # Daily notes
```

---

## Database Schema

### `tenants`
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| phone | TEXT | WhatsApp number (unique) |
| name | TEXT | Name from signup |
| email | TEXT | Email from signup |
| display_name | TEXT | Preferred name (from onboarding) |
| status | TEXT | `active`, `suspended`, `banned` |
| workspace_path | TEXT | Filesystem path to workspace |
| model | TEXT | AI model override |
| max_tokens | INTEGER | Max response tokens |
| plan | TEXT | `free`, `pro`, `unlimited` |
| plan_expires_at | DATETIME | When paid plan expires |
| messages_this_month | INTEGER | Current month usage |
| month_reset_date | TEXT | When counter resets |
| onboarding_step | TEXT | `name`, `work`, `goals`, `complete` |
| preferred_briefing_time | TEXT | HH:MM format |
| message_count | INTEGER | Lifetime messages |
| memory_count | INTEGER | Total memories |
| created_at | DATETIME | Signup date |
| last_active | DATETIME | Last message |

### `conversations`
Stores all messages (role: `user` or `assistant`) per tenant.

### `memories`
Categorized memory items: `general`, `work`, `personal`, `health`, `finance`, `ideas`, `contacts`, `shopping`, `travel`.

### `reminders`
Scheduled reminders with `remind_at` datetime and `sent` flag.

### `signups`
Registration records with activation codes, expiry, and status.

### `config`
Key-value store for runtime configuration (API keys, settings).

### `usage_log`
Per-request token usage tracking for cost analysis.

### `admin_users`
Admin console credentials (bcrypt hashed).

---

## AI Action System

The AI can execute structured actions by including JSON blocks in its responses:

```json
{"type": "save_memory", "content": "User's birthday is March 15", "category": "personal"}
{"type": "save_reminder", "content": "Call dentist", "remind_at": "2026-03-05 14:00"}
{"type": "update_profile", "content": "Works at a law firm in Port of Spain"}
{"type": "daily_note", "content": "Discussed project timeline"}
{"type": "update_soul", "content": "User prefers casual tone, calls them 'bro'"}
{"type": "set_briefing_time", "time": "08:00"}
{"type": "send_to_contact", "phone": "18681234567", "message": "Grocery list: milk, eggs, bread"}
```

Actions are parsed from the AI response, executed server-side, then stripped before sending the reply to the user.

---

## Security Notes

- All admin routes require JWT authentication
- User dashboard uses phone-based OTP (sent via WhatsApp)
- API keys in the database are masked in API responses
- Each tenant's workspace is isolated on the filesystem
- WhatsApp webhook should verify `X-Hub-Signature-256` in production
- Use HTTPS in production (certbot/nginx)
- Set strong `ADMIN_JWT_SECRET` and `ADMIN_PASS`

---

## License

Proprietary. © Wayne / WiPay Caribbean.
