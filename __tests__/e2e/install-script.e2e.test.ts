import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');
const installerPath = path.join(repoRoot, 'scripts/install.sh');

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runInstaller(
  env: Record<string, string>,
  workdir = makeTempDir('airr-workdir-')
) {
  const result = spawnSync('bash', [installerPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      REVIEW_ROUTER_NON_INTERACTIVE: '1',
      REVIEW_ROUTER_LOCAL_ONLY: '1',
      REVIEW_ROUTER_SKIP_GH_CHECK: '1',
      REVIEW_ROUTER_REPO: 'test-owner/test-repo',
      REVIEW_ROUTER_WORKDIR: workdir,
      REVIEW_ROUTER_WORKFLOW_STYLE: 'explicit',
      REVIEW_ROUTER_APP_PROFILE_DIR: path.join(workdir, '.review-router-apps'),
      ...env,
    },
    encoding: 'utf-8',
  });

  return {
    ...result,
    workdir,
    workflowPath: path.join(workdir, '.github/workflows/reviewrouter.yml'),
    interactionWorkflowPath: path.join(
      workdir,
      '.github/workflows/reviewrouter-interaction.yml'
    ),
  };
}

function workflowText(workflowPath: string): string {
  return fs.readFileSync(workflowPath, 'utf-8');
}

function installerLatestReleaseTag(): string {
  const installer = fs.readFileSync(installerPath, 'utf-8');
  const match = installer.match(/^LATEST_RELEASE_TAG="([^"]+)"$/m);
  if (!match) {
    throw new Error('LATEST_RELEASE_TAG not found in installer');
  }
  return match[1];
}

function staticRuntimeEnv(workflow: string): Record<string, string> {
  const marker = 'static_runtime_env_json: >-\n';
  const start = workflow.indexOf(marker);
  if (start === -1) {
    throw new Error('static_runtime_env_json block not found');
  }
  const block = workflow
    .slice(start + marker.length)
    .split('\n')
    .filter((line) => line.startsWith('        '))
    .map((line) => line.slice(8))
    .join('\n');
  return JSON.parse(block) as Record<string, string>;
}

function writePrivateKeyFixture(
  dir: string,
  name = 'app.private-key.pem'
): string {
  const keyFile = path.join(dir, name);
  fs.writeFileSync(
    keyFile,
    [
      '-----BEGIN PRIVATE KEY-----',
      'test-private-key',
      '-----END PRIVATE KEY-----',
      '',
    ].join('\n')
  );
  return keyFile;
}

function writeFakeAppDoctorBin(dir: string): string {
  const binDir = path.join(dir, 'fake-bin');
  fs.mkdirSync(binDir, { recursive: true });

  const ghPath = path.join(binDir, 'gh');
  fs.writeFileSync(
    ghPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "auth" ] && [ "${2:-}" = "status" ]; then exit 0; fi',
      'if [ "${1:-}" = "api" ] && [ "${2:-}" = "/app" ]; then',
      '  args="$*"',
      '  case "$args" in',
      '    *".id"*) printf "12345\\n"; exit 0 ;;',
      '    *".client_id"*) printf "Iv1.doctor-client-id\\n"; exit 0 ;;',
      '    *".slug"*) printf "review-router-doctor\\n"; exit 0 ;;',
      '    *".permissions.actions"*) exit 0 ;;',
      '    *".permissions.contents"*) printf "read\\n"; exit 0 ;;',
      '    *".permissions.issues"*) printf "write\\n"; exit 0 ;;',
      '    *".permissions.pull_requests"*) printf "write\\n"; exit 0 ;;',
      '  esac',
      'fi',
      'printf "unexpected gh call: %s\\n" "$*" >&2',
      'exit 1',
      '',
    ].join('\n')
  );
  fs.chmodSync(ghPath, 0o755);

  const opensslPath = path.join(binDir, 'openssl');
  fs.writeFileSync(
    opensslPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "dgst" ]; then',
      '  printf "fake-signature"',
      '  exit 0',
      'fi',
      'printf "unexpected openssl call: %s\\n" "$*" >&2',
      'exit 1',
      '',
    ].join('\n')
  );
  fs.chmodSync(opensslPath, 0o755);

  return binDir;
}

function writeFakeMissingInstallationAppDoctorBin(dir: string): string {
  const binDir = path.join(dir, 'fake-missing-install-bin');
  fs.mkdirSync(binDir, { recursive: true });

  const ghPath = path.join(binDir, 'gh');
  fs.writeFileSync(
    ghPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "auth" ] && [ "${2:-}" = "status" ]; then exit 0; fi',
      'if [ "${1:-}" = "api" ] && [ "${2:-}" = "/app" ]; then',
      '  args="$*"',
      '  case "$args" in',
      '    *".id"*) printf "12345\\n"; exit 0 ;;',
      '    *".client_id"*) printf "Iv1.doctor-client-id\\n"; exit 0 ;;',
      '    *".slug"*) printf "review-router-doctor\\n"; exit 0 ;;',
      '    *".permissions.actions"*) printf "write\\n"; exit 0 ;;',
      '    *".permissions.contents"*) printf "read\\n"; exit 0 ;;',
      '    *".permissions.issues"*) printf "write\\n"; exit 0 ;;',
      '    *".permissions.pull_requests"*) printf "write\\n"; exit 0 ;;',
      '  esac',
      'fi',
      'if [ "${1:-}" = "api" ] && [ "${2:-}" = "/app/installations" ]; then',
      '  printf "111\\n"',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "api" ] && [ "${2:-}" = "/app/installations/111" ]; then',
      '  args="$*"',
      '  case "$args" in',
      '    *".account.login"*) printf "777genius\\n"; exit 0 ;;',
      '    *".repository_selection"*) printf "all\\n"; exit 0 ;;',
      '  esac',
      'fi',
      'if [ "${1:-}" = "api" ] && [ "${2:-}" = "--method" ] && [ "${3:-}" = "POST" ] && [ "${4:-}" = "/app/installations/111/access_tokens" ]; then',
      '  printf "fake-installation-token\\n"',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "api" ] && [ "${2:-}" = "/repos/test-owner/test-repo" ]; then exit 1; fi',
      'printf "unexpected gh call: %s\\n" "$*" >&2',
      'exit 1',
      '',
    ].join('\n')
  );
  fs.chmodSync(ghPath, 0o755);

  const opensslPath = path.join(binDir, 'openssl');
  fs.writeFileSync(
    opensslPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "dgst" ]; then',
      '  printf "fake-signature"',
      '  exit 0',
      'fi',
      'printf "unexpected openssl call: %s\\n" "$*" >&2',
      'exit 1',
      '',
    ].join('\n')
  );
  fs.chmodSync(opensslPath, 0o755);

  return binDir;
}

describe('review-router curl installer e2e', () => {
  it('generates compact reusable caller workflows when requested', () => {
    const result = runInstaller({
      REVIEW_ROUTER_WORKFLOW_STYLE: 'reusable',
      REVIEW_ROUTER_IDENTITY: 'actions',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'minimal',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Workflow style: reusable');
    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain(
      'uses: 777genius/review-router/.github/workflows/reviewrouter-reusable.yml@main'
    );
    expect(workflow).toContain('merge_group:');
    expect(workflow).toContain('runtime_config_mode: oidc');
    const staticEnv = staticRuntimeEnv(workflow);
    expect(staticEnv.REVIEW_AUTH_MODE).toBe('openrouter-api');
    expect(staticEnv.REVIEW_PROVIDERS).toBe(
      'openrouter/openai/gpt-oss-120b:free,openrouter/poolside/laguna-m.1:free'
    );
    expect(workflow).toContain(
      'OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}'
    );
    expect(workflow).toContain(
      'REVIEW_ROUTER_LEDGER_KEY: ${{ secrets.REVIEW_ROUTER_LEDGER_KEY }}'
    );
    expect(workflow).toContain(
      'REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN: ${{ secrets.REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN }}'
    );
    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).not.toContain('actions/setup-node@v6');

    const interactionWorkflow = workflowText(result.interactionWorkflowPath);
    expect(interactionWorkflow).toContain(
      'uses: 777genius/review-router/.github/workflows/reviewrouter-interaction-reusable.yml@main'
    );
    expect(interactionWorkflow).toContain(
      'review_workflow_file: reviewrouter.yml'
    );
    expect(interactionWorkflow).toContain(
      'REVIEW_ROUTER_LEDGER_KEY: ${{ secrets.REVIEW_ROUTER_LEDGER_KEY }}'
    );
    expect(interactionWorkflow).not.toContain('pull_request_target');
  });

  it('preserves an immutable runtime SHA in both reusable workflows', () => {
    const runtimeSha = '0123456789abcdef0123456789abcdef01234567';
    const result = runInstaller({
      REVIEW_ROUTER_WORKFLOW_STYLE: 'reusable',
      REVIEW_ROUTER_IDENTITY: 'actions',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'minimal',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
      REVIEW_ROUTER_ACTION_REF: `777genius/review-router@${runtimeSha}`,
    });

    expect(result.status).toBe(0);
    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain(
      `uses: 777genius/review-router/.github/workflows/reviewrouter-reusable.yml@${runtimeSha}`
    );
    expect(workflow).toContain(`runtime_ref: ${runtimeSha}`);
    expect(workflow).toContain(
      'group: review-router-${{ github.event.pull_request.number || inputs.pr_number || github.ref }}'
    );
    expect(workflow).toContain('cancel-in-progress: false');

    const interactionWorkflow = workflowText(result.interactionWorkflowPath);
    expect(interactionWorkflow).toContain(
      `uses: 777genius/review-router/.github/workflows/reviewrouter-interaction-reusable.yml@${runtimeSha}`
    );
  });

  it('keeps GitHub App bot identity in compact reusable caller workflows', () => {
    const result = runInstaller({
      REVIEW_ROUTER_WORKFLOW_STYLE: 'reusable',
      REVIEW_ROUTER_IDENTITY: 'app',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'minimal',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
      REVIEW_ROUTER_SKIP_APP_CREATE: '1',
    });

    expect(result.status).toBe(0);
    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain(
      'uses: 777genius/review-router/.github/workflows/reviewrouter-reusable.yml@main'
    );
    expect(workflow).toContain(
      'review_app_client_id: ${{ vars.REVIEW_APP_CLIENT_ID }}'
    );
    expect(workflow).toContain('review_app_repository: test-repo');
    expect(workflow).toContain(
      'REVIEW_APP_PRIVATE_KEY: ${{ secrets.REVIEW_APP_PRIVATE_KEY }}'
    );

    const interactionWorkflow = workflowText(result.interactionWorkflowPath);
    expect(interactionWorkflow).toContain(
      'review_app_client_id: ${{ vars.REVIEW_APP_CLIENT_ID }}'
    );
    expect(interactionWorkflow).toContain(
      'REVIEW_APP_PRIVATE_KEY: ${{ secrets.REVIEW_APP_PRIVATE_KEY }}'
    );
  });

  it('uses Codex providers in compact reusable caller workflows for Codex OAuth', () => {
    const codexDir = makeTempDir('airr-reusable-codex-');
    const authFile = path.join(codexDir, 'auth.json');
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { refresh_token: 'refresh-token' },
      })
    );

    const result = runInstaller({
      REVIEW_ROUTER_WORKFLOW_STYLE: 'reusable',
      REVIEW_ROUTER_IDENTITY: 'actions',
      REVIEW_ROUTER_AUTH: 'codex',
      REVIEW_ROUTER_PRESET: 'safe',
      REVIEW_ROUTER_CODEX_AUTH_FILE: authFile,
    });

    expect(result.status).toBe(0);
    const workflow = workflowText(result.workflowPath);
    const staticEnv = staticRuntimeEnv(workflow);
    expect(staticEnv.REVIEW_AUTH_MODE).toBe('codex-oauth');
    expect(staticEnv.CODEX_MODEL).toBe('gpt-5.6-sol');
    expect(staticEnv.CODEX_REASONING_EFFORT).toBe('medium');
    expect(staticEnv.REVIEW_PROVIDERS).toBeUndefined();
    expect(staticEnv.SYNTHESIS_MODEL).toBeUndefined();
  });

  it('detects active Codex account auth when legacy auth.json is absent', () => {
    const codexHome = makeTempDir('airr-codex-accounts-');
    const accountsDir = path.join(codexHome, 'accounts');
    const activeAccountKey =
      'user-testActiveAccount::00000000-0000-4000-8000-000000000000';
    const activeAuthFile = path.join(
      accountsDir,
      `${Buffer.from(activeAccountKey).toString('base64url')}.auth.json`
    );
    fs.mkdirSync(accountsDir, { recursive: true });
    fs.writeFileSync(
      path.join(accountsDir, 'registry.json'),
      JSON.stringify({ active_account_key: activeAccountKey })
    );
    fs.writeFileSync(
      activeAuthFile,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { refresh_token: 'refresh-token' },
      })
    );

    const result = runInstaller({
      CODEX_HOME: codexHome,
      REVIEW_ROUTER_WORKFLOW_STYLE: 'reusable',
      REVIEW_ROUTER_IDENTITY: 'actions',
      REVIEW_ROUTER_AUTH: 'codex',
      REVIEW_ROUTER_PRESET: 'safe',
    });

    expect(result.status).toBe(0);
    const workflow = workflowText(result.workflowPath);
    expect(staticRuntimeEnv(workflow).REVIEW_AUTH_MODE).toBe('codex-oauth');
  });

  it('generates github-actions bot workflow for OpenRouter auth without GitHub App setup', () => {
    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'actions',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'minimal',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(result.workflowPath)).toBe(true);
    expect(result.stdout).toContain('Security advisory');
    expect(result.stdout).toContain(
      'Generated workflows use pull_request, skip fork PR secret-backed review, and do not use pull_request_target.'
    );
    expect(result.stdout).toContain(
      'Skipping remote repository hardening checks in dry-run/local-only mode'
    );
    expect(result.stdout).toContain('ReviewRouter doctor');
    expect(result.stdout).toContain('Workflow files are present');
    expect(result.stdout).toContain(
      'Skipping remote secret/variable doctor in dry-run/local-only mode'
    );
    expect(result.stdout).toContain('Setup summary');

    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain('name: ReviewRouter');
    expect(workflow).toContain('uses: 777genius/review-router@main');
    expect(result.stdout).toContain('Action ref: 777genius/review-router@main');
    expect(workflow).toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(workflow).toContain(
      'OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}'
    );
    expect(workflow).toContain("INLINE_MAX_COMMENTS: '3'");
    expect(workflow).toContain("INLINE_MIN_SEVERITY: 'major'");
    expect(workflow).toContain('UPDATE_PR_DESCRIPTION:');
    expect(workflow).toContain("FAIL_ON_CRITICAL: 'true'");
    expect(workflow).toContain("FAIL_ON_MAJOR: 'false'");
    expect(workflow).not.toContain('FAIL_ON_SEVERITY:');
    expect(workflow).not.toContain('CODEX_REASONING_EFFORT');
    expect(workflow).not.toContain('CODEX_MODEL');
    expect(workflow).toContain(
      'REVIEW_PROVIDERS: ${{ vars.REVIEW_PROVIDERS }}'
    );
    expect(workflow).toContain("ENABLE_AST_ANALYSIS: 'false'");
    expect(workflow).not.toContain('pull_request_review_comment:');
    expect(workflow).toContain(
      "if: ${{ github.event_name == 'workflow_dispatch' || github.event.pull_request.head.repo.fork != true }}"
    );
    expect(workflow).toContain(
      'REVIEW_ROUTER_LEDGER_KEY: ${{ secrets.REVIEW_ROUTER_LEDGER_KEY }}'
    );
    const interactionWorkflow = workflowText(result.interactionWorkflowPath);
    expect(interactionWorkflow).toContain('name: ReviewRouter Interaction');
    expect(interactionWorkflow).toContain('pull_request_review_comment:');
    expect(interactionWorkflow).toContain('actions: write');
    expect(interactionWorkflow).toContain('pull-requests: write');
    expect(interactionWorkflow).not.toContain(
      "github.event.comment.user.type != 'Bot'"
    );
    expect(interactionWorkflow).not.toContain(
      "startsWith(github.event.comment.body, '/rr ')"
    );
    expect(interactionWorkflow).toContain(
      'REVIEW_ROUTER_MODE: interaction-preflight'
    );
    expect(interactionWorkflow).toContain('REVIEW_ROUTER_MODE: interaction');
    expect(interactionWorkflow).toContain(
      'REVIEW_ROUTER_DISCUSSION_MODE: ${{ vars.REVIEW_ROUTER_DISCUSSION_MODE }}'
    );
    expect(workflow).not.toContain('actions/create-github-app-token');
    expect(workflow).not.toContain('actions/setup-node');
    expect(workflow).not.toContain('\\${{');
  });

  it('can generate a stable major workflow when requested', () => {
    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'actions',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'minimal',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
      REVIEW_ROUTER_ACTION_REF_MODE: 'stable',
    });

    expect(result.status).toBe(0);
    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain('uses: 777genius/review-router@v1');
    expect(result.stdout).toContain('Action ref: 777genius/review-router@v1');
  });

  it('treats latest action ref mode as live main', () => {
    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'actions',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'minimal',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
      REVIEW_ROUTER_ACTION_REF_MODE: 'latest',
    });

    expect(result.status).toBe(0);
    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain('uses: 777genius/review-router@main');
    expect(result.stdout).toContain('Action ref: 777genius/review-router@main');
  });

  it('can generate an exact pinned release workflow when requested', () => {
    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'actions',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'minimal',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
      REVIEW_ROUTER_ACTION_REF_MODE: 'release',
    });

    expect(result.status).toBe(0);
    const workflow = workflowText(result.workflowPath);
    const releaseTag = installerLatestReleaseTag();
    expect(workflow).toContain(`uses: 777genius/review-router@${releaseTag}`);
    expect(result.stdout).toContain(
      `Action ref: 777genius/review-router@${releaseTag}`
    );
  });

  it('rejects reusable workflows against unsafe custom refs', () => {
    const result = runInstaller({
      REVIEW_ROUTER_WORKFLOW_STYLE: 'reusable',
      REVIEW_ROUTER_IDENTITY: 'actions',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'minimal',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
      REVIEW_ROUTER_ACTION_REF: '777genius/review-router@feature/test',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Compact reusable workflow requires @main, @v1, @v1.x.x'
    );
  });

  it('keeps legacy AI_ROBOT_REVIEW environment aliases working', () => {
    const workdir = makeTempDir('airr-legacy-workdir-');
    const result = spawnSync('bash', [installerPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        AI_ROBOT_REVIEW_NON_INTERACTIVE: '1',
        AI_ROBOT_REVIEW_LOCAL_ONLY: '1',
        AI_ROBOT_REVIEW_SKIP_GH_CHECK: '1',
        AI_ROBOT_REVIEW_REPO: 'test-owner/test-repo',
        AI_ROBOT_REVIEW_WORKDIR: workdir,
        AI_ROBOT_REVIEW_IDENTITY: 'actions',
        AI_ROBOT_REVIEW_AUTH: 'openrouter',
        AI_ROBOT_REVIEW_PRESET: 'minimal',
        AI_ROBOT_REVIEW_OPENROUTER_API_KEY: 'or-test-key',
        AI_ROBOT_REVIEW_ACTION_REF_MODE: 'main',
        AI_ROBOT_REVIEW_WORKFLOW_STYLE: 'explicit',
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    const workflow = workflowText(
      path.join(workdir, '.github/workflows/reviewrouter.yml')
    );
    expect(workflow).toContain('uses: 777genius/review-router@main');
    expect(result.stdout).toContain('ReviewRouter setup complete');
  });

  it('generates GitHub App bot workflow for Codex OAuth auth', () => {
    const codexDir = makeTempDir('airr-codex-');
    const authFile = path.join(codexDir, 'auth.json');
    const configFile = path.join(codexDir, 'config.toml');
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { refresh_token: 'refresh-token' },
      })
    );
    fs.writeFileSync(configFile, 'model = "gpt-5.5"\n');

    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'app',
      REVIEW_ROUTER_AUTH: 'codex',
      REVIEW_ROUTER_PRESET: 'safe',
      REVIEW_ROUTER_SKIP_APP_CREATE: '1',
      REVIEW_ROUTER_CODEX_AUTH_FILE: authFile,
      REVIEW_ROUTER_CODEX_CONFIG_FILE: configFile,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ReviewRouter doctor');
    expect(result.stdout).toContain(
      'Codex OAuth stores your ChatGPT-managed Codex auth.json as an Actions secret'
    );
    expect(result.stdout).toContain('Skipping CODEX_CONFIG_TOML by default');
    expect(result.stdout).not.toContain('gh secret set CODEX_CONFIG_TOML');
    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain('uses: actions/create-github-app-token@v3');
    expect(workflow).toContain('client-id: ${{ vars.REVIEW_APP_CLIENT_ID }}');
    expect(workflow).toContain(
      'private-key: ${{ secrets.REVIEW_APP_PRIVATE_KEY }}'
    );
    expect(workflow).toContain('repositories: test-repo');
    expect(workflow).toContain(
      'GITHUB_TOKEN: ${{ steps.app-token.outputs.token }}'
    );
    expect(workflow).not.toContain('secrets.GITHUB_TOKEN }}');
    expect(workflow).toContain('npm install -g @openai/codex@0.147.0');
    expect(workflow).toContain(
      'CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}'
    );
    expect(workflow).toContain('REVIEW_ROUTER_CODEX_AUTH_PERSISTENCE: secret');
    expect(workflow).toContain(
      'printf \'%s\' "$CODEX_AUTH_JSON" > "$CODEX_HOME/auth.json"'
    );
    expect(workflow).toContain('ReviewRouter Codex OAuth auth check failed');
    expect(workflow).toContain('reseed auth.json');
    expect(workflow).not.toContain('codex-oauth-ok');
    expect(workflow).toContain('CODEX_MODEL: ${{ vars.REVIEW_CODEX_MODEL }}');
    expect(workflow).not.toContain(
      'REVIEW_PROVIDERS: ${{ vars.REVIEW_PROVIDERS }}'
    );
    expect(workflow).toContain("INLINE_MAX_COMMENTS: '5'");
    expect(workflow).toContain("INLINE_MIN_SEVERITY: 'major'");
    expect(workflow).toContain(
      "CODEX_REASONING_EFFORT: ${{ vars.REVIEW_CODEX_EFFORT || 'medium' }}"
    );
    expect(workflow).toContain("CODEX_HEALTHCHECK_MODE: 'binary'");
    expect(workflow).toContain("CODEX_AGENTIC_CONTEXT: 'true'");
    expect(workflow).toContain('UPDATE_PR_DESCRIPTION:');
    expect(workflow).toContain("FAIL_ON_CRITICAL: 'true'");
    expect(workflow).toContain("FAIL_ON_MAJOR: 'false'");
    expect(workflow).not.toContain('FAIL_ON_SEVERITY:');
    expect(workflow).toContain("MIN_CONFIDENCE: '0.6'");
    expect(workflow).toContain("CONSENSUS_REQUIRED_FOR_CRITICAL: 'false'");
    expect(workflow).not.toContain('\\${{');
    const interactionWorkflow = workflowText(result.interactionWorkflowPath);
    expect(interactionWorkflow).toContain('permission-actions: write');
    expect(interactionWorkflow).toContain('permission-pull-requests: write');
    expect(interactionWorkflow).toContain(
      'Install official Codex CLI for discussion replies'
    );
    expect(interactionWorkflow).toContain(
      'Restore Codex OAuth config for discussion replies'
    );
    expect(interactionWorkflow).toContain(
      'ReviewRouter Codex OAuth auth check failed'
    );
    expect(interactionWorkflow).toContain('reseed auth.json');
    expect(interactionWorkflow).toContain(
      'GITHUB_TOKEN: ${{ steps.app-token.outputs.token }}'
    );
  });

  it('can generate persistent Codex OAuth auth mode for self-hosted runners', () => {
    const codexDir = makeTempDir('airr-persistent-codex-');
    const authFile = path.join(codexDir, 'auth.json');
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { refresh_token: 'refresh-token' },
      })
    );

    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'actions',
      REVIEW_ROUTER_AUTH: 'codex',
      REVIEW_ROUTER_PRESET: 'safe',
      REVIEW_ROUTER_CODEX_AUTH_FILE: authFile,
      REVIEW_ROUTER_RUNS_ON: 'self-hosted',
      REVIEW_ROUTER_CODEX_AUTH_PERSISTENCE: 'persistent',
    });

    expect(result.status).toBe(0);
    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain('runs-on: self-hosted');
    expect(workflow).toContain(
      'REVIEW_ROUTER_CODEX_AUTH_PERSISTENCE: persistent'
    );
    expect(workflow).toContain('Using existing persistent Codex auth.json');
    expect(result.stdout).toContain(
      'Codex auth persistence is set to persistent'
    );
  });

  it('generates Claude Code subscription OAuth workflow', () => {
    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'actions',
      REVIEW_ROUTER_AUTH: 'claude',
      REVIEW_ROUTER_PRESET: 'safe',
      REVIEW_ROUTER_CLAUDE_CODE_OAUTH_TOKEN: 'claude-oauth-token',
      REVIEW_ROUTER_CLAUDE_MODEL: 'sonnet',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'Claude OAuth stores a one-year Claude Code subscription token'
    );
    expect(result.stdout).toContain(
      'gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo test-owner/test-repo'
    );
    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain('Install official Claude Code CLI');
    expect(workflow).toContain(
      'curl -fsSL https://claude.ai/install.sh | bash'
    );
    expect(workflow).toContain(
      'CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}'
    );
    expect(workflow).toContain('Validate Claude Code OAuth token secret');
    expect(workflow).toContain('CLAUDE_MODEL: ${{ vars.REVIEW_CLAUDE_MODEL }}');
    expect(workflow).not.toContain('CODEX_AUTH_JSON');
    expect(workflow).not.toContain('CODEX_MODEL:');
    expect(workflow).not.toContain('OPENAI_API_KEY');
    const interactionWorkflow = workflowText(result.interactionWorkflowPath);
    expect(interactionWorkflow).not.toContain('Install official Codex CLI');
    expect(interactionWorkflow).not.toContain('Restore Codex OAuth config');
  });

  it('imports existing GitHub App credentials manually and saves a local profile', () => {
    const appDir = makeTempDir('airr-manual-app-');
    const privateKeyFile = writePrivateKeyFixture(appDir);
    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'app',
      REVIEW_ROUTER_APP_SETUP: 'manual',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'safe',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
      REVIEW_ROUTER_APP_CLIENT_ID: 'Iv1.manual-client-id',
      REVIEW_ROUTER_APP_ID: '12345',
      REVIEW_ROUTER_APP_SLUG: 'review-router-manual',
      REVIEW_ROUTER_APP_PRIVATE_KEY_FILE: privateKeyFile,
      REVIEW_ROUTER_APP_LOGO_URL: 'i.imgur.com/Yz9XIQM.png',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'Skipping GitHub App doctor in dry-run/local-only mode'
    );
    expect(result.stdout).toContain('Saved GitHub App profile:');
    expect(result.stdout).toContain('Loaded GitHub App profile:');
    expect(result.stdout).toContain(
      'Optional: upload the ReviewRouter logo for this GitHub App'
    );
    expect(result.stdout).toContain(
      'https://github.com/settings/apps/review-router-manual'
    );
    expect(result.stdout).toContain('https://i.imgur.com/Yz9XIQM.png');
    expect(result.stdout).toContain(
      'gh secret set REVIEW_APP_PRIVATE_KEY --repo test-owner/test-repo'
    );
    const profilePath = path.join(
      result.workdir,
      '.review-router-apps',
      'review-router-manual.env'
    );
    const savedKeyPath = path.join(
      result.workdir,
      '.review-router-apps',
      'review-router-manual.private-key.pem'
    );
    expect(fs.existsSync(profilePath)).toBe(true);
    expect(fs.existsSync(savedKeyPath)).toBe(true);
    expect(fs.readFileSync(profilePath, 'utf-8')).toContain(
      'APP_SLUG=review-router-manual'
    );
    expect(fs.readFileSync(profilePath, 'utf-8')).toContain(
      'APP_PRIVATE_KEY_FILE='
    );
    expect(fs.readFileSync(savedKeyPath, 'utf-8')).toBe(
      fs.readFileSync(privateKeyFile, 'utf-8')
    );
    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain('uses: actions/create-github-app-token@v3');
    expect(workflow).toContain(
      'GITHUB_TOKEN: ${{ steps.app-token.outputs.token }}'
    );
    expect(workflowText(result.interactionWorkflowPath)).toContain(
      'permission-actions: write'
    );
  });

  it('fails before writing workflows when GitHub App doctor detects missing Actions write permission', () => {
    const workdir = makeTempDir('airr-app-doctor-workdir-');
    const fakeBin = writeFakeAppDoctorBin(workdir);
    const privateKeyFile = writePrivateKeyFixture(workdir);

    const result = runInstaller(
      {
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        REVIEW_ROUTER_LOCAL_ONLY: '0',
        REVIEW_ROUTER_SKIP_GH_CHECK: '0',
        REVIEW_ROUTER_IDENTITY: 'app',
        REVIEW_ROUTER_APP_SETUP: 'manual',
        REVIEW_ROUTER_AUTH: 'openrouter',
        REVIEW_ROUTER_PRESET: 'safe',
        REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
        REVIEW_ROUTER_APP_CLIENT_ID: 'Iv1.doctor-client-id',
        REVIEW_ROUTER_APP_ID: '12345',
        REVIEW_ROUTER_APP_SLUG: 'review-router-doctor',
        REVIEW_ROUTER_APP_PRIVATE_KEY_FILE: privateKeyFile,
      },
      workdir
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'GitHub App is missing required permissions: actions:write (current: none)'
    );
    expect(fs.existsSync(result.workflowPath)).toBe(false);
    expect(fs.existsSync(result.interactionWorkflowPath)).toBe(false);
  });

  it('shows the GitHub App install URL when the App is not installed on the target repo', () => {
    const workdir = makeTempDir('airr-app-install-missing-workdir-');
    const fakeBin = writeFakeMissingInstallationAppDoctorBin(workdir);
    const privateKeyFile = writePrivateKeyFixture(workdir);

    const result = runInstaller(
      {
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        REVIEW_ROUTER_LOCAL_ONLY: '0',
        REVIEW_ROUTER_SKIP_GH_CHECK: '0',
        REVIEW_ROUTER_IDENTITY: 'app',
        REVIEW_ROUTER_APP_SETUP: 'manual',
        REVIEW_ROUTER_AUTH: 'openrouter',
        REVIEW_ROUTER_PRESET: 'safe',
        REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
        REVIEW_ROUTER_APP_CLIENT_ID: 'Iv1.doctor-client-id',
        REVIEW_ROUTER_APP_ID: '12345',
        REVIEW_ROUTER_APP_SLUG: 'review-router-doctor',
        REVIEW_ROUTER_APP_PRIVATE_KEY_FILE: privateKeyFile,
      },
      workdir
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'ReviewRouter cannot access test-owner/test-repo through review-router-doctor yet.'
    );
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Install URL: https://github.com/apps/review-router-doctor/installations/new'
    );
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Current App installations visible to this private key: 777genius (all)'
    );
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Target repository owner is test-owner. Install the App for that account/org and include test-repo.'
    );
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Select owner/account test-owner, choose repository test-repo'
    );
    expect(fs.existsSync(result.workflowPath)).toBe(false);
    expect(fs.existsSync(result.interactionWorkflowPath)).toBe(false);
  });

  it('keeps existing GitHub App credential env vars working without explicit app setup mode', () => {
    const appDir = makeTempDir('airr-compat-app-');
    const privateKeyFile = writePrivateKeyFixture(appDir);
    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'app',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'safe',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
      REVIEW_ROUTER_APP_CLIENT_ID: 'Iv1.compat-client-id',
      REVIEW_ROUTER_APP_ID: '22222',
      REVIEW_ROUTER_APP_SLUG: 'review-router-compat',
      REVIEW_ROUTER_APP_PRIVATE_KEY_FILE: privateKeyFile,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Saved GitHub App profile:');
    expect(result.stdout).not.toContain(
      'Skipping GitHub App creation in dry-run/local-only/test mode'
    );
    expect(
      fs.existsSync(
        path.join(
          result.workdir,
          '.review-router-apps',
          'review-router-compat.env'
        )
      )
    ).toBe(true);
  });

  it('reuses a saved GitHub App profile', () => {
    const workdir = makeTempDir('airr-saved-app-workdir-');
    const profileDir = path.join(workdir, '.review-router-apps');
    fs.mkdirSync(profileDir, { recursive: true });
    const privateKeyFile = writePrivateKeyFixture(
      profileDir,
      'saved-router.private-key.pem'
    );
    fs.writeFileSync(
      path.join(profileDir, 'saved-router.env'),
      [
        'APP_ID=98765',
        'APP_CLIENT_ID=Iv1.saved-client-id',
        'APP_SLUG=saved-router',
        'APP_NAME=saved-router',
        `APP_PRIVATE_KEY_FILE=${privateKeyFile}`,
        '',
      ].join('\n')
    );

    const result = runInstaller(
      {
        REVIEW_ROUTER_IDENTITY: 'app',
        REVIEW_ROUTER_APP_SETUP: 'saved',
        REVIEW_ROUTER_APP_PROFILE: 'saved-router',
        REVIEW_ROUTER_AUTH: 'openrouter',
        REVIEW_ROUTER_PRESET: 'safe',
        REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
      },
      workdir
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'Loaded GitHub App profile: saved-router (saved-router)'
    );
    expect(result.stdout).toContain(
      'gh secret set REVIEW_APP_PRIVATE_KEY --repo test-owner/test-repo'
    );
    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain('uses: actions/create-github-app-token@v3');
    expect(workflow).toContain('repositories: test-repo');
  });

  it('fails saved GitHub App profile when the saved private key is missing', () => {
    const workdir = makeTempDir('airr-missing-key-app-workdir-');
    const profileDir = path.join(workdir, '.review-router-apps');
    fs.mkdirSync(profileDir, { recursive: true });
    const missingKeyFile = path.join(
      profileDir,
      'missing-router.private-key.pem'
    );
    fs.writeFileSync(
      path.join(profileDir, 'missing-router.env'),
      [
        'APP_ID=98765',
        'APP_CLIENT_ID=Iv1.missing-client-id',
        'APP_SLUG=missing-router',
        'APP_NAME=missing-router',
        `APP_PRIVATE_KEY_FILE=${missingKeyFile}`,
        '',
      ].join('\n')
    );

    const result = runInstaller(
      {
        REVIEW_ROUTER_IDENTITY: 'app',
        REVIEW_ROUTER_APP_SETUP: 'saved',
        REVIEW_ROUTER_APP_PROFILE: 'missing-router',
        REVIEW_ROUTER_AUTH: 'openrouter',
        REVIEW_ROUTER_PRESET: 'safe',
        REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
      },
      workdir
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain(
      'GitHub App private key file not found'
    );
    expect(fs.existsSync(result.workflowPath)).toBe(false);
  });

  it('requires an explicit saved profile in non-interactive mode when multiple profiles exist', () => {
    const workdir = makeTempDir('airr-multiple-app-workdir-');
    const profileDir = path.join(workdir, '.review-router-apps');
    fs.mkdirSync(profileDir, { recursive: true });
    for (const slug of ['first-router', 'second-router']) {
      const privateKeyFile = writePrivateKeyFixture(
        profileDir,
        `${slug}.private-key.pem`
      );
      fs.writeFileSync(
        path.join(profileDir, `${slug}.env`),
        [
          'APP_ID=98765',
          `APP_CLIENT_ID=Iv1.${slug}`,
          `APP_SLUG=${slug}`,
          `APP_NAME=${slug}`,
          `APP_PRIVATE_KEY_FILE=${privateKeyFile}`,
          '',
        ].join('\n')
      );
    }

    const result = runInstaller(
      {
        REVIEW_ROUTER_IDENTITY: 'app',
        REVIEW_ROUTER_APP_SETUP: 'saved',
        REVIEW_ROUTER_AUTH: 'openrouter',
        REVIEW_ROUTER_PRESET: 'safe',
        REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
      },
      workdir
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain(
      'Multiple saved GitHub App profiles found'
    );
    expect(fs.existsSync(result.workflowPath)).toBe(false);
  });

  it('generates Codex CLI API-key workflow without requiring local OAuth auth', () => {
    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'actions',
      REVIEW_ROUTER_AUTH: 'openai',
      REVIEW_ROUTER_PRESET: 'strict',
      REVIEW_ROUTER_OPENAI_API_KEY: 'sk-test-key',
    });

    expect(result.status).toBe(0);
    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain('OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}');
    expect(workflow).toContain('Validate OpenAI API key secret');
    expect(workflow).not.toContain('codex-api-ok');
    expect(workflow).toContain('CODEX_MODEL: ${{ vars.REVIEW_CODEX_MODEL }}');
    expect(workflow).not.toContain(
      'REVIEW_PROVIDERS: ${{ vars.REVIEW_PROVIDERS }}'
    );
    expect(workflow).toContain("INLINE_MAX_COMMENTS: '10'");
    expect(workflow).toContain("INLINE_MIN_SEVERITY: 'minor'");
    expect(workflow).toContain("FAIL_ON_CRITICAL: 'true'");
    expect(workflow).toContain("FAIL_ON_MAJOR: 'true'");
    expect(workflow).not.toContain('FAIL_ON_SEVERITY:');
    expect(workflow).toContain(
      "CODEX_REASONING_EFFORT: ${{ vars.REVIEW_CODEX_EFFORT || 'medium' }}"
    );
    expect(workflow).toContain("CODEX_HEALTHCHECK_MODE: 'binary'");
    expect(workflow).toContain("CODEX_AGENTIC_CONTEXT: 'true'");
    expect(workflow).toContain("GRAPH_ENABLED: 'true'");
    expect(workflow).not.toContain('CODEX_AUTH_JSON');
  });

  it('generates blocking preset workflow that fails on major findings', () => {
    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'actions',
      REVIEW_ROUTER_AUTH: 'openai',
      REVIEW_ROUTER_PRESET: 'blocking',
      REVIEW_ROUTER_OPENAI_API_KEY: 'sk-test-key',
    });

    expect(result.status).toBe(0);
    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain("INLINE_MAX_COMMENTS: '5'");
    expect(workflow).toContain("INLINE_MIN_SEVERITY: 'major'");
    expect(workflow).toContain("FAIL_ON_CRITICAL: 'true'");
    expect(workflow).toContain("FAIL_ON_MAJOR: 'true'");
    expect(workflow).toContain(
      "CODEX_REASONING_EFFORT: ${{ vars.REVIEW_CODEX_EFFORT || 'medium' }}"
    );
    expect(workflow).toContain("GRAPH_ENABLED: 'false'");
  });

  it('stores secrets and variables at org scope for selected repositories only', () => {
    const result = runInstaller({
      REVIEW_ROUTER_SECRET_SCOPE: 'org',
      REVIEW_ROUTER_ORG: 'test-owner',
      REVIEW_ROUTER_ORG_SECRET_REPOS: 'test-repo',
      REVIEW_ROUTER_IDENTITY: 'actions',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'safe',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'Secret scope: org test-owner, selected repos: test-repo'
    );
    expect(result.stdout).toContain(
      'gh secret set OPENROUTER_API_KEY --org test-owner --repos test-repo'
    );
    expect(result.stdout).toContain(
      'gh variable set REVIEW_AUTH_MODE --org test-owner --repos test-repo'
    );
    expect(result.stdout).toContain(
      'gh variable set REVIEW_PROVIDERS --org test-owner --repos test-repo'
    );

    const workflow = workflowText(result.workflowPath);
    expect(workflow).toContain(
      'OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}'
    );
    expect(workflow).toContain(
      'REVIEW_PROVIDERS: ${{ vars.REVIEW_PROVIDERS }}'
    );
    expect(workflow).not.toContain('CODEX_MODEL');
  });

  it('does not open GitHub App manifest flow in dry-run mode', () => {
    const result = runInstaller({
      REVIEW_ROUTER_LOCAL_ONLY: '0',
      REVIEW_ROUTER_DRY_RUN: '1',
      REVIEW_ROUTER_IDENTITY: 'app',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'safe',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'Skipping GitHub App creation in dry-run/local-only/test mode'
    );
    expect(result.stdout).toContain('would clone test-owner/test-repo');
    expect(result.stdout).toContain(
      'would commit .github/workflows/reviewrouter.yml and .github/workflows/reviewrouter-interaction.yml'
    );
  });

  it('fails clearly when saved GitHub App profiles are missing', () => {
    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'app',
      REVIEW_ROUTER_APP_SETUP: 'saved',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'safe',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain(
      'No saved GitHub App profiles found'
    );
    expect(fs.existsSync(result.workflowPath)).toBe(false);
  });

  it('rejects invalid GitHub App private key before writing workflow', () => {
    const appDir = makeTempDir('airr-bad-app-');
    const badKeyFile = path.join(appDir, 'bad.pem');
    fs.writeFileSync(badKeyFile, 'not a pem key');

    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'app',
      REVIEW_ROUTER_APP_SETUP: 'manual',
      REVIEW_ROUTER_AUTH: 'openrouter',
      REVIEW_ROUTER_PRESET: 'safe',
      REVIEW_ROUTER_OPENROUTER_API_KEY: 'or-test-key',
      REVIEW_ROUTER_APP_CLIENT_ID: 'Iv1.bad-client-id',
      REVIEW_ROUTER_APP_ID: '12345',
      REVIEW_ROUTER_APP_SLUG: 'bad-router',
      REVIEW_ROUTER_APP_PRIVATE_KEY_FILE: badKeyFile,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain(
      'does not look like a PEM private key'
    );
    expect(result.stdout).toContain(
      'Import an existing GitHub App by entering its credentials.'
    );
    expect(result.stdout).toContain(
      'After import, this machine will save a local reusable profile'
    );
    expect(fs.existsSync(result.workflowPath)).toBe(false);
  });

  it('rejects invalid Codex OAuth files before writing workflow', () => {
    const codexDir = makeTempDir('airr-bad-codex-');
    const authFile = path.join(codexDir, 'auth.json');
    fs.writeFileSync(
      authFile,
      JSON.stringify({ auth_mode: 'chatgpt', tokens: {} })
    );

    const result = runInstaller({
      REVIEW_ROUTER_IDENTITY: 'actions',
      REVIEW_ROUTER_AUTH: 'codex',
      REVIEW_ROUTER_PRESET: 'safe',
      REVIEW_ROUTER_CODEX_AUTH_FILE: authFile,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain(
      'tokens.refresh_token is missing'
    );
    expect(fs.existsSync(result.workflowPath)).toBe(false);
  });
});
