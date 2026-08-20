import { execFile } from 'child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, '../..');
const seedScript = path.join(repoRoot, 'scripts/seed-codex-auth.sh');

describe('seed-codex-auth.sh', () => {
  it('prints a repository secret dry-run without leaking auth JSON', async () => {
    const fixture = await createFixture();

    const result = await runSeedScript(fixture, {
      REVIEW_ROUTER_DRY_RUN: '1',
      REVIEW_ROUTER_SECRET_SCOPE: 'repo',
      REVIEW_ROUTER_REPO: '777genius/example',
    });

    expect(result.stdout).toContain('ReviewRouter Codex OAuth secret seeding');
    expect(result.stdout).toContain(
      'Validated Codex auth JSON before writing secrets'
    );
    expect(result.stdout).toContain(
      '[dry-run] gh secret set CODEX_AUTH_JSON --repo 777genius/example <'
    );
    expect(result.stdout + result.stderr).not.toContain(fixture.refreshToken);
  });

  it('prints an organization selected-repositories dry-run', async () => {
    const fixture = await createFixture();

    const result = await runSeedScript(fixture, {
      REVIEW_ROUTER_DRY_RUN: '1',
      REVIEW_ROUTER_SECRET_SCOPE: 'org',
      REVIEW_ROUTER_REPO: 'agent-teams-ai/tvaity',
      REVIEW_ROUTER_ORG: 'agent-teams-ai',
      REVIEW_ROUTER_ORG_SECRET_REPOS: 'tvaity,docs',
    });

    expect(result.stdout).toContain(
      '[dry-run] gh secret set CODEX_AUTH_JSON --org agent-teams-ai --repos tvaity,docs --app actions <'
    );
    expect(result.stdout + result.stderr).not.toContain(fixture.refreshToken);
  });

  it('detects active Codex account auth when legacy auth.json is absent', async () => {
    const fixture = await createFixture({ authStorage: 'active-account' });

    const result = await runSeedScript(fixture, {
      REVIEW_ROUTER_DRY_RUN: '1',
      REVIEW_ROUTER_SECRET_SCOPE: 'repo',
      REVIEW_ROUTER_REPO: '777genius/example',
    });

    expect(result.stdout).toContain(
      'Validated Codex auth JSON before writing secrets'
    );
    expect(result.stdout).toContain('/accounts/');
    expect(result.stdout).toContain('.auth.json');
    expect(result.stdout + result.stderr).not.toContain(fixture.refreshToken);
  });

  it('prefers legacy auth.json over active account auth when both exist', async () => {
    const fixture = await createFixture({ authStorage: 'both' });

    const result = await runSeedScript(fixture, {
      REVIEW_ROUTER_DRY_RUN: '1',
      REVIEW_ROUTER_SECRET_SCOPE: 'repo',
      REVIEW_ROUTER_REPO: '777genius/example',
    });

    expect(result.stdout).toContain(fixture.legacyAuthFile);
    expect(result.stdout).not.toContain('/accounts/');
    expect(result.stdout + result.stderr).not.toContain(fixture.refreshToken);
  });

  it('allows CODEX_AUTH_FILE to force a specific auth file', async () => {
    const fixture = await createFixture({ authStorage: 'both' });

    const result = await runSeedScript(fixture, {
      CODEX_AUTH_FILE: fixture.legacyAuthFile,
      REVIEW_ROUTER_DRY_RUN: '1',
      REVIEW_ROUTER_SECRET_SCOPE: 'repo',
      REVIEW_ROUTER_REPO: '777genius/example',
    });

    expect(result.stdout).toContain(fixture.legacyAuthFile);
  });

  it('preflights Codex auth before confirmed secret writes', async () => {
    const fixture = await createFixture();

    const result = await runSeedScript(fixture, {
      REVIEW_ROUTER_CONFIRM_WRITE: '1',
      REVIEW_ROUTER_SECRET_SCOPE: 'repo',
      REVIEW_ROUTER_REPO: '777genius/example',
    });

    expect(result.stdout).toContain('Codex auth preflight passed');
    expect(result.stdout).toContain(
      'Stored repo secret CODEX_AUTH_JSON for 777genius/example'
    );
    await expect(readFile(fixture.codexLog, 'utf8')).resolves.toContain(
      'exec --model gpt-5.6-sol'
    );
  });

  it('fails before secret writes when auth.json is not ChatGPT OAuth', async () => {
    const fixture = await createFixture({
      authJson: { auth_mode: 'api_key', tokens: { refresh_token: 'bad' } },
    });

    await expect(
      runSeedScript(fixture, {
        REVIEW_ROUTER_DRY_RUN: '1',
        REVIEW_ROUTER_SECRET_SCOPE: 'repo',
        REVIEW_ROUTER_REPO: '777genius/example',
      })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('auth.json auth_mode must be chatgpt'),
    });
  });

  it('prints a reseed auth.json recovery hint before any secret write', async () => {
    const fixture = await createFixture({
      authJson: { auth_mode: 'chatgpt', tokens: {} },
    });

    await expect(
      runSeedScript(fixture, {
        REVIEW_ROUTER_CONFIRM_WRITE: '1',
        REVIEW_ROUTER_SECRET_SCOPE: 'repo',
        REVIEW_ROUTER_REPO: '777genius/example',
      })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('To reseed auth.json'),
    });
  });
});

async function createFixture(input?: {
  readonly authJson?: Record<string, unknown>;
  readonly authStorage?: 'legacy' | 'active-account' | 'both';
}): Promise<{
  readonly root: string;
  readonly codexHome: string;
  readonly binDir: string;
  readonly refreshToken: string;
  readonly legacyAuthFile: string;
  readonly codexLog: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'reviewrouter-seed-test-'));
  const codexHome = path.join(root, '.codex');
  const binDir = path.join(root, 'bin');
  await mkdir(codexHome, { recursive: true });
  await mkdir(binDir, { recursive: true });

  const refreshToken = 'refresh-token-that-must-not-leak';
  const authJson = input?.authJson ?? {
    auth_mode: 'chatgpt',
    tokens: { refresh_token: refreshToken },
  };
  const legacyAuthFile = path.join(codexHome, 'auth.json');
  const codexLog = path.join(root, 'codex-calls.log');
  if (
    input?.authStorage === 'active-account' ||
    input?.authStorage === 'both'
  ) {
    const accountsDir = path.join(codexHome, 'accounts');
    await mkdir(accountsDir, { recursive: true });
    const activeAccountKey =
      'user-review-router-test::00000000-0000-4000-8000-000000000000';
    const encoded = Buffer.from(activeAccountKey, 'utf8').toString('base64url');
    await writeFile(
      path.join(accountsDir, 'registry.json'),
      JSON.stringify({ active_account_key: activeAccountKey })
    );
    await writeFile(
      path.join(accountsDir, `${encoded}.auth.json`),
      JSON.stringify(authJson)
    );
  }
  if (input?.authStorage !== 'active-account') {
    await writeFile(legacyAuthFile, JSON.stringify(authJson));
  }

  const ghPath = path.join(binDir, 'gh');
  await writeFile(
    ghPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "auth" ] && [ "${2:-}" = "status" ]; then exit 0; fi',
      'if [ "${1:-}" = "secret" ] && [ "${2:-}" = "set" ]; then cat >/dev/null; exit 0; fi',
      'echo "unexpected gh call: $*" >&2',
      'exit 2',
      '',
    ].join('\n')
  );
  await chmod(ghPath, 0o755);

  const codexPath = path.join(binDir, 'codex');
  await writeFile(
    codexPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "exec" ]; then',
      '  if [ -n "${REVIEW_ROUTER_TEST_CODEX_LOG:-}" ]; then echo "$*" >> "$REVIEW_ROUTER_TEST_CODEX_LOG"; fi',
      '  echo "review-router-codex-auth-ok"',
      '  exit 0',
      'fi',
      'echo "unexpected codex call: $*" >&2',
      'exit 2',
      '',
    ].join('\n')
  );
  await chmod(codexPath, 0o755);

  return { root, codexHome, binDir, refreshToken, legacyAuthFile, codexLog };
}

async function runSeedScript(
  fixture: {
    readonly root: string;
    readonly codexHome: string;
    readonly binDir: string;
    readonly codexLog?: string;
  },
  env: Record<string, string>
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return execFileAsync('bash', [seedScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
      HOME: fixture.root,
      REVIEW_ROUTER_CODEX_HOME: fixture.codexHome,
      REVIEW_ROUTER_TEST_CODEX_LOG: fixture.codexLog ?? '',
      PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
    },
  });
}
