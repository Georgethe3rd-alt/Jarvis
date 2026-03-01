# Multi-Agent Delegation Examples

## How to Use Kevin (Operations)

### Daily Backup Task
```
Kevin, run the GitHub backup script at /data/.openclaw/workspace/apps/scripts/sync-to-github.sh and report the result.
```

### System Check
```
Kevin, check:
1. Current disk usage with df -h
2. Memory usage
3. Any errors in the last 50 lines of logs
Report back with a summary.
```

### Email Monitoring
```
Kevin, check george-openclaw@agentmail.to for new messages using the AgentMail API. Summarize any important emails.
```

## How to Use Dev (Engineering)

### Create New Integration
```
Dev, create a JavaScript module for interfacing with the GitHub API. It should:
- Support creating issues
- List repositories
- Create gists
Use placeholder [GITHUB_TOKEN] for auth.
```

### Debug Existing Code
```
Dev, review the Twilio integration at /apps/integrations/twilio-voice.js and suggest improvements for error handling.
```

### Build OpenClaw Skill
```
Dev, create a new skill for automated invoice generation. Include:
- PDF generation capability
- Template system
- WiPay payment link integration
Place it in /apps/skills/invoice-generator/
```

## George's Review Process

After Kevin completes:
- Verify execution success
- Check for any anomalies
- Approve or correct actions

After Dev completes:
- Review code quality
- Check security implications
- Test functionality
- Deploy if approved

## Cost Optimization Strategy

### Use Kevin for:
- Scheduled tasks (saves 90% on routine operations)
- Monitoring (continuous but simple)
- Basic file operations
- Status reporting

### Use Dev for:
- Initial code drafts (saves 70% on development)
- Boilerplate generation
- Documentation writing
- Code refactoring

### Use George for:
- Executive decisions
- Security-sensitive operations
- Customer interactions
- Final code review and deployment
- Complex problem solving

## Example Workflow

1. **George**: "I need a new WhatsApp integration"
2. **George → Dev**: "Dev, create a WhatsApp Business API client module with message sending and webhook handling"
3. **Dev**: Creates code and submits
4. **George**: Reviews, tests, refines
5. **George → Kevin**: "Kevin, add the new WhatsApp integration to our daily health check"
6. **Kevin**: Updates monitoring routine
7. **George**: Deploys to production
