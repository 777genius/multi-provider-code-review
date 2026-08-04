import {
  ReviewAgentExecutionError,
  ReviewAgentExecutionSessionKind,
  ReviewAgentFailureClass,
  type ReviewAgentPort,
  type ReviewAgentSelectionPort,
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
  ReviewInvestigationTurnExecutionAuthority,
} from '../../../src/review-investigation/application/investigation-gateway-port';
import { RunInvestigationTurn } from '../../../src/review-investigation/application/run-investigation-turn';
import {
  ReviewInvestigationOperationalFailurePhase,
  type ReviewInvestigationOperationalDiagnosticPort,
} from '../../../src/review-investigation/application/investigation-operational-diagnostic-port';
import {
  ReviewInvestigationLegacyFallbackSignal,
  RunInvestigationWorkSlot,
} from '../../../src/review-investigation/application/run-investigation-work-slot';
import {
  ReviewAgentExecutionProfile,
  ReviewAgentProviderKind,
  type ReviewAgentProtocolRequirements,
  type ReviewAgentRuntimeProfile,
} from '../../../src/review-investigation/domain/runtime-profile';
import {
  ReviewInvestigationAbortReason,
  ReviewInvestigationNextAction,
  ReviewInvestigationConclusion,
  ReviewInvestigationObligationOrigin,
  ReviewInvestigationRunStatus,
  ReviewInvestigationState,
  type ReviewInvestigationSnapshot,
} from '../../../src/review-investigation/domain/investigation-state';
import {
  ReviewTurnCriticDecision,
  ReviewTurnObligationKind,
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
  it('concludes an inconclusive aggregate before treating it as terminal', async () => {
    const pending = Object.freeze({
      ...plannedSnapshot(),
      state: ReviewInvestigationState.Inconclusive,
      nextAction: ReviewInvestigationNextAction.Conclude,
      turn: null,
    });
    const terminal = terminalSnapshot(4);
    const controlPlane = controlPlaneFixture(pending);
    controlPlane.conclude.mockImplementation(async () => {
      controlPlane.current = terminal;
      return terminal;
    });
    const agent = agentFixture(observation());

    const result = await runnerFixture(controlPlane, agent).execute(runInput());

    expect(result).toEqual({
      status: ReviewInvestigationRunStatus.Completed,
      snapshot: terminal,
    });
    expect(controlPlane.conclude).toHaveBeenCalledTimes(1);
    expect(agent.executeTurn).not.toHaveBeenCalled();
  });

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

  it('preserves a committed outcome when gateway disposal fails', async () => {
    const planned = plannedSnapshot();
    const committed = terminalSnapshot(3);
    const controlPlane = controlPlaneFixture(planned);
    controlPlane.commitTurn.mockImplementation(async () => {
      controlPlane.current = committed;
      return committed;
    });
    const gateway = gatewayFixture();
    gateway.session.dispose.mockRejectedValue(
      new Error('dispose failed with secret=cleanup-private-material')
    );
    const diagnostics = {
      record: jest.fn(async () => undefined),
    };

    const result = await runnerFixture(
      controlPlane,
      agentFixture(observation()),
      { gateway, diagnostics }
    ).execute(runInput());

    expect(result).toEqual({
      status: ReviewInvestigationRunStatus.Completed,
      snapshot: committed,
    });
    expect(controlPlane.commitTurn).toHaveBeenCalledTimes(1);
    expect(gateway.session.dispose).toHaveBeenCalledTimes(1);
    expect(diagnostics.record).toHaveBeenCalledWith({
      investigationId: 'investigation-1',
      turnId: 'turn-1',
      phase: ReviewInvestigationOperationalFailurePhase.GatewayCleanup,
      failureClass: ReviewAgentFailureClass.ProcessFailure,
      code: 'review_investigation_gateway_cleanup_failure',
      retryAfterMs: null,
    });
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

  it('reconciles a rejected commit before stopping for recovery', async () => {
    const planned = plannedSnapshot();
    const controlPlane = controlPlaneFixture(planned);
    const rejected = new ReviewInvestigationControlPlaneError(
      ReviewInvestigationControlPlaneFailureClass.Rejected,
      'investigation_turn_observation_rejected'
    );
    controlPlane.commitTurn.mockRejectedValue(rejected);
    const agent = agentFixture(observation());

    const result = await runnerFixture(controlPlane, agent).execute(runInput());

    expect(result).toEqual({
      status: ReviewInvestigationRunStatus.RecoveryRequired,
      snapshot: planned,
    });
    expect(agent.executeTurn).toHaveBeenCalledTimes(1);
    expect(controlPlane.commitTurn).toHaveBeenCalledTimes(1);
    expect(controlPlane.restore).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a commit conflict without attempting legacy recovery', async () => {
    const planned = plannedSnapshot();
    const controlPlane = controlPlaneFixture(planned);
    const conflict = new ReviewInvestigationControlPlaneError(
      ReviewInvestigationControlPlaneFailureClass.Conflict,
      'investigation_turn_fencing_conflict'
    );
    controlPlane.commitTurn.mockRejectedValue(conflict);
    const agent = agentFixture(observation());

    await expect(
      runnerFixture(controlPlane, agent).execute(runInput())
    ).rejects.toBe(conflict);
    expect(controlPlane.restore).not.toHaveBeenCalled();
  });

  it.each([
    ReviewAgentFailureClass.SchemaInvalidOutput,
    ReviewAgentFailureClass.StreamIncomplete,
    ReviewAgentFailureClass.ModelAttributionMissing,
    ReviewAgentFailureClass.UsageAttributionMissing,
  ])(
    'aborts %s once without an immediate provider retry loop',
    async (failureClass) => {
      const planned = plannedSnapshot();
      const aborted = Object.freeze({
        ...planned,
        version: 3,
        state: ReviewInvestigationState.AwaitingTurn,
        turn: null,
      });
      const controlPlane = controlPlaneFixture(planned);
      controlPlane.abortTurn.mockImplementation(async (input) => {
        expect(input.reason).toBe(
          ReviewInvestigationAbortReason.SchemaInvalidOutput
        );
        controlPlane.current = aborted;
        return aborted;
      });
      const agent = agentFixture(
        new ReviewAgentExecutionError(
          failureClass,
          null,
          'provider_output_rejected'
        )
      );

      const result = await runnerFixture(controlPlane, agent).execute(
        runInput()
      );

      expect(result).toEqual({
        status: ReviewInvestigationRunStatus.RecoveryRequired,
        snapshot: aborted,
      });
      expect(agent.executeTurn).toHaveBeenCalledTimes(1);
      expect(controlPlane.abortTurn).toHaveBeenCalledTimes(1);
      expect(controlPlane.planTurn).not.toHaveBeenCalled();
    }
  );

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

  it('preserves supersession when fenced cancellation fails', async () => {
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
    agent.cancel.mockRejectedValue(
      new Error('cancel failed with token=provider-private-material')
    );

    const result = await runnerFixture(controlPlane, agent, {
      currency,
    }).execute(runInput());

    expect(result.status).toBe(ReviewInvestigationRunStatus.Superseded);
    expect(agent.cancel).toHaveBeenCalledTimes(1);
    expect(controlPlane.abortTurn).toHaveBeenCalledTimes(1);
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

  it('parks authentication failures for the minimum capacity parking window', async () => {
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
      expect(input.reason).toBe(
        ReviewInvestigationAbortReason.AuthenticationUnavailable
      );
      expect(input.nextEligibleAt).toBe('2026-08-02T10:01:00.000Z');
      controlPlane.current = parked;
      return parked;
    });
    const agent = agentFixture(
      new ReviewAgentExecutionError(
        ReviewAgentFailureClass.AuthenticationUnavailable,
        null,
        'authentication_unavailable'
      )
    );

    const result = await runnerFixture(controlPlane, agent).execute(runInput());

    expect(result.status).toBe(ReviewInvestigationRunStatus.Parked);
    expect(agent.executeTurn).toHaveBeenCalledTimes(1);
    expect(controlPlane.abortTurn).toHaveBeenCalledTimes(1);
    expect(controlPlane.planTurn).not.toHaveBeenCalled();
  });

  it.each(['open', 'seal'] as const)(
    'preserves typed retry semantics for gateway %s failures',
    async (phase) => {
      const planned = plannedSnapshot();
      const parked = Object.freeze({
        ...planned,
        version: 3,
        state: ReviewInvestigationState.AwaitingTurn,
        nextAction: ReviewInvestigationNextAction.AwaitCapacity,
        nextEligibleAt: '2026-08-02T10:02:00.000Z',
        turn: null,
      });
      const controlPlane = controlPlaneFixture(planned);
      controlPlane.abortTurn.mockImplementation(async (input) => {
        expect(input.reason).toBe(
          ReviewInvestigationAbortReason.CapacityUnavailable
        );
        expect(input.nextEligibleAt).toBe('2026-08-02T10:02:00.000Z');
        controlPlane.current = parked;
        return parked;
      });
      const failure = new ReviewAgentExecutionError(
        ReviewAgentFailureClass.CapacityUnavailable,
        120_000,
        'provider output must not cross the gateway boundary'
      );
      const gateway = gatewayFixture();
      if (phase === 'open') {
        const open = gateway.factory.open as jest.MockedFunction<
          ReviewInvestigationGatewaySessionFactoryPort['open']
        >;
        open.mockRejectedValue(failure);
      } else {
        gateway.session.seal.mockRejectedValue(failure);
      }

      const result = await runnerFixture(
        controlPlane,
        agentFixture(observation()),
        { gateway }
      ).execute(runInput());

      expect(result.status).toBe(ReviewInvestigationRunStatus.Parked);
      expect(controlPlane.abortTurn).toHaveBeenCalledTimes(1);
      expect(controlPlane.commitTurn).not.toHaveBeenCalled();
    }
  );

  it('preserves an aborted outcome when gateway disposal fails', async () => {
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
    controlPlane.abortTurn.mockImplementation(async () => {
      controlPlane.current = parked;
      return parked;
    });
    const gateway = gatewayFixture();
    gateway.session.dispose.mockRejectedValue(
      new Error('dispose failed with source=private-source-code')
    );
    const agent = agentFixture(
      new ReviewAgentExecutionError(
        ReviewAgentFailureClass.CapacityUnavailable,
        1_000,
        'review_agent_capacity_unavailable'
      )
    );

    const result = await runnerFixture(controlPlane, agent, {
      gateway,
    }).execute(runInput());

    expect(result.status).toBe(ReviewInvestigationRunStatus.Parked);
    expect(controlPlane.abortTurn).toHaveBeenCalledTimes(1);
    expect(gateway.session.dispose).toHaveBeenCalledTimes(1);
  });

  it('maps a typed gateway open confinement failure to a terminal security abort', async () => {
    const planned = plannedSnapshot();
    const inconclusive = terminalSnapshot(3);
    const controlPlane = controlPlaneFixture(planned);
    controlPlane.abortTurn.mockImplementation(async (input) => {
      expect(input.reason).toBe(
        ReviewInvestigationAbortReason.ConfinementViolation
      );
      expect(input.nextEligibleAt).toBeNull();
      controlPlane.current = inconclusive;
      return inconclusive;
    });
    const gateway = gatewayFixture();
    const open = gateway.factory.open as jest.MockedFunction<
      ReviewInvestigationGatewaySessionFactoryPort['open']
    >;
    open.mockRejectedValue(
      new ReviewAgentExecutionError(
        ReviewAgentFailureClass.ConfinementViolation,
        null,
        'context_gateway_open_confinement_violation'
      )
    );
    const agent = agentFixture(observation());
    const diagnostics = {
      record: jest.fn(async () => undefined),
    };

    const result = await runnerFixture(controlPlane, agent, {
      gateway,
      diagnostics,
    }).execute(runInput());

    expect(result).toEqual({
      status: ReviewInvestigationRunStatus.Completed,
      snapshot: inconclusive,
    });
    expect(agent.executeTurn).not.toHaveBeenCalled();
    expect(controlPlane.abortTurn).toHaveBeenCalledTimes(1);
    expect(controlPlane.commitTurn).not.toHaveBeenCalled();
    expect(diagnostics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: ReviewInvestigationOperationalFailurePhase.GatewayOpen,
        failureClass: ReviewAgentFailureClass.ConfinementViolation,
        code: 'review_investigation_gateway_open_confinement_failure',
      })
    );
  });

  it('preserves terminal security semantics when gateway seal reports taint', async () => {
    const planned = plannedSnapshot();
    const inconclusive = terminalSnapshot(3);
    const controlPlane = controlPlaneFixture(planned);
    controlPlane.abortTurn.mockImplementation(async (input) => {
      expect(input.reason).toBe(
        ReviewInvestigationAbortReason.ConfinementViolation
      );
      expect(input.nextEligibleAt).toBeNull();
      controlPlane.current = inconclusive;
      return inconclusive;
    });
    const gateway = gatewayFixture();
    gateway.session.seal.mockRejectedValue(
      new ReviewAgentExecutionError(
        ReviewAgentFailureClass.ConfinementViolation,
        null,
        'context_gateway_v4_session_tainted'
      )
    );
    const agent = agentFixture(observation());

    const result = await runnerFixture(controlPlane, agent, {
      gateway,
    }).execute(runInput());

    expect(result).toEqual({
      status: ReviewInvestigationRunStatus.Completed,
      snapshot: inconclusive,
    });
    expect(agent.executeTurn).toHaveBeenCalledTimes(1);
    expect(gateway.session.dispose).toHaveBeenCalledTimes(1);
    expect(controlPlane.abortTurn).toHaveBeenCalledTimes(1);
    expect(controlPlane.commitTurn).not.toHaveBeenCalled();
  });

  it('allows legacy fallback only when capability is disabled before open', async () => {
    const controlPlane = controlPlaneFixture(plannedSnapshot());
    controlPlane.open.mockRejectedValue(
      new ReviewInvestigationControlPlaneError(
        ReviewInvestigationControlPlaneFailureClass.CapabilityDisabled,
        'capability_disabled'
      )
    );
    const agent = agentFixture(observation());

    await expect(
      runnerFixture(controlPlane, agent).execute(runInput())
    ).rejects.toBeInstanceOf(ReviewInvestigationLegacyFallbackSignal);
    expect(agent.executeTurn).not.toHaveBeenCalled();
    expect(controlPlane.planTurn).not.toHaveBeenCalled();
  });

  it('preserves capability-disabled failures after open for recovery', async () => {
    const opened = Object.freeze({
      ...plannedSnapshot(),
      state: ReviewInvestigationState.AwaitingTurn,
      turn: null,
    });
    const controlPlane = controlPlaneFixture(opened);
    const postOpenError = new ReviewInvestigationControlPlaneError(
      ReviewInvestigationControlPlaneFailureClass.CapabilityDisabled,
      'capability_disabled_after_open'
    );
    controlPlane.planTurn.mockRejectedValue(postOpenError);

    await expect(
      runnerFixture(controlPlane, agentFixture(observation())).execute(
        runInput()
      )
    ).rejects.toBe(postOpenError);
  });

  it('executes an independent critic only with matching prepared authority', async () => {
    const critic = Object.freeze({
      ...plannedSnapshot(),
      nextAction: ReviewInvestigationNextAction.RunCritic,
      turn: Object.freeze({
        ...plannedSnapshot().turn!,
        purpose: ReviewTurnPurpose.Critic,
        obligationIds: Object.freeze([]),
        brief: Object.freeze({
          briefVersion: 1 as const,
          investigationId: 'investigation-1',
          investigationVersion: 2,
          dossierDigest: digest,
          turnId: 'turn-1',
          purpose: ReviewTurnPurpose.Critic,
          maximumSemanticRiskPriority: 900_000,
          obligations: Object.freeze([]),
        }),
      }),
    });
    const terminal = terminalSnapshot(3);
    const controlPlane = controlPlaneFixture(critic);
    controlPlane.commitTurn.mockResolvedValue(terminal);
    const claude = agentFixture({
      ...observation(),
      purpose: ReviewTurnPurpose.Critic,
      actualProviderKind: ReviewAgentProviderKind.ClaudeCode,
      criticDecision: ReviewTurnCriticDecision.Accept,
    });
    const resolve = jest.fn(() => ({
      agent: claude,
      providerKind: ReviewAgentProviderKind.ClaudeCode,
      requestedModel: 'claude-critic',
    }));
    const gateway = gatewayFixture({
      ...gatewayAuthority(),
      preparedManifestKey: 'critic-manifest-key',
      providerInvocationKey: 'claude-critic-invocation',
      providerKind: ReviewAgentProviderKind.ClaudeCode,
      requestedModel: 'claude-critic',
    });

    await runnerFixture(controlPlane, claude, {
      agents: { resolve },
      gateway,
    }).execute(runInput());

    expect(resolve).toHaveBeenCalledWith({
      primaryProviderKind: ReviewAgentProviderKind.Codex,
      primaryRequestedModel: 'gpt-5.6-sol',
      executionAuthority: gateway.factory.executionAuthority,
      purpose: ReviewTurnPurpose.Critic,
      maximumSemanticRiskPriority: 900_000,
    });
    expect(claude.executeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedModel: 'claude-critic',
        executionSession: gateway.session.agentSession,
      })
    );
    expect(gateway.factory.open).toHaveBeenCalledWith(
      expect.not.objectContaining({
        providerKind: expect.anything(),
        requestedModel: expect.anything(),
      })
    );
  });

  it('fails an independent critic closed when only the parent manifest is authorized', async () => {
    const critic = Object.freeze({
      ...plannedSnapshot(),
      nextAction: ReviewInvestigationNextAction.RunCritic,
      turn: Object.freeze({
        ...plannedSnapshot().turn!,
        purpose: ReviewTurnPurpose.Critic,
        obligationIds: Object.freeze([]),
        brief: Object.freeze({
          briefVersion: 1 as const,
          investigationId: 'investigation-1',
          investigationVersion: 2,
          dossierDigest: digest,
          turnId: 'turn-1',
          purpose: ReviewTurnPurpose.Critic,
          maximumSemanticRiskPriority: 900_000,
          obligations: Object.freeze([]),
        }),
      }),
    });
    const inconclusive = terminalSnapshot(3);
    const controlPlane = controlPlaneFixture(critic);
    controlPlane.abortTurn.mockImplementation(async (input) => {
      expect(input.reason).toBe(
        ReviewInvestigationAbortReason.ConfinementViolation
      );
      expect(input.nextEligibleAt).toBeNull();
      controlPlane.current = inconclusive;
      return inconclusive;
    });
    const claude = agentFixture({
      ...observation(),
      purpose: ReviewTurnPurpose.Critic,
      actualProviderKind: ReviewAgentProviderKind.ClaudeCode,
      criticDecision: ReviewTurnCriticDecision.Accept,
    });
    const resolve = jest.fn(() => ({
      agent: claude,
      providerKind: ReviewAgentProviderKind.ClaudeCode,
      requestedModel: 'claude-critic',
    }));
    const gateway = gatewayFixture();

    const result = await runnerFixture(controlPlane, claude, {
      agents: { resolve },
      gateway,
    }).execute(runInput());

    expect(result).toEqual({
      status: ReviewInvestigationRunStatus.Completed,
      snapshot: inconclusive,
    });
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        executionAuthority: gateway.factory.executionAuthority,
        purpose: ReviewTurnPurpose.Critic,
      })
    );
    expect(gateway.factory.open).not.toHaveBeenCalled();
    expect(claude.negotiate).not.toHaveBeenCalled();
    expect(claude.executeTurn).not.toHaveBeenCalled();
    expect(controlPlane.commitTurn).not.toHaveBeenCalled();
  });

  it('concludes inconclusive when a high-risk critic has no execution authority', async () => {
    const critic = Object.freeze({
      ...plannedSnapshot(),
      state: ReviewInvestigationState.TurnLeased,
      nextAction: ReviewInvestigationNextAction.RunCritic,
      turn: Object.freeze({
        ...plannedSnapshot().turn!,
        purpose: ReviewTurnPurpose.Critic,
        obligationIds: Object.freeze([]),
        brief: Object.freeze({
          briefVersion: 1 as const,
          investigationId: 'investigation-1',
          investigationVersion: 2,
          dossierDigest: digest,
          turnId: 'turn-1',
          purpose: ReviewTurnPurpose.Critic,
          maximumSemanticRiskPriority: 900_000,
          obligations: Object.freeze([]),
        }),
      }),
    });
    const inconclusive = terminalSnapshot(3);
    const controlPlane = controlPlaneFixture(critic);
    controlPlane.abortTurn.mockImplementation(async (input) => {
      expect(input.reason).toBe(
        ReviewInvestigationAbortReason.ConfinementViolation
      );
      expect(input.nextEligibleAt).toBeNull();
      controlPlane.current = inconclusive;
      return inconclusive;
    });
    const resolve = jest.fn(() => {
      throw new ReviewAgentExecutionError(
        ReviewAgentFailureClass.ConfinementViolation,
        null,
        'review_agent_critic_execution_authority_unavailable'
      );
    });
    const gateway = gatewayFixture();

    const result = await runnerFixture(
      controlPlane,
      agentFixture(observation()),
      { agents: { resolve }, gateway }
    ).execute(runInput());

    expect(result).toEqual({
      status: ReviewInvestigationRunStatus.Completed,
      snapshot: inconclusive,
    });
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: ReviewTurnPurpose.Critic,
        maximumSemanticRiskPriority: 900_000,
      })
    );
    expect(gateway.factory.open).not.toHaveBeenCalled();
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

function gatewayFixture(
  executionAuthority: ReviewInvestigationTurnExecutionAuthority = gatewayAuthority()
): {
  factory: ReviewInvestigationGatewaySessionFactoryPort;
  session: {
    agentSession: ReviewInvestigationGatewaySessionPort['agentSession'];
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
    agentSession: Object.freeze({
      kind: ReviewAgentExecutionSessionKind.ContextGatewayV4,
    }),
    seal,
    dispose,
  };
  return {
    factory: {
      executionAuthority,
      open: jest.fn(async () => session),
    },
    session,
  };
}

function gatewayAuthority(): ReviewInvestigationTurnExecutionAuthority {
  return Object.freeze({
    preparedManifestKey: 'parent-manifest-key',
    providerInvocationKey: 'codex-primary',
    providerKind: ReviewAgentProviderKind.Codex,
    requestedModel: 'gpt-5.6-sol',
    executionProfile: ReviewAgentExecutionProfile.InvestigationGatewayV1,
    toolPolicyHash: digest,
  });
}

function runnerFixture(
  controlPlane: ControlPlaneFixture,
  agent: AgentFixture,
  overrides: {
    currency?: jest.Mock;
    gateway?: ReturnType<typeof gatewayFixture>;
    diagnostics?: ReviewInvestigationOperationalDiagnosticPort;
    leases?: ReviewInvestigationLeasePort;
    agents?: ReviewAgentSelectionPort;
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
    agents: overrides.agents ?? {
      resolve: jest.fn((input) => ({
        agent,
        providerKind: input.primaryProviderKind,
        requestedModel: input.primaryRequestedModel,
      })),
    },
    ...(overrides.diagnostics === undefined
      ? {}
      : { diagnostics: overrides.diagnostics }),
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
    seedEnvelope: {
      canonicalJson: '{}',
      hash: 'b'.repeat(64),
    },
    initialReceipts: [],
    requestedModel: 'gpt-5.6-sol',
    providerKind: ReviewAgentProviderKind.Codex,
    promptFor: () => 'Review the current work slot.',
    workingDirectory: '/tmp/sandbox-review',
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
      brief: Object.freeze({
        briefVersion: 1 as const,
        investigationId: 'investigation-1',
        investigationVersion: 2,
        dossierDigest: digest,
        turnId: 'turn-1',
        purpose: ReviewTurnPurpose.Discovery,
        maximumSemanticRiskPriority: 500_000,
        obligations: Object.freeze([
          Object.freeze({
            obligationId: 'd'.repeat(64),
            kind: ReviewTurnObligationKind.ChangedContent,
            canonicalSubject: 'src/review.ts@head',
            canonicalRequirement: 'inspect complete changed content',
            riskPriority: 500_000,
            origin: ReviewInvestigationObligationOrigin.CoverageContract,
          }),
        ]),
      }),
    }),
    certificateId: null,
    certificateHash: null,
    terminalProviderKind: null,
    terminalActualModel: null,
    terminalObservationCanonicalJson: null,
    terminalOutcomeHash: null,
    conclusion: null,
  });
}

function terminalSnapshot(version: number): ReviewInvestigationSnapshot {
  const terminalObservationCanonicalJson = '{"payloadVersion":2}';
  return Object.freeze({
    ...plannedSnapshot(),
    version,
    state: ReviewInvestigationState.Inconclusive,
    nextAction: ReviewInvestigationNextAction.Terminal,
    turn: null,
    certificateId: 'certificate-1',
    certificateHash: 'c'.repeat(64),
    terminalProviderKind: ReviewAgentProviderKind.Codex,
    terminalActualModel: 'gpt-test',
    terminalObservationCanonicalJson,
    terminalOutcomeHash: createHash('sha256')
      .update(terminalObservationCanonicalJson)
      .digest('hex'),
    conclusion: ReviewInvestigationConclusion.Inconclusive,
  });
}

function observation(): ReviewTurnObservation {
  return Object.freeze({
    outputVersion: 2,
    findings: Object.freeze([]),
    obligationProposals: Object.freeze([]) as readonly [],
    closureClaims: Object.freeze([]),
    operationBackedDiscoveryClaims: Object.freeze([]),
    unresolvableClaims: Object.freeze([]),
    criticDecision: null,
    observationVersion: 2,
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
import { createHash } from 'crypto';
