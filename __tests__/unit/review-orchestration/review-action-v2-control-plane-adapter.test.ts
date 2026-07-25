import { createHash } from 'crypto';
import {
  ReviewActionV2Client,
  ReviewActionV2ClientError,
  ReviewActionV2ClientFailureCode,
} from '../../../src/control-plane/review-action-v2-client';
import {
  ReviewActionV2ProtocolErrorCode,
  ReviewEvidenceLookupResultStatus,
  ReviewEvidenceCommitResultStatus,
  ReviewActionV2OperationId,
  ReviewContextGatewayOpenResultStatus,
  ReviewContextGatewaySealResultStatus,
  ReviewContextReplayCommitResultStatus,
  ReviewExecutionMutationResultStatus,
  ReviewExecutionRestoreResultStatus,
  ReviewExecutionStartResultStatus,
  ReviewInvocationLeaseResultStatus,
  ReviewRunAuthorizationResultStatus,
} from '../../../src/control-plane/generated/review-action-v2/review-action-v2';
import {
  ReviewExecutionProviderKind,
  ReviewEvidenceLookupKind,
  ReviewTaskKind,
  RestoredReviewExecutionState,
  RestoredReviewWorkSlotState,
} from '../../../src/review-orchestration/application';
import { ReviewActionV2ControlPlaneAdapter } from '../../../src/review-orchestration/infrastructure';

describe('ReviewActionV2ControlPlaneAdapter', () => {
  it('normalizes a complete generated authorization and selected limits', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewRunAuthorizationResultStatus.Authorized,
      authorizationId: 'authorization-1',
      authorizationToken: 'authorization.token',
      producerReleaseId: 'release-1',
      protocolLimitsProfileId: 'limits-1',
      operationalSloProfileId: 'slo-1',
      mutationEpoch: '1',
      expiresAt: '2026-07-22T13:00:00.000Z',
      protocolLimitsCanonicalJson: JSON.stringify(protocolLimits),
      authorizationFactsCanonicalJson: canonicalJson(authorizationFacts),
    });
    const adapter = createAdapter(execute);

    await expect(
      adapter.authorize({ oidcToken: 'oidc.token' })
    ).resolves.toEqual(
      expect.objectContaining({
        authorizationId: 'authorization-1',
        limits: protocolLimits,
        facts: authorizationFacts,
      })
    );
  });

  it('opens and seals a target-bound context gateway session', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce(authorizationResponse())
      .mockResolvedValueOnce({
        status: ReviewContextGatewayOpenResultStatus.Opened,
        sessionId: 'session-1',
        eventChainSeedHash: hash('seed'),
        gatewaySessionSecret: Buffer.alloc(32, 1).toString('base64url'),
        sealCapability: 'seal.capability',
        expiresAt: '2026-07-22T12:05:00.000Z',
      })
      .mockResolvedValueOnce({
        status: ReviewContextGatewaySealResultStatus.Accepted,
        attestationId: 'attestation-1',
        attestationHash: hash('attestation'),
      });
    const adapter = createAdapter(execute);
    await adapter.authorize({ oidcToken: 'oidc.token' });

    const session = await adapter.openGatewaySession({
      invocationLease: baseLease,
      sourceExecutionId: execution.executionId,
      sourceWorkSlotId: workSlot.workSlotId,
      sourceReviewRevisionHash: authorization.facts.reviewRevisionHash,
      checkoutTreeOid: '7'.repeat(40),
      gatewayPolicyVersion: 'context-gateway-v2',
      gatewayBinaryHash: hash('gateway'),
      confinementEvidenceHash: hash('confinement'),
    });
    await expect(
      adapter.sealGatewaySession({
        invocationLease: baseLease,
        session,
        providerSucceeded: true,
        schemaValidated: true,
        fullyConsumed: true,
        actualModel: 'gpt-5.6-sol',
        terminalOutcomeHash: hash('outcome'),
        transcriptCanonicalJson: '{"transcriptVersion":1}',
        transcriptHash: hash('{"transcriptVersion":1}'),
        replayMaterialCanonicalJson: '{"replayMaterialVersion":1}',
        replayMaterialHash: hash('{"replayMaterialVersion":1}'),
      })
    ).resolves.toEqual({
      attestationId: 'attestation-1',
      attestationHash: hash('attestation'),
    });
    expect(execute).toHaveBeenNthCalledWith(
      2,
      ReviewActionV2OperationId.ReviewContextGatewayOpen,
      expect.objectContaining({
        leaseCapability: baseLease.leaseCapability,
        sourceExecutionId: execution.executionId,
      })
    );
  });

  it('parses replay-required evidence and commits its target proof', async () => {
    const payloadCanonicalJson = canonicalJson({ findings: [] });
    const replayPlanCanonicalJson = canonicalJson({ planVersion: 1 });
    const execute = jest
      .fn()
      .mockResolvedValueOnce({
        status: ReviewEvidenceLookupResultStatus.ReplayRequired,
        observationId: 'observation-1',
        payloadCanonicalJson,
        payloadHash: hash(payloadCanonicalJson),
        byteCount: Buffer.byteLength(payloadCanonicalJson),
        findingCount: 0,
        actualModel: 'gpt-5.6-sol',
        qualityFlags: [],
        transportAttemptCount: 1,
        eligibilityPolicyVersion: 't2-v1',
        contextDependencyAttestationId: 'attestation-1',
        contextDependencyAttestationHash: hash('attestation'),
        contextReplayCapability: 'replay.capability',
        contextReplayPlanCanonicalJson: replayPlanCanonicalJson,
        contextReplayPlanHash: hash(replayPlanCanonicalJson),
      })
      .mockResolvedValueOnce({
        status: ReviewContextReplayCommitResultStatus.Accepted,
        replayProofId: 'proof-1',
        replayProofHash: hash('proof'),
        attachmentCapability: 'attachment.capability',
      });
    const adapter = createAdapter(execute);
    const candidate = await adapter.lookupEvidence({
      authorization,
      execution,
      workSlot,
      planHash: execution.restoredExecution.planHash,
      manifest: providerManifest,
    });
    expect(candidate).toMatchObject({
      kind: ReviewEvidenceLookupKind.ReplayRequired,
      attestationId: 'attestation-1',
      replayPlanHash: hash(replayPlanCanonicalJson),
    });
    if (candidate.kind !== ReviewEvidenceLookupKind.ReplayRequired) {
      throw new Error('expected replay candidate');
    }

    await expect(
      adapter.commitContextReplay({
        authorization,
        execution,
        workSlot,
        candidate,
        result: {
          targetCheckoutTreeOid: '8'.repeat(40),
          replayResultCanonicalJson: '{"manifestVersion":2}',
          replayResultHash: hash('{"manifestVersion":2}'),
        },
      })
    ).resolves.toEqual({
      attachmentCapability: 'attachment.capability',
    });
  });

  it('uses the generated execution version needed by finalize', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewExecutionStartResultStatus.Admitted,
      executionId: 'execution-1',
      generation: '1',
      streamVersion: '1',
      executionVersion: '2',
      executionCanonicalJson: canonicalExecution({ version: '2' }),
    });
    const adapter = createAdapter(execute);

    await expect(adapter.startExecution(startInput)).resolves.toEqual(
      expect.objectContaining({
        executionId: 'execution-1',
        generation: '1',
        streamVersion: '1',
        executionVersion: '2',
        restoredExecution: expect.objectContaining({
          planHash: startInput.planHash,
          workSlots: [expect.objectContaining({ workSlotId: 'slot-1' })],
        }),
      })
    );
  });

  it('consumes a lookup hit payload and its attachment capability', async () => {
    const payloadCanonicalJson = canonicalJson({ findings: [] });
    const execute = jest.fn().mockResolvedValue({
      status: ReviewEvidenceLookupResultStatus.Hit,
      observationId: 'observation-1',
      payloadCanonicalJson,
      payloadHash: hash(payloadCanonicalJson),
      byteCount: Buffer.byteLength(payloadCanonicalJson),
      findingCount: 0,
      actualModel: 'gpt-test',
      qualityFlags: [],
      transportAttemptCount: 1,
      attachmentCapability: 'attachment.capability',
      attachmentKind: 'exact_revision_reuse',
      reuseSafetyDecisionHash: hash('reuse-safety'),
      eligibilityPolicyVersion: 't0-v1',
    });
    const adapter = createAdapter(execute);

    await expect(
      adapter.lookupEvidence({
        authorization,
        execution,
        workSlot,
        planHash: '2'.repeat(64),
        manifest: {
          manifestCanonicalJson: '{"fixture":true}',
          manifestKey: '3'.repeat(64),
          providerInvocationKey: '4'.repeat(64),
          providerVoteIdentityHash: workSlot.providerVoteIdentityHash,
        },
      })
    ).resolves.toEqual(
      expect.objectContaining({
        kind: ReviewEvidenceLookupKind.Hit,
        attachment: expect.objectContaining({
          kind: 'exact_revision_reuse',
          capability: 'attachment.capability',
        }),
        observation: expect.objectContaining({
          payloadCanonicalJson,
          payloadHash: hash(payloadCanonicalJson),
        }),
      })
    );
  });

  it('turns a fenced same-execution shadow into adoptable evidence', async () => {
    const payloadCanonicalJson = canonicalJson({ findings: [] });
    const execute = jest.fn().mockResolvedValue({
      status: ReviewEvidenceLookupResultStatus.Shadow,
      observationId: 'observation-1',
      payloadCanonicalJson,
      payloadHash: hash(payloadCanonicalJson),
      byteCount: Buffer.byteLength(payloadCanonicalJson),
      findingCount: 0,
      actualModel: 'gpt-test',
      qualityFlags: [],
      transportAttemptCount: 1,
      attachmentCapability: null,
      attachmentKind: null,
      reuseSafetyDecisionHash: null,
      eligibilityPolicyVersion: 't0-v1',
      sourceLeaseId: baseLease.leaseId,
      sourceFencingToken: baseLease.fencingToken,
      sourceOwnerIdHash: hash('owner'),
    });

    await expect(
      createAdapter(execute).lookupEvidence({
        authorization,
        execution,
        workSlot,
        planHash: execution.restoredExecution.planHash,
        manifest: providerManifest,
      })
    ).resolves.toMatchObject({
      kind: ReviewEvidenceLookupKind.Hit,
      attachment: {
        kind: 'same_execution',
        sourceLeaseId: baseLease.leaseId,
        sourceFencingToken: baseLease.fencingToken,
        sourceOwnerIdHash: hash('owner'),
      },
    });
  });

  it('rejects a partial same-execution adoption source tuple', async () => {
    const payloadCanonicalJson = canonicalJson({ findings: [] });
    const execute = jest.fn().mockResolvedValue({
      status: ReviewEvidenceLookupResultStatus.Shadow,
      observationId: 'observation-1',
      payloadCanonicalJson,
      payloadHash: hash(payloadCanonicalJson),
      byteCount: Buffer.byteLength(payloadCanonicalJson),
      findingCount: 0,
      actualModel: 'gpt-test',
      qualityFlags: [],
      transportAttemptCount: 1,
      eligibilityPolicyVersion: 't0-v1',
      sourceLeaseId: baseLease.leaseId,
      sourceFencingToken: null,
      sourceOwnerIdHash: hash('owner'),
    });

    await expect(
      createAdapter(execute).lookupEvidence({
        authorization,
        execution,
        workSlot,
        planHash: execution.restoredExecution.planHash,
        manifest: providerManifest,
      })
    ).rejects.toThrow('review_action_v2_source_fencing_token_missing');
  });

  it('restores a bounded exact-revision execution instead of dropping it', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewExecutionRestoreResultStatus.Found,
      executionId: 'execution-1',
      generation: '1',
      streamVersion: '1',
      executionState: RestoredReviewExecutionState.Running,
      executionCanonicalJson: canonicalExecution(),
    });
    const adapter = createAdapter(execute);

    await expect(
      adapter.restoreExecution({
        authorization,
        reviewRevisionHash: startInput.reviewRevisionHash,
      })
    ).resolves.toMatchObject({
      executionId: 'execution-1',
      reviewRevisionHash: startInput.reviewRevisionHash,
      planHash: startInput.planHash,
    });
  });

  it('rejects restored slot and observation identity drift', async () => {
    const malformed = JSON.parse(canonicalExecution()) as Record<
      string,
      unknown
    >;
    malformed.workSlots = [
      {
        acceptedObservationRefId: 'observation-1',
        activeLeaseId: null,
        providerVoteIdentityHash: workSlot.providerVoteIdentityHash,
        required: true,
        state: RestoredReviewWorkSlotState.Satisfied,
        workSlotId: workSlot.workSlotId,
      },
    ];
    const execute = jest.fn().mockResolvedValue({
      status: ReviewExecutionStartResultStatus.Restored,
      executionId: 'execution-1',
      generation: '1',
      streamVersion: '2',
      executionVersion: '1',
      executionCanonicalJson: canonicalJson(malformed),
    });

    await expect(
      createAdapter(execute).startExecution(startInput)
    ).rejects.toThrow('review_action_v2_restored_work_slot_state_invalid');
  });

  it('preserves the lease identity and accepts the rotated capability', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewInvocationLeaseResultStatus.Applied,
      leaseId: baseLease.leaseId,
      fencingToken: baseLease.fencingToken,
      expiresAt: '2026-07-22T12:11:00.000Z',
      leaseCapability: 'lease.capability.renewed',
    });

    await expect(
      createAdapter(execute).renewInvocationLease({
        idempotencyKey: 'idem:renew:1',
        lease: baseLease,
        ownerIdHash: hash('owner'),
        renewRequestId: 'renew-1',
      })
    ).resolves.toEqual({
      ...baseLease,
      leaseCapability: 'lease.capability.renewed',
      expiresAt: '2026-07-22T12:11:00.000Z',
    });
  });

  it('accepts an idempotent renewal at the fixed lease ceiling', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewInvocationLeaseResultStatus.Restored,
      leaseId: baseLease.leaseId,
      fencingToken: baseLease.fencingToken,
      expiresAt: baseLease.expiresAt,
      leaseCapability: baseLease.leaseCapability,
    });

    await expect(
      createAdapter(execute).renewInvocationLease({
        idempotencyKey: 'idem:renew:ceiling',
        lease: baseLease,
        ownerIdHash: hash('owner'),
        renewRequestId: 'renew-ceiling',
      })
    ).resolves.toEqual({
      ...baseLease,
      renewalCeilingReached: true,
    });
  });

  it('recovers a lost renewal acknowledgement that advanced the lease', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewInvocationLeaseResultStatus.Restored,
      leaseId: baseLease.leaseId,
      fencingToken: baseLease.fencingToken,
      expiresAt: '2026-07-22T12:11:00.000Z',
      leaseCapability: 'lease.capability.recovered',
    });

    await expect(
      createAdapter(execute).renewInvocationLease({
        idempotencyKey: 'idem:renew:recovered',
        lease: baseLease,
        ownerIdHash: hash('owner'),
        renewRequestId: 'renew-recovered',
      })
    ).resolves.toEqual({
      ...baseLease,
      leaseCapability: 'lease.capability.recovered',
      expiresAt: '2026-07-22T12:11:00.000Z',
      renewalCeilingReached: false,
    });
  });

  it('rejects an acquire response on the renewal operation', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewInvocationLeaseResultStatus.Acquired,
      leaseId: baseLease.leaseId,
      fencingToken: baseLease.fencingToken,
      expiresAt: '2026-07-22T12:11:00.000Z',
      leaseCapability: 'lease.capability.renewed',
    });

    await expect(
      createAdapter(execute).renewInvocationLease({
        idempotencyKey: 'idem:renew:acquired',
        lease: baseLease,
        ownerIdHash: hash('owner'),
        renewRequestId: 'renew-acquired',
      })
    ).rejects.toThrow('review_action_v2_lease_renew_acquired');
  });

  it('requires a rotated capability when renewal is applied', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewInvocationLeaseResultStatus.Applied,
      leaseId: baseLease.leaseId,
      fencingToken: baseLease.fencingToken,
      expiresAt: '2026-07-22T12:11:00.000Z',
      leaseCapability: baseLease.leaseCapability,
    });

    await expect(
      createAdapter(execute).renewInvocationLease({
        idempotencyKey: 'idem:renew:not-rotated',
        lease: baseLease,
        ownerIdHash: hash('owner'),
        renewRequestId: 'renew-not-rotated',
      })
    ).rejects.toThrow('review_action_v2_lease_renewal_drift');
  });

  it('rejects renewal without a replacement capability', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewInvocationLeaseResultStatus.Applied,
      leaseId: baseLease.leaseId,
      fencingToken: baseLease.fencingToken,
      expiresAt: '2026-07-22T12:11:00.000Z',
    });

    await expect(
      createAdapter(execute).renewInvocationLease({
        idempotencyKey: 'idem:renew:1',
        lease: baseLease,
        ownerIdHash: hash('owner'),
        renewRequestId: 'renew-1',
      })
    ).rejects.toThrow('review_action_v2_lease_renew_capability_missing');
  });

  it('rejects a changed fencing term as takeover, not renewal', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewInvocationLeaseResultStatus.Applied,
      leaseId: baseLease.leaseId,
      fencingToken: '2',
      expiresAt: '2026-07-22T12:11:00.000Z',
      leaseCapability: 'lease.capability.renewed',
    });

    await expect(
      createAdapter(execute).renewInvocationLease({
        idempotencyKey: 'idem:renew:1',
        lease: baseLease,
        ownerIdHash: hash('owner'),
        renewRequestId: 'renew-1',
      })
    ).rejects.toThrow('review_action_v2_lease_renewal_drift');
  });

  it('treats an omitted historicalOnly flag on a fresh commit as current', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewEvidenceCommitResultStatus.Accepted,
      observationId: 'observation-1',
      eligibilityPolicyVersion: 't0-v1',
    });
    const adapter = createAdapter(execute);

    await expect(
      adapter.commitEvidence({
        authorization,
        idempotencyKey: 'idem:commit:1',
        lease: {
          leaseId: 'lease-1',
          attemptId: 'attempt-1',
          leaseCapability: 'lease.capability',
          fencingToken: '1',
          expiresAt: '2026-07-22T12:10:00.000Z',
          resultReportUntil: '2026-07-22T12:20:00.000Z',
          renewalCeilingReached: false,
        },
        ownerIdHash: '7'.repeat(64),
        observation: {
          payloadCanonicalJson: '{"findings":[]}',
          payloadHash: hash('{"findings":[]}'),
          byteCount: 15,
          findingCount: 0,
          actualModel: 'gpt-test',
          qualityFlags: [],
          transportAttemptCount: 1,
          schemaValidated: true,
          fullyConsumed: true,
        },
      })
    ).resolves.toMatchObject({ historicalOnly: false });
    expect(execute).toHaveBeenCalledWith(
      ReviewActionV2OperationId.ReviewEvidenceCommit,
      expect.objectContaining({
        completionStatus: 'success',
        contextDependencyAttestationId: null,
        contextDependencyAttestationHash: null,
      })
    );
  });

  it('commits the context attestation identity as an exact pair', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewEvidenceCommitResultStatus.Accepted,
      observationId: 'observation-1',
      eligibilityPolicyVersion: 't0-v1',
    });
    const attestationId = 'attestation-1';
    const attestationHash = hash('attestation');

    await createAdapter(execute).commitEvidence({
      authorization,
      idempotencyKey: 'idem:commit:attested',
      lease: baseLease,
      ownerIdHash: hash('owner'),
      observation: {
        payloadCanonicalJson: '{"findings":[]}',
        payloadHash: hash('{"findings":[]}'),
        byteCount: 15,
        findingCount: 0,
        actualModel: 'gpt-test',
        qualityFlags: [],
        transportAttemptCount: 1,
        schemaValidated: true,
        fullyConsumed: true,
        contextDependencyAttestationId: attestationId,
        contextDependencyAttestationHash: attestationHash,
      },
    });

    expect(execute).toHaveBeenCalledWith(
      ReviewActionV2OperationId.ReviewEvidenceCommit,
      expect.objectContaining({
        contextDependencyAttestationId: attestationId,
        contextDependencyAttestationHash: attestationHash,
      })
    );
  });

  it('translates evidence protocol failures into safe actionable codes', async () => {
    const execute = jest.fn().mockRejectedValue(
      new ReviewActionV2ClientError(
        ReviewActionV2ClientFailureCode.ProtocolError,
        ReviewActionV2OperationId.ReviewEvidenceCommit,
        {
          httpStatus: 422,
          protocolErrorCode: ReviewActionV2ProtocolErrorCode.InvalidRequest,
          issues: ['payload_hash_mismatch'],
        }
      )
    );

    await expect(
      createAdapter(execute).commitEvidence({
        authorization,
        idempotencyKey: 'idem:commit:diagnostic',
        lease: baseLease,
        ownerIdHash: hash('owner'),
        observation: {
          payloadCanonicalJson: '{"findings":[]}',
          payloadHash: hash('{"findings":[]}'),
          byteCount: 15,
          findingCount: 0,
          actualModel: 'gpt-test',
          qualityFlags: [],
          transportAttemptCount: 1,
          schemaValidated: true,
          fullyConsumed: true,
        },
      })
    ).rejects.toThrow(
      'review_action_v2:review_evidence_commit:invalid_request:payload_hash_mismatch'
    );
  });

  it('adopts same-execution evidence with exact source and response identities', async () => {
    const observation = acceptedObservation();
    const source = {
      sourceLeaseId: baseLease.leaseId,
      sourceFencingToken: baseLease.fencingToken,
      sourceOwnerIdHash: hash('owner'),
    };
    const facts = canonicalJson({
      observationId: observation.observationId,
      sourceExecutionId: execution.executionId,
      sourceLeaseId: source.sourceLeaseId,
      sourceFencingToken: source.sourceFencingToken,
      providerInvocationKey: observation.providerInvocationKey,
      providerVoteIdentityHash: observation.providerVoteIdentityHash,
      manifestKey: providerManifest.manifestKey,
      payloadHash: observation.payloadHash,
      byteCount: observation.byteCount,
      findingCount: observation.findingCount,
      actualModel: observation.actualModel,
      qualityFlags: observation.qualityFlags,
      transportAttemptCount: observation.transportAttemptCount,
      eligibilityPolicyVersion: observation.eligibilityPolicyVersion,
      planHash: execution.restoredExecution.planHash,
      reviewRevisionHash: authorization.facts.reviewRevisionHash,
    });
    const execute = jest.fn().mockResolvedValue({
      status: ReviewExecutionMutationResultStatus.Applied,
      executionId: execution.executionId,
      workSlotId: workSlot.workSlotId,
      streamVersion: '2',
      observationPayloadCanonicalJson: observation.payloadCanonicalJson,
      observationFactsCanonicalJson: facts,
    });
    const adapter = createAdapter(execute);

    await expect(
      adapter.adoptObservation({
        authorization,
        idempotencyKey: 'idem:adopt:1',
        execution,
        workSlot,
        planHash: execution.restoredExecution.planHash,
        manifest: providerManifest,
        observation,
        source,
      })
    ).resolves.toEqual({ streamVersion: '2' });
    expect(execute).toHaveBeenCalledWith(
      ReviewActionV2OperationId.ReviewExecutionObservationAdopt,
      expect.objectContaining({
        executionGeneration: execution.generation,
        expectedStreamVersion: execution.streamVersion,
        expectedExecutionVersion: execution.executionVersion,
        sourceLeaseId: source.sourceLeaseId,
        sourceFencingToken: source.sourceFencingToken,
        ownerIdHash: source.sourceOwnerIdHash,
      })
    );
  });
});

function createAdapter(execute: jest.Mock) {
  return new ReviewActionV2ControlPlaneAdapter({
    execute,
  } as unknown as ReviewActionV2Client);
}

function authorizationResponse() {
  return {
    status: ReviewRunAuthorizationResultStatus.Authorized,
    authorizationId: authorization.authorizationId,
    authorizationToken: authorization.authorizationToken,
    producerReleaseId: authorization.producerReleaseId,
    protocolLimitsProfileId: authorization.protocolLimitsProfileId,
    operationalSloProfileId: authorization.operationalSloProfileId,
    mutationEpoch: authorization.mutationEpoch,
    expiresAt: authorization.expiresAt,
    protocolLimitsCanonicalJson: JSON.stringify(protocolLimits),
    authorizationFactsCanonicalJson: canonicalJson(authorizationFacts),
  };
}

const protocolLimits = {
  maxAttemptsPerSlot: 3,
  maxLeaseDurationMs: 60_000,
  maxObservationBytes: 100_000,
  maxObservationFindings: 100,
  maxProjectionBytes: 200_000,
  maxProjectionFindings: 100,
  maxPublicationBodyBytes: 200_000,
  maxPublicationChunks: 20,
  maxPublicationOperations: 100,
  maxReconciliationDurationMs: 60_000,
  maxRequestBatchSize: 20,
  maxResultReportDurationMs: 60_000,
  maxWorkSlots: 10,
};

const authorizationFacts = {
  workspaceId: 'workspace-1',
  repositoryConnectionId: 'connection-1',
  scmRepositoryIdentityId: 'repository-1',
  pullRequestNumber: 252,
  sourceRunId: 'run-1',
  sourceRunAttempt: '1',
  baseSha: '1'.repeat(40),
  mergeBaseSha: '2'.repeat(40),
  headSha: '3'.repeat(40),
  reviewRevisionHash: '4'.repeat(64),
  trustDomain: 'github-actions',
  producerReleaseId: 'release-1',
  selectedProtocolVersion: 'review-action-v2',
  schemaDigest: '5'.repeat(64),
  providerVoteLanes: [
    {
      providerKind: ReviewExecutionProviderKind.Codex,
      providerVoteIdentityHash: '6'.repeat(64),
    },
  ],
};

const authorization = {
  authorizationId: 'authorization-1',
  authorizationToken: 'authorization.token',
  producerReleaseId: 'release-1',
  protocolLimitsProfileId: 'limits-1',
  operationalSloProfileId: 'slo-1',
  mutationEpoch: '1',
  expiresAt: '2026-07-22T13:00:00.000Z',
  limits: protocolLimits,
  facts: authorizationFacts,
};

const execution = {
  executionId: 'execution-1',
  generation: '1',
  streamVersion: '1',
  executionVersion: '1',
  restoredExecution: {
    executionId: 'execution-1',
    version: '1',
    streamVersion: '1',
    generation: '1',
    state: RestoredReviewExecutionState.Running,
    authorizationId: authorization.authorizationId,
    reviewRevisionHash: authorization.facts.reviewRevisionHash,
    planHash: '2'.repeat(64),
    workSlots: [
      {
        workSlotId: 'slot-1',
        state: RestoredReviewWorkSlotState.Pending,
        required: true,
        providerVoteIdentityHash: '5'.repeat(64),
        activeLeaseId: null,
        acceptedObservationRefId: null,
      },
    ],
  },
};

const workSlot = {
  workSlotId: 'slot-1',
  taskKind: ReviewTaskKind.FindingDiscovery,
  providerKind: ReviewExecutionProviderKind.Codex,
  providerVoteIdentityHash: '5'.repeat(64),
  shardKey: 'batch-1',
  required: true,
  attemptBudget: 1,
  retryPolicyVersion: 'retry-v1',
};

const providerManifest = {
  manifestCanonicalJson: '{"fixture":true}',
  manifestKey: '3'.repeat(64),
  providerInvocationKey: '4'.repeat(64),
  providerVoteIdentityHash: workSlot.providerVoteIdentityHash,
};

const baseLease = {
  leaseId: 'lease-1',
  attemptId: 'attempt-1',
  leaseCapability: 'lease.capability',
  fencingToken: '1',
  expiresAt: '2026-07-22T12:10:00.000Z',
  resultReportUntil: '2026-07-22T12:20:00.000Z',
  renewalCeilingReached: false,
};

const startInput = {
  authorization,
  idempotencyKey: 'idem:start:1',
  executionId: 'execution-1',
  reviewRevisionHash: '1'.repeat(64),
  compatibilityKey: '2'.repeat(64),
  planHash: '3'.repeat(64),
  workSlotsCanonicalJson: '[]',
  workSlots: [workSlot],
  sourceRunId: 'run-1',
  sourceRunAttempt: '1',
};

function acceptedObservation() {
  const payloadCanonicalJson = canonicalJson({ findings: [] });
  return {
    observationId: 'observation-1',
    payloadCanonicalJson,
    payloadHash: hash(payloadCanonicalJson),
    byteCount: Buffer.byteLength(payloadCanonicalJson),
    findingCount: 0,
    actualModel: 'gpt-test',
    qualityFlags: [] as readonly string[],
    transportAttemptCount: 1,
    schemaValidated: true,
    fullyConsumed: true,
    eligibilityPolicyVersion: 't0-v1',
    providerKind: ReviewExecutionProviderKind.Codex,
    providerInvocationKey: providerManifest.providerInvocationKey,
    providerVoteIdentityHash: providerManifest.providerVoteIdentityHash,
  };
}

function canonicalExecution(overrides: { version?: string } = {}) {
  return canonicalJson({
    authorizationId: authorization.authorizationId,
    executionId: startInput.executionId,
    generation: '1',
    planHash: startInput.planHash,
    reviewRevisionHash: startInput.reviewRevisionHash,
    state: RestoredReviewExecutionState.Running,
    version: overrides.version ?? '1',
    workSlots: [
      {
        acceptedObservationRefId: null,
        activeLeaseId: null,
        providerVoteIdentityHash: workSlot.providerVoteIdentityHash,
        required: workSlot.required,
        state: RestoredReviewWorkSlotState.Pending,
        workSlotId: workSlot.workSlotId,
      },
    ],
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
