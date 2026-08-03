import {
  createScmReadTokenProvider,
  mapOrchestrationResultToCodexOutcome,
  mapRevisionGuardErrorToCodexOutcome,
  planAssignments,
  resolveT0AttemptBudget,
} from '../../../src/review-orchestration/infrastructure/production-t0-review-runner';
import {
  ReviewExecutionProviderKind,
  ReviewOrchestrationResultStatus,
} from '../../../src/review-orchestration/application';
import { CodexOAuthV2ReviewOutcome } from '../../../src/codex-oauth/runtime';
import type { PRContext, ReviewConfig } from '../../../src/types';
import { compareCodeUnits } from '../../../src/review-orchestration/infrastructure/production-review-projection';

describe('ProductionT0ReviewRunner policy', () => {
  it('treats providerRetries as the total provider attempt budget', () => {
    expect(resolveT0AttemptBudget(3, 10)).toBe(3);
    expect(resolveT0AttemptBudget(0, 10)).toBe(1);
  });

  it('caps the configured total attempts at the protocol maximum', () => {
    expect(resolveT0AttemptBudget(5, 2)).toBe(2);
  });

  it('never re-merges token-safe groups after max work slots', () => {
    const pr = pullRequest(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    const planned = planAssignments({
      authorization: authorization(1),
      pr,
      config: {
        providers: ['codex/gpt-test'],
        batchMaxFiles: 1,
        enableTokenAwareBatching: false,
        providerRetries: 1,
      } as ReviewConfig,
      providerName: 'codex/gpt-test',
      compatibilityKey: '7'.repeat(64),
      lifecycleTargets: [],
      liveLifecycleStateHash: '8'.repeat(64),
    });

    expect(planned.assignments).toHaveLength(1);
    expect(planned.assignments[0].context.files).toHaveLength(1);
    expect(planned.uncoveredPaths).toHaveLength(2);
    expect(
      new Set([
        planned.assignments[0].context.files[0].filename,
        ...planned.uncoveredPaths,
      ])
    ).toEqual(new Set(pr.files.map((file) => file.filename)));
  });

  it('uses locale-independent code-unit ordering for v2 projection inputs', () => {
    expect(['ä', 'z', 'A'].sort(compareCodeUnits)).toEqual(['A', 'z', 'ä']);
  });

  it('does not fail the action when publication was safely not applied', () => {
    for (const status of [
      ReviewOrchestrationResultStatus.PublicationNotApplied,
      ReviewOrchestrationResultStatus.PublicationStale,
    ]) {
      expect(mapOrchestrationResultToCodexOutcome({ status })).toEqual({
        outcome: CodexOAuthV2ReviewOutcome.Completed,
      });
    }
  });

  it('keeps incomplete required partial coverage blocking', () => {
    expect(
      mapOrchestrationResultToCodexOutcome({
        status: ReviewOrchestrationResultStatus.PartialCompleted,
        failureCode: 'required_provider_lane_busy',
      })
    ).toEqual({
      outcome: CodexOAuthV2ReviewOutcome.PartialCompleted,
      blockingFailure: 'required_provider_lane_busy',
    });
  });

  it('keeps real orchestration failures blocking', () => {
    expect(
      mapOrchestrationResultToCodexOutcome({
        status: ReviewOrchestrationResultStatus.Failed,
        failureCode: 'provider_failed',
      })
    ).toEqual({
      outcome: CodexOAuthV2ReviewOutcome.PartialCompleted,
      blockingFailure: 'provider_failed',
    });
  });

  it('maps initial revision guard failures into terminal v2 outcomes', () => {
    for (const blockingFailure of [
      'review_action_v2_revision_guard_unavailable',
      'review_action_v2_revision_guard_failed',
    ]) {
      expect(
        mapRevisionGuardErrorToCodexOutcome(new Error(blockingFailure))
      ).toEqual({
        outcome: CodexOAuthV2ReviewOutcome.PartialCompleted,
        blockingFailure,
      });
    }
    expect(
      mapRevisionGuardErrorToCodexOutcome(new Error('unexpected_failure'))
    ).toBeUndefined();
  });

  it('refreshes an expiring SCM read capability before the next read', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const refresh = jest.fn(async () => ({
      token: 'ghs_refreshed',
      expiresAt: '2026-08-03T13:00:00.000Z',
    }));
    const provider = createScmReadTokenProvider({
      token: 'ghs_expiring',
      expiresAt: '2026-08-03T12:00:20.000Z',
      refresh,
    });

    await expect(provider.getToken()).resolves.toBe('ghs_refreshed');
    await expect(provider.getToken()).resolves.toBe('ghs_refreshed');
    expect(refresh).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('coalesces concurrent SCM token refreshes', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const refresh = jest.fn(async () => ({
      token: 'ghs_refreshed',
      expiresAt: '2026-08-03T13:00:00.000Z',
    }));
    const provider = createScmReadTokenProvider({
      token: 'ghs_expiring',
      expiresAt: '2026-08-03T12:00:20.000Z',
      refresh,
    });

    await expect(
      Promise.all([provider.getToken(), provider.getToken()])
    ).resolves.toEqual(['ghs_refreshed', 'ghs_refreshed']);
    expect(refresh).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('rejects stale refreshed SCM capabilities as temporarily unavailable', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const provider = createScmReadTokenProvider({
      token: 'ghs_expiring',
      expiresAt: '2026-08-03T12:00:20.000Z',
      refresh: jest.fn(async () => ({
        token: 'ghs_still_expiring',
        expiresAt: '2026-08-03T12:00:25.000Z',
      })),
    });

    await expect(provider.getToken()).rejects.toThrow(
      'review_action_v2_revision_guard_unavailable'
    );
    jest.useRealTimers();
  });

  it('normalizes SCM token refresh errors for terminal reporting', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const provider = createScmReadTokenProvider({
      token: 'ghs_expiring',
      expiresAt: '2026-08-03T12:00:20.000Z',
      refresh: jest.fn(async () => {
        throw new Error('control_plane_unavailable');
      }),
    });

    await expect(provider.getToken()).rejects.toThrow(
      'review_action_v2_revision_guard_unavailable'
    );
    jest.useRealTimers();
  });

  it('distinguishes permanent and transient SCM token endpoint failures', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const providerFor = (message: string) =>
      createScmReadTokenProvider({
        token: 'ghs_expiring',
        expiresAt: '2026-08-03T12:00:20.000Z',
        refresh: jest.fn(async () => {
          throw new Error(message);
        }),
      });

    await expect(
      providerFor(
        'codex_oauth_control_plane_error:403:permission_required'
      ).getToken()
    ).rejects.toThrow('review_action_v2_revision_guard_failed');
    for (const status of [429, 503]) {
      await expect(
        providerFor(
          `codex_oauth_control_plane_error:${status}:temporarily_unavailable`
        ).getToken()
      ).rejects.toThrow('review_action_v2_revision_guard_unavailable');
    }
    jest.useRealTimers();
  });
});

function authorization(maxWorkSlots: number) {
  return {
    authorizationId: 'authorization-1',
    authorizationToken: 'token',
    producerReleaseId: 'release-1',
    protocolLimitsProfileId: 'limits-1',
    operationalSloProfileId: 'slo-1',
    mutationEpoch: '1',
    expiresAt: '2026-07-24T00:00:00.000Z',
    limits: {
      maxWorkSlots,
      maxAttemptsPerSlot: 3,
      maxObservationBytes: 100_000,
      maxObservationFindings: 100,
      maxProjectionBytes: 100_000,
      maxProjectionFindings: 100,
      maxPublicationOperations: 100,
      maxPublicationChunks: 10,
      maxPublicationBodyBytes: 100_000,
      maxRequestBatchSize: 10,
      maxLeaseDurationMs: 60_000,
      maxResultReportDurationMs: 60_000,
      maxReconciliationDurationMs: 60_000,
    },
    facts: {
      workspaceId: 'workspace-1',
      repositoryConnectionId: 'connection-1',
      scmRepositoryIdentityId: 'repo-1',
      pullRequestNumber: 1,
      sourceRunId: 'run-1',
      sourceRunAttempt: '1',
      baseSha: '1'.repeat(40),
      mergeBaseSha: '2'.repeat(40),
      headSha: '3'.repeat(40),
      reviewRevisionHash: '4'.repeat(64),
      trustDomain: 'github-actions',
      producerReleaseId: 'release-1',
      selectedProtocolVersion: '2',
      schemaDigest: '5'.repeat(64),
      providerVoteLanes: [
        {
          providerKind: ReviewExecutionProviderKind.Codex,
          providerVoteIdentityHash: '6'.repeat(64),
        },
      ],
    },
  };
}

function pullRequest(paths: string[]): PRContext {
  const files = paths.map((filename) => ({
    filename,
    status: 'modified' as const,
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: '@@ -1 +1 @@\n+changed',
  }));
  return {
    number: 1,
    title: 'Bounded batches',
    body: '',
    author: 'reviewer',
    draft: false,
    labels: [],
    files,
    diff: files
      .map(
        (file) =>
          `diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n@@ -1 +1 @@\n+changed`
      )
      .join('\n'),
    additions: files.length,
    deletions: 0,
    baseSha: '1'.repeat(40),
    headSha: '3'.repeat(40),
  };
}
