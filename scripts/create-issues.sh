#!/usr/bin/env bash
# Create the 7 "good first issue" tickets on GitHub.
#
# Prerequisites:
#   - gh CLI installed and authenticated (gh auth login)
#   - Repo already pushed to GitHub (gh repo view should work in this dir)
#
# Usage:
#   bash scripts/create-issues.sh

set -euo pipefail

cd "$(dirname "$0")/.."

ISSUES_DIR="scripts/issues"

if ! command -v gh >/dev/null 2>&1; then
  echo "❌ gh CLI not found. Install: https://cli.github.com/"
  exit 1
fi

if ! gh repo view >/dev/null 2>&1; then
  echo "❌ Not inside a GitHub-linked repo. Push first:"
  echo "   git remote add origin git@github.com:gavrilux/agent-mouth.git"
  echo "   git push -u origin main --tags"
  exit 1
fi

create_issue() {
  local file="$1"
  local title="$2"
  shift 2
  local labels="$*"
  echo "→ Creating issue: $title"
  gh issue create \
    --title "$title" \
    --body-file "$ISSUES_DIR/$file" \
    --label "$labels"
}

# Ensure custom labels exist (gh creates them on-the-fly if --label is used)
# Standard labels (bug, enhancement, good first issue, help wanted, documentation)
# come pre-installed with every new GitHub repo.

create_issue "01-since-message-id.md" \
  "read_inbox: since_message_id parameter is silently ignored" \
  "bug,good first issue"

create_issue "02-display-name.md" \
  "whoami ignores configured display_name (returns Telegram first_name instead)" \
  "bug,good first issue"

create_issue "03-error-codes.md" \
  "Map Telegram errors to spec-defined error codes (AUTH_ERROR, RATE_LIMITED, etc.)" \
  "enhancement,help wanted"

create_issue "04-cache-bot-username.md" \
  "Cache bot username at init — fetchUpdates does wasted HTTP call every poll" \
  "enhancement,good first issue"

create_issue "05-get-thread-recursion.md" \
  "get_thread doesn't recursively walk reply chain (rename or implement)" \
  "bug,enhancement"

create_issue "06-dead-code.md" \
  "Remove unused TelegramTransport.handle field and decide msw fate" \
  "good first issue"

create_issue "07-gitignore-cleanup.md" \
  ".gitignore has non-functional ~/.agent-mouth/ entry" \
  "good first issue,documentation"

echo
echo "✅ All 7 issues created. View them:"
echo "   gh issue list"
