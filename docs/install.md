# ReviewRouter installer

ReviewRouter can be installed into any GitHub repository with a single `curl | bash` command. The installer writes a pull request workflow, stores the required repository secrets/variables, and opens a setup PR instead of pushing directly to the default branch.

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/review-router/main/scripts/install.sh | bash
```

The installer supports macOS and Linux shells first. It requires `gh`, `git`, and `curl`. GitHub App manifest setup uses `python3` when available; without `python3`, the installer prints manual App setup instructions.

The generated workflow uses the live main branch by default:

```text
777genius/review-router@main
```

Use `REVIEW_ROUTER_ACTION_REF_MODE=stable` if you want the moving major tag `777genius/review-router@v1`. Use `REVIEW_ROUTER_ACTION_REF_MODE=release` if you want the exact latest release tag pinned at install time, currently `777genius/review-router@v1.0.80`. Use `REVIEW_ROUTER_ACTION_REF=owner/repo@ref` for a custom fork or exact commit SHA.

## Quick start

### One repository

Fast setup for a single repository. Secrets and variables are stored on that repository only.

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/review-router/main/scripts/install.sh | env \
  REVIEW_ROUTER_REPO=owner/repo \
  REVIEW_ROUTER_SECRET_SCOPE=repo \
  REVIEW_ROUTER_IDENTITY=actions \
  REVIEW_ROUTER_AUTH=codex \
  REVIEW_ROUTER_PRESET=safe \
  bash
```

Use `REVIEW_ROUTER_IDENTITY=app` instead of `actions` if you want comments from a dedicated GitHub App bot instead of `github-actions[bot]`.

### Organization selected repositories

Recommended team setup. Secrets and variables live at organization level, but only selected repositories can access them.

For smoke tests, use a disposable test organization/repository or `REVIEW_ROUTER_DRY_RUN=1`. Do not test org-level secrets against a production organization unless you intend to store real secrets there.

```bash
gh auth refresh -s admin:org

curl -fsSL https://raw.githubusercontent.com/777genius/review-router/main/scripts/install.sh | env \
  REVIEW_ROUTER_REPO=your-org/repo-a \
  REVIEW_ROUTER_SECRET_SCOPE=org \
  REVIEW_ROUTER_ORG=your-org \
  REVIEW_ROUTER_ORG_SECRET_REPOS=repo-a,repo-b \
  REVIEW_ROUTER_IDENTITY=app \
  REVIEW_ROUTER_AUTH=codex \
  REVIEW_ROUTER_PRESET=safe \
  bash
```

This uses `gh secret set --org your-org --repos repo-a,repo-b --app actions`, not `--visibility all`.

To run a real org e2e smoke test against a disposable organization without granting `delete_repo`:

```bash
gh auth refresh -s admin:org
REVIEW_ROUTER_E2E_ORG=your-test-org REVIEW_ROUTER_E2E_SKIP_DELETE=1 bash scripts/e2e-org-installer-smoke.sh
```

The smoke script creates a temporary private repo, installs org-level selected-repo secrets/variables, verifies `visibility=selected` and `numSelectedRepos=1`, verifies the setup PR/workflow, then deletes the smoke secrets/variables. With `REVIEW_ROUTER_E2E_SKIP_DELETE=1`, it leaves the temporary repo for manual deletion so the CLI does not need `delete_repo`.

To verify reruns do not duplicate inline comments on a disposable smoke repository:

```bash
REVIEW_ROUTER_E2E_REPO=owner/repo bash scripts/e2e-rerun-dedup-smoke.sh
```

The script opens a temporary PR with a known review fixture, waits for the first review, pushes an empty commit, waits for the rerun, and fails if the inline comment count increases.

### API key instead of Codex OAuth

For teams that do not want to store a personal Codex OAuth session:

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/review-router/main/scripts/install.sh | env \
  REVIEW_ROUTER_REPO=owner/repo \
  REVIEW_ROUTER_SECRET_SCOPE=repo \
  REVIEW_ROUTER_IDENTITY=actions \
  REVIEW_ROUTER_AUTH=openai \
  REVIEW_ROUTER_OPENAI_API_KEY=sk-... \
  REVIEW_ROUTER_PRESET=safe \
  bash
```

### Claude Code subscription OAuth

```bash
claude setup-token

curl -fsSL https://raw.githubusercontent.com/777genius/review-router/main/scripts/install.sh | env \
  REVIEW_ROUTER_REPO=owner/repo \
  REVIEW_ROUTER_SECRET_SCOPE=repo \
  REVIEW_ROUTER_IDENTITY=actions \
  REVIEW_ROUTER_AUTH=claude \
  REVIEW_ROUTER_CLAUDE_CODE_OAUTH_TOKEN=your-token \
  REVIEW_ROUTER_CLAUDE_MODEL=sonnet \
  REVIEW_ROUTER_PRESET=safe \
  bash
```

### Stable or release refs

The compact reusable workflow needs reusable workflow files to exist in the selected ref. The default `main` ref is the recommended install path because it receives reviewer fixes immediately. If you choose `REVIEW_ROUTER_ACTION_REF_MODE=stable` or `release` with compact reusable before that release has reusable workflow files, the installer stops with a clear error instead of creating a broken workflow.

Use this only when you deliberately want to pin the full explicit workflow to the latest release:

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/review-router/main/scripts/install.sh | env \
  REVIEW_ROUTER_REPO=owner/repo \
  REVIEW_ROUTER_WORKFLOW_STYLE=explicit \
  REVIEW_ROUTER_ACTION_REF_MODE=release \
  REVIEW_ROUTER_SECRET_SCOPE=repo \
  REVIEW_ROUTER_IDENTITY=actions \
  REVIEW_ROUTER_AUTH=codex \
  REVIEW_ROUTER_PRESET=safe \
  bash
```

This is the default and keeps every workflow run on the newest reviewer code from `main`:

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/review-router/main/scripts/install.sh | env \
  REVIEW_ROUTER_REPO=owner/repo \
  REVIEW_ROUTER_ACTION_REF_MODE=main \
  REVIEW_ROUTER_SECRET_SCOPE=repo \
  REVIEW_ROUTER_IDENTITY=actions \
  REVIEW_ROUTER_AUTH=codex \
  REVIEW_ROUTER_PRESET=safe \
  bash
```

## What it creates

- `.github/workflows/reviewrouter.yml`
- `.github/workflows/reviewrouter-interaction.yml`
- Repository or organization variables such as `REVIEW_CODEX_MODEL`, `REVIEW_AUTH_MODE`, or OpenRouter provider variables
- Repository or organization secrets for the selected auth mode
- Branch `review-router/setup`
- A setup PR with the workflow change

Secrets are never deleted automatically. Existing secrets and variables are overwritten only after confirmation.

## Installer Doctor

The installer runs a doctor check before opening the setup PR.

It verifies:

- workflow files were written
- required secrets and variables exist in the selected repo/org scope
- GitHub App profiles match their private key
- GitHub App mode has required permissions: `Actions: write`, `Contents: read`, `Issues: write`, `Pull requests: write`
- the selected App is installed on the target repository

If you intentionally need to bypass App validation for a temporary/manual setup, use:

```bash
REVIEW_ROUTER_SKIP_APP_DOCTOR=1
```

Do not use this for production rollout. Without `Actions: write`, `/rr skip` can record the signed ledger but cannot rerun the failed review check automatically.

## Security advisory

The installer prints a security advisory before writing workflows.

It always reminds you that generated workflows:

- use `pull_request`, not `pull_request_target`
- skip fork PR secret-backed review by default
- keep `/rr skip` handling in a separate workflow

When GitHub API access is available, it also checks:

- whether the target repository is public while using Codex OAuth
- whether the default branch has branch protection
- whether a CODEOWNERS file exists
- whether CODEOWNERS appears to cover `.github/workflows/**`

These checks are warnings, not hard blockers. The main risk is not that collaborators can read Actions secrets in the GitHub UI. The practical risk is workflow-code access: anyone who can get a malicious workflow merged into a repository or push a same-repository branch where secrets are available can try to exfiltrate secrets during CI.

## Secret scopes

| Scope  | Where secrets live                     | Repository access          | Best for                                                               |
| ------ | -------------------------------------- | -------------------------- | ---------------------------------------------------------------------- |
| `repo` | Target repository                      | Target repository only     | Simple setup, personal repos, small private repos                      |
| `org`  | Organization Actions secrets/variables | Selected repositories only | Teams that want one central secret with explicit repository allow-list |

`org` scope always uses selected repositories. It does not grant access to every repository in the organization.

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/review-router/main/scripts/install.sh | env \
  REVIEW_ROUTER_REPO=your-org/repo-a \
  REVIEW_ROUTER_SECRET_SCOPE=org \
  REVIEW_ROUTER_ORG=your-org \
  REVIEW_ROUTER_ORG_SECRET_REPOS=repo-a,repo-b \
  bash
```

If `REVIEW_ROUTER_ORG_SECRET_REPOS` is not set, the installer grants access only to the target repo name from `REVIEW_ROUTER_REPO`.

Managing organization secrets with `gh` requires organization-owner permissions and the `admin:org` OAuth scope:

```bash
gh auth refresh -s admin:org
```

Security note: org-level selected-repo secrets reduce sprawl and make rotation easier, but any workflow in an allowed repository can still access the secret. Protect `.github/workflows/**` with CODEOWNERS/reviews for repositories that can access Codex OAuth.

Repository collaborators normally cannot read Actions secret values in the GitHub UI. The practical risk is workflow-code access: anyone who can modify a workflow on a branch where secrets are available can try to exfiltrate secrets in CI. For Codex OAuth, use one of these controls:

- Prefer org-level selected-repository secrets for teams, scoped only to the repositories that need review.
- Protect `.github/workflows/**` with CODEOWNERS and required reviews.
- Skip secret-backed review for fork PRs, which the installer does by default.
- Use OpenAI API-key mode for shared team automation if you do not want to store a personal ChatGPT OAuth session.

## Identity modes

| Mode                  | Comment author              | Best for                                                    | Tradeoff                                                              |
| --------------------- | --------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `GitHub App bot`      | `review-router-... [bot]` | Production repos, cleaner audit trail, branded bot identity | Creates a user-owned GitHub App and requires installation on the repo |
| `github-actions[bot]` | `github-actions[bot]`       | Fast setup, tests, small teams                              | Default name/avatar, weaker identity/audit separation                 |

Recommendation:

- Use `GitHub App bot` for production repositories.
- Use `github-actions[bot]` when you want the simplest setup and do not care about comment branding.

### GitHub App setup modes

When `REVIEW_ROUTER_IDENTITY=app`, the installer asks how to configure the App credentials:

| Mode     | Behavior                                                                                 |
| -------- | ---------------------------------------------------------------------------------------- |
| `create` | Creates a new user-owned GitHub App through the manifest flow and saves a local profile. |
| `saved`  | Reuses a local profile previously created or imported by this installer. Hidden in interactive setup until a local profile exists. |
| `manual` | Imports an existing App ID, Client ID, slug, and `.pem`, then saves a local reusable profile. |

Local profiles are stored under `~/.config/review-router/apps` by default. Override this with `REVIEW_ROUTER_APP_PROFILE_DIR`.

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/review-router/main/scripts/install.sh | env \
  REVIEW_ROUTER_REPO=owner/repo \
  REVIEW_ROUTER_IDENTITY=app \
  REVIEW_ROUTER_APP_SETUP=saved \
  REVIEW_ROUTER_APP_PROFILE=review-router-owner-repo \
  REVIEW_ROUTER_AUTH=codex \
  REVIEW_ROUTER_PRESET=safe \
  bash
```

To import an existing App without using the browser manifest flow:

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/review-router/main/scripts/install.sh | env \
  REVIEW_ROUTER_REPO=owner/repo \
  REVIEW_ROUTER_IDENTITY=app \
  REVIEW_ROUTER_APP_SETUP=manual \
  REVIEW_ROUTER_APP_CLIENT_ID=Iv1... \
  REVIEW_ROUTER_APP_ID=123456 \
  REVIEW_ROUTER_APP_SLUG=review-router-owner \
  REVIEW_ROUTER_APP_PRIVATE_KEY_FILE=/path/to/private-key.pem \
  REVIEW_ROUTER_AUTH=codex \
  REVIEW_ROUTER_PRESET=safe \
  bash
```

GitHub does not let the installer download an existing GitHub App private key. Keep the `.pem` file from App creation, or generate a new private key in the App settings before using `manual`.

If no local profiles exist yet, the interactive installer shows only `create` and `manual`. Use `manual` when you already have a GitHub App and a private key file. After that import, future installs on this machine can use `saved`.

After App creation/import, the installer verifies that the App can access the target repository. If the App is not installed on that repository yet, it prints the `https://github.com/apps/<slug>/installations/new` link and lets you retry the check instead of writing a broken workflow.

Optional App logo setup:

- Open `https://github.com/settings/apps/<slug>`.
- Upload the ReviewRouter logo: `https://i.imgur.com/Yz9XIQM.png`.
- Recommended format: PNG/JPG/GIF under 1 MB, 200x200.

The installer prints these links after `create` and `manual` App setup. GitHub does not currently let the manifest flow set the App avatar automatically, so this remains a manual upload step.

## Auth modes

### Codex ChatGPT subscription

Uses the local Codex CLI OAuth session and stores it in the target repo as `CODEX_AUTH_JSON`.

ReviewRouter detects both Codex auth layouts:

- legacy `~/.codex/auth.json`
- active account auth from `~/.codex/accounts/registry.json` plus `~/.codex/accounts/*.auth.json`

By default, the installer does not copy `~/.codex/config.toml`. Local Codex config can contain plugins, hooks, or UI-specific settings that are noisy and expensive in CI. If you intentionally need it, opt in:

```bash
REVIEW_ROUTER_INCLUDE_CODEX_CONFIG=1 bash scripts/install.sh
```

The generated workflow installs the official Codex CLI and restores OAuth credentials before review. It does not run a separate headless smoke prompt by default because that would consume an extra Codex subscription request on every PR run and rerun.

```yaml
- name: Restore Codex OAuth config
  env:
    CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}
    REVIEW_ROUTER_CODEX_AUTH_PERSISTENCE: secret
  run: |
    test -n "$CODEX_AUTH_JSON"
    export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
    mkdir -p "$CODEX_HOME"
    chmod 700 "$CODEX_HOME"
    printf '%s' "$CODEX_AUTH_JSON" > "$CODEX_HOME/auth.json"
    chmod 600 "$CODEX_HOME/auth.json"
```

ReviewRouter uses a binary-only Codex health check by default. The real review call is the authoritative auth/model check. If you explicitly want an extra model-exec health check, set `CODEX_HEALTHCHECK_MODE=exec`, but expect higher subscription usage.

Use this only in trusted automation. Do not put personal Codex OAuth credentials into public/open-source repos where untrusted workflow changes can access secrets. GitHub does not expose repository secrets to fork PR workflows by default, and the generated workflow skips fork PRs by default.

Important auth freshness note: on GitHub-hosted runners, the runner filesystem is ephemeral. Codex can refresh the restored auth file during a run, but ReviewRouter cannot safely write the refreshed file back to GitHub Actions secrets automatically. If the stored secret becomes stale or a refresh token is rotated, run `codex login` again on a trusted machine and rerun the installer or update `CODEX_AUTH_JSON`. For fully automatic long-running auth, prefer an OpenAI API key or a trusted self-hosted runner with persistent `CODEX_HOME`.

For trusted self-hosted runners, you can let Codex maintain the refreshed file on disk:

```bash
REVIEW_ROUTER_RUNS_ON=self-hosted \
REVIEW_ROUTER_CODEX_AUTH_PERSISTENCE=persistent \
bash scripts/install.sh
```

`persistent` mode seeds `auth.json` only when the file is missing. Later runs reuse the refreshed file. This only helps when `CODEX_HOME` survives between jobs; it does not make GitHub-hosted runners persistent.

Default Codex model:

```text
gpt-5.6-sol
```

The installer stores it as `REVIEW_CODEX_MODEL`, and the action converts it internally to `codex/<model>`. Override it with `REVIEW_ROUTER_CODEX_MODEL`, for example `REVIEW_ROUTER_CODEX_MODEL=gpt-5.4`.

Codex reasoning effort is stored as `REVIEW_CODEX_EFFORT`. Presets choose a default effort, and you can override it with `REVIEW_ROUTER_CODEX_EFFORT=low|medium|high|xhigh`.

### OpenAI API key

Stores `OPENAI_API_KEY` and uses the Codex CLI in API-key mode. This is better for shared/team automation when you do not want to store a personal ChatGPT OAuth session.

### Claude Code subscription OAuth

Stores `CLAUDE_CODE_OAUTH_TOKEN` and uses the official Claude Code CLI with a Claude Pro, Max, Team, or Enterprise subscription.

Generate the token locally from a trusted machine where Claude Code is logged in:

```bash
claude setup-token
```

The command prints a one-year OAuth token and does not save it. Give that value to the installer with `REVIEW_ROUTER_CLAUDE_CODE_OAUTH_TOKEN`, or set the GitHub Actions secret manually. The secret value must be only the token, not a copied `gh secret set` command.

```bash
REVIEW_ROUTER_AUTH=claude \
REVIEW_ROUTER_CLAUDE_CODE_OAUTH_TOKEN=your-token \
bash scripts/install.sh
```

Default Claude model:

```text
sonnet
```

Override it with `REVIEW_ROUTER_CLAUDE_MODEL`, for example `REVIEW_ROUTER_CLAUDE_MODEL=claude-sonnet-4-6`.

Implementation note: ReviewRouter uses `claude -p` and intentionally does not use `--bare`, because Claude Code bare mode does not read `CLAUDE_CODE_OAUTH_TOKEN`.

### OpenRouter API key

Stores `OPENROUTER_API_KEY` and configures OpenRouter provider mode.

### Optional lifecycle resolve token

By default, ReviewRouter tries to resolve old ReviewRouter review threads with
the same token used for comments, then the workflow token. Some GitHub setups
reject `resolveReviewThread` for integration tokens with `Resource not accessible
by integration`.

If you want auto-close in that setup, add an optional repository or org secret:

```text
REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN
```

The generated workflows pass it only to the review job. ReviewRouter uses it
only for the final review-thread resolve mutation after provider quorum and
freshness checks. It is not used for comments, summaries, or provider calls.

## Review presets

| Preset    | Behavior                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------- |
| `safe`    | Major+ inline comments, max 5 inline comments, one Codex model, AST and security enabled, Codex effort `medium` |
| `blocking` | Same review depth as `safe`, but fails CI on Major+ findings |
| `strict`  | Minor+ inline comments, max 10 inline comments, one Codex model, graph context enabled, Codex effort `high` |
| `minimal` | Major+ inline comments, max 3 inline comments, AST disabled, security enabled, Codex effort `low` |

Safe defaults include:

```text
INLINE_MAX_COMMENTS=5
INLINE_MIN_SEVERITY=major
MIN_CONFIDENCE=0.6
CONSENSUS_REQUIRED_FOR_CRITICAL=false
FAIL_ON_NO_HEALTHY_PROVIDERS=true
FAIL_ON_CRITICAL=true
FAIL_ON_MAJOR=false
UPDATE_PR_DESCRIPTION=true
PROVIDER_MAX_PARALLEL=1
CODEX_REASONING_EFFORT=medium
CODEX_AGENTIC_CONTEXT=true
REVIEW_ROUTER_DISCUSSION_MODE=suggest
REVIEW_ROUTER_LEDGER_KEY=<generated secret>
REVIEW_CODEX_MODEL=gpt-5.6-sol
REVIEW_CODEX_EFFORT=medium
```

`CODEX_AGENTIC_CONTEXT=true` lets Codex inspect related repository files in a read-only sandbox before returning strict JSON findings. It does not grant write access.

`UPDATE_PR_DESCRIPTION=true` appends or updates only the `ReviewRouter` generated block in the pull request body. Author-written PR text stays above the generated block. `FAIL_ON_CRITICAL=true` and `FAIL_ON_MAJOR=false` make the check fail only for critical findings by default. Set `FAIL_ON_MAJOR=true` for stricter blocking, or set advanced `FAIL_ON_SEVERITY=off` if the reviewer should be informational only.

For production repositories, prefer:

```bash
REVIEW_ROUTER_PRESET=blocking
```

This keeps the safer `safe` review depth, but makes Major findings block the pull request. Use `safe` during rollout if you want advisory comments first.

## Human override

If a blocking inline finding is a verified false positive, reply to that specific ReviewRouter inline comment:

```text
/rr skip
/rr skip optional reason
```

The reason is optional. The installer generates a second non-required workflow, `.github/workflows/reviewrouter-interaction.yml`, for `/rr ...` replies and optional discussion replies. `/rr skip` does not run Codex, does not checkout pull request code, and does not try to mark the GitHub review conversation as resolved. It only verifies the command, updates the signed PR ledger, marks the inline comment body as dismissed, and reruns the failed `ReviewRouter / review` check when the token has `actions: write`.

Permission policy:

- Critical and Major findings require `maintain` or `admin`.
- Minor findings allow `write`, `maintain`, or `admin`.
- PR authors cannot skip blocking findings by default.

The skip state is stored in one bot-owned PR comment and signed with `REVIEW_ROUTER_LEDGER_KEY`. If the ledger is edited by hand or the key is missing, ReviewRouter ignores the override state and keeps the PR blocked.

With Codex OAuth or OpenAI API-key modes, new installs set `REVIEW_ROUTER_DISCUSSION_MODE=suggest`. A normal human reply to a ReviewRouter inline finding can receive an AI explanation in the same review thread. If the AI agrees the finding is likely a false positive, it suggests that a maintainer reply `/rr skip`. It does not write the ledger or unblock CI from free-form text.

OpenRouter installs currently set `REVIEW_ROUTER_DISCUSSION_MODE=off` because discussion replies use the Codex CLI responder first. The handler is provider-oriented, so other responders can be added without changing the GitHub command/ledger flow.

## Non-interactive examples

### GitHub App bot + Codex subscription

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/review-router/main/scripts/install.sh | env \
  REVIEW_ROUTER_REPO=owner/repo \
  REVIEW_ROUTER_IDENTITY=app \
  REVIEW_ROUTER_AUTH=codex \
  REVIEW_ROUTER_PRESET=safe \
  REVIEW_ROUTER_YES=1 \
  bash
```

### Blocking production gate

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/review-router/main/scripts/install.sh | env \
  REVIEW_ROUTER_REPO=owner/repo \
  REVIEW_ROUTER_IDENTITY=app \
  REVIEW_ROUTER_AUTH=codex \
  REVIEW_ROUTER_PRESET=blocking \
  REVIEW_ROUTER_YES=1 \
  bash
```

`blocking` fails the `ReviewRouter / review` check for Major and Critical findings. Mark this check as required in branch protection if you want it to gate merges.

### GitHub App bot + Codex subscription using org selected-repo secrets

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/review-router/main/scripts/install.sh | env \
  REVIEW_ROUTER_REPO=your-org/repo-a \
  REVIEW_ROUTER_SECRET_SCOPE=org \
  REVIEW_ROUTER_ORG=your-org \
  REVIEW_ROUTER_ORG_SECRET_REPOS=repo-a \
  REVIEW_ROUTER_IDENTITY=app \
  REVIEW_ROUTER_AUTH=codex \
  REVIEW_ROUTER_PRESET=safe \
  REVIEW_ROUTER_YES=1 \
  bash
```

### github-actions[bot] + OpenAI API key

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/review-router/main/scripts/install.sh | env \
  REVIEW_ROUTER_REPO=owner/repo \
  REVIEW_ROUTER_IDENTITY=actions \
  REVIEW_ROUTER_AUTH=openai \
  REVIEW_ROUTER_OPENAI_API_KEY=sk-... \
  REVIEW_ROUTER_PRESET=safe \
  REVIEW_ROUTER_YES=1 \
  bash
```

### github-actions[bot] + OpenRouter API key

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/review-router/main/scripts/install.sh | env \
  REVIEW_ROUTER_REPO=owner/repo \
  REVIEW_ROUTER_IDENTITY=actions \
  REVIEW_ROUTER_AUTH=openrouter \
  REVIEW_ROUTER_OPENROUTER_API_KEY=sk-or-... \
  REVIEW_ROUTER_PRESET=minimal \
  REVIEW_ROUTER_YES=1 \
  bash
```

## Local dry-run / e2e mode

For tests, the installer can write the workflow into a local directory without touching GitHub:

```bash
TMP_DIR=$(mktemp -d)
REVIEW_ROUTER_NON_INTERACTIVE=1 \
REVIEW_ROUTER_LOCAL_ONLY=1 \
REVIEW_ROUTER_SKIP_GH_CHECK=1 \
REVIEW_ROUTER_REPO=owner/repo \
REVIEW_ROUTER_IDENTITY=actions \
REVIEW_ROUTER_AUTH=openrouter \
REVIEW_ROUTER_OPENROUTER_API_KEY=dummy \
REVIEW_ROUTER_WORKDIR="$TMP_DIR" \
bash scripts/install.sh

cat "$TMP_DIR/.github/workflows/reviewrouter.yml"
```

When the installer is run from inside the target repository, the normal GitHub setup path now reuses the current local repository object database through a temporary `git worktree`. It does not switch your current branch or write workflow files into your current checkout, but it avoids a full `gh repo clone`.

## Workflow defaults

The generated workflow currently uses:

- `actions/checkout@v6`
- `actions/setup-node@v6` when Codex CLI is required
- Node `24`
- `@openai/codex@0.147.0`
- `actions/create-github-app-token@v3` in GitHub App mode

These versions were checked on 2026-08-15 against the current package/action releases.

## Why no hosted App yet

This v1 installer creates user-owned GitHub Apps. That means each user or org controls its own App, private key, installation, and billing/auth secrets. A single shared branded SaaS App would require a backend service to store installation state and mint tokens safely; that is a separate v2 architecture.
