import {
  ReviewActionV2Client,
  ReviewActionV2ClientError,
  ReviewActionV2ClientFailureCode,
} from '../../control-plane/review-action-v2-client';
import {
  ReviewActionV2OperationId,
  ReviewActionV2ProtocolErrorCode,
  ReviewInvestigationMutationResultStatus,
  ReviewInvestigationNextAction as PublishedNextAction,
  ReviewInvestigationOpenResultStatus,
  ReviewInvestigationReplayPrepareResultStatus,
  ReviewContextReceiptReplayCommitResultStatus,
  ReviewInvestigationPublishedAbortReason,
  ReviewInvestigationPublishedConclusion,
  ReviewInvestigationPublishedRuntimeProfile,
  ReviewInvestigationPublishedState,
  ReviewInvestigationRestoreResultStatus,
  type ReviewInvestigationConcludeResult,
  type ReviewInvestigationOpenResult,
  type ReviewInvestigationOpenV2Result,
  type ReviewInvestigationReplayPrepareResult,
  type ReviewInvestigationReplayResult,
  type ReviewInvestigationReplayV2Result,
  type ReviewInvestigationRestoreResult,
  type ReviewInvestigationTurnAbortResult,
  type ReviewInvestigationTurnCommitResult,
  type ReviewInvestigationTurnPlanResult,
} from '../../control-plane/generated/review-action-v2/review-action-v2';
import {
  ReviewInvestigationControlPlaneError,
  ReviewInvestigationControlPlaneFailureClass,
  type ReviewInvestigationControlPlanePort,
  type ReviewInvestigationReplayControlPlanePort,
  type PreparedInvestigationReplay,
} from '../application/investigation-control-plane-port';
import { canonicalJson, sha256 } from '../domain/canonical-json';
import {
  REVIEW_INVESTIGATION_CANONICAL_REQUIREMENT_MAX_LENGTH,
  REVIEW_INVESTIGATION_CANONICAL_SUBJECT_MAX_LENGTH,
  REVIEW_INVESTIGATION_TURN_BRIEF_MAX_BYTES,
  REVIEW_INVESTIGATION_TURN_MAX_OBLIGATIONS,
  ReviewInvestigationObligationOrigin,
  ReviewInvestigationConclusion,
  ReviewInvestigationNextAction,
  ReviewInvestigationState,
  type ReviewInvestigationSnapshot,
  type ReviewInvestigationTurn,
  type ReviewInvestigationTurnBrief,
} from '../domain/investigation-state';
import { ReviewAgentProviderKind } from '../domain/runtime-profile';
import {
  ReviewTurnObligationKind,
  ReviewTurnPurpose,
  type ReviewTurnObservation,
} from '../domain/turn-observation';

type InvestigationResult =
  | ReviewInvestigationOpenResult
  | ReviewInvestigationOpenV2Result
  | ReviewInvestigationRestoreResult
  | ReviewInvestigationTurnPlanResult
  | ReviewInvestigationTurnCommitResult
  | ReviewInvestigationTurnAbortResult
  | ReviewInvestigationConcludeResult
  | ReviewInvestigationReplayResult
  | ReviewInvestigationReplayV2Result;

export class ReviewActionV2InvestigationAdapter
  implements
    ReviewInvestigationControlPlanePort,
    ReviewInvestigationReplayControlPlanePort
{
  constructor(private readonly client: ReviewActionV2Client) {}

  async open(
    input: Parameters<ReviewInvestigationControlPlanePort['open']>[0]
  ): ReturnType<ReviewInvestigationControlPlanePort['open']> {
    const coverage = document(input.coverageContract);
    const policy = document(input.investigationPolicy);
    const receipts = document(input.initialReceipts);
    const result = await this.mutation(
      ReviewActionV2OperationId.ReviewInvestigationOpenV2,
      () =>
        this.client.execute(
          ReviewActionV2OperationId.ReviewInvestigationOpenV2,
          {
            authorizationToken: input.authorizationToken,
            idempotencyKey: idempotencyKey('open', {
              executionId: input.executionId,
              workSlotId: input.workSlotId,
              reviewRevisionHash: input.reviewRevisionHash,
              stableReviewUnitKey: input.stableReviewUnitKey,
              providerVoteLaneId: input.providerVoteLaneId,
              investigationManifestHash: input.providerManifestHash,
              coverageContractHash: coverage.hash,
              runtimeProfile: input.runtimeProfile,
            }),
            authorizationId: input.authorizationId,
            executionId: input.executionId,
            workSlotId: input.workSlotId,
            reviewRevisionHash: input.reviewRevisionHash,
            stableReviewUnitKey: input.stableReviewUnitKey,
            providerVoteLaneId: input.providerVoteLaneId,
            providerStrategyId: input.providerStrategyId,
            runtimeProfile: runtimeProfile(input.runtimeProfile),
            coverageContractCanonicalJson: coverage.canonicalJson,
            coverageContractHash: coverage.hash,
            investigationPolicyCanonicalJson: policy.canonicalJson,
            investigationPolicyHash: policy.hash,
            seedObligationsCanonicalJson: input.seedEnvelope.canonicalJson,
            seedObligationsHash: input.seedEnvelope.hash,
            initialReceiptsCanonicalJson: receipts.canonicalJson,
            initialReceiptsHash: receipts.hash,
            investigationManifestCanonicalJson:
              input.providerManifestCanonicalJson,
            investigationManifestHash: input.providerManifestHash,
          }
        )
    );
    if (
      result.status !== ReviewInvestigationOpenResultStatus.Opened &&
      result.status !== ReviewInvestigationOpenResultStatus.Restored
    ) {
      throw statusError(result.status);
    }
    return snapshotFromResult(result, null);
  }

  async restore(
    input: Parameters<ReviewInvestigationControlPlanePort['restore']>[0]
  ): ReturnType<ReviewInvestigationControlPlanePort['restore']> {
    let result: ReviewInvestigationRestoreResult;
    try {
      result = await this.client.execute(
        ReviewActionV2OperationId.ReviewInvestigationRestore,
        {
          authorizationToken: input.authorizationToken,
          authorizationId: input.authorizationId,
          investigationId: input.investigationId,
          reviewRevisionHash: input.reviewRevisionHash,
        }
      );
    } catch (error) {
      throw transportError(
        error,
        ReviewActionV2OperationId.ReviewInvestigationRestore,
        false
      );
    }
    if (result.status === ReviewInvestigationRestoreResultStatus.Missing) {
      return null;
    }
    if (result.status !== ReviewInvestigationRestoreResultStatus.Found) {
      throw statusError(result.status);
    }
    return snapshotFromResult(result, null);
  }

  async planTurn(
    input: Parameters<ReviewInvestigationControlPlanePort['planTurn']>[0]
  ): ReturnType<ReviewInvestigationControlPlanePort['planTurn']> {
    const budget = document(input.turnBudget);
    const result = await this.mutation(
      ReviewActionV2OperationId.ReviewInvestigationTurnPlan,
      () =>
        this.client.execute(
          ReviewActionV2OperationId.ReviewInvestigationTurnPlan,
          {
            authorizationToken: input.authorizationToken,
            idempotencyKey: idempotencyKey('plan', {
              investigationId: input.snapshot.investigationId,
              expectedVersion: input.snapshot.version,
              dossierDigest: input.snapshot.dossierDigest,
              turnBudgetHash: budget.hash,
            }),
            investigationId: input.snapshot.investigationId,
            expectedVersion: String(input.snapshot.version),
            dossierDigest: input.snapshot.dossierDigest,
            leaseDurationMs: input.leaseDurationMs,
            maxObligationsForTurn: input.maxObligationsForTurn,
            turnBudgetHash: budget.hash,
          }
        )
    );
    requireMutationApplied(result.status);
    const turnCapability = nullableString(result.turnCapability);
    const snapshot = snapshotFromResult(result, turnCapability);
    if (snapshot.turn !== null && turnCapability === null) {
      throw invalidResponse('investigation_turn_capability_missing');
    }
    return attachTurnBrief(snapshot, result);
  }

  async commitTurn(
    input: Parameters<ReviewInvestigationControlPlanePort['commitTurn']>[0]
  ): ReturnType<ReviewInvestigationControlPlanePort['commitTurn']> {
    const turn = requireTurn(input.snapshot);
    const observationCanonicalJson = canonicalObservation(input.observation);
    const observationHash = sha256(observationCanonicalJson);
    const result = await this.mutation(
      ReviewActionV2OperationId.ReviewInvestigationTurnCommit,
      () =>
        this.client.execute(
          ReviewActionV2OperationId.ReviewInvestigationTurnCommit,
          {
            authorizationToken: input.authorizationToken,
            leaseCapability: input.lease.leaseCapability,
            idempotencyKey: idempotencyKey('commit', {
              investigationId: input.snapshot.investigationId,
              expectedVersion: input.snapshot.version,
              turnId: turn.turnId,
              sourceLeaseId: input.lease.leaseId,
              fencingToken: input.lease.fencingToken,
              observationHash,
              attestationHash: input.attestationHash,
            }),
            investigationId: input.snapshot.investigationId,
            expectedVersion: String(input.snapshot.version),
            turnId: turn.turnId,
            turnCapability: turn.turnCapability,
            sourceLeaseId: input.lease.leaseId,
            fencingToken: input.lease.fencingToken,
            acceptedAttestationId: input.attestationId,
            acceptedAttestationHash: input.attestationHash,
            turnObservationCanonicalJson: observationCanonicalJson,
            turnObservationHash: observationHash,
          }
        )
    );
    requireMutationApplied(result.status);
    return snapshotFromResult(result, null);
  }

  async abortTurn(
    input: Parameters<ReviewInvestigationControlPlanePort['abortTurn']>[0]
  ): ReturnType<ReviewInvestigationControlPlanePort['abortTurn']> {
    const turn = requireTurn(input.snapshot);
    const result = await this.mutation(
      ReviewActionV2OperationId.ReviewInvestigationTurnAbort,
      () =>
        this.client.execute(
          ReviewActionV2OperationId.ReviewInvestigationTurnAbort,
          {
            authorizationToken: input.authorizationToken,
            leaseCapability: input.lease.leaseCapability,
            idempotencyKey: idempotencyKey('abort', {
              investigationId: input.snapshot.investigationId,
              expectedVersion: input.snapshot.version,
              turnId: turn.turnId,
              sourceLeaseId: input.lease.leaseId,
              fencingToken: input.lease.fencingToken,
              reason: input.reason,
              nextEligibleAt: input.nextEligibleAt,
            }),
            investigationId: input.snapshot.investigationId,
            expectedVersion: String(input.snapshot.version),
            turnId: turn.turnId,
            turnCapability: turn.turnCapability,
            sourceLeaseId: input.lease.leaseId,
            fencingToken: input.lease.fencingToken,
            abortReason: publishedAbortReason(input.reason),
            nextEligibleAt: input.nextEligibleAt,
          }
        )
    );
    requireMutationApplied(result.status);
    return snapshotFromResult(result, null);
  }

  async conclude(
    input: Parameters<ReviewInvestigationControlPlanePort['conclude']>[0]
  ): ReturnType<ReviewInvestigationControlPlanePort['conclude']> {
    const result = await this.mutation(
      ReviewActionV2OperationId.ReviewInvestigationConclude,
      () =>
        this.client.execute(
          ReviewActionV2OperationId.ReviewInvestigationConclude,
          {
            authorizationToken: input.authorizationToken,
            idempotencyKey: idempotencyKey('conclude', {
              investigationId: input.snapshot.investigationId,
              expectedVersion: input.snapshot.version,
              dossierDigest: input.snapshot.dossierDigest,
              certificateTtlMs: input.certificateTtlMs,
            }),
            investigationId: input.snapshot.investigationId,
            expectedVersion: String(input.snapshot.version),
            dossierDigest: input.snapshot.dossierDigest,
            certificateTtlMs: input.certificateTtlMs,
          }
        )
    );
    requireMutationApplied(result.status);
    return snapshotFromResult(result, null);
  }

  async prepareReplay(
    input: Parameters<
      ReviewInvestigationReplayControlPlanePort['prepareReplay']
    >[0]
  ): ReturnType<ReviewInvestigationReplayControlPlanePort['prepareReplay']> {
    const coverage = document(input.open.coverageContract);
    let result;
    try {
      result = await this.client.execute(
        ReviewActionV2OperationId.ReviewInvestigationReplayPrepare,
        {
          authorizationToken: input.open.authorizationToken,
          authorizationId: input.open.authorizationId,
          targetExecutionId: input.open.executionId,
          targetWorkSlotId: input.open.workSlotId,
          targetReviewRevisionHash: input.open.reviewRevisionHash,
          stableReviewUnitKey: input.open.stableReviewUnitKey,
          providerVoteLaneId: input.open.providerVoteLaneId,
          providerManifestCanonicalJson: input.providerManifestCanonicalJson,
          providerManifestHash: input.providerManifestHash,
          coverageContractCanonicalJson: coverage.canonicalJson,
          coverageContractHash: coverage.hash,
        }
      );
    } catch (error) {
      const mapped = transportError(
        error,
        ReviewActionV2OperationId.ReviewInvestigationReplayPrepare,
        false
      );
      if (
        mapped.failureClass ===
          ReviewInvestigationControlPlaneFailureClass.CapabilityDisabled ||
        mapped.failureClass ===
          ReviewInvestigationControlPlaneFailureClass.Rejected
      ) {
        return null;
      }
      throw mapped;
    }
    if (
      result.status === ReviewInvestigationReplayPrepareResultStatus.Missing ||
      result.status === ReviewInvestigationReplayPrepareResultStatus.Rejected
    ) {
      return null;
    }
    if (
      result.status !== ReviewInvestigationReplayPrepareResultStatus.Prepared
    ) {
      throw invalidResponse('investigation_replay_prepare_status_invalid');
    }
    return parseReplayPreparation(result);
  }

  async commitReceiptReplay(
    input: Parameters<
      ReviewInvestigationReplayControlPlanePort['commitReceiptReplay']
    >[0]
  ): ReturnType<
    ReviewInvestigationReplayControlPlanePort['commitReceiptReplay']
  > {
    const result = await this.mutation(
      ReviewActionV2OperationId.ReviewContextReceiptReplayCommit,
      () =>
        this.client.execute(
          ReviewActionV2OperationId.ReviewContextReceiptReplayCommit,
          {
            authorizationToken: input.open.authorizationToken,
            idempotencyKey: idempotencyKey('receipt-replay-commit', {
              executionId: input.open.executionId,
              workSlotId: input.open.workSlotId,
              attestationId: input.prepared.contextAttestationId,
              attestationHash: input.prepared.contextAttestationHash,
              sourceOperationReceiptIdsHash:
                input.prepared.sourceOperationReceiptIdsHash,
              targetReviewRevisionHash: input.open.reviewRevisionHash,
              targetCheckoutTreeOid: input.result.targetCheckoutTreeOid,
              replayResultHash: input.result.replayResultHash,
            }),
            executionId: input.open.executionId,
            workSlotId: input.open.workSlotId,
            attestationId: input.prepared.contextAttestationId,
            attestationHash: input.prepared.contextAttestationHash,
            targetReviewRevisionHash: input.open.reviewRevisionHash,
            targetCheckoutTreeOid: input.result.targetCheckoutTreeOid,
            replayCapability: input.prepared.replayCapability,
            replayResultCanonicalJson: input.result.replayResultCanonicalJson,
            replayResultHash: input.result.replayResultHash,
          }
        )
    );
    if (
      result.status === ReviewContextReceiptReplayCommitResultStatus.Denied ||
      result.status === ReviewContextReceiptReplayCommitResultStatus.Conflict
    ) {
      return null;
    }
    if (
      result.status !== ReviewContextReceiptReplayCommitResultStatus.Accepted &&
      result.status !== ReviewContextReceiptReplayCommitResultStatus.Idempotent
    ) {
      throw statusError(result.status);
    }
    return Object.freeze({
      replayProofId: requireString(result.replayProofId, 'replay_proof_id'),
    });
  }

  async replay(
    input: Parameters<ReviewInvestigationReplayControlPlanePort['replay']>[0]
  ): ReturnType<ReviewInvestigationReplayControlPlanePort['replay']> {
    const coverage = document(input.open.coverageContract);
    const policy = document(input.open.investigationPolicy);
    const initialReceipts = document(input.open.initialReceipts);
    const targetScope = document(input.scope);
    const targetRevision = document(input.revision);
    const replayProofs = document(input.replayProofs);
    const result = await this.mutation(
      ReviewActionV2OperationId.ReviewInvestigationReplayV2,
      () =>
        this.client.execute(
          ReviewActionV2OperationId.ReviewInvestigationReplayV2,
          {
            authorizationToken: input.open.authorizationToken,
            idempotencyKey: idempotencyKey('replay', {
              sourceInvestigationId: input.prepared.sourceInvestigationId,
              sourceCertificateHash: input.prepared.sourceCertificateHash,
              targetExecutionId: input.open.executionId,
              targetWorkSlotId: input.open.workSlotId,
              targetRevisionHash: targetRevision.hash,
              providerStrategyId: input.open.providerStrategyId,
              investigationManifestHash: input.open.providerManifestHash,
              coverageContractHash: coverage.hash,
              investigationPolicyHash: policy.hash,
              seedObligationsHash: input.open.seedEnvelope.hash,
              initialReceiptsHash: initialReceipts.hash,
              replayProofsHash: replayProofs.hash,
            }),
            authorizationId: input.open.authorizationId,
            sourceInvestigationId: input.prepared.sourceInvestigationId,
            sourceCertificateHash: input.prepared.sourceCertificateHash,
            targetExecutionId: input.open.executionId,
            targetWorkSlotId: input.open.workSlotId,
            stableReviewUnitKey: input.open.stableReviewUnitKey,
            providerVoteLaneId: input.open.providerVoteLaneId,
            providerStrategyId: input.open.providerStrategyId,
            investigationManifestCanonicalJson:
              input.open.providerManifestCanonicalJson,
            investigationManifestHash: input.open.providerManifestHash,
            runtimeProfile: runtimeProfile(input.open.runtimeProfile),
            coverageContractCanonicalJson: coverage.canonicalJson,
            coverageContractHash: coverage.hash,
            investigationPolicyCanonicalJson: policy.canonicalJson,
            investigationPolicyHash: policy.hash,
            seedObligationsCanonicalJson: input.open.seedEnvelope.canonicalJson,
            seedObligationsHash: input.open.seedEnvelope.hash,
            initialReceiptsCanonicalJson: initialReceipts.canonicalJson,
            initialReceiptsHash: initialReceipts.hash,
            targetScopeCanonicalJson: targetScope.canonicalJson,
            targetScopeHash: targetScope.hash,
            targetRevisionCanonicalJson: targetRevision.canonicalJson,
            targetRevisionHash: targetRevision.hash,
            replayProofsCanonicalJson: replayProofs.canonicalJson,
            replayProofsHash: replayProofs.hash,
          }
        )
    );
    requireMutationApplied(result.status);
    return snapshotFromResult(result, null);
  }

  private async mutation<Operation extends ReviewActionV2OperationId, Result>(
    operationId: Operation,
    execute: () => Promise<Result>
  ): Promise<Result> {
    try {
      return await execute();
    } catch (error) {
      throw transportError(error, operationId, true);
    }
  }
}

function document(value: Parameters<typeof canonicalJson>[0]) {
  const serialized = canonicalJson(value);
  return Object.freeze({ canonicalJson: serialized, hash: sha256(serialized) });
}

function parseReplayPreparation(
  result: ReviewInvestigationReplayPrepareResult
): PreparedInvestigationReplay {
  const raw = requireCanonicalDocumentString(
    result.replayPreparationCanonicalJson,
    'replay_preparation'
  );
  if (
    sha256(raw) !==
    requireDigest(result.replayPreparationHash, 'replay_preparation_hash')
  ) {
    throw invalidResponse('replay_preparation_hash_mismatch');
  }
  const parsed = requireRecord(JSON.parse(raw), 'replay_preparation');
  requireExactKeys(parsed, ['obligations']);
  const obligations = requireArray(
    parsed.obligations,
    'replay_preparation_obligations',
    1_024
  ).map((value) => {
    const obligation = requireRecord(value, 'replay_preparation_obligation');
    requireExactKeys(obligation, [
      'obligationId',
      'contextAttestationId',
      'contextAttestationHash',
      'sourceOperationReceiptIdsHash',
      'replayCapability',
      'replayPlanCanonicalJson',
      'replayPlanHash',
    ]);
    const replayPlanCanonicalJson = requireCanonicalDocumentString(
      obligation.replayPlanCanonicalJson,
      'replay_plan',
      512 * 1_024
    );
    const replayPlanHash = requireDigest(
      obligation.replayPlanHash,
      'replay_plan_hash'
    );
    if (sha256(replayPlanCanonicalJson) !== replayPlanHash) {
      throw invalidResponse('replay_plan_hash_mismatch');
    }
    return Object.freeze({
      obligationId: requireDigest(obligation.obligationId, 'obligation_id'),
      contextAttestationId: requireString(
        obligation.contextAttestationId,
        'context_attestation_id'
      ),
      contextAttestationHash: requireDigest(
        obligation.contextAttestationHash,
        'context_attestation_hash'
      ),
      sourceOperationReceiptIdsHash: requireDigest(
        obligation.sourceOperationReceiptIdsHash,
        'source_operation_receipt_ids_hash'
      ),
      replayCapability: requireString(
        obligation.replayCapability,
        'replay_capability'
      ),
      replayPlanCanonicalJson,
      replayPlanHash,
    });
  });
  if (
    obligations.length === 0 ||
    new Set(obligations.map((item) => item.obligationId)).size !==
      obligations.length
  ) {
    throw invalidResponse('replay_preparation_obligations_invalid');
  }
  return Object.freeze({
    sourceInvestigationId: requireString(
      result.sourceInvestigationId,
      'source_investigation_id'
    ),
    sourceCertificateId: requireString(
      result.sourceCertificateId,
      'source_certificate_id'
    ),
    sourceCertificateHash: requireDigest(
      result.sourceCertificateHash,
      'source_certificate_hash'
    ),
    obligations: Object.freeze(obligations),
  });
}

function idempotencyKey(
  operation: string,
  preimage: Parameters<typeof canonicalJson>[0]
): string {
  return `rr:investigation:${operation}:${sha256(canonicalJson(preimage))}`;
}

function canonicalObservation(observation: ReviewTurnObservation): string {
  return canonicalJson(observation);
}

function runtimeProfile(
  value: string
): ReviewInvestigationPublishedRuntimeProfile {
  if (
    value === ReviewInvestigationPublishedRuntimeProfile.GatewayAttestedAgentV1
  ) {
    return ReviewInvestigationPublishedRuntimeProfile.GatewayAttestedAgentV1;
  }
  throw new ReviewInvestigationControlPlaneError(
    ReviewInvestigationControlPlaneFailureClass.Rejected,
    'investigation_runtime_profile_unsupported'
  );
}

function publishedAbortReason(
  value: string
): ReviewInvestigationPublishedAbortReason {
  if (
    !Object.values(ReviewInvestigationPublishedAbortReason).includes(
      value as ReviewInvestigationPublishedAbortReason
    )
  ) {
    throw new ReviewInvestigationControlPlaneError(
      ReviewInvestigationControlPlaneFailureClass.Rejected,
      'investigation_abort_reason_unsupported'
    );
  }
  return value as ReviewInvestigationPublishedAbortReason;
}

function requireMutationApplied(
  status: ReviewInvestigationMutationResultStatus
): void {
  if (
    status !== ReviewInvestigationMutationResultStatus.Applied &&
    status !== ReviewInvestigationMutationResultStatus.Restored &&
    status !== ReviewInvestigationMutationResultStatus.Parked
  ) {
    throw statusError(status);
  }
}

function snapshotFromResult(
  result: InvestigationResult,
  turnCapability: string | null
): ReviewInvestigationSnapshot {
  const raw = requireString(
    result.investigationCanonicalJson,
    'investigation_canonical_json'
  );
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidResponse('investigation_canonical_json_invalid');
  }
  if (canonicalJson(value as Parameters<typeof canonicalJson>[0]) !== raw) {
    throw invalidResponse('investigation_canonical_json_not_canonical');
  }
  const root = requireRecord(value, 'investigation');
  requireExactKeys(root, [
    'investigationId',
    'version',
    'state',
    'dossierDigest',
    'openObligationCount',
    'satisfiedObligationCount',
    'unresolvableObligationCount',
    'findingCount',
    'semanticTurns',
    'operationalAttempts',
    'criticCycles',
    'nextEligibleAt',
    'nextAction',
    'turn',
    'certificateId',
    'certificateHash',
    'terminalProviderKind',
    'terminalActualModel',
    'terminalObservationCanonicalJson',
    'terminalOutcomeHash',
    'conclusion',
  ]);
  const turn = root.turn === null ? null : parseTurn(root.turn, turnCapability);
  const snapshot: ReviewInvestigationSnapshot = Object.freeze({
    investigationId: requireString(root.investigationId, 'investigation_id'),
    version: requireNonNegativeInteger(root.version, 'investigation_version'),
    state: enumValue(
      root.state,
      ReviewInvestigationState,
      'investigation_state'
    ),
    dossierDigest: requireDigest(root.dossierDigest, 'dossier_digest'),
    openObligationCount: requireNonNegativeInteger(
      root.openObligationCount,
      'open_obligation_count'
    ),
    satisfiedObligationCount: requireNonNegativeInteger(
      root.satisfiedObligationCount,
      'satisfied_obligation_count'
    ),
    unresolvableObligationCount: requireNonNegativeInteger(
      root.unresolvableObligationCount,
      'unresolvable_obligation_count'
    ),
    findingCount: requireNonNegativeInteger(root.findingCount, 'finding_count'),
    semanticTurns: requireNonNegativeInteger(
      root.semanticTurns,
      'semantic_turns'
    ),
    operationalAttempts: requireNonNegativeInteger(
      root.operationalAttempts,
      'operational_attempts'
    ),
    criticCycles: requireNonNegativeInteger(root.criticCycles, 'critic_cycles'),
    nextEligibleAt: nullableTimestamp(root.nextEligibleAt, 'next_eligible_at'),
    nextAction: enumValue(
      root.nextAction,
      ReviewInvestigationNextAction,
      'next_action'
    ),
    turn,
    certificateId: nullableString(root.certificateId),
    certificateHash: nullableDigest(root.certificateHash, 'certificate_hash'),
    terminalProviderKind: nullableEnumValue(
      root.terminalProviderKind,
      ReviewAgentProviderKind,
      'terminal_provider_kind'
    ),
    terminalActualModel: nullableString(root.terminalActualModel),
    terminalObservationCanonicalJson: nullableCanonicalJson(
      root.terminalObservationCanonicalJson,
      'terminal_observation'
    ),
    terminalOutcomeHash: nullableDigest(
      root.terminalOutcomeHash,
      'terminal_outcome_hash'
    ),
    conclusion: nullableEnumValue(
      root.conclusion,
      ReviewInvestigationConclusion,
      'investigation_conclusion'
    ),
  });
  verifyTerminalArtifact(snapshot);
  verifyEnvelopeConsistency(result, snapshot);
  return snapshot;
}

function parseTurn(
  value: unknown,
  turnCapability: string | null
): ReviewInvestigationTurn {
  const turn = requireRecord(value, 'investigation_turn');
  requireExactKeys(turn, [
    'turnId',
    'purpose',
    'leasedAtVersion',
    'dossierDigest',
    'obligationIds',
    'semanticTurnOrdinal',
    'criticCycleOrdinal',
    'leasedAt',
    'expiresAt',
  ]);
  return Object.freeze({
    turnId: requireString(turn.turnId, 'turn_id'),
    purpose: enumValue(turn.purpose, ReviewTurnPurpose, 'turn_purpose'),
    leasedAtVersion: requireNonNegativeInteger(
      turn.leasedAtVersion,
      'turn_leased_at_version'
    ),
    dossierDigest: requireDigest(turn.dossierDigest, 'turn_dossier_digest'),
    obligationIds: Object.freeze(
      requireArray(turn.obligationIds, 'turn_obligation_ids').map((item) =>
        requireDigest(item, 'turn_obligation_id')
      )
    ),
    semanticTurnOrdinal: requireNonNegativeInteger(
      turn.semanticTurnOrdinal,
      'semantic_turn_ordinal'
    ),
    criticCycleOrdinal: requireNonNegativeInteger(
      turn.criticCycleOrdinal,
      'critic_cycle_ordinal'
    ),
    leasedAt: timestamp(turn.leasedAt, 'turn_leased_at'),
    expiresAt: timestamp(turn.expiresAt, 'turn_expires_at'),
    turnCapability: turnCapability ?? '',
    brief: null,
  });
}

function attachTurnBrief(
  snapshot: ReviewInvestigationSnapshot,
  result: ReviewInvestigationTurnPlanResult
): ReviewInvestigationSnapshot {
  const raw = requireCanonicalDocumentString(
    result.turnBriefCanonicalJson,
    'turn_brief_canonical_json',
    REVIEW_INVESTIGATION_TURN_BRIEF_MAX_BYTES
  );
  const expectedHash = requireDigest(result.turnBriefHash, 'turn_brief_hash');
  if (sha256(raw) !== expectedHash) {
    throw invalidResponse('turn_brief_hash_mismatch');
  }
  const parsed: unknown = JSON.parse(raw);
  if (snapshot.turn === null) {
    if (parsed !== null) throw invalidResponse('turn_brief_without_turn');
    return snapshot;
  }
  const brief = parseTurnBrief(parsed, snapshot);
  return Object.freeze({
    ...snapshot,
    turn: Object.freeze({ ...snapshot.turn, brief }),
  });
}

function parseTurnBrief(
  value: unknown,
  snapshot: ReviewInvestigationSnapshot
): ReviewInvestigationTurnBrief {
  const brief = requireRecord(value, 'turn_brief');
  requireExactKeys(brief, [
    'briefVersion',
    'investigationId',
    'investigationVersion',
    'dossierDigest',
    'turnId',
    'purpose',
    'maximumSemanticRiskPriority',
    'obligations',
  ]);
  const parsed = Object.freeze({
    briefVersion: requireLiteralOne(brief.briefVersion, 'brief_version'),
    investigationId: requireString(brief.investigationId, 'investigation_id'),
    investigationVersion: requireNonNegativeInteger(
      brief.investigationVersion,
      'investigation_version'
    ),
    dossierDigest: requireDigest(brief.dossierDigest, 'dossier_digest'),
    turnId: requireString(brief.turnId, 'turn_id'),
    purpose: enumValue(brief.purpose, ReviewTurnPurpose, 'turn_purpose'),
    maximumSemanticRiskPriority: requireBoundedRiskPriority(
      brief.maximumSemanticRiskPriority,
      'maximum_semantic_risk_priority'
    ),
    obligations: Object.freeze(
      requireArray(
        brief.obligations,
        'turn_obligations',
        REVIEW_INVESTIGATION_TURN_MAX_OBLIGATIONS
      ).map((value) => {
        const obligation = requireRecord(value, 'turn_obligation');
        requireExactKeys(obligation, [
          'obligationId',
          'kind',
          'canonicalSubject',
          'canonicalRequirement',
          'riskPriority',
          'origin',
        ]);
        return Object.freeze({
          obligationId: requireDigest(obligation.obligationId, 'obligation_id'),
          kind: enumValue(
            obligation.kind,
            ReviewTurnObligationKind,
            'obligation_kind'
          ),
          canonicalSubject: requireBoundedText(
            obligation.canonicalSubject,
            'canonical_subject',
            REVIEW_INVESTIGATION_CANONICAL_SUBJECT_MAX_LENGTH
          ),
          canonicalRequirement: requireBoundedText(
            obligation.canonicalRequirement,
            'canonical_requirement',
            REVIEW_INVESTIGATION_CANONICAL_REQUIREMENT_MAX_LENGTH
          ),
          riskPriority: requireNonNegativeInteger(
            obligation.riskPriority,
            'risk_priority'
          ),
          origin: enumValue(
            obligation.origin,
            ReviewInvestigationObligationOrigin,
            'obligation_origin'
          ),
        });
      })
    ),
  });
  if (
    parsed.investigationId !== snapshot.investigationId ||
    parsed.investigationVersion !== snapshot.version ||
    parsed.dossierDigest !== snapshot.dossierDigest ||
    parsed.turnId !== snapshot.turn?.turnId ||
    parsed.purpose !== snapshot.turn?.purpose ||
    parsed.obligations.length !== snapshot.turn.obligationIds.length ||
    parsed.obligations.some(
      (obligation, index) =>
        obligation.obligationId !== snapshot.turn?.obligationIds[index]
    )
  ) {
    throw invalidResponse('turn_brief_envelope_mismatch');
  }
  return parsed;
}

function requireLiteralOne(value: unknown, field: string): 1 {
  if (value !== 1) throw invalidResponse(`${field}_invalid`);
  return 1;
}

function verifyEnvelopeConsistency(
  result: InvestigationResult,
  snapshot: ReviewInvestigationSnapshot
): void {
  if (
    result.investigationId !== snapshot.investigationId ||
    result.investigationVersion !== String(snapshot.version) ||
    publishedState(snapshot.state) !== result.investigationState ||
    result.dossierDigest !== snapshot.dossierDigest ||
    publishedNextAction(snapshot.nextAction) !== result.nextAction ||
    result.certificateId !== snapshot.certificateId ||
    result.certificateHash !== snapshot.certificateHash ||
    result.terminalProviderKind !== snapshot.terminalProviderKind ||
    result.terminalActualModel !== snapshot.terminalActualModel ||
    result.terminalObservationCanonicalJson !==
      snapshot.terminalObservationCanonicalJson ||
    result.terminalOutcomeHash !== snapshot.terminalOutcomeHash ||
    result.investigationConclusion !== publishedConclusion(snapshot.conclusion)
  ) {
    throw invalidResponse('investigation_result_envelope_mismatch');
  }
}

function verifyTerminalArtifact(snapshot: ReviewInvestigationSnapshot): void {
  const artifact = [
    snapshot.certificateId,
    snapshot.certificateHash,
    snapshot.terminalObservationCanonicalJson,
    snapshot.terminalOutcomeHash,
  ];
  const artifactPresent = artifact.some((value) => value !== null);
  if (artifactPresent && artifact.some((value) => value === null)) {
    throw invalidResponse('investigation_terminal_artifact_incomplete');
  }
  const provenancePresent =
    snapshot.terminalProviderKind !== null ||
    snapshot.terminalActualModel !== null;
  if (
    provenancePresent &&
    (snapshot.terminalProviderKind === null ||
      snapshot.terminalActualModel === null)
  ) {
    throw invalidResponse('investigation_terminal_provenance_incomplete');
  }
  verifyConclusionConsistency(snapshot);
  if (!artifactPresent) {
    if (provenancePresent) {
      throw invalidResponse(
        'investigation_terminal_provenance_without_artifact'
      );
    }
    if (
      snapshot.conclusion !== null &&
      !(
        snapshot.nextAction === ReviewInvestigationNextAction.Conclude &&
        snapshot.turn === null &&
        ((snapshot.state === ReviewInvestigationState.ReadyToConclude &&
          snapshot.conclusion !== ReviewInvestigationConclusion.Inconclusive) ||
          (snapshot.state === ReviewInvestigationState.Inconclusive &&
            snapshot.conclusion === ReviewInvestigationConclusion.Inconclusive))
      )
    ) {
      throw invalidResponse('investigation_preterminal_conclusion_invalid');
    }
    return;
  }
  if (
    snapshot.conclusion === null ||
    ![
      ReviewInvestigationState.Concluded,
      ReviewInvestigationState.Inconclusive,
    ].includes(snapshot.state) ||
    snapshot.nextAction !== ReviewInvestigationNextAction.Terminal ||
    snapshot.turn !== null ||
    sha256(snapshot.terminalObservationCanonicalJson!) !==
      snapshot.terminalOutcomeHash ||
    (snapshot.conclusion !== ReviewInvestigationConclusion.Inconclusive &&
      !provenancePresent)
  ) {
    throw invalidResponse('investigation_terminal_artifact_invalid');
  }
  verifyTerminalPayload(snapshot);
}

function verifyConclusionConsistency(
  snapshot: ReviewInvestigationSnapshot
): void {
  if (
    (snapshot.state === ReviewInvestigationState.Concluded &&
      snapshot.conclusion !== ReviewInvestigationConclusion.VerifiedClean &&
      snapshot.conclusion !== ReviewInvestigationConclusion.Findings) ||
    (snapshot.state === ReviewInvestigationState.Inconclusive &&
      snapshot.conclusion !== ReviewInvestigationConclusion.Inconclusive) ||
    (snapshot.conclusion === ReviewInvestigationConclusion.VerifiedClean &&
      (snapshot.findingCount !== 0 ||
        snapshot.openObligationCount !== 0 ||
        snapshot.unresolvableObligationCount !== 0)) ||
    (snapshot.conclusion === ReviewInvestigationConclusion.Findings &&
      (snapshot.findingCount === 0 ||
        snapshot.openObligationCount !== 0 ||
        snapshot.unresolvableObligationCount !== 0))
  ) {
    throw invalidResponse('investigation_terminal_artifact_invalid');
  }
}

function verifyTerminalPayload(snapshot: ReviewInvestigationSnapshot): void {
  let value: unknown;
  try {
    value = JSON.parse(snapshot.terminalObservationCanonicalJson!);
  } catch {
    throw invalidResponse('investigation_terminal_payload_invalid');
  }
  if (!isRecord(value)) {
    throw invalidResponse('investigation_terminal_payload_invalid');
  }
  const findings = value.normalizedFindings;
  const lifecycle = value.normalizedLifecycleRevalidations;
  if (
    !hasExactKeys(value, [
      'normalizedFindings',
      'normalizedLifecycleRevalidations',
      'payloadVersion',
      'safeUsage',
    ]) ||
    value.payloadVersion !== 2 ||
    !Array.isArray(findings) ||
    findings.some((item) => !isNormalizedFinding(item)) ||
    !Array.isArray(lifecycle) ||
    lifecycle.some((item) => !isNormalizedLifecycleRevalidation(item)) ||
    !isSafeUsage(value.safeUsage) ||
    findings.length !== snapshot.findingCount
  ) {
    throw invalidResponse('investigation_terminal_payload_invalid');
  }
}

function isNormalizedFinding(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'category',
      'endLine',
      'evidence',
      'message',
      'normalizedFailureModeHash',
      'path',
      'placementConfidence',
      'severity',
      'startLine',
      'suggestion',
      'title',
    ]) &&
    typeof value.category === 'string' &&
    isNullablePositiveInteger(value.endLine) &&
    isStringArray(value.evidence) &&
    typeof value.message === 'string' &&
    isSha256Digest(value.normalizedFailureModeHash) &&
    typeof value.path === 'string' &&
    isNullableConfidence(value.placementConfidence) &&
    isFindingSeverity(value.severity) &&
    isNullablePositiveInteger(value.startLine) &&
    (value.suggestion === null || typeof value.suggestion === 'string') &&
    typeof value.title === 'string'
  );
}

function isNormalizedLifecycleRevalidation(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'confidence',
      'evidence',
      'fingerprint',
      'rationale',
      'targetId',
      'verdict',
    ]) &&
    isNullableConfidence(value.confidence) &&
    Array.isArray(value.evidence) &&
    value.evidence.every(isNormalizedLifecycleEvidence) &&
    (value.fingerprint === null || typeof value.fingerprint === 'string') &&
    (value.rationale === null || typeof value.rationale === 'string') &&
    typeof value.targetId === 'string' &&
    isLifecycleVerdict(value.verdict)
  );
}

function isNormalizedLifecycleEvidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['endLine', 'path', 'reason', 'startLine']) &&
    isNullablePositiveInteger(value.endLine) &&
    typeof value.path === 'string' &&
    typeof value.reason === 'string' &&
    isNullablePositiveInteger(value.startLine)
  );
}

function isFindingSeverity(value: unknown): boolean {
  return value === 'critical' || value === 'major' || value === 'minor';
}

function isLifecycleVerdict(value: unknown): boolean {
  return (
    value === 'resolved' || value === 'still_valid' || value === 'uncertain'
  );
}

function isSha256Digest(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isNullablePositiveInteger(value: unknown): boolean {
  return value === null || (Number.isSafeInteger(value) && Number(value) > 0);
}

function isNullableConfidence(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1)
  );
}

function isSafeUsage(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['inputTokens', 'outputTokens', 'totalTokens']) ||
    !isNullableNonNegativeInteger(value.inputTokens) ||
    !isNullableNonNegativeInteger(value.outputTokens) ||
    !isNullableNonNegativeInteger(value.totalTokens)
  ) {
    return false;
  }
  return !(
    typeof value.inputTokens === 'number' &&
    typeof value.outputTokens === 'number' &&
    typeof value.totalTokens === 'number' &&
    value.totalTokens !== value.inputTokens + value.outputTokens
  );
}

function isNullableNonNegativeInteger(value: unknown): boolean {
  return value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function publishedConclusion(
  conclusion: ReviewInvestigationConclusion | null
): ReviewInvestigationPublishedConclusion | null {
  return conclusion as ReviewInvestigationPublishedConclusion | null;
}

function publishedState(
  state: ReviewInvestigationState
): ReviewInvestigationPublishedState {
  return state as unknown as ReviewInvestigationPublishedState;
}

function publishedNextAction(
  action: ReviewInvestigationNextAction
): PublishedNextAction {
  return action as unknown as PublishedNextAction;
}

function requireTurn(
  snapshot: ReviewInvestigationSnapshot
): ReviewInvestigationTurn {
  if (snapshot.turn === null || snapshot.turn.turnCapability.length === 0) {
    throw invalidResponse('investigation_active_turn_missing');
  }
  return snapshot.turn;
}

function transportError(
  error: unknown,
  operationId: ReviewActionV2OperationId,
  mutation: boolean
): ReviewInvestigationControlPlaneError {
  if (error instanceof ReviewInvestigationControlPlaneError) return error;
  if (!(error instanceof ReviewActionV2ClientError)) {
    return new ReviewInvestigationControlPlaneError(
      mutation
        ? ReviewInvestigationControlPlaneFailureClass.AmbiguousOutcome
        : ReviewInvestigationControlPlaneFailureClass.Unavailable,
      `investigation_control_plane_failure:${operationId}`
    );
  }
  if (
    error.protocolErrorCode ===
    ReviewActionV2ProtocolErrorCode.CapabilityDisabled
  ) {
    return new ReviewInvestigationControlPlaneError(
      ReviewInvestigationControlPlaneFailureClass.CapabilityDisabled,
      error.message
    );
  }
  if (
    error.protocolErrorCode === ReviewActionV2ProtocolErrorCode.CapacityLimited
  ) {
    return new ReviewInvestigationControlPlaneError(
      ReviewInvestigationControlPlaneFailureClass.CapacityLimited,
      error.message
    );
  }
  if (
    error.protocolErrorCode ===
    ReviewActionV2ProtocolErrorCode.StalePrecondition
  ) {
    return new ReviewInvestigationControlPlaneError(
      ReviewInvestigationControlPlaneFailureClass.StalePrecondition,
      error.message
    );
  }
  if (
    operationId === ReviewActionV2OperationId.ReviewInvestigationTurnCommit &&
    error.protocolErrorCode ===
      ReviewActionV2ProtocolErrorCode.InvariantViolation &&
    error.issues !== undefined &&
    error.issues.length > 0 &&
    error.issues.every((issue) => providerOutputInvariantViolations.has(issue))
  ) {
    return new ReviewInvestigationControlPlaneError(
      ReviewInvestigationControlPlaneFailureClass.ProviderOutputInvalid,
      error.message
    );
  }
  const ambiguous =
    mutation &&
    (error.protocolErrorCode ===
      ReviewActionV2ProtocolErrorCode.AmbiguousOutcome ||
      error.code === ReviewActionV2ClientFailureCode.NetworkFailure ||
      error.code === ReviewActionV2ClientFailureCode.RequestTimedOut ||
      error.code === ReviewActionV2ClientFailureCode.InvalidResponse);
  return new ReviewInvestigationControlPlaneError(
    ambiguous
      ? ReviewInvestigationControlPlaneFailureClass.AmbiguousOutcome
      : ReviewInvestigationControlPlaneFailureClass.Rejected,
    error.message
  );
}

const providerOutputInvariantViolations = new Set([
  'investigation_operation_backed_discovery_invalid',
  'investigation_operation_backed_discovery_limit_exceeded',
]);

function statusError(status: string): ReviewInvestigationControlPlaneError {
  return new ReviewInvestigationControlPlaneError(
    status === 'conflict'
      ? ReviewInvestigationControlPlaneFailureClass.Conflict
      : ReviewInvestigationControlPlaneFailureClass.Rejected,
    `investigation_result_${status}`
  );
}

function invalidResponse(
  message: string
): ReviewInvestigationControlPlaneError {
  return new ReviewInvestigationControlPlaneError(
    ReviewInvestigationControlPlaneFailureClass.InvalidResponse,
    message
  );
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidResponse(`${field}_invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): void {
  if (!hasExactKeys(value, keys)) {
    throw invalidResponse('investigation_shape_invalid');
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return !(
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  );
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 16_000) {
    throw invalidResponse(`${field}_invalid`);
  }
  return value;
}

function requireBoundedText(
  value: unknown,
  field: string,
  maximumLength: number
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    })
  ) {
    throw invalidResponse(`${field}_invalid`);
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined
    ? null
    : requireString(value, 'nullable_string');
}

function nullableDigest(value: unknown, field: string): string | null {
  return value === null ? null : requireDigest(value, field);
}

function nullableEnumValue<T extends Record<string, string>>(
  value: unknown,
  source: T,
  field: string
): T[keyof T] | null {
  return value === null ? null : enumValue(value, source, field);
}

function nullableCanonicalJson(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length < 2) {
    throw invalidResponse(`${field}_invalid`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidResponse(`${field}_invalid`);
  }
  if (canonicalJson(parsed as Parameters<typeof canonicalJson>[0]) !== value) {
    throw invalidResponse(`${field}_not_canonical`);
  }
  return value;
}

function requireDigest(value: unknown, field: string): string {
  const digest = requireString(value, field);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw invalidResponse(`${field}_invalid`);
  return digest;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw invalidResponse(`${field}_invalid`);
  }
  return Number(value);
}

function requireBoundedRiskPriority(value: unknown, field: string): number {
  const parsed = requireNonNegativeInteger(value, field);
  if (parsed > 1_000_000) throw invalidResponse(`${field}_invalid`);
  return parsed;
}

function requireArray(
  value: unknown,
  field: string,
  maximum = 256
): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw invalidResponse(`${field}_invalid`);
  }
  return value;
}

function requireCanonicalDocumentString(
  value: unknown,
  field: string,
  maximumBytes = 2 * 1_024 * 1_024
): string {
  if (
    typeof value !== 'string' ||
    value.length < 2 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw invalidResponse(`${field}_invalid`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidResponse(`${field}_invalid`);
  }
  if (canonicalJson(parsed as Parameters<typeof canonicalJson>[0]) !== value) {
    throw invalidResponse(`${field}_not_canonical`);
  }
  return value;
}

function enumValue<T extends Record<string, string>>(
  value: unknown,
  source: T,
  field: string
): T[keyof T] {
  if (typeof value !== 'string' || !Object.values(source).includes(value)) {
    throw invalidResponse(`${field}_invalid`);
  }
  return value as T[keyof T];
}

function timestamp(value: unknown, field: string): string {
  const result = requireString(value, field);
  if (!Number.isFinite(Date.parse(result))) {
    throw invalidResponse(`${field}_invalid`);
  }
  return result;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : timestamp(value, field);
}
