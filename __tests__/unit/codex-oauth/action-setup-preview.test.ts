import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as core from '../../../src/actions/core';
import { runCodexOAuthRotatingRuntime } from '../../../src/codex-oauth/runtime';
import {
  runCodexOAuthRotatingAction,
  type CodexOAuthTerminalOutcomeReport,
} from '../../../src/codex-oauth/action';
import {
  CodexOAuthReviewRuntimeMode,
  CodexOAuthV2MergeGateFailureCode,
  CodexOAuthV2ReviewOutcome,
  CodexOAuthV2TerminalReason,
  type CodexOAuthV2ReviewResult,
  type CodexOAuthV2ReviewRunnerPort,
} from '../../../src/codex-oauth/runtime';
import { MergeGateConclusion } from '../../../src/review-projection/domain';
import {
  ReviewActionV2RuntimeMode,
  type ReviewActionV2Activation,
} from '../../../src/control-plane/review-action-v2-contract';

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
      post: jest.fn(
        async (_report: CodexOAuthTerminalOutcomeReport) => undefined
      ),
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
          '<!-- reviewrouter:codex-oauth:terminal:max-changed-lines-exceeded -->',
        dedupeKey: 'max_changed_lines_exceeded',
        body: expect.stringContaining(
          'ReviewRouter did not start a model review'
        ),
        stepSummary: expect.not.stringContaining('reviewrouter:codex-oauth'),
        commitStatus: {
          state: 'failure',
          description: 'Review skipped: PR exceeds configured safety limit.',
          context: 'ReviewRouter',
        },
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
        reason: CodexOAuthV2TerminalReason.RequiredProviderLaneBusy,
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
        commitStatus: {
          state: 'failure',
          description: 'Review delayed: provider lanes are busy.',
          context: 'ReviewRouter',
        },
      })
    );
  });

  it('reports unavailable revision reads as a retryable delayed outcome', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'completed',
      publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
      v2Review: {
        outcome: CodexOAuthV2ReviewOutcome.Failed,
        reason: CodexOAuthV2TerminalReason.RevisionGuardUnavailable,
        blockingFailure: 'review_action_v2_revision_guard_unavailable',
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
    expect(terminalOutcomeReporter.post).toHaveBeenCalledWith(
      expect.objectContaining({
        marker:
          '<!-- reviewrouter:codex-oauth:terminal:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:revision-unavailable -->',
        body: expect.stringContaining(
          'repository state temporarily unavailable'
        ),
        commitStatus: {
          state: 'failure',
          description:
            'Review delayed: repository state is temporarily unavailable.',
          context: 'ReviewRouter',
        },
      })
    );
  });

  it('reports rejected revision reads as a repository verification failure', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'completed',
      publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
      v2Review: {
        outcome: CodexOAuthV2ReviewOutcome.Failed,
        reason: CodexOAuthV2TerminalReason.RevisionGuardFailed,
        blockingFailure: 'review_action_v2_revision_guard_failed',
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
    expect(terminalOutcomeReporter.post).toHaveBeenCalledWith(
      expect.objectContaining({
        marker:
          '<!-- reviewrouter:codex-oauth:terminal:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:revision-failed -->',
        body: expect.stringContaining('repository revision validation failed'),
        commitStatus: {
          state: 'error',
          description:
            'Review failed: repository revision could not be verified.',
          context: 'ReviewRouter',
        },
      })
    );
  });

  it('reports exhausted provider capacity without disguising it as generic partial coverage', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'completed',
      publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
      v2Review: {
        outcome: CodexOAuthV2ReviewOutcome.Failed,
        reason: CodexOAuthV2TerminalReason.ProviderCapacityUnavailable,
        blockingFailure: 'provider_capacity_unavailable',
      },
    });
    process.env = {
      ...actionEnv({ eventPath, outputPath, headRef: 'feature/change' }),
      GITHUB_STEP_SUMMARY: stepSummaryPath,
    };
    const terminalOutcomeReporter = {
      post: jest.fn(async () => undefined),
    };

    await runCodexOAuthRotatingAction({
      reviewActionV2Activation: v2Activation(),
      terminalOutcomeReporter,
    });

    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(stepSummaryPath, 'utf8')).toContain(
      'Review unavailable'
    );
    expect(terminalOutcomeReporter.post).toHaveBeenCalledWith(
      expect.objectContaining({
        marker:
          '<!-- reviewrouter:codex-oauth:terminal:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:provider-capacity -->',
        body: expect.stringContaining(
          'provider capacity is temporarily unavailable'
        ),
        commitStatus: {
          state: 'failure',
          description: 'Review unavailable: provider capacity is exhausted.',
          context: 'ReviewRouter',
        },
      })
    );
  });

  it('reports generic partial coverage as incomplete and never as complete', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'completed',
      publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
      v2Review: {
        outcome: CodexOAuthV2ReviewOutcome.PartialCompleted,
        reason: CodexOAuthV2TerminalReason.RequiredReviewCoverageIncomplete,
        blockingFailure: 'required_review_coverage_incomplete',
      },
    });
    process.env = {
      ...actionEnv({ eventPath, outputPath, headRef: 'feature/change' }),
      GITHUB_STEP_SUMMARY: stepSummaryPath,
    };
    const terminalOutcomeReporter = {
      post: jest.fn(
        async (_report: CodexOAuthTerminalOutcomeReport) => undefined
      ),
    };

    await runCodexOAuthRotatingAction({
      reviewActionV2Activation: v2Activation(),
      terminalOutcomeReporter,
    });

    expect(process.exitCode).toBe(1);
    const report = terminalOutcomeReporter.post.mock.calls[0]?.[0];
    expect(report).toEqual(
      expect.objectContaining({
        marker:
          '<!-- reviewrouter:codex-oauth:terminal:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:partial -->',
        body: expect.stringContaining('Review incomplete'),
        commitStatus: {
          state: 'failure',
          description: 'Review incomplete: required coverage did not finish.',
          context: 'ReviewRouter',
        },
      })
    );
    expect(report?.body).not.toMatch(/Review complete(?:d)?/i);
  });

  it('reports superseded revisions as stale without publishing approval evidence', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'completed',
      publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
      v2Review: { outcome: CodexOAuthV2ReviewOutcome.Superseded },
    });
    process.env = {
      ...actionEnv({ eventPath, outputPath, headRef: 'feature/change' }),
      GITHUB_STEP_SUMMARY: stepSummaryPath,
    };
    const terminalOutcomeReporter = {
      post: jest.fn(async () => undefined),
    };

    await runCodexOAuthRotatingAction({
      reviewActionV2Activation: v2Activation(),
      terminalOutcomeReporter,
    });

    expect(process.exitCode).toBe(1);
    expect(terminalOutcomeReporter.post).toHaveBeenCalledWith(
      expect.objectContaining({
        marker:
          '<!-- reviewrouter:codex-oauth:terminal:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:stale -->',
        body: expect.stringContaining('newer PR revision exists'),
        commitStatus: {
          state: 'failure',
          description: 'Review superseded by a newer PR revision.',
          context: 'ReviewRouter',
        },
      })
    );
  });

  it.each([
    [
      {
        outcome: CodexOAuthV2ReviewOutcome.PublicationStale,
        reason: CodexOAuthV2TerminalReason.PublicationStale,
        blockingFailure: 'publication_request_revision_mismatch',
      } satisfies CodexOAuthV2ReviewResult,
      'publication-stale',
      'Review result stale',
    ],
    [
      {
        outcome: CodexOAuthV2ReviewOutcome.PublicationNotApplied,
        reason: CodexOAuthV2TerminalReason.PublicationConflict,
        blockingFailure: 'publication_request_conflict',
      } satisfies CodexOAuthV2ReviewResult,
      'publication-not-applied',
      'Review not published',
    ],
  ] as const)(
    'never clears warnings or publishes success for %s',
    async (v2Review, markerKind, expectedTitle) => {
      mockedRuntime.mockResolvedValue({
        status: 'completed',
        publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
        v2Review,
      });
      process.env = {
        ...actionEnv({ eventPath, outputPath, headRef: 'feature/change' }),
        GITHUB_STEP_SUMMARY: stepSummaryPath,
      };
      const terminalOutcomeReporter = {
        post: jest.fn(async () => undefined),
        clear: jest.fn(async () => undefined),
        status: jest.fn(async () => undefined),
      };

      await runCodexOAuthRotatingAction({
        reviewActionV2Activation: v2Activation(),
        terminalOutcomeReporter,
      });

      expect(process.exitCode).toBe(1);
      expect(terminalOutcomeReporter.clear).not.toHaveBeenCalled();
      expect(terminalOutcomeReporter.status).not.toHaveBeenCalled();
      expect(terminalOutcomeReporter.post).toHaveBeenCalledWith(
        expect.objectContaining({
          marker: `<!-- reviewrouter:codex-oauth:terminal:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:${markerKind} -->`,
          body: expect.stringContaining(expectedTitle),
          commitStatus: expect.objectContaining({ state: 'failure' }),
        })
      );
    }
  );

  it('wires verified v2 without exposing legacy comment capabilities', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'completed',
      publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
      v2Review: {
        outcome: CodexOAuthV2ReviewOutcome.Completed,
        mergeGateConclusion: MergeGateConclusion.Pass,
      },
    });
    process.env = {
      ...actionEnv({
        eventPath,
        outputPath,
        headRef: 'feature/change',
      }),
      GITHUB_RUN_ID: '123456789',
      GITHUB_SERVER_URL: 'https://github.example.com',
    };
    const v2ReviewRunner: CodexOAuthV2ReviewRunnerPort = {
      run: jest.fn(
        async (): Promise<CodexOAuthV2ReviewResult> => ({
          outcome: CodexOAuthV2ReviewOutcome.Completed,
          mergeGateConclusion: MergeGateConclusion.Pass,
        })
      ),
    };
    const terminalOutcomeReporter = {
      post: jest.fn(async () => undefined),
      clear: jest.fn(async () => undefined),
      status: jest.fn(async () => undefined),
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
      terminalOutcomeReporter,
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
    expect(terminalOutcomeReporter.post).not.toHaveBeenCalled();
    expect(terminalOutcomeReporter.clear).toHaveBeenCalledWith({
      reason: 'review_completed',
    });
    expect(terminalOutcomeReporter.status).toHaveBeenCalledWith({
      state: 'success',
      description: 'Review completed.',
      context: 'ReviewRouter',
      targetUrl:
        'https://github.example.com/Padelapp-Club/monitoring-service/actions/runs/123456789',
    });
    expect(process.exitCode).toBeUndefined();
    expect(fs.readFileSync(outputPath, 'utf8')).toContain(
      'reviewrouter_v2_outcome'
    );
  });

  it.each([
    [
      MergeGateConclusion.Fail,
      CodexOAuthV2MergeGateFailureCode.Failed,
      'Review completed with blocking findings.',
    ],
    [
      MergeGateConclusion.Inconclusive,
      CodexOAuthV2MergeGateFailureCode.Inconclusive,
      'Review completed with an inconclusive merge gate.',
    ],
    [
      undefined,
      CodexOAuthV2MergeGateFailureCode.Missing,
      'Review completed without a merge gate conclusion.',
    ],
  ])(
    'fails the workflow after completed publication for merge gate %s',
    async (mergeGateConclusion, failureCode, description) => {
      const v2Review = (mergeGateConclusion === undefined
        ? { outcome: CodexOAuthV2ReviewOutcome.Completed }
        : {
            outcome: CodexOAuthV2ReviewOutcome.Completed,
            mergeGateConclusion,
          }) as unknown as CodexOAuthV2ReviewResult;
      mockedRuntime.mockResolvedValue({
        status: 'completed',
        publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
        v2Review,
      });
      process.env = {
        ...actionEnv({
          eventPath,
          outputPath,
          headRef: 'feature/change',
        }),
        GITHUB_RUN_ID: '123456789',
        GITHUB_SERVER_URL: 'https://github.example.com',
      };
      const terminalOutcomeReporter = {
        post: jest.fn(async () => undefined),
        clear: jest.fn(async () => undefined),
        status: jest.fn(async () => undefined),
      };
      const setFailed = jest.spyOn(core, 'setFailed');

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

      expect(terminalOutcomeReporter.clear).toHaveBeenCalledWith({
        reason: 'review_completed',
      });
      expect(terminalOutcomeReporter.status).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'failure', description })
      );
      expect(process.exitCode).toBe(1);
      expect(setFailed).toHaveBeenCalledWith(failureCode);
      expect(fs.readFileSync(outputPath, 'utf8')).toContain(
        'reviewrouter_v2_outcome'
      );
    }
  );

  it('uses the production T0 runner when no test runner is injected', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'completed',
      publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
      v2Review: {
        outcome: CodexOAuthV2ReviewOutcome.Completed,
        mergeGateConclusion: MergeGateConclusion.Pass,
      },
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

function v2Activation(): ReviewActionV2Activation {
  return {
    mode: ReviewActionV2RuntimeMode.T0,
    handoff: {
      saasSourceCommit: 'a'.repeat(40),
      expectedPublicActionBaseCommit: 'b'.repeat(40),
      schemaDigest: 'c'.repeat(64),
      canonicalizerDigest: 'd'.repeat(64),
      goldenFixtureDigest: 'e'.repeat(64),
      generatedFileCount: 8,
    },
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
