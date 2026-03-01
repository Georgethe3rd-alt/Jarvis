# Jarvis — George the 3rd

> *Like Jarvis from Iron Man — anticipates needs, takes initiative, and runs tasks without needing to be prompted through every step.*

George the 3rd is the third instance of an [OpenClaw](https://openclaw.ai) AI assistant workspace. Proactive, resourceful, dry wit. A sophisticated ghost in the machine with a touch of British butler energy.

## What This Is

An AI agent workspace configuration — the memory, soul, identity, and operational setup that makes George tick. Fork it, adapt it, run your own instance.

## Structure

```
jarvis/
├── AGENTS.md        — Workspace behaviour: memory, heartbeats, safety
├── SOUL.md          — Core personality and operating principles
├── IDENTITY.md      — Who George is
├── BOOT.md          — Startup instructions
├── HEARTBEAT.md     — Periodic task configuration
└── apps/
    ├── agents/      — Sub-agent definitions (Dev, Kevin)
    ├── integrations/— API integrations (AgentMail, Twilio, ElevenLabs)
    ├── scripts/     — Automation scripts
    └── skills/      — OpenClaw skills
```

## Setup

1. Clone into an OpenClaw workspace
2. Populate `TOOLS.md` with your API credentials (see `TOOLS.md.example`)
3. Configure communication channels (Telegram, AgentMail, Twilio)
4. Start a session — George reads `SOUL.md`, `IDENTITY.md`, and recent memory on every boot

## Agent Architecture

George delegates to two sub-agents:

- **Kevin** — Operations: backups, monitoring, routine tasks (cost-optimised)
- **Dev** — Engineering: code drafts, integrations, scripts (George reviews before deploy)

George handles executive decisions, security-sensitive operations, and complex problem solving.

## Communication Channels

Supports Telegram, SMS (Twilio), Email (AgentMail), and Voice (Twilio + ElevenLabs).

---

*George the 3rd — Born February 19, 2026.*
