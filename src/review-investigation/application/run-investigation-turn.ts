import {
  ReviewAgentExecutionError,
  ReviewAgentFailureClass,
  type ReviewAgentSelection,
  type ReviewAgentSelectionPort,
} from './review-agent-port';
import {
  ReviewInvestigationAbortReason,
  type ReviewInvestigationSnapshot,
  type ReviewInvestigationTurnBrief,
} from '../domain/investigation-state';
import { canonicalJson, sha256 } from '../domain/canonical-json';
import {
  ReviewTurnPurpose,
  type ReviewTurnObservation,
} from '../domain/turn-observation';
import {
  ReviewInvestigationControlPlaneError,
  ReviewInvestigationControlPlaneFailureClass,
  ReviewInvestigationCurrency,
  type ReviewInvestigationControlPlanePort,
  type ReviewInvestigationCurrencyPort,
  type ReviewInvestigationLease,
} from './investigation-control-plane-port';
import {
  ReviewInvestigationGatewayConfigurationError,
  type AcceptedInvestigationAttestation,
  type ReviewInvestigationGatewaySessionFactoryPort,
  type ReviewInvestigationGatewaySessionPort,
} from './investigation-gateway-port';
import {
  ReviewAgentConfinementStrength,
  ReviewAgentExecutionProfile,
  type ReviewAgentProviderKind,
} from '../domain/runtime-profile';
import {
  ReviewInvestigationOperationalFailurePhase,
  type ReviewInvestigationOperationalDiagnosticPort,
} from './investigation-operational-diagnostic-port';

export enum RunInvestigationTurnStatus {
  Committed = 'committed',
  Aborted = 'aborted',
  Superseded = 'superseded',
  RecoveryRequired = 'recovery_required',
}

export type RunInvestigationTurnResult = Readonly<{
  status: RunInvestigationTurnStatus;
  snapshot: ReviewInvestigationSnapshot;
}>;

const MAX_SAFE_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;

export class RunInvestigationTurn {
  constructor(
    private readonly dependencies: Readonly<{
      controlPlane: ReviewInvestigationControlPlanePort;
      currency: ReviewInvestigationCurrencyPort;
      gateway: ReviewInvestigationGatewaySessionFactoryPort;
      agents: ReviewAgentSelectionPort;
      diagnostics?: ReviewInvestigationOperationalDiagnosticPort;
      now: () => Date;
    }>
  ) {}

  async execute(input: {
    readonly authorizationToken: string;
    readonly authorizationId: string;
    readonly executionId: string;
    readonly workSlotId: string;
    readonly reviewRevisionHash: string;
    readonly requestedModel: string;
    readonly providerKind: ReviewAgentProviderKind;
    readonly prompt: string;
    readonly workingDirectory: string;
    readonly timeoutMs: number;
    readonly maxTurns: number;
    readonly minimumCapacityParkMs: number;
    readonly snapshot: ReviewInvestigationSnapshot;
    readonly currentLease: () => ReviewInvestigationLease;
    readonly signal?: AbortSignal;
  }): Promise<RunInvestigationTurnResult> {
    const turn = requireActiveTurn(input.snapshot);
    let brief: ReviewInvestigationTurnBrief;
    let selection: ReviewAgentSelection;
    try {
      brief = requireTurnBrief(turn.brief);
      selection = this.dependencies.agents.resolve({
        primaryProviderKind: input.providerKind,
        primaryRequestedModel: input.requestedModel,
        executionAuthority: this.dependencies.gateway.executionAuthority,
        purpose: turn.purpose,
        maximumSemanticRiskPriority: brief.maximumSemanticRiskPriority,
      });
      requireAuthorizedSelection(
        selection,
        this.dependencies.gateway.executionAuthority,
        turn.purpose
      );
      await selection.agent.negotiate({
        providerKind: selection.providerKind,
        executionProfile: ReviewAgentExecutionProfile.GatewayAttestedAgentV1,
        minimumConfinement: ReviewAgentConfinementStrength.GatewayOnly,
        requireActualModelAttribution: true,
        requireUsageAttribution: true,
        requireFencedCancellation: true,
        minimumMaxTurns: input.maxTurns,
      });
    } catch (error) {
      const failure = await this.recordOperationalFailure(
        input,
        error,
        ReviewInvestigationOperationalFailurePhase.AgentPreflight
      );
      return this.abortProviderFailure(input, failure);
    }
    const invocationId = `${input.snapshot.investigationId}:${turn.turnId}:${input.currentLease().attemptId}`;
    const current = await this.dependencies.currency.check(input);
    if (current !== ReviewInvestigationCurrency.Current) {
      return this.abortSuperseded(input, invocationId);
    }

    let session: ReviewInvestigationGatewaySessionPort;
    try {
      session = await this.dependencies.gateway.open({
        executionId: input.executionId,
        workSlotId: input.workSlotId,
        reviewRevisionHash: input.reviewRevisionHash,
        investigationId: input.snapshot.investigationId,
        turnId: turn.turnId,
        currentLease: input.currentLease,
      });
    } catch (error) {
      if (error instanceof ReviewInvestigationGatewayConfigurationError) {
        throw error;
      }
      const failure = await this.recordOperationalFailure(
        input,
        error,
        ReviewInvestigationOperationalFailurePhase.GatewayOpen
      );
      return this.abortProviderFailure(input, failure);
    }
    try {
      let observation: ReviewTurnObservation;
      try {
        observation = await selection.agent.executeTurn({
          invocationId,
          fencingToken: input.currentLease().fencingToken,
          turnId: turn.turnId,
          dossierVersion: input.snapshot.version,
          dossierDigest: input.snapshot.dossierDigest,
          purpose: turn.purpose,
          allowedObligationIds: Object.freeze(
            brief.obligations.map((obligation) => obligation.obligationId)
          ),
          prompt: input.prompt,
          workspaceRoot: input.workingDirectory,
          requestedModel: selection.requestedModel,
          timeoutMs: input.timeoutMs,
          maxTurns: input.maxTurns,
          executionSession: session.agentSession,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch (error) {
        const failure = await this.recordOperationalFailure(
          input,
          error,
          ReviewInvestigationOperationalFailurePhase.AgentExecution
        );
        return this.abortProviderFailure(input, failure);
      }

      if (
        (await this.dependencies.currency.check(input)) !==
        ReviewInvestigationCurrency.Current
      ) {
        await cancelPreservingSemanticOutcome(
          selection,
          invocationId,
          input.currentLease().fencingToken,
          (error) =>
            this.recordOperationalFailure(
              input,
              error,
              ReviewInvestigationOperationalFailurePhase.AgentCancel
            )
        );
        return this.abortSuperseded(input, invocationId);
      }

      const terminalOutcomeHash = hashObservation(observation);
      let accepted: AcceptedInvestigationAttestation;
      try {
        accepted = await session.seal({
          actualModel: observation.actualModel,
          terminalOutcomeHash,
        });
      } catch (error) {
        const failure = await this.recordOperationalFailure(
          input,
          error,
          ReviewInvestigationOperationalFailurePhase.GatewaySeal
        );
        return this.abortProviderFailure(input, failure);
      }
      observation = Object.freeze({
        ...observation,
        contextAttestationReference: accepted.attestationId,
      });
      try {
        const snapshot = await this.dependencies.controlPlane.commitTurn({
          authorizationToken: input.authorizationToken,
          snapshot: input.snapshot,
          lease: input.currentLease(),
          attestationId: accepted.attestationId,
          attestationHash: accepted.attestationHash,
          observation,
        });
        return { status: RunInvestigationTurnStatus.Committed, snapshot };
      } catch (error) {
        if (
          error instanceof ReviewInvestigationControlPlaneError &&
          error.failureClass ===
            ReviewInvestigationControlPlaneFailureClass.ProviderOutputInvalid
        ) {
          return this.abort(
            input,
            ReviewInvestigationAbortReason.SchemaInvalidOutput,
            null,
            RunInvestigationTurnStatus.RecoveryRequired
          );
        }
        return this.reconcileAmbiguous(input, error);
      }
    } finally {
      await disposePreservingSemanticOutcome(session, (error) =>
        this.recordOperationalFailure(
          input,
          error,
          ReviewInvestigationOperationalFailurePhase.GatewayCleanup
        )
      );
    }
  }

  private async recordOperationalFailure(
    input: Parameters<RunInvestigationTurn['execute']>[0],
    error: unknown,
    phase: ReviewInvestigationOperationalFailurePhase
  ): Promise<ReviewAgentExecutionError> {
    const failure = operationalFailure(error, phase);
    try {
      await this.dependencies.diagnostics?.record({
        investigationId: input.snapshot.investigationId,
        turnId: input.snapshot.turn?.turnId ?? 'turn-unavailable',
        phase,
        failureClass: failure.failureClass,
        code: failure.message,
        detailCode: operationalDetailCode(error),
        retryAfterMs: boundedRetryAfterMs(failure.retryAfterMs),
      });
    } catch {
      // Diagnostic delivery cannot replace the semantic turn outcome.
    }
    return failure;
  }

  private async abortProviderFailure(
    input: Parameters<RunInvestigationTurn['execute']>[0],
    error: unknown
  ): Promise<RunInvestigationTurnResult> {
    const failure =
      error instanceof ReviewAgentExecutionError
        ? new ReviewAgentExecutionError(
            error.failureClass,
            boundedRetryAfterMs(error.retryAfterMs),
            'review_agent_typed_failure'
          )
        : new ReviewAgentExecutionError(
            ReviewAgentFailureClass.ProcessFailure,
            null,
            'review_agent_unclassified_failure'
          );
    const reason = abortReason(failure.failureClass);
    const delay =
      failure.retryAfterMs === null &&
      !requiresBoundedParking(failure.failureClass)
        ? null
        : Math.max(
            failure.retryAfterMs ?? input.minimumCapacityParkMs,
            input.minimumCapacityParkMs
          );
    const nextEligibleAt =
      delay === null
        ? null
        : new Date(this.dependencies.now().getTime() + delay).toISOString();
    return this.abort(
      input,
      reason,
      nextEligibleAt,
      isNonRetryableProviderOutputFailure(failure.failureClass)
        ? RunInvestigationTurnStatus.RecoveryRequired
        : RunInvestigationTurnStatus.Aborted
    );
  }

  private async abortSuperseded(
    input: Parameters<RunInvestigationTurn['execute']>[0],
    _invocationId: string
  ): Promise<RunInvestigationTurnResult> {
    return this.abort(
      input,
      ReviewInvestigationAbortReason.SupersededExecution,
      null,
      RunInvestigationTurnStatus.Superseded
    );
  }

  private async abort(
    input: Parameters<RunInvestigationTurn['execute']>[0],
    reason: ReviewInvestigationAbortReason,
    nextEligibleAt: string | null,
    status = RunInvestigationTurnStatus.Aborted
  ): Promise<RunInvestigationTurnResult> {
    try {
      const snapshot = await this.dependencies.controlPlane.abortTurn({
        authorizationToken: input.authorizationToken,
        snapshot: input.snapshot,
        lease: input.currentLease(),
        reason,
        nextEligibleAt,
      });
      return { status, snapshot };
    } catch (error) {
      return this.reconcileAmbiguous(input, error, status);
    }
  }

  private async reconcileAmbiguous(
    input: Parameters<RunInvestigationTurn['execute']>[0],
    error: unknown,
    acceptedStatus = RunInvestigationTurnStatus.Committed
  ): Promise<RunInvestigationTurnResult> {
    if (!(error instanceof ReviewInvestigationControlPlaneError)) {
      throw error;
    }
    if (
      error.failureClass !==
        ReviewInvestigationControlPlaneFailureClass.AmbiguousOutcome &&
      error.failureClass !==
        ReviewInvestigationControlPlaneFailureClass.Rejected
    ) {
      throw error;
    }
    const restored = await this.dependencies.controlPlane.restore({
      authorizationToken: input.authorizationToken,
      authorizationId: input.authorizationId,
      investigationId: input.snapshot.investigationId,
      reviewRevisionHash: input.reviewRevisionHash,
    });
    if (restored === null) throw error;
    const accepted =
      restored.version > input.snapshot.version &&
      restored.turn?.turnId !== input.snapshot.turn?.turnId;
    return {
      status: accepted
        ? acceptedStatus
        : RunInvestigationTurnStatus.RecoveryRequired,
      snapshot: restored,
    };
  }
}

const operationalFailureCodes = Object.freeze({
  [ReviewInvestigationOperationalFailurePhase.AgentPreflight]: Object.freeze({
    default: 'review_investigation_agent_preflight_failure',
    confinement: 'review_investigation_agent_preflight_confinement_failure',
  }),
  [ReviewInvestigationOperationalFailurePhase.AgentCancel]: Object.freeze({
    default: 'review_investigation_agent_cancel_failure',
    confinement: 'review_investigation_agent_cancel_confinement_failure',
  }),
  [ReviewInvestigationOperationalFailurePhase.AgentExecution]: Object.freeze({
    default: 'review_investigation_agent_execution_failure',
    confinement: 'review_investigation_agent_execution_confinement_failure',
  }),
  [ReviewInvestigationOperationalFailurePhase.GatewayCleanup]: Object.freeze({
    default: 'review_investigation_gateway_cleanup_failure',
    confinement: 'review_investigation_gateway_cleanup_confinement_failure',
  }),
  [ReviewInvestigationOperationalFailurePhase.GatewayOpen]: Object.freeze({
    default: 'review_investigation_gateway_open_failure',
    confinement: 'review_investigation_gateway_open_confinement_failure',
  }),
  [ReviewInvestigationOperationalFailurePhase.GatewaySeal]: Object.freeze({
    default: 'review_investigation_gateway_seal_failure',
    confinement: 'review_investigation_gateway_seal_confinement_failure',
  }),
});

function operationalFailure(
  error: unknown,
  phase: ReviewInvestigationOperationalFailurePhase
): ReviewAgentExecutionError {
  const typed = error instanceof ReviewAgentExecutionError ? error : null;
  const failureClass =
    typed?.failureClass ?? ReviewAgentFailureClass.ProcessFailure;
  const code = operationalFailureCodes[phase];
  return new ReviewAgentExecutionError(
    failureClass,
    typed?.retryAfterMs ?? null,
    failureClass === ReviewAgentFailureClass.ConfinementViolation
      ? code.confinement
      : code.default
  );
}

function operationalDetailCode(error: unknown): string | null {
  if (
    error instanceof ReviewAgentExecutionError &&
    /^review_agent_[a-z0-9_]{1,160}$/u.test(error.message)
  ) {
    return error.message;
  }
  return null;
}

async function cancelPreservingSemanticOutcome(
  selection: ReviewAgentSelection,
  invocationId: string,
  fencingToken: string,
  onFailure: (error: unknown) => Promise<unknown>
): Promise<void> {
  try {
    await selection.agent.cancel(invocationId, fencingToken);
  } catch (error) {
    // Supersession is already authoritative; cleanup cannot replace it.
    await onFailure(error);
  }
}

async function disposePreservingSemanticOutcome(
  session: ReviewInvestigationGatewaySessionPort,
  onFailure: (error: unknown) => Promise<unknown>
): Promise<void> {
  try {
    await session.dispose();
  } catch (error) {
    // Commit or abort is authoritative; cleanup cannot replace it.
    await onFailure(error);
  }
}

function requireTurnBrief(
  brief: ReviewInvestigationTurnBrief | null
): ReviewInvestigationTurnBrief {
  if (brief === null) {
    throw new ReviewAgentExecutionError(
      ReviewAgentFailureClass.CapabilityUnavailable,
      null,
      'review_investigation_turn_brief_missing'
    );
  }
  return brief;
}

function requireAuthorizedSelection(
  selection: Pick<ReviewAgentSelection, 'providerKind' | 'requestedModel'>,
  authority: Readonly<{
    providerKind: ReviewAgentProviderKind;
    requestedModel: string;
  }>,
  purpose: ReviewTurnPurpose
): void {
  if (
    selection.providerKind === authority.providerKind &&
    selection.requestedModel === authority.requestedModel
  ) {
    return;
  }
  throw new ReviewAgentExecutionError(
    ReviewAgentFailureClass.ConfinementViolation,
    null,
    purpose === ReviewTurnPurpose.Critic
      ? 'review_agent_critic_execution_authority_unavailable'
      : 'review_agent_execution_authority_mismatch'
  );
}

function requireActiveTurn(snapshot: ReviewInvestigationSnapshot) {
  if (snapshot.turn === null) throw new Error('investigation_turn_missing');
  return snapshot.turn;
}

function hashObservation(observation: ReviewTurnObservation): string {
  return sha256(
    canonicalJson({
      ...observation,
      contextAttestationReference: null,
    })
  );
}

function abortReason(
  failure: ReviewAgentFailureClass
): ReviewInvestigationAbortReason {
  switch (failure) {
    case ReviewAgentFailureClass.AuthenticationUnavailable:
      return ReviewInvestigationAbortReason.AuthenticationUnavailable;
    case ReviewAgentFailureClass.QuotaUnavailable:
    case ReviewAgentFailureClass.CapacityUnavailable:
      return ReviewInvestigationAbortReason.CapacityUnavailable;
    case ReviewAgentFailureClass.Timeout:
      return ReviewInvestigationAbortReason.Timeout;
    case ReviewAgentFailureClass.Cancelled:
      return ReviewInvestigationAbortReason.Cancelled;
    case ReviewAgentFailureClass.ConfinementViolation:
      return ReviewInvestigationAbortReason.ConfinementViolation;
    case ReviewAgentFailureClass.SchemaInvalidOutput:
    case ReviewAgentFailureClass.StreamIncomplete:
    case ReviewAgentFailureClass.ModelAttributionMissing:
    case ReviewAgentFailureClass.UsageAttributionMissing:
      return ReviewInvestigationAbortReason.SchemaInvalidOutput;
    case ReviewAgentFailureClass.CapabilityUnavailable:
    case ReviewAgentFailureClass.StartupFailure:
    case ReviewAgentFailureClass.ProcessFailure:
      return ReviewInvestigationAbortReason.RetryableInfrastructureFailure;
  }
}

function requiresBoundedParking(failure: ReviewAgentFailureClass): boolean {
  return [
    ReviewAgentFailureClass.AuthenticationUnavailable,
    ReviewAgentFailureClass.QuotaUnavailable,
    ReviewAgentFailureClass.CapacityUnavailable,
    ReviewAgentFailureClass.CapabilityUnavailable,
  ].includes(failure);
}

function isNonRetryableProviderOutputFailure(
  failure: ReviewAgentFailureClass
): boolean {
  return [
    ReviewAgentFailureClass.SchemaInvalidOutput,
    ReviewAgentFailureClass.StreamIncomplete,
    ReviewAgentFailureClass.ModelAttributionMissing,
    ReviewAgentFailureClass.UsageAttributionMissing,
  ].includes(failure);
}

function boundedRetryAfterMs(value: number | null): number | null {
  if (
    value === null ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_SAFE_RETRY_AFTER_MS
  ) {
    return null;
  }
  return value;
}
