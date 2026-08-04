import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

const repoRoot = path.resolve(__dirname, '../..');
const workflowPath = path.join(
  repoRoot,
  '.github/workflows/reviewrouter-execution-reusable.yml'
);
const actionPath = path.join(repoRoot, 'action.yml');
const preloadPath = path.join(
  __dirname,
  'production-entrypoint-artifact-preload.cjs'
);
const runtimeConfigSentinel = '987654321';
const fakeGitHubPublicKey = 'dh2I7IMEE5Gd/p1NHVbxfmU8jJlAgt9bE3uQoK5u33Q=';

type WorkflowStep = Readonly<{
  name?: string;
  run?: string;
}>;

type WorkflowDocument = Readonly<{
  jobs?: Readonly<
    Record<
      string,
      Readonly<{
        steps?: readonly WorkflowStep[];
      }>
    >
  >;
}>;

type ActionDocument = Readonly<{
  runs?: Readonly<{
    main?: string;
  }>;
}>;

type SmokeWitness = Readonly<{
  artifactPath: string;
  artifactSha256: string;
  expectedActionVersion: string;
  failure?: string;
  networkGuardsInstalled: boolean;
  runtimeConfig?: Readonly<{
    actionVersion: string;
    configVersion: number;
    providerLimit: string;
  }>;
  investigationRollout?: Readonly<{
    recording: string | null;
    shadow: string | null;
    contextCritic: string | null;
    verifiedClean: string | null;
    crossRevisionReplay: string | null;
    productionEffects: string | null;
  }>;
  calls: readonly Readonly<{
    method: string;
    origin: string;
    pathname: string;
  }>[];
}>;

describe('committed production entrypoint artifact', () => {
  jest.setTimeout(30_000);

  it('provisions runtime config into the production runner without real I/O', () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'reviewrouter-entrypoint-smoke-')
    );

    try {
      const runtimeArgument = readCommittedT0RuntimeArgument();
      assertPublicActionLauncherTargetsRuntime();

      const artifactPath = path.join(
        repoRoot,
        runtimeArgument.replace(/^\.reviewrouter-runtime\//, '')
      );
      const artifactSha256 = sha256(fs.readFileSync(artifactPath));
      const actionVersion = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
      }).trim();
      expect(actionVersion).toMatch(/^[a-f0-9]{40}$/);
      expect(
        execFileSync(
          'git',
          [
            'ls-files',
            '--error-unmatch',
            path.relative(repoRoot, artifactPath),
          ],
          { cwd: repoRoot, encoding: 'utf8' }
        ).trim()
      ).toBe('dist/index.js');

      const githubWorkspace = ensureDirectory(
        path.join(tempRoot, 'github-workspace')
      );
      const runnerTemp = ensureDirectory(path.join(tempRoot, 'runner-temp'));
      const home = ensureDirectory(path.join(tempRoot, 'home'));
      fs.symlinkSync(
        repoRoot,
        path.join(githubWorkspace, '.reviewrouter-runtime'),
        'dir'
      );

      const eventPath = path.join(tempRoot, 'event.json');
      const outputPath = path.join(tempRoot, 'github-output');
      const witnessPath = path.join(tempRoot, 'witness.json');
      const codexLogPath = path.join(tempRoot, 'codex.log');
      const gitLogPath = path.join(tempRoot, 'git.log');
      const fakeBin = ensureDirectory(path.join(tempRoot, 'fake-bin'));
      const fakeCodexPath = path.join(fakeBin, 'codex');
      const fakeGitPath = path.join(fakeBin, 'git');

      fs.writeFileSync(
        eventPath,
        JSON.stringify({
          repository: { full_name: 'sandbox/repository' },
          pull_request: {
            number: 17,
            head: {
              ref: 'artifact-smoke',
              repo: { full_name: 'sandbox/repository' },
              sha: 'a'.repeat(40),
            },
          },
        })
      );
      fs.writeFileSync(outputPath, '');
      writeFakeCodex(fakeCodexPath, codexLogPath);
      writeFakeGit(fakeGitPath, gitLogPath);

      const result = spawnSync(process.execPath, [runtimeArgument], {
        cwd: githubWorkspace,
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
          HOME: home,
          NODE_OPTIONS: `--require=${preloadPath}`,
          CI: 'true',
          GITHUB_ACTIONS: 'true',
          GITHUB_EVENT_NAME: 'pull_request',
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: outputPath,
          GITHUB_REPOSITORY: 'sandbox/repository',
          GITHUB_WORKSPACE: githubWorkspace,
          RUNNER_TEMP: runnerTemp,
          REVIEWROUTER_ACTION_V2_MODE: 't0',
          REVIEWROUTER_ACTION_VERSION: actionVersion,
          REVIEWROUTER_API_URL: 'https://control-plane.reviewrouter.test',
          REVIEWROUTER_CONTROL_PLANE_URL:
            'https://control-plane.reviewrouter.test',
          REVIEWROUTER_OIDC_AUDIENCE: 'reviewrouter',
          REVIEWROUTER_RUNTIME_CONFIG_MODE: 'oidc',
          REVIEWROUTER_STATIC_CONFIG_FALLBACK: 'false',
          REVIEWROUTER_CODEX_BINARY: fakeCodexPath,
          REVIEW_ROUTER_MODE: 'codex-oauth-rotating',
          INPUT_API_URL: 'https://control-plane.reviewrouter.test',
          INPUT_CONTROL_PLANE_URL: 'https://control-plane.reviewrouter.test',
          INPUT_PROVIDER_INSTANCE_ID: 'codex-rotating:artifact-smoke',
          INPUT_WORKFLOW_SCHEMA_VERSION: '1',
          INPUT_AUTH_JSON: JSON.stringify({
            auth_mode: 'chatgpt',
            tokens: { refresh_token: 'fake-refresh-token' },
            last_refresh: '2026-08-04T00:00:00.000Z',
          }),
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fake-oidc-request-token',
          ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.actions.test/token',
          RR_ARTIFACT_SMOKE_EXPECTED_ACTION_VERSION: actionVersion,
          RR_ARTIFACT_SMOKE_EXPECTED_ARTIFACT: artifactPath,
          RR_ARTIFACT_SMOKE_EXPECTED_ARTIFACT_SHA256: artifactSha256,
          RR_ARTIFACT_SMOKE_PUBLIC_KEY: fakeGitHubPublicKey,
          RR_ARTIFACT_SMOKE_WITNESS_PATH: witnessPath,
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        'ReviewRouter runtime config applied (version 4242).'
      );
      expect(result.stdout).toContain('Review failed [configuration_invalid]');
      expect(result.stdout).toContain(`Received: ${runtimeConfigSentinel}`);

      const witness = JSON.parse(
        fs.readFileSync(witnessPath, 'utf8')
      ) as SmokeWitness;
      expect(witness).toMatchObject({
        artifactPath: fs.realpathSync(artifactPath),
        artifactSha256,
        expectedActionVersion: actionVersion,
        networkGuardsInstalled: true,
        runtimeConfig: {
          actionVersion,
          configVersion: 4242,
          providerLimit: runtimeConfigSentinel,
        },
        investigationRollout: {
          recording: '1',
          shadow: '1',
          contextCritic: '1',
          verifiedClean: '1',
          crossRevisionReplay: '1',
          productionEffects: '1',
        },
      });
      expect(witness.failure).toBeUndefined();
      expect(
        witness.calls.map(
          (call) => `${call.method} ${call.origin}${call.pathname}`
        )
      ).toEqual([
        'GET https://oidc.actions.test/token',
        'POST https://control-plane.reviewrouter.test/api/action/v1/codex-oauth/prelease',
        'POST https://control-plane.reviewrouter.test/api/action/v1/codex-oauth/finalize',
        'GET https://api.github.com/repos/sandbox/repository/actions/secrets/public-key',
        'POST https://control-plane.reviewrouter.test/api/action/v1/codex-oauth/writeback-preflight',
        'POST https://control-plane.reviewrouter.test/api/action/v1/codex-oauth/writeback',
        'POST https://control-plane.reviewrouter.test/api/action/v1/codex-oauth/checkout-token',
        'GET https://oidc.actions.test/token',
        'POST https://control-plane.reviewrouter.test/api/action/v1/session/exchange',
        'GET https://control-plane.reviewrouter.test/api/action/v1/config',
      ]);
      expect(readLog(codexLogPath)).toEqual(['version', 'login-status']);
      expect(readLog(gitLogPath)).toEqual([
        'init',
        'config',
        'config',
        'config',
        'remote',
        'fetch',
        'checkout',
      ]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

function readCommittedT0RuntimeArgument(): string {
  const workflow = yaml.load(fs.readFileSync(workflowPath, 'utf8'), {
    schema: yaml.JSON_SCHEMA,
  }) as WorkflowDocument;
  const step = workflow.jobs?.review?.steps?.find(
    (candidate) => candidate.name === 'Run ReviewRouter T0'
  );
  const match = /^node (\.reviewrouter-runtime\/dist\/index\.js)$/.exec(
    step?.run ?? ''
  );

  expect(match).not.toBeNull();
  return match![1];
}

function assertPublicActionLauncherTargetsRuntime(): void {
  const action = yaml.load(fs.readFileSync(actionPath, 'utf8'), {
    schema: yaml.JSON_SCHEMA,
  }) as ActionDocument;
  const launcher = action.runs?.main;

  expect(launcher).toBe('action-dist/index.cjs');
  expect(
    execFileSync('git', ['ls-files', '--error-unmatch', launcher!], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim()
  ).toBe(launcher);
  expect(fs.readFileSync(path.join(repoRoot, launcher!), 'utf8')).toContain(
    '(actionPath, "dist", "index.js")'
  );
}

function writeFakeCodex(filePath: string, logPath: string): void {
  writeExecutable(
    filePath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const invocation = args.includes('--version')
  ? 'version'
  : args[0] === 'login' && args[1] === 'status'
    ? 'login-status'
    : 'unexpected';
fs.appendFileSync(${JSON.stringify(logPath)}, invocation + '\\n');
if (invocation === 'version') console.log('codex-artifact-smoke 0.0.0');
process.exitCode = invocation === 'unexpected' ? 97 : 0;
`
  );
}

function writeFakeGit(filePath: string, logPath: string): void {
  writeExecutable(
    filePath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const operation = ['init', 'config', 'remote', 'fetch', 'checkout'].find((name) =>
  args.includes(name)
) || 'unexpected';
fs.appendFileSync(${JSON.stringify(logPath)}, operation + '\\n');
if (operation === 'init') fs.mkdirSync(path.join(process.cwd(), '.git'), { recursive: true });
process.exitCode = operation === 'unexpected' ? 98 : 0;
`
  );
}

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function ensureDirectory(directory: string): string {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function readLog(filePath: string): string[] {
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
