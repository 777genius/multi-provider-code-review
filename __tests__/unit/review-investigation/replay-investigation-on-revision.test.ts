import {
  ReplayInvestigationOnRevision,
  ReviewInvestigationCurrency,
  type PreparedInvestigationReplay,
  type ReviewInvestigationOpenInput,
  type ReviewInvestigationTargetRevision,
  type ReviewInvestigationTargetScope,
} from '../../../src/review-investigation/application';
import { sha256 } from '../../../src/review-investigation/domain/canonical-json';

describe('ReplayInvestigationOnRevision', () => {
  it('commits successful receipt proofs independently and reopens mismatches', async () => {
    const prepared = preparation();
    const controlPlane = {
      prepareReplay: jest.fn().mockResolvedValue(prepared),
      commitReceiptReplay: jest
        .fn()
        .mockResolvedValueOnce({ replayProofId: 'proof-a' })
        .mockResolvedValueOnce(null),
      replay: jest.fn().mockResolvedValue({ investigationId: 'target' }),
    };
    const receipts = {
      replayReceipt: jest
        .fn()
        .mockResolvedValueOnce(replayResult('a'))
        .mockResolvedValueOnce(replayResult('b')),
    };
    const currency = {
      check: jest.fn().mockResolvedValue(ReviewInvestigationCurrency.Current),
    };
    const useCase = new ReplayInvestigationOnRevision({
      controlPlane: controlPlane as never,
      receipts,
      currency,
    });

    await expect(useCase.execute(input())).resolves.toEqual({
      investigationId: 'target',
    });
    expect(receipts.replayReceipt).toHaveBeenCalledTimes(2);
    expect(controlPlane.replay).toHaveBeenCalledWith(
      expect.objectContaining({
        open: expect.objectContaining({
          seedEnvelope: input().open.seedEnvelope,
          initialReceipts: [],
        }),
        replayProofs: [
          {
            obligationId: prepared.obligations[0]!.obligationId,
            replayProofId: 'proof-a',
          },
        ],
      })
    );
  });

  it('falls back before target mutation when no source is prepared', async () => {
    const controlPlane = {
      prepareReplay: jest.fn().mockResolvedValue(null),
      commitReceiptReplay: jest.fn(),
      replay: jest.fn(),
    };
    const useCase = new ReplayInvestigationOnRevision({
      controlPlane: controlPlane as never,
      receipts: { replayReceipt: jest.fn() },
      currency: {
        check: jest.fn().mockResolvedValue(ReviewInvestigationCurrency.Current),
      },
    });

    await expect(useCase.execute(input())).resolves.toBeNull();
    expect(controlPlane.replay).not.toHaveBeenCalled();
  });

  it('executes an identical receipt selection only once for multiple obligations', async () => {
    const first = receipt('shared');
    const prepared = Object.freeze({
      ...preparation(),
      obligations: Object.freeze([
        first,
        Object.freeze({ ...first, obligationId: sha256('other-obligation') }),
      ]),
    });
    const controlPlane = {
      prepareReplay: jest.fn().mockResolvedValue(prepared),
      commitReceiptReplay: jest
        .fn()
        .mockResolvedValue({ replayProofId: 'proof-shared' }),
      replay: jest.fn().mockResolvedValue({ investigationId: 'target' }),
    };
    const receipts = {
      replayReceipt: jest.fn().mockResolvedValue(replayResult('c')),
    };
    const useCase = new ReplayInvestigationOnRevision({
      controlPlane: controlPlane as never,
      receipts,
      currency: {
        check: jest.fn().mockResolvedValue(ReviewInvestigationCurrency.Current),
      },
    });

    await useCase.execute(input());

    expect(receipts.replayReceipt).toHaveBeenCalledTimes(1);
    expect(controlPlane.commitReceiptReplay).toHaveBeenCalledTimes(1);
    expect(controlPlane.replay.mock.calls[0]?.[0].replayProofs).toHaveLength(2);
  });

  it('stops without applying replay when the target revision is superseded', async () => {
    const controlPlane = {
      prepareReplay: jest.fn().mockResolvedValue(preparation()),
      commitReceiptReplay: jest.fn(),
      replay: jest.fn(),
    };
    const currency = {
      check: jest
        .fn()
        .mockResolvedValueOnce(ReviewInvestigationCurrency.Current)
        .mockResolvedValueOnce(ReviewInvestigationCurrency.Superseded),
    };
    const receipts = { replayReceipt: jest.fn() };
    const useCase = new ReplayInvestigationOnRevision({
      controlPlane: controlPlane as never,
      receipts,
      currency,
    });

    await expect(useCase.execute(input())).resolves.toBeNull();
    expect(receipts.replayReceipt).not.toHaveBeenCalled();
    expect(controlPlane.replay).not.toHaveBeenCalled();
  });
});

function input(): {
  open: ReviewInvestigationOpenInput;
  scope: ReviewInvestigationTargetScope;
  revision: ReviewInvestigationTargetRevision;
  providerManifestCanonicalJson: string;
  providerManifestHash: string;
} {
  const providerManifestCanonicalJson = '{}';
  return {
    open: {
      authorizationToken: 'authorization-token',
      authorizationId: 'authorization-1',
      executionId: 'execution-1',
      workSlotId: 'slot-1',
      reviewRevisionHash: sha256('target-revision'),
      stableReviewUnitKey: 'stable-unit',
      providerVoteLaneId: 'lane-1',
      providerStrategyId: sha256('provider-strategy'),
      runtimeProfile: 'gateway_attested_agent_v1',
      coverageContract: {},
      investigationPolicy: {},
      seedEnvelope: {
        canonicalJson: '{}',
        hash: sha256('{}'),
      },
      initialReceipts: [],
      providerManifestCanonicalJson,
      providerManifestHash: sha256(providerManifestCanonicalJson),
      ownerIdHash: sha256('owner'),
    },
    scope: {
      workspaceId: 'workspace-1',
      repositoryConnectionId: 'connection-1',
      scmRepositoryIdentityId: 'repository-1',
      pullRequestNumber: 7,
      trustDomain: 'trusted',
      authorizationScopeHash: sha256('scope'),
    },
    revision: {
      baseSha: '1'.repeat(40),
      mergeBaseSha: '2'.repeat(40),
      headSha: '3'.repeat(40),
      reviewRevisionHash: sha256('target-revision'),
    },
    providerManifestCanonicalJson,
    providerManifestHash: sha256(providerManifestCanonicalJson),
  };
}

function preparation(): PreparedInvestigationReplay {
  return Object.freeze({
    sourceInvestigationId: 'source-investigation',
    sourceCertificateId: 'source-certificate',
    sourceCertificateHash: sha256('source-certificate'),
    obligations: Object.freeze([receipt('a'), receipt('b')]),
  });
}

function receipt(suffix: string) {
  return Object.freeze({
    obligationId: sha256(`obligation-${suffix}`),
    contextAttestationId: `attestation-${suffix}`,
    contextAttestationHash: sha256(`attestation-${suffix}`),
    sourceOperationReceiptIdsHash: sha256(`receipts-${suffix}`),
    replayCapability: `capability-${suffix}`,
    replayPlanCanonicalJson: '{}',
    replayPlanHash: sha256('{}'),
  });
}

function replayResult(suffix: string) {
  return Object.freeze({
    targetCheckoutTreeOid: suffix.repeat(40),
    replayResultCanonicalJson: '{}',
    replayResultHash: sha256('{}'),
  });
}
