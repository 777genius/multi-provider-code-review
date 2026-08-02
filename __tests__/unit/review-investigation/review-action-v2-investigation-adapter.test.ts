import {
  ReviewInvestigationMutationResultStatus,
  ReviewInvestigationNextAction,
  ReviewInvestigationPublishedConclusion,
  ReviewInvestigationPublishedState,
  ReviewInvestigationRestoreResultStatus,
} from '../../../src/control-plane/generated/review-action-v2/review-action-v2';
import { ReviewActionV2InvestigationAdapter } from '../../../src/review-investigation/infrastructure/review-action-v2-investigation-adapter';
import {
  canonicalJson,
  sha256,
} from '../../../src/review-investigation/domain/canonical-json';
import {
  ReviewInvestigationState,
  ReviewInvestigationConclusion,
  ReviewInvestigationNextAction as DomainNextAction,
  type ReviewInvestigationSnapshot,
} from '../../../src/review-investigation/domain/investigation-state';
import { ReviewAgentProviderKind } from '../../../src/review-investigation/domain/runtime-profile';
import {
  ReviewTurnObligationKind,
  ReviewTurnPurpose,
} from '../../../src/review-investigation/domain/turn-observation';

describe('ReviewActionV2InvestigationAdapter turn brief', () => {
  it('restores a complete certificate-backed terminal artifact', async () => {
    const result = terminalResult();
    const adapter = new ReviewActionV2InvestigationAdapter({
      execute: jest.fn().mockResolvedValue(result),
    } as never);

    await expect(
      adapter.restore({
        authorizationToken: 'authorization-token',
        authorizationId: 'authorization-1',
        investigationId: 'investigation-1',
        reviewRevisionHash: digest('r'),
      })
    ).resolves.toMatchObject({
      state: ReviewInvestigationState.Concluded,
      certificateId: 'certificate-1',
      terminalProviderKind: ReviewAgentProviderKind.Codex,
      terminalActualModel: 'gpt-test',
      conclusion: ReviewInvestigationConclusion.VerifiedClean,
    });
  });

  it('rejects a terminal artifact whose payload hash is inconsistent', async () => {
    const adapter = new ReviewActionV2InvestigationAdapter({
      execute: jest
        .fn()
        .mockResolvedValue(
          terminalResult({ terminalOutcomeHash: digest('f') })
        ),
    } as never);

    await expect(
      adapter.restore({
        authorizationToken: 'authorization-token',
        authorizationId: 'authorization-1',
        investigationId: 'investigation-1',
        reviewRevisionHash: digest('r'),
      })
    ).rejects.toThrow('investigation_terminal_artifact_invalid');
  });

  it('binds a canonical turn brief to the returned dossier and turn', async () => {
    const brief = canonicalJson({
      briefVersion: 1,
      investigationId: 'investigation-1',
      investigationVersion: 2,
      dossierDigest: digest('d'),
      turnId: 'turn-1',
      purpose: ReviewTurnPurpose.Discovery,
      obligations: [
        {
          obligationId: digest('b'),
          kind: ReviewTurnObligationKind.ChangedContent,
          canonicalSubject: 'src/review.ts',
          canonicalRequirement: 'inspect complete changed content',
          riskPriority: 100,
          origin: 'coverage_contract',
        },
      ],
    });
    const client = {
      execute: jest.fn().mockResolvedValue(
        planResult({
          turnBriefCanonicalJson: brief,
          turnBriefHash: sha256(brief),
        })
      ),
    };
    const adapter = new ReviewActionV2InvestigationAdapter(client as never);

    const planned = await adapter.planTurn({
      authorizationToken: 'authorization-token',
      snapshot: unplannedSnapshot(),
      leaseDurationMs: 60_000,
      maxObligationsForTurn: 4,
      turnBudget: { maxTokens: 10_000 },
    });

    expect(planned.turn?.brief).toEqual({
      briefVersion: 1,
      investigationId: 'investigation-1',
      investigationVersion: 2,
      dossierDigest: digest('d'),
      turnId: 'turn-1',
      purpose: ReviewTurnPurpose.Discovery,
      obligations: [
        {
          obligationId: digest('b'),
          kind: ReviewTurnObligationKind.ChangedContent,
          canonicalSubject: 'src/review.ts',
          canonicalRequirement: 'inspect complete changed content',
          riskPriority: 100,
          origin: 'coverage_contract',
        },
      ],
    });
  });

  it('rejects a turn brief whose hash does not match', async () => {
    const brief = canonicalJson(null);
    const client = {
      execute: jest.fn().mockResolvedValue(
        planResult({
          turnBriefCanonicalJson: brief,
          turnBriefHash: digest('f'),
        })
      ),
    };
    const adapter = new ReviewActionV2InvestigationAdapter(client as never);

    await expect(
      adapter.planTurn({
        authorizationToken: 'authorization-token',
        snapshot: unplannedSnapshot(),
        leaseDurationMs: 60_000,
        maxObligationsForTurn: 4,
        turnBudget: { maxTokens: 10_000 },
      })
    ).rejects.toThrow('turn_brief_hash_mismatch');
  });
});

function planResult(input: {
  turnBriefCanonicalJson: string;
  turnBriefHash: string;
}) {
  const readModel = {
    investigationId: 'investigation-1',
    version: 2,
    state: ReviewInvestigationState.TurnLeased,
    dossierDigest: digest('d'),
    openObligationCount: 1,
    satisfiedObligationCount: 0,
    unresolvableObligationCount: 0,
    findingCount: 0,
    semanticTurns: 0,
    operationalAttempts: 1,
    criticCycles: 0,
    nextEligibleAt: null,
    nextAction: DomainNextAction.RunTurn,
    turn: {
      turnId: 'turn-1',
      purpose: ReviewTurnPurpose.Discovery,
      leasedAtVersion: 2,
      dossierDigest: digest('d'),
      obligationIds: [digest('b')],
      semanticTurnOrdinal: 1,
      criticCycleOrdinal: 0,
      leasedAt: '2026-08-02T10:00:00.000Z',
      expiresAt: '2026-08-02T10:05:00.000Z',
    },
    certificateId: null,
    certificateHash: null,
    terminalProviderKind: null,
    terminalActualModel: null,
    terminalObservationCanonicalJson: null,
    terminalOutcomeHash: null,
    conclusion: null,
  };
  return {
    status: ReviewInvestigationMutationResultStatus.Applied,
    investigationId: 'investigation-1',
    investigationVersion: '2',
    investigationState: ReviewInvestigationPublishedState.TurnLeased,
    dossierDigest: digest('d'),
    nextAction: ReviewInvestigationNextAction.RunTurn,
    investigationCanonicalJson: canonicalJson(readModel),
    certificateId: null,
    certificateHash: null,
    terminalProviderKind: null,
    terminalActualModel: null,
    terminalObservationCanonicalJson: null,
    terminalOutcomeHash: null,
    investigationConclusion: null,
    turnId: 'turn-1',
    turnCapability: 'turn.capability.value',
    turnExpiresAt: '2026-08-02T10:05:00.000Z',
    ...input,
  };
}

function terminalResult(
  overrides: Partial<{
    terminalOutcomeHash: string;
  }> = {}
) {
  const terminalObservationCanonicalJson = canonicalJson({ payloadVersion: 2 });
  const terminalOutcomeHash =
    overrides.terminalOutcomeHash ?? sha256(terminalObservationCanonicalJson);
  const readModel = {
    investigationId: 'investigation-1',
    version: 7,
    state: ReviewInvestigationState.Concluded,
    dossierDigest: digest('d'),
    openObligationCount: 0,
    satisfiedObligationCount: 2,
    unresolvableObligationCount: 0,
    findingCount: 0,
    semanticTurns: 1,
    operationalAttempts: 1,
    criticCycles: 1,
    nextEligibleAt: null,
    nextAction: DomainNextAction.Terminal,
    turn: null,
    certificateId: 'certificate-1',
    certificateHash: digest('c'),
    terminalProviderKind: ReviewAgentProviderKind.Codex,
    terminalActualModel: 'gpt-test',
    terminalObservationCanonicalJson,
    terminalOutcomeHash,
    conclusion: ReviewInvestigationConclusion.VerifiedClean,
  };
  return {
    status: ReviewInvestigationRestoreResultStatus.Found,
    investigationId: readModel.investigationId,
    investigationVersion: String(readModel.version),
    investigationState: ReviewInvestigationPublishedState.Concluded,
    dossierDigest: readModel.dossierDigest,
    nextAction: ReviewInvestigationNextAction.Terminal,
    investigationCanonicalJson: canonicalJson(readModel),
    certificateId: readModel.certificateId,
    certificateHash: readModel.certificateHash,
    terminalProviderKind: readModel.terminalProviderKind,
    terminalActualModel: readModel.terminalActualModel,
    terminalObservationCanonicalJson,
    terminalOutcomeHash,
    investigationConclusion:
      ReviewInvestigationPublishedConclusion.VerifiedClean,
  };
}

function unplannedSnapshot(): ReviewInvestigationSnapshot {
  return Object.freeze({
    investigationId: 'investigation-1',
    version: 1,
    state: ReviewInvestigationState.AwaitingTurn,
    dossierDigest: digest('a'),
    openObligationCount: 1,
    satisfiedObligationCount: 0,
    unresolvableObligationCount: 0,
    findingCount: 0,
    semanticTurns: 0,
    operationalAttempts: 0,
    criticCycles: 0,
    nextEligibleAt: null,
    nextAction: DomainNextAction.RunTurn,
    turn: null,
    certificateId: null,
    certificateHash: null,
    terminalProviderKind: null,
    terminalActualModel: null,
    terminalObservationCanonicalJson: null,
    terminalOutcomeHash: null,
    conclusion: null,
  });
}

function digest(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}
