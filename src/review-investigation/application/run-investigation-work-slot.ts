import type { CanonicalJsonValue } from '../domain/canonical-json';
import {
  ReviewInvestigationNextAction,
  ReviewInvestigationRunStatus,
  ReviewInvestigationState,
  type ReviewInvestigationRunResult,
  type ReviewInvestigationSnapshot,
} from '../domain/investigation-state';
import {
  ReviewInvestigationControlPlaneError,
  ReviewInvestigationControlPlaneFailureClass,
  ReviewInvestigationLeaseAcquireStatus,
  type ReviewInvestigationControlPlanePort,
  type ReviewInvestigationDelayPort,
  type ReviewInvestigationLease,
  type ReviewInvestigationLeasePort,
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

export enum ReviewInvestigationLegacyFallbackReason {
  CapabilityDisabledBeforeOpen = 'capability_disabled_before_open',
  RecordOnlyDeferred = 'record_only_deferred',
}

export class ReviewInvestigationLegacyFallbackSignal extends Error {
  constructor(
    readonly reason: ReviewInvestigationLegacyFallbackReason = ReviewInvestigationLegacyFallbackReason.CapabilityDisabledBeforeOpen,
    readonly deferredStatus: ReviewInvestigationDeferredRunStatus | null = null
  ) {
    super(`review_investigation_legacy_fallback:${reason}`);
    this.name = 'ReviewInvestigationLegacyFallbackSignal';
  }
}

export type ReviewInvestigationDeferredRunStatus =
  | ReviewInvestigationRunStatus.Parked
  | ReviewInvestigationRunStatus.RecoveryRequired
  | ReviewInvestigationRunStatus.TransitionBudgetExhausted;

export class ReviewInvestigationDeferredSignal extends Error {
  constructor(readonly status: ReviewInvestigationDeferredRunStatus) {
    super(`review_investigation_deferred:${status}`);
    this.name = 'ReviewInvestigationDeferredSignal';
  }
}

export class RunInvestigationWorkSlot {
  constructor(
    private readonly dependencies: Readonly<{
      controlPlane: ReviewInvestigationControlPlanePort;
      leases: ReviewInvestigationLeasePort;
      delay: ReviewInvestigationDelayPort;
      turnRunner: RunInvestigationTurn;
      replay?: ReviewInvestigationReplayUseCasePort;
      now?: () => Date;
    }>
  ) {}

  async execute(
    input: ReviewInvestigationOpenInput & {
      readonly requestedModel: string;
      readonly providerKind: ReviewAgentProviderKind;
      readonly promptFor: (snapshot: ReviewInvestigationSnapshot) => string;
      readonly workingDirectory: string;
      readonly turnBudget: CanonicalJsonValue;
      readonly leaseDurationMs: number;
      readonly maxObligationsForTurn: number;
      readonly providerTimeoutMs: number;
      readonly providerMaxTurns: number;
      readonly certificateTtlMs: number;
      readonly minimumCapacityParkMs: number;
      readonly maxStateTransitions: number;
      readonly signal?: AbortSignal;
      readonly targetRevision?: ReviewInvestigationTargetRevision;
      readonly targetScope?: ReviewInvestigationTargetScope;
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
    let snapshot: ReviewInvestigationSnapshot;
    if (replayed !== null) {
      snapshot = replayed;
    } else {
      try {
        snapshot = await this.dependencies.controlPlane.open(input);
      } catch (error) {
        if (
          error instanceof ReviewInvestigationControlPlaneError &&
          error.failureClass ===
            ReviewInvestigationControlPlaneFailureClass.CapabilityDisabled
        ) {
          throw new ReviewInvestigationLegacyFallbackSignal();
        }
        throw error;
      }
    }
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
      const acquired = await this.dependencies.leases.acquire({
        authorizationToken: input.authorizationToken,
        snapshot,
        investigationId: snapshot.investigationId,
        turnId: turn.turnId,
        providerStrategyId: input.providerStrategyId,
        providerManifestCanonicalJson: input.providerManifestCanonicalJson,
        providerManifestHash: input.providerManifestHash,
        ownerIdHash: input.ownerIdHash,
      });
      if (acquired.status !== ReviewInvestigationLeaseAcquireStatus.Acquired) {
        const restored = await this.restoreAfterLeaseContention({
          input,
          snapshot,
          turnId: turn.turnId,
          waitForCompletion:
            acquired.status === ReviewInvestigationLeaseAcquireStatus.Busy,
        });
        if (
          restored === null ||
          sameActiveTurn(restored, snapshot, turn.turnId)
        ) {
          return { status: ReviewInvestigationRunStatus.Parked, snapshot };
        }
        snapshot = restored;
        continue;
      }
      let lease = acquired.lease;
      try {
        const result = await superviseLease({
          lease,
          renew: (currentLease) =>
            this.dependencies.leases.renew({
              lease: currentLease,
              ownerIdHash: input.ownerIdHash,
            }),
          onLeaseAccepted: (renewedLease) => {
            lease = renewedLease;
          },
          signal: input.signal,
          now: this.dependencies.now ?? (() => new Date()),
          operation: (signal, currentLease) =>
            this.dependencies.turnRunner.execute({
              authorizationToken: input.authorizationToken,
              authorizationId: input.authorizationId,
              executionId: input.executionId,
              workSlotId: input.workSlotId,
              reviewRevisionHash: input.reviewRevisionHash,
              requestedModel: input.requestedModel,
              providerKind: input.providerKind,
              prompt: input.promptFor(snapshot),
              workingDirectory: input.workingDirectory,
              timeoutMs: input.providerTimeoutMs,
              maxTurns: input.providerMaxTurns,
              minimumCapacityParkMs: input.minimumCapacityParkMs,
              snapshot,
              currentLease,
              signal,
            }),
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
        try {
          await this.dependencies.leases.release({
            investigationId: snapshot.investigationId,
            turnId: turn.turnId,
            lease,
            ownerIdHash: input.ownerIdHash,
          });
        } catch {
          // The fenced turn mutation is durable; lease expiry is the cleanup fallback.
        }
      }
    }
    return {
      status: ReviewInvestigationRunStatus.TransitionBudgetExhausted,
      snapshot,
    };
  }

  private async restoreAfterLeaseContention(input: {
    readonly input: Parameters<RunInvestigationWorkSlot['execute']>[0];
    readonly snapshot: ReviewInvestigationSnapshot;
    readonly turnId: string;
    readonly waitForCompletion: boolean;
  }): Promise<ReviewInvestigationSnapshot | null> {
    const startedAt = (this.dependencies.now ?? (() => new Date()))().getTime();
    const turnExpiresAt = Date.parse(input.snapshot.turn?.expiresAt ?? '');
    const boundedWaitMs = input.waitForCompletion
      ? Math.max(
          0,
          Math.min(
            input.input.providerTimeoutMs + input.input.minimumCapacityParkMs,
            Number.isFinite(turnExpiresAt)
              ? turnExpiresAt - startedAt
              : input.input.providerTimeoutMs
          )
        )
      : 0;
    const pollIntervalMs = 5_000;
    const maxPolls = Math.max(1, Math.ceil(boundedWaitMs / pollIntervalMs) + 1);
    let restored: ReviewInvestigationSnapshot | null = null;
    for (let poll = 0; poll < maxPolls; poll += 1) {
      throwIfAborted(input.input.signal);
      restored = await this.dependencies.controlPlane.restore({
        authorizationToken: input.input.authorizationToken,
        authorizationId: input.input.authorizationId,
        investigationId: input.snapshot.investigationId,
        reviewRevisionHash: input.input.reviewRevisionHash,
      });
      if (
        restored === null ||
        !sameActiveTurn(restored, input.snapshot, input.turnId)
      ) {
        return restored;
      }
      if (poll + 1 >= maxPolls) break;
      await this.dependencies.delay.sleep(
        Math.min(
          pollIntervalMs,
          Math.max(1, boundedWaitMs - poll * pollIntervalMs)
        )
      );
    }
    return restored;
  }
}

async function superviseLease<T>(input: {
  readonly lease: ReviewInvestigationLease;
  readonly renew: (
    currentLease: ReviewInvestigationLease
  ) => Promise<ReviewInvestigationLease>;
  readonly onLeaseAccepted: (lease: ReviewInvestigationLease) => void;
  readonly signal?: AbortSignal;
  readonly now: () => Date;
  readonly operation: (
    signal: AbortSignal,
    currentLease: () => ReviewInvestigationLease
  ) => Promise<T>;
}): Promise<T> {
  requireLeaseValidity(input.lease);
  let currentLease = input.lease;
  let stopped = false;
  let wake: (() => void) | undefined;
  const abort = new AbortController();
  const relayAbort = () => abort.abort(input.signal?.reason);
  if (input.signal?.aborted) relayAbort();
  else input.signal?.addEventListener('abort', relayAbort, { once: true });
  let rejectLeaseFailure!: (reason: unknown) => void;
  const leaseFailure = new Promise<never>((_resolve, reject) => {
    rejectLeaseFailure = reject;
  });
  const failLease = (error: unknown) => {
    if (stopped || abort.signal.aborted) return;
    abort.abort(error);
    rejectLeaseFailure(error);
  };
  const wait = (delayMs: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      timer.unref?.();
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  const renewLoop = (async () => {
    while (!stopped) {
      const remaining =
        Date.parse(currentLease.expiresAt) - input.now().getTime();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        failLease(new Error('review_investigation_lease_expired'));
        return;
      }
      const atCeiling =
        Date.parse(currentLease.expiresAt) >=
        Date.parse(currentLease.resultReportUntil);
      await wait(
        atCeiling
          ? remaining
          : Math.min(30_000, Math.max(1_000, Math.floor(remaining / 2)))
      );
      if (stopped) return;
      if (atCeiling) {
        failLease(new Error('review_investigation_lease_expired'));
        return;
      }
      try {
        const renewed = await input.renew(currentLease);
        requireLeaseRenewalContinuity(currentLease, renewed);
        currentLease = renewed;
        input.onLeaseAccepted(renewed);
      } catch (error) {
        failLease(error);
        return;
      }
    }
  })();

  const operation = Promise.resolve().then(() =>
    input.operation(abort.signal, () => currentLease)
  );
  try {
    return await Promise.race([operation, leaseFailure]);
  } finally {
    stopped = true;
    wake?.();
    input.signal?.removeEventListener('abort', relayAbort);
    await renewLoop;
    await operation.catch(() => undefined);
  }
}

function sameActiveTurn(
  restored: ReviewInvestigationSnapshot,
  previous: ReviewInvestigationSnapshot,
  turnId: string
): boolean {
  return (
    restored.version === previous.version &&
    restored.turn?.turnId === turnId &&
    restored.nextAction !== ReviewInvestigationNextAction.Terminal
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('review_investigation_cancelled');
}

function requireLeaseRenewalContinuity(
  previous: ReviewInvestigationLease,
  renewed: ReviewInvestigationLease
): void {
  requireLeaseValidity(renewed, 'review_investigation_lease_renewal_drift');
  const renewedExpiry = Date.parse(renewed.expiresAt);
  if (
    renewed.leaseId !== previous.leaseId ||
    renewed.attemptId !== previous.attemptId ||
    renewed.fencingToken !== previous.fencingToken ||
    renewed.resultReportUntil !== previous.resultReportUntil ||
    renewed.leaseCapability.length === 0 ||
    renewed.leaseCapability === previous.leaseCapability ||
    renewedExpiry <= Date.parse(previous.expiresAt)
  ) {
    throw new Error('review_investigation_lease_renewal_drift');
  }
}

function requireLeaseValidity(
  lease: ReviewInvestigationLease,
  errorCode = 'review_investigation_lease_invalid'
): void {
  const expiresAt = Date.parse(lease.expiresAt);
  const resultReportUntil = Date.parse(lease.resultReportUntil);
  if (
    lease.leaseId.length === 0 ||
    lease.attemptId.length === 0 ||
    lease.leaseCapability.length === 0 ||
    lease.fencingToken.length === 0 ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(resultReportUntil) ||
    expiresAt > resultReportUntil
  ) {
    throw new Error(errorCode);
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
