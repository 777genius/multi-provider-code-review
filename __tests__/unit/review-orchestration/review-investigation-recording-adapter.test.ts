import { createHash } from 'crypto';
import {
  ReviewExecutionProviderKind,
  ReviewInvocationConfigurationMismatchError,
  ReviewInvocationConfigurationMismatchReason,
  ReviewInvestigationRecordingMode,
  ReviewTaskKind,
} from '../../../src/review-orchestration/application';
import {
  ReviewInvestigationGatewayConfigurationError,
  ReviewInvestigationGatewayConfigurationFailureReason,
} from '../../../src/review-investigation/application/investigation-gateway-port';
import { ReviewPromptPathCoverageKind } from '../../../src/review-orchestration/domain';
import {
  REVIEW_INVESTIGATION_COVERAGE_PROFILE,
  REVIEW_INVESTIGATION_PRODUCTION_POLICY,
  ReviewInvestigationRecordingAdapter,
  reviewInvestigationCoverageContract,
  reviewInvestigationCoverageProfileHash,
  reviewInvestigationPolicyHash,
} from '../../../src/review-orchestration/infrastructure/review-investigation-recording-adapter';
import {
  ReviewInvestigationConclusion,
  ReviewInvestigationNextAction,
  ReviewInvestigationRunStatus,
  ReviewInvestigationState,
} from '../../../src/review-investigation/domain/investigation-state';
import { ReviewAgentProviderKind } from '../../../src/review-investigation/domain/runtime-profile';
import { ReviewTurnPurpose } from '../../../src/review-investigation/domain/turn-observation';
import { canonicalJson } from '../../../src/review-investigation/domain/canonical-json';
import {
  ReviewInvestigationChangedFileStatus,
  createReviewInvestigationProbePlan,
} from '../../../src/review-investigation/domain/deterministic-context-probe-plan';
import {
  buildReviewInvestigationSeedEnvelope,
  type ReviewInvestigationCanonicalInventory,
  type ReviewInvestigationCanonicalInventoryEntry,
} from '../../../src/review-investigation/domain/review-investigation-seed-envelope';
import {
  ReviewInvestigationDeferredSignal,
  ReviewInvestigationLegacyFallbackReason,
} from '../../../src/review-investigation/application/run-investigation-work-slot';
import capabilityGolden from '../../../src/review-investigation/fixtures/review-investigation-capability-v1.golden.json';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

describe('ReviewInvestigationRecordingAdapter', () => {
  it('reads removed changed content from merge-base instead of the absent head', () => {
    const { invocation } = executionInput();
    const path = 'src/removed.ts';
    const plan = createReviewInvestigationProbePlan({
      files: [probeFile(path, ReviewInvestigationChangedFileStatus.Removed)],
      fullDiff: '',
    });
    const coverageManifest = {
      ...invocation.coverageManifest,
      paths: [
        {
          path,
          kind: ReviewPromptPathCoverageKind.FullPatch,
          contentHash: null,
        },
      ],
    };
    const seeds = buildReviewInvestigationSeedEnvelope({
      canonicalInventory: canonicalInventory([
        inventoryEntry(path, ReviewInvestigationChangedFileStatus.Removed),
      ]),
      probePlan: plan,
      reviewPrompt: invocation.reviewPrompt,
      requestedModel: invocation.requestedModel,
      coverageManifest,
    }).envelope.obligations;
    const changed = seeds.find((seed) => seed.kind === 'changed_content')!;

    expect(JSON.parse(changed.canonicalSubject)).toEqual({
      kind: 'file_read',
      pathHash: hash(path),
      revision: 'merge_base',
      subjectVersion: 1,
    });
    expect(JSON.parse(changed.canonicalRequirement)).toMatchObject({
      kind: 'complete_changed_file',
      path,
      pathHash: hash(path),
      requirementVersion: 2,
      revision: 'merge_base',
    });
  });

  it('projects only a certificate-backed terminal observation', async () => {
    const terminalJson = '{"payloadVersion":2}';
    const execute = jest.fn(async (runInput) => {
      expect(runInput.providerManifestCanonicalJson).toBe('{}');
      expect(runInput.providerManifestHash).toBe('9'.repeat(64));
      expect(runInput.coverageContract).toEqual(
        reviewInvestigationCoverageContract('release-1')
      );
      const seedObligations = runInput.seedEnvelope.envelope.obligations;
      expect(seedObligations[0]).toMatchObject({ kind: 'inventory_witness' });
      expect(JSON.parse(seedObligations[0].canonicalSubject)).toMatchObject({
        kind: 'canonical_inventory',
        reviewRevisionHash: 'b'.repeat(64),
        subjectVersion: 2,
      });
      expect(
        seedObligations.filter(
          (item: { kind: string }) => item.kind === 'changed_content'
        )
      ).toHaveLength(6);
      expect(seedObligations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            canonicalSubject: fileSubject('src/a.ts', 'merge_base'),
            riskPriority: 500_000,
          }),
          expect.objectContaining({
            canonicalSubject: fileSubject('src/a.ts'),
            riskPriority: 500_000,
          }),
          expect.objectContaining({
            canonicalSubject: fileSubject('src/auth/session.ts', 'merge_base'),
            riskPriority: 900_000,
          }),
          expect.objectContaining({
            canonicalSubject: fileSubject('src/auth/session.ts'),
            riskPriority: 900_000,
          }),
          expect.objectContaining({
            canonicalSubject: fileSubject('src/z.ts', 'merge_base'),
            riskPriority: 500_000,
          }),
          expect.objectContaining({
            canonicalSubject: fileSubject('src/z.ts'),
            riskPriority: 500_000,
          }),
        ])
      );
      const requirements = runInput.seedEnvelope.envelope.obligations.map(
        (item: { canonicalRequirement: string }) =>
          JSON.parse(item.canonicalRequirement)
      );
      const changedRequirement = requirements.find(
        (requirement: { kind: string; path?: string; revision?: string }) =>
          requirement.kind === 'complete_changed_file' &&
          requirement.path === 'src/auth/session.ts' &&
          requirement.revision === 'head'
      );
      expect(Object.keys(changedRequirement).sort()).toEqual([
        'kind',
        'path',
        'pathHash',
        'requirementVersion',
        'revision',
      ]);
      expect(requirements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'complete_changed_file',
            path: 'src/auth/session.ts',
            pathHash: hash('src/auth/session.ts'),
            requirementVersion: 2,
            revision: 'head',
          }),
          expect.objectContaining({
            kind: 'complete_page_chain',
            matchMode: 'fixed_string',
            probeKind: 'declaration_identifier',
            query: 'refreshSession',
            queryHash: hash('refreshSession'),
            requirementVersion: 2,
          }),
          expect.objectContaining({
            kind: 'complete_page_chain',
            query: 'session.revoked',
            queryHash: hash('session.revoked'),
            requirementVersion: 2,
          }),
        ])
      );
      expect(
        requirements.filter(
          (requirement: { kind: string }) =>
            requirement.kind === 'complete_page_chain'
        ).length
      ).toBeGreaterThan(1);
      const prompt = runInput.promptFor(activeSnapshot());
      expect(prompt).toContain(
        'REVIEWROUTER_INVESTIGATION_TURN_BRIEF_V1_BASE64URL:'
      );
      expect(prompt).toContain('operationBackedDiscoveryClaims');
      expect(prompt).toContain('provider-neutral obligationProposals entry');
      expect(prompt).toContain(
        'exactly kind, canonicalSubject, canonicalRequirement, and riskPriority'
      );
      expect(prompt).toContain('never provide an obligation ID');
      return {
        status: ReviewInvestigationRunStatus.Completed,
        snapshot: terminalSnapshot(terminalJson),
      };
    });
    const adapter = new ReviewInvestigationRecordingAdapter(
      () => ({ execute }) as never,
      options()
    );

    expect(adapter.mode).toBe(ReviewInvestigationRecordingMode.RecordOnly);
    expect(adapter.verifiedCleanEffectsEnabled).toBe(false);

    await expect(adapter.execute(executionInput())).resolves.toEqual({
      payloadCanonicalJson: terminalJson,
      payloadHash: hash(terminalJson),
      byteCount: Buffer.byteLength(terminalJson),
      findingCount: 0,
      actualModel: 'gpt-test',
      qualityFlags: ['investigation_verified_clean'],
      transportAttemptCount: 2,
      schemaValidated: true,
      fullyConsumed: true,
      investigationCertificateId: 'certificate-1',
      investigationCertificateHash: 'c'.repeat(64),
    });
  });

  it('claims the investigation manifest in record-only mode but not legacy gateway work', () => {
    const adapter = new ReviewInvestigationRecordingAdapter(
      () => ({ execute: jest.fn() }) as never,
      options()
    );
    const input = executionInput();
    expect(
      adapter.supports({
        workSlot: input.workSlot,
        invocation: input.invocation,
      })
    ).toBe(true);
    expect(
      adapter.supports({
        workSlot: input.workSlot,
        invocation: {
          ...input.invocation,
          manifestFacts: {
            ...input.invocation.manifestFacts,
            executionProfile: 'context_gateway_v1',
          },
        },
      })
    ).toBe(false);
  });

  it('does not claim lifecycle work', () => {
    const adapter = new ReviewInvestigationRecordingAdapter(
      () => ({ execute: jest.fn() }) as never,
      options()
    );
    const input = executionInput();
    expect(
      adapter.supports({
        workSlot: input.workSlot,
        invocation: {
          ...input.invocation,
          manifestFacts: {
            ...input.invocation.manifestFacts,
            taskKindSet: [ReviewTaskKind.LifecycleRevalidation],
          },
        },
      })
    ).toBe(false);
  });

  it('does not claim investigation support for an incomplete probe plan', () => {
    const adapter = new ReviewInvestigationRecordingAdapter(
      () => ({ execute: jest.fn() }) as never,
      options()
    );
    const input = executionInput();
    const incompleteProbePlan = createReviewInvestigationProbePlan({
      files: [
        {
          path: 'src/too-many.ts',
          previousPath: null,
          status: ReviewInvestigationChangedFileStatus.Modified,
          patch: null,
        },
      ],
      fullDiff: [
        'diff --git a/src/too-many.ts b/src/too-many.ts',
        '+export const first = 1;',
        '+export const second = 2;',
      ].join('\n'),
      limits: { maxProbesPerFile: 2, maxProbesOverall: 2 },
    });

    expect(
      adapter.supports({
        workSlot: input.workSlot,
        invocation: {
          ...input.invocation,
          investigationProbePlan: incompleteProbePlan,
        },
      })
    ).toBe(false);
  });

  it('does not claim an invocation whose transient seed envelope is not manifest-bound', () => {
    const adapter = new ReviewInvestigationRecordingAdapter(
      () => ({ execute: jest.fn() }) as never,
      options()
    );
    const input = executionInput();

    expect(
      adapter.supports({
        workSlot: input.workSlot,
        invocation: {
          ...input.invocation,
          investigationSeedEnvelope: {
            ...input.invocation.investigationSeedEnvelope,
            hash: 'f'.repeat(64),
          },
        },
      })
    ).toBe(false);
  });

  it('supports provider-neutral Codex and Claude Code work slots', () => {
    const adapter = new ReviewInvestigationRecordingAdapter(
      () => ({ execute: jest.fn() }) as never,
      options()
    );

    for (const providerKind of [
      ReviewExecutionProviderKind.Codex,
      ReviewExecutionProviderKind.ClaudeCode,
    ]) {
      const input = executionInput(providerKind);
      expect(
        adapter.supports({
          workSlot: input.workSlot,
          invocation: input.invocation,
        })
      ).toBe(true);
    }
    const unsupported = executionInput(ReviewExecutionProviderKind.OpenRouter);
    expect(
      adapter.supports({
        workSlot: unsupported.workSlot,
        invocation: unsupported.invocation,
      })
    ).toBe(false);
  });

  it('executes a Claude Code slot with the provider-neutral runtime kind', async () => {
    const terminalJson = '{"payloadVersion":2}';
    const execute = jest.fn(async (runInput) => {
      expect(runInput.providerKind).toBe(ReviewAgentProviderKind.ClaudeCode);
      return {
        status: ReviewInvestigationRunStatus.Completed,
        snapshot: terminalSnapshot(
          terminalJson,
          ReviewAgentProviderKind.ClaudeCode
        ),
      };
    });
    const adapter = new ReviewInvestigationRecordingAdapter(
      () => ({ execute }) as never,
      options()
    );

    await expect(
      adapter.execute(executionInput(ReviewExecutionProviderKind.ClaudeCode))
    ).resolves.toMatchObject({ actualModel: 'gpt-test' });
  });

  it.each([
    ReviewInvestigationRunStatus.Parked,
    ReviewInvestigationRunStatus.RecoveryRequired,
    ReviewInvestigationRunStatus.TransitionBudgetExhausted,
  ])(
    'preserves the authoritative legacy review when record-only investigation is %s',
    async (status) => {
      const adapter = new ReviewInvestigationRecordingAdapter(
        () =>
          ({
            execute: jest.fn(async () => ({
              status,
              snapshot: activeSnapshot(),
            })),
          }) as never,
        options()
      );

      await expect(adapter.execute(executionInput())).rejects.toMatchObject({
        name: 'ReviewInvestigationLegacyFallbackSignal',
        reason: ReviewInvestigationLegacyFallbackReason.RecordOnlyDeferred,
        deferredStatus: status,
      });
    }
  );

  it('surfaces authoritative parked work as a typed deferral', async () => {
    const adapter = new ReviewInvestigationRecordingAdapter(
      () =>
        ({
          execute: jest.fn(async () => ({
            status: ReviewInvestigationRunStatus.Parked,
            snapshot: activeSnapshot(),
          })),
        }) as never,
      options(),
      ReviewInvestigationRecordingMode.Authoritative
    );

    await expect(adapter.execute(executionInput())).rejects.toMatchObject({
      name: 'ReviewInvestigationDeferredSignal',
      status: ReviewInvestigationRunStatus.Parked,
    } satisfies Partial<ReviewInvestigationDeferredSignal>);
  });

  it('maps fatal investigation gateway drift back to orchestration configuration failure', async () => {
    const adapter = new ReviewInvestigationRecordingAdapter(
      () =>
        ({
          execute: jest
            .fn()
            .mockRejectedValue(
              new ReviewInvestigationGatewayConfigurationError(
                ReviewInvestigationGatewayConfigurationFailureReason.ContextGatewayPolicyMismatch
              )
            ),
        }) as never,
      options()
    );

    await expect(adapter.execute(executionInput())).rejects.toMatchObject({
      name: ReviewInvocationConfigurationMismatchError.name,
      reason:
        ReviewInvocationConfigurationMismatchReason.ContextGatewayPolicyMismatch,
    });
  });

  it('exports exact deterministic production capability hashes', () => {
    expect(REVIEW_INVESTIGATION_COVERAGE_PROFILE).toEqual(
      capabilityGolden.coverageProfile.value
    );
    expect(canonicalJson(REVIEW_INVESTIGATION_COVERAGE_PROFILE)).toBe(
      capabilityGolden.coverageProfile.canonicalJson
    );
    expect(reviewInvestigationCoverageProfileHash()).toBe(
      capabilityGolden.coverageProfile.sha256
    );
    expect(REVIEW_INVESTIGATION_PRODUCTION_POLICY).toEqual(
      capabilityGolden.policy.value
    );
    expect(canonicalJson(REVIEW_INVESTIGATION_PRODUCTION_POLICY)).toBe(
      capabilityGolden.policy.canonicalJson
    );
    expect(reviewInvestigationPolicyHash()).toBe(
      capabilityGolden.policy.sha256
    );
  });

  it('keeps producer release identity only in the per-run open contract', () => {
    const releaseOne = reviewInvestigationCoverageContract('release-1');
    const releaseTwo = reviewInvestigationCoverageContract('release-2');
    expect(releaseOne).toEqual({
      ...capabilityGolden.coverageProfile.value,
      producerReleaseId: 'release-1',
    });
    expect(hash(canonicalJson(releaseOne))).not.toBe(
      hash(canonicalJson(releaseTwo))
    );
    expect(reviewInvestigationCoverageProfileHash()).toBe(
      capabilityGolden.coverageProfile.sha256
    );
  });
});

function executionInput(
  providerKind: ReviewExecutionProviderKind = ReviewExecutionProviderKind.Codex
) {
  const reviewRevisionHash = 'b'.repeat(64);
  const workSlot = {
    workSlotId: 'slot-1',
    taskKind: ReviewTaskKind.FindingDiscovery,
    providerKind,
    providerVoteIdentityHash: 'v'.repeat(64),
    shardKey: 'unit-1',
    required: true,
    attemptBudget: 2,
    retryPolicyVersion: 'retry-v1',
  } as const;
  const investigationProbePlan = createReviewInvestigationProbePlan({
    files: [
      probeFile('src/z.ts'),
      probeFile('src/a.ts'),
      probeFile('src/auth/session.ts'),
    ],
    fullDiff: [
      'diff --git a/src/auth/session.ts b/src/auth/session.ts',
      '--- a/src/auth/session.ts',
      '+++ b/src/auth/session.ts',
      '@@ -1 +1,2 @@',
      '+export function refreshSession() {}',
      '+emit("session.revoked");',
    ].join('\n'),
  });
  const coverageManifest = {
    version: 'review_prompt_coverage.v2',
    workSlotId: workSlot.workSlotId,
    reviewRevisionHash,
    paths: [
      {
        path: 'src/z.ts',
        kind: ReviewPromptPathCoverageKind.FullPatch,
        contentHash: null,
      },
      {
        path: 'src/a.ts',
        kind: ReviewPromptPathCoverageKind.FullPatch,
        contentHash: null,
      },
      {
        path: 'src/auth/session.ts',
        kind: ReviewPromptPathCoverageKind.FullPatch,
        contentHash: null,
      },
    ],
    coverageHash: 'd'.repeat(64),
  } as const;
  const investigationSeedEnvelope = buildReviewInvestigationSeedEnvelope({
    canonicalInventory: canonicalInventory([
      inventoryEntry('src/z.ts'),
      inventoryEntry('src/a.ts'),
      inventoryEntry('src/auth/session.ts'),
    ]),
    coverageManifest,
    probePlan: investigationProbePlan,
    requestedModel: 'gpt-test',
    reviewPrompt: 'Review the assigned change.',
  });
  const invocation = {
    workSlotId: workSlot.workSlotId,
    attemptOrdinal: 1,
    provider: 'codex/gpt-test',
    requestedModel: 'gpt-test',
    reviewPrompt: 'Review the assigned change.',
    immutableRequest: {},
    investigationProbePlan,
    investigationSeedEnvelope,
    coverageManifest,
    manifestFacts: {
      taskKindSet: [ReviewTaskKind.FindingDiscovery],
      providerKind,
      providerCapabilityHash: '1'.repeat(64),
      providerRequestEnvelopeHash: investigationSeedEnvelope.hash,
      outputSchemaHash: '3'.repeat(64),
      filePatchManifestHash: '4'.repeat(64),
      contextManifestHash: '5'.repeat(64),
      lifecycleTargetSetHash: null,
      liveLifecycleStateHash: null,
      toolPolicyHash: '6'.repeat(64),
      executionProfile: 'investigation_gateway_v1',
      baseTreeHash: '7'.repeat(64),
      environmentContractHash: '8'.repeat(64),
    },
  } as const;
  return {
    authorization: {
      authorizationId: 'authorization-1',
      authorizationToken: 'authorization-token',
      facts: {
        producerReleaseId: 'release-1',
        reviewRevisionHash,
      },
    } as never,
    execution: { executionId: 'execution-1' } as never,
    workSlot,
    invocation,
    manifest: {
      manifestCanonicalJson: '{}',
      manifestKey: '9'.repeat(64),
      providerInvocationKey: 'a'.repeat(64),
      providerVoteIdentityHash: workSlot.providerVoteIdentityHash,
    },
    ownerIdHash: 'e'.repeat(64),
    sourceReviewRevisionHash: reviewRevisionHash,
    signal: new AbortController().signal,
  } as const;
}

function probeFile(
  path: string,
  status: ReviewInvestigationChangedFileStatus = ReviewInvestigationChangedFileStatus.Modified
) {
  return Object.freeze({
    path,
    previousPath: null,
    status,
    patch: null,
  });
}

function canonicalInventory(
  entries: readonly ReviewInvestigationCanonicalInventoryEntry[]
): ReviewInvestigationCanonicalInventory {
  const identity = {
    inventoryVersion: 2 as const,
    mergeBaseTreeOid: hash('merge-base-tree').slice(0, 40),
    headTreeOid: hash('head-tree').slice(0, 40),
    entries: Object.freeze([...entries]),
  };
  return Object.freeze({
    ...identity,
    itemCount: entries.length,
    inventoryHash: hash(canonicalJson(identity)),
  });
}

function inventoryEntry(
  path: string,
  status: ReviewInvestigationChangedFileStatus = ReviewInvestigationChangedFileStatus.Modified
): ReviewInvestigationCanonicalInventoryEntry {
  const removed = status === ReviewInvestigationChangedFileStatus.Removed;
  return Object.freeze({
    status: removed ? 'deleted' : 'modified',
    beforePath: path,
    afterPath: removed ? null : path,
    beforeMode: '100644',
    afterMode: removed ? '000000' : '100644',
    beforeOid: hash(`${path}:before`).slice(0, 40),
    afterOid: removed ? '0'.repeat(40) : hash(`${path}:after`).slice(0, 40),
    beforeContentKind: 'text',
    beforeByteCount: 20,
    beforeLineCount: 1,
    afterContentKind: removed ? 'absent' : 'text',
    afterByteCount: removed ? null : 20,
    afterLineCount: removed ? null : 1,
    contentKind: 'text',
    byteCount: 20,
    lineCount: 1,
    generated: false,
    generatedPolicySource: null,
  });
}

function options() {
  return {
    workingDirectory: '/tmp/review-investigation-fixture',
    leaseDurationMs: 300_000,
    providerTimeoutMs: 600_000,
    certificateTtlMs: 86_400_000,
    minimumCapacityParkMs: 60_000,
    maxObligationsForTurn: 64,
    maxStateTransitions: 128,
    policy: REVIEW_INVESTIGATION_PRODUCTION_POLICY,
  } as const;
}

function fileSubject(
  path: string,
  revision: 'head' | 'merge_base' = 'head'
): string {
  return canonicalJson({
    kind: 'file_read',
    pathHash: hash(path),
    revision,
    subjectVersion: 1,
  });
}

function activeSnapshot() {
  return {
    investigationId: 'investigation-1',
    version: 2,
    state: ReviewInvestigationState.TurnLeased,
    dossierDigest: 'f'.repeat(64),
    openObligationCount: 2,
    satisfiedObligationCount: 1,
    unresolvableObligationCount: 0,
    findingCount: 0,
    semanticTurns: 0,
    operationalAttempts: 0,
    criticCycles: 0,
    nextEligibleAt: null,
    nextAction: ReviewInvestigationNextAction.RunTurn,
    turn: {
      turnId: 'turn-1',
      purpose: ReviewTurnPurpose.Discovery,
      leasedAtVersion: 2,
      dossierDigest: 'f'.repeat(64),
      obligationIds: ['1'.repeat(64)],
      semanticTurnOrdinal: 1,
      criticCycleOrdinal: 0,
      leasedAt: '2026-08-02T10:00:00.000Z',
      expiresAt: '2026-08-02T10:05:00.000Z',
      turnCapability: 'turn-capability',
      brief: {
        briefVersion: 1,
        investigationId: 'investigation-1',
        investigationVersion: 2,
        dossierDigest: 'f'.repeat(64),
        turnId: 'turn-1',
        purpose: ReviewTurnPurpose.Discovery,
        maximumSemanticRiskPriority: 500_000,
        obligations: [],
      },
    },
    certificateId: null,
    certificateHash: null,
    terminalProviderKind: null,
    terminalActualModel: null,
    terminalObservationCanonicalJson: null,
    terminalOutcomeHash: null,
    conclusion: null,
  } as const;
}

function terminalSnapshot(
  terminalJson: string,
  providerKind: ReviewAgentProviderKind = ReviewAgentProviderKind.Codex
) {
  return {
    ...activeSnapshot(),
    version: 7,
    state: ReviewInvestigationState.Concluded,
    nextAction: ReviewInvestigationNextAction.Terminal,
    turn: null,
    findingCount: 0,
    operationalAttempts: 2,
    certificateId: 'certificate-1',
    certificateHash: 'c'.repeat(64),
    terminalProviderKind: providerKind,
    terminalActualModel: 'gpt-test',
    terminalObservationCanonicalJson: terminalJson,
    terminalOutcomeHash: hash(terminalJson),
    conclusion: ReviewInvestigationConclusion.VerifiedClean,
  } as const;
}
