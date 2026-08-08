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
  seedEnvelope: Readonly<{
    canonicalJson: string;
    hash: string;
  }>;
  initialReceipts: CanonicalJsonValue;
  providerManifestCanonicalJson: string;
  providerManifestHash: string;
  ownerIdHash: string;
}>;

export type ReviewInvestigationTargetRevision = Readonly<{
  baseSha: string;
  mergeBaseSha: string;
  headSha: string;
  reviewRevisionHash: string;
}>;

export type ReviewInvestigationTargetScope = Readonly<{
  workspaceId: string;
  repositoryConnectionId: string;
  scmRepositoryIdentityId: string;
  pullRequestNumber: number;
  trustDomain: string;
  authorizationScopeHash: string;
}>;

export type PreparedInvestigationReceiptReplay = Readonly<{
  obligationId: string;
  contextAttestationId: string;
  contextAttestationHash: string;
  sourceOperationReceiptIdsHash: string;
  replayCapability: string;
  replayPlanCanonicalJson: string;
  replayPlanHash: string;
}>;

export type PreparedInvestigationReplay = Readonly<{
  sourceInvestigationId: string;
  sourceCertificateId: string;
  sourceCertificateHash: string;
  obligations: readonly PreparedInvestigationReceiptReplay[];
}>;

export type InvestigationReceiptReplayResult = Readonly<{
  targetCheckoutTreeOid: string;
  replayResultCanonicalJson: string;
  replayResultHash: string;
}>;

export interface ReviewInvestigationReplayControlPlanePort {
  prepareReplay(input: {
    readonly open: ReviewInvestigationOpenInput;
    readonly providerManifestCanonicalJson: string;
    readonly providerManifestHash: string;
  }): Promise<PreparedInvestigationReplay | null>;
  commitReceiptReplay(input: {
    readonly open: ReviewInvestigationOpenInput;
    readonly prepared: PreparedInvestigationReceiptReplay;
    readonly result: InvestigationReceiptReplayResult;
  }): Promise<{ readonly replayProofId: string } | null>;
  replay(input: {
    readonly open: ReviewInvestigationOpenInput;
    readonly scope: ReviewInvestigationTargetScope;
    readonly revision: ReviewInvestigationTargetRevision;
    readonly prepared: PreparedInvestigationReplay;
    readonly replayProofs: readonly Readonly<{
      obligationId: string;
      replayProofId: string;
    }>[];
  }): Promise<ReviewInvestigationSnapshot>;
}

export interface InvestigationReceiptReplayPort {
  replayReceipt(input: {
    readonly prepared: PreparedInvestigationReceiptReplay;
    readonly targetRevision: ReviewInvestigationTargetRevision;
  }): Promise<InvestigationReceiptReplayResult | null>;
}

export interface ReviewInvestigationReplayUseCasePort {
  execute(input: {
    readonly open: ReviewInvestigationOpenInput;
    readonly scope: ReviewInvestigationTargetScope;
    readonly revision: ReviewInvestigationTargetRevision;
    readonly providerManifestCanonicalJson: string;
    readonly providerManifestHash: string;
  }): Promise<ReviewInvestigationSnapshot | null>;
}

export interface ReviewInvestigationControlPlanePort {
  open(
    input: ReviewInvestigationOpenInput
  ): Promise<ReviewInvestigationSnapshot>;
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
    readonly authorizationToken: string;
    readonly snapshot: ReviewInvestigationSnapshot;
    readonly investigationId: string;
    readonly turnId: string;
    readonly providerStrategyId: string;
    readonly providerManifestCanonicalJson: string;
    readonly providerManifestHash: string;
    readonly ownerIdHash: string;
  }): Promise<ReviewInvestigationLeaseAcquireResult>;
  renew(input: {
    readonly lease: ReviewInvestigationLease;
    readonly ownerIdHash: string;
  }): Promise<ReviewInvestigationLease>;
  release(input: {
    readonly investigationId: string;
    readonly turnId: string;
    readonly lease: ReviewInvestigationLease;
    readonly ownerIdHash: string;
  }): Promise<void>;
}

export interface ReviewInvestigationDelayPort {
  sleep(delayMs: number): Promise<void>;
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
  ProviderOutputInvalid = 'provider_output_invalid',
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
