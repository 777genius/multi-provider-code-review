import type { CanonicalJsonValue } from '../domain/canonical-json';
import type {
  ReviewInvestigationAbortReason,
  ReviewInvestigationSnapshot,
} from '../domain/investigation-state';
import type { ReviewTurnObservation } from '../domain/turn-observation';

export type ReviewInvestigationLease = Readonly<{
  leaseId: string;
  attemptId: string;
  leaseCapability: string;
  fencingToken: string;
  expiresAt: string;
  resultReportUntil: string;
}>;

export enum ReviewInvestigationLeaseAcquireStatus {
  Acquired = 'acquired',
  Busy = 'busy',
  AttemptBudgetExhausted = 'attempt_budget_exhausted',
  NotRunnable = 'not_runnable',
}

export type ReviewInvestigationLeaseAcquireResult =
  | Readonly<{
      status: ReviewInvestigationLeaseAcquireStatus.Acquired;
      lease: ReviewInvestigationLease;
    }>
  | Readonly<{
      status:
        | ReviewInvestigationLeaseAcquireStatus.Busy
        | ReviewInvestigationLeaseAcquireStatus.AttemptBudgetExhausted
        | ReviewInvestigationLeaseAcquireStatus.NotRunnable;
    }>;

export enum ReviewInvestigationCurrency {
  Current = 'current',
  Superseded = 'superseded',
  Stale = 'stale',
}

export type ReviewInvestigationOpenInput = Readonly<{
  authorizationToken: string;
  authorizationId: string;
  executionId: string;
  workSlotId: string;
  reviewRevisionHash: string;
  stableReviewUnitKey: string;
  providerVoteLaneId: string;
  providerStrategyId: string;
  runtimeProfile: string;
  coverageContract: CanonicalJsonValue;
  investigationPolicy: CanonicalJsonValue;
  seedObligations: CanonicalJsonValue;
  initialReceipts: CanonicalJsonValue;
}>;

export interface ReviewInvestigationControlPlanePort {
  open(input: ReviewInvestigationOpenInput): Promise<ReviewInvestigationSnapshot>;
  restore(input: {
    readonly authorizationToken: string;
    readonly authorizationId: string;
    readonly investigationId: string;
    readonly reviewRevisionHash: string;
  }): Promise<ReviewInvestigationSnapshot | null>;
  planTurn(input: {
    readonly authorizationToken: string;
    readonly snapshot: ReviewInvestigationSnapshot;
    readonly leaseDurationMs: number;
    readonly maxObligationsForTurn: number;
    readonly turnBudget: CanonicalJsonValue;
  }): Promise<ReviewInvestigationSnapshot>;
  commitTurn(input: {
    readonly authorizationToken: string;
    readonly snapshot: ReviewInvestigationSnapshot;
    readonly lease: ReviewInvestigationLease;
    readonly attestationId: string;
    readonly attestationHash: string;
    readonly observation: ReviewTurnObservation;
  }): Promise<ReviewInvestigationSnapshot>;
  abortTurn(input: {
    readonly authorizationToken: string;
    readonly snapshot: ReviewInvestigationSnapshot;
    readonly lease: ReviewInvestigationLease;
    readonly reason: ReviewInvestigationAbortReason;
    readonly nextEligibleAt: string | null;
  }): Promise<ReviewInvestigationSnapshot>;
  conclude(input: {
    readonly authorizationToken: string;
    readonly snapshot: ReviewInvestigationSnapshot;
    readonly certificateTtlMs: number;
  }): Promise<ReviewInvestigationSnapshot>;
}

export interface ReviewInvestigationLeasePort {
  acquire(input: {
    readonly investigationId: string;
    readonly turnId: string;
    readonly providerStrategyId: string;
  }): Promise<ReviewInvestigationLeaseAcquireResult>;
  release(input: {
    readonly investigationId: string;
    readonly turnId: string;
    readonly lease: ReviewInvestigationLease;
  }): Promise<void>;
}

export interface ReviewInvestigationCurrencyPort {
  check(input: {
    readonly executionId: string;
    readonly workSlotId: string;
    readonly reviewRevisionHash: string;
  }): Promise<ReviewInvestigationCurrency>;
}

export enum ReviewInvestigationControlPlaneFailureClass {
  AmbiguousOutcome = 'ambiguous_outcome',
  CapacityLimited = 'capacity_limited',
  Conflict = 'conflict',
  StalePrecondition = 'stale_precondition',
  CapabilityDisabled = 'capability_disabled',
  Rejected = 'rejected',
  Unavailable = 'unavailable',
  InvalidResponse = 'invalid_response',
}

export class ReviewInvestigationControlPlaneError extends Error {
  constructor(
    readonly failureClass: ReviewInvestigationControlPlaneFailureClass,
    message: string
  ) {
    super(message);
    this.name = 'ReviewInvestigationControlPlaneError';
  }
}
