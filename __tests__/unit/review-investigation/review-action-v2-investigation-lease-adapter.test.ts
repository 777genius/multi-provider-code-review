import {
  ReviewActionV2ClientError,
  ReviewActionV2ClientFailureCode,
} from '../../../src/control-plane/review-action-v2-client';
import {
  ReviewActionV2OperationId,
  ReviewActionV2ProtocolErrorCode,
  ReviewInvestigationLeaseResultStatus,
} from '../../../src/control-plane/generated/review-action-v2/review-action-v2';
import {
  ReviewInvestigationControlPlaneFailureClass,
  ReviewInvestigationLeaseAcquireStatus,
  type ReviewInvestigationLease,
} from '../../../src/review-investigation/application/investigation-control-plane-port';
import {
  ReviewInvestigationNextAction,
  ReviewInvestigationState,
  type ReviewInvestigationSnapshot,
} from '../../../src/review-investigation/domain/investigation-state';
import { ReviewTurnPurpose } from '../../../src/review-investigation/domain/turn-observation';
import { ReviewActionV2InvestigationLeaseAdapter } from '../../../src/review-investigation/infrastructure/review-action-v2-investigation-lease-adapter';

const providerStrategyId = 'a'.repeat(64);
const providerManifestHash = 'b'.repeat(64);
const ownerIdHash = 'c'.repeat(64);
const providerManifestCanonicalJson = '{"providers":["codex"]}';

const acquireRequestId =
  'rr:investigation-lease-acquire:87533827796ffcf2cbd2cdd4e3cd1ac6feaa9a9f';
const acquireIdempotencyKey =
  'rr:investigation-lease-acquire-idem:e579eadea6c8071aaf6a25664cb05b479456d22c';
const renewRequestId = 'rr:investigation-lease-renew:renew-request-1';
const renewIdempotencyKey =
  'rr:investigation-lease-renew-idem:871a9415f5799413c97f14c382e4c2900d72c1e4';
const releaseRequestId =
  'rr:investigation-lease-release:7fd240cea8d87146febac19d031bf3f28fc8365d';
const releaseIdempotencyKey =
  'rr:investigation-lease-release-idem:3115075b99c018a6669ef8aa2b196c23bd35f861';

const lease: ReviewInvestigationLease = Object.freeze({
  leaseId: 'lease-1',
  attemptId: 'attempt-1',
  leaseCapability: 'lease.capability.initial',
  fencingToken: '41',
  expiresAt: '2026-08-05T10:05:00.000Z',
  resultReportUntil: '2026-08-05T10:15:00.000Z',
});

describe('ReviewActionV2InvestigationLeaseAdapter', () => {
  describe('acquire', () => {
    it.each([
      ReviewInvestigationLeaseResultStatus.Acquired,
      ReviewInvestigationLeaseResultStatus.Restored,
    ])(
      'sends the exact acquire request and maps %s with all lease fields',
      async (status) => {
        const execute = jest.fn().mockResolvedValue({ status, ...lease });
        const adapter = createAdapter(execute);

        await expect(adapter.acquire(acquireInput())).resolves.toEqual({
          status: ReviewInvestigationLeaseAcquireStatus.Acquired,
          lease,
        });
        expect(execute).toHaveBeenCalledTimes(1);
        expect(execute).toHaveBeenCalledWith(
          ReviewActionV2OperationId.ReviewInvestigationLeaseAcquire,
          {
            authorizationToken: 'authorization-token',
            idempotencyKey: acquireIdempotencyKey,
            investigationId: 'investigation-1',
            expectedVersion: '7',
            turnId: 'turn-1',
            turnCapability: 'turn.capability.value',
            providerStrategyId,
            investigationManifestCanonicalJson: providerManifestCanonicalJson,
            investigationManifestHash: providerManifestHash,
            acquireRequestId,
            ownerIdHash,
          }
        );
      }
    );

    it.each([
      [
        ReviewInvestigationLeaseResultStatus.Busy,
        ReviewInvestigationLeaseAcquireStatus.Busy,
      ],
      [
        ReviewInvestigationLeaseResultStatus.BindingStale,
        ReviewInvestigationLeaseAcquireStatus.NotRunnable,
      ],
      [
        ReviewInvestigationLeaseResultStatus.Rejected,
        ReviewInvestigationLeaseAcquireStatus.NotRunnable,
      ],
      [
        ReviewInvestigationLeaseResultStatus.Missing,
        ReviewInvestigationLeaseAcquireStatus.NotRunnable,
      ],
    ])('maps acquire status %s to %s', async (status, expectedStatus) => {
      const adapter = createAdapter(jest.fn().mockResolvedValue({ status }));

      await expect(adapter.acquire(acquireInput())).resolves.toEqual({
        status: expectedStatus,
      });
    });

    it('uses a fresh acquire identity for a new recovery cycle', async () => {
      const execute = jest.fn().mockResolvedValue({
        status: ReviewInvestigationLeaseResultStatus.Acquired,
        ...lease,
      });
      const requestIds = ['acquire-cycle-1', 'acquire-cycle-2'];
      const adapter = createAdapter(execute, () => requestIds.shift()!);

      await adapter.acquire(acquireInput());
      await adapter.acquire(acquireInput());

      const first = execute.mock.calls[0]![1];
      const second = execute.mock.calls[1]![1];
      expect(first.acquireRequestId).not.toBe(second.acquireRequestId);
      expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    });

    it('maps an acquire idempotency conflict to a typed conflict', async () => {
      const adapter = createAdapter(
        jest.fn().mockResolvedValue({
          status: ReviewInvestigationLeaseResultStatus.IdempotencyConflict,
        })
      );

      await expectFailure(
        adapter.acquire(acquireInput()),
        ReviewInvestigationControlPlaneFailureClass.Conflict,
        'investigation_lease_acquire_idempotency_conflict'
      );
    });

    it('rejects an acquire lease whose expiry exceeds its report ceiling', async () => {
      const adapter = createAdapter(
        jest.fn().mockResolvedValue({
          status: ReviewInvestigationLeaseResultStatus.Acquired,
          ...lease,
          expiresAt: '2026-08-05T10:16:00.000Z',
        })
      );

      await expectFailure(
        adapter.acquire(acquireInput()),
        ReviewInvestigationControlPlaneFailureClass.InvalidResponse,
        'investigation_lease_deadline_order_invalid'
      );
    });

    it.each([
      ReviewInvestigationLeaseResultStatus.Applied,
      ReviewInvestigationLeaseResultStatus.StaleFence,
      ReviewInvestigationLeaseResultStatus.Expired,
      ReviewInvestigationLeaseResultStatus.InvalidDeadline,
    ])('rejects acquire-only invalid status %s', async (status) => {
      const adapter = createAdapter(jest.fn().mockResolvedValue({ status }));

      await expectFailure(
        adapter.acquire(acquireInput()),
        ReviewInvestigationControlPlaneFailureClass.InvalidResponse,
        'investigation_lease_acquire_status_invalid'
      );
    });

    it.each([
      ['leaseId', { leaseId: null }, 'investigation_lease_id_missing'],
      ['attemptId', { attemptId: null }, 'investigation_attempt_id_missing'],
      [
        'leaseCapability',
        { leaseCapability: '' },
        'investigation_lease_capability_missing',
      ],
      [
        'fencingToken',
        { fencingToken: null },
        'investigation_lease_fencing_token_missing',
      ],
      [
        'expiresAt',
        { expiresAt: 'not-a-timestamp' },
        'investigation_lease_expires_at_invalid',
      ],
      [
        'resultReportUntil',
        { resultReportUntil: null },
        'investigation_lease_result_report_until_missing',
      ],
      [
        'valid resultReportUntil timestamp',
        { resultReportUntil: 'not-a-timestamp' },
        'investigation_lease_result_report_until_invalid',
      ],
    ])('requires acquire continuity field %s', async (_, override, message) => {
      const adapter = createAdapter(
        jest.fn().mockResolvedValue({
          status: ReviewInvestigationLeaseResultStatus.Acquired,
          ...lease,
          ...override,
        })
      );

      await expectFailure(
        adapter.acquire(acquireInput()),
        ReviewInvestigationControlPlaneFailureClass.InvalidResponse,
        message
      );
    });

    it.each([
      ['a missing turn', { turn: null }],
      [
        'a different turn ID',
        { turn: { ...investigationSnapshot().turn!, turnId: 'turn-2' } },
      ],
      [
        'an empty turn capability',
        { turn: { ...investigationSnapshot().turn!, turnCapability: '' } },
      ],
    ])('rejects %s before transport', async (_, snapshotOverride) => {
      const execute = jest.fn();
      const adapter = createAdapter(execute);

      await expectFailure(
        adapter.acquire({
          ...acquireInput(),
          snapshot: {
            ...investigationSnapshot(),
            ...snapshotOverride,
          },
        }),
        ReviewInvestigationControlPlaneFailureClass.InvalidResponse,
        'investigation_lease_turn_binding_invalid'
      );
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe('renew', () => {
    it.each([
      ReviewInvestigationLeaseResultStatus.Applied,
      ReviewInvestigationLeaseResultStatus.Restored,
    ])(
      'sends the exact renew request and preserves continuity on %s',
      async (status) => {
        const execute = jest.fn().mockResolvedValue({
          status,
          leaseId: lease.leaseId,
          fencingToken: lease.fencingToken,
          expiresAt: '2026-08-05T10:10:00.000Z',
          leaseCapability: 'lease.capability.rotated',
        });
        const adapter = createAdapter(execute);

        await expect(adapter.renew({ lease, ownerIdHash })).resolves.toEqual({
          leaseId: lease.leaseId,
          attemptId: lease.attemptId,
          leaseCapability: 'lease.capability.rotated',
          fencingToken: lease.fencingToken,
          expiresAt: '2026-08-05T10:10:00.000Z',
          resultReportUntil: lease.resultReportUntil,
        });
        expect(execute).toHaveBeenCalledTimes(1);
        expect(execute).toHaveBeenCalledWith(
          ReviewActionV2OperationId.ReviewInvestigationLeaseRenew,
          {
            leaseCapability: lease.leaseCapability,
            idempotencyKey: renewIdempotencyKey,
            leaseId: lease.leaseId,
            ownerIdHash,
            fencingToken: lease.fencingToken,
            renewRequestId,
          }
        );
      }
    );

    it.each([
      ['changed lease id', { leaseId: 'lease-takeover' }],
      ['changed fencing token', { fencingToken: '42' }],
      ['unrotated capability', { leaseCapability: lease.leaseCapability }],
      ['non-advancing expiry', { expiresAt: lease.expiresAt }],
      [
        'expiry beyond report ceiling',
        { expiresAt: '2026-08-05T10:16:00.000Z' },
      ],
    ])('rejects renewal drift with %s', async (_, override) => {
      const adapter = createAdapter(
        jest.fn().mockResolvedValue({
          status: ReviewInvestigationLeaseResultStatus.Applied,
          leaseId: lease.leaseId,
          fencingToken: lease.fencingToken,
          expiresAt: '2026-08-05T10:10:00.000Z',
          leaseCapability: 'lease.capability.rotated',
          ...override,
        })
      );

      await expectFailure(
        adapter.renew({ lease, ownerIdHash }),
        ReviewInvestigationControlPlaneFailureClass.InvalidResponse,
        'investigation_lease_renewal_drift'
      );
    });

    it.each([
      ReviewInvestigationLeaseResultStatus.BindingStale,
      ReviewInvestigationLeaseResultStatus.StaleFence,
      ReviewInvestigationLeaseResultStatus.Expired,
    ])('maps renew status %s to a stale precondition', async (status) => {
      const adapter = createAdapter(jest.fn().mockResolvedValue({ status }));

      await expectFailure(
        adapter.renew({ lease, ownerIdHash }),
        ReviewInvestigationControlPlaneFailureClass.StalePrecondition,
        `investigation_lease_renew_${status}`
      );
    });

    it('maps a renew idempotency conflict to a typed conflict', async () => {
      const adapter = createAdapter(
        jest.fn().mockResolvedValue({
          status: ReviewInvestigationLeaseResultStatus.IdempotencyConflict,
        })
      );

      await expectFailure(
        adapter.renew({ lease, ownerIdHash }),
        ReviewInvestigationControlPlaneFailureClass.Conflict,
        'investigation_lease_renew_idempotency_conflict'
      );
    });

    it.each([
      ReviewInvestigationLeaseResultStatus.Acquired,
      ReviewInvestigationLeaseResultStatus.Busy,
      ReviewInvestigationLeaseResultStatus.InvalidDeadline,
      ReviewInvestigationLeaseResultStatus.Rejected,
      ReviewInvestigationLeaseResultStatus.Missing,
    ])('maps renew status %s to rejected', async (status) => {
      const adapter = createAdapter(jest.fn().mockResolvedValue({ status }));

      await expectFailure(
        adapter.renew({ lease, ownerIdHash }),
        ReviewInvestigationControlPlaneFailureClass.Rejected,
        `investigation_lease_renew_${status}`
      );
    });

    it.each([
      ['leaseId', { leaseId: null }, 'investigation_lease_id_missing'],
      [
        'fencingToken',
        { fencingToken: '' },
        'investigation_lease_fencing_token_missing',
      ],
      [
        'expiresAt',
        { expiresAt: 'not-a-timestamp' },
        'investigation_lease_expires_at_invalid',
      ],
      [
        'leaseCapability',
        { leaseCapability: null },
        'investigation_lease_capability_missing',
      ],
    ])('requires renewed continuity field %s', async (_, override, message) => {
      const adapter = createAdapter(
        jest.fn().mockResolvedValue({
          status: ReviewInvestigationLeaseResultStatus.Applied,
          leaseId: lease.leaseId,
          fencingToken: lease.fencingToken,
          expiresAt: '2026-08-05T10:10:00.000Z',
          leaseCapability: 'lease.capability.rotated',
          ...override,
        })
      );

      await expectFailure(
        adapter.renew({ lease, ownerIdHash }),
        ReviewInvestigationControlPlaneFailureClass.InvalidResponse,
        message
      );
    });
  });

  describe('release', () => {
    it.each([
      ReviewInvestigationLeaseResultStatus.Applied,
      ReviewInvestigationLeaseResultStatus.Restored,
      ReviewInvestigationLeaseResultStatus.Missing,
      ReviewInvestigationLeaseResultStatus.Expired,
      ReviewInvestigationLeaseResultStatus.BindingStale,
      ReviewInvestigationLeaseResultStatus.StaleFence,
    ])('sends the exact release request and accepts %s', async (status) => {
      const execute = jest.fn().mockResolvedValue({ status });
      const adapter = createAdapter(execute);

      await expect(adapter.release(releaseInput())).resolves.toBeUndefined();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        ReviewActionV2OperationId.ReviewInvestigationLeaseRelease,
        {
          leaseCapability: lease.leaseCapability,
          idempotencyKey: releaseIdempotencyKey,
          leaseId: lease.leaseId,
          ownerIdHash,
          fencingToken: lease.fencingToken,
          releaseRequestId,
        }
      );
    });

    it('maps a release idempotency conflict to a typed conflict', async () => {
      const adapter = createAdapter(
        jest.fn().mockResolvedValue({
          status: ReviewInvestigationLeaseResultStatus.IdempotencyConflict,
        })
      );

      await expectFailure(
        adapter.release(releaseInput()),
        ReviewInvestigationControlPlaneFailureClass.Conflict,
        'investigation_lease_release_idempotency_conflict'
      );
    });

    it.each([
      ReviewInvestigationLeaseResultStatus.Acquired,
      ReviewInvestigationLeaseResultStatus.Busy,
      ReviewInvestigationLeaseResultStatus.InvalidDeadline,
      ReviewInvestigationLeaseResultStatus.Rejected,
    ])('maps release status %s to rejected', async (status) => {
      const adapter = createAdapter(jest.fn().mockResolvedValue({ status }));

      await expectFailure(
        adapter.release(releaseInput()),
        ReviewInvestigationControlPlaneFailureClass.Rejected,
        `investigation_lease_release_${status}`
      );
    });
  });

  describe('transport failures', () => {
    it.each([
      [
        'acquire',
        (adapter: ReviewActionV2InvestigationLeaseAdapter) =>
          adapter.acquire(acquireInput()),
      ],
      [
        'renew',
        (adapter: ReviewActionV2InvestigationLeaseAdapter) =>
          adapter.renew({ lease, ownerIdHash }),
      ],
      [
        'release',
        (adapter: ReviewActionV2InvestigationLeaseAdapter) =>
          adapter.release(releaseInput()),
      ],
    ])(
      'maps an unknown %s transport error to unavailable',
      async (_, invoke) => {
        const adapter = createAdapter(
          jest.fn().mockRejectedValue(new Error('sensitive transport detail'))
        );

        await expectFailure(
          invoke(adapter),
          ReviewInvestigationControlPlaneFailureClass.Unavailable,
          'investigation_lease_transport_unavailable'
        );
      }
    );

    it.each([
      [
        ReviewActionV2ProtocolErrorCode.AmbiguousOutcome,
        ReviewInvestigationControlPlaneFailureClass.AmbiguousOutcome,
      ],
      [
        ReviewActionV2ProtocolErrorCode.CapacityLimited,
        ReviewInvestigationControlPlaneFailureClass.CapacityLimited,
      ],
      [
        ReviewActionV2ProtocolErrorCode.CapabilityDisabled,
        ReviewInvestigationControlPlaneFailureClass.CapabilityDisabled,
      ],
      [
        ReviewActionV2ProtocolErrorCode.IdempotencyConflict,
        ReviewInvestigationControlPlaneFailureClass.Conflict,
      ],
      [
        ReviewActionV2ProtocolErrorCode.ResourceGone,
        ReviewInvestigationControlPlaneFailureClass.StalePrecondition,
      ],
      [
        ReviewActionV2ProtocolErrorCode.StalePrecondition,
        ReviewInvestigationControlPlaneFailureClass.StalePrecondition,
      ],
      [
        ReviewActionV2ProtocolErrorCode.InvalidRequest,
        ReviewInvestigationControlPlaneFailureClass.Rejected,
      ],
    ])(
      'maps protocol transport error %s to %s',
      async (protocolErrorCode, failureClass) => {
        const adapter = createAdapter(
          jest
            .fn()
            .mockRejectedValue(
              new ReviewActionV2ClientError(
                ReviewActionV2ClientFailureCode.ProtocolError,
                ReviewActionV2OperationId.ReviewInvestigationLeaseAcquire,
                { protocolErrorCode }
              )
            )
        );

        await expectFailure(
          adapter.acquire(acquireInput()),
          failureClass,
          'investigation_lease_transport_protocol_error'
        );
      }
    );

    it.each([
      ReviewActionV2ClientFailureCode.NetworkFailure,
      ReviewActionV2ClientFailureCode.RequestTimedOut,
    ])('maps client transport failure %s to unavailable', async (code) => {
      const adapter = createAdapter(
        jest
          .fn()
          .mockRejectedValue(
            new ReviewActionV2ClientError(
              code,
              ReviewActionV2OperationId.ReviewInvestigationLeaseAcquire
            )
          )
      );

      await expectFailure(
        adapter.acquire(acquireInput()),
        ReviewInvestigationControlPlaneFailureClass.Unavailable,
        `investigation_lease_transport_${code}`
      );
    });
  });
});

function createAdapter(
  execute: jest.Mock,
  requestId: () => string = () => 'renew-request-1'
): ReviewActionV2InvestigationLeaseAdapter {
  return new ReviewActionV2InvestigationLeaseAdapter(
    { execute } as never,
    requestId
  );
}

function acquireInput() {
  return {
    authorizationToken: 'authorization-token',
    snapshot: investigationSnapshot(),
    investigationId: 'investigation-1',
    turnId: 'turn-1',
    providerStrategyId,
    providerManifestCanonicalJson,
    providerManifestHash,
    ownerIdHash,
  };
}

function releaseInput() {
  return {
    investigationId: 'investigation-1',
    turnId: 'turn-1',
    lease,
    ownerIdHash,
  };
}

function investigationSnapshot(): ReviewInvestigationSnapshot {
  return {
    investigationId: 'investigation-1',
    version: 7,
    state: ReviewInvestigationState.TurnLeased,
    dossierDigest: 'd'.repeat(64),
    openObligationCount: 1,
    satisfiedObligationCount: 0,
    unresolvableObligationCount: 0,
    findingCount: 0,
    semanticTurns: 0,
    operationalAttempts: 1,
    criticCycles: 0,
    nextEligibleAt: null,
    nextAction: ReviewInvestigationNextAction.RunTurn,
    turn: {
      turnId: 'turn-1',
      purpose: ReviewTurnPurpose.Discovery,
      leasedAtVersion: 7,
      dossierDigest: 'd'.repeat(64),
      obligationIds: ['obligation-1'],
      semanticTurnOrdinal: 1,
      criticCycleOrdinal: 0,
      leasedAt: '2026-08-05T10:00:00.000Z',
      expiresAt: lease.expiresAt,
      turnCapability: 'turn.capability.value',
      brief: null,
    },
    certificateId: null,
    certificateHash: null,
    terminalProviderKind: null,
    terminalActualModel: null,
    terminalObservationCanonicalJson: null,
    terminalOutcomeHash: null,
    conclusion: null,
  };
}

async function expectFailure(
  promise: Promise<unknown>,
  failureClass: ReviewInvestigationControlPlaneFailureClass,
  message: string
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: 'ReviewInvestigationControlPlaneError',
    failureClass,
    message,
  });
}
