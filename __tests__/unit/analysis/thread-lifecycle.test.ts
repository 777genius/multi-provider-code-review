import {
  countPreviousStillValidBySeverity,
  ThreadLifecycleAggregator,
  hasLifecycleUncertainty,
  reconcileCarriedFindingsWithLifecycle,
} from '../../../src/analysis/thread-lifecycle';
import {
  Finding,
  LifecycleTarget,
  ProviderLifecycleRevalidation,
  ProviderResult,
} from '../../../src/types';
import { findingFingerprintFromFinding } from '../../../src/github/comment-fingerprint';

const target = (overrides: Partial<LifecycleTarget> = {}): LifecycleTarget => ({
  targetId: 'rrt_target_1',
  threadId: 'thread-1',
  threadUrl: 'https://github.test/thread/1',
  fingerprint: 'a'.repeat(24),
  severity: 'major',
  title: 'Old bug',
  message: 'Old bug still matters',
  originalPath: 'src/app.ts',
  currentPath: 'src/app.ts',
  originalLine: 10,
  currentLine: 12,
  parentCommentId: 'comment-1',
  parentCommentUpdatedAt: '2026-05-14T00:00:00Z',
  threadCommentCount: 1,
  viewerCanResolve: true,
  hasHumanReply: false,
  trustedAuthor: true,
  ...overrides,
});

describe('semantic escalation lifecycle safety', () => {
  it('keeps a Minor parent open when the current finding escalates to Major', () => {
    const currentFinding: Finding = {
      file: 'src/app.ts',
      line: 12,
      severity: 'major',
      title: 'SQL injection in account lookup',
      message:
        'The query interpolates accountId directly into SQL and permits crafted input.',
    };

    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [
        target({
          severity: 'minor',
          title: 'SQL injection in account lookup',
          message:
            'The query interpolates accountId directly into SQL and permits crafted input.',
        }),
      ],
      plannedProviders: ['provider-a'],
      providerResults: [success('provider-a', [resolvedVote()])],
      currentFindings: [currentFinding],
    });

    expect(lifecycle.resolvedCandidates).toHaveLength(0);
    expect(lifecycle.previousStillValid[0]?.reasonCodes).toContain(
      'current_finding_present'
    );
  });
});

const success = (
  name: string,
  revalidations: ProviderLifecycleRevalidation[]
): ProviderResult => ({
  name,
  status: 'success',
  durationSeconds: 1,
  result: {
    content: '{}',
    revalidations,
  },
});

const resolvedVote = (
  targetId = 'rrt_target_1'
): ProviderLifecycleRevalidation => ({
  targetId,
  fingerprint: 'a'.repeat(24),
  verdict: 'resolved',
  confidence: 0.95,
  evidence: [
    {
      path: 'src/app.ts',
      startLine: 12,
      endLine: 12,
      reason: 'Current code validates the missing case.',
    },
  ],
  rationale: 'The old failure mode is gone.',
});

describe('ThreadLifecycleAggregator', () => {
  it('resolves in multi-provider mode only after two independent provider votes', () => {
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [target()],
      plannedProviders: ['provider-a', 'provider-b'],
      providerResults: [
        success('provider-a', [resolvedVote()]),
        success('provider-b', [resolvedVote()]),
      ],
      currentFindings: [],
    });

    expect(lifecycle.quorumMode).toBe('multi-provider');
    expect(lifecycle.resolvedCandidates).toHaveLength(1);
    expect(lifecycle.previousUncertain).toHaveLength(0);
  });

  it('resolves in single-provider mode after one valid resolved vote', () => {
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [target()],
      plannedProviders: ['provider-a'],
      providerResults: [success('provider-a', [resolvedVote()])],
      currentFindings: [],
    });

    expect(lifecycle.quorumMode).toBe('single-provider');
    expect(lifecycle.resolvedCandidates).toHaveLength(1);
    expect(lifecycle.previousUncertain).toHaveLength(0);
  });

  it('fails closed when lifecycle inventory failed even if resolved votes exist', () => {
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [target()],
      plannedProviders: ['provider-a', 'provider-b'],
      providerResults: [
        success('provider-a', [resolvedVote()]),
        success('provider-b', [resolvedVote()]),
      ],
      currentFindings: [],
      inventoryFailed: true,
    });

    expect(lifecycle.resolvedCandidates).toHaveLength(0);
    expect(lifecycle.previousUncertain[0].reasonCodes).toContain(
      'inventory_failed'
    );
    expect(lifecycle.warnings).toContain(
      'review thread lifecycle inventory failed'
    );
  });

  it('keeps the thread open when a multi-provider run has one resolved vote and one failed provider', () => {
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [target()],
      plannedProviders: ['provider-a', 'provider-b'],
      providerResults: [
        success('provider-a', [resolvedVote()]),
        {
          name: 'provider-b',
          status: 'error',
          error: new Error('failed'),
          durationSeconds: 1,
        },
      ],
      currentFindings: [],
    });

    expect(lifecycle.resolvedCandidates).toHaveLength(0);
    expect(lifecycle.previousUncertain[0].reasonCodes).toEqual(
      expect.arrayContaining([
        'provider_failed',
        'insufficient_resolved_quorum',
      ])
    );
  });

  it('keeps the thread open when a provider omits the assigned revalidation target', () => {
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [target()],
      plannedProviders: ['provider-a', 'provider-b'],
      providerResults: [
        success('provider-a', [resolvedVote()]),
        success('provider-b', []),
      ],
      currentFindings: [],
    });

    expect(lifecycle.resolvedCandidates).toHaveLength(0);
    expect(lifecycle.previousUncertain[0].reasonCodes).toEqual(
      expect.arrayContaining([
        'provider_missing_revalidation',
        'insufficient_resolved_quorum',
      ])
    );
  });

  it('downgrades resolved votes without concrete evidence to uncertain', () => {
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [target()],
      plannedProviders: ['provider-a', 'provider-b'],
      providerResults: [
        success('provider-a', [
          {
            ...resolvedVote(),
            evidence: [],
          },
        ]),
        success('provider-b', [resolvedVote()]),
      ],
      currentFindings: [],
    });

    expect(lifecycle.resolvedCandidates).toHaveLength(0);
    expect(lifecycle.previousUncertain[0].reasonCodes).toContain(
      'invalid_resolved_evidence'
    );
  });

  it('downgrades resolved votes with out-of-range confidence to uncertain', () => {
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [target()],
      plannedProviders: ['provider-a', 'provider-b'],
      providerResults: [
        success('provider-a', [
          {
            ...resolvedVote(),
            confidence: 95,
          },
        ]),
        success('provider-b', [resolvedVote()]),
      ],
      currentFindings: [],
    });

    expect(lifecycle.resolvedCandidates).toHaveLength(0);
    expect(lifecycle.previousUncertain[0].reasonCodes).toContain(
      'invalid_resolved_evidence'
    );
  });

  it('does not use out-of-range configured confidence thresholds', () => {
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [target()],
      plannedProviders: ['provider-a', 'provider-b'],
      providerResults: [
        success('provider-a', [
          {
            ...resolvedVote(),
            confidence: 0.5,
          },
        ]),
        success('provider-b', [
          {
            ...resolvedVote(),
            confidence: 0.5,
          },
        ]),
      ],
      currentFindings: [],
      config: {
        reviewThreadLifecycleResolveConfidence: {
          major: -1,
        },
      },
    });

    expect(lifecycle.resolvedCandidates).toHaveLength(0);
    expect(lifecycle.previousUncertain[0].reasonCodes).toContain(
      'invalid_resolved_evidence'
    );
  });

  it('uses untrusted_author as the manual reason without inventing a human reply', () => {
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [
        target({
          trustedAuthor: false,
          reasonCodes: ['untrusted_author'],
        }),
      ],
      plannedProviders: ['provider-a', 'provider-b'],
      providerResults: [
        success('provider-a', [resolvedVote()]),
        success('provider-b', [resolvedVote()]),
      ],
      currentFindings: [],
    });

    expect(lifecycle.manualAttention[0].reasonCodes).toContain(
      'untrusted_author'
    );
    expect(lifecycle.manualAttention[0].reasonCodes).not.toContain(
      'human_reply'
    );
  });

  it('lets a valid still_valid vote override an otherwise resolved quorum', () => {
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [target()],
      plannedProviders: ['provider-a', 'provider-b', 'provider-c'],
      providerResults: [
        success('provider-a', [resolvedVote()]),
        success('provider-b', [resolvedVote()]),
        success('provider-c', [
          {
            targetId: 'rrt_target_1',
            fingerprint: 'a'.repeat(24),
            verdict: 'still_valid',
            confidence: 0.9,
            evidence: [
              {
                path: 'src/app.ts',
                reason: 'The same unchecked branch remains.',
              },
            ],
            rationale: 'Still reachable.',
          },
        ]),
      ],
      currentFindings: [],
    });

    expect(lifecycle.resolvedCandidates).toHaveLength(0);
    expect(lifecycle.previousStillValid[0].reasonCodes).toContain(
      'still_valid_vote'
    );
  });

  it('counts viewer-cannot-resolve targets as still valid when provider evidence says the old finding remains', () => {
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [
        target({
          viewerCanResolve: false,
          reasonCodes: ['viewer_cannot_resolve'],
        }),
      ],
      plannedProviders: ['provider-a'],
      providerResults: [
        success('provider-a', [
          {
            targetId: 'rrt_target_1',
            fingerprint: 'a'.repeat(24),
            verdict: 'still_valid',
            confidence: 0.9,
            evidence: [
              {
                path: 'src/app.ts',
                reason: 'The unchecked branch remains.',
              },
            ],
            rationale: 'Still reachable.',
          },
        ]),
      ],
      currentFindings: [],
    });

    expect(lifecycle.previousStillValid).toHaveLength(1);
    expect(countPreviousStillValidBySeverity(lifecycle).major).toBe(1);
    expect(lifecycle.manualAttention).toHaveLength(0);
  });

  it('keeps viewerCanResolve as advisory and attempts mutation when quorum exists', () => {
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [
        target({
          viewerCanResolve: false,
        }),
      ],
      plannedProviders: ['provider-a'],
      providerResults: [success('provider-a', [resolvedVote()])],
      currentFindings: [],
    });

    expect(lifecycle.resolvedCandidates).toHaveLength(1);
    expect(lifecycle.mutationSkipped).toHaveLength(0);
  });

  it('closes in three-provider mode when resolved quorum exists and the remaining provider is uncertain', () => {
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [target()],
      plannedProviders: ['provider-a', 'provider-b', 'provider-c'],
      providerResults: [
        success('provider-a', [resolvedVote()]),
        success('provider-b', [resolvedVote()]),
        success('provider-c', [
          {
            targetId: 'rrt_target_1',
            fingerprint: 'a'.repeat(24),
            verdict: 'uncertain',
            confidence: 0.4,
            evidence: [],
            rationale: 'The relevant code is outside context.',
          },
        ]),
      ],
      currentFindings: [],
    });

    expect(lifecycle.resolvedCandidates).toHaveLength(1);
    expect(lifecycle.previousUncertain).toHaveLength(0);
  });

  it('keeps a two-provider run open when resolved quorum is not reached because the second provider is uncertain', () => {
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [target()],
      plannedProviders: ['provider-a', 'provider-b'],
      providerResults: [
        success('provider-a', [resolvedVote()]),
        success('provider-b', [
          {
            targetId: 'rrt_target_1',
            fingerprint: 'a'.repeat(24),
            verdict: 'uncertain',
            confidence: 0.4,
            evidence: [],
            rationale: 'The relevant code is outside context.',
          },
        ]),
      ],
      currentFindings: [],
    });

    expect(lifecycle.resolvedCandidates).toHaveLength(0);
    expect(lifecycle.previousUncertain[0].reasonCodes).toContain(
      'provider_uncertain'
    );
  });

  it('does not let duplicate responses from one provider fake quorum', () => {
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [target()],
      plannedProviders: ['provider-a', 'provider-b'],
      providerResults: [
        success('provider-a', [resolvedVote()]),
        success('provider-a', [resolvedVote()]),
        success('provider-b', []),
      ],
      currentFindings: [],
    });

    expect(lifecycle.resolvedCandidates).toHaveLength(0);
    expect(lifecycle.previousUncertain[0].reasonCodes).toContain(
      'insufficient_resolved_quorum'
    );
  });

  it('does not resolve out-of-scope targets even if provider output contains matching target IDs', () => {
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [target()],
      plannedProviders: ['provider-a', 'provider-b'],
      providerResults: [
        success('provider-a', [resolvedVote()]),
        success('provider-b', [resolvedVote()]),
      ],
      currentFindings: [],
      assignmentRecords: [
        {
          targetId: 'rrt_target_1',
          fingerprint: 'a'.repeat(24),
          assignedProviderIds: [],
          assignedBatchIds: [],
          failedProviderIds: [],
          unassignedProviderIds: [
            { providerId: 'provider-a', reason: 'outside_review_scope' },
            { providerId: 'provider-b', reason: 'outside_review_scope' },
          ],
          scopeStatus: 'out_of_scope',
        },
      ],
    });

    expect(lifecycle.resolvedCandidates).toHaveLength(0);
    expect(lifecycle.previousUncertain[0].reasonCodes).toEqual(
      expect.arrayContaining([
        'outside_review_scope',
        'insufficient_resolved_quorum',
      ])
    );
  });

  it('ignores lifecycle votes from providers outside the resolved review plan', () => {
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [target()],
      plannedProviders: ['provider-a', 'provider-b'],
      providerResults: [
        success('provider-a', [resolvedVote()]),
        success('unplanned-provider', [resolvedVote()]),
        success('provider-b', []),
      ],
      currentFindings: [],
    });

    expect(lifecycle.resolvedCandidates).toHaveLength(0);
    expect(lifecycle.previousUncertain[0].reasonCodes).toContain(
      'provider_missing_revalidation'
    );
  });

  it('ignores lifecycle votes for targets that were not assigned to that provider batch', () => {
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [target()],
      plannedProviders: ['provider-a', 'provider-b'],
      providerResults: [
        {
          ...success('provider-a', [resolvedVote()]),
          lifecycleAssignedTargetIds: ['rrt_target_1'],
        },
        {
          ...success('provider-b', [resolvedVote()]),
          lifecycleAssignedTargetIds: ['rrt_different_target'],
        },
      ],
      currentFindings: [],
    });

    expect(lifecycle.resolvedCandidates).toHaveLength(0);
    expect(lifecycle.previousUncertain[0].reasonCodes).toContain(
      'provider_missing_revalidation'
    );
  });

  it('keeps duplicate-fingerprint targets independent by targetId', () => {
    const secondTarget = target({
      targetId: 'rrt_target_2',
      threadId: 'thread-2',
      parentCommentId: 'comment-2',
    });
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [target(), secondTarget],
      plannedProviders: ['provider-a', 'provider-b'],
      providerResults: [
        success('provider-a', [resolvedVote('rrt_target_1')]),
        success('provider-b', [resolvedVote('rrt_target_1')]),
      ],
      currentFindings: [],
    });

    expect(
      lifecycle.resolvedCandidates.map((record) => record.target.targetId)
    ).toEqual(['rrt_target_1']);
    expect(
      lifecycle.previousUncertain.map((record) => record.target.targetId)
    ).toEqual(['rrt_target_2']);
  });

  it('ignores a resolved vote whose fingerprint does not match the target', () => {
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [target()],
      plannedProviders: ['provider-a', 'provider-b'],
      providerResults: [
        success('provider-a', [
          {
            ...resolvedVote(),
            fingerprint: 'b'.repeat(24),
          },
        ]),
        success('provider-b', [resolvedVote()]),
      ],
      currentFindings: [],
    });

    expect(lifecycle.resolvedCandidates).toHaveLength(0);
    expect(lifecycle.previousUncertain[0].reasonCodes).toContain(
      'unknown_target_id'
    );
  });

  it('treats a current finding with the same semantic fingerprint as still valid', () => {
    const currentFinding: Finding = {
      file: 'src/app.ts',
      line: 12,
      severity: 'major',
      title: 'Old bug',
      message: 'Old bug still matters',
    };
    const currentFingerprint = target({
      fingerprint: 'unused',
    });
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [
        {
          ...currentFingerprint,
          fingerprint: findingFingerprintFromFinding(currentFinding),
        },
      ],
      plannedProviders: ['provider-a', 'provider-b'],
      providerResults: [
        success('provider-a', [resolvedVote(currentFingerprint.targetId)]),
        success('provider-b', [resolvedVote(currentFingerprint.targetId)]),
      ],
      currentFindings: [currentFinding],
    });

    expect(lifecycle.resolvedCandidates).toHaveLength(0);
    expect(lifecycle.previousStillValid[0].reasonCodes).toContain(
      'current_finding_present'
    );
    expect(countPreviousStillValidBySeverity(lifecycle).major).toBe(0);
  });

  it('treats a nearby current finding with changed wording as the same active old issue', () => {
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [
        target({
          fingerprint: 'legacy-fingerprint-legacy',
          title: 'Unchecked null team id',
          message: 'The team id can be null and still reach provisioning.',
          currentLine: 40,
        }),
      ],
      plannedProviders: ['provider-a', 'provider-b'],
      providerResults: [
        success('provider-a', [resolvedVote()]),
        success('provider-b', [resolvedVote()]),
      ],
      currentFindings: [
        {
          file: 'src/app.ts',
          line: 43,
          severity: 'major',
          title: 'Null team id reaches provisioning',
          message: 'Provisioning still accepts a null team id on this branch.',
        },
      ],
    });

    expect(lifecycle.resolvedCandidates).toHaveLength(0);
    expect(lifecycle.previousStillValid[0].reasonCodes).toContain(
      'current_finding_present'
    );
    expect(countPreviousStillValidBySeverity(lifecycle).major).toBe(0);
  });

  it('blocks auto-resolve and counts the old issue when a raw provider finding matches but final current findings are filtered out', () => {
    const rawFinding: Finding = {
      file: 'src/app.ts',
      line: 43,
      severity: 'major',
      title: 'Null team id reaches provisioning',
      message: 'Provisioning still accepts a null team id on this branch.',
    };
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [
        target({
          fingerprint: 'legacy-fingerprint-legacy',
          title: 'Unchecked null team id',
          message: 'The team id can be null and still reach provisioning.',
          currentLine: 40,
        }),
      ],
      plannedProviders: ['provider-a', 'provider-b'],
      providerResults: [
        success('provider-a', [resolvedVote()]),
        {
          ...success('provider-b', [resolvedVote()]),
          result: {
            content: '{}',
            findings: [rawFinding],
            revalidations: [resolvedVote()],
          },
        },
      ],
      currentFindings: [],
    });

    expect(lifecycle.resolvedCandidates).toHaveLength(0);
    expect(lifecycle.previousStillValid[0].reasonCodes).toContain(
      'provider_current_finding_present'
    );
    expect(countPreviousStillValidBySeverity(lifecycle).major).toBe(1);
  });

  it('does not let a provider failure from an unrelated batch block an assigned target', () => {
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [target()],
      plannedProviders: ['provider-a', 'provider-b'],
      providerResults: [
        success('provider-a', [resolvedVote()]),
        success('provider-b', [resolvedVote()]),
        {
          name: 'provider-b',
          status: 'error',
          error: new Error('different batch failed'),
          durationSeconds: 1,
        },
      ],
      currentFindings: [],
      assignmentRecords: [
        {
          targetId: 'rrt_target_1',
          fingerprint: 'a'.repeat(24),
          assignedProviderIds: ['provider-a', 'provider-b'],
          assignedBatchIds: ['batch-1'],
          failedProviderIds: [],
          unassignedProviderIds: [],
          scopeStatus: 'in_scope',
        },
      ],
    });

    expect(lifecycle.resolvedCandidates).toHaveLength(1);
    expect(lifecycle.previousUncertain).toHaveLength(0);
  });

  it('reports resolved quorum without mutating in report mode', () => {
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'report',
      targets: [target()],
      plannedProviders: ['provider-a'],
      providerResults: [success('provider-a', [resolvedVote()])],
      currentFindings: [],
    });

    expect(lifecycle.resolvedCandidates).toHaveLength(0);
    expect(lifecycle.mutationSkipped[0].reasonCodes).toContain('report_mode');
  });

  it('does not treat command-only skipped targets as lifecycle uncertainty', () => {
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [],
      plannedProviders: [],
      providerResults: [],
      currentFindings: [],
      skipped: [
        {
          target: target(),
          reasonCodes: ['command_dismissed'],
        },
      ],
    });

    expect(hasLifecycleUncertainty(lifecycle)).toBe(false);
  });

  it('does not keep command-dismissed manual-attention records active', () => {
    const dismissed = target();
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [],
      plannedProviders: [],
      providerResults: [],
      currentFindings: [],
      initialManualAttention: [
        {
          target: dismissed,
          reasonCodes: ['human_reply'],
        },
      ],
      skipped: [
        {
          target: dismissed,
          reasonCodes: ['command_dismissed'],
        },
      ],
    });

    expect(lifecycle.manualAttention).toHaveLength(0);
    expect(hasLifecycleUncertainty(lifecycle)).toBe(false);
  });

  it('removes only carried findings whose live lifecycle resolution was confirmed', () => {
    const carriedFinding: Finding = {
      file: 'src/app.ts',
      line: 12,
      severity: 'major',
      title: 'Old bug',
      message: 'Old bug still matters',
    };
    const freshFinding: Finding = {
      ...carriedFinding,
      title: 'Fresh bug',
      message: 'A fresh issue from this review.',
      line: 40,
    };
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [target()],
      plannedProviders: ['provider-a'],
      providerResults: [success('provider-a', [resolvedVote()])],
      currentFindings: [freshFinding],
    });
    lifecycle.resolvedByLifecycle.push(
      ...lifecycle.resolvedCandidates.map((record) => ({
        ...record,
        resolvedBy: 'review-router' as const,
      }))
    );
    lifecycle.resolvedCandidates = [];

    expect(
      reconcileCarriedFindingsWithLifecycle({
        mergedFindings: [carriedFinding, freshFinding],
        carriedFindings: [carriedFinding],
        lifecycle,
      })
    ).toEqual({ findings: [freshFinding], removed: [carriedFinding] });
  });

  it('deactivates a carried finding after a trusted fallback resolution reply is posted', () => {
    const carriedFinding: Finding = {
      file: 'src/app.ts',
      line: 12,
      severity: 'major',
      title: 'Old bug',
      message: 'Old bug still matters',
    };
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [target()],
      plannedProviders: ['provider-a'],
      providerResults: [success('provider-a', [resolvedVote()])],
      currentFindings: [],
    });
    lifecycle.mutationFailed.push(
      ...lifecycle.resolvedCandidates.map((record) => ({
        ...record,
        reasonCodes: [
          ...record.reasonCodes,
          'mutation_permission_denied' as const,
          'resolution_comment_posted' as const,
        ],
      }))
    );
    lifecycle.resolvedCandidates = [];

    expect(
      reconcileCarriedFindingsWithLifecycle({
        mergedFindings: [carriedFinding],
        carriedFindings: [carriedFinding],
        lifecycle,
      })
    ).toEqual({ findings: [], removed: [carriedFinding] });
    expect(lifecycle.resolvedByLifecycle).toHaveLength(0);
    expect(lifecycle.mutationFailed).toHaveLength(1);
  });

  it('deactivates a carried finding from a previously recorded trusted resolution marker', () => {
    const carriedFinding: Finding = {
      file: 'src/app.ts',
      line: 12,
      severity: 'major',
      title: 'Old bug',
      message: 'Old bug still matters',
    };
    const resolvedTarget = target({
      trustedResolutionMarker: {
        schemaVersion: 'reviewrouter-lifecycle-resolution.v1',
        targetId: 'rrt_target_1',
        fingerprint: 'a'.repeat(24),
        commentId: 'comment-resolution',
        commentUpdatedAt: '2026-07-22T00:00:00.000Z',
      },
    });
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [resolvedTarget],
      plannedProviders: [],
      providerResults: [],
      currentFindings: [carriedFinding],
    });

    expect(
      reconcileCarriedFindingsWithLifecycle({
        mergedFindings: [carriedFinding],
        carriedFindings: [carriedFinding],
        lifecycle,
      })
    ).toEqual({ findings: [], removed: [carriedFinding] });
  });

  it('retains a carried finding when a fallback marker lacks resolved provider quorum', () => {
    const carriedFinding: Finding = {
      file: 'src/app.ts',
      line: 12,
      severity: 'major',
      title: 'Old bug',
      message: 'Old bug still matters',
    };
    const oneResolvedVote = {
      ...resolvedVote(),
      providerId: 'provider-a',
      valid: true,
      reasonCodes: [],
    };
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [],
      plannedProviders: ['provider-a', 'provider-b'],
      providerResults: [],
      currentFindings: [],
    });
    lifecycle.mutationFailed.push({
      target: target(),
      reasonCodes: ['mutation_permission_denied', 'resolution_comment_posted'],
      providerVotes: [oneResolvedVote],
    });

    expect(
      reconcileCarriedFindingsWithLifecycle({
        mergedFindings: [carriedFinding],
        carriedFindings: [carriedFinding],
        lifecycle,
      })
    ).toEqual({ findings: [carriedFinding], removed: [] });
  });

  it.each([
    {
      name: 'fallback reply failed',
      reasonCodes: [
        'mutation_permission_denied',
        'resolution_comment_failed',
      ] as const,
      targetOverrides: {},
      inventoryFailed: false,
    },
    {
      name: 'permission denied without a fallback marker',
      reasonCodes: ['mutation_permission_denied'] as const,
      targetOverrides: {},
      inventoryFailed: false,
    },
    {
      name: 'fallback marker belongs to an untrusted target',
      reasonCodes: [
        'mutation_permission_denied',
        'resolution_comment_posted',
      ] as const,
      targetOverrides: { trustedAuthor: false },
      inventoryFailed: false,
    },
    {
      name: 'fallback marker is mixed with an uncertain outcome',
      reasonCodes: [
        'mutation_permission_denied',
        'resolution_comment_posted',
        'provider_uncertain',
      ] as const,
      targetOverrides: {},
      inventoryFailed: false,
    },
    {
      name: 'fallback marker is mixed with a skipped outcome',
      reasonCodes: [
        'mutation_permission_denied',
        'resolution_comment_posted',
        'head_sha_changed',
      ] as const,
      targetOverrides: {},
      inventoryFailed: false,
    },
    {
      name: 'thread inventory failed',
      reasonCodes: [
        'mutation_permission_denied',
        'resolution_comment_posted',
      ] as const,
      targetOverrides: {},
      inventoryFailed: true,
    },
  ])('retains carried findings when $name', (scenario) => {
    const carriedFinding: Finding = {
      file: 'src/app.ts',
      line: 12,
      severity: 'major',
      title: 'Old bug',
      message: 'Old bug still matters',
    };
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'resolve',
      targets: [target(scenario.targetOverrides)],
      plannedProviders: ['provider-a'],
      providerResults: [success('provider-a', [resolvedVote()])],
      currentFindings: [],
    });
    const candidate = lifecycle.resolvedCandidates[0] ?? {
      target: target(scenario.targetOverrides),
      reasonCodes: [],
      providerVotes: [
        {
          ...resolvedVote(),
          providerId: 'provider-a',
          valid: true,
          reasonCodes: [],
        },
      ],
    };
    lifecycle.mutationFailed.push({
      ...candidate,
      reasonCodes: [...scenario.reasonCodes],
    });
    lifecycle.resolvedCandidates = [];
    lifecycle.inventoryFailed = scenario.inventoryFailed;

    expect(
      reconcileCarriedFindingsWithLifecycle({
        mergedFindings: [carriedFinding],
        carriedFindings: [carriedFinding],
        lifecycle,
      })
    ).toEqual({ findings: [carriedFinding], removed: [] });
  });

  it.each([
    'previousUncertain',
    'mutationSkipped',
    'mutationFailed',
    'skipped',
  ] as const)(
    'retains carried findings when the target is only in %s',
    (outcome) => {
      const carriedFinding: Finding = {
        file: 'src/app.ts',
        line: 12,
        severity: 'major',
        title: 'Old bug',
        message: 'Old bug still matters',
      };
      const lifecycle = new ThreadLifecycleAggregator().aggregate({
        mode: 'resolve',
        targets: [],
        plannedProviders: [],
        providerResults: [],
        currentFindings: [],
      });
      lifecycle[outcome].push({
        target: target(),
        reasonCodes: ['provider_uncertain'],
      });

      expect(
        reconcileCarriedFindingsWithLifecycle({
          mergedFindings: [carriedFinding],
          carriedFindings: [carriedFinding],
          lifecycle,
        })
      ).toEqual({ findings: [carriedFinding], removed: [] });
    }
  );
});
