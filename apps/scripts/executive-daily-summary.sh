#!/bin/bash
# Executive Daily Summary Generator
# Compiles key metrics and activities for Wayne

WORKSPACE_DIR="/data/.openclaw/workspace"
SUMMARY_DATE=$(date '+%Y-%m-%d')
SUMMARY_FILE="$WORKSPACE_DIR/docs/summaries/executive-summary-$SUMMARY_DATE.md"

mkdir -p "$WORKSPACE_DIR/docs/summaries"

cat > "$SUMMARY_FILE" << EOF
# Executive Summary - $SUMMARY_DATE

## Key Activities
$(tail -50 "$WORKSPACE_DIR/memory/$SUMMARY_DATE.md" 2>/dev/null | grep -E "^\*\*[0-9]{2}:[0-9]{2}" | tail -5 || echo "- No activities logged today")

## System Status
- OpenClaw Version: $(openclaw --version 2>/dev/null || echo "Unknown")
- Active Channels: $(grep -E "enabled.*true" /data/.openclaw/openclaw.json | wc -l)
- Memory Usage: $(df -h /data | tail -1 | awk '{print $3 "/" $2 " (" $5 ")"}')

## Pending Tasks
$(grep -E "TODO|PENDING|Awaiting" "$WORKSPACE_DIR/STATUS.md" 2>/dev/null || echo "- All systems operational")

## Recent Communications
- Telegram Messages: $(grep -c "telegram:" "$WORKSPACE_DIR/memory/$SUMMARY_DATE.md" 2>/dev/null || echo "0")
- Voice Calls: $(grep -c "voice call\|Call initiated" "$WORKSPACE_DIR/memory/$SUMMARY_DATE.md" 2>/dev/null || echo "0")

## Next Actions
$(grep -E "Next Steps|TODO" "$WORKSPACE_DIR/memory/$SUMMARY_DATE.md" | head -3 || echo "- Continue monitoring")

---
Generated: $(date '+%Y-%m-%d %H:%M:%S %Z')
EOF

echo "Executive summary generated: $SUMMARY_FILE"
