import { createHash } from 'crypto';
import {
  ReviewExecutionProviderKind,
  ReviewTaskKind,
} from '../../../src/review-orchestration/application';
import { ReviewPromptPathCoverageKind } from '../../../src/review-orchestration/domain';
import { ReviewInvestigationRecordingAdapter } from '../../../src/review-orchestration/infrastructure/review-investigation-recording-adapter';
import {
  ReviewInvestigationConclusion,
  ReviewInvestigationNextAction,
  ReviewInvestigationRunStatus,
  ReviewInvestigationState,
} from '../../../src/review-investigation/domain/investigation-state';
import { ReviewAgentProviderKind } from '../../../src/review-investigation/domain/runtime-profile';
import { ReviewTurnPurpose } from '../../../src/review-investigation/domain/turn-observation';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

describe('ReviewInvestigationRecordingAdapter', () => {
  it('projects only a certificate-backed terminal observation', async () => {
    const terminalJson = '{"payloadVersion":2}';
    const execute = jest.fn(async (runInput) => {
      expect(runInput.seedObligations).toEqual([
        expect.objectContaining({ kind: 'inventory_witness' }),
        expect.objectContaining({ canonicalSubject: 'src/a.ts@head' }),
        expect.objectContaining({ canonicalSubject: 'src/z.ts@head' }),
      ]);
      expect(runInput.managedLease()).toMatchObject({
        leaseId: 'lease-1',
        fencingToken: '7',
      });
      const prompt = runInput.promptFor(activeSnapshot());
      expect(prompt).toContain(
        'REVIEWROUTER_INVESTIGATION_TURN_BRIEF_V1_BASE64URL:'
      );
      return {
        status: ReviewInvestigationRunStatus.Completed,
        snapshot: terminalSnapshot(terminalJson),
      };
    });
    const adapter = new ReviewInvestigationRecordingAdapter(
      () => ({ execute }) as never,
      options()
    );

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

  it('does not claim lifecycle or legacy gateway work', () => {
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
            executionProfile: 'context_gateway_v1',
          },
        },
      })
    ).toBe(false);
  });
});

function executionInput() {
  const reviewRevisionHash = 'b'.repeat(64);
  const workSlot = {
    workSlotId: 'slot-1',
    taskKind: ReviewTaskKind.FindingDiscovery,
    providerKind: ReviewExecutionProviderKind.Codex,
    providerVoteIdentityHash: 'v'.repeat(64),
    shardKey: 'unit-1',
    required: true,
    attemptBudget: 2,
    retryPolicyVersion: 'retry-v1',
  } as const;
  const invocation = {
    workSlotId: workSlot.workSlotId,
    attemptOrdinal: 1,
    provider: 'codex/gpt-test',
    requestedModel: 'gpt-test',
    reviewPrompt: 'Review the assigned change.',
    immutableRequest: {},
    coverageManifest: {
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
      ],
      coverageHash: 'd'.repeat(64),
    },
    manifestFacts: {
      taskKindSet: [ReviewTaskKind.FindingDiscovery],
      providerKind: ReviewExecutionProviderKind.Codex,
      providerCapabilityHash: '1'.repeat(64),
      providerRequestEnvelopeHash: '2'.repeat(64),
      outputSchemaHash: '3'.repeat(64),
      filePatchManifestHash: '4'.repeat(64),
      contextManifestHash: '5'.repeat(64),
      lifecycleTargetSetHash: null,
      liveLifecycleStateHash: null,
      toolPolicyHash: '6'.repeat(64),
      executionProfile: 'context_gateway_v1',
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
    currentLease: () => ({
      leaseId: 'lease-1',
      attemptId: 'attempt-1',
      leaseCapability: 'lease-capability',
      fencingToken: '7',
      expiresAt: '2026-08-02T10:05:00.000Z',
      resultReportUntil: '2026-08-02T10:10:00.000Z',
      renewalCeilingReached: false,
    }),
    ownerIdHash: 'e'.repeat(64),
    sourceReviewRevisionHash: reviewRevisionHash,
    signal: new AbortController().signal,
  } as const;
}

function options() {
  return {
    workingDirectory: '/tmp/review-investigation-fixture',
    providerCredentialEnvironment: () => ({}),
    leaseDurationMs: 300_000,
    providerTimeoutMs: 600_000,
    certificateTtlMs: 86_400_000,
    minimumCapacityParkMs: 60_000,
    maxObligationsForTurn: 64,
    maxStateTransitions: 128,
    maxSemanticTurns: 12,
    maxOperationalAttempts: 24,
    maxCriticCycles: 3,
    maxObligations: 1_024,
    maxFindings: 256,
    maxProposalsPerTurn: 128,
    maxReceiptsPerTurn: 256,
    maxExpansionDepth: 8,
  } as const;
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

function terminalSnapshot(terminalJson: string) {
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
    terminalProviderKind: ReviewAgentProviderKind.Codex,
    terminalActualModel: 'gpt-test',
    terminalObservationCanonicalJson: terminalJson,
    terminalOutcomeHash: hash(terminalJson),
    conclusion: ReviewInvestigationConclusion.VerifiedClean,
  } as const;
}
