import {
  ReviewAgentExecutionError,
  ReviewAgentFailureClass,
  type ReviewAgentPort,
} from '../../../src/review-investigation/application/review-agent-port';
import {
  ReviewInvestigationControlPlaneError,
  ReviewInvestigationControlPlaneFailureClass,
  ReviewInvestigationCurrency,
  ReviewInvestigationLeaseAcquireStatus,
  type ReviewInvestigationControlPlanePort,
  type ReviewInvestigationLease,
  type ReviewInvestigationLeasePort,
} from '../../../src/review-investigation/application/investigation-control-plane-port';
import type {
  ReviewInvestigationGatewaySessionFactoryPort,
  ReviewInvestigationGatewaySessionPort,
} from '../../../src/review-investigation/application/investigation-gateway-port';
import { RunInvestigationTurn } from '../../../src/review-investigation/application/run-investigation-turn';
import { RunInvestigationWorkSlot } from '../../../src/review-investigation/application/run-investigation-work-slot';
import {
  ReviewAgentExecutionProfile,
  ReviewAgentProviderKind,
  type ReviewAgentProtocolRequirements,
  type ReviewAgentRuntimeProfile,
} from '../../../src/review-investigation/domain/runtime-profile';
import {
  ReviewInvestigationNextAction,
  ReviewInvestigationRunStatus,
  ReviewInvestigationState,
  type ReviewInvestigationSnapshot,
} from '../../../src/review-investigation/domain/investigation-state';
import {
  ReviewTurnPurpose,
  type ReviewTurnObservation,
} from '../../../src/review-investigation/domain/turn-observation';

const digest = 'a'.repeat(64);
const revisionHash = 'b'.repeat(64);
const lease: ReviewInvestigationLease = Object.freeze({
  leaseId: 'lease-1',
  attemptId: 'attempt-1',
  leaseCapability: 'lease.capability.value',
  fencingToken: '1',
  expiresAt: '2026-08-02T10:10:00.000Z',
  resultReportUntil: '2026-08-02T10:20:00.000Z',
});

describe('RunInvestigationWorkSlot', () => {
  it('refreshes a restored active-turn capability before provider execution', async () => {
    const restored = Object.freeze({
      ...plannedSnapshot(),
      turn: Object.freeze({
        ...plannedSnapshot().turn!,
        turnCapability: '',
      }),
    });
    const planned = plannedSnapshot();
    const committed = terminalSnapshot(3);
    const controlPlane = controlPlaneFixture(restored);
    controlPlane.planTurn.mockImplementation(async () => {
      controlPlane.current = planned;
      return planned;
    });
    controlPlane.commitTurn.mockImplementation(async () => {
      controlPlane.current = committed;
      return committed;
    });
    const agent = agentFixture(observation());
    const runner = runnerFixture(controlPlane, agent);

    const result = await runner.execute(runInput());

    expect(result.status).toBe(ReviewInvestigationRunStatus.Completed);
    expect(controlPlane.planTurn).toHaveBeenCalledTimes(1);
    expect(agent.executeTurn).toHaveBeenCalledTimes(1);
  });

  it('reconciles an ambiguous accepted commit without a second provider call', async () => {
    const planned = plannedSnapshot();
    const committed = terminalSnapshot(3);
    const controlPlane = controlPlaneFixture(planned);
    controlPlane.commitTurn.mockImplementation(async () => {
      controlPlane.current = committed;
      throw new ReviewInvestigationControlPlaneError(
        ReviewInvestigationControlPlaneFailureClass.AmbiguousOutcome,
        'connection_closed_after_commit'
      );
    });
    const agent = agentFixture(observation());
    const runner = runnerFixture(controlPlane, agent);

    const result = await runner.execute(runInput());

    expect(result).toEqual({
      status: ReviewInvestigationRunStatus.Completed,
      snapshot: committed,
    });
    expect(agent.executeTurn).toHaveBeenCalledTimes(1);
    expect(controlPlane.restore).toHaveBeenCalledTimes(1);

    const restartedAgent = agentFixture(observation());
    const restarted = runnerFixture(controlPlane, restartedAgent);
    const restoredResult = await restarted.execute(runInput());
    expect(restoredResult.status).toBe(ReviewInvestigationRunStatus.Completed);
    expect(restartedAgent.executeTurn).not.toHaveBeenCalled();
  });

  it('uses the orchestration-managed lease without acquiring or releasing it', async () => {
    const planned = plannedSnapshot();
    const committed = terminalSnapshot(3);
    const controlPlane = controlPlaneFixture(planned);
    controlPlane.commitTurn.mockImplementation(async (input) => {
      expect(input.lease.attemptId).toBe('attempt-managed');
      controlPlane.current = committed;
      return committed;
    });
    const leases: ReviewInvestigationLeasePort = {
      acquire: jest.fn(),
      release: jest.fn(),
    };
    const managedLease = Object.freeze({
      ...lease,
      attemptId: 'attempt-managed',
      leaseCapability: 'managed.lease.capability',
    });
    const runner = runnerFixture(controlPlane, agentFixture(observation()), {
      leases,
    });

    const result = await runner.execute({
      ...runInput(),
      managedLease: () => managedLease,
    });

    expect(result.status).toBe(ReviewInvestigationRunStatus.Completed);
    expect(leases.acquire).not.toHaveBeenCalled();
    expect(leases.release).not.toHaveBeenCalled();
  });

  it('stops for recovery when an ambiguous commit was not accepted', async () => {
    const planned = plannedSnapshot();
    const controlPlane = controlPlaneFixture(planned);
    controlPlane.commitTurn.mockRejectedValue(
      new ReviewInvestigationControlPlaneError(
        ReviewInvestigationControlPlaneFailureClass.AmbiguousOutcome,
        'connection_closed_before_commit'
      )
    );
    const agent = agentFixture(observation());
    const runner = runnerFixture(controlPlane, agent);

    const result = await runner.execute(runInput());

    expect(result.status).toBe(ReviewInvestigationRunStatus.RecoveryRequired);
    expect(result.snapshot).toBe(planned);
    expect(agent.executeTurn).toHaveBeenCalledTimes(1);
    expect(controlPlane.commitTurn).toHaveBeenCalledTimes(1);
  });

  it('cancels and aborts a turn when the revision becomes superseded', async () => {
    const planned = plannedSnapshot();
    const superseded = Object.freeze({
      ...planned,
      version: 3,
      state: ReviewInvestigationState.Superseded,
      nextAction: ReviewInvestigationNextAction.Terminal,
      turn: null,
    });
    const controlPlane = controlPlaneFixture(planned);
    controlPlane.abortTurn.mockImplementation(async () => {
      controlPlane.current = superseded;
      return superseded;
    });
    const currency = jest
      .fn()
      .mockResolvedValueOnce(ReviewInvestigationCurrency.Current)
      .mockResolvedValueOnce(ReviewInvestigationCurrency.Superseded);
    const agent = agentFixture(observation());
    const gateway = gatewayFixture();
    const runner = runnerFixture(controlPlane, agent, { currency, gateway });

    const result = await runner.execute(runInput());

    expect(result.status).toBe(ReviewInvestigationRunStatus.Superseded);
    expect(agent.cancel).toHaveBeenCalledTimes(1);
    expect(gateway.session.seal).not.toHaveBeenCalled();
    expect(controlPlane.commitTurn).not.toHaveBeenCalled();
  });

  it('parks capacity failures until the bounded retry timestamp', async () => {
    const planned = plannedSnapshot();
    const parked = Object.freeze({
      ...planned,
      version: 3,
      state: ReviewInvestigationState.AwaitingTurn,
      nextAction: ReviewInvestigationNextAction.AwaitCapacity,
      nextEligibleAt: '2026-08-02T10:01:00.000Z',
      turn: null,
    });
    const controlPlane = controlPlaneFixture(planned);
    controlPlane.abortTurn.mockImplementation(async (input) => {
      expect(input.nextEligibleAt).toBe('2026-08-02T10:01:00.000Z');
      controlPlane.current = parked;
      return parked;
    });
    const agent = agentFixture(
      new ReviewAgentExecutionError(
        ReviewAgentFailureClass.CapacityUnavailable,
        1_000,
        'capacity_unavailable'
      )
    );
    const runner = runnerFixture(controlPlane, agent);

    const result = await runner.execute(runInput());

    expect(result.status).toBe(ReviewInvestigationRunStatus.Parked);
    expect(agent.executeTurn).toHaveBeenCalledTimes(1);
    expect(controlPlane.abortTurn).toHaveBeenCalledTimes(1);
    expect(controlPlane.planTurn).not.toHaveBeenCalled();
  });
});

type ControlPlaneFixture = ReviewInvestigationControlPlanePort & {
  current: ReviewInvestigationSnapshot;
  open: jest.MockedFunction<ReviewInvestigationControlPlanePort['open']>;
  restore: jest.MockedFunction<ReviewInvestigationControlPlanePort['restore']>;
  planTurn: jest.MockedFunction<
    ReviewInvestigationControlPlanePort['planTurn']
  >;
  commitTurn: jest.MockedFunction<
    ReviewInvestigationControlPlanePort['commitTurn']
  >;
  abortTurn: jest.MockedFunction<
    ReviewInvestigationControlPlanePort['abortTurn']
  >;
  conclude: jest.MockedFunction<
    ReviewInvestigationControlPlanePort['conclude']
  >;
};

function controlPlaneFixture(
  initial: ReviewInvestigationSnapshot
): ControlPlaneFixture {
  const fixture = {} as ControlPlaneFixture;
  fixture.current = initial;
  fixture.open = jest.fn(async (_input) => fixture.current);
  fixture.restore = jest.fn(async (_input) => fixture.current);
  fixture.planTurn = jest.fn(async (_input) => fixture.current);
  fixture.commitTurn = jest.fn(async (_input) => fixture.current);
  fixture.abortTurn = jest.fn(async (_input) => fixture.current);
  fixture.conclude = jest.fn(async (_input) => fixture.current);
  return fixture;
}

type AgentFixture = ReviewAgentPort & {
  executeTurn: jest.MockedFunction<ReviewAgentPort['executeTurn']>;
  cancel: jest.MockedFunction<ReviewAgentPort['cancel']>;
};

function agentFixture(
  outcome: ReviewTurnObservation | ReviewAgentExecutionError
): AgentFixture {
  const executeTurn: jest.MockedFunction<ReviewAgentPort['executeTurn']> =
    jest.fn(async (_request) => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
  const cancel: jest.MockedFunction<ReviewAgentPort['cancel']> = jest.fn(
    async (_invocationId, _fencingToken) => undefined
  );
  return {
    negotiate: jest.fn(
      async (_requirements: ReviewAgentProtocolRequirements) =>
        ({}) as ReviewAgentRuntimeProfile
    ),
    executeTurn,
    cancel,
  };
}

function gatewayFixture(): {
  factory: ReviewInvestigationGatewaySessionFactoryPort;
  session: {
    seal: jest.MockedFunction<ReviewInvestigationGatewaySessionPort['seal']>;
    dispose: jest.MockedFunction<
      ReviewInvestigationGatewaySessionPort['dispose']
    >;
  };
} {
  const seal: jest.MockedFunction<
    ReviewInvestigationGatewaySessionPort['seal']
  > = jest.fn(async (_input) => ({
    attestationId: 'attestation-1',
    attestationHash: 'c'.repeat(64),
  }));
  const dispose: jest.MockedFunction<
    ReviewInvestigationGatewaySessionPort['dispose']
  > = jest.fn(async () => undefined);
  const session = {
    providerConfig: Object.freeze({
      policyVersion: 'context-gateway-v4' as const,
      binaryHash: digest,
      command: '/usr/bin/node',
      args: Object.freeze(['/tmp/context-gateway.cjs']),
      cwd: '/tmp/sandbox-review',
      enabledTools: Object.freeze(['review_read_file']),
      runtimeEnvironment: Object.freeze({}),
      credentialEnvironment: Object.freeze({}),
    }),
    seal,
    dispose,
  };
  return {
    factory: { open: jest.fn(async () => session) },
    session,
  };
}

function runnerFixture(
  controlPlane: ControlPlaneFixture,
  agent: AgentFixture,
  overrides: {
    currency?: jest.Mock;
    gateway?: ReturnType<typeof gatewayFixture>;
    leases?: ReviewInvestigationLeasePort;
  } = {}
): RunInvestigationWorkSlot {
  const gateway = overrides.gateway ?? gatewayFixture();
  const turnRunner = new RunInvestigationTurn({
    controlPlane,
    currency: {
      check:
        overrides.currency ??
        jest.fn(async () => ReviewInvestigationCurrency.Current),
    },
    gateway: gateway.factory,
    agent,
    now: () => new Date('2026-08-02T10:00:00.000Z'),
  });
  const leases: ReviewInvestigationLeasePort = overrides.leases ?? {
    acquire: jest.fn(async () => ({
      status: ReviewInvestigationLeaseAcquireStatus.Acquired,
      lease,
    })),
    release: jest.fn(async () => undefined),
  };
  return new RunInvestigationWorkSlot({ controlPlane, leases, turnRunner });
}

function runInput() {
  return {
    authorizationToken: 'authorization.token.value',
    authorizationId: 'authorization-1',
    executionId: 'execution-1',
    workSlotId: 'work-slot-1',
    reviewRevisionHash: revisionHash,
    stableReviewUnitKey: 'review-unit-1',
    providerVoteLaneId: 'lane-1',
    providerStrategyId: 'codex-primary',
    runtimeProfile: ReviewAgentExecutionProfile.GatewayAttestedAgentV1,
    coverageContract: { version: 1 },
    investigationPolicy: { version: 1 },
    seedObligations: [],
    initialReceipts: [],
    requestedModel: 'gpt-5.6-sol',
    promptFor: () => 'Review the current work slot.',
    workingDirectory: '/tmp/sandbox-review',
    providerCredentialEnvironment: {},
    turnBudget: { maxOperations: 32 },
    leaseDurationMs: 300_000,
    maxObligationsForTurn: 16,
    providerTimeoutMs: 600_000,
    providerMaxTurns: 8,
    certificateTtlMs: 3_600_000,
    minimumCapacityParkMs: 60_000,
    maxStateTransitions: 8,
  } as const;
}

function plannedSnapshot(): ReviewInvestigationSnapshot {
  return Object.freeze({
    investigationId: 'investigation-1',
    version: 2,
    state: ReviewInvestigationState.TurnLeased,
    dossierDigest: digest,
    openObligationCount: 1,
    satisfiedObligationCount: 0,
    unresolvableObligationCount: 0,
    findingCount: 0,
    semanticTurns: 0,
    operationalAttempts: 0,
    criticCycles: 0,
    nextEligibleAt: null,
    nextAction: ReviewInvestigationNextAction.RunTurn,
    turn: Object.freeze({
      turnId: 'turn-1',
      purpose: ReviewTurnPurpose.Discovery,
      leasedAtVersion: 2,
      dossierDigest: digest,
      obligationIds: Object.freeze(['d'.repeat(64)]),
      semanticTurnOrdinal: 1,
      criticCycleOrdinal: 0,
      leasedAt: '2026-08-02T10:00:00.000Z',
      expiresAt: '2026-08-02T10:05:00.000Z',
      turnCapability: 'turn.capability.value',
      brief: null,
    }),
  });
}

function terminalSnapshot(version: number): ReviewInvestigationSnapshot {
  return Object.freeze({
    ...plannedSnapshot(),
    version,
    state: ReviewInvestigationState.Inconclusive,
    nextAction: ReviewInvestigationNextAction.Terminal,
    turn: null,
  });
}

function observation(): ReviewTurnObservation {
  return Object.freeze({
    outputVersion: 1,
    findings: Object.freeze([]),
    obligationProposals: Object.freeze([]),
    closureClaims: Object.freeze([]),
    unresolvableClaims: Object.freeze([]),
    criticDecision: null,
    observationVersion: 1,
    invocationId: 'investigation-1:turn-1:attempt-1',
    turnId: 'turn-1',
    dossierVersion: 2,
    purpose: ReviewTurnPurpose.Discovery,
    actualProviderKind: ReviewAgentProviderKind.Codex,
    actualModel: 'gpt-5.6-sol',
    runtimeProfile: ReviewAgentExecutionProfile.GatewayAttestedAgentV1,
    usage: Object.freeze({
      inputTokens: 100,
      cachedInputTokens: 50,
      outputTokens: 10,
      reasoningOutputTokens: 5,
      totalTokens: 115,
    }),
    durationMs: 1_000,
    schemaComplete: true,
    streamComplete: true,
    contextAttestationReference: null,
  });
}
