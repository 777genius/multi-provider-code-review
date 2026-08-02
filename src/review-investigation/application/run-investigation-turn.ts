import {
  ReviewAgentExecutionError,
  ReviewAgentFailureClass,
  type ReviewAgentPort,
} from './review-agent-port';
import {
  ReviewInvestigationAbortReason,
  type ReviewInvestigationSnapshot,
} from '../domain/investigation-state';
import { canonicalJson, sha256 } from '../domain/canonical-json';
import type { ReviewTurnObservation } from '../domain/turn-observation';
import {
  ReviewInvestigationControlPlaneError,
  ReviewInvestigationControlPlaneFailureClass,
  ReviewInvestigationCurrency,
  type ReviewInvestigationControlPlanePort,
  type ReviewInvestigationCurrencyPort,
  type ReviewInvestigationLease,
} from './investigation-control-plane-port';
import type { ReviewInvestigationGatewaySessionFactoryPort } from './investigation-gateway-port';
import {
  ReviewAgentConfinementStrength,
  ReviewAgentExecutionProfile,
  type ReviewAgentProviderKind,
} from '../domain/runtime-profile';

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

export class RunInvestigationTurn {
  constructor(
    private readonly dependencies: Readonly<{
      controlPlane: ReviewInvestigationControlPlanePort;
      currency: ReviewInvestigationCurrencyPort;
      gateway: ReviewInvestigationGatewaySessionFactoryPort;
      agent: ReviewAgentPort;
      now: () => Date;
    }>
  ) {}

  async execute(input: {
    readonly authorizationToken: string;
    readonly authorizationId: string;
    readonly executionId: string;
    readonly workSlotId: string;
    readonly reviewRevisionHash: string;
    readonly providerStrategyId: string;
    readonly requestedModel: string;
    readonly providerKind: ReviewAgentProviderKind;
    readonly prompt: string;
    readonly workingDirectory: string;
    readonly timeoutMs: number;
    readonly maxTurns: number;
    readonly minimumCapacityParkMs: number;
    readonly snapshot: ReviewInvestigationSnapshot;
    readonly lease: ReviewInvestigationLease;
    readonly providerCredentialEnvironment: Readonly<NodeJS.ProcessEnv>;
    readonly signal?: AbortSignal;
  }): Promise<RunInvestigationTurnResult> {
    const turn = requireActiveTurn(input.snapshot);
    await this.dependencies.agent.negotiate({
      providerKind: input.providerKind,
      executionProfile: ReviewAgentExecutionProfile.GatewayAttestedAgentV1,
      minimumConfinement: ReviewAgentConfinementStrength.GatewayOnly,
      requireActualModelAttribution: true,
      requireUsageAttribution: true,
      requireFencedCancellation: true,
      minimumMaxTurns: input.maxTurns,
    });
    const invocationId = `${input.snapshot.investigationId}:${turn.turnId}:${input.lease.attemptId}`;
    const current = await this.dependencies.currency.check(input);
    if (current !== ReviewInvestigationCurrency.Current) {
      return this.abortSuperseded(input, invocationId);
    }

    const session = await this.dependencies.gateway.open({
      executionId: input.executionId,
      workSlotId: input.workSlotId,
      reviewRevisionHash: input.reviewRevisionHash,
      investigationId: input.snapshot.investigationId,
      turnId: turn.turnId,
      lease: input.lease,
      requestedModel: input.requestedModel,
      providerStrategyId: input.providerStrategyId,
    });
    try {
      let observation: ReviewTurnObservation;
      try {
        observation = await this.dependencies.agent.executeTurn({
          invocationId,
          fencingToken: input.lease.fencingToken,
          turnId: turn.turnId,
          dossierVersion: input.snapshot.version,
          dossierDigest: input.snapshot.dossierDigest,
          purpose: turn.purpose,
          prompt: input.prompt,
          workingDirectory: input.workingDirectory,
          requestedModel: input.requestedModel,
          timeoutMs: input.timeoutMs,
          maxTurns: input.maxTurns,
          gateway: session.providerConfig,
          providerCredentialEnvironment: input.providerCredentialEnvironment,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch (error) {
        return this.abortProviderFailure(input, error);
      }

      if (
        (await this.dependencies.currency.check(input)) !==
        ReviewInvestigationCurrency.Current
      ) {
        await this.dependencies.agent.cancel(
          invocationId,
          input.lease.fencingToken
        );
        return this.abortSuperseded(input, invocationId);
      }

      const terminalOutcomeHash = hashObservation(observation);
      const accepted = await session.seal({
        actualModel: observation.actualModel,
        terminalOutcomeHash,
      });
      observation = Object.freeze({
        ...observation,
        contextAttestationReference: accepted.attestationId,
      });
      try {
        const snapshot = await this.dependencies.controlPlane.commitTurn({
          authorizationToken: input.authorizationToken,
          snapshot: input.snapshot,
          lease: input.lease,
          attestationId: accepted.attestationId,
          attestationHash: accepted.attestationHash,
          observation,
        });
        return { status: RunInvestigationTurnStatus.Committed, snapshot };
      } catch (error) {
        return this.reconcileAmbiguous(input, error);
      }
    } finally {
      await session.dispose();
    }
  }

  private async abortProviderFailure(
    input: Parameters<RunInvestigationTurn['execute']>[0],
    error: unknown
  ): Promise<RunInvestigationTurnResult> {
    const failure =
      error instanceof ReviewAgentExecutionError
        ? error
        : new ReviewAgentExecutionError(
            ReviewAgentFailureClass.ProcessFailure,
            null,
            'review_agent_unclassified_failure'
          );
    const reason = abortReason(failure.failureClass);
    const delay =
      failure.retryAfterMs === null
        ? null
        : Math.max(failure.retryAfterMs, input.minimumCapacityParkMs);
    const nextEligibleAt =
      delay === null
        ? null
        : new Date(this.dependencies.now().getTime() + delay).toISOString();
    return this.abort(input, reason, nextEligibleAt);
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
        lease: input.lease,
        reason,
        nextEligibleAt,
      });
      return { status, snapshot };
    } catch (error) {
      return this.reconcileAmbiguous(input, error);
    }
  }

  private async reconcileAmbiguous(
    input: Parameters<RunInvestigationTurn['execute']>[0],
    error: unknown
  ): Promise<RunInvestigationTurnResult> {
    if (
      !(error instanceof ReviewInvestigationControlPlaneError) ||
      error.failureClass !==
        ReviewInvestigationControlPlaneFailureClass.AmbiguousOutcome
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
        ? RunInvestigationTurnStatus.Committed
        : RunInvestigationTurnStatus.RecoveryRequired,
      snapshot: restored,
    };
  }
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
