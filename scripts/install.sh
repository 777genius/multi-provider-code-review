#!/usr/bin/env bash
# review-router installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/777genius/review-router/main/scripts/install.sh | bash

set -Eeuo pipefail

PRODUCT_NAME="review-router"
LATEST_RELEASE_TAG="v1.0.115"
LATEST_MAJOR_TAG="v1"
DEFAULT_ACTION_REF_MODE="main"
DEFAULT_STABLE_ACTION_REF="777genius/review-router@$LATEST_MAJOR_TAG"
DEFAULT_RELEASE_ACTION_REF="777genius/review-router@$LATEST_RELEASE_TAG"
DEFAULT_MAIN_ACTION_REF="777genius/review-router@main"
DEFAULT_WORKFLOW_STYLE="reusable"
DEFAULT_BRANCH_NAME="review-router/setup"
WORKFLOW_PATH=".github/workflows/reviewrouter.yml"
INTERACTION_WORKFLOW_PATH=".github/workflows/reviewrouter-interaction.yml"
CODEX_NPM_PACKAGE="@openai/codex@0.145.0"
DEFAULT_CODEX_MODEL="gpt-5.5"
DEFAULT_CLAUDE_MODEL="sonnet"
DEFAULT_APP_LOGO_URL="https://i.imgur.com/Yz9XIQM.png"
OPENROUTER_DEFAULT_PROVIDERS="openrouter/openai/gpt-oss-120b:free,openrouter/poolside/laguna-m.1:free"
OPENROUTER_DEFAULT_SYNTHESIS="openrouter/free"

env_first() {
  local key value
  for key in "$@"; do
    value="${!key-}"
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return 0
    fi
  done
  return 1
}

ACTION_REF_EXPLICIT="$(env_first REVIEW_ROUTER_ACTION_REF AI_ROBOT_REVIEW_ACTION_REF || true)"
ACTION_REF_MODE="$(env_first REVIEW_ROUTER_ACTION_REF_MODE AI_ROBOT_REVIEW_ACTION_REF_MODE || true)"
ACTION_REF=""
WORKFLOW_STYLE="$(env_first REVIEW_ROUTER_WORKFLOW_STYLE AI_ROBOT_REVIEW_WORKFLOW_STYLE || printf '%s' "$DEFAULT_WORKFLOW_STYLE")"
INSTALL_BRANCH="$(env_first REVIEW_ROUTER_BRANCH AI_ROBOT_REVIEW_BRANCH || printf '%s' "$DEFAULT_BRANCH_NAME")"
TARGET_REPO="$(env_first REVIEW_ROUTER_REPO AI_ROBOT_REVIEW_REPO || true)"
SECRET_SCOPE="$(env_first REVIEW_ROUTER_SECRET_SCOPE AI_ROBOT_REVIEW_SECRET_SCOPE || true)"
ORG_NAME="$(env_first REVIEW_ROUTER_ORG AI_ROBOT_REVIEW_ORG || true)"
ORG_SELECTED_REPOS="$(env_first REVIEW_ROUTER_ORG_SECRET_REPOS AI_ROBOT_REVIEW_ORG_SECRET_REPOS || true)"
IDENTITY_MODE="$(env_first REVIEW_ROUTER_IDENTITY AI_ROBOT_REVIEW_IDENTITY || true)"
APP_SETUP="$(env_first REVIEW_ROUTER_APP_SETUP AI_ROBOT_REVIEW_APP_SETUP || true)"
APP_PROFILE="$(env_first REVIEW_ROUTER_APP_PROFILE AI_ROBOT_REVIEW_APP_PROFILE || true)"
APP_PROFILE_DIR="$(env_first REVIEW_ROUTER_APP_PROFILE_DIR AI_ROBOT_REVIEW_APP_PROFILE_DIR || true)"
APP_LOGO_URL="$(env_first REVIEW_ROUTER_APP_LOGO_URL AI_ROBOT_REVIEW_APP_LOGO_URL || printf '%s' "$DEFAULT_APP_LOGO_URL")"
AUTH_MODE="$(env_first REVIEW_ROUTER_AUTH AI_ROBOT_REVIEW_AUTH || true)"
DISCUSSION_MODE="$(env_first REVIEW_ROUTER_DISCUSSION_MODE AI_ROBOT_REVIEW_DISCUSSION_MODE || true)"
PRESET="$(env_first REVIEW_ROUTER_PRESET AI_ROBOT_REVIEW_PRESET || true)"
CODEX_MODEL="$(env_first REVIEW_ROUTER_CODEX_MODEL AI_ROBOT_REVIEW_CODEX_MODEL || printf '%s' "$DEFAULT_CODEX_MODEL")"
CLAUDE_MODEL="$(env_first REVIEW_ROUTER_CLAUDE_MODEL AI_ROBOT_REVIEW_CLAUDE_MODEL || printf '%s' "$DEFAULT_CLAUDE_MODEL")"
CODEX_EFFORT_OVERRIDE="$(env_first REVIEW_ROUTER_CODEX_EFFORT AI_ROBOT_REVIEW_CODEX_EFFORT || true)"
RUNS_ON="$(env_first REVIEW_ROUTER_RUNS_ON AI_ROBOT_REVIEW_RUNS_ON || printf 'ubuntu-latest')"
CODEX_AUTH_PERSISTENCE="$(env_first REVIEW_ROUTER_CODEX_AUTH_PERSISTENCE AI_ROBOT_REVIEW_CODEX_AUTH_PERSISTENCE || printf 'secret')"
DRY_RUN="$(env_first REVIEW_ROUTER_DRY_RUN AI_ROBOT_REVIEW_DRY_RUN || printf '0')"
NON_INTERACTIVE="$(env_first REVIEW_ROUTER_NON_INTERACTIVE AI_ROBOT_REVIEW_NON_INTERACTIVE || printf '0')"
LOCAL_ONLY="$(env_first REVIEW_ROUTER_LOCAL_ONLY AI_ROBOT_REVIEW_LOCAL_ONLY || printf '0')"
SKIP_GH_CHECK="$(env_first REVIEW_ROUTER_SKIP_GH_CHECK AI_ROBOT_REVIEW_SKIP_GH_CHECK || printf '0')"
SKIP_APP_CREATE="$(env_first REVIEW_ROUTER_SKIP_APP_CREATE AI_ROBOT_REVIEW_SKIP_APP_CREATE || printf '0')"
SKIP_APP_DOCTOR="$(env_first REVIEW_ROUTER_SKIP_APP_DOCTOR AI_ROBOT_REVIEW_SKIP_APP_DOCTOR || printf '0')"
YES="$(env_first REVIEW_ROUTER_YES AI_ROBOT_REVIEW_YES || printf '0')"
NO_BROWSER="$(env_first REVIEW_ROUTER_NO_BROWSER AI_ROBOT_REVIEW_NO_BROWSER || printf '0')"
WORKDIR_OVERRIDE="$(env_first REVIEW_ROUTER_WORKDIR AI_ROBOT_REVIEW_WORKDIR || true)"
WORKDIR_IS_GIT_WORKTREE=0
WORKDIR_SOURCE_REPO=""

case "$APP_LOGO_URL" in
  http://*|https://*) ;;
  *) APP_LOGO_URL="https://$APP_LOGO_URL" ;;
esac

if [ -t 1 ]; then
  BOLD='\033[1m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  RED='\033[0;31m'
  BLUE='\033[0;34m'
  NC='\033[0m'
else
  BOLD=''
  GREEN=''
  YELLOW=''
  RED=''
  BLUE=''
  NC=''
fi

log() { printf '%b\n' "$*"; }
info() { log "${BLUE}==>${NC} $*"; }
ok() { log "${GREEN}OK${NC} $*"; }
warn() { log "${YELLOW}WARN${NC} $*"; }
fatal() { log "${RED}ERROR${NC} $*" >&2; exit 1; }

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|y|Y) return 0 ;;
    *) return 1 ;;
  esac
}

json_escape() {
  printf '%s' "$1" | sed \
    -e 's/\\/\\\\/g' \
    -e 's/"/\\"/g'
}

json_pair() {
  key="$1"
  value="$2"
  printf '"%s":"%s"' "$key" "$(json_escape "$value")"
}

append_json_pair() {
  json_object="$1"
  key="$2"
  value="$3"
  if [ "$json_object" = "{" ]; then
    printf '%s%s' "$json_object" "$(json_pair "$key" "$value")"
  else
    printf '%s,%s' "$json_object" "$(json_pair "$key" "$value")"
  fi
}

append_pretty_json_pair() {
  json_object="$1"
  key="$2"
  value="$3"
  pair="  \"${key}\": \"$(json_escape "$value")\""
  if [ "$json_object" = "{" ]; then
    printf '%s\n%s' "$json_object" "$pair"
  else
    printf '%s,\n%s' "$json_object" "$pair"
  fi
}

validate_discussion_mode() {
  case "${1:-}" in
    off|suggest) return 0 ;;
    *) fatal "Unsupported REVIEW_ROUTER_DISCUSSION_MODE: ${1:-}. Use off or suggest." ;;
  esac
}

validate_codex_auth_persistence() {
  case "${1:-}" in
    secret|persistent) return 0 ;;
    *) fatal "Unsupported REVIEW_ROUTER_CODEX_AUTH_PERSISTENCE: ${1:-}. Use secret or persistent." ;;
  esac
}

read_interactive() {
  local __var_name="$1"
  if [ -r /dev/tty ]; then
    IFS= read -r "${__var_name?}" < /dev/tty
    return $?
  fi
  if [ -t 0 ]; then
    IFS= read -r "${__var_name?}"
    return $?
  fi
  return 1
}

ensure_interactive_input() {
  if [ -r /dev/tty ] || [ -t 0 ]; then
    return 0
  fi
  fatal "Interactive input is unavailable. Re-run from a terminal or set REVIEW_ROUTER_NON_INTERACTIVE=1 with the required REVIEW_ROUTER_* environment variables."
}

stty_interactive() {
  if [ -r /dev/tty ]; then
    stty "$@" < /dev/tty
  else
    stty "$@"
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fatal "Missing required command: $1"
}

run() {
  if is_true "$DRY_RUN"; then
    log "[dry-run] $*"
  else
    "$@"
  fi
}

validate_repo() {
  case "$1" in
    */*) ;;
    *) fatal "Repository must be in owner/repo form. Got: $1" ;;
  esac
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || fatal "Invalid repository name: $1"
}

repo_owner() { printf '%s' "$1" | cut -d/ -f1; }
repo_name() { printf '%s' "$1" | cut -d/ -f2-; }

normalize_secret_scope_env() {
  case "$SECRET_SCOPE" in
    organization|org-level|org_selected|org-selected) SECRET_SCOPE="org" ;;
    repository|repo-level|repo_selected|repo-selected) SECRET_SCOPE="repo" ;;
  esac
}

normalize_selected_repos() {
  raw_repos="$1"
  normalized=""
  old_ifs="$IFS"
  IFS=','
  for item in $raw_repos; do
    repo="$(printf '%s' "$item" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -n "$repo" ] || continue
    case "$repo" in
      */*)
        repo_owner_part="${repo%%/*}"
        repo_name_part="${repo#*/}"
        if [ "$repo_owner_part" != "$ORG_NAME" ]; then
          IFS="$old_ifs"
          fatal "Org selected repo $repo must belong to org $ORG_NAME"
        fi
        repo="$repo_name_part"
        ;;
    esac
    printf '%s' "$repo" | grep -Eq '^[A-Za-z0-9_.-]+$' || {
      IFS="$old_ifs"
      fatal "Invalid selected repository name for org secret: $repo"
    }
    if [ -n "$normalized" ]; then
      normalized="$normalized,$repo"
    else
      normalized="$repo"
    fi
  done
  IFS="$old_ifs"
  [ -n "$normalized" ] || fatal "At least one selected repository is required for org-level secrets"
  printf '%s' "$normalized"
}

normalize_remote_repo() {
  remote="$1"
  remote="${remote#git@github.com:}"
  remote="${remote#https://github.com/}"
  remote="${remote#http://github.com/}"
  remote="${remote%.git}"
  case "$remote" in
    */*) printf '%s' "$remote" ;;
    *) return 1 ;;
  esac
}

detect_repo() {
  if [ -n "$TARGET_REPO" ]; then
    validate_repo "$TARGET_REPO"
    return
  fi

  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    remote_url="$(git config --get remote.origin.url || true)"
    if [ -n "$remote_url" ] && detected="$(normalize_remote_repo "$remote_url")"; then
      TARGET_REPO="$detected"
      validate_repo "$TARGET_REPO"
      return
    fi
  fi

  if command -v gh >/dev/null 2>&1 && ! is_true "$SKIP_GH_CHECK"; then
    detected="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
    if [ -n "$detected" ]; then
      TARGET_REPO="$detected"
      validate_repo "$TARGET_REPO"
      return
    fi
  fi

  prompt_text "TARGET_REPO" "Target GitHub repository (owner/repo)" ""
  validate_repo "$TARGET_REPO"
}

prompt_text() {
  var_name="$1"
  label="$2"
  default_value="$3"
  current_value="$(eval "printf '%s' \"\${$var_name:-}\"")"

  if [ -n "$current_value" ]; then
    return
  fi
  if is_true "$NON_INTERACTIVE"; then
    if [ -n "$default_value" ]; then
      eval "$var_name=\"$default_value\""
      return
    fi
    fatal "$var_name is required in non-interactive mode"
  fi

  ensure_interactive_input
  if [ -n "$default_value" ]; then
    printf '%s [%s]: ' "$label" "$default_value" >&2
  else
    printf '%s: ' "$label" >&2
  fi
  read_interactive answer || fatal "Could not read interactive input for: $label"
  if [ -z "$answer" ]; then
    answer="$default_value"
  fi
  [ -n "$answer" ] || fatal "$label is required"
  eval "$var_name=\"$answer\""
}

prompt_secret() {
  var_name="$1"
  label="$2"
  current_value="$(eval "printf '%s' \"\${$var_name:-}\"")"

  if [ -n "$current_value" ]; then
    return
  fi
  if is_true "$NON_INTERACTIVE"; then
    fatal "$var_name is required in non-interactive mode"
  fi

  ensure_interactive_input
  printf '%s: ' "$label" >&2
  stty_state="$(stty_interactive -g 2>/dev/null || true)"
  stty_interactive -echo 2>/dev/null || true
  read_interactive answer || {
    [ -z "$stty_state" ] || stty_interactive "$stty_state" 2>/dev/null || true
    fatal "Could not read interactive input for: $label"
  }
  [ -z "$stty_state" ] || stty_interactive "$stty_state" 2>/dev/null || true
  printf '\n' >&2
  [ -n "$answer" ] || fatal "$label is required"
  eval "$var_name=\"$answer\""
}

choose() {
  var_name="$1"
  prompt="$2"
  default_value="$3"
  shift 3
  current_value="$(eval "printf '%s' \"\${$var_name:-}\"")"

  if [ -n "$current_value" ]; then
    validate_choice "$var_name" "$current_value" "$@"
    return
  fi
  if is_true "$NON_INTERACTIVE"; then
    eval "$var_name=\"$default_value\""
    return
  fi

  ensure_interactive_input
  log ""
  log "${BOLD}$prompt${NC}"
  i=1
  for option in "$@"; do
    label="${option%%:*}"
    description="${option#*:}"
    log "  $i) $label - $description"
    i=$((i + 1))
  done
  printf 'Choose [%s]: ' "$default_value" >&2
  read_interactive answer || fatal "Could not read interactive input for: $prompt"
  if [ -z "$answer" ]; then
    answer="$default_value"
  fi

  if printf '%s' "$answer" | grep -Eq '^[0-9]+$'; then
    idx=1
    for option in "$@"; do
      if [ "$idx" = "$answer" ]; then
        answer="${option%%:*}"
        break
      fi
      idx=$((idx + 1))
    done
  fi

  validate_choice "$var_name" "$answer" "$@"
  eval "$var_name=\"$answer\""
}

validate_choice() {
  var_name="$1"
  value="$2"
  shift 2
  for option in "$@"; do
    if [ "${option%%:*}" = "$value" ]; then
      return
    fi
  done
  fatal "Invalid $var_name: $value"
}

resolve_action_ref() {
  if [ -n "$ACTION_REF_EXPLICIT" ]; then
    ACTION_REF="$ACTION_REF_EXPLICIT"
    ACTION_REF_MODE="custom"
    return
  fi

  case "$ACTION_REF_MODE" in
    stable|major|v1)
      ACTION_REF_MODE="stable"
      ACTION_REF="$DEFAULT_STABLE_ACTION_REF"
      ;;
    release|pinned|tag|exact)
      ACTION_REF_MODE="release"
      ACTION_REF="$DEFAULT_RELEASE_ACTION_REF"
      ;;
    main|live|dev|latest)
      ACTION_REF_MODE="main"
      ACTION_REF="$DEFAULT_MAIN_ACTION_REF"
      ;;
    *)
      fatal "Unsupported REVIEW_ROUTER_ACTION_REF_MODE: $ACTION_REF_MODE. Use main, stable, release, or REVIEW_ROUTER_ACTION_REF=owner/repo@ref."
      ;;
  esac
}

validate_action_ref_for_workflow_style() {
  if [ "$WORKFLOW_STYLE" != "reusable" ]; then
    return 0
  fi

  local ref
  ref="${ACTION_REF##*@}"
  if printf '%s' "$ref" | grep -Eq '^(main|v1|v1\.[0-9]+\.[0-9]+|[a-fA-F0-9]{40})$'; then
    return 0
  fi

  fatal "Compact reusable workflow requires @main, @v1, @v1.x.x, or a reusable-capable 40-character commit SHA. Use REVIEW_ROUTER_WORKFLOW_STYLE=explicit for custom forks or legacy refs."
}

confirm() {
  message="$1"
  if is_true "$YES"; then
    return 0
  fi
  if is_true "$NON_INTERACTIVE"; then
    return 1
  fi
  ensure_interactive_input
  printf '%s [y/N]: ' "$message" >&2
  read_interactive answer || fatal "Could not read interactive input for confirmation"
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

check_prerequisites() {
  require_cmd git
  require_cmd curl
  if ! is_true "$SKIP_GH_CHECK"; then
    require_cmd gh
    gh auth status >/dev/null 2>&1 || fatal "gh is not authenticated. Run: gh auth login"
  elif ! is_true "$DRY_RUN" && ! is_true "$LOCAL_ONLY"; then
    fatal "REVIEW_ROUTER_SKIP_GH_CHECK is only allowed with dry-run/local-only setup"
  fi
}

setup_secret_scope() {
  normalize_secret_scope_env
  validate_choice "SECRET_SCOPE" "$SECRET_SCOPE" \
    "repo:Repository-level secrets and variables" \
    "org:Organization-level secrets and variables, restricted to selected repositories"

  if [ "$SECRET_SCOPE" = "org" ]; then
    if [ -z "$ORG_NAME" ]; then
      ORG_NAME="$(repo_owner "$TARGET_REPO")"
    fi
    ORG_SELECTED_REPOS="$(normalize_selected_repos "${ORG_SELECTED_REPOS:-$(repo_name "$TARGET_REPO")}")"

    if ! is_true "$DRY_RUN" && ! is_true "$LOCAL_ONLY" && ! is_true "$SKIP_GH_CHECK"; then
      owner_type="$(gh api "users/$ORG_NAME" --jq .type 2>/dev/null || true)"
      [ "$owner_type" = "Organization" ] || fatal "REVIEW_ROUTER_SECRET_SCOPE=org requires an organization owner. $ORG_NAME is $owner_type. Use repo scope for personal repositories."
      if ! gh auth status 2>&1 | grep -q 'admin:org'; then
        warn "Org-level secrets usually require gh admin:org scope. If setting secrets fails, run: gh auth refresh -s admin:org"
      fi
    fi
  fi
}

secret_exists() {
  if is_true "$DRY_RUN" || is_true "$SKIP_GH_CHECK"; then
    return 1
  fi
  if [ "$SECRET_SCOPE" = "org" ]; then
    gh secret list --org "$ORG_NAME" --app actions 2>/dev/null | awk '{print $1}' | grep -Fxq "$1"
  else
    gh secret list --repo "$TARGET_REPO" 2>/dev/null | awk '{print $1}' | grep -Fxq "$1"
  fi
}

variable_exists() {
  if is_true "$DRY_RUN" || is_true "$SKIP_GH_CHECK"; then
    return 1
  fi
  if [ "$SECRET_SCOPE" = "org" ]; then
    gh variable list --org "$ORG_NAME" 2>/dev/null | awk '{print $1}' | grep -Fxq "$1"
  else
    gh variable list --repo "$TARGET_REPO" 2>/dev/null | awk '{print $1}' | grep -Fxq "$1"
  fi
}

set_repo_secret_from_file() {
  name="$1"
  file_path="$2"
  [ -f "$file_path" ] || fatal "Secret file not found for $name: $file_path"

  if secret_exists "$name" && ! confirm "Secret $name already exists in $SECRET_SCOPE scope. Overwrite?"; then
    warn "Keeping existing secret $name"
    return
  fi

  if is_true "$DRY_RUN" || is_true "$SKIP_GH_CHECK"; then
    if [ "$SECRET_SCOPE" = "org" ]; then
      log "[dry-run] gh secret set $name --org $ORG_NAME --repos $ORG_SELECTED_REPOS --app actions < $file_path"
    else
      log "[dry-run] gh secret set $name --repo $TARGET_REPO < $file_path"
    fi
  else
    if [ "$SECRET_SCOPE" = "org" ]; then
      gh secret set "$name" --org "$ORG_NAME" --repos "$ORG_SELECTED_REPOS" --app actions < "$file_path" >/dev/null
      ok "Stored org secret $name for $ORG_NAME repos: $ORG_SELECTED_REPOS"
    else
      gh secret set "$name" --repo "$TARGET_REPO" < "$file_path" >/dev/null
      ok "Stored repo secret $name"
    fi
  fi
}

set_repo_secret_value() {
  name="$1"
  value="$2"
  [ -n "$value" ] || fatal "Secret $name cannot be empty"

  tmp_file="$(mktemp)"
  chmod 600 "$tmp_file"
  printf '%s' "$value" > "$tmp_file"
  set_repo_secret_from_file "$name" "$tmp_file"
  rm -f "$tmp_file"
}

generate_ledger_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif command -v shasum >/dev/null 2>&1; then
    printf '%s:%s:%s' "$TARGET_REPO" "$RANDOM" "$(date +%s%N)" | shasum -a 256 | awk '{print $1}'
  else
    printf '%s:%s:%s' "$TARGET_REPO" "$RANDOM" "$(date +%s%N)" | sha256sum | awk '{print $1}'
  fi
}

setup_ledger_secret() {
  REVIEW_ROUTER_LEDGER_KEY_VALUE="$(env_first REVIEW_ROUTER_LEDGER_KEY AI_ROBOT_REVIEW_LEDGER_KEY || true)"
  if [ -z "$REVIEW_ROUTER_LEDGER_KEY_VALUE" ]; then
    REVIEW_ROUTER_LEDGER_KEY_VALUE="$(generate_ledger_key)"
  fi
  set_repo_secret_value REVIEW_ROUTER_LEDGER_KEY "$REVIEW_ROUTER_LEDGER_KEY_VALUE"
}

set_repo_variable() {
  name="$1"
  value="$2"
  [ -n "$value" ] || fatal "Variable $name cannot be empty"

  if variable_exists "$name" && ! confirm "Variable $name already exists in $SECRET_SCOPE scope. Overwrite?"; then
    warn "Keeping existing variable $name"
    return
  fi

  if is_true "$DRY_RUN" || is_true "$SKIP_GH_CHECK"; then
    if [ "$SECRET_SCOPE" = "org" ]; then
      log "[dry-run] gh variable set $name --org $ORG_NAME --repos $ORG_SELECTED_REPOS --body <redacted>"
    else
      log "[dry-run] gh variable set $name --repo $TARGET_REPO --body <redacted>"
    fi
  else
    if [ "$SECRET_SCOPE" = "org" ]; then
      gh variable set "$name" --org "$ORG_NAME" --repos "$ORG_SELECTED_REPOS" --body "$value" >/dev/null
      ok "Stored org variable $name=$value for $ORG_NAME repos: $ORG_SELECTED_REPOS"
    else
      gh variable set "$name" --repo "$TARGET_REPO" --body "$value" >/dev/null
      ok "Stored repo variable $name=$value"
    fi
  fi
}

can_run_remote_checks() {
  ! is_true "$DRY_RUN" && ! is_true "$LOCAL_ONLY" && ! is_true "$SKIP_GH_CHECK"
}

current_checkout_for_target_repo() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
  repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || return 1
  remote_url="$(git -C "$repo_root" config --get remote.origin.url || true)"
  [ -n "$remote_url" ] || return 1
  detected_repo="$(normalize_remote_repo "$remote_url" 2>/dev/null || true)"
  [ "$detected_repo" = "$TARGET_REPO" ] || return 1
  printf '%s' "$repo_root"
}

decode_base64_to_stdout() {
  if base64 --decode >/dev/null 2>&1 </dev/null; then
    base64 --decode
  else
    base64 -D
  fi
}

read_github_file() {
  repo_path="$1"
  ref="$2"
  encoded="$(gh api "repos/$TARGET_REPO/contents/$repo_path?ref=$ref" --jq '.content' 2>/dev/null || true)"
  [ -n "$encoded" ] || return 1
  printf '%s' "$encoded" | tr -d '\n' | decode_base64_to_stdout 2>/dev/null
}

find_codeowners_content() {
  ref="$1"
  for codeowners_path in CODEOWNERS .github/CODEOWNERS docs/CODEOWNERS; do
    if content="$(read_github_file "$codeowners_path" "$ref")"; then
      printf '%s\n' "$content"
      return 0
    fi
  done
  return 1
}

run_security_advisory() {
  log ""
  info "Security advisory"
  if [ "$AUTH_MODE" = "codex" ]; then
    warn "Codex OAuth stores your ChatGPT-managed Codex auth.json as an Actions secret. Use it only for trusted private automation; prefer OpenAI API key mode for public/open-source repositories."
    if [ "$CODEX_AUTH_PERSISTENCE" = "persistent" ]; then
      ok "Codex auth persistence is set to persistent; this only helps on trusted self-hosted runners with persistent CODEX_HOME."
      case "$RUNS_ON" in
        ubuntu-latest|macos-latest|windows-latest)
          warn "Persistent Codex auth was selected with a GitHub-hosted runner label ($RUNS_ON). The runner filesystem is ephemeral, so refreshed auth.json will not survive the job."
          ;;
      esac
    else
      warn "GitHub-hosted runners are ephemeral. If Codex refreshes auth.json during a run, ReviewRouter cannot persist the refreshed file back to GitHub secrets automatically; reseed auth.json if Codex starts returning 401."
    fi
  elif [ "$AUTH_MODE" = "claude" ]; then
    warn "Claude OAuth stores a one-year Claude Code subscription token as an Actions secret. Use it only for trusted private automation; prefer API-key mode for shared public/open-source automation."
  else
    ok "Auth mode does not store Codex OAuth auth.json"
  fi
  ok "Generated workflows use pull_request, skip fork PR secret-backed review, and do not use pull_request_target."

  if ! can_run_remote_checks; then
    warn "Skipping remote repository hardening checks in dry-run/local-only mode"
    return
  fi

  repo_visibility="$(gh repo view "$TARGET_REPO" --json visibility --jq '.visibility' 2>/dev/null || true)"
  default_branch="$(gh repo view "$TARGET_REPO" --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null || true)"
  [ -n "$default_branch" ] || default_branch="main"

  if { [ "$AUTH_MODE" = "codex" ] || [ "$AUTH_MODE" = "claude" ]; } && [ "$repo_visibility" = "PUBLIC" ]; then
    warn "Target repository is public and auth mode uses a personal subscription OAuth secret. GitHub does not pass Actions secrets to fork PR workflows, but subscription OAuth is still not recommended for public/open-source repos."
  fi

  if gh api "repos/$TARGET_REPO/branches/$default_branch/protection" >/dev/null 2>&1; then
    ok "Default branch protection is enabled on $default_branch"
    if [ "$(gh api "repos/$TARGET_REPO/branches/$default_branch/protection" --jq '.required_pull_request_reviews != null' 2>/dev/null || printf 'false')" != "true" ]; then
      warn "Default branch protection exists, but required pull request reviews were not detected. Require reviews for workflow changes before relying on secret-backed review."
    fi
  else
    warn "Default branch protection was not detected on $default_branch. Protect the branch before storing Codex OAuth or provider API secrets."
  fi

  if codeowners="$(find_codeowners_content "$default_branch")"; then
    ok "CODEOWNERS file detected"
    if printf '%s\n' "$codeowners" | grep -Eq '(^|[[:space:]])\.github/(\*\*|workflows(/|\*\*)?)'; then
      ok "CODEOWNERS appears to cover .github workflows"
    else
      warn "CODEOWNERS exists, but .github/workflows/** ownership was not detected. Add a workflow owners rule for stronger secret protection."
    fi
  else
    warn "CODEOWNERS was not detected. Add CODEOWNERS for .github/workflows/** so workflow changes require trusted reviewers."
  fi
}

verify_codex_auth_file() {
  auth_file="$1"
  [ -f "$auth_file" ] || fatal "Codex auth file not found: $auth_file. Run: codex login"
  require_cmd python3
  python3 - "$auth_file" <<'PY'
import json
import sys
path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as f:
    data = json.load(f)
if data.get('auth_mode') != 'chatgpt':
    raise SystemExit('auth_mode must be chatgpt')
if not ((data.get('tokens') or {}).get('refresh_token')):
    raise SystemExit('tokens.refresh_token is missing')
PY
}

resolve_codex_auth_file() {
  explicit_auth_file="$(env_first REVIEW_ROUTER_CODEX_AUTH_FILE AI_ROBOT_REVIEW_CODEX_AUTH_FILE || true)"
  if [ -n "$explicit_auth_file" ]; then
    printf '%s\n' "$explicit_auth_file"
    return
  fi

  codex_home="${CODEX_HOME:-$HOME/.codex}"
  legacy_auth_file="$codex_home/auth.json"
  if [ -f "$legacy_auth_file" ]; then
    printf '%s\n' "$legacy_auth_file"
    return
  fi

  if command -v python3 >/dev/null 2>&1; then
    active_auth_file="$(
      python3 - "$codex_home" <<'PY' 2>/dev/null || true
import base64
import json
import os
import sys

codex_home = sys.argv[1]
registry_path = os.path.join(codex_home, 'accounts', 'registry.json')
if not os.path.exists(registry_path):
    raise SystemExit(0)

with open(registry_path, 'r', encoding='utf-8') as f:
    registry = json.load(f)

active_key = registry.get('active_account_key')
if not active_key:
    raise SystemExit(0)

encoded = base64.urlsafe_b64encode(active_key.encode('utf-8')).decode('ascii').rstrip('=')
auth_path = os.path.join(codex_home, 'accounts', f'{encoded}.auth.json')
if os.path.exists(auth_path):
    print(auth_path)
PY
    )"
    if [ -n "$active_auth_file" ]; then
      printf '%s\n' "$active_auth_file"
      return
    fi
  fi

  printf '%s\n' "$legacy_auth_file"
}

setup_auth() {
  preset_values
  case "$AUTH_MODE" in
    codex)
      if [ -z "$DISCUSSION_MODE" ]; then DISCUSSION_MODE="suggest"; fi
      validate_discussion_mode "$DISCUSSION_MODE"
      auth_file="$(resolve_codex_auth_file)"
      config_file="$(env_first REVIEW_ROUTER_CODEX_CONFIG_FILE AI_ROBOT_REVIEW_CODEX_CONFIG_FILE || printf '%s' "${CODEX_HOME:-$HOME/.codex}/config.toml")"
      verify_codex_auth_file "$auth_file"
      set_repo_secret_from_file CODEX_AUTH_JSON "$auth_file"
      include_codex_config="$(env_first REVIEW_ROUTER_INCLUDE_CODEX_CONFIG AI_ROBOT_REVIEW_INCLUDE_CODEX_CONFIG || printf '0')"
      if is_true "$include_codex_config"; then
        [ -f "$config_file" ] || fatal "Codex config file not found: $config_file"
        set_repo_secret_from_file CODEX_CONFIG_TOML "$config_file"
      else
        warn "Skipping CODEX_CONFIG_TOML by default to avoid carrying local plugins/hooks into CI. Set REVIEW_ROUTER_INCLUDE_CODEX_CONFIG=1 if you need it."
      fi
      set_repo_variable REVIEW_AUTH_MODE "codex-oauth"
      set_repo_variable REVIEW_CODEX_MODEL "$CODEX_MODEL"
      set_repo_variable REVIEW_CODEX_EFFORT "$CODEX_REASONING_EFFORT"
      set_repo_variable REVIEW_ROUTER_DISCUSSION_MODE "$DISCUSSION_MODE"
      ;;
    openai)
      if [ -z "$DISCUSSION_MODE" ]; then DISCUSSION_MODE="suggest"; fi
      validate_discussion_mode "$DISCUSSION_MODE"
      REVIEW_ROUTER_OPENAI_API_KEY="$(env_first REVIEW_ROUTER_OPENAI_API_KEY AI_ROBOT_REVIEW_OPENAI_API_KEY || true)"
      prompt_secret REVIEW_ROUTER_OPENAI_API_KEY "OpenAI API key"
      set_repo_secret_value OPENAI_API_KEY "$REVIEW_ROUTER_OPENAI_API_KEY"
      set_repo_variable REVIEW_AUTH_MODE "openai-api"
      set_repo_variable REVIEW_CODEX_MODEL "$CODEX_MODEL"
      set_repo_variable REVIEW_CODEX_EFFORT "$CODEX_REASONING_EFFORT"
      set_repo_variable REVIEW_ROUTER_DISCUSSION_MODE "$DISCUSSION_MODE"
      ;;
    claude)
      if [ -z "$DISCUSSION_MODE" ]; then DISCUSSION_MODE="off"; fi
      validate_discussion_mode "$DISCUSSION_MODE"
      if [ "$DISCUSSION_MODE" != "off" ]; then
        warn "AI discussion replies currently require Codex CLI auth. For Claude installs, REVIEW_ROUTER_DISCUSSION_MODE will be set to off."
        DISCUSSION_MODE="off"
      fi
      REVIEW_ROUTER_CLAUDE_CODE_OAUTH_TOKEN="$(env_first REVIEW_ROUTER_CLAUDE_CODE_OAUTH_TOKEN AI_ROBOT_REVIEW_CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN || true)"
      prompt_secret REVIEW_ROUTER_CLAUDE_CODE_OAUTH_TOKEN "Claude Code OAuth token from claude setup-token"
      set_repo_secret_value CLAUDE_CODE_OAUTH_TOKEN "$REVIEW_ROUTER_CLAUDE_CODE_OAUTH_TOKEN"
      set_repo_variable REVIEW_AUTH_MODE "claude-oauth"
      set_repo_variable REVIEW_CLAUDE_MODEL "$CLAUDE_MODEL"
      set_repo_variable REVIEW_ROUTER_DISCUSSION_MODE "$DISCUSSION_MODE"
      ;;
    openrouter)
      if [ -z "$DISCUSSION_MODE" ]; then DISCUSSION_MODE="off"; fi
      validate_discussion_mode "$DISCUSSION_MODE"
      if [ "$DISCUSSION_MODE" != "off" ]; then
        warn "AI discussion replies currently require Codex CLI auth. For OpenRouter installs, REVIEW_ROUTER_DISCUSSION_MODE will be set to off."
        DISCUSSION_MODE="off"
      fi
      REVIEW_ROUTER_OPENROUTER_API_KEY="$(env_first REVIEW_ROUTER_OPENROUTER_API_KEY AI_ROBOT_REVIEW_OPENROUTER_API_KEY || true)"
      prompt_secret REVIEW_ROUTER_OPENROUTER_API_KEY "OpenRouter API key"
      set_repo_secret_value OPENROUTER_API_KEY "$REVIEW_ROUTER_OPENROUTER_API_KEY"
      set_repo_variable REVIEW_AUTH_MODE "openrouter-api"
      set_repo_variable REVIEW_PROVIDERS "$OPENROUTER_DEFAULT_PROVIDERS"
      set_repo_variable REVIEW_SYNTHESIS_MODEL "$OPENROUTER_DEFAULT_SYNTHESIS"
      set_repo_variable REVIEW_ROUTER_DISCUSSION_MODE "$DISCUSSION_MODE"
      ;;
    *) fatal "Unsupported auth mode: $AUTH_MODE" ;;
  esac
}

safe_app_name() {
  owner="$(repo_owner "$TARGET_REPO")"
  repo="$(repo_name "$TARGET_REPO")"
  raw="$(env_first REVIEW_ROUTER_APP_NAME AI_ROBOT_REVIEW_APP_NAME || printf '%s' "$PRODUCT_NAME-$owner-$repo")"
  printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9-' '-' | sed 's/^-//; s/-$//; s/--*/-/g' | cut -c1-34
}

app_profile_dir() {
  if [ -n "$APP_PROFILE_DIR" ]; then
    printf '%s' "$APP_PROFILE_DIR"
  elif [ -n "${XDG_CONFIG_HOME:-}" ]; then
    printf '%s/review-router/apps' "$XDG_CONFIG_HOME"
  else
    printf '%s/.config/review-router/apps' "$HOME"
  fi
}

shell_quote() {
  printf '%q' "$1"
}

validate_app_private_key_file() {
  key_file="$1"
  [ -f "$key_file" ] || fatal "GitHub App private key file not found: $key_file"
  [ -r "$key_file" ] || fatal "GitHub App private key file is not readable: $key_file"
  grep -q 'BEGIN .*PRIVATE KEY' "$key_file" || fatal "GitHub App private key file does not look like a PEM private key: $key_file"
}

profile_path_for_slug() {
  slug="$1"
  printf '%s/%s.env' "$(app_profile_dir)" "$slug"
}

has_saved_app_profiles() {
  profile_dir="$(app_profile_dir)"
  [ -d "$profile_dir" ] || return 1
  for profile_file in "$profile_dir"/*.env; do
    [ -f "$profile_file" ] && return 0
  done
  return 1
}

save_app_profile() {
  app_id="$1"
  client_id="$2"
  slug="$3"
  app_name="$4"
  private_key_file="$5"
  [ -n "$app_id" ] || fatal "APP_ID is required for GitHub App profile"
  [ -n "$client_id" ] || fatal "APP_CLIENT_ID is required for GitHub App profile"
  [ -n "$slug" ] || fatal "APP_SLUG is required for GitHub App profile"
  validate_app_private_key_file "$private_key_file"

  profile_dir="$(app_profile_dir)"
  mkdir -p "$profile_dir"
  chmod 700 "$profile_dir" 2>/dev/null || true

  safe_slug="$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9-' '-' | sed 's/^-//; s/-$//; s/--*/-/g')"
  [ -n "$safe_slug" ] || fatal "Invalid GitHub App slug for profile: $slug"

  saved_key="$profile_dir/$safe_slug.private-key.pem"
  if [ "$(cd "$(dirname "$private_key_file")" && pwd)/$(basename "$private_key_file")" != "$(cd "$profile_dir" && pwd)/$(basename "$saved_key")" ]; then
    cp "$private_key_file" "$saved_key"
  fi
  chmod 600 "$saved_key"

  profile_file="$profile_dir/$safe_slug.env"
  {
    printf 'APP_ID=%s\n' "$(shell_quote "$app_id")"
    printf 'APP_CLIENT_ID=%s\n' "$(shell_quote "$client_id")"
    printf 'APP_SLUG=%s\n' "$(shell_quote "$slug")"
    printf 'APP_NAME=%s\n' "$(shell_quote "${app_name:-$slug}")"
    printf 'APP_PRIVATE_KEY_FILE=%s\n' "$(shell_quote "$saved_key")"
  } > "$profile_file"
  chmod 600 "$profile_file"
  SAVED_APP_PROFILE_FILE="$profile_file"
  ok "Saved GitHub App profile: $profile_file"
}

load_app_profile() {
  profile="$1"
  profile_dir="$(app_profile_dir)"
  if [ -f "$profile" ]; then
    profile_file="$profile"
  else
    profile_slug="${profile%.env}"
    profile_file="$profile_dir/$profile_slug.env"
  fi
  [ -f "$profile_file" ] || fatal "Saved GitHub App profile not found: $profile_file"

  APP_ID=""
  APP_CLIENT_ID=""
  APP_SLUG=""
  APP_NAME=""
  APP_PRIVATE_KEY_FILE=""
  # shellcheck disable=SC1090
  . "$profile_file"
  [ -n "${APP_ID:-}" ] || fatal "APP_ID missing in profile: $profile_file"
  [ -n "${APP_CLIENT_ID:-}" ] || fatal "APP_CLIENT_ID missing in profile: $profile_file"
  [ -n "${APP_SLUG:-}" ] || fatal "APP_SLUG missing in profile: $profile_file"
  [ -n "${APP_PRIVATE_KEY_FILE:-}" ] || fatal "APP_PRIVATE_KEY_FILE missing in profile: $profile_file"
  validate_app_private_key_file "$APP_PRIVATE_KEY_FILE"
  ok "Loaded GitHub App profile: ${APP_NAME:-$APP_SLUG} ($APP_SLUG)"
}

run_app_doctor() {
  [ "$IDENTITY_MODE" = "app" ] || return
  if is_true "$SKIP_APP_DOCTOR"; then
    warn "Skipping GitHub App doctor because REVIEW_ROUTER_SKIP_APP_DOCTOR=1"
    return
  fi
  if ! can_run_remote_checks; then
    warn "Skipping GitHub App doctor in dry-run/local-only mode"
    return
  fi

  require_cmd python3
  require_cmd openssl
  info "Running GitHub App doctor for $APP_SLUG on $TARGET_REPO"
  app_jwt="$(python3 - "$APP_ID" "$APP_PRIVATE_KEY_FILE" <<'PY'
import base64
import json
import subprocess
import sys
import time

app_id, key_file = sys.argv[1:3]

def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode('ascii').rstrip('=')

now = int(time.time())
header = b64url(json.dumps({'alg': 'RS256', 'typ': 'JWT'}, separators=(',', ':')).encode())
payload = b64url(json.dumps({'iat': now - 60, 'exp': now + 540, 'iss': app_id}, separators=(',', ':')).encode())
signing_input = f'{header}.{payload}'.encode()
proc = subprocess.run(
    ['openssl', 'dgst', '-sha256', '-sign', key_file],
    input=signing_input,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    check=False,
)
if proc.returncode != 0:
    raise SystemExit(f'Could not sign GitHub App JWT with {key_file}: {proc.stderr.decode(errors="ignore").strip()}')
print(f'{header}.{payload}.{b64url(proc.stdout)}')
PY
)"

  app_id_actual="$(gh api /app -H "Authorization: Bearer $app_jwt" --jq '.id')"
  app_client_id_actual="$(gh api /app -H "Authorization: Bearer $app_jwt" --jq '.client_id')"
  app_slug_actual="$(gh api /app -H "Authorization: Bearer $app_jwt" --jq '.slug')"

  [ "$app_id_actual" = "$APP_ID" ] || fatal "GitHub App private key belongs to App ID $app_id_actual, not configured APP_ID $APP_ID"
  [ "$app_client_id_actual" = "$APP_CLIENT_ID" ] || fatal "GitHub App client ID mismatch: API returned $app_client_id_actual, profile has $APP_CLIENT_ID"
  [ "$app_slug_actual" = "$APP_SLUG" ] || fatal "GitHub App slug mismatch: API returned $app_slug_actual, profile has $APP_SLUG"

  missing_permissions=""
  actual_actions="$(gh api /app -H "Authorization: Bearer $app_jwt" --jq '.permissions.actions // ""')"
  actual_contents="$(gh api /app -H "Authorization: Bearer $app_jwt" --jq '.permissions.contents // ""')"
  actual_issues="$(gh api /app -H "Authorization: Bearer $app_jwt" --jq '.permissions.issues // ""')"
  actual_pull_requests="$(gh api /app -H "Authorization: Bearer $app_jwt" --jq '.permissions.pull_requests // ""')"
  [ "$actual_actions" = "write" ] || missing_permissions="$missing_permissions actions:write (current: ${actual_actions:-none})"
  case "$actual_contents" in
    read|write) ;;
    *) missing_permissions="$missing_permissions contents:read (current: ${actual_contents:-none})" ;;
  esac
  [ "$actual_issues" = "write" ] || missing_permissions="$missing_permissions issues:write (current: ${actual_issues:-none})"
  [ "$actual_pull_requests" = "write" ] || missing_permissions="$missing_permissions pull_requests:write (current: ${actual_pull_requests:-none})"
  [ -z "$missing_permissions" ] || fatal "GitHub App is missing required permissions:$missing_permissions. Open https://github.com/settings/apps/$APP_SLUG/permissions, update permissions, then approve the installation update."

  installed=0
  installed_accounts=""
  installation_ids="$(gh api /app/installations -H "Authorization: Bearer $app_jwt" --paginate --jq '.[].id')"
  for installation_id in $installation_ids; do
    account_login="$(gh api "/app/installations/$installation_id" -H "Authorization: Bearer $app_jwt" --jq '.account.login // .account.slug // empty' 2>/dev/null || true)"
    repo_selection="$(gh api "/app/installations/$installation_id" -H "Authorization: Bearer $app_jwt" --jq '.repository_selection // empty' 2>/dev/null || true)"
    if [ -n "$account_login" ]; then
      if [ -n "$installed_accounts" ]; then
        installed_accounts="$installed_accounts, $account_login ($repo_selection)"
      else
        installed_accounts="$account_login ($repo_selection)"
      fi
    fi
    installation_token="$(gh api --method POST "/app/installations/$installation_id/access_tokens" -H "Authorization: Bearer $app_jwt" --jq '.token')"
    if gh api "/repos/$TARGET_REPO" -H "Authorization: Bearer $installation_token" >/dev/null 2>&1; then
      installed=1
      break
    fi
  done
  if [ "$installed" != "1" ]; then
    warn "GitHub App $APP_SLUG is not installed on $TARGET_REPO yet."
    if [ -n "$installed_accounts" ]; then
      warn "Current App installations visible to this private key: $installed_accounts"
      warn "Target repository owner is $(repo_owner "$TARGET_REPO"). Install the App for that account/org and include $(repo_name "$TARGET_REPO")."
    else
      warn "No installations are visible to this GitHub App private key yet."
    fi
    return 2
  fi

  ok "GitHub App doctor passed"
}

ensure_app_doctor_passes() {
  [ "$IDENTITY_MODE" = "app" ] || return
  attempts=0
  install_url="https://github.com/apps/$APP_SLUG/installations/new"

  while :; do
    if run_app_doctor; then
      return
    else
      status="$?"
    fi
    [ "$status" = "2" ] || return "$status"

    attempts=$((attempts + 1))
    log ""
    warn "ReviewRouter cannot access $TARGET_REPO through $APP_SLUG yet."
    log "Install URL: $install_url"
    log "Select owner/account $(repo_owner "$TARGET_REPO"), choose repository $(repo_name "$TARGET_REPO"), approve the installation, then retry."

    if is_true "$NON_INTERACTIVE"; then
      fatal "Install the GitHub App on $TARGET_REPO, then rerun the installer: $install_url"
    fi
    if is_true "$YES"; then
      if [ "$attempts" -ge 5 ]; then
        fatal "GitHub App $APP_SLUG still cannot access $TARGET_REPO after $attempts checks. Install it here, then rerun the installer: $install_url"
      fi
      sleep 3
      continue
    fi
    confirm "I installed $APP_SLUG on $TARGET_REPO. Retry the check?" || fatal "Install the GitHub App on $TARGET_REPO, then rerun the installer: $install_url"
  done
}

select_saved_app_profile() {
  profile_dir="$(app_profile_dir)"
  if [ -n "$APP_PROFILE" ]; then
    load_app_profile "$APP_PROFILE"
    return
  fi

  [ -d "$profile_dir" ] || fatal "No saved GitHub App profiles found in $profile_dir. Use REVIEW_ROUTER_APP_SETUP=create or REVIEW_ROUTER_APP_SETUP=manual first."

  profiles=()
  for profile_file in "$profile_dir"/*.env; do
    [ -f "$profile_file" ] || continue
    profiles+=("$profile_file")
  done
  [ "${#profiles[@]}" -gt 0 ] || fatal "No saved GitHub App profiles found in $profile_dir. Use REVIEW_ROUTER_APP_SETUP=create or REVIEW_ROUTER_APP_SETUP=manual first."

  if [ "${#profiles[@]}" -eq 1 ]; then
    load_app_profile "${profiles[0]}"
    return
  fi
  if is_true "$NON_INTERACTIVE"; then
    fatal "Multiple saved GitHub App profiles found in $profile_dir. Set REVIEW_ROUTER_APP_PROFILE to the profile slug or .env path."
  fi

  options=()
  first_slug=""
  for profile_file in "${profiles[@]}"; do
    slug="$(basename "$profile_file" .env)"
    [ -n "$first_slug" ] || first_slug="$slug"
    options+=("$slug:$profile_file")
  done
  choose APP_PROFILE "Saved GitHub App profile" "$first_slug" "${options[@]}"
  load_app_profile "$APP_PROFILE"
}

store_loaded_app_credentials() {
  ensure_app_doctor_passes
  set_repo_variable REVIEW_APP_CLIENT_ID "$APP_CLIENT_ID"
  set_repo_variable REVIEW_APP_ID "$APP_ID"
  set_repo_variable REVIEW_APP_SLUG "$APP_SLUG"
  set_repo_secret_from_file REVIEW_APP_PRIVATE_KEY "$APP_PRIVATE_KEY_FILE"
}

print_app_logo_instruction() {
  app_slug="${1:-${APP_SLUG:-}}"
  [ -n "$app_slug" ] || return
  log ""
  info "Optional: upload the ReviewRouter logo for this GitHub App"
  log "App settings: https://github.com/settings/apps/$app_slug"
  log "Logo: $APP_LOGO_URL"
  log "Recommended: PNG/JPG/GIF under 1 MB, 200x200"
}

manual_app_setup() {
  app_name="$1"
  reason="${2:-manual}"
  if [ "$reason" = "missing-python" ]; then
    warn "python3 is not available; falling back to manual GitHub App setup."
    log "Create a private GitHub App named: $app_name"
    log "Permissions: Contents read, Issues write, Pull requests write, Actions write. Webhooks: disabled."
    log "After creating it, generate a private key and provide the values below."
  else
    log "Import an existing GitHub App by entering its credentials."
    log "The App must have Contents read, Issues write, Pull requests write, and Actions write permissions."
    log "GitHub does not expose existing private keys; use a .pem you already saved or generate a new key in the App settings."
    log "After import, this machine will save a local reusable profile under $(app_profile_dir)."
  fi
  REVIEW_ROUTER_APP_CLIENT_ID="$(env_first REVIEW_ROUTER_APP_CLIENT_ID AI_ROBOT_REVIEW_APP_CLIENT_ID || true)"
  REVIEW_ROUTER_APP_ID="$(env_first REVIEW_ROUTER_APP_ID AI_ROBOT_REVIEW_APP_ID || true)"
  REVIEW_ROUTER_APP_SLUG="$(env_first REVIEW_ROUTER_APP_SLUG AI_ROBOT_REVIEW_APP_SLUG || true)"
  REVIEW_ROUTER_APP_PRIVATE_KEY_FILE="$(env_first REVIEW_ROUTER_APP_PRIVATE_KEY_FILE AI_ROBOT_REVIEW_APP_PRIVATE_KEY_FILE || true)"
  prompt_text REVIEW_ROUTER_APP_CLIENT_ID "GitHub App client ID" ""
  prompt_text REVIEW_ROUTER_APP_ID "GitHub App ID" ""
  prompt_text REVIEW_ROUTER_APP_SLUG "GitHub App slug" ""
  prompt_text REVIEW_ROUTER_APP_PRIVATE_KEY_FILE "Path to GitHub App private key .pem" ""
  validate_app_private_key_file "$REVIEW_ROUTER_APP_PRIVATE_KEY_FILE"
  save_app_profile "$REVIEW_ROUTER_APP_ID" "$REVIEW_ROUTER_APP_CLIENT_ID" "$REVIEW_ROUTER_APP_SLUG" "$app_name" "$REVIEW_ROUTER_APP_PRIVATE_KEY_FILE"
  load_app_profile "$SAVED_APP_PROFILE_FILE"
  store_loaded_app_credentials
  print_app_logo_instruction "$APP_SLUG"
}

reuse_saved_app_setup() {
  select_saved_app_profile
  store_loaded_app_credentials
}

create_github_app_with_manifest() {
  app_name="$1"
  if is_true "$DRY_RUN" || is_true "$LOCAL_ONLY" || is_true "$SKIP_APP_CREATE"; then
    warn "Skipping GitHub App creation in dry-run/local-only/test mode"
    APP_CLIENT_ID="Iv1.local-test-client-id"
    APP_ID="0"
    APP_SLUG="$app_name"
    APP_NAME="$app_name"
    set_repo_variable REVIEW_APP_CLIENT_ID "Iv1.local-test-client-id"
    set_repo_variable REVIEW_APP_ID "0"
    set_repo_variable REVIEW_APP_SLUG "$app_name"
    return
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    manual_app_setup "$app_name" "missing-python"
    return
  fi

  tmp_dir="$(mktemp -d)"
  env_file="$tmp_dir/app.env"

  info "Creating user-owned GitHub App via manifest flow"
  python3 - "$app_name" "$TARGET_REPO" "$env_file" "$NO_BROWSER" "$APP_LOGO_URL" <<'PY'
import http.server
import html
import json
import os
import secrets
import shlex
import socketserver
import subprocess
import sys
import threading
import urllib.parse
import webbrowser

app_name, target_repo, env_file, no_browser, app_logo_url = sys.argv[1:6]
app_logo_url_html = html.escape(app_logo_url, quote=True)
state = secrets.token_urlsafe(18)
result = {}
error = {}

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def _send(self, status, body, content_type='text/html; charset=utf-8'):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.end_headers()
        self.wfile.write(body.encode('utf-8'))

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/':
            callback = f'http://127.0.0.1:{self.server.server_address[1]}/callback'
            manifest = {
                'name': app_name,
                'url': 'https://github.com/777genius/review-router',
                'description': 'ReviewRouter posts Codex-powered pull request reviews from a dedicated GitHub App bot identity.',
                'public': False,
                'redirect_url': callback,
                'callback_urls': [callback],
                'hook_attributes': {
                    'url': 'https://example.invalid/review-router-webhook-disabled',
                    'active': False,
                },
                'default_permissions': {
                    'actions': 'write',
                    'contents': 'read',
                    'issues': 'write',
                    'pull_requests': 'write',
                },
                'default_events': [],
                'request_oauth_on_install': False,
                'setup_on_update': False,
            }
            manifest_json = json.dumps(manifest).replace("'", '&#39;')
            self._send(200, f'''<!doctype html>
<html><head><meta charset="utf-8"><title>Create {app_name}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:760px;margin:40px auto;line-height:1.45;">
<h1>Create {app_name}</h1>
<p>This creates a private GitHub App with Contents read, Issues write, Pull requests write, and Actions write permissions.</p>
<form action="https://github.com/settings/apps/new?state={state}" method="post">
  <input type="hidden" name="manifest" value='{manifest_json}'>
  <button style="font-size:18px;padding:10px 16px;" type="submit">Create GitHub App</button>
</form>
<p>After GitHub redirects back, this installer will store App credentials in <code>{target_repo}</code>.</p>
</body></html>''')
            return

        if parsed.path == '/callback':
            params = urllib.parse.parse_qs(parsed.query)
            if params.get('state', [''])[0] != state:
                self._send(400, 'State mismatch. Close this page and rerun the installer.', 'text/plain; charset=utf-8')
                return
            code = params.get('code', [''])[0]
            if not code:
                self._send(400, 'Missing GitHub manifest code.', 'text/plain; charset=utf-8')
                return
            try:
                converted = subprocess.check_output(
                    ['gh', 'api', '--method', 'POST', f'/app-manifests/{code}/conversions'],
                    text=True,
                )
                app = json.loads(converted)
                private_key_path = os.path.join(os.path.dirname(env_file), 'private-key.pem')
                with open(private_key_path, 'w', encoding='utf-8') as f:
                    f.write(app['pem'])
                os.chmod(private_key_path, 0o600)
                with open(env_file, 'w', encoding='utf-8') as f:
                    f.write(f"APP_ID={shlex.quote(str(app['id']))}\n")
                    f.write(f"APP_CLIENT_ID={shlex.quote(str(app['client_id']))}\n")
                    f.write(f"APP_SLUG={shlex.quote(str(app['slug']))}\n")
                    f.write(f"APP_NAME={shlex.quote(str(app['name']))}\n")
                    f.write(f"APP_PRIVATE_KEY_FILE={shlex.quote(private_key_path)}\n")
                install_url = f"https://github.com/apps/{app['slug']}/installations/new"
                result['install_url'] = install_url
                self._send(200, f'''<!doctype html>
<html><head><meta charset="utf-8"><title>{app['name']} created</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:760px;margin:40px auto;line-height:1.45;">
<h1>GitHub App credentials saved</h1>
<p><strong>App:</strong> {app['name']} (<code>{app['slug']}[bot]</code>)</p>
<p><strong>Next step:</strong> install the App on <code>{target_repo}</code>.</p>
<p><a style="font-size:18px;" href="{install_url}">Install {app['slug']} on repositories</a></p>
<p><strong>Optional logo:</strong> upload the <a href="{app_logo_url_html}">ReviewRouter logo</a> in App settings. Recommended: PNG/JPG/GIF under 1 MB, 200x200.</p>
<p>Return to the terminal after installing the App.</p>
</body></html>''')
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            except Exception as exc:
                error['message'] = str(exc)
                self._send(500, str(exc), 'text/plain; charset=utf-8')
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            return

        self._send(404, 'Not found', 'text/plain; charset=utf-8')

with socketserver.TCPServer(('127.0.0.1', 0), Handler) as httpd:
    url = f'http://127.0.0.1:{httpd.server_address[1]}/'
    print(f'Open this URL to create the GitHub App: {url}', flush=True)
    if no_browser not in ('1', 'true', 'TRUE', 'yes', 'YES'):
        try:
            webbrowser.open(url)
        except Exception:
            pass
    httpd.serve_forever()

if error:
    raise SystemExit(error['message'])
if not os.path.exists(env_file):
    raise SystemExit('GitHub App manifest flow did not complete')
if result.get('install_url'):
    print(f"Install URL: {result['install_url']}")
PY

  # shellcheck disable=SC1090
  . "$env_file"
  save_app_profile "$APP_ID" "$APP_CLIENT_ID" "$APP_SLUG" "$APP_NAME" "$APP_PRIVATE_KEY_FILE"
  load_app_profile "$SAVED_APP_PROFILE_FILE"
  store_loaded_app_credentials
  rm -rf "$tmp_dir"

  ok "GitHub App credentials saved for $TARGET_REPO"
  warn "Make sure the App is installed on $TARGET_REPO before the first review run."
  print_app_logo_instruction "$APP_SLUG"
}

setup_identity() {
  case "$IDENTITY_MODE" in
    app)
      app_name="$(safe_app_name)"
      log ""
      log "GitHub App bot mode: comments will come from a dedicated App bot, not github-actions[bot]."
      if [ -z "$APP_SETUP" ] && [ -n "$APP_PROFILE" ]; then
        APP_SETUP="saved"
      fi
      if [ -z "$APP_SETUP" ] \
        && [ -n "${REVIEW_ROUTER_APP_CLIENT_ID:-${AI_ROBOT_REVIEW_APP_CLIENT_ID:-}}" ] \
        && [ -n "${REVIEW_ROUTER_APP_ID:-${AI_ROBOT_REVIEW_APP_ID:-}}" ] \
        && [ -n "${REVIEW_ROUTER_APP_SLUG:-${AI_ROBOT_REVIEW_APP_SLUG:-}}" ] \
        && [ -n "${REVIEW_ROUTER_APP_PRIVATE_KEY_FILE:-${AI_ROBOT_REVIEW_APP_PRIVATE_KEY_FILE:-}}" ]; then
        APP_SETUP="manual"
      fi
      if [ -z "$APP_SETUP" ]; then
        app_setup_options=(
          "create:Create a new user-owned GitHub App"
        )
        if has_saved_app_profiles; then
          app_setup_options+=("saved:Reuse a locally saved GitHub App profile")
        else
          warn "No saved GitHub App profiles found yet. Choose create, or manual if you already have an App ID and .pem key."
        fi
        app_setup_options+=("manual:Import existing GitHub App credentials (.pem required) and save a profile")
        choose APP_SETUP "GitHub App setup" "create" "${app_setup_options[@]}"
      fi
      case "$APP_SETUP" in
        create|new)
          APP_SETUP="create"
          create_github_app_with_manifest "$app_name"
          ;;
        saved|reuse)
          APP_SETUP="saved"
          reuse_saved_app_setup
          ;;
        manual|existing)
          APP_SETUP="manual"
          manual_app_setup "$app_name" "manual"
          ;;
        *) fatal "Unsupported REVIEW_ROUTER_APP_SETUP: $APP_SETUP. Use create, saved, or manual." ;;
      esac
      ;;
    actions)
      log ""
      log "github-actions[bot] mode: fastest setup, no GitHub App. Comments use the default Actions bot name/avatar."
      ;;
    *) fatal "Unsupported identity mode: $IDENTITY_MODE" ;;
  esac
}

preset_values() {
  case "$PRESET" in
    safe)
      INLINE_MIN_SEVERITY="major"
      INLINE_MAX_COMMENTS="5"
      FAIL_ON_CRITICAL="true"
      FAIL_ON_MAJOR="false"
      CODEX_REASONING_EFFORT="medium"
      ENABLE_SECURITY="true"
      ENABLE_AST_ANALYSIS="true"
      GRAPH_ENABLED="false"
      ;;
    blocking)
      INLINE_MIN_SEVERITY="major"
      INLINE_MAX_COMMENTS="5"
      FAIL_ON_CRITICAL="true"
      FAIL_ON_MAJOR="true"
      CODEX_REASONING_EFFORT="medium"
      ENABLE_SECURITY="true"
      ENABLE_AST_ANALYSIS="true"
      GRAPH_ENABLED="false"
      ;;
    strict)
      INLINE_MIN_SEVERITY="minor"
      INLINE_MAX_COMMENTS="10"
      FAIL_ON_CRITICAL="true"
      FAIL_ON_MAJOR="true"
      CODEX_REASONING_EFFORT="high"
      ENABLE_SECURITY="true"
      ENABLE_AST_ANALYSIS="true"
      GRAPH_ENABLED="true"
      ;;
    minimal)
      INLINE_MIN_SEVERITY="major"
      INLINE_MAX_COMMENTS="3"
      FAIL_ON_CRITICAL="true"
      FAIL_ON_MAJOR="false"
      CODEX_REASONING_EFFORT="low"
      ENABLE_SECURITY="true"
      ENABLE_AST_ANALYSIS="false"
      GRAPH_ENABLED="false"
      ;;
    *) fatal "Unsupported preset: $PRESET" ;;
  esac
  if [ -n "$CODEX_EFFORT_OVERRIDE" ]; then
    case "$CODEX_EFFORT_OVERRIDE" in
      low|medium|high|xhigh) CODEX_REASONING_EFFORT="$CODEX_EFFORT_OVERRIDE" ;;
      *) fatal "Unsupported REVIEW_ROUTER_CODEX_EFFORT: $CODEX_EFFORT_OVERRIDE. Use low, medium, high, or xhigh." ;;
    esac
  fi
}

runtime_ref_from_action_ref() {
  ref="${ACTION_REF##*@}"
  repo="${ACTION_REF%@*}"
  if [ "$repo" != "777genius/review-router" ]; then
    fatal "Reusable workflow style requires REVIEW_ROUTER_ACTION_REF to use 777genius/review-router."
  fi
  if printf '%s' "$ref" | grep -Eq '^(main|v1|v1\.[0-9]+\.[0-9]+|[a-fA-F0-9]{40})$'; then
    printf '%s' "$ref"
    return
  fi
  fatal "Reusable workflow style requires REVIEW_ROUTER_ACTION_REF to be @main, @v1, @v1.x.x, or @40-char-sha."
}

write_reusable_workflow() {
  workflow_file="$1"
  runtime_ref="$(runtime_ref_from_action_ref)"
  repo_name_value="$(repo_name "$TARGET_REPO")"
  preset_values
  case "$AUTH_MODE" in
    codex) runtime_auth_mode="codex-oauth" ;;
    openai) runtime_auth_mode="openai-api" ;;
    claude) runtime_auth_mode="claude-oauth" ;;
    openrouter) runtime_auth_mode="openrouter-api" ;;
    *) runtime_auth_mode="$AUTH_MODE" ;;
  esac
  static_runtime_env_json="{"
  static_runtime_env_json="$(append_pretty_json_pair "$static_runtime_env_json" REVIEW_AUTH_MODE "$runtime_auth_mode")"
  # Keep only values that differ from runtime defaults, plus quality gates that
  # intentionally differ from older upstream defaults. This keeps caller YAML
  # readable without changing review behavior.
  static_runtime_env_json="$(append_pretty_json_pair "$static_runtime_env_json" MIN_CONFIDENCE "0.6")"
  static_runtime_env_json="$(append_pretty_json_pair "$static_runtime_env_json" CONSENSUS_REQUIRED_FOR_CRITICAL "false")"
  if [ "$INLINE_MAX_COMMENTS" != "5" ]; then
    static_runtime_env_json="$(append_pretty_json_pair "$static_runtime_env_json" INLINE_MAX_COMMENTS "$INLINE_MAX_COMMENTS")"
  fi
  if [ "$INLINE_MIN_SEVERITY" != "major" ]; then
    static_runtime_env_json="$(append_pretty_json_pair "$static_runtime_env_json" INLINE_MIN_SEVERITY "$INLINE_MIN_SEVERITY")"
  fi
  if [ "$FAIL_ON_MAJOR" = "true" ]; then
    static_runtime_env_json="$(append_pretty_json_pair "$static_runtime_env_json" FAIL_ON_MAJOR "$FAIL_ON_MAJOR")"
  fi
  if [ "$ENABLE_AST_ANALYSIS" != "true" ]; then
    static_runtime_env_json="$(append_pretty_json_pair "$static_runtime_env_json" ENABLE_AST_ANALYSIS "$ENABLE_AST_ANALYSIS")"
  fi
  if [ "$ENABLE_SECURITY" != "true" ]; then
    static_runtime_env_json="$(append_pretty_json_pair "$static_runtime_env_json" ENABLE_SECURITY "$ENABLE_SECURITY")"
  fi
  if [ "$GRAPH_ENABLED" != "false" ]; then
    static_runtime_env_json="$(append_pretty_json_pair "$static_runtime_env_json" GRAPH_ENABLED "$GRAPH_ENABLED")"
  fi
  if [ "$AUTH_MODE" = "codex" ] || [ "$AUTH_MODE" = "openai" ]; then
    static_runtime_env_json="$(append_pretty_json_pair "$static_runtime_env_json" CODEX_MODEL "$CODEX_MODEL")"
    static_runtime_env_json="$(append_pretty_json_pair "$static_runtime_env_json" CODEX_REASONING_EFFORT "$CODEX_REASONING_EFFORT")"
  elif [ "$AUTH_MODE" = "claude" ]; then
    static_runtime_env_json="$(append_pretty_json_pair "$static_runtime_env_json" CLAUDE_MODEL "$CLAUDE_MODEL")"
  elif [ "$AUTH_MODE" = "openrouter" ]; then
    static_runtime_env_json="$(append_pretty_json_pair "$static_runtime_env_json" REVIEW_PROVIDERS "$OPENROUTER_DEFAULT_PROVIDERS")"
    static_runtime_env_json="$(append_pretty_json_pair "$static_runtime_env_json" SYNTHESIS_MODEL "$OPENROUTER_DEFAULT_SYNTHESIS")"
  fi
  if [ "$IDENTITY_MODE" = "app" ] && [ -n "${APP_SLUG:-}" ]; then
    static_runtime_env_json="$(append_pretty_json_pair "$static_runtime_env_json" REVIEW_APP_SLUG "$APP_SLUG")"
  fi
  static_runtime_env_json="$static_runtime_env_json
}"
  mkdir -p "$(dirname "$workflow_file")"

  {
    cat <<'YAML'
name: ReviewRouter

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  merge_group:
  workflow_dispatch:
    inputs:
      pr_number:
        description: Pull request number
        required: false
        type: string

permissions:
  contents: read
  issues: write
  pull-requests: write
  id-token: write

concurrency:
  group: review-router-${{ github.event.pull_request.number || inputs.pr_number || github.ref }}
  cancel-in-progress: false

jobs:
  review:
YAML
    printf '    uses: 777genius/review-router/.github/workflows/reviewrouter-reusable.yml@%s\n' "$runtime_ref"
    cat <<YAML
    with:
      runtime_ref: $runtime_ref
      runtime_config_mode: oidc
      # Non-secret fallback config. Provider credentials stay in GitHub Actions secrets.
      static_runtime_env_json: >-
$(printf '%s\n' "$static_runtime_env_json" | sed 's/^/        /')
      pr_number: \${{ github.event.pull_request.number || inputs.pr_number }}
YAML
    if [ "$IDENTITY_MODE" = "app" ]; then
      cat <<YAML
      review_app_client_id: \${{ vars.REVIEW_APP_CLIENT_ID }}
      review_app_repository: $repo_name_value
YAML
    fi
    cat <<'YAML'
    secrets:
      # Secrets are read only by this repository workflow. ReviewRouter SaaS does not store provider credentials.
      REVIEW_ROUTER_LEDGER_KEY: ${{ secrets.REVIEW_ROUTER_LEDGER_KEY }}
YAML
    if [ "$IDENTITY_MODE" = "app" ]; then
      cat <<'YAML'
      REVIEW_APP_PRIVATE_KEY: ${{ secrets.REVIEW_APP_PRIVATE_KEY }}
YAML
    fi
    cat <<'YAML'
      CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}
      CODEX_CONFIG_TOML: ${{ secrets.CODEX_CONFIG_TOML }}
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
      REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN: ${{ secrets.REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN }}
YAML
  } > "$workflow_file"
}

write_reusable_interaction_workflow() {
  workflow_file="$1"
  runtime_ref="$(runtime_ref_from_action_ref)"
  repo_name_value="$(repo_name "$TARGET_REPO")"
  mkdir -p "$(dirname "$workflow_file")"

  {
    cat <<'YAML'
name: ReviewRouter Interaction

on:
  pull_request_review_comment:
    types: [created, edited]

permissions:
  actions: write
  contents: read
  issues: write
  pull-requests: write
  id-token: write

concurrency:
  group: review-router-interaction-${{ github.event.pull_request.number || github.event.comment.id }}
  cancel-in-progress: false

jobs:
  interaction:
YAML
    printf '    uses: 777genius/review-router/.github/workflows/reviewrouter-interaction-reusable.yml@%s\n' "$runtime_ref"
    cat <<YAML
    with:
      runtime_ref: $runtime_ref
      runtime_config_mode: oidc
      review_workflow_file: reviewrouter.yml
YAML
    if [ "$IDENTITY_MODE" = "app" ]; then
      cat <<YAML
      review_app_client_id: \${{ vars.REVIEW_APP_CLIENT_ID }}
      review_app_repository: $repo_name_value
YAML
    fi
    cat <<'YAML'
    secrets:
YAML
    if [ "$IDENTITY_MODE" = "app" ]; then
      cat <<'YAML'
      REVIEW_APP_PRIVATE_KEY: ${{ secrets.REVIEW_APP_PRIVATE_KEY }}
YAML
    fi
    cat <<'YAML'
      REVIEW_ROUTER_LEDGER_KEY: ${{ secrets.REVIEW_ROUTER_LEDGER_KEY }}
YAML
  } > "$workflow_file"
}

write_workflow() {
  workflow_file="$1"
  if [ "$WORKFLOW_STYLE" = "reusable" ]; then
    write_reusable_workflow "$workflow_file"
    return
  fi
  repo_name_value="$(repo_name "$TARGET_REPO")"
  preset_values
  mkdir -p "$(dirname "$workflow_file")"

  {
    cat <<'YAML'
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
    if: ${{ github.event_name == 'workflow_dispatch' || github.event.pull_request.head.repo.fork != true }}
YAML
    printf '    runs-on: %s\n' "$RUNS_ON"
    cat <<'YAML'
    timeout-minutes: 20
YAML

    cat <<'YAML'
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
YAML

    if [ "$IDENTITY_MODE" = "app" ]; then
      cat <<'YAML'

      - name: Create review GitHub App token
        id: app-token
        uses: actions/create-github-app-token@v3
        with:
          client-id: ${{ vars.REVIEW_APP_CLIENT_ID }}
          private-key: ${{ secrets.REVIEW_APP_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}
YAML
      printf '          repositories: %s\n' "$repo_name_value"
      cat <<'YAML'
          permission-contents: read
          permission-issues: write
          permission-pull-requests: write
YAML
    fi

    if [ "$AUTH_MODE" = "codex" ] || [ "$AUTH_MODE" = "openai" ]; then
      cat <<YAML

      - uses: actions/setup-node@v6
        with:
          node-version: '24'

      - name: Install official Codex CLI
        run: npm install -g $CODEX_NPM_PACKAGE
YAML
    elif [ "$AUTH_MODE" = "claude" ]; then
      cat <<'YAML'

      - name: Install official Claude Code CLI
        run: |
          curl -fsSL https://claude.ai/install.sh | bash
          echo "$HOME/.local/bin" >> "$GITHUB_PATH"
YAML
    fi

    if [ "$AUTH_MODE" = "codex" ]; then
      cat <<'YAML'

      - name: Restore Codex OAuth config
        env:
          CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}
          CODEX_CONFIG_TOML: ${{ secrets.CODEX_CONFIG_TOML }}
YAML
      printf '          REVIEW_ROUTER_CODEX_AUTH_PERSISTENCE: %s\n' "$CODEX_AUTH_PERSISTENCE"
      cat <<'YAML'
        run: |
          test -n "$CODEX_AUTH_JSON"
          export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
          mkdir -p "$CODEX_HOME"
          chmod 700 "$CODEX_HOME"
          if [ "$REVIEW_ROUTER_CODEX_AUTH_PERSISTENCE" = "persistent" ] && [ -f "$CODEX_HOME/auth.json" ]; then
            echo "Using existing persistent Codex auth.json"
          else
            printf '%s' "$CODEX_AUTH_JSON" > "$CODEX_HOME/auth.json"
          fi
          chmod 600 "$CODEX_HOME/auth.json"
          node <<'NODE'
          const fs = require('node:fs');
          const codexHome = process.env.CODEX_HOME || `${process.env.HOME}/.codex`;
          const path = `${codexHome}/auth.json`;
          function fail(message) {
            console.error(`ReviewRouter Codex OAuth auth check failed: ${message}`);
            console.error('Fix: run `codex login` on a trusted machine, then rerun the ReviewRouter installer or update CODEX_AUTH_JSON to reseed auth.json.');
            process.exit(1);
          }
          let data;
          try {
            data = JSON.parse(fs.readFileSync(path, 'utf8'));
          } catch (error) {
            fail(`auth.json is not valid JSON (${error.message})`);
          }
          if (data.auth_mode !== 'chatgpt') fail('auth.json auth_mode must be chatgpt');
          if (!data.tokens || !data.tokens.refresh_token) fail('auth.json tokens.refresh_token is missing; reseed auth.json');
          NODE
          if [ -n "$CODEX_CONFIG_TOML" ]; then
            printf '%s' "$CODEX_CONFIG_TOML" > "$CODEX_HOME/config.toml"
            chmod 600 "$CODEX_HOME/config.toml"
          fi
YAML
    elif [ "$AUTH_MODE" = "openai" ]; then
      cat <<'YAML'

      - name: Validate OpenAI API key secret
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        run: |
          test -n "$OPENAI_API_KEY"
YAML
    elif [ "$AUTH_MODE" = "claude" ]; then
      cat <<'YAML'

      - name: Validate Claude Code OAuth token secret
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: |
          test -n "$CLAUDE_CODE_OAUTH_TOKEN"
YAML
    fi

    cat <<'YAML'

      - name: Run ReviewRouter
YAML
    printf '        uses: %s\n' "$ACTION_REF"

    cat <<'YAML'
        env:
          REVIEW_ROUTER_LEDGER_KEY: ${{ secrets.REVIEW_ROUTER_LEDGER_KEY }}
          REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN: ${{ secrets.REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN }}
YAML
    if [ "$AUTH_MODE" = "openai" ]; then
      cat <<'YAML'
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
YAML
    elif [ "$AUTH_MODE" = "claude" ]; then
      cat <<'YAML'
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
YAML
    elif [ "$AUTH_MODE" = "openrouter" ]; then
      cat <<'YAML'
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
YAML
    fi

    cat <<'YAML'
        with:
YAML
    if [ "$IDENTITY_MODE" = "app" ]; then
      cat <<'YAML'
          GITHUB_TOKEN: ${{ steps.app-token.outputs.token }}
YAML
    else
      cat <<'YAML'
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
YAML
    fi

    cat <<'YAML'
          PR_NUMBER: ${{ github.event.pull_request.number || inputs.pr_number }}
YAML

    cat <<YAML
          FAIL_ON_NO_HEALTHY_PROVIDERS: 'true'
          INLINE_MAX_COMMENTS: '$INLINE_MAX_COMMENTS'
          INLINE_MIN_SEVERITY: '$INLINE_MIN_SEVERITY'
          MIN_CONFIDENCE: '0.6'
          CONSENSUS_REQUIRED_FOR_CRITICAL: 'false'
          UPDATE_PR_DESCRIPTION: 'true'
          FAIL_ON_CRITICAL: '$FAIL_ON_CRITICAL'
          FAIL_ON_MAJOR: '$FAIL_ON_MAJOR'
          ENABLE_AST_ANALYSIS: '$ENABLE_AST_ANALYSIS'
          ENABLE_SECURITY: '$ENABLE_SECURITY'
          ENABLE_AI_DETECTION: 'false'
          LEARNING_ENABLED: 'false'
          GRAPH_ENABLED: '$GRAPH_ENABLED'
YAML

    if [ "$AUTH_MODE" = "codex" ] || [ "$AUTH_MODE" = "openai" ]; then
      cat <<'YAML'
          CODEX_MODEL: ${{ vars.REVIEW_CODEX_MODEL }}
          CODEX_REASONING_EFFORT: ${{ vars.REVIEW_CODEX_EFFORT || 'medium' }}
YAML
      cat <<YAML
          CODEX_HEALTHCHECK_MODE: 'binary'
          CODEX_AGENTIC_CONTEXT: 'true'
YAML
    elif [ "$AUTH_MODE" = "claude" ]; then
      cat <<'YAML'
          CLAUDE_MODEL: ${{ vars.REVIEW_CLAUDE_MODEL }}
YAML
    elif [ "$AUTH_MODE" = "openrouter" ]; then
      cat <<'YAML'
          REVIEW_PROVIDERS: ${{ vars.REVIEW_PROVIDERS }}
          SYNTHESIS_MODEL: ${{ vars.REVIEW_SYNTHESIS_MODEL }}
YAML
    fi
	  } > "$workflow_file"
}

write_interaction_workflow() {
  workflow_file="$1"
  if [ "$WORKFLOW_STYLE" = "reusable" ]; then
    write_reusable_interaction_workflow "$workflow_file"
    return
  fi
  repo_name_value="$(repo_name "$TARGET_REPO")"
  mkdir -p "$(dirname "$workflow_file")"

  {
    cat <<'YAML'
name: ReviewRouter Interaction

on:
  pull_request_review_comment:
    types: [created, edited]

permissions:
  actions: write
  contents: read
  issues: write
  pull-requests: write

concurrency:
  group: review-router-interaction-${{ github.event.pull_request.number || github.event.comment.id }}
  cancel-in-progress: false

jobs:
  interaction:
YAML
    printf '    runs-on: %s\n' "$RUNS_ON"
    cat <<'YAML'
    timeout-minutes: 10
    steps:
YAML

    if [ "$IDENTITY_MODE" = "app" ]; then
      cat <<'YAML'
      - name: Create review GitHub App token
        id: app-token
        uses: actions/create-github-app-token@v3
        with:
          client-id: ${{ vars.REVIEW_APP_CLIENT_ID }}
          private-key: ${{ secrets.REVIEW_APP_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}
YAML
      printf '          repositories: %s\n' "$repo_name_value"
      cat <<'YAML'
          permission-actions: write
          permission-contents: read
          permission-issues: write
          permission-pull-requests: write
YAML
    fi

    cat <<'YAML'
      - name: Preflight ReviewRouter interaction
        id: preflight
YAML
    printf '        uses: %s\n' "$ACTION_REF"
    cat <<'YAML'
        with:
          REVIEW_ROUTER_MODE: interaction-preflight
          REVIEW_ROUTER_DISCUSSION_MODE: ${{ vars.REVIEW_ROUTER_DISCUSSION_MODE }}
YAML
    if [ "$IDENTITY_MODE" = "app" ]; then
      cat <<'YAML'
          GITHUB_TOKEN: ${{ steps.app-token.outputs.token }}
YAML
    else
      cat <<'YAML'
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
YAML
    fi

    if [ "$AUTH_MODE" = "codex" ] || [ "$AUTH_MODE" = "openai" ]; then
      cat <<YAML

      - uses: actions/setup-node@v6
        if: steps.preflight.outputs.needs_discussion == 'true'
        with:
          node-version: '24'

      - name: Install official Codex CLI for discussion replies
        if: steps.preflight.outputs.needs_discussion == 'true'
        run: npm install -g $CODEX_NPM_PACKAGE
YAML
    fi

    if [ "$AUTH_MODE" = "codex" ]; then
      cat <<'YAML'

      - name: Restore Codex OAuth config for discussion replies
        if: steps.preflight.outputs.needs_discussion == 'true'
        env:
          CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}
          CODEX_CONFIG_TOML: ${{ secrets.CODEX_CONFIG_TOML }}
YAML
      printf '          REVIEW_ROUTER_CODEX_AUTH_PERSISTENCE: %s\n' "$CODEX_AUTH_PERSISTENCE"
      cat <<'YAML'
        run: |
          test -n "$CODEX_AUTH_JSON"
          export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
          mkdir -p "$CODEX_HOME"
          chmod 700 "$CODEX_HOME"
          if [ "$REVIEW_ROUTER_CODEX_AUTH_PERSISTENCE" = "persistent" ] && [ -f "$CODEX_HOME/auth.json" ]; then
            echo "Using existing persistent Codex auth.json"
          else
            printf '%s' "$CODEX_AUTH_JSON" > "$CODEX_HOME/auth.json"
          fi
          chmod 600 "$CODEX_HOME/auth.json"
          node <<'NODE'
          const fs = require('node:fs');
          const codexHome = process.env.CODEX_HOME || `${process.env.HOME}/.codex`;
          const path = `${codexHome}/auth.json`;
          function fail(message) {
            console.error(`ReviewRouter Codex OAuth auth check failed: ${message}`);
            console.error('Fix: run `codex login` on a trusted machine, then rerun the ReviewRouter installer or update CODEX_AUTH_JSON to reseed auth.json.');
            process.exit(1);
          }
          let data;
          try {
            data = JSON.parse(fs.readFileSync(path, 'utf8'));
          } catch (error) {
            fail(`auth.json is not valid JSON (${error.message})`);
          }
          if (data.auth_mode !== 'chatgpt') fail('auth.json auth_mode must be chatgpt');
          if (!data.tokens || !data.tokens.refresh_token) fail('auth.json tokens.refresh_token is missing; reseed auth.json');
          NODE
          if [ -n "$CODEX_CONFIG_TOML" ]; then
            printf '%s' "$CODEX_CONFIG_TOML" > "$CODEX_HOME/config.toml"
            chmod 600 "$CODEX_HOME/config.toml"
          fi
YAML
    fi

    cat <<'YAML'

      - name: Handle ReviewRouter interaction
        if: steps.preflight.outputs.should_run == 'true'
YAML
    printf '        uses: %s\n' "$ACTION_REF"
    cat <<'YAML'
        env:
          REVIEW_ROUTER_LEDGER_KEY: ${{ secrets.REVIEW_ROUTER_LEDGER_KEY }}
YAML
    if [ "$AUTH_MODE" = "openai" ]; then
      cat <<'YAML'
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
YAML
    fi
    cat <<'YAML'
        with:
          REVIEW_ROUTER_MODE: interaction
          REVIEW_ROUTER_DISCUSSION_MODE: ${{ vars.REVIEW_ROUTER_DISCUSSION_MODE }}
          REVIEW_ROUTER_DISCUSSION_TIMEOUT_SECONDS: '60'
          REVIEW_ROUTER_REVIEW_WORKFLOW_FILE: reviewrouter.yml
          REVIEW_ROUTER_ALLOW_AUTHOR_SKIP: 'false'
YAML
    if [ "$IDENTITY_MODE" = "app" ]; then
      cat <<'YAML'
          GITHUB_TOKEN: ${{ steps.app-token.outputs.token }}
YAML
    else
      cat <<'YAML'
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
YAML
    fi
    if [ "$AUTH_MODE" = "codex" ] || [ "$AUTH_MODE" = "openai" ]; then
      cat <<'YAML'
          CODEX_MODEL: ${{ vars.REVIEW_CODEX_MODEL }}
          CODEX_REASONING_EFFORT: ${{ vars.REVIEW_CODEX_EFFORT || 'medium' }}
YAML
    fi
  } > "$workflow_file"
}

required_secret_names() {
  printf '%s\n' REVIEW_ROUTER_LEDGER_KEY
  case "$AUTH_MODE" in
    codex) printf '%s\n' CODEX_AUTH_JSON ;;
    claude) printf '%s\n' CLAUDE_CODE_OAUTH_TOKEN ;;
    openai) printf '%s\n' OPENAI_API_KEY ;;
    openrouter) printf '%s\n' OPENROUTER_API_KEY ;;
  esac
  if [ "$IDENTITY_MODE" = "app" ]; then
    printf '%s\n' REVIEW_APP_PRIVATE_KEY
  fi
}

required_variable_names() {
  printf '%s\n' REVIEW_AUTH_MODE REVIEW_ROUTER_DISCUSSION_MODE
  case "$AUTH_MODE" in
    codex|openai) printf '%s\n' REVIEW_CODEX_MODEL REVIEW_CODEX_EFFORT ;;
    claude) printf '%s\n' REVIEW_CLAUDE_MODEL ;;
    openrouter) printf '%s\n' REVIEW_PROVIDERS REVIEW_SYNTHESIS_MODEL ;;
  esac
  if [ "$IDENTITY_MODE" = "app" ]; then
    printf '%s\n' REVIEW_APP_CLIENT_ID REVIEW_APP_ID REVIEW_APP_SLUG
  fi
}

run_setup_doctor() {
  log ""
  info "ReviewRouter doctor"
  [ -f "$WORKDIR/$WORKFLOW_PATH" ] || fatal "Doctor failed: missing $WORKFLOW_PATH"
  [ -f "$WORKDIR/$INTERACTION_WORKFLOW_PATH" ] || fatal "Doctor failed: missing $INTERACTION_WORKFLOW_PATH"
  ok "Workflow files are present"

  if ! can_run_remote_checks; then
    warn "Skipping remote secret/variable doctor in dry-run/local-only mode"
    return
  fi

  missing_items=""
  while IFS= read -r secret_name; do
    [ -n "$secret_name" ] || continue
    if secret_exists "$secret_name"; then
      ok "Secret exists: $secret_name"
    else
      missing_items="$missing_items secret:$secret_name"
    fi
  done <<EOF
$(required_secret_names)
EOF

  while IFS= read -r variable_name; do
    [ -n "$variable_name" ] || continue
    if variable_exists "$variable_name"; then
      ok "Variable exists: $variable_name"
    else
      missing_items="$missing_items variable:$variable_name"
    fi
  done <<EOF
$(required_variable_names)
EOF

  [ -z "$missing_items" ] || fatal "Doctor failed: missing required GitHub configuration:$missing_items"
  ok "Required GitHub secrets and variables are present"
}

print_setup_summary() {
  log ""
  log "${BOLD}Setup summary${NC}"
  log "Repository: $TARGET_REPO"
  log "Action ref: $ACTION_REF"
  log "Identity: $IDENTITY_MODE"
  if [ "$IDENTITY_MODE" = "app" ]; then
    log "GitHub App: ${APP_SLUG:-unknown}[bot]"
  fi
  log "Auth mode: $AUTH_MODE"
  log "Preset: $PRESET"
  log "Runner: $RUNS_ON"
  if [ "$AUTH_MODE" = "codex" ]; then
    log "Codex auth persistence: $CODEX_AUTH_PERSISTENCE"
  fi
  if [ "$SECRET_SCOPE" = "org" ]; then
    log "Secrets/vars: org $ORG_NAME, selected repos: $ORG_SELECTED_REPOS"
  else
    log "Secrets/vars: repo $TARGET_REPO"
  fi
  log "Workflows: $WORKFLOW_PATH, $INTERACTION_WORKFLOW_PATH"
}

prepare_worktree() {
  if is_true "$LOCAL_ONLY"; then
    if [ -n "$WORKDIR_OVERRIDE" ]; then
      WORKDIR="$WORKDIR_OVERRIDE"
    else
      WORKDIR="$(pwd)"
    fi
    mkdir -p "$WORKDIR"
    return
  fi

  WORKDIR="$(mktemp -d)"
  if is_true "$DRY_RUN" || is_true "$SKIP_GH_CHECK"; then
    log "[dry-run] would clone $TARGET_REPO into $WORKDIR"
    mkdir -p "$WORKDIR"
    return
  fi

  if current_repo_root="$(current_checkout_for_target_repo)"; then
    default_branch="$(gh repo view "$TARGET_REPO" --json defaultBranchRef -q .defaultBranchRef.name)"
    tmp_parent="$(mktemp -d)"
    WORKDIR="$tmp_parent/worktree"
    WORKDIR_IS_GIT_WORKTREE=1
    WORKDIR_SOURCE_REPO="$current_repo_root"
    info "Using current checkout at $current_repo_root to create a temporary setup worktree"
    (
      cd "$current_repo_root"
      git fetch origin "refs/heads/$default_branch:refs/remotes/origin/$default_branch" --depth=1 >/dev/null 2>&1 || git fetch origin "$default_branch" --depth=1 >/dev/null
      git fetch origin "refs/heads/$INSTALL_BRANCH:refs/remotes/origin/$INSTALL_BRANCH" --depth=1 >/dev/null 2>&1 || true
      git worktree add --detach "$WORKDIR" "origin/$default_branch" >/dev/null
      cd "$WORKDIR"
      git checkout -B "$INSTALL_BRANCH" "origin/$default_branch" >/dev/null 2>&1 || git checkout -B "$INSTALL_BRANCH" >/dev/null
    )
    return
  fi

  info "Cloning $TARGET_REPO into a temporary worktree"
  gh repo clone "$TARGET_REPO" "$WORKDIR" -- --depth=1 >/dev/null
  default_branch="$(gh repo view "$TARGET_REPO" --json defaultBranchRef -q .defaultBranchRef.name)"
  (
    cd "$WORKDIR"
    git fetch origin "refs/heads/$INSTALL_BRANCH:refs/remotes/origin/$INSTALL_BRANCH" --depth=1 >/dev/null 2>&1 || true
    git checkout -B "$INSTALL_BRANCH" "origin/$default_branch" >/dev/null 2>&1 || git checkout -B "$INSTALL_BRANCH" >/dev/null
  )
}

cleanup_worktree() {
  if [ "${WORKDIR_IS_GIT_WORKTREE:-0}" = "1" ] && [ -n "${WORKDIR_SOURCE_REPO:-}" ] && [ -n "${WORKDIR:-}" ]; then
    git -C "$WORKDIR_SOURCE_REPO" worktree remove --force "$WORKDIR" >/dev/null 2>&1 || true
    rmdir "$(dirname "$WORKDIR")" >/dev/null 2>&1 || true
  fi
}

commit_and_open_pr() {
  if is_true "$LOCAL_ONLY"; then
    ok "Workflows written locally to $WORKDIR/$WORKFLOW_PATH and $WORKDIR/$INTERACTION_WORKFLOW_PATH"
    return
  fi

  if is_true "$DRY_RUN" || is_true "$SKIP_GH_CHECK"; then
    log "[dry-run] would commit $WORKFLOW_PATH and $INTERACTION_WORKFLOW_PATH on branch $INSTALL_BRANCH and open a PR"
    return
  fi

  default_branch="$(gh repo view "$TARGET_REPO" --json defaultBranchRef -q .defaultBranchRef.name)"
  (
    cd "$WORKDIR"
	    git add "$WORKFLOW_PATH" "$INTERACTION_WORKFLOW_PATH"
    if git diff --cached --quiet; then
      exit 42
    fi
    git config user.name "review-router installer"
    git config user.email "review-router@example.invalid"
    git commit -m "ci: add review-router" >/dev/null
    if expected_sha="$(git rev-parse "refs/remotes/origin/$INSTALL_BRANCH" 2>/dev/null)"; then
      git push -u origin "$INSTALL_BRANCH" --force-with-lease="refs/heads/$INSTALL_BRANCH:$expected_sha" >/dev/null
    else
      git push -u origin "$INSTALL_BRANCH" >/dev/null
    fi
  ) || {
    status=$?
    if [ "$status" -eq 42 ]; then
      ok "Workflow already up to date; no PR needed"
      return
    fi
    exit "$status"
  }

  owner="$(repo_owner "$TARGET_REPO")"
  pr_body="Adds ReviewRouter pull request automation. Installer mode: identity=$IDENTITY_MODE, auth=$AUTH_MODE, preset=$PRESET, workflow=$WORKFLOW_STYLE."
  existing_pr_url="$(gh api --method GET "repos/$TARGET_REPO/pulls" \
    -f state=open \
    -f "head=$owner:$INSTALL_BRANCH" \
    --jq '.[0].html_url // empty')"
  if [ -n "$existing_pr_url" ]; then
    ok "Setup PR already exists for branch $INSTALL_BRANCH: $existing_pr_url"
  else
    pr_url="$(gh api --method POST "repos/$TARGET_REPO/pulls" \
      -f title="ci: add review-router" \
      -f head="$INSTALL_BRANCH" \
      -f base="$default_branch" \
      -f body="$pr_body" \
      --jq '.html_url')"
    ok "Opened setup PR for $TARGET_REPO: $pr_url"
  fi
}

main() {
  log "${BOLD}ReviewRouter installer${NC}"
  check_prerequisites
  detect_repo

  normalize_secret_scope_env
  if [ -z "$ACTION_REF_EXPLICIT" ] && [ -z "$ACTION_REF_MODE" ]; then
    choose ACTION_REF_MODE "Action version" "$DEFAULT_ACTION_REF_MODE" \
      "main:Live main branch, gets every update immediately" \
      "stable:Stable major tag ($LATEST_MAJOR_TAG), updated only when the moving tag is advanced" \
      "release:Pinned exact release tag ($LATEST_RELEASE_TAG), maximum reproducibility"
  fi
  resolve_action_ref
  case "$WORKFLOW_STYLE" in
    reusable|explicit) ;;
    *) fatal "Unsupported REVIEW_ROUTER_WORKFLOW_STYLE: $WORKFLOW_STYLE. Use reusable or explicit." ;;
  esac
  validate_action_ref_for_workflow_style
  choose SECRET_SCOPE "Secrets and variables scope" "repo" \
    "repo:Store secrets and variables on the target repository" \
    "org:Store secrets and variables on the organization, restricted to selected repositories"
  choose IDENTITY_MODE "Comment identity" "app" \
    "app:GitHub App bot identity, better audit, creates user-owned App" \
    "actions:Default github-actions[bot], fastest setup, no App"
  choose AUTH_MODE "Model authentication" "codex" \
    "codex:Codex CLI with ChatGPT subscription OAuth from local auth.json" \
    "claude:Claude Code CLI with Claude subscription OAuth from claude setup-token" \
    "openai:Codex CLI with OpenAI API key secret" \
    "openrouter:OpenRouter API key with preferred free OpenRouter models"
  choose PRESET "Review preset" "safe" \
    "safe:Balanced defaults, major+ inline comments" \
    "blocking:Safe review depth, but fail CI on major+ findings" \
    "strict:More comments and graph context" \
    "minimal:Fewer comments and less analysis"
  validate_codex_auth_persistence "$CODEX_AUTH_PERSISTENCE"

  log ""
  setup_secret_scope
  info "Target repo: $TARGET_REPO"
  if [ "$SECRET_SCOPE" = "org" ]; then
    info "Secret scope: org $ORG_NAME, selected repos: $ORG_SELECTED_REPOS"
  else
    info "Secret scope: repo $TARGET_REPO"
  fi
  info "Identity: $IDENTITY_MODE"
  info "Auth mode: $AUTH_MODE"
  info "Preset: $PRESET"
  info "Action ref: $ACTION_REF"
  info "Workflow style: $WORKFLOW_STYLE"

  run_security_advisory
  setup_identity
  setup_auth
  setup_ledger_secret
  prepare_worktree
  write_workflow "$WORKDIR/$WORKFLOW_PATH"
  write_interaction_workflow "$WORKDIR/$INTERACTION_WORKFLOW_PATH"
  run_setup_doctor
  commit_and_open_pr
  cleanup_worktree

  log ""
  ok "ReviewRouter setup complete"
  print_setup_summary
  log "Docs: https://github.com/777genius/review-router/blob/main/docs/install.md"
}

main "$@"
