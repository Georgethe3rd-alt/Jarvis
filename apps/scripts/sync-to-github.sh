#!/bin/bash
# Sync workspace to GitHub

cd /data/.openclaw/workspace

# Add all changes
git add -A

# Commit with timestamp
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S %Z')
git commit -m "Workspace sync: $TIMESTAMP" || echo "No changes to commit"

# Push to GitHub
# Note: Requires GitHub PAT to be set in environment or git credential helper
git push origin main
