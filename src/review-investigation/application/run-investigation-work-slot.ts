import type { CanonicalJsonValue } from '../domain/canonical-json';
import {
  ReviewInvestigationNextAction,
  ReviewInvestigationRunStatus,
  ReviewInvestigationState,
  type ReviewInvestigationRunResult,
  type ReviewInvestigationSnapshot,
} from '../domain/investigation-state';
import {
  ReviewInvestigationLeaseAcquireStatus,
  type ReviewInvestigationControlPlanePort,
  type ReviewInvestigationLeasePort,
  type ReviewInvestigationLease,
  type ReviewInvestigationOpenInput,
  type ReviewInvestigationReplayUseCasePort,
  type ReviewInvestigationTargetScope,
  type ReviewInvestigationTargetRevision,
} from './investigation-control-plane-port';
import {
  RunInvestigationTurn,
  RunInvestigationTurnStatus,
} from './run-investigation-turn';
import type { ReviewAgentProviderKind } from '../domain/runtime-profile';

export class RunInvestigationWorkSlot {
  constructor(
    private readonly dependencies: Readonly<{
      controlPlane: ReviewInvestigationControlPlanePort;
      leases: ReviewInvestigationLeasePort;
      turnRunner: RunInvestigationTurn;
      replay?: ReviewInvestigationReplayUseCasePort;
    }>
  ) {}

  async execute(
    input: ReviewInvestigationOpenInput & {
      readonly requestedModel: string;
      readonly providerKind: ReviewAgentProviderKind;
      readonly promptFor: (snapshot: ReviewInvestigationSnapshot) => string;
      readonly workingDirectory: string;
      readonly providerCredentialEnvironment: Readonly<NodeJS.ProcessEnv>;
      readonly turnBudget: CanonicalJsonValue;
      readonly leaseDurationMs: number;
      readonly maxObligationsForTurn: number;
      readonly providerTimeoutMs: number;
      readonly providerMaxTurns: number;
      readonly certificateTtlMs: number;
      readonly minimumCapacityParkMs: number;
      readonly maxStateTransitions: number;
      readonly managedLease?: () => ReviewInvestigationLease;
      readonly signal?: AbortSignal;
      readonly targetRevision?: ReviewInvestigationTargetRevision;
      readonly targetScope?: ReviewInvestigationTargetScope;
      readonly providerManifestCanonicalJson?: string;
      readonly providerManifestHash?: string;
    }
  ): Promise<ReviewInvestigationRunResult> {
    let replayed: ReviewInvestigationSnapshot | null = null;
    if (this.dependencies.replay) {
      if (
        !input.targetRevision ||
        !input.targetScope ||
        !input.providerManifestCanonicalJson ||
        !input.providerManifestHash
      ) {
        throw new Error('review_investigation_replay_input_missing');
      }
      replayed = await this.dependencies.replay.execute({
        open: input,
        scope: input.targetScope,
        revision: input.targetRevision,
        providerManifestCanonicalJson: input.providerManifestCanonicalJson,
        providerManifestHash: input.providerManifestHash,
      });
    }
    let snapshot =
      replayed ?? (await this.dependencies.controlPlane.open(input));
    for (
      let transition = 0;
      transition < input.maxStateTransitions;
      transition += 1
    ) {
      if (isSuperseded(snapshot)) {
        return { status: ReviewInvestigationRunStatus.Superseded, snapshot };
      }
      if (
        snapshot.nextAction === ReviewInvestigationNextAction.Terminal ||
        isTerminal(snapshot)
      ) {
        return { status: ReviewInvestigationRunStatus.Completed, snapshot };
      }
      if (snapshot.nextAction === ReviewInvestigationNextAction.AwaitCapacity) {
        return { status: ReviewInvestigationRunStatus.Parked, snapshot };
      }
      if (snapshot.nextAction === ReviewInvestigationNextAction.Conclude) {
        snapshot = await this.dependencies.controlPlane.conclude({
          authorizationToken: input.authorizationToken,
          snapshot,
          certificateTtlMs: input.certificateTtlMs,
        });
        continue;
      }
      if (snapshot.turn === null || snapshot.turn.turnCapability.length === 0) {
        snapshot = await this.dependencies.controlPlane.planTurn({
          authorizationToken: input.authorizationToken,
          snapshot,
          leaseDurationMs: input.leaseDurationMs,
          maxObligationsForTurn: input.maxObligationsForTurn,
          turnBudget: input.turnBudget,
        });
        continue;
      }

      const turn = snapshot.turn;
      const managedLease = input.managedLease?.();
      const acquired = managedLease
        ? null
        : await this.dependencies.leases.acquire({
            investigationId: snapshot.investigationId,
            turnId: turn.turnId,
            providerStrategyId: input.providerStrategyId,
          });
      if (
        acquired !== null &&
        acquired.status !== ReviewInvestigationLeaseAcquireStatus.Acquired
      ) {
        return { status: ReviewInvestigationRunStatus.Parked, snapshot };
      }
      const lease = managedLease ?? acquired!.lease;
      try {
        const result = await this.dependencies.turnRunner.execute({
          authorizationToken: input.authorizationToken,
          authorizationId: input.authorizationId,
          executionId: input.executionId,
          workSlotId: input.workSlotId,
          reviewRevisionHash: input.reviewRevisionHash,
          providerStrategyId: input.providerStrategyId,
          requestedModel: input.requestedModel,
          providerKind: input.providerKind,
          prompt: input.promptFor(snapshot),
          workingDirectory: input.workingDirectory,
          timeoutMs: input.providerTimeoutMs,
          maxTurns: input.providerMaxTurns,
          minimumCapacityParkMs: input.minimumCapacityParkMs,
          snapshot,
          lease,
          providerCredentialEnvironment: input.providerCredentialEnvironment,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        snapshot = result.snapshot;
        if (result.status === RunInvestigationTurnStatus.RecoveryRequired) {
          return {
            status: ReviewInvestigationRunStatus.RecoveryRequired,
            snapshot,
          };
        }
        if (result.status === RunInvestigationTurnStatus.Superseded) {
          return { status: ReviewInvestigationRunStatus.Superseded, snapshot };
        }
      } finally {
        if (acquired !== null) {
          await this.dependencies.leases.release({
            investigationId: snapshot.investigationId,
            turnId: turn.turnId,
            lease,
          });
        }
      }
    }
    return {
      status: ReviewInvestigationRunStatus.TransitionBudgetExhausted,
      snapshot,
    };
  }
}

function isTerminal(snapshot: ReviewInvestigationSnapshot): boolean {
  return [
    ReviewInvestigationState.Concluded,
    ReviewInvestigationState.Expired,
  ].includes(snapshot.state);
}

function isSuperseded(snapshot: ReviewInvestigationSnapshot): boolean {
  return snapshot.state === ReviewInvestigationState.Superseded;
}
