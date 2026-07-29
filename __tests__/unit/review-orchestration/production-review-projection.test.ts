import { DEFAULT_CONFIG } from '../../../src/config/defaults';
import {
  ReviewExecutionProviderKind,
  ReviewTaskKind,
} from '../../../src/review-orchestration/application';
import {
  createReviewPromptCoverageManifest,
  ReviewPromptPathCoverageKind,
} from '../../../src/review-orchestration/domain';
import { createProductionReviewProjectionBuilder } from '../../../src/review-orchestration/infrastructure/production-review-projection';
import { CheckConclusion } from '../../../src/review-projection/domain';

describe('production review projection coverage', () => {
  it('reports one successful required provider slot as 1/1', async () => {
    const builder = projectionBuilder([assignment('required-slot', true)]);
    const manifest = fullCoverageManifest('required-slot');

    const projection = await builder.build({
      acceptedEvidence: [acceptedEvidence('required-slot', manifest)],
      exhaustedWorkSlotIds: [],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
    });
    const envelope = JSON.parse(projection.projectionEnvelopeCanonicalJson);
    const summary = envelope.publishing.summary.body;

    expect(envelope.projectionPolicyVersion).toBe(
      'review-projection-policy.v4-t0'
    );
    expect(summary).toContain('| Providers | 1/1 succeeded |');
    expect(summary).not.toContain('1 failed');
  });

  it('reports an exhausted required provider slot as 0/1', async () => {
    const builder = projectionBuilder([assignment('required-slot', true)]);

    const projection = await builder.build({
      acceptedEvidence: [],
      exhaustedWorkSlotIds: ['required-slot'],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
    });
    const envelope = JSON.parse(projection.projectionEnvelopeCanonicalJson);

    expect(envelope.coverage.state).toBe('partial');
    expect(envelope.publishing.summary.body).toContain(
      '| Providers | 0/1 succeeded, 1 failed |'
    );
  });

  it('counts one provider across batches and fails it when one required batch is exhausted', async () => {
    const builder = projectionBuilder([
      assignment('required-slot-1', true),
      assignment('required-slot-2', true),
    ]);

    const projection = await builder.build({
      acceptedEvidence: [
        acceptedEvidence(
          'required-slot-1',
          fullCoverageManifest('required-slot-1')
        ),
      ],
      exhaustedWorkSlotIds: ['required-slot-2'],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
    });
    const summary = JSON.parse(projection.projectionEnvelopeCanonicalJson)
      .publishing.summary.body;

    expect(summary).toContain('| Providers | 0/1 succeeded, 1 failed |');
    expect(summary).not.toContain('| Providers | 1/2');
  });

  it('reports 0/0 only when no required provider slots were planned', async () => {
    const builder = projectionBuilder([]);

    const projection = await builder.build({
      acceptedEvidence: [],
      exhaustedWorkSlotIds: [],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
    });
    const summary = JSON.parse(projection.projectionEnvelopeCanonicalJson)
      .publishing.summary.body;

    expect(summary).toContain('| Providers | 0/0 succeeded |');
  });

  it('makes required-slot coverage partial when context inspection is incomplete', async () => {
    const builder = projectionBuilder([assignment('required-slot', true)]);
    const manifest = fullCoverageManifest('required-slot');

    const projection = await builder.build({
      acceptedEvidence: [
        acceptedEvidence('required-slot', manifest, [
          'context_inspection_incomplete',
        ]),
      ],
      exhaustedWorkSlotIds: [],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
    });
    const envelope = JSON.parse(projection.projectionEnvelopeCanonicalJson);

    expect(envelope.coverage).toMatchObject({
      state: 'partial',
      limitations: ['work_slot_context_inspection_incomplete:required-slot'],
    });
    expect(envelope.publishing.summary.allClear).toBe(false);
    expect(envelope.publishing.check.conclusion).toBe(CheckConclusion.Neutral);
  });

  it('keeps current-head coverage complete for non-blocking quality flags', async () => {
    const builder = projectionBuilder([assignment('required-slot', true)]);
    const manifest = fullCoverageManifest('required-slot');

    const projection = await builder.build({
      acceptedEvidence: [
        acceptedEvidence('required-slot', manifest, [
          'provider_warning',
          'cross_revision_reuse_disabled',
        ]),
      ],
      exhaustedWorkSlotIds: [],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
    });

    expect(projection.coverageComplete).toBe(true);
    expect(
      JSON.parse(projection.projectionEnvelopeCanonicalJson).coverage
    ).toMatchObject({ state: 'complete', limitations: [] });
  });

  it('keeps coverage complete for paths explicitly excluded by review policy', async () => {
    const builder = projectionBuilder([assignment('required-slot', true)]);
    const manifest = createReviewPromptCoverageManifest({
      workSlotId: 'required-slot',
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
      assignedPaths: ['src/a.ts'],
      pathCoverage: [
        {
          path: 'src/a.ts',
          kind: ReviewPromptPathCoverageKind.PolicyExcluded,
          contentHash: null,
        },
      ],
    });

    const projection = await builder.build({
      acceptedEvidence: [acceptedEvidence('required-slot', manifest)],
      exhaustedWorkSlotIds: [],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
    });
    const envelope = JSON.parse(projection.projectionEnvelopeCanonicalJson);

    expect(projection.coverageComplete).toBe(true);
    expect(envelope.coverage).toMatchObject({
      state: 'complete',
      totalFiles: 1,
      reviewedFiles: 0,
      unreviewedFiles: 0,
      limitations: [],
    });
  });

  it('does not downgrade required coverage for incomplete optional evidence', async () => {
    const builder = projectionBuilder([
      assignment('required-slot', true),
      assignment('optional-slot', false),
    ]);

    const projection = await builder.build({
      acceptedEvidence: [
        acceptedEvidence(
          'required-slot',
          fullCoverageManifest('required-slot')
        ),
        acceptedEvidence(
          'optional-slot',
          fullCoverageManifest('optional-slot'),
          ['context_inspection_incomplete']
        ),
      ],
      exhaustedWorkSlotIds: [],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
    });
    const envelope = JSON.parse(projection.projectionEnvelopeCanonicalJson);

    expect(envelope.coverage).toMatchObject({
      state: 'complete',
      limitations: [],
    });
    expect(envelope.publishing.summary.body).toContain(
      '| Providers | 1/1 succeeded |'
    );
  });

  it('publishes only neutral coverage output when an assigned path lacks full patch proof', async () => {
    const builder = createProductionReviewProjectionBuilder({
      authorizationFacts,
      pr,
      config: DEFAULT_CONFIG,
      protocolLimits,
      assignments: [
        {
          workSlotId: 'slot-1',
          taskKind: ReviewTaskKind.FindingDiscovery,
          providerKind: ReviewExecutionProviderKind.Codex,
          required: true,
          filePaths: ['src/a.ts'],
        },
      ],
      uncoveredPaths: [],
      uncoveredLifecycleTargetIds: [],
      lifecycleInventory: {
        loadCurrent: jest.fn().mockResolvedValue({
          inventoryVersion: 'review_lifecycle_inventory.v1',
          loadedForHeadSha: pr.headSha,
          lifecycleStateHash: 'lifecycle-state-1',
          commandLedgerWatermark: 'ledger-1',
          complete: true,
          warnings: [],
          targets: [],
        }),
      },
    });
    const coverageManifest = createReviewPromptCoverageManifest({
      workSlotId: 'slot-1',
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
      assignedPaths: ['src/a.ts'],
      pathCoverage: [
        {
          path: 'src/a.ts',
          kind: ReviewPromptPathCoverageKind.SummaryOnly,
          contentHash: '9'.repeat(64),
        },
      ],
    });

    const projection = await builder.build({
      acceptedEvidence: [acceptedEvidence('slot-1', coverageManifest)],
      exhaustedWorkSlotIds: [],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
    });
    const envelope = JSON.parse(projection.projectionEnvelopeCanonicalJson);

    expect(projection.coverageComplete).toBe(false);
    expect(envelope.coverage.state).toBe('partial');
    expect(envelope.publishing.summary.allClear).toBe(false);
    expect(envelope.publishing.check.conclusion).toBe(CheckConclusion.Neutral);
    expect(envelope.publishing.inlineReviewChunks).toEqual([]);
    expect(envelope.publishing.lifecycle).toEqual([]);
    expect(envelope.snapshot).toEqual({
      lineageHints: [],
      occurrenceProvenance: [],
    });
  });

  it('does not make coverage partial for an exhausted optional vote lane', async () => {
    const builder = createProductionReviewProjectionBuilder({
      authorizationFacts,
      pr,
      config: DEFAULT_CONFIG,
      protocolLimits,
      assignments: [
        {
          workSlotId: 'required-slot',
          taskKind: ReviewTaskKind.FindingDiscovery,
          providerKind: ReviewExecutionProviderKind.Codex,
          required: true,
          filePaths: ['src/a.ts'],
        },
        {
          workSlotId: 'optional-slot',
          taskKind: ReviewTaskKind.FindingDiscovery,
          providerKind: ReviewExecutionProviderKind.Codex,
          required: false,
          filePaths: ['src/a.ts'],
        },
      ],
      uncoveredPaths: [],
      uncoveredLifecycleTargetIds: [],
      lifecycleInventory: completeLifecycleInventory(),
    });
    const requiredManifest = createReviewPromptCoverageManifest({
      workSlotId: 'required-slot',
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
      assignedPaths: ['src/a.ts'],
      pathCoverage: [
        {
          path: 'src/a.ts',
          kind: ReviewPromptPathCoverageKind.FullPatch,
          contentHash: '8'.repeat(64),
        },
      ],
    });

    const projection = await builder.build({
      acceptedEvidence: [acceptedEvidence('required-slot', requiredManifest)],
      exhaustedWorkSlotIds: ['optional-slot'],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
    });

    expect(projection.coverageComplete).toBe(true);
    expect(
      JSON.parse(projection.projectionEnvelopeCanonicalJson).coverage
    ).toMatchObject({ state: 'complete', limitations: [] });
  });

  it('still rejects an invalid optional coverage manifest', async () => {
    const builder = createProductionReviewProjectionBuilder({
      authorizationFacts,
      pr,
      config: DEFAULT_CONFIG,
      protocolLimits,
      assignments: [
        {
          workSlotId: 'optional-slot',
          taskKind: ReviewTaskKind.FindingDiscovery,
          providerKind: ReviewExecutionProviderKind.Codex,
          required: false,
          filePaths: ['src/a.ts'],
        },
      ],
      uncoveredPaths: [],
      uncoveredLifecycleTargetIds: [],
      lifecycleInventory: completeLifecycleInventory(),
    });
    const optionalManifest = createReviewPromptCoverageManifest({
      workSlotId: 'optional-slot',
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
      assignedPaths: ['src/a.ts'],
      pathCoverage: [
        {
          path: 'src/a.ts',
          kind: ReviewPromptPathCoverageKind.SummaryOnly,
          contentHash: '7'.repeat(64),
        },
      ],
    });

    await expect(
      builder.build({
        acceptedEvidence: [
          acceptedEvidence('optional-slot', {
            ...optionalManifest,
            coverageHash: '0'.repeat(64),
          }),
        ],
        exhaustedWorkSlotIds: [],
        reviewRevisionHash: authorizationFacts.reviewRevisionHash,
      })
    ).rejects.toThrow('review_projection_coverage_manifest_hash_invalid');
  });
});

function completeLifecycleInventory() {
  return {
    loadCurrent: jest.fn().mockResolvedValue({
      inventoryVersion: 'review_lifecycle_inventory.v1',
      loadedForHeadSha: pr.headSha,
      lifecycleStateHash: 'lifecycle-state-1',
      commandLedgerWatermark: 'ledger-1',
      complete: true,
      warnings: [],
      targets: [],
    }),
  };
}

function projectionBuilder(
  assignments: Array<{
    workSlotId: string;
    taskKind: ReviewTaskKind;
    providerKind: ReviewExecutionProviderKind;
    required: boolean;
    filePaths: string[];
  }>
) {
  return createProductionReviewProjectionBuilder({
    authorizationFacts,
    pr,
    config: DEFAULT_CONFIG,
    protocolLimits,
    assignments,
    uncoveredPaths: [],
    uncoveredLifecycleTargetIds: [],
    lifecycleInventory: completeLifecycleInventory(),
  });
}

function assignment(workSlotId: string, required: boolean) {
  return {
    workSlotId,
    taskKind: ReviewTaskKind.FindingDiscovery,
    providerKind: ReviewExecutionProviderKind.Codex,
    required,
    filePaths: ['src/a.ts'],
  };
}

function fullCoverageManifest(workSlotId: string) {
  return createReviewPromptCoverageManifest({
    workSlotId,
    reviewRevisionHash: authorizationFacts.reviewRevisionHash,
    assignedPaths: ['src/a.ts'],
    pathCoverage: [
      {
        path: 'src/a.ts',
        kind: ReviewPromptPathCoverageKind.FullPatch,
        contentHash: '8'.repeat(64),
      },
    ],
  });
}

function acceptedEvidence(
  workSlotId: string,
  coverageManifest: ReturnType<typeof createReviewPromptCoverageManifest>,
  qualityFlags: string[] = []
) {
  const payloadCanonicalJson = JSON.stringify({
    payloadVersion: 2,
    normalizedFindings: [],
    normalizedLifecycleRevalidations: [],
  });
  return {
    workSlotId,
    coverageManifest,
    observation: {
      observationId: `observation-${workSlotId}`,
      eligibilityPolicyVersion: 'eligibility.v1',
      providerKind: ReviewExecutionProviderKind.Codex,
      providerInvocationKey: '7'.repeat(64),
      providerVoteIdentityHash:
        authorizationFacts.providerVoteLanes[0].providerVoteIdentityHash,
      payloadCanonicalJson,
      payloadHash: '8'.repeat(64),
      byteCount: Buffer.byteLength(payloadCanonicalJson),
      findingCount: 0,
      actualModel: 'gpt-5.6-sol',
      qualityFlags,
      transportAttemptCount: 1,
      schemaValidated: true,
      fullyConsumed: true,
    },
  };
}

const authorizationFacts = {
  workspaceId: 'workspace-1',
  repositoryConnectionId: 'connection-1',
  scmRepositoryIdentityId: 'repository-1',
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
};

const pr = {
  number: 1,
  title: 'Partial coverage',
  body: '',
  author: 'reviewer',
  draft: false,
  labels: [],
  files: [
    {
      filename: 'src/a.ts',
      status: 'modified' as const,
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: '@@ -1 +1 @@\n+changed',
    },
  ],
  diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+changed',
  additions: 1,
  deletions: 0,
  baseSha: authorizationFacts.baseSha,
  headSha: authorizationFacts.headSha,
};

const protocolLimits = {
  maxWorkSlots: 10,
  maxAttemptsPerSlot: 3,
  maxObservationBytes: 100_000,
  maxObservationFindings: 100,
  maxProjectionBytes: 200_000,
  maxProjectionFindings: 100,
  maxPublicationOperations: 100,
  maxPublicationChunks: 20,
  maxPublicationBodyBytes: 200_000,
  maxRequestBatchSize: 20,
  maxLeaseDurationMs: 60_000,
  maxResultReportDurationMs: 60_000,
  maxReconciliationDurationMs: 60_000,
};
