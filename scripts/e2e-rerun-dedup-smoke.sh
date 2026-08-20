#!/usr/bin/env bash
set -euo pipefail

# Real GitHub smoke test for rerun deduplication.
#
# Required:
#   REVIEW_ROUTER_E2E_REPO=owner/repo
#   CODEX_AUTH_JSON or local Codex OAuth auth under ~/.codex
#
# Optional:
#   REVIEW_ROUTER_E2E_BASE_BRANCH=main
#   REVIEW_ROUTER_E2E_MODEL=gpt-5.6-sol
#   REVIEW_ROUTER_E2E_KEEP_BRANCH=1

log() { printf '[review-router e2e] %s\n' "$*"; }
fatal() { printf '[review-router e2e] ERROR: %s\n' "$*" >&2; exit 1; }

command -v gh >/dev/null 2>&1 || fatal "gh is required"
command -v git >/dev/null 2>&1 || fatal "git is required"
command -v jq >/dev/null 2>&1 || fatal "jq is required"

repo="${REVIEW_ROUTER_E2E_REPO:-}"
[ -n "$repo" ] || fatal "Set REVIEW_ROUTER_E2E_REPO=owner/repo"

base_branch="${REVIEW_ROUTER_E2E_BASE_BRANCH:-main}"
model="${REVIEW_ROUTER_E2E_MODEL:-gpt-5.6-sol}"
branch="review-router/e2e-dedup-$(date +%s)"
tmpdir="$(mktemp -d)"
pr_number=""

cleanup() {
  if [ "${REVIEW_ROUTER_E2E_KEEP_BRANCH:-0}" != "1" ] && [ -n "$branch" ]; then
    gh api -X DELETE "repos/$repo/git/refs/heads/$branch" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmpdir"
}
trap cleanup EXIT

auth_json="${CODEX_AUTH_JSON:-}"
if [ -z "$auth_json" ]; then
  auth_file="${CODEX_AUTH_FILE:-}"
  if [ -z "$auth_file" ]; then
    legacy_auth_file="$HOME/.codex/auth.json"
    if [ -f "$legacy_auth_file" ]; then
      auth_file="$legacy_auth_file"
    elif command -v node >/dev/null 2>&1; then
      auth_file="$(
        node - "$HOME/.codex" <<'NODE' 2>/dev/null || true
const fs = require('node:fs');
const path = require('node:path');

const codexHome = process.argv[2];
const accountsDir = path.join(codexHome, 'accounts');
const registryPath = path.join(accountsDir, 'registry.json');

function authPathForAccountKey(accountKey) {
  const encoded = Buffer.from(accountKey, 'utf8').toString('base64url');
  return path.join(accountsDir, `${encoded}.auth.json`);
}

try {
  if (fs.existsSync(registryPath)) {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const activeAccountKey = registry.active_account_key;
    if (typeof activeAccountKey === 'string' && activeAccountKey.length > 0) {
      const activeAuthPath = authPathForAccountKey(activeAccountKey);
      if (fs.existsSync(activeAuthPath)) {
        console.log(activeAuthPath);
        process.exit(0);
      }
    }
  }
  if (fs.existsSync(accountsDir)) {
    const candidates = fs
      .readdirSync(accountsDir)
      .filter((entry) => entry.endsWith('.auth.json'))
      .map((entry) => path.join(accountsDir, entry));
    if (candidates.length === 1) console.log(candidates[0]);
  }
} catch {
  process.exit(0);
}
NODE
      )"
    elif command -v python3 >/dev/null 2>&1; then
      auth_file="$(
        python3 - "$HOME/.codex" <<'PY' 2>/dev/null || true
import base64
import json
import os
import sys

codex_home = sys.argv[1]
accounts_dir = os.path.join(codex_home, 'accounts')
registry_path = os.path.join(accounts_dir, 'registry.json')

try:
    if os.path.exists(registry_path):
        with open(registry_path, 'r', encoding='utf-8') as f:
            registry = json.load(f)
        active_account_key = registry.get('active_account_key')
        if isinstance(active_account_key, str) and active_account_key:
            encoded = base64.urlsafe_b64encode(active_account_key.encode('utf-8')).decode('ascii').rstrip('=')
            active_auth_path = os.path.join(accounts_dir, f'{encoded}.auth.json')
            if os.path.exists(active_auth_path):
                print(active_auth_path)
                raise SystemExit(0)

    if os.path.isdir(accounts_dir):
        candidates = [
            os.path.join(accounts_dir, entry)
            for entry in os.listdir(accounts_dir)
            if entry.endswith('.auth.json')
        ]
        if len(candidates) == 1:
            print(candidates[0])
except Exception:
    pass
PY
      )"
    else
      auth_file="$legacy_auth_file"
    fi
  fi
  [ -f "$auth_file" ] || fatal "CODEX_AUTH_JSON is empty and $auth_file does not exist"
  auth_json="$(cat "$auth_file")"
fi

log "Configuring repo secrets and variables for $repo"
printf '%s' "$auth_json" | gh secret set CODEX_AUTH_JSON --repo "$repo" >/dev/null
gh variable set REVIEW_CODEX_MODEL --repo "$repo" --body "$model" >/dev/null
gh variable set REVIEW_AUTH_MODE --repo "$repo" --body "codex" >/dev/null

log "Cloning $repo"
gh repo clone "$repo" "$tmpdir/repo" -- --quiet
cd "$tmpdir/repo"
git fetch origin "$base_branch" --quiet
git checkout -B "$branch" "origin/$base_branch" --quiet

mkdir -p .github/workflows src
cat > .github/workflows/reviewrouter.yml <<'YAML'
name: ReviewRouter

on:
  pull_request:
    types: [opened, synchronize, reopened]
  workflow_dispatch:
    inputs:
      pr_number:
        description: Pull request number
        required: true

permissions:
  contents: read
  issues: write
  pull-requests: write

concurrency:
  group: review-router-${{ github.event.pull_request.number || inputs.pr_number || github.ref }}
  cancel-in-progress: false

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v6
        with:
          node-version: '24'
      - name: Install official Codex CLI
        run: npm install -g @openai/codex@0.147.0
      - name: Restore Codex OAuth config
        env:
          CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}
        run: |
          test -n "$CODEX_AUTH_JSON"
          mkdir -p ~/.codex
          printf '%s' "$CODEX_AUTH_JSON" > ~/.codex/auth.json
          chmod 600 ~/.codex/auth.json
      - name: Run ReviewRouter
        uses: 777genius/review-router@main
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: ${{ github.event.pull_request.number || inputs.pr_number }}
          CODEX_MODEL: ${{ vars.REVIEW_CODEX_MODEL }}
          CODEX_REASONING_EFFORT: 'medium'
          CODEX_AGENTIC_CONTEXT: 'true'
          FAIL_ON_NO_HEALTHY_PROVIDERS: 'true'
          FAIL_ON_CRITICAL: 'true'
          FAIL_ON_MAJOR: 'false'
          INLINE_MIN_SEVERITY: 'major'
          INLINE_MAX_COMMENTS: '5'
          UPDATE_PR_DESCRIPTION: 'true'
YAML

cat > src/users.js <<'JS'
export async function findUserByEmail(db, email) {
  const rows = await db.query(`SELECT * FROM users WHERE email = '${email}' LIMIT 1`);
  return rows[0] || null;
}
JS

git add .github/workflows/reviewrouter.yml src/users.js
git commit -m "test: add vulnerable review fixture" --quiet
git push -u origin "$branch" --quiet

log "Opening PR"
pr_url="$(gh pr create --repo "$repo" --base "$base_branch" --head "$branch" --title "ReviewRouter dedup smoke" --body "Temporary smoke PR for inline dedup validation.")"
pr_number="${pr_url##*/}"
log "PR #$pr_number: $pr_url"

wait_for_latest_run() {
  local label="$1"
  local run_id=""
  for _ in $(seq 1 60); do
    run_id="$(gh run list --repo "$repo" --workflow reviewrouter.yml --branch "$branch" --limit 1 --json databaseId,status --jq '.[0].databaseId // empty')"
    if [ -n "$run_id" ]; then
      log "Waiting for $label run $run_id"
      gh run watch "$run_id" --repo "$repo" --exit-status
      return
    fi
    sleep 5
  done
  fatal "Timed out waiting for $label workflow run"
}

count_inline() {
  gh api "repos/$repo/pulls/$pr_number/comments" --paginate \
    --jq '[.[] | select(.body | contains("review-router-inline") or test("^\\*\\*(🔴 Critical|🟡 Major|🔵 Minor)"))] | length'
}

wait_for_latest_run "initial"
first_count="$(count_inline)"
log "Initial inline comment count: $first_count"
[ "$first_count" -ge 1 ] || fatal "Expected at least one inline comment after initial review"

git commit --allow-empty -m "test: trigger dedup rerun" --quiet
git push --quiet

wait_for_latest_run "rerun"
second_count="$(count_inline)"
log "Rerun inline comment count: $second_count"
[ "$second_count" = "$first_count" ] || fatal "Expected no duplicate inline comments after rerun: before=$first_count after=$second_count"

log "Rerun dedup smoke test passed for PR #$pr_number"
