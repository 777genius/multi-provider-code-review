import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCodexOAuthRotatingRuntime } from '../../../src/codex-oauth/runtime';
import { runCodexOAuthRotatingAction } from '../../../src/codex-oauth/action';
import {
  CodexOAuthReviewRuntimeMode,
  CodexOAuthV2ReviewOutcome,
} from '../../../src/codex-oauth/runtime';
import { ReviewActionV2RuntimeMode } from '../../../src/control-plane/review-action-v2-contract';

jest.mock('../../../src/codex-oauth/runtime', () => ({
  ...jest.requireActual('../../../src/codex-oauth/runtime'),
  runCodexOAuthRotatingRuntime: jest.fn(),
}));

const mockedRuntime = runCodexOAuthRotatingRuntime as jest.MockedFunction<
  typeof runCodexOAuthRotatingRuntime
>;

describe('Codex OAuth rotating setup PR preview', () => {
  const originalEnv = process.env;
  let tempDir: string;
  let eventPath: string;
  let outputPath: string;

  beforeEach(() => {
    process.exitCode = undefined;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-codex-preview-'));
    eventPath = path.join(tempDir, 'event.json');
    outputPath = path.join(tempDir, 'output');
    mockedRuntime.mockReset();
    mockedRuntime.mockResolvedValue({
      status: 'skipped',
      reason: 'stale_queued_secret',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
    process.exitCode = undefined;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('skips setup PR preview before the Codex auth secret is configured', async () => {
    process.env = actionEnv({
      eventPath,
      outputPath,
      headRef: 'reviewrouter/setup',
    });

    await runCodexOAuthRotatingAction();

    expect(mockedRuntime).not.toHaveBeenCalled();
    expect(fs.readFileSync(outputPath, 'utf8')).toContain(
      'reviewrouter_skipped_reason'
    );
    expect(fs.readFileSync(outputPath, 'utf8')).toContain(
      'setup_pr_waiting_for_codex_auth'
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('does not skip ordinary pull requests when the Codex auth secret is missing', async () => {
    process.env = actionEnv({
      eventPath,
      outputPath,
      headRef: 'feature/change',
    });

    await runCodexOAuthRotatingAction();

    expect(mockedRuntime).toHaveBeenCalledTimes(1);
    const [runtimeInput, runtimePorts] = mockedRuntime.mock.calls[0];
    expect(runtimeInput.workspacePath).toBe(process.env.GITHUB_WORKSPACE);
    expect(runtimeInput).not.toHaveProperty('reviewMode');
    expect(runtimePorts.controlPlane).toHaveProperty('commentToken');
    expect(runtimePorts).toHaveProperty('comments');
    expect(runtimePorts).toHaveProperty('review');
    expect(runtimePorts).not.toHaveProperty('v2Review');
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(outputPath, 'utf8')).toContain(
      'stale_queued_secret'
    );
  });

  it('does not skip setup PR preview when Codex auth is already configured', async () => {
    process.env = {
      ...actionEnv({
        eventPath,
        outputPath,
        headRef: 'reviewrouter/setup',
      }),
      INPUT_AUTH_JSON: JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { refresh_token: 'refresh-token' },
      }),
    };

    await runCodexOAuthRotatingAction();

    expect(mockedRuntime).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it('fails closed when runtime skips after setup because review did not run', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'skipped',
      reason: 'permission_required',
    });
    process.env = actionEnv({
      eventPath,
      outputPath,
      headRef: 'feature/change',
    });

    await runCodexOAuthRotatingAction();

    expect(mockedRuntime).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(outputPath, 'utf8')).toContain(
      'permission_required'
    );
  });

  it('reports a server-authoritative size skip without failing the workflow', async () => {
    mockedRuntime.mockImplementation(async () => {
      expect(process.env['INPUT_OPENROUTER-API-KEY']).toBe(
        'provider-secret-not-read-before-admission'
      );
      return {
        status: 'skipped',
        reason: 'max_changed_lines_exceeded',
        changedLines: 346_978,
        maxChangedLines: 250_000,
        decisionHash: 'a'.repeat(64),
      };
    });
    process.env = {
      ...actionEnv({
        eventPath,
        outputPath,
        headRef: 'feature/change',
      }),
      'INPUT_OPENROUTER-API-KEY': 'provider-secret-not-read-before-admission',
    };

    await runCodexOAuthRotatingAction();

    expect(mockedRuntime).toHaveBeenCalledTimes(1);
    expect(mockedRuntime.mock.calls[0]![0]).toMatchObject({
      pullRequestNumber: 1,
    });
    expect(process.exitCode).toBeUndefined();
    expect(fs.readFileSync(outputPath, 'utf8')).toContain(
      'max_changed_lines_exceeded'
    );
  });

  it('wires verified v2 without exposing legacy comment capabilities', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'completed',
      publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
      v2Review: { outcome: CodexOAuthV2ReviewOutcome.Completed },
    });
    process.env = actionEnv({
      eventPath,
      outputPath,
      headRef: 'feature/change',
    });
    const v2ReviewRunner = {
      run: jest.fn(async () => ({
        outcome: CodexOAuthV2ReviewOutcome.Completed,
      })),
    };

    await runCodexOAuthRotatingAction({
      reviewActionV2Activation: {
        mode: ReviewActionV2RuntimeMode.T0,
        handoff: {
          saasSourceCommit: 'a'.repeat(40),
          expectedPublicActionBaseCommit: 'b'.repeat(40),
          schemaDigest: 'c'.repeat(64),
          canonicalizerDigest: 'd'.repeat(64),
          goldenFixtureDigest: 'e'.repeat(64),
          generatedFileCount: 8,
        },
      },
      v2ReviewRunner,
    });

    expect(mockedRuntime).toHaveBeenCalledTimes(1);
    const [runtimeInput, runtimePorts] = mockedRuntime.mock.calls[0];
    expect(runtimeInput.reviewMode).toBe(
      CodexOAuthReviewRuntimeMode.ServerPublishedV2
    );
    expect(runtimeInput.workspacePath).not.toBe(process.env.GITHUB_WORKSPACE);
    expect(path.dirname(runtimeInput.workspacePath)).toBe(
      fs.realpathSync(process.env.RUNNER_TEMP!)
    );
    expect(fs.existsSync(runtimeInput.workspacePath)).toBe(false);
    expect(runtimePorts.controlPlane).not.toHaveProperty('commentToken');
    expect(runtimePorts).not.toHaveProperty('comments');
    expect(runtimePorts).not.toHaveProperty('review');
    expect(runtimePorts).toHaveProperty('v2Review', v2ReviewRunner);
    expect(process.exitCode).toBeUndefined();
    expect(fs.readFileSync(outputPath, 'utf8')).toContain(
      'reviewrouter_v2_outcome'
    );
  });

  it('uses the production T0 runner when no test runner is injected', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'completed',
      publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
      v2Review: { outcome: CodexOAuthV2ReviewOutcome.Completed },
    });
    process.env = actionEnv({
      eventPath,
      outputPath,
      headRef: 'feature/change',
    });

    await runCodexOAuthRotatingAction({
      reviewActionV2Activation: {
        mode: ReviewActionV2RuntimeMode.T0,
        handoff: {
          saasSourceCommit: 'a'.repeat(40),
          expectedPublicActionBaseCommit: 'b'.repeat(40),
          schemaDigest: 'c'.repeat(64),
          canonicalizerDigest: 'd'.repeat(64),
          goldenFixtureDigest: 'e'.repeat(64),
          generatedFileCount: 8,
        },
      },
    });

    const [, runtimePorts] = mockedRuntime.mock.calls[0];
    expect('v2Review' in runtimePorts).toBe(true);
    if (!('v2Review' in runtimePorts)) {
      throw new Error('expected production v2 review runner');
    }
    expect(runtimePorts.v2Review).toEqual(
      expect.objectContaining({ run: expect.any(Function) })
    );
    expect(runtimePorts.controlPlane).not.toHaveProperty('commentToken');
    expect(runtimePorts).not.toHaveProperty('comments');
    expect(runtimePorts).not.toHaveProperty('review');
  });
});

function actionEnv(input: {
  readonly eventPath: string;
  readonly outputPath: string;
  readonly headRef: string;
}): NodeJS.ProcessEnv {
  fs.writeFileSync(
    input.eventPath,
    JSON.stringify({
      repository: { full_name: 'Padelapp-Club/monitoring-service' },
      pull_request: {
        number: 1,
        head: {
          ref: input.headRef,
          repo: { full_name: 'Padelapp-Club/monitoring-service' },
          sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      },
    })
  );

  return {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: input.eventPath,
    GITHUB_OUTPUT: input.outputPath,
    GITHUB_REPOSITORY: 'Padelapp-Club/monitoring-service',
    GITHUB_WORKSPACE: ensureDirectory(
      path.join(path.dirname(input.eventPath), 'github-workspace')
    ),
    RUNNER_TEMP: ensureDirectory(
      path.join(path.dirname(input.eventPath), 'runner-temp')
    ),
    'INPUT_API-URL': 'https://api.reviewrouter.site',
    'INPUT_PROVIDER-INSTANCE-ID': 'codex-rotating:1196598615',
    'INPUT_WORKFLOW-SCHEMA-VERSION': '1',
  };
}

function ensureDirectory(directory: string): string {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}
