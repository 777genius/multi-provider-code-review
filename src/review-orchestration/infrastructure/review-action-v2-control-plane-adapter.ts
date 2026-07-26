import { createHash } from 'crypto';
import {
  ReviewActionV2Client,
  ReviewActionV2ClientError,
} from '../../control-plane/review-action-v2-client';
import {
  reviewActionV2PublishedProtocolVersion,
  reviewActionV2PublishedSchemaDigest,
  ReviewActionV2OperationId,
  ReviewContextGatewayOpenResultStatus,
  ReviewContextGatewaySealResultStatus,
  ReviewContextReplayCommitResultStatus,
  ReviewEvidenceCommitResultStatus,
  ReviewEvidenceLookupResultStatus,
  ReviewExecutionMutationResultStatus,
  ReviewExecutionRestoreResultStatus,
  ReviewExecutionStartResultStatus,
  ReviewInvocationLeaseResultStatus,
  ReviewPublicationRequestResultStatus,
  ReviewPublicationStatusResultStatus,
  ReviewRunAuthorizationResultStatus,
  ReviewActionV2ProtocolErrorCode,
  type ReviewEvidenceLookupResult,
  type ReviewExecutionStartResult,
} from '../../control-plane/generated/review-action-v2/review-action-v2';
import {
  ReviewEvidenceLookupKind,
  ReviewExecutionProviderKind,
  ReviewInvocationLeaseAcquireOutcomeStatus,
  ReviewPublicationRequestOutcomeStatus,
  ReviewPublicationState,
  RestoredReviewExecutionState,
  RestoredReviewWorkSlotState,
  type AcceptedReviewObservation,
  type ReviewActionV2ControlPlanePort,
  type ReviewContextAttestationPort,
  type ReviewExecutionAdmission,
  type ReviewInvocationLease,
  type ReviewProtocolLimits,
  type ReviewRunAuthorization,
  type RestoredReviewExecution,
  type ReviewWorkSlotPlan,
} from '../application';

export class ReviewActionV2ControlPlaneAdapter
  implements ReviewActionV2ControlPlanePort, ReviewContextAttestationPort
{
  private activeAuthorization: ReviewRunAuthorization | null = null;

  constructor(private readonly client: ReviewActionV2Client) {}

  async authorize(input: {
    readonly oidcToken: string;
  }): Promise<ReviewRunAuthorization> {
    const result = await this.client.execute(
      ReviewActionV2OperationId.ReviewRunAuthorize,
      {
        oidcToken: input.oidcToken,
        supportedProtocols: [
          {
            protocolVersion: reviewActionV2PublishedProtocolVersion,
            schemaDigest: reviewActionV2PublishedSchemaDigest,
          },
        ],
      }
    );
    if (
      result.status !== ReviewRunAuthorizationResultStatus.Authorized &&
      result.status !== ReviewRunAuthorizationResultStatus.Restored
    ) {
      throw new Error('review_action_v2_authorization_denied');
    }
    const authorization = {
      authorizationId: requireString(
        result.authorizationId,
        'authorization_id'
      ),
      authorizationToken: requireString(
        result.authorizationToken,
        'authorization_token'
      ),
      producerReleaseId: requireString(
        result.producerReleaseId,
        'producer_release_id'
      ),
      protocolLimitsProfileId: requireString(
        result.protocolLimitsProfileId,
        'protocol_limits_profile_id'
      ),
      operationalSloProfileId: requireString(
        result.operationalSloProfileId,
        'operational_slo_profile_id'
      ),
      mutationEpoch: requireDecimal(result.mutationEpoch, 'mutation_epoch'),
      expiresAt: requireTimestamp(result.expiresAt, 'expires_at'),
      limits: parseProtocolLimits(result.protocolLimitsCanonicalJson),
      facts: parseAuthorizationFacts(result.authorizationFactsCanonicalJson),
    };
    this.activeAuthorization = authorization;
    return authorization;
  }

  async openGatewaySession(
    input: Parameters<ReviewContextAttestationPort['openGatewaySession']>[0]
  ): ReturnType<ReviewContextAttestationPort['openGatewaySession']> {
    const authorization = this.requireActiveAuthorization();
    const result = await this.client.execute(
      ReviewActionV2OperationId.ReviewContextGatewayOpen,
      {
        authorizationToken: authorization.authorizationToken,
        leaseCapability: input.invocationLease.leaseCapability,
        idempotencyKey: deterministicIdempotencyKey('context-gateway-open', [
          input.invocationLease.attemptId,
          input.invocationLease.leaseId,
          input.invocationLease.fencingToken,
          input.sourceExecutionId,
          input.sourceWorkSlotId,
          input.sourceReviewRevisionHash,
          input.checkoutTreeOid,
          input.gatewayPolicyVersion,
          input.gatewayBinaryHash,
          input.confinementEvidenceHash,
        ]),
        attemptId: input.invocationLease.attemptId,
        sourceLeaseId: input.invocationLease.leaseId,
        fencingToken: input.invocationLease.fencingToken,
        sourceExecutionId: input.sourceExecutionId,
        sourceWorkSlotId: input.sourceWorkSlotId,
        sourceReviewRevisionHash: input.sourceReviewRevisionHash,
        checkoutTreeOid: input.checkoutTreeOid,
        gatewayPolicyVersion: input.gatewayPolicyVersion,
        gatewayBinaryHash: input.gatewayBinaryHash,
        confinementEvidenceHash: input.confinementEvidenceHash,
      }
    );
    if (
      result.status !== ReviewContextGatewayOpenResultStatus.Opened &&
      result.status !== ReviewContextGatewayOpenResultStatus.Idempotent
    ) {
      throw new Error(`review_action_v2_context_gateway_open_${result.status}`);
    }
    return Object.freeze({
      sessionId: requireString(result.sessionId, 'context_gateway_session_id'),
      eventChainSeedHash: requireDigest(
        result.eventChainSeedHash,
        'context_gateway_event_chain_seed_hash'
      ),
      sealCapability: requireString(
        result.sealCapability,
        'context_gateway_seal_capability'
      ),
      gatewaySessionSecret: requireString(
        result.gatewaySessionSecret,
        'context_gateway_session_secret'
      ),
      expiresAt: requireTimestamp(
        result.expiresAt,
        'context_gateway_expires_at'
      ),
    });
  }

  async sealGatewaySession(
    input: Parameters<ReviewContextAttestationPort['sealGatewaySession']>[0]
  ): ReturnType<ReviewContextAttestationPort['sealGatewaySession']> {
    const authorization = this.requireActiveAuthorization();
    let result;
    try {
      result = await this.client.execute(
        ReviewActionV2OperationId.ReviewContextGatewaySeal,
        {
          authorizationToken: authorization.authorizationToken,
          leaseCapability: input.invocationLease.leaseCapability,
          idempotencyKey: deterministicIdempotencyKey('context-gateway-seal', [
            input.session.sessionId,
            input.transcriptHash,
            input.replayMaterialHash,
            input.terminalOutcomeHash,
          ]),
          sessionId: input.session.sessionId,
          sealCapability: input.session.sealCapability,
          attemptId: input.invocationLease.attemptId,
          sourceLeaseId: input.invocationLease.leaseId,
          fencingToken: input.invocationLease.fencingToken,
          providerSucceeded: input.providerSucceeded,
          schemaValidated: input.schemaValidated,
          fullyConsumed: input.fullyConsumed,
          actualModel: input.actualModel,
          terminalOutcomeHash: input.terminalOutcomeHash,
          transcriptCanonicalJson: input.transcriptCanonicalJson,
          transcriptHash: input.transcriptHash,
          replayMaterialCanonicalJson: input.replayMaterialCanonicalJson,
          replayMaterialHash: input.replayMaterialHash,
        }
      );
    } catch (error) {
      throw controlPlaneFailure(error);
    }
    if (
      result.status === ReviewContextGatewaySealResultStatus.Denied ||
      result.status === ReviewContextGatewaySealResultStatus.Conflict
    ) {
      return null;
    }
    if (
      result.status !== ReviewContextGatewaySealResultStatus.Accepted &&
      result.status !== ReviewContextGatewaySealResultStatus.Idempotent
    ) {
      throw new Error(`review_action_v2_context_gateway_seal_${result.status}`);
    }
    return Object.freeze({
      attestationId: requireString(
        result.attestationId,
        'context_dependency_attestation_id'
      ),
      attestationHash: requireDigest(
        result.attestationHash,
        'context_dependency_attestation_hash'
      ),
    });
  }

  async commitContextReplay(
    input: Parameters<ReviewContextAttestationPort['commitContextReplay']>[0]
  ): ReturnType<ReviewContextAttestationPort['commitContextReplay']> {
    const result = await this.client.execute(
      ReviewActionV2OperationId.ReviewContextReplayCommit,
      {
        authorizationToken: input.authorization.authorizationToken,
        idempotencyKey: deterministicIdempotencyKey('context-replay-commit', [
          input.execution.executionId,
          input.workSlot.workSlotId,
          input.candidate.attestationId,
          input.candidate.attestationHash,
          input.result.targetCheckoutTreeOid,
          input.result.replayResultHash,
        ]),
        executionId: input.execution.executionId,
        workSlotId: input.workSlot.workSlotId,
        attestationId: input.candidate.attestationId,
        attestationHash: input.candidate.attestationHash,
        targetReviewRevisionHash: input.authorization.facts.reviewRevisionHash,
        targetCheckoutTreeOid: input.result.targetCheckoutTreeOid,
        replayCapability: input.candidate.replayCapability,
        replayResultCanonicalJson: input.result.replayResultCanonicalJson,
        replayResultHash: input.result.replayResultHash,
      }
    );
    if (
      result.status === ReviewContextReplayCommitResultStatus.Denied ||
      result.status === ReviewContextReplayCommitResultStatus.Conflict
    ) {
      return null;
    }
    if (
      result.status !== ReviewContextReplayCommitResultStatus.Accepted &&
      result.status !== ReviewContextReplayCommitResultStatus.Idempotent
    ) {
      throw new Error(`review_action_v2_context_replay_${result.status}`);
    }
    return Object.freeze({
      attachmentCapability: requireString(
        result.attachmentCapability,
        'context_replay_attachment_capability'
      ),
    });
  }

  private requireActiveAuthorization(): ReviewRunAuthorization {
    if (!this.activeAuthorization) {
      throw new Error('review_action_v2_context_gateway_unauthorized');
    }
    return this.activeAuthorization;
  }

  async restoreSnapshot(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly reviewRevisionHash: string;
  }): Promise<void> {
    await this.client.execute(ReviewActionV2OperationId.ReviewSnapshotRestore, {
      authorizationToken: input.authorization.authorizationToken,
      reviewRevisionHash: input.reviewRevisionHash,
    });
  }

  async restoreExecution(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly reviewRevisionHash: string;
  }): Promise<RestoredReviewExecution | null> {
    const result = await this.client.execute(
      ReviewActionV2OperationId.ReviewExecutionRestore,
      {
        authorizationToken: input.authorization.authorizationToken,
        authorizationId: input.authorization.authorizationId,
        reviewRevisionHash: input.reviewRevisionHash,
      }
    );
    if (
      result.status === ReviewExecutionRestoreResultStatus.Missing ||
      result.status === ReviewExecutionRestoreResultStatus.NotRestorable
    ) {
      return null;
    }
    if (result.status !== ReviewExecutionRestoreResultStatus.Found) {
      throw new Error('review_action_v2_restore_status_unknown');
    }
    const streamVersion = requireDecimal(
      result.streamVersion,
      'restore_stream_version'
    );
    const restored = parseRestoredExecution(result.executionCanonicalJson, {
      authorizationId: input.authorization.authorizationId,
      reviewRevisionHash: input.reviewRevisionHash,
      maxWorkSlots: input.authorization.limits.maxWorkSlots,
      streamVersion,
    });
    if (
      requireString(result.executionId, 'restore_execution_id') !==
        restored.executionId ||
      requireDecimal(result.generation, 'restore_generation') !==
        restored.generation ||
      requireString(result.executionState, 'restore_execution_state') !==
        restored.state
    ) {
      throw new Error('review_action_v2_restore_envelope_mismatch');
    }
    return restored;
  }

  async startExecution(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly idempotencyKey: string;
    readonly executionId: string;
    readonly reviewRevisionHash: string;
    readonly compatibilityKey: string;
    readonly planHash: string;
    readonly workSlotsCanonicalJson: string;
    readonly workSlots: readonly ReviewWorkSlotPlan[];
    readonly sourceRunId: string;
    readonly sourceRunAttempt: string;
  }): Promise<ReviewExecutionAdmission> {
    const result = await this.client.execute(
      ReviewActionV2OperationId.ReviewExecutionStart,
      {
        authorizationToken: input.authorization.authorizationToken,
        idempotencyKey: input.idempotencyKey,
        authorizationId: input.authorization.authorizationId,
        executionId: input.executionId,
        reviewRevisionHash: input.reviewRevisionHash,
        compatibilityKey: input.compatibilityKey,
        planHash: input.planHash,
        workSlotsCanonicalJson: input.workSlotsCanonicalJson,
        sourceRunId: input.sourceRunId,
        sourceRunAttempt: input.sourceRunAttempt,
      }
    );
    if (
      result.status !== ReviewExecutionStartResultStatus.Admitted &&
      result.status !== ReviewExecutionStartResultStatus.Restored
    ) {
      throw new Error(`review_action_v2_execution_${result.status}`);
    }
    return parseExecutionAdmission(result, input);
  }

  async supersedeExecution(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly idempotencyKey: string;
    readonly execution: ReviewExecutionAdmission;
    readonly targetRevisionHash: string;
  }): Promise<void> {
    const operationId = ReviewActionV2OperationId.ReviewExecutionSupersede;
    const request = {
      authorizationToken: input.authorization.authorizationToken,
      idempotencyKey: input.idempotencyKey,
      executionId: input.execution.executionId,
      expectedStreamVersion: input.execution.streamVersion,
      targetRevisionHash: input.targetRevisionHash,
    } as const;
    const result = await this.client.execute(operationId, request).catch((error) => {
      if (isBenignSupersedeTargetRevisionMismatch(error)) {
        return {
          status: ReviewExecutionMutationResultStatus.Restored,
          executionId: input.execution.executionId,
          streamVersion: input.execution.streamVersion,
        };
      }
      throw error;
    });
    requireMutationApplied(result.status, 'execution_supersede');
  }

  async lookupEvidence(
    input: Parameters<ReviewActionV2ControlPlanePort['lookupEvidence']>[0]
  ): ReturnType<ReviewActionV2ControlPlanePort['lookupEvidence']> {
    const result = await this.client.execute(
      ReviewActionV2OperationId.ReviewEvidenceLookup,
      {
        authorizationToken: input.authorization.authorizationToken,
        executionId: input.execution.executionId,
        workSlotId: input.workSlot.workSlotId,
        planHash: input.planHash,
        manifestCanonicalJson: input.manifest.manifestCanonicalJson,
        manifestKey: input.manifest.manifestKey,
        providerInvocationKey: input.manifest.providerInvocationKey,
        providerVoteIdentityHash: input.manifest.providerVoteIdentityHash,
      }
    );
    if (result.status === ReviewEvidenceLookupResultStatus.Miss) {
      return { kind: ReviewEvidenceLookupKind.Miss };
    }
    if (result.status === ReviewEvidenceLookupResultStatus.ReplayRequired) {
      const observation = parseLookupObservation(result, input);
      const attestationId = requireString(
        result.contextDependencyAttestationId,
        'context_dependency_attestation_id'
      );
      const attestationHash = requireDigest(
        result.contextDependencyAttestationHash,
        'context_dependency_attestation_hash'
      );
      const replayPlanCanonicalJson = requireCanonicalJson(
        result.contextReplayPlanCanonicalJson,
        'context_replay_plan'
      );
      const replayPlanHash = requireDigest(
        result.contextReplayPlanHash,
        'context_replay_plan_hash'
      );
      if (
        digest(replayPlanCanonicalJson) !== replayPlanHash ||
        observation.contextDependencyAttestationId !== attestationId ||
        observation.contextDependencyAttestationHash !== attestationHash
      ) {
        throw new Error('review_action_v2_context_replay_identity_mismatch');
      }
      return {
        kind: ReviewEvidenceLookupKind.ReplayRequired,
        observation,
        attestationId,
        attestationHash,
        replayCapability: requireString(
          result.contextReplayCapability,
          'context_replay_capability'
        ),
        replayPlanCanonicalJson,
        replayPlanHash,
      };
    }
    if (
      result.status === ReviewEvidenceLookupResultStatus.Hit ||
      result.status === ReviewEvidenceLookupResultStatus.Shadow
    ) {
      const sourceFacts = parseAdoptionSourceFacts(result);
      if (
        result.status === ReviewEvidenceLookupResultStatus.Shadow &&
        sourceFacts === null
      ) {
        return { kind: ReviewEvidenceLookupKind.Miss };
      }
      const observation = parseLookupObservation(result, input);
      const attachmentCapability = result.attachmentCapability ?? null;
      const attachmentKind = result.attachmentKind ?? null;
      const attachment = attachmentCapability
        ? parseExactRevisionAttachment(
            attachmentCapability,
            attachmentKind,
            result.reuseSafetyDecisionHash,
            sourceFacts
          )
        : parseSameExecutionAttachment(
            attachmentKind,
            result.reuseSafetyDecisionHash,
            sourceFacts
          );
      return {
        kind: ReviewEvidenceLookupKind.Hit,
        attachment,
        observation,
      };
    }
    throw new Error('review_action_v2_lookup_status_unknown');
  }

  async acquireInvocationLease(
    input: Parameters<
      ReviewActionV2ControlPlanePort['acquireInvocationLease']
    >[0]
  ): ReturnType<ReviewActionV2ControlPlanePort['acquireInvocationLease']> {
    const result = await this.client.execute(
      ReviewActionV2OperationId.ReviewInvocationLeaseAcquire,
      {
        authorizationToken: input.authorization.authorizationToken,
        idempotencyKey: input.idempotencyKey,
        executionId: input.execution.executionId,
        workSlotId: input.workSlot.workSlotId,
        purpose: 'provider_execution',
        manifestCanonicalJson: input.manifest.manifestCanonicalJson,
        manifestKey: input.manifest.manifestKey,
        providerInvocationKey: input.manifest.providerInvocationKey,
        providerVoteIdentityHash: input.manifest.providerVoteIdentityHash,
        acquireRequestId: input.acquireRequestId,
        ownerIdHash: input.ownerIdHash,
      }
    );
    if (result.status === ReviewInvocationLeaseResultStatus.Busy) {
      return { status: ReviewInvocationLeaseAcquireOutcomeStatus.Busy };
    }
    if (result.status === ReviewInvocationLeaseResultStatus.Rejected) {
      return leaseAcquireRejectedOutcome(result.rejectionReason);
    }
    if (
      result.status !== ReviewInvocationLeaseResultStatus.Acquired &&
      result.status !== ReviewInvocationLeaseResultStatus.Restored
    ) {
      throw new Error(`review_action_v2_lease_${result.status}`);
    }
    return {
      status: ReviewInvocationLeaseAcquireOutcomeStatus.Acquired,
      lease: parseLease(result),
    };
  }

  async renewInvocationLease(
    input: Parameters<ReviewActionV2ControlPlanePort['renewInvocationLease']>[0]
  ): ReturnType<ReviewActionV2ControlPlanePort['renewInvocationLease']> {
    const result = await this.client.execute(
      ReviewActionV2OperationId.ReviewInvocationLeaseRenew,
      {
        leaseCapability: input.lease.leaseCapability,
        idempotencyKey: input.idempotencyKey,
        leaseId: input.lease.leaseId,
        ownerIdHash: input.ownerIdHash,
        fencingToken: input.lease.fencingToken,
        renewRequestId: input.renewRequestId,
      }
    );
    if (
      result.status !== ReviewInvocationLeaseResultStatus.Applied &&
      result.status !== ReviewInvocationLeaseResultStatus.Restored
    ) {
      throw new Error(`review_action_v2_lease_renew_${result.status}`);
    }
    const leaseId = requireString(result.leaseId, 'lease_renew_lease_id');
    const fencingToken = requireDecimal(
      result.fencingToken,
      'lease_renew_fencing_token'
    );
    const expiresAt = requireTimestamp(
      result.expiresAt,
      'lease_renew_expires_at'
    );
    const leaseCapability = requireString(
      result.leaseCapability,
      'lease_renew_capability'
    );
    const previousExpiry = Date.parse(input.lease.expiresAt);
    const renewedExpiry = Date.parse(expiresAt);
    const expiryAdvanced = renewedExpiry > previousExpiry;
    // Restored can recover a lost acknowledgement after the renewal was applied.
    const renewalCeilingReached =
      result.status === ReviewInvocationLeaseResultStatus.Restored &&
      !expiryAdvanced;
    if (
      leaseId !== input.lease.leaseId ||
      fencingToken !== input.lease.fencingToken ||
      renewedExpiry < previousExpiry ||
      (expiryAdvanced && leaseCapability === input.lease.leaseCapability) ||
      (result.status === ReviewInvocationLeaseResultStatus.Applied &&
        !expiryAdvanced)
    ) {
      throw new Error('review_action_v2_lease_renewal_drift');
    }
    return {
      ...input.lease,
      leaseCapability,
      expiresAt,
      renewalCeilingReached,
    };
  }

  async releaseInvocationLease(
    input: Parameters<
      ReviewActionV2ControlPlanePort['releaseInvocationLease']
    >[0]
  ): Promise<void> {
    const result = await this.client.execute(
      ReviewActionV2OperationId.ReviewInvocationLeaseRelease,
      {
        leaseCapability: input.lease.leaseCapability,
        idempotencyKey: input.idempotencyKey,
        leaseId: input.lease.leaseId,
        ownerIdHash: input.ownerIdHash,
        fencingToken: input.lease.fencingToken,
        releaseRequestId: input.releaseRequestId,
      }
    );
    if (
      result.status !== ReviewInvocationLeaseResultStatus.Applied &&
      result.status !== ReviewInvocationLeaseResultStatus.Restored &&
      result.status !== ReviewInvocationLeaseResultStatus.Expired
    ) {
      throw new Error(`review_action_v2_lease_release_${result.status}`);
    }
  }

  async commitEvidence(
    input: Parameters<ReviewActionV2ControlPlanePort['commitEvidence']>[0]
  ): ReturnType<ReviewActionV2ControlPlanePort['commitEvidence']> {
    const result = await (async () => {
      try {
        return await this.client.execute(
          ReviewActionV2OperationId.ReviewEvidenceCommit,
          {
            authorizationToken: input.authorization.authorizationToken,
            leaseCapability: input.lease.leaseCapability,
            idempotencyKey: input.idempotencyKey,
            attemptId: input.lease.attemptId,
            sourceLeaseId: input.lease.leaseId,
            ownerIdHash: input.ownerIdHash,
            fencingToken: input.lease.fencingToken,
            completionStatus: 'success',
            schemaValidated: input.observation.schemaValidated,
            fullyConsumed: input.observation.fullyConsumed,
            actualModel: input.observation.actualModel,
            contextDependencyAttestationId:
              input.observation.contextDependencyAttestationId ?? null,
            contextDependencyAttestationHash:
              input.observation.contextDependencyAttestationHash ?? null,
            payloadCanonicalJson: input.observation.payloadCanonicalJson,
            payloadHash: input.observation.payloadHash,
            qualityFlags: input.observation.qualityFlags,
            transportAttemptCount: input.observation.transportAttemptCount,
          }
        );
      } catch (error) {
        throw controlPlaneFailure(error);
      }
    })();
    if (
      result.status !== ReviewEvidenceCommitResultStatus.Accepted &&
      result.status !== ReviewEvidenceCommitResultStatus.Idempotent
    ) {
      throw new Error(`review_action_v2_evidence_commit_${result.status}`);
    }
    return {
      observationId: requireString(result.observationId, 'observation_id'),
      historicalOnly: result.historicalOnly === true,
      eligibilityPolicyVersion: requireString(
        result.eligibilityPolicyVersion,
        'eligibility_policy_version'
      ),
    };
  }

  async attachObservation(
    input: Parameters<ReviewActionV2ControlPlanePort['attachObservation']>[0]
  ): ReturnType<ReviewActionV2ControlPlanePort['attachObservation']> {
    const result = await this.client.execute(
      ReviewActionV2OperationId.ReviewExecutionObservationAttach,
      {
        authorizationToken: input.authorization.authorizationToken,
        leaseCapability: input.attachmentCapability,
        idempotencyKey: input.idempotencyKey,
        executionId: input.execution.executionId,
        workSlotId: input.workSlot.workSlotId,
        observationId: input.observation.observationId,
        providerInvocationKey: input.observation.providerInvocationKey,
        providerVoteIdentityHash: input.observation.providerVoteIdentityHash,
        payloadHash: input.observation.payloadHash,
        byteCount: input.observation.byteCount,
        findingCount: input.observation.findingCount,
        eligibilityPolicyVersion: input.observation.eligibilityPolicyVersion,
      }
    );
    requireMutationApplied(result.status, 'observation_attach');
    return {
      streamVersion: requireDecimal(result.streamVersion, 'stream_version'),
    };
  }

  async adoptObservation(
    input: Parameters<ReviewActionV2ControlPlanePort['adoptObservation']>[0]
  ): ReturnType<ReviewActionV2ControlPlanePort['adoptObservation']> {
    const result = await this.client.execute(
      ReviewActionV2OperationId.ReviewExecutionObservationAdopt,
      {
        authorizationToken: input.authorization.authorizationToken,
        idempotencyKey: input.idempotencyKey,
        executionId: input.execution.executionId,
        executionGeneration: input.execution.generation,
        expectedStreamVersion: input.execution.streamVersion,
        expectedExecutionVersion: input.execution.executionVersion,
        workSlotId: input.workSlot.workSlotId,
        observationId: input.observation.observationId,
        providerInvocationKey: input.observation.providerInvocationKey,
        providerVoteIdentityHash: input.observation.providerVoteIdentityHash,
        payloadHash: input.observation.payloadHash,
        byteCount: input.observation.byteCount,
        findingCount: input.observation.findingCount,
        sourceLeaseId: input.source.sourceLeaseId,
        sourceFencingToken: input.source.sourceFencingToken,
        manifestCanonicalJson: input.manifest.manifestCanonicalJson,
        manifestKey: input.manifest.manifestKey,
        planHash: input.planHash,
        reviewRevisionHash: input.authorization.facts.reviewRevisionHash,
        ownerIdHash: input.source.sourceOwnerIdHash,
        eligibilityPolicyVersion: input.observation.eligibilityPolicyVersion,
      }
    );
    requireMutationApplied(result.status, 'observation_adopt');
    if (
      requireString(result.executionId, 'adopt_execution_id') !==
        input.execution.executionId ||
      requireString(result.workSlotId, 'adopt_work_slot_id') !==
        input.workSlot.workSlotId ||
      requireCanonicalJson(
        result.observationPayloadCanonicalJson,
        'adopt_observation_payload'
      ) !== input.observation.payloadCanonicalJson ||
      requireCanonicalJson(
        result.observationFactsCanonicalJson,
        'adopt_observation_facts'
      ) !== adoptionFactsCanonicalJson(input)
    ) {
      throw new Error('review_action_v2_adoption_response_identity_mismatch');
    }
    return {
      streamVersion: requireDecimal(result.streamVersion, 'stream_version'),
    };
  }

  async finalizeExecution(
    input: Parameters<ReviewActionV2ControlPlanePort['finalizeExecution']>[0]
  ): ReturnType<ReviewActionV2ControlPlanePort['finalizeExecution']> {
    const result = await (async () => {
      try {
        return await this.client.execute(
          ReviewActionV2OperationId.ReviewExecutionFinalize,
          {
            authorizationToken: input.authorization.authorizationToken,
            idempotencyKey: input.idempotencyKey,
            executionId: input.execution.executionId,
            expectedStreamVersion: input.execution.streamVersion,
            expectedExecutionVersion: input.execution.executionVersion,
            artifactId: input.projection.artifactId,
            artifactHash: input.projection.artifactHash,
            projectionEnvelopeVersion:
              input.projection.projectionEnvelopeVersion,
            projectionEnvelopeCanonicalJson:
              input.projection.projectionEnvelopeCanonicalJson,
            projectionHash: input.projection.projectionHash,
            lifecycleStateHash: input.projection.lifecycleStateHash,
            commandLedgerWatermark: input.projection.commandLedgerWatermark,
            allowPartial: input.allowPartial,
          }
        );
      } catch (error) {
        throw controlPlaneFailure(error);
      }
    })();
    requireMutationApplied(result.status, 'execution_finalize');
    return {
      publicationPermit: requireString(
        result.publicationPermit,
        'publication_permit'
      ),
    };
  }

  async requestPublication(
    input: Parameters<ReviewActionV2ControlPlanePort['requestPublication']>[0]
  ): ReturnType<ReviewActionV2ControlPlanePort['requestPublication']> {
    const result = await (async () => {
      try {
        return await this.client.execute(
          ReviewActionV2OperationId.ReviewPublicationRequest,
          {
            authorizationToken: input.authorization.authorizationToken,
            idempotencyKey: input.idempotencyKey,
            publicationPermit: input.publicationPermit,
            projectionHash: input.projection.projectionHash,
            operationsCanonicalJson: input.projection.operationsCanonicalJson,
          }
        );
      } catch (error) {
        if (isPublicationRequestAmbiguousOutcome(error)) {
          return {
            status: ReviewPublicationRequestResultStatus.Conflict,
            publicationAttemptId: null,
            publicationState: null,
            pollAfterMs: null,
          };
        }
        throw controlPlaneFailure(error);
      }
    })();
    if (result.status === ReviewPublicationRequestResultStatus.Conflict) {
      return {
        status: ReviewPublicationRequestOutcomeStatus.Conflict,
      };
    }
    if (
      result.status !== ReviewPublicationRequestResultStatus.Accepted &&
      result.status !== ReviewPublicationRequestResultStatus.Restored
    ) {
      throw new Error(`review_action_v2_publication_${result.status}`);
    }
    return {
      status: ReviewPublicationRequestOutcomeStatus.Requested,
      publicationAttemptId: requireString(
        result.publicationAttemptId,
        'publication_attempt_id'
      ),
      pollAfterMs: requireNonNegativeInteger(
        result.pollAfterMs,
        'publication_poll_after_ms'
      ),
    };
  }

  async readPublicationStatus(
    input: Parameters<
      ReviewActionV2ControlPlanePort['readPublicationStatus']
    >[0]
  ): ReturnType<ReviewActionV2ControlPlanePort['readPublicationStatus']> {
    const result = await this.client.execute(
      ReviewActionV2OperationId.ReviewPublicationStatus,
      {
        authorizationToken: input.authorization.authorizationToken,
        publicationAttemptId: input.publicationAttemptId,
      }
    );
    if (result.status !== ReviewPublicationStatusResultStatus.Terminal) {
      return {
        terminal: false,
        pollAfterMs: requireNonNegativeInteger(
          result.pollAfterMs,
          'publication_status_poll_after_ms'
        ),
      };
    }
    return {
      terminal: true,
      outcome: {
        state: parsePublicationOutcome(result.terminalOutcome),
        ...(result.canonicalReceiptSetHash
          ? { canonicalReceiptSetHash: result.canonicalReceiptSetHash }
          : {}),
      },
    };
  }
}

const SAFE_CONTROL_PLANE_DIAGNOSTIC_ISSUES = new Set([
  'artifact_hash_mismatch',
  'context_actual_model_mismatch',
  'context_checkout_tree_mismatch',
  'context_gateway_binary_mismatch',
  'context_gateway_policy_mismatch',
  'context_replay_material_hash_mismatch',
  'context_seal_authority_mismatch',
  'context_transcript_hash_mismatch',
  'context_transcript_hmac_chain_invalid',
  'payload_hash_mismatch',
  'projection_authority_mismatch',
  'publication_permit_authority_mismatch',
  'publication_release_or_limits_invalid',
]);

function controlPlaneFailure(error: unknown): Error {
  if (!(error instanceof ReviewActionV2ClientError)) {
    return error instanceof Error
      ? error
      : new Error('review_action_v2:unknown_failure');
  }
  const category = error.protocolErrorCode ?? error.code;
  const base = `review_action_v2:${error.operationId}:${category}`;
  const issue = error.issues?.find((value) =>
    SAFE_CONTROL_PLANE_DIAGNOSTIC_ISSUES.has(value)
  );
  const diagnostic = issue ? `${base}:${issue}` : base;
  return new Error(diagnostic.length <= 120 ? diagnostic : base, {
    cause: error,
  });
}

function isPublicationRequestAmbiguousOutcome(error: unknown): boolean {
  return (
    error instanceof ReviewActionV2ClientError &&
    error.operationId === ReviewActionV2OperationId.ReviewPublicationRequest &&
    error.protocolErrorCode === ReviewActionV2ProtocolErrorCode.AmbiguousOutcome
  );
}

function parseLookupObservation(
  result: ReviewEvidenceLookupResult,
  input: Parameters<ReviewActionV2ControlPlanePort['lookupEvidence']>[0]
): AcceptedReviewObservation {
  const payloadCanonicalJson = requireCanonicalJson(
    result.payloadCanonicalJson,
    'evidence_payload'
  );
  const payloadHash = requireDigest(result.payloadHash, 'payload_hash');
  const byteCount = requireNonNegativeInteger(result.byteCount, 'byte_count');
  if (
    payloadHash !== digest(payloadCanonicalJson) ||
    byteCount !== Buffer.byteLength(payloadCanonicalJson, 'utf8')
  ) {
    throw new Error('review_action_v2_lookup_payload_identity_mismatch');
  }
  const contextAttestationId = result.contextDependencyAttestationId ?? null;
  const contextAttestationHash =
    result.contextDependencyAttestationHash ?? null;
  if ((contextAttestationId === null) !== (contextAttestationHash === null)) {
    throw new Error('review_action_v2_context_attestation_reference_invalid');
  }
  return Object.freeze({
    observationId: requireString(result.observationId, 'observation_id'),
    payloadCanonicalJson,
    payloadHash,
    byteCount,
    findingCount: requireNonNegativeInteger(
      result.findingCount,
      'finding_count'
    ),
    actualModel: requireString(result.actualModel, 'actual_model'),
    qualityFlags: requireStringArray(result.qualityFlags, 'quality_flags'),
    transportAttemptCount: requirePositiveInteger(
      result.transportAttemptCount,
      'transport_attempt_count'
    ),
    schemaValidated: true,
    fullyConsumed: true,
    eligibilityPolicyVersion: requireString(
      result.eligibilityPolicyVersion,
      'eligibility_policy_version'
    ),
    providerKind: input.workSlot.providerKind,
    providerInvocationKey: input.manifest.providerInvocationKey,
    providerVoteIdentityHash: input.manifest.providerVoteIdentityHash,
    ...(contextAttestationId === null
      ? {}
      : {
          contextDependencyAttestationId: requireString(
            contextAttestationId,
            'context_dependency_attestation_id'
          ),
          contextDependencyAttestationHash: requireDigest(
            contextAttestationHash,
            'context_dependency_attestation_hash'
          ),
        }),
  });
}

function parseExecutionAdmission(
  result: ReviewExecutionStartResult,
  expected: {
    readonly authorization: ReviewRunAuthorization;
    readonly executionId: string;
    readonly reviewRevisionHash: string;
    readonly planHash: string;
    readonly workSlots: readonly ReviewWorkSlotPlan[];
  }
): ReviewExecutionAdmission {
  const executionId = requireString(result.executionId, 'execution_id');
  const generation = requireDecimal(result.generation, 'execution_generation');
  const executionVersion = requireDecimal(
    result.executionVersion,
    'execution_version'
  );
  const streamVersion = requireDecimal(result.streamVersion, 'stream_version');
  const restoredExecution = parseRestoredExecution(
    result.executionCanonicalJson,
    {
      authorizationId: expected.authorization.authorizationId,
      reviewRevisionHash: expected.reviewRevisionHash,
      maxWorkSlots: expected.authorization.limits.maxWorkSlots,
      streamVersion,
      executionId: expected.executionId,
      planHash: expected.planHash,
      workSlots: expected.workSlots,
    }
  );
  if (
    executionId !== restoredExecution.executionId ||
    generation !== restoredExecution.generation ||
    executionVersion !== restoredExecution.version
  ) {
    throw new Error('review_action_v2_execution_admission_mismatch');
  }
  return {
    executionId,
    generation,
    streamVersion,
    executionVersion,
    restoredExecution,
  };
}

function parseRestoredExecution(
  value: string | null | undefined,
  expected: {
    readonly authorizationId: string;
    readonly reviewRevisionHash: string;
    readonly maxWorkSlots: number;
    readonly streamVersion: string;
    readonly executionId?: string;
    readonly planHash?: string;
    readonly workSlots?: readonly ReviewWorkSlotPlan[];
  }
): RestoredReviewExecution {
  const parsed = parseCanonicalObject(value);
  requireExactKeys(parsed, [
    'authorizationId',
    'executionId',
    'generation',
    'planHash',
    'reviewRevisionHash',
    'state',
    'version',
    'workSlots',
  ]);
  const executionId = requireString(
    parsed.executionId,
    'restored_execution_id'
  );
  const generation = requireDecimal(parsed.generation, 'restored_generation');
  const version = requireDecimal(parsed.version, 'restored_version');
  const authorizationId = requireString(
    parsed.authorizationId,
    'restored_authorization_id'
  );
  const reviewRevisionHash = requireDigest(
    parsed.reviewRevisionHash,
    'restored_review_revision_hash'
  );
  const planHash = requireDigest(parsed.planHash, 'restored_plan_hash');
  const state = parseRestoredExecutionState(parsed.state);
  if (
    authorizationId !== expected.authorizationId ||
    reviewRevisionHash !== expected.reviewRevisionHash ||
    (expected.executionId !== undefined &&
      executionId !== expected.executionId) ||
    (expected.planHash !== undefined && planHash !== expected.planHash)
  ) {
    throw new Error('review_action_v2_restored_execution_scope_mismatch');
  }
  if (
    !Array.isArray(parsed.workSlots) ||
    parsed.workSlots.length > expected.maxWorkSlots
  ) {
    throw new Error('review_action_v2_restored_work_slots_invalid');
  }
  const workSlots = parsed.workSlots.map(parseRestoredWorkSlot);
  if (
    new Set(workSlots.map((slot) => slot.workSlotId)).size !== workSlots.length
  ) {
    throw new Error('review_action_v2_restored_work_slot_duplicate');
  }
  if (expected.workSlots) {
    const expectedById = new Map(
      expected.workSlots.map((slot) => [slot.workSlotId, slot])
    );
    if (
      expectedById.size !== workSlots.length ||
      workSlots.some((slot) => {
        const planned = expectedById.get(slot.workSlotId);
        return (
          !planned ||
          planned.required !== slot.required ||
          planned.providerVoteIdentityHash !== slot.providerVoteIdentityHash
        );
      })
    ) {
      throw new Error('review_action_v2_restored_work_slot_plan_mismatch');
    }
  }
  return Object.freeze({
    executionId,
    version,
    streamVersion: expected.streamVersion,
    generation,
    state,
    authorizationId,
    reviewRevisionHash,
    planHash,
    workSlots: Object.freeze(workSlots),
  });
}

function parseRestoredWorkSlot(value: unknown) {
  if (!isRecord(value)) {
    throw new Error('review_action_v2_restored_work_slot_invalid');
  }
  requireExactKeys(value, [
    'acceptedObservationRefId',
    'activeLeaseId',
    'providerVoteIdentityHash',
    'required',
    'state',
    'workSlotId',
  ]);
  const state = parseRestoredWorkSlotState(value.state);
  const activeLeaseId = requireNullableString(
    value.activeLeaseId,
    'active_lease_id'
  );
  const acceptedObservationRefId = requireNullableString(
    value.acceptedObservationRefId,
    'accepted_observation_ref_id'
  );
  if (
    (state === RestoredReviewWorkSlotState.Leased) !==
      (activeLeaseId !== null) ||
    (state === RestoredReviewWorkSlotState.Satisfied) !==
      (acceptedObservationRefId !== null) ||
    (acceptedObservationRefId !== null &&
      !/^obsref:[a-f0-9]{64}$/.test(acceptedObservationRefId))
  ) {
    throw new Error('review_action_v2_restored_work_slot_state_invalid');
  }
  return Object.freeze({
    workSlotId: requireString(value.workSlotId, 'restored_work_slot_id'),
    state,
    required: requireBoolean(value.required, 'restored_work_slot_required'),
    providerVoteIdentityHash: requireDigest(
      value.providerVoteIdentityHash,
      'restored_provider_vote_identity_hash'
    ),
    activeLeaseId,
    acceptedObservationRefId,
  });
}

function parseRestoredExecutionState(
  value: unknown
): RestoredReviewExecutionState {
  if (
    typeof value !== 'string' ||
    !Object.values(RestoredReviewExecutionState).includes(
      value as RestoredReviewExecutionState
    )
  ) {
    throw new Error('review_action_v2_restored_execution_state_invalid');
  }
  return value as RestoredReviewExecutionState;
}

function parseRestoredWorkSlotState(
  value: unknown
): RestoredReviewWorkSlotState {
  if (
    typeof value !== 'string' ||
    !Object.values(RestoredReviewWorkSlotState).includes(
      value as RestoredReviewWorkSlotState
    )
  ) {
    throw new Error('review_action_v2_restored_work_slot_state_invalid');
  }
  return value as RestoredReviewWorkSlotState;
}

function parseAuthorizationFacts(value: string | undefined) {
  const parsed = parseCanonicalObject(value);
  const providerVoteLanes = parsed.providerVoteLanes;
  if (!Array.isArray(providerVoteLanes) || providerVoteLanes.length === 0) {
    throw new Error('review_action_v2_provider_vote_lanes_invalid');
  }
  const facts = {
    workspaceId: requireString(parsed.workspaceId, 'workspace_id'),
    repositoryConnectionId: requireString(
      parsed.repositoryConnectionId,
      'repository_connection_id'
    ),
    scmRepositoryIdentityId: requireString(
      parsed.scmRepositoryIdentityId,
      'scm_repository_identity_id'
    ),
    pullRequestNumber: requirePositiveInteger(
      parsed.pullRequestNumber,
      'pull_request_number'
    ),
    sourceRunId: requireString(parsed.sourceRunId, 'source_run_id'),
    sourceRunAttempt: requireString(
      parsed.sourceRunAttempt,
      'source_run_attempt'
    ),
    baseSha: requireCommitSha(parsed.baseSha, 'base_sha'),
    mergeBaseSha: requireCommitSha(parsed.mergeBaseSha, 'merge_base_sha'),
    headSha: requireCommitSha(parsed.headSha, 'head_sha'),
    reviewRevisionHash: requireDigest(
      parsed.reviewRevisionHash,
      'review_revision_hash'
    ),
    trustDomain: requireString(parsed.trustDomain, 'trust_domain'),
    producerReleaseId: requireString(
      parsed.producerReleaseId,
      'facts_producer_release_id'
    ),
    selectedProtocolVersion: requireString(
      parsed.selectedProtocolVersion,
      'selected_protocol_version'
    ),
    schemaDigest: requireDigest(parsed.schemaDigest, 'schema_digest'),
    providerVoteLanes: providerVoteLanes.map((value) => {
      if (!isRecord(value)) {
        throw new Error('review_action_v2_provider_vote_lane_invalid');
      }
      const providerKind = requireString(value.providerKind, 'provider_kind');
      if (
        !Object.values(ReviewExecutionProviderKind).includes(
          providerKind as ReviewExecutionProviderKind
        )
      ) {
        throw new Error('review_action_v2_provider_kind_invalid');
      }
      return {
        providerKind: providerKind as ReviewExecutionProviderKind,
        providerVoteIdentityHash: requireDigest(
          value.providerVoteIdentityHash,
          'provider_vote_identity_hash'
        ),
      };
    }),
  };
  const expectedKeys = [
    'baseSha',
    'headSha',
    'mergeBaseSha',
    'producerReleaseId',
    'providerVoteLanes',
    'pullRequestNumber',
    'repositoryConnectionId',
    'reviewRevisionHash',
    'schemaDigest',
    'scmRepositoryIdentityId',
    'selectedProtocolVersion',
    'sourceRunAttempt',
    'sourceRunId',
    'trustDomain',
    'workspaceId',
  ];
  if (Object.keys(parsed).sort().join(',') !== expectedKeys.sort().join(',')) {
    throw new Error('review_action_v2_authorization_facts_fields_invalid');
  }
  return facts;
}

function parseLease(result: {
  readonly leaseId?: string | null;
  readonly attemptId?: string | null;
  readonly leaseCapability?: string | null;
  readonly fencingToken?: string | null;
  readonly expiresAt?: string | null;
  readonly resultReportUntil?: string | null;
}): ReviewInvocationLease {
  return {
    leaseId: requireString(result.leaseId, 'lease_id'),
    attemptId: requireString(result.attemptId, 'attempt_id'),
    leaseCapability: requireString(result.leaseCapability, 'lease_capability'),
    fencingToken: requireDecimal(result.fencingToken, 'fencing_token'),
    expiresAt: requireTimestamp(result.expiresAt, 'lease_expires_at'),
    resultReportUntil: requireTimestamp(
      result.resultReportUntil,
      'result_report_until'
    ),
    renewalCeilingReached: false,
  };
}

function leaseAcquireRejectedOutcome(reason: string | null | undefined): {
  readonly status:
    | ReviewInvocationLeaseAcquireOutcomeStatus.AttemptBudgetExhausted
    | ReviewInvocationLeaseAcquireOutcomeStatus.NotRunnable;
} {
  if (reason === 'attempt_budget_exhausted') {
    return {
      status: ReviewInvocationLeaseAcquireOutcomeStatus.AttemptBudgetExhausted,
    };
  }
  if (reason === 'not_runnable') {
    return { status: ReviewInvocationLeaseAcquireOutcomeStatus.NotRunnable };
  }
  throw new Error(
    `review_action_v2_lease_rejected:${reason ?? 'reason_missing'}`
  );
}

function parseProtocolLimits(value: string | undefined): ReviewProtocolLimits {
  const parsed = parseCanonicalObject(value);
  const keys = [
    'maxAttemptsPerSlot',
    'maxLeaseDurationMs',
    'maxObservationBytes',
    'maxObservationFindings',
    'maxProjectionBytes',
    'maxProjectionFindings',
    'maxPublicationBodyBytes',
    'maxPublicationChunks',
    'maxPublicationOperations',
    'maxReconciliationDurationMs',
    'maxRequestBatchSize',
    'maxResultReportDurationMs',
    'maxWorkSlots',
  ] as const;
  if (Object.keys(parsed).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error('review_action_v2_protocol_limits_fields_invalid');
  }
  return Object.fromEntries(
    keys.map((key) => [key, requirePositiveInteger(parsed[key], key)])
  ) as unknown as ReviewProtocolLimits;
}

function parsePublicationOutcome(value: string | null | undefined) {
  switch (value) {
    case ReviewPublicationState.Succeeded:
      return ReviewPublicationState.Succeeded;
    case 'superseded_no_effect':
    case 'failed_no_effect':
    case ReviewPublicationState.NotApplied:
      return ReviewPublicationState.NotApplied;
    case ReviewPublicationState.StaleCompensated:
      return ReviewPublicationState.StaleCompensated;
    case ReviewPublicationState.StaleVisible:
      return ReviewPublicationState.StaleVisible;
    case ReviewPublicationState.TerminalUnknown:
      return ReviewPublicationState.TerminalUnknown;
    default:
      throw new Error('review_action_v2_publication_outcome_unknown');
  }
}

function parseExactRevisionAttachment(
  capability: string,
  attachmentKind: string | null,
  reuseSafetyDecisionHash: string | null | undefined,
  sourceFacts: AdoptionSourceFacts | null
) {
  if (attachmentKind !== 'exact_revision_reuse' || sourceFacts !== null) {
    throw new Error('review_action_v2_cross_revision_reuse_forbidden');
  }
  return Object.freeze({
    kind: 'exact_revision_reuse' as const,
    capability: requireString(capability, 'attachment_capability'),
    reuseSafetyDecisionHash: requireDigest(
      reuseSafetyDecisionHash,
      'reuse_safety_decision_hash'
    ),
  });
}

function parseSameExecutionAttachment(
  attachmentKind: string | null,
  reuseSafetyDecisionHash: string | null | undefined,
  sourceFacts: AdoptionSourceFacts | null
) {
  if (
    attachmentKind !== null ||
    reuseSafetyDecisionHash != null ||
    sourceFacts === null
  ) {
    throw new Error('review_action_v2_same_execution_attachment_invalid');
  }
  return Object.freeze({ kind: 'same_execution' as const, ...sourceFacts });
}

type AdoptionSourceFacts = Readonly<{
  sourceLeaseId: string;
  sourceFencingToken: string;
  sourceOwnerIdHash: string;
}>;

function parseAdoptionSourceFacts(result: {
  readonly sourceLeaseId?: string | null;
  readonly sourceFencingToken?: string | null;
  readonly sourceOwnerIdHash?: string | null;
}): AdoptionSourceFacts | null {
  const sourceLeaseId = result.sourceLeaseId ?? null;
  const sourceFencingToken = result.sourceFencingToken ?? null;
  const sourceOwnerIdHash = result.sourceOwnerIdHash ?? null;
  if (
    sourceLeaseId === null &&
    sourceFencingToken === null &&
    sourceOwnerIdHash === null
  ) {
    return null;
  }
  return Object.freeze({
    sourceLeaseId: requireString(sourceLeaseId, 'source_lease_id'),
    sourceFencingToken: requireDecimal(
      sourceFencingToken,
      'source_fencing_token'
    ),
    sourceOwnerIdHash: requireDigest(sourceOwnerIdHash, 'source_owner_id_hash'),
  });
}

function adoptionFactsCanonicalJson(
  input: Parameters<ReviewActionV2ControlPlanePort['adoptObservation']>[0]
): string {
  return JSON.stringify(
    canonicalize({
      observationId: input.observation.observationId,
      sourceExecutionId: input.execution.executionId,
      sourceLeaseId: input.source.sourceLeaseId,
      sourceFencingToken: input.source.sourceFencingToken,
      providerInvocationKey: input.observation.providerInvocationKey,
      providerVoteIdentityHash: input.observation.providerVoteIdentityHash,
      manifestKey: input.manifest.manifestKey,
      payloadHash: input.observation.payloadHash,
      byteCount: input.observation.byteCount,
      findingCount: input.observation.findingCount,
      actualModel: input.observation.actualModel,
      qualityFlags: input.observation.qualityFlags,
      transportAttemptCount: input.observation.transportAttemptCount,
      eligibilityPolicyVersion: input.observation.eligibilityPolicyVersion,
      planHash: input.planHash,
      reviewRevisionHash: input.authorization.facts.reviewRevisionHash,
    })
  );
}

function requireMutationApplied(
  status: ReviewExecutionMutationResultStatus,
  operation: string
): void {
  if (
    status !== ReviewExecutionMutationResultStatus.Applied &&
    status !== ReviewExecutionMutationResultStatus.Restored
  ) {
    throw new Error(`review_action_v2_${operation}_${status}`);
  }
}

function isBenignSupersedeTargetRevisionMismatch(error: unknown): boolean {
  return (
    error instanceof ReviewActionV2ClientError &&
    error.operationId === ReviewActionV2OperationId.ReviewExecutionSupersede &&
    error.protocolErrorCode === ReviewActionV2ProtocolErrorCode.Forbidden &&
    error.issues?.includes('target_revision_mismatch') === true
  );
}

function parseCanonicalObject(value: string | null | undefined) {
  if (!value) throw new Error('review_action_v2_canonical_json_missing');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('review_action_v2_canonical_json_invalid', {
      cause: error,
    });
  }
  if (!isRecord(parsed) || JSON.stringify(canonicalize(parsed)) !== value) {
    throw new Error('review_action_v2_canonical_json_invalid');
  }
  return parsed;
}

function requireCanonicalJson(
  value: string | null | undefined,
  field: string
): string {
  if (!value) throw new Error(`review_action_v2_${field}_missing`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`review_action_v2_${field}_invalid`, { cause: error });
  }
  if (JSON.stringify(canonicalize(parsed)) !== value) {
    throw new Error(`review_action_v2_${field}_invalid`);
  }
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`review_action_v2_${field}_missing`);
  }
  return value;
}

function requireNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requireString(value, field);
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`review_action_v2_${field}_invalid`);
  }
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[]
): void {
  if (
    Object.keys(value).sort().join(',') !== [...expectedKeys].sort().join(',')
  ) {
    throw new Error('review_action_v2_canonical_json_fields_invalid');
  }
}

function requireDecimal(value: unknown, field: string): string {
  const parsed = requireString(value, field);
  if (!/^(0|[1-9][0-9]*)$/.test(parsed)) {
    throw new Error(`review_action_v2_${field}_invalid`);
  }
  return parsed;
}

function requireDigest(value: unknown, field: string): string {
  const parsed = requireString(value, field);
  if (!/^[a-f0-9]{64}$/.test(parsed)) {
    throw new Error(`review_action_v2_${field}_invalid`);
  }
  return parsed;
}

function requireCommitSha(value: unknown, field: string): string {
  const parsed = requireString(value, field).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(parsed)) {
    throw new Error(`review_action_v2_${field}_invalid`);
  }
  return parsed;
}

function requireStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`review_action_v2_${field}_invalid`);
  }
  return Object.freeze([...value]);
}

function requireTimestamp(value: unknown, field: string): string {
  const parsed = requireString(value, field);
  if (!Number.isFinite(Date.parse(parsed))) {
    throw new Error(`review_action_v2_${field}_invalid`);
  }
  return parsed;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`review_action_v2_${field}_invalid`);
  }
  return value as number;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`review_action_v2_${field}_invalid`);
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function deterministicIdempotencyKey(
  purpose: string,
  parts: readonly string[]
): string {
  return `rr:${purpose}:${digest(
    JSON.stringify({
      parts,
      purpose,
    })
  )}`;
}
