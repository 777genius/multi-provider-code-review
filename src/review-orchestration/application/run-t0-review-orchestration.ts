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
  ReviewPublicationUnavailableFact,
  ReviewPublicationState,
  ReviewInvestigationRecordingMode,
  ReviewInvestigationDiagnosticOutcome,
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
  type ReviewInvestigationDiagnosticsPort,
  type ReviewOidcTokenPort,
  type ReviewOrchestrationClockPort,
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
import {
  ReviewInvocationConfigurationMismatchError,
  ReviewInvocationConfigurationMismatchReason,
} from './review-invocation-failure';
import {
  ReviewInvestigationDeferredSignal,
  ReviewInvestigationLegacyFallbackSignal,
} from '../../review-investigation/application/run-investigation-work-slot';
import type { MergeGateConclusion } from '../../review-projection/domain';
import type { ExecutionDeadline } from '../../review-execution/domain/execution-deadline';

export enum ReviewOrchestrationResultStatus {
  Completed = 'completed',
  PartialCompleted = 'partial_completed',
  Superseded = 'superseded',
  PublicationNotApplied = 'publication_not_applied',
  PublicationStale = 'publication_stale',
  PublicationUnavailable = 'publication_unavailable',
  Failed = 'failed',
}

const MAX_PRE_EXECUTION_AUTHORIZATION_TTL_MS = 6 * 60 * 60_000;
const MIN_PRE_EXECUTION_AUTHORIZATION_VALIDITY_MS =
  3 * 60 * 60_000 + 5 * 60_000;
const PUBLICATION_AUTHORIZATION_RESERVE_MS = 5 * 60_000;
const PUBLICATION_HORIZON_MULTIPLIER = 2;
const FINAL_PUBLICATION_STATUS_RESERVE_MS = 30_000;
const MIN_PUBLICATION_POLL_DELAY_MS = 1_000;

export type RunT0ReviewOrchestrationCommand = {
  readonly executionId: string;
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly headSha: string;
  readonly reviewRevisionHash: string;
  readonly compatibilityKey: string;
  readonly planHash: string;
  readonly workSlotsCanonicalJson: string;
  readonly assignmentManifestCanonicalJson: string;
  readonly assignmentManifestHash: string;
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
  readonly unavailablePublicationFacts?: readonly ReviewPublicationUnavailableFact[];
  readonly mergeGateConclusion?: MergeGateConclusion;
};

enum ReviewWorkSlotExhaustionReason {
  AttemptBudgetExhausted = 'attempt_budget_exhausted',
  NotRunnable = 'not_runnable',
  ProviderAttemptsExhausted = 'provider_attempts_exhausted',
  ProviderLaneBusy = 'provider_lane_busy',
  InvestigationDeferred = 'investigation_deferred',
  RestoredTerminal = 'restored_terminal',
  DeadlineReached = 'deadline_reached',
}

export type RunT0ReviewOrchestrationDependencies = {
  readonly controlPlane: ReviewActionV2ControlPlanePort;
  readonly revisionGuard: ReviewRevisionGuardPort;
  readonly oidc: ReviewOidcTokenPort;
  readonly invocationManifestAssembler: ProviderInvocationManifestAssemblerPort;
  readonly invocations: PreparedReviewInvocationPort;
  readonly investigationInvocations?: PreparedReviewInvocationPort;
  readonly invocationFailureClassifier: ReviewInvocationFailureClassifierPort;
  readonly invocationDiagnostics?: ReviewInvocationDiagnosticsPort;
  readonly investigationRecording?: ReviewInvestigationRecordingPort;
  readonly investigationDiagnostics?: ReviewInvestigationDiagnosticsPort;
  readonly leaseSupervisor: ReviewInvocationLeaseSupervisorPort;
  readonly projectionBuilder: CurrentReviewProjectionBuilderPort;
  readonly contextReplay?: ContextDependencyReplayPort;
  readonly contextAttestations?: ReviewContextAttestationPort;
  readonly identities: ReviewOrchestrationIdentityPort;
  readonly clock: ReviewOrchestrationClockPort;
  readonly delay: ReviewOrchestrationDelayPort;
  readonly executionDeadline?: ExecutionDeadline;
  readonly progress?: ReviewOrchestrationProgressPort;
};

export interface ReviewOrchestrationProgressPort {
  report(
    event: Readonly<
      | { type: 'initialized'; workSlots: readonly ReviewWorkSlotPlan[] }
      | { type: 'running'; workSlotId: string; attemptOrdinal: number }
      | { type: 'accepted'; workSlotId: string; attemptOrdinal: number }
      | { type: 'exhausted'; workSlotId: string }
      | { type: 'assembling' }
      | { type: 'publishing' }
    >
  ): void;
}

export class RunT0ReviewOrchestration {
  constructor(
    private readonly dependencies: RunT0ReviewOrchestrationDependencies,
    private readonly maxPublicationPolls: number | null = null,
    private readonly maxBusyPollsPerProviderLane = 24,
    private readonly revisionPollIntervalMs = 5_000
  ) {
    if (
      maxPublicationPolls !== null &&
      (!Number.isSafeInteger(maxPublicationPolls) || maxPublicationPolls < 1)
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

      const preExecutionRenewal = await this.renewAuthorization({
        authorization,
        command,
        phase: 'pre-execution',
        requestedTtlMs: MAX_PRE_EXECUTION_AUTHORIZATION_TTL_MS,
      });
      authorization = preExecutionRenewal.authorization;
      if (
        preExecutionRenewal.validForMsAtResponse <
        MIN_PRE_EXECUTION_AUTHORIZATION_VALIDITY_MS
      ) {
        throw new Error(
          'review_orchestration_execution_authorization_window_insufficient'
        );
      }

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
        assignmentManifestCanonicalJson:
          command.assignmentManifestCanonicalJson,
        assignmentManifestHash: command.assignmentManifestHash,
        workSlots: command.workSlots,
        sourceRunId: command.sourceRunId,
        sourceRunAttempt: command.sourceRunAttempt,
      });
      this.dependencies.progress?.report({
        type: 'initialized',
        workSlots: command.workSlots,
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
          !this.canStartBatch()
        ) {
          exhaustedWorkSlotIds.push(workSlot.workSlotId);
          exhaustedWorkSlotReasons.set(
            workSlot.workSlotId,
            ReviewWorkSlotExhaustionReason.DeadlineReached
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
          this.dependencies.progress?.report({
            type: 'accepted',
            workSlotId: workSlot.workSlotId,
            attemptOrdinal: outcome.attemptOrdinal ?? 1,
          });
        } else {
          exhaustedWorkSlotIds.push(workSlot.workSlotId);
          if (outcome.exhaustionReason) {
            exhaustedWorkSlotReasons.set(
              workSlot.workSlotId,
              outcome.exhaustionReason
            );
          }
          this.dependencies.progress?.report({
            type: 'exhausted',
            workSlotId: workSlot.workSlotId,
          });
          const terminal = terminalizeCommand(outcome.exhaustionReason);
          if (terminal) {
            const terminalized =
              await this.dependencies.controlPlane.terminalizeWorkSlot({
                authorization,
                idempotencyKey: this.idempotencyKey('slot-terminalize', [
                  execution.executionId,
                  execution.generation,
                  workSlot.workSlotId,
                  terminal.terminalState,
                  terminal.reasonCode,
                ]),
                execution,
                reviewRevisionHash: command.reviewRevisionHash,
                workSlotId: workSlot.workSlotId,
                terminal,
              });
            execution = {
              ...execution,
              streamVersion: terminalized.streamVersion,
            };
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
      this.dependencies.progress?.report({ type: 'assembling' });
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
      const publicationHorizonMs = safeMultiplyMilliseconds(
        authorization.limits.maxReconciliationDurationMs,
        PUBLICATION_HORIZON_MULTIPLIER
      );
      const publicationRequiredValidityMs = safeAddMilliseconds(
        publicationHorizonMs,
        FINAL_PUBLICATION_STATUS_RESERVE_MS
      );
      const publicationRenewal = await this.renewAuthorization({
        authorization,
        command,
        phase: 'pre-publication',
        discriminator: projection.projectionHash,
        requestedTtlMs: safeAddMilliseconds(
          publicationHorizonMs,
          PUBLICATION_AUTHORIZATION_RESERVE_MS
        ),
      });
      authorization = publicationRenewal.authorization;
      const publicationRenewalReceivedAtMs = readMonotonicClockMs(
        this.dependencies.clock
      );
      if (
        publicationRenewal.validForMsAtResponse < publicationRequiredValidityMs
      ) {
        throw new Error(
          'review_orchestration_publication_authorization_window_insufficient'
        );
      }
      const latestExecution =
        await this.dependencies.controlPlane.restoreExecution({
          authorization,
          reviewRevisionHash: command.reviewRevisionHash,
        });
      execution = refreshExecutionAdmission(execution, latestExecution);
      validateProjectionAgainstLimits(projection, authorization.limits);
      this.assertExecutionDeadlineAvailable();
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
      this.assertExecutionDeadlineAvailable();
      assertPublicationAuthorizationWindow({
        validForMsAtResponse: publicationRenewal.validForMsAtResponse,
        elapsedMs: elapsedMonotonicMs(
          publicationRenewalReceivedAtMs,
          readMonotonicClockMs(this.dependencies.clock)
        ),
        requiredMs: publicationRequiredValidityMs,
      });
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
      this.dependencies.progress?.report({ type: 'publishing' });
      if (
        publication.status ===
        ReviewPublicationRequestOutcomeStatus.FactsUnavailable
      ) {
        state = evolveReviewOrchestration(state, {
          type: ReviewOrchestrationEventType.Failed,
        });
        return {
          status: ReviewOrchestrationResultStatus.PublicationUnavailable,
          state,
          executionId: execution.executionId,
          failureCode: 'publication_facts_unavailable',
          unavailablePublicationFacts: publication.unavailableFacts,
        };
      }
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
      const elapsedSinceRenewalMs = elapsedMonotonicMs(
        publicationRenewalReceivedAtMs,
        readMonotonicClockMs(this.dependencies.clock)
      );
      const reconciliationBudgetMs = Math.min(
        publicationHorizonMs,
        publicationRenewal.validForMsAtResponse -
          elapsedSinceRenewalMs -
          FINAL_PUBLICATION_STATUS_RESERVE_MS
      );
      if (reconciliationBudgetMs <= 0) {
        throw new Error(
          'review_orchestration_publication_authorization_window_exhausted'
        );
      }
      const publicationWindowMs = Math.min(
        safeAddMilliseconds(
          reconciliationBudgetMs,
          FINAL_PUBLICATION_STATUS_RESERVE_MS
        ),
        this.executionDeadlineRemainingMs()
      );
      if (publicationWindowMs <= 0) {
        throw new ReviewExecutionDeadlineReachedSignal();
      }
      const publicationDeadlineMs = safeAddMilliseconds(
        readMonotonicClockMs(this.dependencies.clock),
        publicationWindowMs
      );
      const publicationPollLimit = calculatePublicationPollLimit({
        hardLimit: this.maxPublicationPolls,
        reconciliationDurationMs: reconciliationBudgetMs,
      });
      for (let poll = 0; poll < publicationPollLimit; poll += 1) {
        const remainingMs =
          publicationDeadlineMs - readMonotonicClockMs(this.dependencies.clock);
        if (remainingMs <= 0) break;
        const delayMs = Math.min(
          clampPollDelay(pollAfterMs),
          Math.max(0, remainingMs - FINAL_PUBLICATION_STATUS_RESERVE_MS)
        );
        if (delayMs > 0) await this.dependencies.delay.sleep(delayMs);
        const requestBudgetMs = Math.floor(
          publicationDeadlineMs - readMonotonicClockMs(this.dependencies.clock)
        );
        if (requestBudgetMs <= 0) break;
        const status =
          await this.dependencies.controlPlane.readPublicationStatus({
            authorization,
            publicationAttemptId: publication.publicationAttemptId,
            timeoutMs: requestBudgetMs,
          });
        if (!status.terminal) {
          if (
            publicationDeadlineMs -
              readMonotonicClockMs(this.dependencies.clock) <=
            FINAL_PUBLICATION_STATUS_RESERVE_MS
          ) {
            break;
          }
          pollAfterMs = clampPollDelay(status.pollAfterMs);
          continue;
        }
        return finishPublication({
          state,
          executionId: execution.executionId,
          publicationAttemptId: publication.publicationAttemptId,
          partial,
          failureCode: partialFailureCode,
          mergeGateConclusion: projection.mergeGateConclusion,
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

  private async renewAuthorization(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly command: RunT0ReviewOrchestrationCommand;
    readonly phase: string;
    readonly discriminator?: string;
    readonly requestedTtlMs: number;
  }) {
    // T0 renewal is part of the digest-pinned v2 protocol. Downgrading after a
    // capability error would mix release contracts and can outlive authority.
    const identityParts = [
      input.authorization.authorizationId,
      input.authorization.mutationEpoch,
      input.command.executionId,
      input.command.sourceRunId,
      input.command.sourceRunAttempt,
      input.command.reviewRevisionHash,
      input.phase,
      ...(input.discriminator ? [input.discriminator] : []),
    ];
    const renewal = await this.dependencies.controlPlane.renewAuthorization({
      authorization: input.authorization,
      idempotencyKey: this.idempotencyKey('authorization-renew', identityParts),
      renewalRequestId: this.dependencies.identities.deterministicId(
        'authorization-renewal-request',
        identityParts
      ),
      oidcToken: await this.dependencies.oidc.getToken(),
      requestedTtlMs: input.requestedTtlMs,
    });
    validateAuthorizationScope(input.command, renewal.authorization);
    return renewal;
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
    readonly attemptOrdinal?: number;
  }> {
    let streamVersion = input.execution.streamVersion;
    for (
      let attemptOrdinal = 1;
      attemptOrdinal <= input.workSlot.attemptBudget;
      attemptOrdinal += 1
    ) {
      this.dependencies.progress?.report({
        type: 'running',
        workSlotId: input.workSlot.workSlotId,
        attemptOrdinal,
      });
      await this.assertRevisionCurrent(input.revision);
      input.onEvent({
        type: ReviewOrchestrationEventType.SlotLookupStarted,
        workSlotId: input.workSlot.workSlotId,
      });
      const authoritativeInvocation =
        await this.dependencies.invocations.prepare({
          workSlot: input.workSlot,
          attemptOrdinal,
        });
      const authoritativeManifest =
        await this.dependencies.invocationManifestAssembler.assemble(
          authoritativeInvocation
        );
      validateManifest(authoritativeManifest);
      if (
        authoritativeManifest.providerVoteIdentityHash !==
          input.workSlot.providerVoteIdentityHash ||
        authoritativeInvocation.workSlotId !== input.workSlot.workSlotId ||
        authoritativeInvocation.attemptOrdinal !== attemptOrdinal
      ) {
        throw new Error('review_orchestration_manifest_scope_mismatch');
      }
      const reused = await this.trySatisfyFromLookup({
        ...input,
        execution: { ...input.execution, streamVersion },
        manifest: authoritativeManifest,
      });
      if (reused) {
        return {
          observation: reused.observation,
          coverageManifest: authoritativeInvocation.coverageManifest,
          streamVersion: reused.streamVersion,
          attemptOrdinal,
        };
      }
      if (input.restoredSlot.state === RestoredReviewWorkSlotState.Satisfied) {
        throw new Error(
          'review_orchestration_restored_observation_unavailable'
        );
      }
      if (!this.canStartInvocation(attemptOrdinal)) {
        input.onEvent({
          type: ReviewOrchestrationEventType.SlotExhausted,
          workSlotId: input.workSlot.workSlotId,
        });
        return {
          streamVersion,
          exhaustionReason: ReviewWorkSlotExhaustionReason.DeadlineReached,
        };
      }

      let investigationCandidate;
      try {
        investigationCandidate = await this.prepareInvestigationCandidate({
          authorization: input.authorization,
          execution: input.execution,
          workSlot: input.workSlot,
          attemptOrdinal,
          ownerIdHash: input.ownerIdHash,
          revision: input.revision,
        });
      } catch (error) {
        if (error instanceof ReviewExecutionDeadlineReachedSignal) {
          input.onEvent({
            type: ReviewOrchestrationEventType.SlotExhausted,
            workSlotId: input.workSlot.workSlotId,
          });
          return {
            streamVersion,
            exhaustionReason: ReviewWorkSlotExhaustionReason.DeadlineReached,
          };
        }
        if (!(error instanceof ReviewInvestigationDeferredSignal)) throw error;
        this.recordInvestigationDiagnostic({
          outcome: ReviewInvestigationDiagnosticOutcome.AuthoritativeDeferred,
          workSlot: input.workSlot,
          attemptOrdinal,
          error,
        });
        if (attemptOrdinal < input.workSlot.attemptBudget) continue;
        input.onEvent({
          type: ReviewOrchestrationEventType.SlotExhausted,
          workSlotId: input.workSlot.workSlotId,
        });
        return {
          streamVersion,
          exhaustionReason:
            ReviewWorkSlotExhaustionReason.InvestigationDeferred,
        };
      }
      const selectedInvestigationCandidate =
        investigationCandidate !== null &&
        this.dependencies.investigationRecording?.mode ===
          ReviewInvestigationRecordingMode.Authoritative &&
        (investigationCandidate.observation.findingCount > 0 ||
          (investigationCandidate.observation.qualityFlags.includes(
            'investigation_verified_clean'
          ) &&
            this.dependencies.investigationRecording
              .verifiedCleanEffectsEnabled === true))
          ? investigationCandidate
          : null;
      const invocation = selectedInvestigationCandidate
        ? selectedInvestigationCandidate.invocation
        : authoritativeInvocation;
      const manifest = selectedInvestigationCandidate
        ? selectedInvestigationCandidate.manifest
        : authoritativeManifest;
      const precomputedObservation = selectedInvestigationCandidate
        ? selectedInvestigationCandidate.observation
        : null;

      if (selectedInvestigationCandidate) {
        const reusedInvestigation = await this.trySatisfyFromLookup({
          ...input,
          execution: { ...input.execution, streamVersion },
          manifest,
        });
        if (reusedInvestigation) {
          return {
            observation: reusedInvestigation.observation,
            coverageManifest: invocation.coverageManifest,
            streamVersion: reusedInvestigation.streamVersion,
          };
        }
      }

      if (!this.canStartInvocation(attemptOrdinal)) {
        input.onEvent({
          type: ReviewOrchestrationEventType.SlotExhausted,
          workSlotId: input.workSlot.workSlotId,
        });
        return {
          streamVersion,
          exhaustionReason: ReviewWorkSlotExhaustionReason.DeadlineReached,
        };
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
        if (!this.canStartInvocation(attemptOrdinal)) {
          input.onEvent({
            type: ReviewOrchestrationEventType.SlotExhausted,
            workSlotId: input.workSlot.workSlotId,
          });
          return {
            streamVersion,
            exhaustionReason: ReviewWorkSlotExhaustionReason.DeadlineReached,
          };
        }
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
          const delayMs = this.clampProviderDelay(
            Math.min(5_000, 500 * 2 ** Math.min(localBusyPollCount - 1, 4))
          );
          if (delayMs <= 0) {
            input.onEvent({
              type: ReviewOrchestrationEventType.SlotExhausted,
              workSlotId: input.workSlot.workSlotId,
            });
            return {
              streamVersion,
              exhaustionReason: ReviewWorkSlotExhaustionReason.DeadlineReached,
            };
          }
          await this.dependencies.delay.sleep(delayMs);
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
      if (!this.canStartInvocation(attemptOrdinal)) {
        await this.releaseLease(lease, input.ownerIdHash, attemptOrdinal);
        input.onEvent({
          type: ReviewOrchestrationEventType.SlotExhausted,
          workSlotId: input.workSlot.workSlotId,
        });
        return {
          streamVersion,
          exhaustionReason: ReviewWorkSlotExhaustionReason.DeadlineReached,
        };
      }

      let observationPayload;
      try {
        observationPayload = await this.dependencies.leaseSupervisor.run({
          lease,
          renew: async () => {
            lease = await this.renewLease(lease!, input.ownerIdHash);
            return lease;
          },
          operation: (signal, currentLease) =>
            precomputedObservation === null
              ? this.executeInvocationWithRevisionWatch({
                  invocation,
                  manifest,
                  currentLease,
                  sourceExecutionId: input.execution.executionId,
                  signal,
                  revision: input.revision,
                })
              : Promise.resolve(precomputedObservation),
        });
        if (
          invocation.manifestFacts.executionProfile !== 'context_gateway_v1'
        ) {
          await this.assertRevisionCurrent(input.revision);
        }
        if (this.providerOperationRemainingMs() <= 0) {
          throw new ReviewExecutionDeadlineReachedSignal();
        }
      } catch (error) {
        if (error instanceof ReviewExecutionSupersededSignal) {
          await this.releaseLease(lease, input.ownerIdHash, attemptOrdinal);
          throw error;
        }
        if (error instanceof ReviewExecutionDeadlineReachedSignal) {
          await this.releaseLease(lease, input.ownerIdHash, attemptOrdinal);
          input.onEvent({
            type: ReviewOrchestrationEventType.SlotExhausted,
            workSlotId: input.workSlot.workSlotId,
          });
          return {
            streamVersion,
            exhaustionReason: ReviewWorkSlotExhaustionReason.DeadlineReached,
          };
        }
        if (
          error instanceof RetryableReviewContextInspectionFailure &&
          attemptOrdinal === input.workSlot.attemptBudget &&
          invocation.manifestFacts.executionProfile !== 'context_gateway_v1'
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
          if (
            failureClass === ReviewInvocationFailureClass.ConfigurationMismatch
          ) {
            throw error instanceof ReviewInvocationConfigurationMismatchError
              ? error
              : new Error('review_invocation_configuration_mismatch');
          }
          continue;
        }
      }
      try {
        assertRequiredContextAttestation(
          invocation.manifestFacts.executionProfile,
          observationPayload
        );
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
          attemptOrdinal,
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
    readonly sourceExecutionId: string;
    readonly revision: ReviewRevisionFacts;
  }): Promise<ReviewObservationPayload> {
    const abort = new AbortController();
    let stopped = false;
    const relayLeaseAbort = () => abort.abort(input.signal.reason);
    if (input.signal.aborted) relayLeaseAbort();
    else
      input.signal.addEventListener('abort', relayLeaseAbort, { once: true });
    const drainOnSupersession =
      input.invocation.manifestFacts.executionProfile === 'context_gateway_v1';
    const monitor = async () => {
      while (!stopped && !abort.signal.aborted) {
        const delayMs = this.clampProviderDelay(this.revisionPollIntervalMs);
        if (delayMs <= 0) {
          abort.abort(new ReviewExecutionDeadlineReachedSignal());
          return;
        }
        await this.dependencies.delay.sleep(delayMs);
        if (stopped || abort.signal.aborted) return;
        if (this.providerOperationRemainingMs() <= 0) {
          abort.abort(new ReviewExecutionDeadlineReachedSignal());
          return;
        }
        if (drainOnSupersession) continue;
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
      const observation = await this.executeLegacyInvocation(
        input,
        abort.signal
      );
      if (abort.signal.reason instanceof ReviewExecutionDeadlineReachedSignal) {
        throw abort.signal.reason;
      }
      return observation;
    } catch (error) {
      if (
        abort.signal.reason instanceof ReviewExecutionSupersededSignal ||
        abort.signal.reason instanceof ReviewExecutionDeadlineReachedSignal
      ) {
        throw abort.signal.reason;
      }
      throw error;
    } finally {
      stopped = true;
      input.signal.removeEventListener('abort', relayLeaseAbort);
    }
  }

  private async prepareInvestigationCandidate(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly execution: ReviewExecutionAdmission;
    readonly workSlot: ReviewWorkSlotPlan;
    readonly attemptOrdinal: number;
    readonly ownerIdHash: string;
    readonly revision: ReviewRevisionFacts;
  }): Promise<{
    readonly invocation: PreparedReviewInvocation;
    readonly manifest: ProviderInvocationManifest;
    readonly observation: ReviewObservationPayload;
  } | null> {
    const recording = this.dependencies.investigationRecording;
    const invocations = this.dependencies.investigationInvocations;
    if (!recording || !invocations) return null;
    try {
      const invocation = await invocations.prepare({
        workSlot: input.workSlot,
        attemptOrdinal: input.attemptOrdinal,
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
        invocation.attemptOrdinal !== input.attemptOrdinal
      ) {
        throw new Error('review_investigation_manifest_scope_mismatch');
      }
      if (!recording.supports({ workSlot: input.workSlot, invocation })) {
        return null;
      }

      const abort = new AbortController();
      let stopped = false;
      const monitor = async () => {
        while (!stopped && !abort.signal.aborted) {
          const delayMs = this.clampProviderDelay(this.revisionPollIntervalMs);
          if (delayMs <= 0) {
            abort.abort(new ReviewExecutionDeadlineReachedSignal());
            return;
          }
          await this.dependencies.delay.sleep(delayMs);
          if (stopped || abort.signal.aborted) return;
          if (this.providerOperationRemainingMs() <= 0) {
            abort.abort(new ReviewExecutionDeadlineReachedSignal());
            return;
          }
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
        const observation = await recording.execute({
          authorization: input.authorization,
          execution: input.execution,
          workSlot: input.workSlot,
          invocation,
          manifest,
          ownerIdHash: input.ownerIdHash,
          sourceReviewRevisionHash: input.revision.reviewRevisionHash,
          signal: abort.signal,
        });
        if (
          abort.signal.reason instanceof ReviewExecutionDeadlineReachedSignal
        ) {
          throw abort.signal.reason;
        }
        return { invocation, manifest, observation };
      } catch (error) {
        if (
          abort.signal.reason instanceof ReviewExecutionSupersededSignal ||
          abort.signal.reason instanceof ReviewExecutionDeadlineReachedSignal
        ) {
          throw abort.signal.reason;
        }
        throw error;
      } finally {
        stopped = true;
      }
    } catch (error) {
      if (
        error instanceof ReviewExecutionSupersededSignal ||
        error instanceof ReviewExecutionDeadlineReachedSignal
      ) {
        throw error;
      }
      if (
        error instanceof ReviewInvestigationLegacyFallbackSignal ||
        recording.mode === ReviewInvestigationRecordingMode.RecordOnly
      ) {
        this.recordInvestigationDiagnostic({
          outcome: ReviewInvestigationDiagnosticOutcome.LegacyFallback,
          workSlot: input.workSlot,
          attemptOrdinal: input.attemptOrdinal,
          error,
        });
        return null;
      }
      throw error;
    }
  }

  private recordInvestigationDiagnostic(input: {
    readonly outcome: ReviewInvestigationDiagnosticOutcome;
    readonly workSlot: ReviewWorkSlotPlan;
    readonly attemptOrdinal: number;
    readonly error: unknown;
  }): void {
    try {
      this.dependencies.investigationDiagnostics?.record({
        outcome: input.outcome,
        workSlotId: input.workSlot.workSlotId,
        attemptOrdinal: input.attemptOrdinal,
        providerKind: input.workSlot.providerKind,
        error: input.error,
      });
    } catch {
      // Diagnostics must never change investigation fallback or safety decisions.
    }
  }

  private executeLegacyInvocation(
    input: {
      readonly invocation: PreparedReviewInvocation;
      readonly manifest: ProviderInvocationManifest;
      readonly currentLease: () => ReviewInvocationLease;
      readonly sourceExecutionId: string;
      readonly revision: ReviewRevisionFacts;
    },
    signal: AbortSignal
  ): Promise<ReviewObservationPayload> {
    if (
      input.invocation.manifestFacts.executionProfile ===
      'investigation_gateway_v1'
    ) {
      throw new ReviewInvocationConfigurationMismatchError(
        ReviewInvocationConfigurationMismatchReason.InvestigationLegacyFallbackManifestMismatch
      );
    }
    return this.dependencies.invocations.execute({
      invocation: input.invocation,
      manifest: input.manifest,
      lease: input.currentLease(),
      sourceExecutionId: input.sourceExecutionId,
      sourceReviewRevisionHash: input.revision.reviewRevisionHash,
      signal,
    });
  }

  private canStartBatch(): boolean {
    return this.dependencies.executionDeadline?.canStartBatch() ?? true;
  }

  private canStartInvocation(attemptOrdinal: number): boolean {
    const deadline = this.dependencies.executionDeadline;
    if (!deadline) return true;
    return attemptOrdinal === 1
      ? deadline.canStartInitialInvocation()
      : deadline.canStartOptionalRetry();
  }

  private executionDeadlineRemainingMs(): number {
    return this.dependencies.executionDeadline?.remainingMs() ?? Infinity;
  }

  private assertExecutionDeadlineAvailable(): void {
    if (this.executionDeadlineRemainingMs() <= 0) {
      throw new ReviewExecutionDeadlineReachedSignal();
    }
  }

  private providerOperationRemainingMs(): number {
    return (
      this.dependencies.executionDeadline?.clampProviderTimeout(
        Number.MAX_SAFE_INTEGER
      ) ?? Infinity
    );
  }

  private clampProviderDelay(requestedDelayMs: number): number {
    return Math.floor(
      Math.min(requestedDelayMs, this.providerOperationRemainingMs())
    );
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

function terminalizeCommand(
  reason: ReviewWorkSlotExhaustionReason | undefined
):
  | {
      readonly terminalState: 'exhausted';
      readonly reasonCode: 'attempt_budget_exhausted';
    }
  | {
      readonly terminalState: 'cancelled';
      readonly reasonCode: 'deadline_reached';
    }
  | null {
  if (
    reason === ReviewWorkSlotExhaustionReason.AttemptBudgetExhausted ||
    reason === ReviewWorkSlotExhaustionReason.ProviderAttemptsExhausted
  ) {
    return {
      terminalState: 'exhausted',
      reasonCode: 'attempt_budget_exhausted',
    };
  }
  if (reason === ReviewWorkSlotExhaustionReason.DeadlineReached) {
    return { terminalState: 'cancelled', reasonCode: 'deadline_reached' };
  }
  return null;
}

function finishPublication(input: {
  readonly state: ReviewOrchestrationState;
  readonly executionId: string;
  readonly publicationAttemptId: string;
  readonly partial: boolean;
  readonly failureCode?: string;
  readonly mergeGateConclusion: MergeGateConclusion;
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
    mergeGateConclusion: input.mergeGateConclusion,
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
    if (reason === ReviewWorkSlotExhaustionReason.InvestigationDeferred) {
      return 'required_investigation_deferred';
    }
    if (reason === ReviewWorkSlotExhaustionReason.DeadlineReached) {
      return 'required_execution_deadline_reached';
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
    command.assignmentManifestHash,
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

function assertRequiredContextAttestation(
  executionProfile: PreparedReviewInvocation['manifestFacts']['executionProfile'],
  observation: ReviewObservationPayload
): void {
  if (executionProfile !== 'context_gateway_v1') return;
  if (
    !observation.contextDependencyAttestationId ||
    !observation.contextDependencyAttestationHash
  ) {
    throw new Error('review_context_gateway_attestation_required');
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
  if (!Number.isFinite(value) || value < 0) {
    return MIN_PUBLICATION_POLL_DELAY_MS;
  }
  return Math.min(
    Math.max(Math.floor(value), MIN_PUBLICATION_POLL_DELAY_MS),
    30_000
  );
}

function calculatePublicationPollLimit(input: {
  readonly hardLimit: number | null;
  readonly reconciliationDurationMs: number;
}): number {
  const durationBound = Math.ceil(
    input.reconciliationDurationMs / MIN_PUBLICATION_POLL_DELAY_MS
  );
  const deadlineBound = Math.max(1, durationBound);
  return input.hardLimit === null
    ? deadlineBound
    : Math.min(input.hardLimit, deadlineBound);
}

function readMonotonicClockMs(clock: ReviewOrchestrationClockPort): number {
  const nowMs = clock.monotonicNowMs();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('review_orchestration_monotonic_clock_invalid');
  }
  return nowMs;
}

function safeAddMilliseconds(left: number, right: number): number {
  if (
    !Number.isSafeInteger(left) ||
    left < 0 ||
    !Number.isSafeInteger(right) ||
    right < 0 ||
    left > Number.MAX_SAFE_INTEGER - right
  ) {
    throw new Error('review_orchestration_duration_overflow');
  }
  return left + right;
}

function safeMultiplyMilliseconds(value: number, multiplier: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isSafeInteger(multiplier) ||
    multiplier < 1 ||
    value > Math.floor(Number.MAX_SAFE_INTEGER / multiplier)
  ) {
    throw new Error('review_orchestration_duration_overflow');
  }
  return value * multiplier;
}

function elapsedMonotonicMs(startMs: number, endMs: number): number {
  if (endMs < startMs) {
    throw new Error('review_orchestration_monotonic_clock_regressed');
  }
  return endMs - startMs;
}

function assertPublicationAuthorizationWindow(input: {
  readonly validForMsAtResponse: number;
  readonly elapsedMs: number;
  readonly requiredMs: number;
}): void {
  if (input.validForMsAtResponse - input.elapsedMs < input.requiredMs) {
    throw new Error(
      'review_orchestration_publication_authorization_window_insufficient'
    );
  }
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

class ReviewExecutionDeadlineReachedSignal extends Error {
  constructor() {
    super('review_orchestration_execution_deadline_reached');
  }
}

class ReviewProviderUnavailableSignal extends Error {
  constructor(failureCode: string) {
    super(failureCode);
  }
}
