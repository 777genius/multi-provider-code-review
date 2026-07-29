import { createHash } from 'crypto';
import {
  ReviewEvidenceLookupKind,
  ReviewContextInspectionFailureReason,
  ReviewExecutionProviderKind,
  ReviewInvocationFailureClass,
  ReviewInvocationLeaseAcquireOutcomeStatus,
  ReviewOrchestrationResultStatus,
  ReviewPublicationRequestOutcomeStatus,
  ReviewPublicationState,
  RestoredReviewExecutionState,
  RestoredReviewWorkSlotState,
  ReviewTaskKind,
  RetryableReviewContextInspectionFailure,
  RunT0ReviewOrchestration,
  canonicalizeReviewWorkSlots,
  type ReviewActionV2ControlPlanePort,
  type ReviewOrchestrationDelayPort,
  type ReviewOrchestrationIdentityPort,
  type ReviewRunAuthorization,
  type ReviewWorkSlotPlan,
  type RunT0ReviewOrchestrationCommand,
  type RunT0ReviewOrchestrationDependencies,
} from '../../../src/review-orchestration/application';
import {
  createReviewPromptCoverageManifest,
  ReviewOrchestrationPhase,
  ReviewPromptPathCoverageKind,
} from '../../../src/review-orchestration/domain';

describe('RunT0ReviewOrchestration', () => {
  it('completes a fresh exact-revision observation and publication', async () => {
    const fixture = createFixture();

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Completed,
      executionId: 'execution-1',
      publicationAttemptId: 'publication-1',
      canonicalReceiptSetHash: hash('receipt'),
    });
    expect(result.state.phase).toBe(ReviewOrchestrationPhase.Completed);
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(
      jest.mocked(fixture.dependencies.invocations.execute).mock.calls[0][0]
        .invocation
    ).toBe(
      await jest.mocked(fixture.dependencies.invocations.prepare).mock
        .results[0].value
    );
    expect(fixture.controlPlane.commitEvidence).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.attachObservation).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.attachObservation).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentCapability: lease.leaseCapability })
    );
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
      1
    );
    expect(
      fixture.dependencies.identities.deterministicId
    ).toHaveBeenCalledWith('idempotency-lease-acquire', [
      'execution-1',
      'slot-1',
      expect.any(String),
    ]);
    expect(
      fixture.dependencies.identities.deterministicId
    ).toHaveBeenCalledWith('idempotency-publication', [
      'publication.permit',
      projection.projectionHash,
    ]);
  });

  it('treats publication request conflicts as not applied instead of failing the run', async () => {
    const fixture = createFixture();
    fixture.controlPlane.requestPublication.mockResolvedValue({
      status: ReviewPublicationRequestOutcomeStatus.Conflict,
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.PublicationNotApplied,
      executionId: 'execution-1',
      failureCode: 'publication_request_conflict',
    });
    expect(result.state.phase).toBe(ReviewOrchestrationPhase.Completed);
    expect(fixture.controlPlane.readPublicationStatus).not.toHaveBeenCalled();
  });

  it('treats stale publication requests as safely not applied', async () => {
    const fixture = createFixture();
    fixture.controlPlane.requestPublication.mockResolvedValue({
      status: ReviewPublicationRequestOutcomeStatus.Stale,
      reason: 'lifecycle_status_not_current',
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.PublicationStale,
      executionId: 'execution-1',
      failureCode: 'publication_request_lifecycle_status_not_current',
    });
    expect(result.state.phase).toBe(ReviewOrchestrationPhase.Completed);
    expect(fixture.controlPlane.readPublicationStatus).not.toHaveBeenCalled();
  });

  it('refreshes the server execution version immediately before finalize', async () => {
    const fixture = createFixture();
    const latest = restoredAdmission(fixture.command, {
      state: RestoredReviewWorkSlotState.Satisfied,
      acceptedObservationRefId: observationRef(
        'execution-1',
        'slot-1',
        acceptedObservation.observationId
      ),
    }).restoredExecution;
    fixture.controlPlane.restoreExecution
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ ...latest, version: '7', streamVersion: '2' });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: expect.objectContaining({ executionVersion: '7' }),
      })
    );
  });

  it('uses an eligible T0 observation without invoking the provider', async () => {
    const fixture = createFixture();
    fixture.controlPlane.lookupEvidence.mockResolvedValue({
      kind: ReviewEvidenceLookupKind.Hit,
      observation: acceptedObservation,
      attachment: {
        kind: 'exact_revision_reuse',
        capability: 'adoption.capability',
        reuseSafetyDecisionHash: hash('reuse-safety'),
      },
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    expect(fixture.controlPlane.acquireInvocationLease).not.toHaveBeenCalled();
    expect(fixture.controlPlane.attachObservation).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentCapability: 'adoption.capability' })
    );
  });

  it('reuses evidence completed by the incumbent while waiting for its lease', async () => {
    const fixture = createFixture();
    fixture.controlPlane.lookupEvidence
      .mockResolvedValueOnce({ kind: ReviewEvidenceLookupKind.Miss })
      .mockResolvedValueOnce({
        kind: ReviewEvidenceLookupKind.Hit,
        observation: acceptedObservation,
        attachment: {
          kind: 'exact_revision_reuse',
          capability: 'incumbent.attachment.capability',
          reuseSafetyDecisionHash: hash('incumbent-reuse-safety'),
        },
      });
    fixture.controlPlane.acquireInvocationLease.mockResolvedValueOnce({
      status: ReviewInvocationLeaseAcquireOutcomeStatus.Busy,
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.dependencies.invocations.prepare).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    expect(fixture.controlPlane.acquireInvocationLease).toHaveBeenCalledTimes(
      1
    );
    expect(fixture.controlPlane.lookupEvidence).toHaveBeenCalledTimes(2);
    expect(fixture.controlPlane.attachObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentCapability: 'incumbent.attachment.capability',
      })
    );
  });

  it('replays dependency-attested evidence before cross-revision attachment', async () => {
    const fixture = createFixture();
    const attestedObservation = {
      ...acceptedObservation,
      contextDependencyAttestationId: 'attestation-1',
      contextDependencyAttestationHash: hash('attestation'),
    };
    const replayPlanCanonicalJson = '{"planVersion":1}';
    fixture.controlPlane.lookupEvidence.mockResolvedValue({
      kind: ReviewEvidenceLookupKind.ReplayRequired,
      observation: attestedObservation,
      attestationId: 'attestation-1',
      attestationHash: hash('attestation'),
      replayCapability: 'replay.capability',
      replayPlanCanonicalJson,
      replayPlanHash: hash(replayPlanCanonicalJson),
    });
    const contextReplay = {
      replay: jest.fn().mockResolvedValue({
        targetCheckoutTreeOid: '4'.repeat(40),
        replayResultCanonicalJson: '{"manifestVersion":2}',
        replayResultHash: hash('{"manifestVersion":2}'),
      }),
    };
    const contextAttestations = {
      openGatewaySession: jest.fn(),
      sealGatewaySession: jest.fn(),
      commitContextReplay: jest.fn().mockResolvedValue({
        attachmentCapability: 'replayed.attachment.capability',
      }),
    };
    Object.assign(fixture.dependencies, {
      contextReplay,
      contextAttestations,
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(contextReplay.replay).toHaveBeenCalledTimes(1);
    expect(contextAttestations.commitContextReplay).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    expect(fixture.controlPlane.acquireInvocationLease).not.toHaveBeenCalled();
    expect(fixture.controlPlane.attachObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: attestedObservation,
        attachmentCapability: 'replayed.attachment.capability',
      })
    );
  });

  it('restores an already satisfied slot without rerunning or reattaching it', async () => {
    const fixture = createFixture();
    fixture.controlPlane.lookupEvidence.mockResolvedValue({
      kind: ReviewEvidenceLookupKind.Hit,
      observation: acceptedObservation,
      attachment: sameExecutionAttachment,
    });
    fixture.controlPlane.startExecution.mockResolvedValue(
      restoredAdmission(fixture.command, {
        state: RestoredReviewWorkSlotState.Satisfied,
        acceptedObservationRefId: observationRef(
          'execution-1',
          'slot-1',
          acceptedObservation.observationId
        ),
      })
    );

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    expect(fixture.controlPlane.acquireInvocationLease).not.toHaveBeenCalled();
    expect(fixture.controlPlane.attachObservation).not.toHaveBeenCalled();
    expect(fixture.dependencies.projectionBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({
        acceptedEvidence: [
          expect.objectContaining({
            workSlotId: 'slot-1',
            observation: acceptedObservation,
            coverageManifest: expect.objectContaining({
              workSlotId: 'slot-1',
            }),
          }),
        ],
      })
    );
  });

  it('rejects a restored observation with the wrong identity', async () => {
    const fixture = createFixture();
    fixture.controlPlane.lookupEvidence.mockResolvedValue({
      kind: ReviewEvidenceLookupKind.Hit,
      observation: acceptedObservation,
      attachment: sameExecutionAttachment,
    });
    fixture.controlPlane.startExecution.mockResolvedValue(
      restoredAdmission(fixture.command, {
        state: RestoredReviewWorkSlotState.Satisfied,
        acceptedObservationRefId: `obsref:${hash('different-observation')}`,
      })
    );

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode:
        'review_orchestration_restored_observation_identity_mismatch',
    });
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
  });

  it('does not rerun a restored exhausted slot', async () => {
    const fixture = createFixture();
    fixture.controlPlane.startExecution.mockResolvedValue(
      restoredAdmission(fixture.command, {
        state: RestoredReviewWorkSlotState.Exhausted,
        acceptedObservationRefId: null,
      })
    );

    const result = await fixture.useCase.execute({
      ...fixture.command,
      allowPartial: true,
    });

    expect(result.status).toBe(
      ReviewOrchestrationResultStatus.PartialCompleted
    );
    expect(fixture.dependencies.invocations.prepare).not.toHaveBeenCalled();
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
  });

  it('adopts same-execution evidence without rerunning the provider', async () => {
    const fixture = createFixture();
    const pending = restoredAdmission(fixture.command, {
      state: RestoredReviewWorkSlotState.Pending,
      acceptedObservationRefId: null,
    }).restoredExecution;
    const satisfied = restoredAdmission(fixture.command, {
      state: RestoredReviewWorkSlotState.Satisfied,
      acceptedObservationRefId: observationRef(
        'execution-1',
        'slot-1',
        acceptedObservation.observationId
      ),
    }).restoredExecution;
    fixture.controlPlane.restoreExecution
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce({
        ...satisfied,
        version: '2',
        streamVersion: '2',
      });
    fixture.controlPlane.lookupEvidence.mockResolvedValue({
      kind: ReviewEvidenceLookupKind.Hit,
      observation: acceptedObservation,
      attachment: sameExecutionAttachment,
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    expect(fixture.controlPlane.acquireInvocationLease).not.toHaveBeenCalled();
    expect(fixture.controlPlane.adoptObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: acceptedObservation,
        source: sameExecutionAttachment,
      })
    );
    expect(fixture.controlPlane.attachObservation).not.toHaveBeenCalled();
  });

  it('retries only provider execution under a new attempt', async () => {
    const fixture = createFixture({ maxAttempts: 2 });
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockRejectedValueOnce(new Error('provider_failed'))
      .mockResolvedValueOnce(observationPayload);

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.dependencies.invocations.prepare).toHaveBeenNthCalledWith(
      1,
      {
        workSlot: fixture.command.workSlots[0],
        attemptOrdinal: 1,
      }
    );
    expect(fixture.dependencies.invocations.prepare).toHaveBeenNthCalledWith(
      2,
      {
        workSlot: fixture.command.workSlots[0],
        attemptOrdinal: 2,
      }
    );
    expect(fixture.controlPlane.commitEvidence).toHaveBeenCalledTimes(1);
  });

  it('keeps retry decisions independent from failure diagnostics', async () => {
    const fixture = createFixture({ maxAttempts: 2 });
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockRejectedValueOnce(new Error('provider_failed'))
      .mockResolvedValueOnce(observationPayload);
    jest
      .mocked(fixture.dependencies.invocationDiagnostics!.recordFailure)
      .mockImplementation(() => {
        throw new Error('diagnostics_failed');
      });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(
      fixture.dependencies.invocationDiagnostics!.recordFailure
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptBudget: 2,
        failureClass: ReviewInvocationFailureClass.Retryable,
        invocation: expect.objectContaining({
          attemptOrdinal: 1,
          workSlotId: 'slot-1',
        }),
      })
    );
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(2);
    expect(fixture.controlPlane.commitEvidence).toHaveBeenCalledTimes(1);
  });

  it('retries a missing context witness within the existing attempt budget', async () => {
    const fixture = createFixture({
      executionProfile: 'context_gateway_v1',
      maxAttempts: 2,
    });
    const fallback = {
      ...observationPayload,
      qualityFlags: [
        'context_inspection_incomplete',
        'cross_revision_reuse_disabled',
      ],
    };
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockRejectedValueOnce(
        new RetryableReviewContextInspectionFailure(
          ReviewContextInspectionFailureReason.MissingChangedPathsWitness,
          fallback
        )
      )
      .mockResolvedValueOnce(observationPayload);

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(2);
    expect(
      fixture.dependencies.invocationFailureClassifier.classify
    ).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.commitEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ observation: observationPayload })
    );
  });

  it('preserves exhausted context inspection as current-revision-only evidence', async () => {
    const fixture = createFixture({
      executionProfile: 'context_gateway_v1',
      maxAttempts: 2,
    });
    fixture.controlPlane.commitEvidence.mockResolvedValue({
      observationId: 'observation-current-only',
      historicalOnly: true,
      eligibilityPolicyVersion: 't0-v1',
    });
    const fallback = {
      ...observationPayload,
      qualityFlags: [
        'context_inspection_incomplete',
        'cross_revision_reuse_disabled',
      ],
    };
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockRejectedValue(
        new RetryableReviewContextInspectionFailure(
          ReviewContextInspectionFailureReason.MissingChangedPathsWitness,
          fallback
        )
      );

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(2);
    expect(fixture.controlPlane.commitEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({
          qualityFlags: [
            'context_inspection_incomplete',
            'cross_revision_reuse_disabled',
          ],
        }),
      })
    );
    const committedObservation =
      fixture.controlPlane.commitEvidence.mock.calls[0][0].observation;
    expect(committedObservation).not.toHaveProperty(
      'contextDependencyAttestationId'
    );
    expect(committedObservation).not.toHaveProperty(
      'contextDependencyAttestationHash'
    );
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
      2
    );
    expect(fixture.controlPlane.attachObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({
          observationId: 'observation-current-only',
          qualityFlags: [
            'context_inspection_incomplete',
            'cross_revision_reuse_disabled',
          ],
        }),
      })
    );
  });

  it('fails fast across the review when provider capacity is unavailable', async () => {
    const fixture = createFixture({ maxAttempts: 3 });
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockRejectedValue(new Error('quota_exceeded'));
    jest
      .mocked(fixture.dependencies.invocationFailureClassifier.classify)
      .mockReturnValue(ReviewInvocationFailureClass.CapacityUnavailable);

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode: 'provider_capacity_unavailable',
    });
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
      1
    );
    expect(fixture.dependencies.projectionBuilder.build).not.toHaveBeenCalled();
    expect(fixture.controlPlane.finalizeExecution).not.toHaveBeenCalled();
  });

  it('fails fast when provider authentication is unavailable', async () => {
    const fixture = createFixture({ maxAttempts: 3 });
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockRejectedValue(new Error('refresh token was revoked'));
    jest
      .mocked(fixture.dependencies.invocationFailureClassifier.classify)
      .mockReturnValue(ReviewInvocationFailureClass.AuthenticationUnavailable);

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode: 'provider_authentication_unavailable',
    });
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.projectionBuilder.build).not.toHaveBeenCalled();
  });

  it('supersedes before scheduling stale work and never projects it', async () => {
    const fixture = createFixture();
    jest
      .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
      .mockResolvedValueOnce(revisionOf(fixture.command))
      .mockResolvedValueOnce({
        ...revisionOf(fixture.command),
        headSha: '9'.repeat(40),
        reviewRevisionHash: hash('new-head'),
      });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Superseded);
    expect(fixture.controlPlane.supersedeExecution).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.invocations.prepare).not.toHaveBeenCalled();
    expect(fixture.dependencies.projectionBuilder.build).not.toHaveBeenCalled();
    expect(fixture.controlPlane.requestPublication).not.toHaveBeenCalled();
  });

  it('releases the lease and supersedes when revision moves after provider execution', async () => {
    const fixture = createFixture();
    jest
      .mocked(fixture.dependencies.delay.sleep)
      .mockImplementation(() => new Promise<void>(() => undefined));
    const revisionGuard = jest.mocked(
      fixture.dependencies.revisionGuard.loadCurrentRevision
    );
    revisionGuard.mockReset().mockResolvedValue(revisionOf(fixture.command));
    for (let call = 0; call < 4; call += 1) {
      revisionGuard.mockResolvedValueOnce(revisionOf(fixture.command));
    }
    revisionGuard.mockResolvedValueOnce({
      ...revisionOf(fixture.command),
      mergeBaseSha: '8'.repeat(40),
      reviewRevisionHash: hash('new-head'),
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Superseded);
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.commitEvidence).not.toHaveBeenCalled();
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
      1
    );
    expect(fixture.controlPlane.supersedeExecution).toHaveBeenCalledTimes(1);
  });

  it('aborts an active provider invocation when the revision moves', async () => {
    const fixture = createFixture();
    let releaseRevisionPoll!: () => void;
    jest.mocked(fixture.dependencies.delay.sleep).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseRevisionPoll = resolve;
        })
    );
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockImplementation(async ({ signal }) => {
        observedSignal = signal;
        providerStarted();
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(signal.reason || new Error('aborted')),
            { once: true }
          );
        });
      });

    const resultPromise = fixture.useCase.execute(fixture.command);
    await started;
    jest
      .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
      .mockResolvedValue({
        ...revisionOf(fixture.command),
        headSha: '9'.repeat(40),
        reviewRevisionHash: hash('new-head-during-provider'),
      });
    releaseRevisionPoll();
    const result = await resultPromise;

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Superseded);
    expect(observedSignal?.aborted).toBe(true);
    expect(fixture.controlPlane.commitEvidence).not.toHaveBeenCalled();
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
      1
    );
  });

  it('drains a confined invocation and commits historical evidence after supersession', async () => {
    const fixture = createFixture({
      executionProfile: 'context_gateway_v1',
    });
    fixture.controlPlane.commitEvidence.mockResolvedValue({
      observationId: 'observation-historical',
      historicalOnly: true,
      eligibilityPolicyVersion: 't0-v1',
    });
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    let finishProvider!: () => void;
    const providerMayFinish = new Promise<void>((resolve) => {
      finishProvider = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockImplementation(async ({ signal }) => {
        observedSignal = signal;
        providerStarted();
        await providerMayFinish;
        return observationPayload;
      });

    const resultPromise = fixture.useCase.execute(fixture.command);
    await started;
    jest
      .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
      .mockResolvedValue({
        ...revisionOf(fixture.command),
        headSha: '9'.repeat(40),
        reviewRevisionHash: hash('new-head-during-confined-provider'),
      });
    finishProvider();
    const result = await resultPromise;

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Superseded);
    expect(observedSignal?.aborted).toBe(false);
    expect(fixture.controlPlane.commitEvidence).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.attachObservation).not.toHaveBeenCalled();
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
      1
    );
    expect(fixture.controlPlane.supersedeExecution).toHaveBeenCalledTimes(1);
  });

  it('publishes a blocking partial result after bounded attempt exhaustion', async () => {
    const fixture = createFixture();
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockRejectedValue(new Error('provider_failed'));

    const result = await fixture.useCase.execute({
      ...fixture.command,
      allowPartial: true,
    });

    expect(result.status).toBe(
      ReviewOrchestrationResultStatus.PartialCompleted
    );
    expect(result.failureCode).toBe('required_work_exhausted');
    expect(result.state.phase).toBe(ReviewOrchestrationPhase.PartialCompleted);
    expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledWith(
      expect.objectContaining({ allowPartial: true })
    );
    expect(fixture.dependencies.projectionBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({ exhaustedWorkSlotIds: ['slot-1'] })
    );
  });

  it('does not consume a semantic attempt ordinal while a lease is busy', async () => {
    const fixture = createFixture({ maxAttempts: 1 });
    fixture.controlPlane.acquireInvocationLease
      .mockResolvedValueOnce({
        status: ReviewInvocationLeaseAcquireOutcomeStatus.Busy,
      })
      .mockResolvedValueOnce({
        status: ReviewInvocationLeaseAcquireOutcomeStatus.Acquired,
        lease,
      });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.dependencies.invocations.prepare).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.invocations.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ attemptOrdinal: 1 })
    );
    expect(fixture.controlPlane.acquireInvocationLease).toHaveBeenCalledTimes(
      2
    );
    expect(fixture.dependencies.delay.sleep).toHaveBeenCalledWith(500);
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
  });

  it('marks a persistently busy required lease as blocking partial coverage', async () => {
    const fixture = createFixture({ maxAttempts: 1 });
    fixture.controlPlane.acquireInvocationLease.mockResolvedValue({
      status: ReviewInvocationLeaseAcquireOutcomeStatus.Busy,
    });
    const useCase = new RunT0ReviewOrchestration(fixture.dependencies, 30, 2);

    const result = await useCase.execute({
      ...fixture.command,
      allowPartial: true,
    });

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.PartialCompleted,
      failureCode: 'required_provider_lane_busy',
    });
    expect(fixture.controlPlane.acquireInvocationLease).toHaveBeenCalledTimes(
      2
    );
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    expect(fixture.dependencies.projectionBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({ exhaustedWorkSlotIds: ['slot-1'] })
    );
    expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledWith(
      expect.objectContaining({ allowPartial: true })
    );
  });

  it('shares the busy poll budget across required slots on one provider lane', async () => {
    const fixture = createFixture({ maxAttempts: 1 });
    const secondSlot: ReviewWorkSlotPlan = {
      ...fixture.command.workSlots[0]!,
      workSlotId: 'slot-2',
      shardKey: 'batch-2',
    };
    const workSlots = [...fixture.command.workSlots, secondSlot];
    const command = {
      ...fixture.command,
      workSlots,
      workSlotsCanonicalJson: canonicalizeReviewWorkSlots(workSlots),
      allowPartial: true,
    };
    jest
      .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
      .mockResolvedValue(revisionOf(command));
    fixture.controlPlane.restoreExecution
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        ...restoredAdmission(command, {
          state: RestoredReviewWorkSlotState.Pending,
          acceptedObservationRefId: null,
        }).restoredExecution,
        version: '2',
        streamVersion: '2',
      });
    fixture.controlPlane.acquireInvocationLease.mockResolvedValue({
      status: ReviewInvocationLeaseAcquireOutcomeStatus.Busy,
    });
    const useCase = new RunT0ReviewOrchestration(fixture.dependencies, 30, 2);

    const result = await useCase.execute(command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.PartialCompleted,
      failureCode: 'required_provider_lane_busy',
    });
    expect(fixture.controlPlane.acquireInvocationLease).toHaveBeenCalledTimes(
      2
    );
    expect(fixture.dependencies.invocations.prepare).toHaveBeenCalledTimes(1);
    expect(
      jest
        .mocked(fixture.dependencies.delay.sleep)
        .mock.calls.filter(([delayMs]) => delayMs === 500)
    ).toHaveLength(1);
    expect(fixture.dependencies.projectionBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({
        exhaustedWorkSlotIds: ['slot-1', 'slot-2'],
      })
    );
  });

  it('treats a server-side attempt budget exhaustion as an exhausted slot', async () => {
    const fixture = createFixture({ maxAttempts: 1 });
    fixture.controlPlane.acquireInvocationLease.mockResolvedValue({
      status: ReviewInvocationLeaseAcquireOutcomeStatus.AttemptBudgetExhausted,
    });

    const result = await fixture.useCase.execute({
      ...fixture.command,
      allowPartial: true,
    });

    expect(result.status).toBe(
      ReviewOrchestrationResultStatus.PartialCompleted
    );
    expect(result.failureCode).toBe('required_work_exhausted');
    expect(result.state.phase).toBe(ReviewOrchestrationPhase.PartialCompleted);
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    expect(fixture.dependencies.projectionBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({ exhaustedWorkSlotIds: ['slot-1'] })
    );
  });

  it('accepts monotonic execution advancement between restore and start', async () => {
    const fixture = createFixture();
    const older = restoredAdmission(fixture.command, {
      state: RestoredReviewWorkSlotState.Pending,
      acceptedObservationRefId: null,
    }).restoredExecution;
    const newer = restoredAdmission(fixture.command, {
      state: RestoredReviewWorkSlotState.Satisfied,
      acceptedObservationRefId: observationRef(
        'execution-1',
        'slot-1',
        acceptedObservation.observationId
      ),
    });
    const advanced = {
      ...newer,
      streamVersion: '2',
      executionVersion: '2',
      restoredExecution: {
        ...newer.restoredExecution,
        streamVersion: '2',
        version: '2',
      },
    };
    fixture.controlPlane.restoreExecution
      .mockReset()
      .mockResolvedValueOnce(older)
      .mockResolvedValue(advanced.restoredExecution);
    fixture.controlPlane.startExecution.mockResolvedValue(advanced);
    fixture.controlPlane.lookupEvidence.mockResolvedValue({
      kind: ReviewEvidenceLookupKind.Hit,
      observation: acceptedObservation,
      attachment: sameExecutionAttachment,
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
  });

  it('rejects lease renewal identity drift before evidence commit', async () => {
    const fixture = createFixture();
    (fixture.dependencies.leaseSupervisor.run as jest.Mock).mockImplementation(
      async ({
        renew,
        operation,
      }: {
        renew: () => Promise<unknown>;
        operation: (signal: AbortSignal) => Promise<unknown>;
      }) => {
        await renew();
        return operation(new AbortController().signal);
      }
    );
    fixture.controlPlane.renewInvocationLease.mockResolvedValue({
      ...lease,
      leaseId: 'lease-drift',
      fencingToken: '2',
      expiresAt: '2026-07-22T12:11:00.000Z',
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode: 'required_work_exhausted',
    });
    expect(fixture.controlPlane.commitEvidence).not.toHaveBeenCalled();
  });

  it('propagates the rotated renewal capability to every later mutation', async () => {
    const fixture = createFixture();
    (fixture.dependencies.leaseSupervisor.run as jest.Mock).mockImplementation(
      async ({
        renew,
        operation,
      }: {
        renew: () => Promise<unknown>;
        operation: (signal: AbortSignal) => Promise<unknown>;
      }) => {
        await renew();
        return operation(new AbortController().signal);
      }
    );
    fixture.controlPlane.renewInvocationLease.mockResolvedValue({
      ...lease,
      leaseCapability: 'lease.capability.renewed',
      expiresAt: '2026-07-22T12:11:00.000Z',
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.controlPlane.commitEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: expect.objectContaining({
          leaseCapability: 'lease.capability.renewed',
        }),
      })
    );
    expect(fixture.controlPlane.attachObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentCapability: 'lease.capability.renewed',
      })
    );
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: expect.objectContaining({
          leaseCapability: 'lease.capability.renewed',
        }),
      })
    );
  });

  it('does not mark coverage partial when only an optional slot is exhausted', async () => {
    const fixture = createFixture();
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockRejectedValue(new Error('provider_failed'));

    const optionalWorkSlots = [
      { ...fixture.command.workSlots[0], required: false },
    ];
    const optionalCommand = {
      ...fixture.command,
      workSlots: optionalWorkSlots,
      workSlotsCanonicalJson: canonicalizeReviewWorkSlots(optionalWorkSlots),
    };
    fixture.controlPlane.restoreExecution
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(
        restoredAdmission(optionalCommand, {
          state: RestoredReviewWorkSlotState.Pending,
          acceptedObservationRefId: null,
        }).restoredExecution
      );

    const result = await fixture.useCase.execute(optionalCommand);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledWith(
      expect.objectContaining({ allowPartial: false })
    );
  });

  it('derives final partial publication from projection coverage limitations', async () => {
    const fixture = createFixture();
    jest
      .mocked(fixture.dependencies.projectionBuilder.build)
      .mockResolvedValue({
        ...projection,
        coverageComplete: false,
      });

    const result = await fixture.useCase.execute({
      ...fixture.command,
      allowPartial: true,
    });

    expect(result.status).toBe(
      ReviewOrchestrationResultStatus.PartialCompleted
    );
    expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledWith(
      expect.objectContaining({ allowPartial: true })
    );
  });

  it('fails before durable execution when server limits reject the plan', async () => {
    const fixture = createFixture();
    fixture.controlPlane.authorize.mockResolvedValue({
      ...authorization,
      limits: { ...authorization.limits, maxWorkSlots: 0 },
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode: 'review_orchestration_work_slot_limit_exceeded',
    });
    expect(fixture.controlPlane.startExecution).not.toHaveBeenCalled();
  });

  it('blocks terminal_unknown instead of treating publication as complete', async () => {
    const fixture = createFixture();
    fixture.controlPlane.readPublicationStatus.mockResolvedValue({
      terminal: true,
      outcome: { state: ReviewPublicationState.TerminalUnknown },
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode: 'publication_terminal_unknown',
    });
    expect(result.state.phase).toBe(ReviewOrchestrationPhase.Failed);
  });
});

function createFixture(
  options: {
    maxAttempts?: number;
    executionProfile?:
      | 'prompt_only_envelope_v1'
      | 'agentic_unbounded_v1'
      | 'context_gateway_v1';
  } = {}
) {
  const controlPlane = {
    authorize: jest.fn().mockResolvedValue(authorization),
    restoreSnapshot: jest.fn().mockResolvedValue(undefined),
    restoreExecution: jest.fn().mockResolvedValue(null),
    startExecution: jest.fn().mockImplementation(async (input) => ({
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
        reviewRevisionHash: input.reviewRevisionHash,
        planHash: input.planHash,
        workSlots: input.workSlots.map((slot: ReviewWorkSlotPlan) => ({
          workSlotId: slot.workSlotId,
          state: RestoredReviewWorkSlotState.Pending,
          required: slot.required,
          providerVoteIdentityHash: slot.providerVoteIdentityHash,
          activeLeaseId: null,
          acceptedObservationRefId: null,
        })),
      },
    })),
    supersedeExecution: jest.fn().mockResolvedValue(undefined),
    lookupEvidence: jest
      .fn()
      .mockResolvedValue({ kind: ReviewEvidenceLookupKind.Miss }),
    acquireInvocationLease: jest.fn().mockResolvedValue({
      status: ReviewInvocationLeaseAcquireOutcomeStatus.Acquired,
      lease,
    }),
    renewInvocationLease: jest.fn().mockResolvedValue(lease),
    releaseInvocationLease: jest.fn().mockResolvedValue(undefined),
    commitEvidence: jest.fn().mockResolvedValue({
      observationId: 'observation-1',
      historicalOnly: false,
      eligibilityPolicyVersion: 't0-v1',
    }),
    attachObservation: jest.fn().mockResolvedValue({ streamVersion: '2' }),
    adoptObservation: jest.fn().mockResolvedValue({ streamVersion: '2' }),
    finalizeExecution: jest
      .fn()
      .mockResolvedValue({ publicationPermit: 'publication.permit' }),
    requestPublication: jest.fn().mockResolvedValue({
      status: ReviewPublicationRequestOutcomeStatus.Requested,
      publicationAttemptId: 'publication-1',
      pollAfterMs: 0,
    }),
    readPublicationStatus: jest.fn().mockResolvedValue({
      terminal: true,
      outcome: {
        state: ReviewPublicationState.Succeeded,
        canonicalReceiptSetHash: hash('receipt'),
      },
    }),
  } as jest.Mocked<ReviewActionV2ControlPlanePort>;
  const workSlots = [
    {
      workSlotId: 'slot-1',
      taskKind: ReviewTaskKind.FindingDiscovery,
      providerKind: ReviewExecutionProviderKind.Codex,
      providerVoteIdentityHash: hash('vote'),
      shardKey: 'batch-1',
      required: true,
      attemptBudget: options.maxAttempts ?? 1,
      retryPolicyVersion: 'retry-v1',
    },
  ] as const;
  const command: RunT0ReviewOrchestrationCommand = {
    executionId: 'execution-1',
    baseSha: '1'.repeat(40),
    mergeBaseSha: '2'.repeat(40),
    headSha: '3'.repeat(40),
    reviewRevisionHash: hash('revision'),
    compatibilityKey: hash('compatibility'),
    planHash: hash('plan'),
    workSlotsCanonicalJson: canonicalizeReviewWorkSlots(workSlots),
    workSlots,
    sourceRunId: 'run-1',
    sourceRunAttempt: '1',
    ownerIdHash: hash('owner'),
    allowPartial: false,
  };
  controlPlane.restoreExecution
    .mockReset()
    .mockResolvedValueOnce(null)
    .mockResolvedValue({
      ...restoredAdmission(command, {
        state: RestoredReviewWorkSlotState.Pending,
        acceptedObservationRefId: null,
      }).restoredExecution,
      version: '2',
      streamVersion: '2',
    });
  const dependencies = {
    controlPlane,
    revisionGuard: {
      loadCurrentRevision: jest.fn().mockResolvedValue(revisionOf(command)),
    },
    oidc: { getToken: jest.fn().mockResolvedValue('oidc.token') },
    invocationManifestAssembler: {
      assemble: jest.fn().mockImplementation(async (invocation) => ({
        manifestCanonicalJson: '{"fixture":true}',
        manifestKey: hash(`manifest-${invocation.attemptOrdinal}`),
        providerInvocationKey: hash(`invocation-${invocation.attemptOrdinal}`),
        providerVoteIdentityHash: hash('vote'),
      })),
    },
    invocations: {
      prepare: jest
        .fn()
        .mockImplementation(async ({ workSlot, attemptOrdinal }) => ({
          workSlotId: workSlot.workSlotId,
          attemptOrdinal,
          provider: 'codex',
          requestedModel: 'gpt-test',
          immutableRequest: Object.freeze({ prompt: 'review' }),
          coverageManifest: coverageManifest(workSlot.workSlotId),
          manifestFacts: Object.freeze({
            taskKindSet: [workSlot.taskKind],
            providerKind: workSlot.providerKind,
            providerCapabilityHash: hash('capability'),
            providerRequestEnvelopeHash: hash('request'),
            outputSchemaHash: hash('schema'),
            filePatchManifestHash: hash('patch'),
            contextManifestHash: hash('context'),
            lifecycleTargetSetHash: null,
            liveLifecycleStateHash: null,
            toolPolicyHash: hash('tool-policy'),
            executionProfile:
              options.executionProfile ?? 'agentic_unbounded_v1',
            baseTreeHash: null,
            environmentContractHash: hash('environment'),
          }),
        })),
      execute: jest.fn().mockResolvedValue(observationPayload),
    },
    invocationFailureClassifier: {
      classify: jest
        .fn()
        .mockReturnValue(ReviewInvocationFailureClass.Retryable),
    },
    invocationDiagnostics: {
      recordFailure: jest.fn(),
    },
    leaseSupervisor: {
      run: jest
        .fn()
        .mockImplementation(async ({ operation }) =>
          operation(new AbortController().signal)
        ),
    },
    projectionBuilder: {
      build: jest.fn().mockResolvedValue(projection),
    },
    identities: {
      deterministicId: jest.fn(
        (namespace, parts) =>
          `rr:${namespace}:${hash(parts.join('|')).slice(0, 32)}`
      ),
    } satisfies ReviewOrchestrationIdentityPort,
    delay: {
      sleep: jest.fn().mockResolvedValue(undefined),
    } satisfies ReviewOrchestrationDelayPort,
  } as unknown as jest.Mocked<RunT0ReviewOrchestrationDependencies>;
  return {
    controlPlane,
    command,
    dependencies,
    useCase: new RunT0ReviewOrchestration(dependencies),
  };
}

const authorization: ReviewRunAuthorization = {
  authorizationId: 'authorization-1',
  authorizationToken: 'authorization.token',
  producerReleaseId: 'release-1',
  protocolLimitsProfileId: 'limits-1',
  operationalSloProfileId: 'slo-1',
  mutationEpoch: '1',
  expiresAt: '2026-07-22T13:00:00.000Z',
  limits: {
    maxWorkSlots: 10,
    maxAttemptsPerSlot: 3,
    maxObservationBytes: 100_000,
    maxObservationFindings: 100,
    maxProjectionBytes: 200_000,
    maxProjectionFindings: 100,
    maxPublicationOperations: 100,
    maxPublicationChunks: 20,
    maxPublicationBodyBytes: 200_000,
    maxRequestBatchSize: 20,
    maxLeaseDurationMs: 60_000,
    maxResultReportDurationMs: 60_000,
    maxReconciliationDurationMs: 60_000,
  },
  facts: {
    workspaceId: 'workspace-1',
    repositoryConnectionId: 'connection-1',
    scmRepositoryIdentityId: 'repository-1',
    pullRequestNumber: 252,
    sourceRunId: 'run-1',
    sourceRunAttempt: '1',
    baseSha: '1'.repeat(40),
    mergeBaseSha: '2'.repeat(40),
    headSha: '3'.repeat(40),
    reviewRevisionHash: hash('revision'),
    trustDomain: 'github-actions',
    producerReleaseId: 'release-1',
    selectedProtocolVersion: 'review-action-v2',
    schemaDigest: hash('schema-digest'),
    providerVoteLanes: [
      {
        providerKind: ReviewExecutionProviderKind.Codex,
        providerVoteIdentityHash: hash('vote'),
      },
    ],
  },
};

const lease = {
  leaseId: 'lease-1',
  attemptId: 'attempt-1',
  leaseCapability: 'lease.capability',
  fencingToken: '1',
  expiresAt: '2026-07-22T12:10:00.000Z',
  resultReportUntil: '2026-07-22T12:20:00.000Z',
  renewalCeilingReached: false,
};

const sameExecutionAttachment = {
  kind: 'same_execution' as const,
  sourceLeaseId: lease.leaseId,
  sourceFencingToken: lease.fencingToken,
  sourceOwnerIdHash: hash('owner'),
};

const observationPayload = {
  payloadCanonicalJson: '{"findings":[]}',
  payloadHash: hash('{"findings":[]}'),
  byteCount: 15,
  findingCount: 0,
  actualModel: 'gpt-test',
  qualityFlags: [] as readonly string[],
  transportAttemptCount: 1,
  schemaValidated: true,
  fullyConsumed: true,
};

const acceptedObservation = {
  ...observationPayload,
  observationId: 'observation-1',
  eligibilityPolicyVersion: 't0-v1',
  providerKind: ReviewExecutionProviderKind.Codex,
  providerInvocationKey: hash('invocation-1'),
  providerVoteIdentityHash: hash('vote'),
};

const projection = {
  artifactId: 'artifact-1',
  artifactHash: hash('artifact'),
  projectionEnvelopeVersion: 1,
  projectionEnvelopeCanonicalJson: '{"findings":[]}',
  projectionHash: hash('projection'),
  lifecycleStateHash: hash('lifecycle'),
  commandLedgerWatermark: '1',
  operationsCanonicalJson: '[]',
  findingCount: 0,
  publicationOperationCount: 0,
  publicationChunkCount: 0,
  coverageComplete: true,
};

function coverageManifest(workSlotId: string) {
  return createReviewPromptCoverageManifest({
    workSlotId,
    reviewRevisionHash: hash('revision'),
    assignedPaths: ['src/a.ts'],
    pathCoverage: [
      {
        path: 'src/a.ts',
        kind: ReviewPromptPathCoverageKind.FullPatch,
        contentHash: hash('patch'),
      },
    ],
  });
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function revisionOf(command: RunT0ReviewOrchestrationCommand) {
  return {
    baseSha: command.baseSha,
    mergeBaseSha: command.mergeBaseSha,
    headSha: command.headSha,
    reviewRevisionHash: command.reviewRevisionHash,
  };
}

function restoredAdmission(
  command: RunT0ReviewOrchestrationCommand,
  slot: {
    readonly state: RestoredReviewWorkSlotState;
    readonly acceptedObservationRefId: string | null;
  }
) {
  return {
    executionId: command.executionId,
    generation: '1',
    streamVersion: '1',
    executionVersion: '1',
    restoredExecution: {
      executionId: command.executionId,
      version: '1',
      streamVersion: '1',
      generation: '1',
      state: RestoredReviewExecutionState.Running,
      authorizationId: authorization.authorizationId,
      reviewRevisionHash: command.reviewRevisionHash,
      planHash: command.planHash,
      workSlots: command.workSlots.map((workSlot) => ({
        workSlotId: workSlot.workSlotId,
        state: slot.state,
        required: workSlot.required,
        providerVoteIdentityHash: workSlot.providerVoteIdentityHash,
        activeLeaseId: null,
        acceptedObservationRefId: slot.acceptedObservationRefId,
      })),
    },
  };
}

function observationRef(
  executionId: string,
  workSlotId: string,
  observationId: string
): string {
  return `obsref:${hash(
    canonicalJson({ executionId, observationId, workSlotId })
  )}`;
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
