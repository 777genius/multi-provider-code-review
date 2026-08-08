import { createHash, randomUUID } from 'crypto';
import {
  ReviewActionV2Client,
  ReviewActionV2ClientError,
  ReviewActionV2ClientFailureCode,
} from '../../control-plane/review-action-v2-client';
import {
  ReviewActionV2OperationId,
  ReviewActionV2ProtocolErrorCode,
  ReviewInvestigationLeaseResultStatus,
} from '../../control-plane/generated/review-action-v2/review-action-v2';
import {
  ReviewInvestigationControlPlaneError,
  ReviewInvestigationControlPlaneFailureClass,
  ReviewInvestigationLeaseAcquireStatus,
  type ReviewInvestigationLease,
  type ReviewInvestigationLeasePort,
} from '../application/investigation-control-plane-port';

export class ReviewActionV2InvestigationLeaseAdapter implements ReviewInvestigationLeasePort {
  constructor(
    private readonly client: ReviewActionV2Client,
    private readonly requestId: () => string = randomUUID
  ) {}

  async acquire(
    input: Parameters<ReviewInvestigationLeasePort['acquire']>[0]
  ): ReturnType<ReviewInvestigationLeasePort['acquire']> {
    const turn = input.snapshot.turn;
    if (
      turn === null ||
      turn.turnId !== input.turnId ||
      turn.turnCapability.length === 0
    ) {
      throw invalidResponse('investigation_lease_turn_binding_invalid');
    }
    const acquireRequestId = deterministicId('investigation-lease-acquire', [
      input.investigationId,
      String(input.snapshot.version),
      input.turnId,
      input.providerStrategyId,
      input.providerManifestHash,
      input.ownerIdHash,
      this.requestId(),
    ]);
    let result;
    try {
      result = await this.client.execute(
        ReviewActionV2OperationId.ReviewInvestigationLeaseAcquire,
        {
          authorizationToken: input.authorizationToken,
          idempotencyKey: deterministicId('investigation-lease-acquire-idem', [
            acquireRequestId,
          ]),
          investigationId: input.investigationId,
          expectedVersion: String(input.snapshot.version),
          turnId: input.turnId,
          turnCapability: turn.turnCapability,
          providerStrategyId: input.providerStrategyId,
          investigationManifestCanonicalJson:
            input.providerManifestCanonicalJson,
          investigationManifestHash: input.providerManifestHash,
          acquireRequestId,
          ownerIdHash: input.ownerIdHash,
        }
      );
    } catch (error) {
      throw mapTransportError(error);
    }
    switch (result.status) {
      case ReviewInvestigationLeaseResultStatus.Acquired:
      case ReviewInvestigationLeaseResultStatus.Restored:
        return Object.freeze({
          status: ReviewInvestigationLeaseAcquireStatus.Acquired,
          lease: leaseFromAcquire(result),
        });
      case ReviewInvestigationLeaseResultStatus.Busy:
        return Object.freeze({
          status: ReviewInvestigationLeaseAcquireStatus.Busy,
        });
      case ReviewInvestigationLeaseResultStatus.BindingStale:
      case ReviewInvestigationLeaseResultStatus.Rejected:
      case ReviewInvestigationLeaseResultStatus.Missing:
        return Object.freeze({
          status: ReviewInvestigationLeaseAcquireStatus.NotRunnable,
        });
      case ReviewInvestigationLeaseResultStatus.IdempotencyConflict:
        throw new ReviewInvestigationControlPlaneError(
          ReviewInvestigationControlPlaneFailureClass.Conflict,
          'investigation_lease_acquire_idempotency_conflict'
        );
      default:
        throw invalidResponse('investigation_lease_acquire_status_invalid');
    }
  }

  async renew(
    input: Parameters<ReviewInvestigationLeasePort['renew']>[0]
  ): ReturnType<ReviewInvestigationLeasePort['renew']> {
    const renewRequestId = `rr:investigation-lease-renew:${this.requestId()}`;
    let result;
    try {
      result = await this.client.execute(
        ReviewActionV2OperationId.ReviewInvestigationLeaseRenew,
        {
          leaseCapability: input.lease.leaseCapability,
          idempotencyKey: deterministicId('investigation-lease-renew-idem', [
            renewRequestId,
          ]),
          leaseId: input.lease.leaseId,
          ownerIdHash: input.ownerIdHash,
          fencingToken: input.lease.fencingToken,
          renewRequestId,
        }
      );
    } catch (error) {
      throw mapTransportError(error);
    }
    if (
      result.status !== ReviewInvestigationLeaseResultStatus.Applied &&
      result.status !== ReviewInvestigationLeaseResultStatus.Restored
    ) {
      throw statusError('investigation_lease_renew', result.status);
    }
    const renewed = Object.freeze({
      ...input.lease,
      leaseId: requireString(result.leaseId, 'investigation_lease_id'),
      fencingToken: requireString(
        result.fencingToken,
        'investigation_lease_fencing_token'
      ),
      expiresAt: requireTimestamp(
        result.expiresAt,
        'investigation_lease_expires_at'
      ),
      leaseCapability: requireString(
        result.leaseCapability,
        'investigation_lease_capability'
      ),
    });
    if (
      renewed.leaseId !== input.lease.leaseId ||
      renewed.fencingToken !== input.lease.fencingToken ||
      renewed.leaseCapability === input.lease.leaseCapability ||
      Date.parse(renewed.expiresAt) <= Date.parse(input.lease.expiresAt) ||
      Date.parse(renewed.expiresAt) > Date.parse(input.lease.resultReportUntil)
    ) {
      throw invalidResponse('investigation_lease_renewal_drift');
    }
    return renewed;
  }

  async release(
    input: Parameters<ReviewInvestigationLeasePort['release']>[0]
  ): ReturnType<ReviewInvestigationLeasePort['release']> {
    const releaseRequestId = deterministicId('investigation-lease-release', [
      input.investigationId,
      input.turnId,
      input.lease.leaseId,
      input.lease.fencingToken,
      input.ownerIdHash,
    ]);
    let result;
    try {
      result = await this.client.execute(
        ReviewActionV2OperationId.ReviewInvestigationLeaseRelease,
        {
          leaseCapability: input.lease.leaseCapability,
          idempotencyKey: deterministicId('investigation-lease-release-idem', [
            releaseRequestId,
          ]),
          leaseId: input.lease.leaseId,
          ownerIdHash: input.ownerIdHash,
          fencingToken: input.lease.fencingToken,
          releaseRequestId,
        }
      );
    } catch (error) {
      throw mapTransportError(error);
    }
    if (
      result.status !== ReviewInvestigationLeaseResultStatus.Applied &&
      result.status !== ReviewInvestigationLeaseResultStatus.Restored &&
      result.status !== ReviewInvestigationLeaseResultStatus.Missing &&
      result.status !== ReviewInvestigationLeaseResultStatus.Expired &&
      result.status !== ReviewInvestigationLeaseResultStatus.BindingStale &&
      result.status !== ReviewInvestigationLeaseResultStatus.StaleFence
    ) {
      throw statusError('investigation_lease_release', result.status);
    }
  }
}

function leaseFromAcquire(input: {
  readonly leaseId?: string | null;
  readonly attemptId?: string | null;
  readonly leaseCapability?: string | null;
  readonly fencingToken?: string | null;
  readonly expiresAt?: string | null;
  readonly resultReportUntil?: string | null;
}): ReviewInvestigationLease {
  const lease = Object.freeze({
    leaseId: requireString(input.leaseId, 'investigation_lease_id'),
    attemptId: requireString(input.attemptId, 'investigation_attempt_id'),
    leaseCapability: requireString(
      input.leaseCapability,
      'investigation_lease_capability'
    ),
    fencingToken: requireString(
      input.fencingToken,
      'investigation_lease_fencing_token'
    ),
    expiresAt: requireTimestamp(
      input.expiresAt,
      'investigation_lease_expires_at'
    ),
    resultReportUntil: requireTimestamp(
      input.resultReportUntil,
      'investigation_lease_result_report_until'
    ),
  });
  if (Date.parse(lease.expiresAt) > Date.parse(lease.resultReportUntil)) {
    throw invalidResponse('investigation_lease_deadline_order_invalid');
  }
  return lease;
}

function deterministicId(namespace: string, parts: readonly string[]): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(parts), 'utf8')
    .digest('hex')
    .slice(0, 40);
  return `rr:${namespace}:${digest}`;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidResponse(`${field}_missing`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  const parsed = requireString(value, field);
  if (!Number.isFinite(Date.parse(parsed))) {
    throw invalidResponse(`${field}_invalid`);
  }
  return parsed;
}

function invalidResponse(
  message: string
): ReviewInvestigationControlPlaneError {
  return new ReviewInvestigationControlPlaneError(
    ReviewInvestigationControlPlaneFailureClass.InvalidResponse,
    message
  );
}

function statusError(
  operation: string,
  status: ReviewInvestigationLeaseResultStatus
): ReviewInvestigationControlPlaneError {
  const failureClass =
    status === ReviewInvestigationLeaseResultStatus.BindingStale ||
    status === ReviewInvestigationLeaseResultStatus.StaleFence ||
    status === ReviewInvestigationLeaseResultStatus.Expired
      ? ReviewInvestigationControlPlaneFailureClass.StalePrecondition
      : status === ReviewInvestigationLeaseResultStatus.IdempotencyConflict
        ? ReviewInvestigationControlPlaneFailureClass.Conflict
        : ReviewInvestigationControlPlaneFailureClass.Rejected;
  return new ReviewInvestigationControlPlaneError(
    failureClass,
    `${operation}_${status}`
  );
}

function mapTransportError(
  error: unknown
): ReviewInvestigationControlPlaneError {
  if (!(error instanceof ReviewActionV2ClientError)) {
    return new ReviewInvestigationControlPlaneError(
      ReviewInvestigationControlPlaneFailureClass.Unavailable,
      'investigation_lease_transport_unavailable'
    );
  }
  const failureClass = (() => {
    switch (error.protocolErrorCode) {
      case ReviewActionV2ProtocolErrorCode.AmbiguousOutcome:
        return ReviewInvestigationControlPlaneFailureClass.AmbiguousOutcome;
      case ReviewActionV2ProtocolErrorCode.CapacityLimited:
        return ReviewInvestigationControlPlaneFailureClass.CapacityLimited;
      case ReviewActionV2ProtocolErrorCode.CapabilityDisabled:
        return ReviewInvestigationControlPlaneFailureClass.CapabilityDisabled;
      case ReviewActionV2ProtocolErrorCode.IdempotencyConflict:
        return ReviewInvestigationControlPlaneFailureClass.Conflict;
      case ReviewActionV2ProtocolErrorCode.ResourceGone:
      case ReviewActionV2ProtocolErrorCode.StalePrecondition:
        return ReviewInvestigationControlPlaneFailureClass.StalePrecondition;
      default:
        return error.code === ReviewActionV2ClientFailureCode.NetworkFailure ||
          error.code === ReviewActionV2ClientFailureCode.RequestTimedOut
          ? ReviewInvestigationControlPlaneFailureClass.Unavailable
          : ReviewInvestigationControlPlaneFailureClass.Rejected;
    }
  })();
  return new ReviewInvestigationControlPlaneError(
    failureClass,
    `investigation_lease_transport_${error.code}`
  );
}
