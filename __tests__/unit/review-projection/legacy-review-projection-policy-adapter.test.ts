import { DEFAULT_CONFIG } from '../../../src/config/defaults';
import {
  FindingOccurrence,
  FindingOccurrenceState,
  FindingPlacementKind,
  FindingSeverity,
  ProjectionCoverageState,
  RevisionFileStatus,
} from '../../../src/review-projection/domain/review-projection';
import { REVIEW_PROJECTION_ABSOLUTE_LIMITS } from '../../../src/review-projection/domain/review-projection-limits';
import { LegacyReviewProjectionPolicyAdapter } from '../../../src/review-projection/infrastructure/legacy/legacy-review-projection-policy-adapter';

describe('LegacyReviewProjectionPolicyAdapter', () => {
  const adapter = new LegacyReviewProjectionPolicyAdapter({
    ...DEFAULT_CONFIG,
    inlineMaxComments: 20,
    inlineMinSeverity: 'minor',
    inlineMinAgreement: 1,
  });

  it('reuses filtering and consensus while preserving projection provenance', async () => {
    const selected = await adapter.selectCurrent({
      findings: [
        candidate({ sourceFindingId: 'a', providerIds: ['codex'] }),
        candidate({
          sourceFindingId: 'b',
          providerIds: ['claude'],
          providerVoteKeys: ['claude/account-2'],
          observationIds: ['observation-2'],
        }),
      ],
      revisionFiles: [revisionFile()],
      diff: diff(),
      limits: REVIEW_PROJECTION_ABSOLUTE_LIMITS,
    });

    expect(selected).toHaveLength(1);
    expect(selected[0].sourceFindingIds).toEqual(['a', 'b']);
    expect(selected[0].providerVoteKeys).toEqual([
      'claude/account-2',
      'codex/account-1',
    ]);
    expect(selected[0].observationIds).toEqual([
      'observation-1',
      'observation-2',
    ]);
  });

  it('degrades rename, deletion and unplaceable findings without false inline anchors', async () => {
    const occurrences = [
      occurrence({
        lineageId: 'renamed',
        filePath: 'src/old.ts',
        line: 2,
      }),
      occurrence({
        lineageId: 'deleted',
        filePath: 'src/deleted.ts',
        line: 1,
      }),
      occurrence({
        lineageId: 'unplaceable',
        filePath: 'src/unplaceable.ts',
        line: 99,
      }),
    ];
    const projected = await adapter.projectPresentation({
      scope: {
        scmRepositoryIdentityId: 'repo-1',
        pullRequestNumber: 252,
        baseSha: '0'.repeat(40),
        reviewedHeadSha: '1'.repeat(40),
        reviewRevisionHash: 'revision-1',
      },
      presentation: {
        title: 'Large PR',
        author: 'author',
        additions: 3,
        deletions: 1,
      },
      providerExecution: {
        plannedProviders: 1,
        succeededProviders: 1,
      },
      coverage: {
        state: ProjectionCoverageState.Complete,
        mode: 'full',
        totalFiles: 3,
        reviewedFiles: 3,
        unreviewedFiles: 0,
        limitations: [],
      },
      occurrences,
      revisionFiles: [
        {
          path: 'src/new.ts',
          previousPath: 'src/old.ts',
          status: RevisionFileStatus.Renamed,
          patch: '@@ -1 +1,2 @@\n const safe = true;\n+dangerous();',
        },
        {
          path: 'src/deleted.ts',
          status: RevisionFileStatus.Removed,
          patch: '@@ -1 +0,0 @@\n-dangerous();',
        },
        {
          path: 'src/unplaceable.ts',
          status: RevisionFileStatus.Modified,
          patch: '@@ -1 +1 @@\n-safe();\n+changed();',
        },
      ],
      limits: REVIEW_PROJECTION_ABSOLUTE_LIMITS,
    });

    expect(projected.placements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lineageId: 'renamed',
          kind: FindingPlacementKind.Inline,
          path: 'src/new.ts',
        }),
        expect.objectContaining({
          lineageId: 'deleted',
          kind: FindingPlacementKind.Summary,
        }),
        expect.objectContaining({
          lineageId: 'unplaceable',
          kind: FindingPlacementKind.File,
        }),
      ])
    );
  });

  it('presents partial coverage as incomplete while preserving preliminary findings', async () => {
    const projected = await adapter.projectPresentation({
      scope: {
        scmRepositoryIdentityId: 'repo-1',
        pullRequestNumber: 46,
        baseSha: '0'.repeat(40),
        reviewedHeadSha: '1'.repeat(40),
        reviewRevisionHash: 'revision-partial',
      },
      presentation: {
        title: 'Partial review',
        author: 'author',
        additions: 1,
        deletions: 0,
      },
      providerExecution: {
        plannedProviders: 1,
        succeededProviders: 1,
      },
      coverage: {
        state: ProjectionCoverageState.Partial,
        mode: 'full',
        totalFiles: 2,
        reviewedFiles: 1,
        unreviewedFiles: 1,
        limitations: ['work_slot_coverage_incomplete:slot-2'],
      },
      occurrences: [occurrence()],
      revisionFiles: [revisionFile()],
      limits: REVIEW_PROJECTION_ABSOLUTE_LIMITS,
    });

    expect(projected.summaryBody).toContain(
      '## Review incomplete - 1 preliminary finding preserved ⚠️'
    );
    expect(projected.summaryBody).toContain(
      'Inline comments and lifecycle changes were withheld'
    );
    expect(projected.summaryBody).toContain('### Coverage not completed');
    expect(projected.summaryBody).toContain(
      '- work_slot_coverage_incomplete:slot-2'
    );
    expect(projected.summaryBody).not.toMatch(
      /^##\s+Review complete(?:d)?\b/im
    );
    expect(projected.checkTitle).toBe('Review incomplete - partial coverage');
    expect(projected.checkConclusion).toBe('neutral');
  });

  it('does not claim a clean review when partial coverage found nothing', async () => {
    const projected = await adapter.projectPresentation({
      scope: {
        scmRepositoryIdentityId: 'repo-1',
        pullRequestNumber: 46,
        baseSha: '0'.repeat(40),
        reviewedHeadSha: '1'.repeat(40),
        reviewRevisionHash: 'revision-partial-empty',
      },
      presentation: {
        title: 'Partial review',
        author: 'author',
        additions: 1,
        deletions: 0,
      },
      providerExecution: {
        plannedProviders: 1,
        succeededProviders: 1,
      },
      coverage: {
        state: ProjectionCoverageState.Partial,
        mode: 'full',
        totalFiles: 2,
        reviewedFiles: 1,
        unreviewedFiles: 1,
        limitations: ['work_slot_coverage_incomplete:slot-2'],
      },
      occurrences: [],
      revisionFiles: [revisionFile()],
      limits: REVIEW_PROJECTION_ABSOLUTE_LIMITS,
    });

    expect(projected.summaryBody).toContain(
      '## Review incomplete - 0 preliminary findings preserved ⚠️'
    );
    expect(projected.summaryBody).not.toContain(
      'No critical, major, or minor findings were reported for this revision.'
    );
    expect(projected.summaryBody).toContain(
      'Inline comments and lifecycle changes were withheld'
    );
  });

  it('does not count carried occurrences as severity-gate blockers', () => {
    const decision = adapter.evaluateMergeGate({
      failOnSeverity: FindingSeverity.Major,
      occurrences: [
        occurrence({ state: FindingOccurrenceState.CarriedUnverified }),
      ],
      coverage: {
        state: ProjectionCoverageState.Complete,
        mode: 'full',
        totalFiles: 1,
        reviewedFiles: 1,
        unreviewedFiles: 0,
        limitations: [],
      },
      lifecycleInventoryComplete: true,
    });

    expect(decision).toEqual({
      conclusion: 'pass',
      blockingLineageIds: [],
      reasonCodes: [],
    });
  });
});

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    sourceFindingId: 'a',
    category: 'correctness',
    normalizedFailureModeHash: 'failure-mode-1',
    severity: FindingSeverity.Major,
    title: 'Runtime crash on valid request',
    message: 'The changed call throws when the request is valid.',
    filePath: 'src/service.ts',
    line: 2,
    providerIds: ['codex'],
    providerVoteKeys: ['codex/account-1'],
    observationIds: ['observation-1'],
    ...overrides,
  };
}

function occurrence(
  overrides: Partial<FindingOccurrence> = {}
): FindingOccurrence {
  return {
    lineageId: 'lineage-1',
    sourceFindingIds: ['finding-1'],
    state: FindingOccurrenceState.New,
    severity: FindingSeverity.Major,
    category: 'correctness',
    normalizedFailureModeHash: 'failure-mode-1',
    title: 'Runtime crash on valid request',
    message: 'The changed call throws when the request is valid.',
    filePath: 'src/service.ts',
    line: 2,
    placement: {
      lineageId: 'lineage-1',
      kind: FindingPlacementKind.Summary,
      path: 'src/service.ts',
    },
    providerVoteKeys: ['codex/account-1'],
    observationIds: ['observation-1'],
    firstSeenHeadSha: '0'.repeat(40),
    sourceHeadSha: '1'.repeat(40),
    blocking: false,
    ...overrides,
  };
}

function revisionFile() {
  return {
    path: 'src/service.ts',
    status: RevisionFileStatus.Modified,
    patch: '@@ -1 +1,2 @@\n const safe = true;\n+dangerous();',
  };
}

function diff(): string {
  return [
    'diff --git a/src/service.ts b/src/service.ts',
    '--- a/src/service.ts',
    '+++ b/src/service.ts',
    '@@ -1 +1,2 @@',
    ' const safe = true;',
    '+dangerous();',
  ].join('\n');
}
