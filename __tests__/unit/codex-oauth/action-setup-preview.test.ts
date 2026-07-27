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
  let stepSummaryPath: string;

  beforeEach(() => {
    process.exitCode = undefined;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-codex-preview-'));
    eventPath = path.join(tempDir, 'event.json');
    outputPath = path.join(tempDir, 'output');
    stepSummaryPath = path.join(tempDir, 'step-summary.md');
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
      GITHUB_STEP_SUMMARY: stepSummaryPath,
      'INPUT_OPENROUTER-API-KEY': 'provider-secret-not-read-before-admission',
    };
    const terminalOutcomeReporter = {
      post: jest.fn(async () => undefined),
    };

    await runCodexOAuthRotatingAction({ terminalOutcomeReporter });

    expect(mockedRuntime).toHaveBeenCalledTimes(1);
    expect(mockedRuntime.mock.calls[0]![0]).toMatchObject({
      pullRequestNumber: 1,
    });
    expect(process.exitCode).toBeUndefined();
    expect(fs.readFileSync(outputPath, 'utf8')).toContain(
      'max_changed_lines_exceeded'
    );
    expect(fs.readFileSync(stepSummaryPath, 'utf8')).toContain(
      'Review skipped'
    );
    expect(fs.readFileSync(stepSummaryPath, 'utf8')).toContain('346,978');
    expect(terminalOutcomeReporter.post).toHaveBeenCalledWith(
      expect.objectContaining({
        marker:
          '<!-- reviewrouter:codex-oauth:terminal:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:skipped -->',
        body: expect.stringContaining(
          'ReviewRouter did not start a model review'
        ),
        stepSummary: expect.not.stringContaining('reviewrouter:codex-oauth'),
      })
    );
  });

  it('uses an OIDC request snapshot for terminal outcome reports after runtime cleanup', async () => {
    mockedRuntime.mockImplementation(async (_input, ports) => {
      expect(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe(
        'runner-oidc-request-token'
      );
      if (!ports.lifecycle?.clearOidcEnv) {
        throw new Error('expected lifecycle OIDC cleanup port');
      }
      ports.lifecycle.clearOidcEnv();
      expect(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
      expect(process.env.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
      return {
        status: 'skipped',
        reason: 'max_changed_lines_exceeded',
        changedLines: 346_978,
        maxChangedLines: 250_000,
        decisionHash: 'a'.repeat(64),
      };
    });
    const fetchImpl = jest.fn(async (url, init) => {
      const urlText = String(url);
      if (urlText.startsWith('https://oidc.actions.example/token')) {
        expect((init?.headers as Record<string, string>).authorization).toBe(
          'Bearer runner-oidc-request-token'
        );
        return jsonResponse({ value: 'runner-oidc-token' });
      }
      if (
        urlText ===
        'https://api.reviewrouter.site/api/action/v1/session/exchange'
      ) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          oidcToken: 'runner-oidc-token',
          audience: 'reviewrouter',
        });
        return jsonResponse({
          protocolVersion: 1,
          sessionToken: 'action-session-token',
        });
      }
      if (
        urlText === 'https://api.reviewrouter.site/api/action/v1/comment-token'
      ) {
        expect((init?.headers as Record<string, string>).authorization).toBe(
          'Bearer action-session-token'
        );
        return jsonResponse({ protocolVersion: 1 });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    process.env = {
      ...actionEnv({
        eventPath,
        outputPath,
        headRef: 'feature/change',
      }),
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.actions.example/token',
      GITHUB_STEP_SUMMARY: stepSummaryPath,
    };

    await runCodexOAuthRotatingAction({ fetchImpl });

    expect(process.exitCode).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('https://oidc.actions.example/token'),
      expect.any(Object)
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.reviewrouter.site/api/action/v1/session/exchange',
      expect.any(Object)
    );
    expect(fs.readFileSync(stepSummaryPath, 'utf8')).toContain(
      'Review skipped'
    );
  });

  it('reports lane-busy partial v2 reviews as a clear terminal outcome', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'completed',
      publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
      v2Review: {
        outcome: CodexOAuthV2ReviewOutcome.PartialCompleted,
        blockingFailure: 'required_provider_lane_busy',
      },
    });
    process.env = {
      ...actionEnv({
        eventPath,
        outputPath,
        headRef: 'feature/change',
      }),
      GITHUB_STEP_SUMMARY: stepSummaryPath,
    };
    const terminalOutcomeReporter = {
      post: jest.fn(async () => undefined),
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
      terminalOutcomeReporter,
    });

    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(stepSummaryPath, 'utf8')).toContain(
      'Review delayed'
    );
    expect(terminalOutcomeReporter.post).toHaveBeenCalledWith(
      expect.objectContaining({
        marker:
          '<!-- reviewrouter:codex-oauth:terminal:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:lane-busy -->',
        body: expect.stringContaining('provider lanes were busy'),
      })
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

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
