import { createHash } from 'crypto';
import {
  createReviewOrchestrationState,
  evolveReviewOrchestration,
  ReviewOrchestrationEventType,
  ReviewOrchestrationPhase,
  type ReviewOrchestrationState,
} from '../domain';
import {
  ReviewEvidenceLookupKind,
  ReviewInvocationFailureClass,
  ReviewInvocationLeaseAcquireOutcomeStatus,
  ReviewPublicationRequestOutcomeStatus,
  ReviewPublicationState,
  ReviewInvestigationRecordingMode,
  RestoredReviewWorkSlotState,
  type AcceptedReviewObservation,
  type AcceptedReviewWorkSlotEvidence,
  type CurrentReviewProjectionBuilderPort,
  type ContextDependencyReplayPort,
  type PreparedReviewInvocationPort,
  type PreparedReviewInvocation,
  type ProviderInvocationManifest,
  type ProviderInvocationManifestAssemblerPort,
  type ReviewActionV2ControlPlanePort,
  type ReviewContextAttestationPort,
  type ReviewExecutionAdmission,
  type ReviewInvocationLease,
  type ReviewInvocationDiagnosticsPort,
  type ReviewInvocationFailureClassifierPort,
  type ReviewInvocationLeaseSupervisorPort,
  type ReviewInvestigationRecordingPort,
  type ReviewOidcTokenPort,
  type ReviewOrchestrationDelayPort,
  type ReviewOrchestrationIdentityPort,
  type ReviewProtocolLimits,
  type ReviewRevisionGuardPort,
  type ReviewRevisionFacts,
  type ReviewObservationPayload,
  type ReviewRunAuthorization,
  type RestoredReviewExecution,
  type RestoredReviewWorkSlot,
  type ReviewWorkSlotPlan,
} from './review-orchestration-ports';
import type { ReviewPromptCoverageManifest } from '../domain';
import { RetryableReviewContextInspectionFailure } from './review-context-inspection-failure';

export enum ReviewOrchestrationResultStatus {
  Completed = 'completed',
  PartialCompleted = 'partial_completed',
  Superseded = 'superseded',
  PublicationNotApplied = 'publication_not_applied',
  PublicationStale = 'publication_stale',
  Failed = 'failed',
}

export type RunT0ReviewOrchestrationCommand = {
  readonly executionId: string;
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly headSha: string;
  readonly reviewRevisionHash: string;
  readonly compatibilityKey: string;
  readonly planHash: string;
  readonly workSlotsCanonicalJson: string;
  readonly workSlots: readonly ReviewWorkSlotPlan[];
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
  readonly ownerIdHash: string;
  readonly allowPartial: boolean;
};

export type ReviewOrchestrationResult = {
  readonly status: ReviewOrchestrationResultStatus;
  readonly state: ReviewOrchestrationState;
  readonly executionId?: string;
  readonly publicationAttemptId?: string;
  readonly canonicalReceiptSetHash?: string;
  readonly failureCode?: string;
};

enum ReviewWorkSlotExhaustionReason {
  AttemptBudgetExhausted = 'attempt_budget_exhausted',
  NotRunnable = 'not_runnable',
  ProviderAttemptsExhausted = 'provider_attempts_exhausted',
  ProviderLaneBusy = 'provider_lane_busy',
  RestoredTerminal = 'restored_terminal',
}

export type RunT0ReviewOrchestrationDependencies = {
  readonly controlPlane: ReviewActionV2ControlPlanePort;
  readonly revisionGuard: ReviewRevisionGuardPort;
  readonly oidc: ReviewOidcTokenPort;
  readonly invocationManifestAssembler: ProviderInvocationManifestAssemblerPort;
  readonly invocations: PreparedReviewInvocationPort;
  readonly invocationFailureClassifier: ReviewInvocationFailureClassifierPort;
  readonly invocationDiagnostics?: ReviewInvocationDiagnosticsPort;
  readonly investigationRecording?: ReviewInvestigationRecordingPort;
  readonly leaseSupervisor: ReviewInvocationLeaseSupervisorPort;
  readonly projectionBuilder: CurrentReviewProjectionBuilderPort;
  readonly contextReplay?: ContextDependencyReplayPort;
  readonly contextAttestations?: ReviewContextAttestationPort;
  readonly identities: ReviewOrchestrationIdentityPort;
  readonly delay: ReviewOrchestrationDelayPort;
};

export class RunT0ReviewOrchestration {
  constructor(
    private readonly dependencies: RunT0ReviewOrchestrationDependencies,
    private readonly maxPublicationPolls = 30,
    private readonly maxBusyPollsPerProviderLane = 24,
    private readonly revisionPollIntervalMs = 5_000
  ) {
    if (
      !Number.isSafeInteger(maxPublicationPolls) ||
      maxPublicationPolls < 1 ||
      maxPublicationPolls > 120
    ) {
      throw new Error('review_orchestration_publication_poll_limit_invalid');
    }
    if (
      !Number.isSafeInteger(maxBusyPollsPerProviderLane) ||
      maxBusyPollsPerProviderLane < 1 ||
      maxBusyPollsPerProviderLane > 120
    ) {
      throw new Error('review_orchestration_busy_poll_limit_invalid');
    }
    if (
      !Number.isSafeInteger(revisionPollIntervalMs) ||
      revisionPollIntervalMs < 10 ||
      revisionPollIntervalMs > 60_000
    ) {
      throw new Error('review_orchestration_revision_poll_interval_invalid');
    }
  }

  async execute(
    command: RunT0ReviewOrchestrationCommand
  ): Promise<ReviewOrchestrationResult> {
    return this.executeInternal(command);
  }

  async executeAuthorized(
    command: RunT0ReviewOrchestrationCommand,
    authorization: ReviewRunAuthorization
  ): Promise<ReviewOrchestrationResult> {
    return this.executeInternal(command, authorization);
  }

  private async executeInternal(
    command: RunT0ReviewOrchestrationCommand,
    preauthorized?: ReviewRunAuthorization
  ): Promise<ReviewOrchestrationResult> {
    let state = createReviewOrchestrationState(
      command.workSlots.map((slot) => slot.workSlotId)
    );
    let authorization: ReviewRunAuthorization | undefined;
    let execution: ReviewExecutionAdmission | undefined;

    try {
      validateCommand(command);
      authorization =
        preauthorized ??
        (await this.dependencies.controlPlane.authorize({
          oidcToken: await this.dependencies.oidc.getToken(),
        }));
      validateAuthorizationScope(command, authorization);
      validatePlanAgainstLimits(command.workSlots, authorization.limits);
      state = evolveReviewOrchestration(state, {
        type: ReviewOrchestrationEventType.Authorized,
      });

      const admittedRevision =
        await this.dependencies.revisionGuard.loadCurrentRevision();
      if (!sameRevision(admittedRevision, command)) {
        state = evolveReviewOrchestration(state, {
          type: ReviewOrchestrationEventType.Superseded,
        });
        return { status: ReviewOrchestrationResultStatus.Superseded, state };
      }
      state = evolveReviewOrchestration(state, {
        type: ReviewOrchestrationEventType.RevisionConfirmed,
      });

      const [, restoredExecution] = await Promise.all([
        this.dependencies.controlPlane.restoreSnapshot({
          authorization,
          reviewRevisionHash: command.reviewRevisionHash,
        }),
        this.dependencies.controlPlane.restoreExecution({
          authorization,
          reviewRevisionHash: command.reviewRevisionHash,
        }),
      ]);

      execution = await this.dependencies.controlPlane.startExecution({
        authorization,
        idempotencyKey: this.idempotencyKey('start', [
          authorization.authorizationId,
          command.reviewRevisionHash,
          command.planHash,
        ]),
        executionId: command.executionId,
        reviewRevisionHash: command.reviewRevisionHash,
        compatibilityKey: command.compatibilityKey,
        planHash: command.planHash,
        workSlotsCanonicalJson: command.workSlotsCanonicalJson,
        workSlots: command.workSlots,
        sourceRunId: command.sourceRunId,
        sourceRunAttempt: command.sourceRunAttempt,
      });
      validateRestoredExecutionContinuity(restoredExecution, execution);
      state = evolveReviewOrchestration(state, {
        type: ReviewOrchestrationEventType.ExecutionStarted,
      });

      const acceptedEvidence: AcceptedReviewWorkSlotEvidence[] = [];
      const exhaustedWorkSlotIds: string[] = [];
      const exhaustedWorkSlotReasons = new Map<
        string,
        ReviewWorkSlotExhaustionReason
      >();
      const busyPollsByProviderLane = new Map<string, number>();
      const restoredSlots = new Map(
        execution.restoredExecution.workSlots.map((slot) => [
          slot.workSlotId,
          slot,
        ])
      );
      for (const workSlot of command.workSlots) {
        const restoredSlot = restoredSlots.get(workSlot.workSlotId);
        if (!restoredSlot) {
          throw new Error('review_orchestration_restored_work_slot_missing');
        }
        if (
          restoredSlot.state === RestoredReviewWorkSlotState.Exhausted ||
          restoredSlot.state === RestoredReviewWorkSlotState.Cancelled
        ) {
          exhaustedWorkSlotIds.push(workSlot.workSlotId);
          exhaustedWorkSlotReasons.set(
            workSlot.workSlotId,
            ReviewWorkSlotExhaustionReason.RestoredTerminal
          );
          state = evolveReviewOrchestration(state, {
            type: ReviewOrchestrationEventType.SlotExhausted,
            workSlotId: workSlot.workSlotId,
          });
          continue;
        }
        if (
          restoredSlot.state !== RestoredReviewWorkSlotState.Satisfied &&
          (busyPollsByProviderLane.get(workSlot.providerVoteIdentityHash) ??
            0) >= this.maxBusyPollsPerProviderLane
        ) {
          exhaustedWorkSlotIds.push(workSlot.workSlotId);
          exhaustedWorkSlotReasons.set(
            workSlot.workSlotId,
            ReviewWorkSlotExhaustionReason.ProviderLaneBusy
          );
          state = evolveReviewOrchestration(state, {
            type: ReviewOrchestrationEventType.SlotExhausted,
            workSlotId: workSlot.workSlotId,
          });
          continue;
        }
        await this.assertRevisionCurrent(command);
        const outcome = await this.satisfyWorkSlot({
          authorization,
          execution,
          workSlot,
          planHash: command.planHash,
          ownerIdHash: command.ownerIdHash,
          revision: command,
          restoredSlot,
          busyPollsByProviderLane,
          onEvent: (event) => {
            state = evolveReviewOrchestration(state, event);
          },
        });
        execution = { ...execution, streamVersion: outcome.streamVersion };
        if (outcome.observation) {
          if (!outcome.coverageManifest) {
            throw new Error('review_orchestration_coverage_manifest_missing');
          }
          acceptedEvidence.push({
            workSlotId: workSlot.workSlotId,
            observation: outcome.observation,
            coverageManifest: outcome.coverageManifest,
          });
        } else {
          exhaustedWorkSlotIds.push(workSlot.workSlotId);
          if (outcome.exhaustionReason) {
            exhaustedWorkSlotReasons.set(
              workSlot.workSlotId,
              outcome.exhaustionReason
            );
          }
        }
      }

      const requiredWorkSlotIds = new Set(
        command.workSlots
          .filter((workSlot) => workSlot.required)
          .map((workSlot) => workSlot.workSlotId)
      );
      const requiredExhaustedWorkSlotIds = exhaustedWorkSlotIds.filter(
        (workSlotId) => requiredWorkSlotIds.has(workSlotId)
      );
      if (requiredExhaustedWorkSlotIds.length > 0 && !command.allowPartial) {
        state = evolveReviewOrchestration(state, {
          type: ReviewOrchestrationEventType.Failed,
        });
        return {
          status: ReviewOrchestrationResultStatus.Failed,
          state,
          executionId: execution.executionId,
          failureCode: 'required_work_exhausted',
        };
      }

      const publicationRevision =
        await this.dependencies.revisionGuard.loadCurrentRevision();
      if (!sameRevision(publicationRevision, command)) {
        await this.dependencies.controlPlane.supersedeExecution({
          authorization,
          idempotencyKey: this.idempotencyKey('supersede', [
            execution.executionId,
            execution.streamVersion,
            command.reviewRevisionHash,
          ]),
          execution,
          targetRevisionHash: publicationRevision.reviewRevisionHash,
        });
        state = evolveReviewOrchestration(state, {
          type: ReviewOrchestrationEventType.Superseded,
        });
        return {
          status: ReviewOrchestrationResultStatus.Superseded,
          state,
          executionId: execution.executionId,
        };
      }

      const projection = await this.dependencies.projectionBuilder.build({
        acceptedEvidence,
        exhaustedWorkSlotIds,
        reviewRevisionHash: command.reviewRevisionHash,
      });
      const partial =
        requiredExhaustedWorkSlotIds.length > 0 || !projection.coverageComplete;
      const partialFailureCode = derivePartialFailureCode({
        requiredExhaustedWorkSlotIds,
        exhaustedWorkSlotReasons,
        projectionCoverageComplete: projection.coverageComplete,
      });
      if (partial && !command.allowPartial) {
        state = evolveReviewOrchestration(state, {
          type: ReviewOrchestrationEventType.Failed,
        });
        return {
          status: ReviewOrchestrationResultStatus.Failed,
          state,
          executionId: execution.executionId,
          failureCode: 'required_review_coverage_incomplete',
        };
      }
      await this.assertRevisionCurrent(command);
      const latestExecution =
        await this.dependencies.controlPlane.restoreExecution({
          authorization,
          reviewRevisionHash: command.reviewRevisionHash,
        });
      execution = refreshExecutionAdmission(execution, latestExecution);
      validateProjectionAgainstLimits(projection, authorization.limits);
      state = evolveReviewOrchestration(state, {
        type: ReviewOrchestrationEventType.FinalizationStarted,
      });
      const finalized = await this.dependencies.controlPlane.finalizeExecution({
        authorization,
        idempotencyKey: this.idempotencyKey('finalize', [
          execution.executionId,
          projection.projectionHash,
        ]),
        execution,
        projection,
        allowPartial: partial,
      });
      await this.assertRevisionCurrent(command);
      const publication =
        await this.dependencies.controlPlane.requestPublication({
          authorization,
          idempotencyKey: this.idempotencyKey('publication', [
            finalized.publicationPermit,
            projection.projectionHash,
          ]),
          publicationPermit: finalized.publicationPermit,
          projection,
        });
      if (
        publication.status === ReviewPublicationRequestOutcomeStatus.Conflict
      ) {
        const publicationRequestedState = evolveReviewOrchestration(state, {
          type: ReviewOrchestrationEventType.PublicationRequested,
          partial,
        });
        const conflictState = evolveReviewOrchestration(
          publicationRequestedState,
          {
            type: ReviewOrchestrationEventType.PublicationCompleted,
            partial,
          }
        );
        return {
          status: ReviewOrchestrationResultStatus.PublicationNotApplied,
          state: conflictState,
          executionId: execution.executionId,
          failureCode: 'publication_request_conflict',
        };
      }
      if (publication.status === ReviewPublicationRequestOutcomeStatus.Stale) {
        const publicationRequestedState = evolveReviewOrchestration(state, {
          type: ReviewOrchestrationEventType.PublicationRequested,
          partial,
        });
        const staleState = evolveReviewOrchestration(
          publicationRequestedState,
          {
            type: ReviewOrchestrationEventType.PublicationCompleted,
            partial,
          }
        );
        return {
          status: ReviewOrchestrationResultStatus.PublicationStale,
          state: staleState,
          executionId: execution.executionId,
          failureCode: `publication_request_${publication.reason}`,
        };
      }
      state = evolveReviewOrchestration(state, {
        type: ReviewOrchestrationEventType.PublicationRequested,
        partial,
      });

      let pollAfterMs = publication.pollAfterMs;
      for (let poll = 0; poll < this.maxPublicationPolls; poll += 1) {
        await this.dependencies.delay.sleep(clampPollDelay(pollAfterMs));
        const status =
          await this.dependencies.controlPlane.readPublicationStatus({
            authorization,
            publicationAttemptId: publication.publicationAttemptId,
          });
        if (!status.terminal) {
          pollAfterMs = clampPollDelay(status.pollAfterMs);
          continue;
        }
        return finishPublication({
          state,
          executionId: execution.executionId,
          publicationAttemptId: publication.publicationAttemptId,
          partial,
          failureCode: partialFailureCode,
          outcome: status.outcome,
        });
      }

      state = evolveReviewOrchestration(state, {
        type: ReviewOrchestrationEventType.Failed,
      });
      return {
        status: ReviewOrchestrationResultStatus.Failed,
        state,
        executionId: execution.executionId,
        publicationAttemptId: publication.publicationAttemptId,
        failureCode: 'publication_poll_exhausted',
      };
    } catch (error) {
      if (error instanceof ReviewExecutionSupersededSignal) {
        if (authorization && execution) {
          await this.dependencies.controlPlane.supersedeExecution({
            authorization,
            idempotencyKey: this.idempotencyKey('supersede', [
              execution.executionId,
              execution.streamVersion,
              command.reviewRevisionHash,
              error.currentRevisionHash,
            ]),
            execution,
            targetRevisionHash: error.currentRevisionHash,
          });
        }
        if (!isTerminal(state.phase)) {
          state = evolveReviewOrchestration(state, {
            type: ReviewOrchestrationEventType.Superseded,
          });
        }
        return {
          status: ReviewOrchestrationResultStatus.Superseded,
          state,
          ...(execution ? { executionId: execution.executionId } : {}),
        };
      }
      if (!isTerminal(state.phase)) {
        state = evolveReviewOrchestration(state, {
          type: ReviewOrchestrationEventType.Failed,
        });
      }
      return {
        status: ReviewOrchestrationResultStatus.Failed,
        state,
        ...(execution ? { executionId: execution.executionId } : {}),
        failureCode: safeFailureCode(error),
      };
    }
  }

  private async satisfyWorkSlot(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly execution: ReviewExecutionAdmission;
    readonly workSlot: ReviewWorkSlotPlan;
    readonly planHash: string;
    readonly ownerIdHash: string;
    readonly revision: ReviewRevisionFacts;
    readonly restoredSlot: RestoredReviewWorkSlot;
    readonly busyPollsByProviderLane: Map<string, number>;
    readonly onEvent: (event: {
      readonly type:
        | ReviewOrchestrationEventType.SlotLookupStarted
        | ReviewOrchestrationEventType.SlotLeaseAcquired
        | ReviewOrchestrationEventType.SlotSatisfied
        | ReviewOrchestrationEventType.SlotExhausted;
      readonly workSlotId: string;
    }) => void;
  }): Promise<{
    readonly observation?: AcceptedReviewObservation;
    readonly coverageManifest?: ReviewPromptCoverageManifest;
    readonly exhaustionReason?: ReviewWorkSlotExhaustionReason;
    readonly streamVersion: string;
  }> {
    let streamVersion = input.execution.streamVersion;
    for (
      let attemptOrdinal = 1;
      attemptOrdinal <= input.workSlot.attemptBudget;
      attemptOrdinal += 1
    ) {
      await this.assertRevisionCurrent(input.revision);
      input.onEvent({
        type: ReviewOrchestrationEventType.SlotLookupStarted,
        workSlotId: input.workSlot.workSlotId,
      });
      const invocation = await this.dependencies.invocations.prepare({
        workSlot: input.workSlot,
        attemptOrdinal,
      });
      const manifest =
        await this.dependencies.invocationManifestAssembler.assemble(
          invocation
        );
      validateManifest(manifest);
      if (
        manifest.providerVoteIdentityHash !==
          input.workSlot.providerVoteIdentityHash ||
        invocation.workSlotId !== input.workSlot.workSlotId ||
        invocation.attemptOrdinal !== attemptOrdinal
      ) {
        throw new Error('review_orchestration_manifest_scope_mismatch');
      }
      const reused = await this.trySatisfyFromLookup({
        ...input,
        execution: { ...input.execution, streamVersion },
        manifest,
      });
      if (reused) {
        return {
          observation: reused.observation,
          coverageManifest: invocation.coverageManifest,
          streamVersion: reused.streamVersion,
        };
      }
      if (input.restoredSlot.state === RestoredReviewWorkSlotState.Satisfied) {
        throw new Error(
          'review_orchestration_restored_observation_unavailable'
        );
      }

      const acquireRequestId = this.identity('acquire-request', [
        input.execution.executionId,
        input.workSlot.workSlotId,
        String(attemptOrdinal),
        manifest.providerInvocationKey,
      ]);
      let lease: ReviewInvocationLease | null = null;
      let localBusyPollCount = 0;
      while (lease === null) {
        const providerLaneBusyPollCount =
          input.busyPollsByProviderLane.get(
            input.workSlot.providerVoteIdentityHash
          ) ?? 0;
        if (providerLaneBusyPollCount >= this.maxBusyPollsPerProviderLane) {
          input.onEvent({
            type: ReviewOrchestrationEventType.SlotExhausted,
            workSlotId: input.workSlot.workSlotId,
          });
          return {
            streamVersion,
            exhaustionReason: ReviewWorkSlotExhaustionReason.ProviderLaneBusy,
          };
        }
        if (localBusyPollCount > 0) {
          await this.dependencies.delay.sleep(
            Math.min(5_000, 500 * 2 ** Math.min(localBusyPollCount - 1, 4))
          );
          await this.assertRevisionCurrent(input.revision);
          const joined = await this.trySatisfyFromLookup({
            ...input,
            execution: { ...input.execution, streamVersion },
            manifest,
          });
          if (joined) {
            return {
              observation: joined.observation,
              coverageManifest: invocation.coverageManifest,
              streamVersion: joined.streamVersion,
            };
          }
        }
        const acquire =
          await this.dependencies.controlPlane.acquireInvocationLease({
            authorization: input.authorization,
            idempotencyKey: this.idempotencyKey('lease-acquire', [
              input.execution.executionId,
              input.workSlot.workSlotId,
              acquireRequestId,
            ]),
            execution: { ...input.execution, streamVersion },
            workSlot: input.workSlot,
            manifest,
            acquireRequestId,
            ownerIdHash: input.ownerIdHash,
          });
        if (
          acquire.status === ReviewInvocationLeaseAcquireOutcomeStatus.Acquired
        ) {
          lease = acquire.lease;
          continue;
        }
        if (acquire.status === ReviewInvocationLeaseAcquireOutcomeStatus.Busy) {
          input.busyPollsByProviderLane.set(
            input.workSlot.providerVoteIdentityHash,
            providerLaneBusyPollCount + 1
          );
          localBusyPollCount += 1;
          continue;
        }
        if (
          acquire.status ===
          ReviewInvocationLeaseAcquireOutcomeStatus.AttemptBudgetExhausted
        ) {
          input.onEvent({
            type: ReviewOrchestrationEventType.SlotExhausted,
            workSlotId: input.workSlot.workSlotId,
          });
          return {
            streamVersion,
            exhaustionReason:
              ReviewWorkSlotExhaustionReason.AttemptBudgetExhausted,
          };
        }
        if (
          acquire.status ===
          ReviewInvocationLeaseAcquireOutcomeStatus.NotRunnable
        ) {
          await this.assertRevisionCurrent(input.revision);
          input.onEvent({
            type: ReviewOrchestrationEventType.SlotExhausted,
            workSlotId: input.workSlot.workSlotId,
          });
          return {
            streamVersion,
            exhaustionReason: ReviewWorkSlotExhaustionReason.NotRunnable,
          };
        }
      }
      input.onEvent({
        type: ReviewOrchestrationEventType.SlotLeaseAcquired,
        workSlotId: input.workSlot.workSlotId,
      });

      await this.assertRevisionCurrent(input.revision);

      let observationPayload;
      try {
        observationPayload = await this.dependencies.leaseSupervisor.run({
          lease,
          renew: async () => {
            lease = await this.renewLease(lease!, input.ownerIdHash);
            return lease;
          },
          operation: (signal, currentLease) =>
            this.executeInvocationWithRevisionWatch({
              authorization: input.authorization,
              execution: input.execution,
              workSlot: input.workSlot,
              ownerIdHash: input.ownerIdHash,
              invocation,
              manifest,
              currentLease,
              sourceExecutionId: input.execution.executionId,
              signal,
              revision: input.revision,
            }),
        });
        if (
          invocation.manifestFacts.executionProfile !== 'context_gateway_v1'
        ) {
          await this.assertRevisionCurrent(input.revision);
        }
      } catch (error) {
        if (error instanceof ReviewExecutionSupersededSignal) {
          await this.releaseLease(lease, input.ownerIdHash, attemptOrdinal);
          throw error;
        }
        if (
          error instanceof RetryableReviewContextInspectionFailure &&
          attemptOrdinal === input.workSlot.attemptBudget
        ) {
          observationPayload = error.currentRevisionObservation;
        } else {
          await this.releaseLease(lease, input.ownerIdHash, attemptOrdinal);
          const failureClass =
            this.dependencies.invocationFailureClassifier.classify(error);
          try {
            this.dependencies.invocationDiagnostics?.recordFailure({
              invocation,
              attemptBudget: input.workSlot.attemptBudget,
              failureClass,
              error,
            });
          } catch {
            // Diagnostics must never change review retry or safety decisions.
          }
          if (
            failureClass === ReviewInvocationFailureClass.CapacityUnavailable
          ) {
            throw new ReviewProviderUnavailableSignal(
              'provider_capacity_unavailable'
            );
          }
          if (
            failureClass ===
            ReviewInvocationFailureClass.AuthenticationUnavailable
          ) {
            throw new ReviewProviderUnavailableSignal(
              'provider_authentication_unavailable'
            );
          }
          continue;
        }
      }
      try {
        validateObservationAgainstLimits(
          observationPayload,
          input.authorization.limits
        );
        const committed = await this.dependencies.controlPlane.commitEvidence({
          authorization: input.authorization,
          idempotencyKey: this.idempotencyKey('evidence-commit', [
            lease.attemptId,
            observationPayload.payloadHash,
          ]),
          lease,
          ownerIdHash: input.ownerIdHash,
          observation: observationPayload,
        });
        await this.assertRevisionCurrent(input.revision);
        // historicalOnly only disables future cross-revision reuse. The current
        // revision can still safely publish the fresh observation after the
        // revision guard above.
        const observation: AcceptedReviewObservation = {
          ...observationPayload,
          observationId: committed.observationId,
          eligibilityPolicyVersion: committed.eligibilityPolicyVersion,
          providerKind: input.workSlot.providerKind,
          providerInvocationKey: manifest.providerInvocationKey,
          providerVoteIdentityHash: manifest.providerVoteIdentityHash,
        };
        const attached = await this.dependencies.controlPlane.attachObservation(
          {
            authorization: input.authorization,
            idempotencyKey: this.idempotencyKey('attach', [
              input.execution.executionId,
              input.workSlot.workSlotId,
              observation.observationId,
            ]),
            execution: { ...input.execution, streamVersion },
            workSlot: input.workSlot,
            observation,
            attachmentCapability: lease.leaseCapability,
          }
        );
        streamVersion = attached.streamVersion;
        input.onEvent({
          type: ReviewOrchestrationEventType.SlotSatisfied,
          workSlotId: input.workSlot.workSlotId,
        });
        return {
          observation,
          coverageManifest: invocation.coverageManifest,
          streamVersion,
        };
      } finally {
        await this.releaseLease(lease, input.ownerIdHash, attemptOrdinal);
      }
    }

    input.onEvent({
      type: ReviewOrchestrationEventType.SlotExhausted,
      workSlotId: input.workSlot.workSlotId,
    });
    return {
      streamVersion,
      exhaustionReason:
        ReviewWorkSlotExhaustionReason.ProviderAttemptsExhausted,
    };
  }

  private async trySatisfyFromLookup(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly execution: ReviewExecutionAdmission;
    readonly workSlot: ReviewWorkSlotPlan;
    readonly planHash: string;
    readonly manifest: ProviderInvocationManifest;
    readonly revision: ReviewRevisionFacts;
    readonly restoredSlot: RestoredReviewWorkSlot;
    readonly onEvent: (event: {
      readonly type: ReviewOrchestrationEventType.SlotSatisfied;
      readonly workSlotId: string;
    }) => void;
  }): Promise<{
    readonly observation: AcceptedReviewObservation;
    readonly streamVersion: string;
  } | null> {
    const lookup = await this.dependencies.controlPlane.lookupEvidence({
      authorization: input.authorization,
      execution: input.execution,
      workSlot: input.workSlot,
      planHash: input.planHash,
      manifest: input.manifest,
    });
    if (lookup.kind === ReviewEvidenceLookupKind.Miss) return null;

    await this.assertRevisionCurrent(input.revision);
    validateObservationAgainstLimits(
      lookup.observation,
      input.authorization.limits
    );

    let streamVersion = input.execution.streamVersion;
    if (lookup.kind === ReviewEvidenceLookupKind.ReplayRequired) {
      const replayed = await this.replayCandidate({
        authorization: input.authorization,
        execution: input.execution,
        workSlot: input.workSlot,
        revision: input.revision,
        candidate: lookup,
      });
      if (!replayed) return null;
      await this.assertRevisionCurrent(input.revision);
      const attached = await this.dependencies.controlPlane.attachObservation({
        authorization: input.authorization,
        idempotencyKey: this.idempotencyKey('attach-replayed', [
          input.execution.executionId,
          input.workSlot.workSlotId,
          lookup.observation.observationId,
          lookup.attestationId,
          input.revision.reviewRevisionHash,
        ]),
        execution: input.execution,
        workSlot: input.workSlot,
        observation: lookup.observation,
        attachmentCapability: replayed.attachmentCapability,
      });
      streamVersion = attached.streamVersion;
    } else if (
      input.restoredSlot.state === RestoredReviewWorkSlotState.Satisfied
    ) {
      if (
        input.restoredSlot.acceptedObservationRefId !==
        observationRefId(
          input.execution.executionId,
          input.workSlot.workSlotId,
          lookup.observation.observationId
        )
      ) {
        throw new Error(
          'review_orchestration_restored_observation_identity_mismatch'
        );
      }
    } else if (lookup.attachment.kind === 'exact_revision_reuse') {
      const attached = await this.dependencies.controlPlane.attachObservation({
        authorization: input.authorization,
        idempotencyKey: this.idempotencyKey('attach', [
          input.execution.executionId,
          input.workSlot.workSlotId,
          lookup.observation.observationId,
        ]),
        execution: input.execution,
        workSlot: input.workSlot,
        observation: lookup.observation,
        attachmentCapability: lookup.attachment.capability,
      });
      streamVersion = attached.streamVersion;
    } else {
      const latestExecution =
        await this.dependencies.controlPlane.restoreExecution({
          authorization: input.authorization,
          reviewRevisionHash: input.revision.reviewRevisionHash,
        });
      const adoptionExecution = refreshExecutionAdmission(
        input.execution,
        latestExecution
      );
      const adopted = await this.dependencies.controlPlane.adoptObservation({
        authorization: input.authorization,
        idempotencyKey: this.idempotencyKey('adopt', [
          input.execution.executionId,
          input.workSlot.workSlotId,
          lookup.observation.observationId,
          lookup.attachment.sourceLeaseId,
          lookup.attachment.sourceFencingToken,
        ]),
        execution: adoptionExecution,
        workSlot: input.workSlot,
        planHash: input.planHash,
        manifest: input.manifest,
        observation: lookup.observation,
        source: lookup.attachment,
      });
      streamVersion = adopted.streamVersion;
    }

    input.onEvent({
      type: ReviewOrchestrationEventType.SlotSatisfied,
      workSlotId: input.workSlot.workSlotId,
    });
    return { observation: lookup.observation, streamVersion };
  }

  private async replayCandidate(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly execution: ReviewExecutionAdmission;
    readonly workSlot: ReviewWorkSlotPlan;
    readonly revision: ReviewRevisionFacts;
    readonly candidate: Extract<
      Awaited<ReturnType<ReviewActionV2ControlPlanePort['lookupEvidence']>>,
      { readonly kind: ReviewEvidenceLookupKind.ReplayRequired }
    >;
  }): Promise<{ readonly attachmentCapability: string } | null> {
    if (
      !this.dependencies.contextReplay ||
      !this.dependencies.contextAttestations
    ) {
      return null;
    }
    try {
      const replay = await this.dependencies.contextReplay.replay({
        candidate: input.candidate,
        targetRevision: input.revision,
      });
      if (!replay) return null;
      await this.assertRevisionCurrent(input.revision);
      return this.dependencies.contextAttestations.commitContextReplay({
        authorization: input.authorization,
        execution: input.execution,
        workSlot: input.workSlot,
        candidate: input.candidate,
        result: replay,
      });
    } catch {
      return null;
    }
  }

  private async renewLease(
    lease: ReviewInvocationLease,
    ownerIdHash: string
  ): Promise<ReviewInvocationLease> {
    const renewRequestId = this.identity('lease-renew-request', [
      lease.leaseId,
      lease.fencingToken,
      lease.expiresAt,
    ]);
    const renewed = await this.dependencies.controlPlane.renewInvocationLease({
      idempotencyKey: this.idempotencyKey('lease-renew', [
        lease.leaseId,
        lease.fencingToken,
        renewRequestId,
      ]),
      lease,
      ownerIdHash,
      renewRequestId,
    });
    if (
      renewed.leaseId !== lease.leaseId ||
      renewed.attemptId !== lease.attemptId ||
      renewed.resultReportUntil !== lease.resultReportUntil ||
      renewed.fencingToken !== lease.fencingToken ||
      (renewed.renewalCeilingReached
        ? renewed.expiresAt !== lease.expiresAt
        : Date.parse(renewed.expiresAt) <= Date.parse(lease.expiresAt))
    ) {
      throw new Error('review_orchestration_lease_renewal_drift');
    }
    return renewed;
  }

  private async assertRevisionCurrent(
    expectedRevision: ReviewRevisionFacts
  ): Promise<void> {
    const currentRevision =
      await this.dependencies.revisionGuard.loadCurrentRevision();
    if (!sameRevisionFacts(currentRevision, expectedRevision)) {
      throw new ReviewExecutionSupersededSignal(
        currentRevision.reviewRevisionHash
      );
    }
  }

  private async executeInvocationWithRevisionWatch(input: {
    readonly signal: AbortSignal;
    readonly invocation: PreparedReviewInvocation;
    readonly manifest: ProviderInvocationManifest;
    readonly currentLease: () => ReviewInvocationLease;
    readonly authorization: ReviewRunAuthorization;
    readonly execution: ReviewExecutionAdmission;
    readonly workSlot: ReviewWorkSlotPlan;
    readonly ownerIdHash: string;
    readonly sourceExecutionId: string;
    readonly revision: ReviewRevisionFacts;
  }): Promise<ReviewObservationPayload> {
    const abort = new AbortController();
    let stopped = false;
    const relayLeaseAbort = () => abort.abort(input.signal.reason);
    if (input.signal.aborted) relayLeaseAbort();
    else
      input.signal.addEventListener('abort', relayLeaseAbort, { once: true });
    const investigate =
      this.dependencies.investigationRecording?.supports({
        workSlot: input.workSlot,
        invocation: input.invocation,
      }) ?? false;
    const drainOnSupersession =
      !investigate &&
      input.invocation.manifestFacts.executionProfile === 'context_gateway_v1';
    const monitor = async () => {
      if (drainOnSupersession) return;
      while (!stopped && !abort.signal.aborted) {
        await this.dependencies.delay.sleep(this.revisionPollIntervalMs);
        if (stopped || abort.signal.aborted) return;
        try {
          await this.assertRevisionCurrent(input.revision);
        } catch (error) {
          if (error instanceof ReviewExecutionSupersededSignal) {
            abort.abort(error);
            return;
          }
        }
      }
    };
    void monitor();
    try {
      if (investigate) {
        const investigationObservation =
          await this.dependencies.investigationRecording!.execute({
            authorization: input.authorization,
            execution: input.execution,
            workSlot: input.workSlot,
            invocation: input.invocation,
            manifest: input.manifest,
            currentLease: input.currentLease,
            ownerIdHash: input.ownerIdHash,
            sourceReviewRevisionHash: input.revision.reviewRevisionHash,
            signal: abort.signal,
          });
        if (
          this.dependencies.investigationRecording!.mode ===
          ReviewInvestigationRecordingMode.Authoritative
        ) {
          return investigationObservation;
        }
      }
      return await this.dependencies.invocations.execute({
        invocation: input.invocation,
        manifest: input.manifest,
        lease: input.currentLease(),
        sourceExecutionId: input.sourceExecutionId,
        sourceReviewRevisionHash: input.revision.reviewRevisionHash,
        signal: abort.signal,
      });
    } catch (error) {
      if (abort.signal.reason instanceof ReviewExecutionSupersededSignal) {
        throw abort.signal.reason;
      }
      throw error;
    } finally {
      stopped = true;
      input.signal.removeEventListener('abort', relayLeaseAbort);
    }
  }

  private async releaseLease(
    lease: ReviewInvocationLease,
    ownerIdHash: string,
    attemptOrdinal: number
  ): Promise<void> {
    const releaseRequestId = this.identity('lease-release-request', [
      lease.leaseId,
      lease.fencingToken,
      String(attemptOrdinal),
    ]);
    try {
      await this.dependencies.controlPlane.releaseInvocationLease({
        idempotencyKey: this.idempotencyKey('lease-release', [
          lease.leaseId,
          lease.fencingToken,
          releaseRequestId,
        ]),
        lease,
        ownerIdHash,
        releaseRequestId,
      });
    } catch {
      // Expiry is the safety fallback; release is cleanup after durable reporting.
    }
  }

  private idempotencyKey(namespace: string, parts: readonly string[]): string {
    return this.identity(`idempotency-${namespace}`, parts);
  }

  private identity(namespace: string, parts: readonly string[]): string {
    return this.dependencies.identities.deterministicId(namespace, parts);
  }
}

function finishPublication(input: {
  readonly state: ReviewOrchestrationState;
  readonly executionId: string;
  readonly publicationAttemptId: string;
  readonly partial: boolean;
  readonly failureCode?: string;
  readonly outcome: {
    readonly state: ReviewPublicationState;
    readonly canonicalReceiptSetHash?: string;
  };
}): ReviewOrchestrationResult {
  if (input.outcome.state === ReviewPublicationState.TerminalUnknown) {
    const state = evolveReviewOrchestration(input.state, {
      type: ReviewOrchestrationEventType.Failed,
    });
    return {
      status: ReviewOrchestrationResultStatus.Failed,
      state,
      executionId: input.executionId,
      publicationAttemptId: input.publicationAttemptId,
      failureCode: 'publication_terminal_unknown',
    };
  }
  const state = evolveReviewOrchestration(input.state, {
    type: ReviewOrchestrationEventType.PublicationCompleted,
    partial: input.partial,
  });
  if (input.outcome.state === ReviewPublicationState.NotApplied) {
    return {
      status: ReviewOrchestrationResultStatus.PublicationNotApplied,
      state,
      executionId: input.executionId,
      publicationAttemptId: input.publicationAttemptId,
    };
  }
  if (
    input.outcome.state === ReviewPublicationState.StaleCompensated ||
    input.outcome.state === ReviewPublicationState.StaleVisible
  ) {
    return {
      status: ReviewOrchestrationResultStatus.PublicationStale,
      state,
      executionId: input.executionId,
      publicationAttemptId: input.publicationAttemptId,
    };
  }
  if (input.outcome.state !== ReviewPublicationState.Succeeded) {
    throw new Error('review_orchestration_publication_terminal_invalid');
  }
  return {
    status: input.partial
      ? ReviewOrchestrationResultStatus.PartialCompleted
      : ReviewOrchestrationResultStatus.Completed,
    state,
    executionId: input.executionId,
    publicationAttemptId: input.publicationAttemptId,
    ...(input.partial && input.failureCode
      ? { failureCode: input.failureCode }
      : {}),
    ...(input.outcome.canonicalReceiptSetHash
      ? { canonicalReceiptSetHash: input.outcome.canonicalReceiptSetHash }
      : {}),
  };
}

function derivePartialFailureCode(input: {
  readonly requiredExhaustedWorkSlotIds: readonly string[];
  readonly exhaustedWorkSlotReasons: ReadonlyMap<
    string,
    ReviewWorkSlotExhaustionReason
  >;
  readonly projectionCoverageComplete: boolean;
}): string | undefined {
  const firstRequiredExhausted = input.requiredExhaustedWorkSlotIds[0];
  if (firstRequiredExhausted) {
    const reason = input.exhaustedWorkSlotReasons.get(firstRequiredExhausted);
    if (reason === ReviewWorkSlotExhaustionReason.ProviderLaneBusy) {
      return 'required_provider_lane_busy';
    }
    return 'required_work_exhausted';
  }
  return input.projectionCoverageComplete
    ? undefined
    : 'required_review_coverage_incomplete';
}

function validateCommand(command: RunT0ReviewOrchestrationCommand): void {
  for (const commitSha of [
    command.baseSha,
    command.mergeBaseSha,
    command.headSha,
  ]) {
    if (!/^[a-f0-9]{40}$/.test(commitSha)) {
      throw new Error('review_orchestration_commit_sha_invalid');
    }
  }
  for (const digest of [
    command.reviewRevisionHash,
    command.compatibilityKey,
    command.planHash,
    command.ownerIdHash,
  ]) {
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error('review_orchestration_digest_invalid');
    }
  }
  if (
    !isCanonicalJson(command.workSlotsCanonicalJson) ||
    command.workSlotsCanonicalJson !==
      canonicalizeReviewWorkSlots(command.workSlots)
  ) {
    throw new Error('review_orchestration_work_slots_not_canonical');
  }
  if (command.workSlots.length === 0) {
    throw new Error('review_orchestration_work_slots_empty');
  }
}

function validateAuthorizationScope(
  command: RunT0ReviewOrchestrationCommand,
  authorization: ReviewRunAuthorization
): void {
  if (
    !sameRevisionFacts(authorization.facts, command) ||
    authorization.producerReleaseId !== authorization.facts.producerReleaseId ||
    command.sourceRunId !== authorization.facts.sourceRunId ||
    command.sourceRunAttempt !== authorization.facts.sourceRunAttempt
  ) {
    throw new Error('review_orchestration_authorization_scope_mismatch');
  }
}

function sameRevision(
  current: ReviewRevisionFacts,
  expected: RunT0ReviewOrchestrationCommand
): boolean {
  return sameRevisionFacts(current, expected);
}

function sameRevisionFacts(
  left: ReviewRevisionFacts,
  right: ReviewRevisionFacts
): boolean {
  return (
    left.baseSha === right.baseSha &&
    left.mergeBaseSha === right.mergeBaseSha &&
    left.headSha === right.headSha &&
    left.reviewRevisionHash === right.reviewRevisionHash
  );
}

function validateRestoredExecutionContinuity(
  restored: RestoredReviewExecution | null,
  admitted: ReviewExecutionAdmission
): void {
  if (!restored || restored.executionId !== admitted.executionId) return;
  if (
    restored.generation !== admitted.generation ||
    restored.authorizationId !== admitted.restoredExecution.authorizationId ||
    restored.reviewRevisionHash !==
      admitted.restoredExecution.reviewRevisionHash ||
    restored.planHash !== admitted.restoredExecution.planHash ||
    !sameRestoredWorkSlotPlan(
      restored.workSlots,
      admitted.restoredExecution.workSlots
    ) ||
    BigInt(admitted.executionVersion) < BigInt(restored.version) ||
    BigInt(admitted.streamVersion) < BigInt(restored.streamVersion) ||
    (admitted.executionVersion === restored.version &&
      admitted.streamVersion === restored.streamVersion &&
      !sameRestoredExecutionSnapshot(restored, admitted.restoredExecution))
  ) {
    throw new Error('review_orchestration_restored_execution_drift');
  }
}

function sameRestoredExecutionSnapshot(
  left: RestoredReviewExecution,
  right: RestoredReviewExecution
): boolean {
  return (
    left.state === right.state &&
    JSON.stringify(canonicalize(left.workSlots)) ===
      JSON.stringify(canonicalize(right.workSlots))
  );
}

function refreshExecutionAdmission(
  admitted: ReviewExecutionAdmission,
  restored: RestoredReviewExecution | null
): ReviewExecutionAdmission {
  if (
    !restored ||
    restored.executionId !== admitted.executionId ||
    restored.generation !== admitted.generation ||
    restored.authorizationId !== admitted.restoredExecution.authorizationId ||
    restored.reviewRevisionHash !==
      admitted.restoredExecution.reviewRevisionHash ||
    restored.planHash !== admitted.restoredExecution.planHash ||
    !sameRestoredWorkSlotPlan(
      restored.workSlots,
      admitted.restoredExecution.workSlots
    ) ||
    BigInt(restored.version) < BigInt(admitted.executionVersion) ||
    BigInt(restored.streamVersion) < BigInt(admitted.streamVersion)
  ) {
    throw new Error('review_orchestration_execution_refresh_invalid');
  }
  return Object.freeze({
    ...admitted,
    generation: restored.generation,
    streamVersion: restored.streamVersion,
    executionVersion: restored.version,
    restoredExecution: restored,
  });
}

function sameRestoredWorkSlotPlan(
  current: readonly RestoredReviewWorkSlot[],
  admitted: readonly RestoredReviewWorkSlot[]
): boolean {
  const currentById = new Map(current.map((slot) => [slot.workSlotId, slot]));
  return (
    currentById.size === admitted.length &&
    admitted.every((slot) => {
      const latest = currentById.get(slot.workSlotId);
      return (
        latest?.required === slot.required &&
        latest.providerVoteIdentityHash === slot.providerVoteIdentityHash
      );
    })
  );
}

function observationRefId(
  executionId: string,
  workSlotId: string,
  observationId: string
): string {
  return `obsref:${sha256(
    JSON.stringify(canonicalize({ executionId, observationId, workSlotId }))
  )}`;
}

export function canonicalizeReviewWorkSlots(
  workSlots: readonly ReviewWorkSlotPlan[]
): string {
  return JSON.stringify(
    [...workSlots]
      .sort((left, right) =>
        compareCodePoints(left.workSlotId, right.workSlotId)
      )
      .map((slot) => ({
        attemptBudget: slot.attemptBudget,
        providerKind: slot.providerKind,
        providerVoteIdentityHash: slot.providerVoteIdentityHash,
        required: slot.required,
        retryPolicyVersion: slot.retryPolicyVersion,
        shardKey: slot.shardKey,
        taskKind: slot.taskKind,
        workSlotId: slot.workSlotId,
      }))
  );
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validatePlanAgainstLimits(
  workSlots: readonly ReviewWorkSlotPlan[],
  limits: ReviewProtocolLimits
): void {
  if (workSlots.length > limits.maxWorkSlots) {
    throw new Error('review_orchestration_work_slot_limit_exceeded');
  }
  for (const slot of workSlots) {
    if (
      !Number.isSafeInteger(slot.attemptBudget) ||
      slot.attemptBudget < 1 ||
      slot.attemptBudget > limits.maxAttemptsPerSlot
    ) {
      throw new Error('review_orchestration_attempt_limit_exceeded');
    }
  }
}

function validateObservationAgainstLimits(
  observation: {
    readonly payloadCanonicalJson: string;
    readonly payloadHash: string;
    readonly byteCount: number;
    readonly findingCount: number;
  },
  limits: ReviewProtocolLimits
): void {
  if (
    !isCanonicalJson(observation.payloadCanonicalJson) ||
    sha256(observation.payloadCanonicalJson) !== observation.payloadHash ||
    Buffer.byteLength(observation.payloadCanonicalJson, 'utf8') !==
      observation.byteCount ||
    observation.byteCount < 0 ||
    observation.byteCount > limits.maxObservationBytes ||
    observation.findingCount < 0 ||
    observation.findingCount > limits.maxObservationFindings
  ) {
    throw new Error('review_orchestration_observation_limit_exceeded');
  }
}

function validateProjectionAgainstLimits(
  projection: {
    readonly projectionEnvelopeCanonicalJson: string;
    readonly operationsCanonicalJson: string;
    readonly findingCount: number;
    readonly publicationOperationCount: number;
    readonly publicationChunkCount: number;
  },
  limits: ReviewProtocolLimits
): void {
  if (
    Buffer.byteLength(projection.projectionEnvelopeCanonicalJson, 'utf8') >
      limits.maxProjectionBytes ||
    projection.findingCount > limits.maxProjectionFindings ||
    Buffer.byteLength(projection.operationsCanonicalJson, 'utf8') >
      limits.maxPublicationBodyBytes ||
    projection.publicationOperationCount > limits.maxPublicationOperations ||
    projection.publicationChunkCount > limits.maxPublicationChunks ||
    !isCanonicalJson(projection.projectionEnvelopeCanonicalJson) ||
    !isCanonicalJson(projection.operationsCanonicalJson)
  ) {
    throw new Error('review_orchestration_projection_limit_exceeded');
  }
}

function validateManifest(manifest: {
  readonly manifestCanonicalJson: string;
  readonly manifestKey: string;
  readonly providerInvocationKey: string;
  readonly providerVoteIdentityHash: string;
}): void {
  if (
    !isCanonicalJson(manifest.manifestCanonicalJson) ||
    ![
      manifest.manifestKey,
      manifest.providerInvocationKey,
      manifest.providerVoteIdentityHash,
    ].every((digest) => /^[a-f0-9]{64}$/.test(digest))
  ) {
    throw new Error('review_orchestration_manifest_invalid');
  }
}

function clampPollDelay(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 1000;
  return Math.min(Math.max(Math.floor(value), 100), 30_000);
}

function isCanonicalJson(value: string): boolean {
  try {
    return JSON.stringify(canonicalize(JSON.parse(value))) === value;
  } catch {
    return false;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          canonicalize((value as Record<string, unknown>)[key]),
        ])
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown_failure';
  return /^[a-z0-9_:-]{1,120}$/.test(error.message)
    ? error.message
    : 'review_orchestration_failed';
}

function isTerminal(phase: ReviewOrchestrationPhase): boolean {
  return (
    phase === ReviewOrchestrationPhase.Completed ||
    phase === ReviewOrchestrationPhase.PartialCompleted ||
    phase === ReviewOrchestrationPhase.Superseded ||
    phase === ReviewOrchestrationPhase.Failed
  );
}

class ReviewExecutionSupersededSignal extends Error {
  constructor(readonly currentRevisionHash: string) {
    super('review_orchestration_superseded');
  }
}

class ReviewProviderUnavailableSignal extends Error {
  constructor(failureCode: string) {
    super(failureCode);
  }
}
