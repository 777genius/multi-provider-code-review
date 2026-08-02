import {
  ReviewInvestigationMutationResultStatus,
  ReviewInvestigationNextAction,
  ReviewInvestigationPublishedState,
} from '../../../src/control-plane/generated/review-action-v2/review-action-v2';
import { ReviewActionV2InvestigationAdapter } from '../../../src/review-investigation/infrastructure/review-action-v2-investigation-adapter';
import {
  canonicalJson,
  sha256,
} from '../../../src/review-investigation/domain/canonical-json';
import {
  ReviewInvestigationState,
  ReviewInvestigationNextAction as DomainNextAction,
  type ReviewInvestigationSnapshot,
} from '../../../src/review-investigation/domain/investigation-state';
import {
  ReviewTurnObligationKind,
  ReviewTurnPurpose,
} from '../../../src/review-investigation/domain/turn-observation';

describe('ReviewActionV2InvestigationAdapter turn brief', () => {
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
  };
  return {
    status: ReviewInvestigationMutationResultStatus.Applied,
    investigationId: 'investigation-1',
    investigationVersion: '2',
    investigationState: ReviewInvestigationPublishedState.TurnLeased,
    dossierDigest: digest('d'),
    nextAction: ReviewInvestigationNextAction.RunTurn,
    investigationCanonicalJson: canonicalJson(readModel),
    turnId: 'turn-1',
    turnCapability: 'turn.capability.value',
    turnExpiresAt: '2026-08-02T10:05:00.000Z',
    ...input,
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
  });
}

function digest(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}
