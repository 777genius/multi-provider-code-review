import {
  LegacyFallbackBeforeInvestigationAuthorityControlPlane,
  createScmReadTokenProvider,
  mapOrchestrationResultToCodexOutcome,
  mapRevisionGuardErrorToCodexOutcome,
  planAssignments,
  resolveProductionContextGatewayPolicyVersion,
  resolveProductionContextGatewaySessionFactoryOptions,
  resolveT0AttemptBudget,
} from '../../../src/review-orchestration/infrastructure/production-t0-review-runner';
import { CONTEXT_GATEWAY_DEFAULT_POLICY_VERSION } from '../../../src/context-gateway/context-gateway-release-contract';
import {
  ReviewCapabilityKind,
  ReviewExecutionProviderKind,
  ReviewInvocationConfigurationMismatchError,
  ReviewInvocationConfigurationMismatchReason,
  ReviewInvestigationRecordingMode,
  ReviewInvestigationRolloutCapability,
  ReviewOrchestrationResultStatus,
  type ReviewRunAuthorization,
} from '../../../src/review-orchestration/application';
import {
  reviewInvestigationExtensionV1,
  reviewInvestigationRolloutAuthorizationV3Contract,
} from '../../../src/control-plane/generated/review-action-v2/review-action-v2';
import {
  CodexOAuthV2ReviewOutcome,
  CodexOAuthV2TerminalReason,
} from '../../../src/codex-oauth/runtime';
import type { PRContext, ReviewConfig } from '../../../src/types';
import { compareCodeUnits } from '../../../src/review-orchestration/infrastructure/production-review-projection';
import {
  reviewInvestigationCoverageProfileHash,
  reviewInvestigationPolicyHash,
} from '../../../src/review-orchestration/infrastructure/review-investigation-recording-adapter';
import {
  ReviewAgentProviderKind,
  InvestigationContextGatewayRuntimeConfigurationError,
  InvestigationContextGatewayRuntimeConfigurationFailureReason,
  ReviewInvestigationControlPlaneError,
  ReviewInvestigationControlPlaneFailureClass,
  ReviewInvestigationLegacyFallbackSignal,
  ReviewTurnPurpose,
  type ReviewAgentPort,
} from '../../../src/review-investigation';
import {
  createProductionReviewInvestigationAgentSelector,
  createProductionReviewInvestigationGatewayFactory,
  productionReviewInvestigationRecordingMode,
  readProductionReviewInvestigationRolloutFlags,
  resolveProductionReviewInvestigationRollout,
  type ProductionReviewInvestigationRolloutFlags,
} from '../../../src/review-orchestration/infrastructure/production-review-investigation-composition';

describe('ProductionT0ReviewRunner policy', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('treats providerRetries as the total provider attempt budget', () => {
    expect(resolveT0AttemptBudget(3, 10)).toBe(3);
    expect(resolveT0AttemptBudget(0, 10)).toBe(1);
  });

  it('caps the configured total attempts at the protocol maximum', () => {
    expect(resolveT0AttemptBudget(5, 2)).toBe(2);
  });

  it('pins agentic reviews to the release gateway policy independently of investigation rollout', () => {
    expect(
      resolveProductionContextGatewayPolicyVersion({ agenticContext: true })
    ).toBe(CONTEXT_GATEWAY_DEFAULT_POLICY_VERSION);
    expect(
      resolveProductionContextGatewayPolicyVersion({ agenticContext: false })
    ).toBeNull();

    const baseOptions = {
      agenticContext: true,
      checkoutRoot: '/tmp/review',
      gatewayBundlePath: '/tmp/context-gateway.js',
    } as const;
    expect(
      resolveProductionContextGatewaySessionFactoryOptions({
        ...baseOptions,
        investigationRecordingEnabled: false,
      })
    ).toEqual({
      checkoutRoot: baseOptions.checkoutRoot,
      gatewayBundlePath: baseOptions.gatewayBundlePath,
      policyVersion: CONTEXT_GATEWAY_DEFAULT_POLICY_VERSION,
    });
    expect(
      resolveProductionContextGatewaySessionFactoryOptions({
        ...baseOptions,
        investigationRecordingEnabled: true,
      })
    ).toEqual({
      checkoutRoot: baseOptions.checkoutRoot,
      gatewayBundlePath: baseOptions.gatewayBundlePath,
      policyVersion: CONTEXT_GATEWAY_DEFAULT_POLICY_VERSION,
    });
  });

  it('translates orchestration gateway drift at the investigation runtime boundary', async () => {
    const delegate = {
      open: jest
        .fn()
        .mockRejectedValue(
          new ReviewInvocationConfigurationMismatchError(
            ReviewInvocationConfigurationMismatchReason.ContextGatewayPolicyMismatch
          )
        ),
    };
    const factory = createProductionReviewInvestigationGatewayFactory(
      delegate as never
    );

    await expect(factory.open({} as never)).rejects.toMatchObject({
      name: InvestigationContextGatewayRuntimeConfigurationError.name,
      reason:
        InvestigationContextGatewayRuntimeConfigurationFailureReason.ContextGatewayPolicyMismatch,
    });
    expect(delegate.open).toHaveBeenCalledTimes(1);
  });

  it('never re-merges token-safe groups after max work slots', () => {
    const pr = pullRequest(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    const planned = planAssignments({
      authorization: authorization(1),
      pr,
      config: {
        providers: ['codex/gpt-test'],
        batchMaxFiles: 1,
        enableTokenAwareBatching: false,
        providerRetries: 1,
      } as ReviewConfig,
      providerName: 'codex/gpt-test',
      compatibilityKey: '7'.repeat(64),
      lifecycleTargets: [],
      liveLifecycleStateHash: '8'.repeat(64),
    });

    expect(planned.assignments).toHaveLength(1);
    expect(planned.assignments[0].context.files).toHaveLength(1);
    expect(planned.uncoveredPaths).toHaveLength(2);
    expect(
      new Set([
        planned.assignments[0].context.files[0].filename,
        ...planned.uncoveredPaths,
      ])
    ).toEqual(new Set(pr.files.map((file) => file.filename)));
  });

  it('uses locale-independent code-unit ordering for v2 projection inputs', () => {
    expect(['ä', 'z', 'A'].sort(compareCodeUnits)).toEqual(['A', 'z', 'ä']);
  });

  it.each([
    [
      ReviewOrchestrationResultStatus.PublicationNotApplied,
      CodexOAuthV2ReviewOutcome.PublicationNotApplied,
      CodexOAuthV2TerminalReason.PublicationConflict,
      'review_action_v2_publication_not_applied',
    ],
    [
      ReviewOrchestrationResultStatus.PublicationStale,
      CodexOAuthV2ReviewOutcome.PublicationStale,
      CodexOAuthV2TerminalReason.PublicationStale,
      'review_action_v2_publication_stale',
    ],
  ])(
    'never maps %s to a completed review',
    (status, outcome, reason, blockingFailure) => {
      expect(mapOrchestrationResultToCodexOutcome({ status })).toEqual({
        outcome,
        reason,
        blockingFailure,
      });
    }
  );

  it.each([
    [
      'required_provider_lane_busy',
      CodexOAuthV2TerminalReason.RequiredProviderLaneBusy,
    ],
    [
      'required_investigation_deferred',
      CodexOAuthV2TerminalReason.RequiredInvestigationDeferred,
    ],
  ])(
    'keeps incomplete required partial coverage blocking for %s',
    (failureCode, reason) => {
      expect(
        mapOrchestrationResultToCodexOutcome({
          status: ReviewOrchestrationResultStatus.PartialCompleted,
          failureCode,
        })
      ).toEqual({
        outcome: CodexOAuthV2ReviewOutcome.PartialCompleted,
        reason,
        blockingFailure: failureCode,
      });
    }
  );

  it('keeps real orchestration failures blocking', () => {
    expect(
      mapOrchestrationResultToCodexOutcome({
        status: ReviewOrchestrationResultStatus.Failed,
        failureCode: 'provider_failed',
      })
    ).toEqual({
      outcome: CodexOAuthV2ReviewOutcome.Failed,
      reason: CodexOAuthV2TerminalReason.ExecutionFailed,
      blockingFailure: 'provider_failed',
    });
  });

  it('keeps a locally requested investigation on legacy with old authorization facts', () => {
    expect(
      resolveProductionReviewInvestigationRollout({
        flags: rolloutFlags({ recordingEnabled: true }),
        agenticContext: true,
        authorization: authorization(1),
        primaryProviderKind: ReviewExecutionProviderKind.Codex,
      }).recordingEnabled
    ).toBe(false);
  });

  it('keeps all rollout flags disabled by default', () => {
    expect(readProductionReviewInvestigationRolloutFlags({})).toEqual(
      rolloutFlags()
    );
  });

  it.each([
    [undefined, false],
    ['', false],
    ['0', false],
    ['1', true],
  ])('parses the strict recording flag value %p', (value, expected) => {
    expect(
      readProductionReviewInvestigationRolloutFlags({
        REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED: value,
      }).recordingEnabled
    ).toBe(expected);
  });

  it.each(['true', 'false', '2', ' ', '01'])(
    'rejects non-canonical rollout flag value %p',
    (value) => {
      expect(() =>
        readProductionReviewInvestigationRolloutFlags({
          REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED: value,
        })
      ).toThrow('review_investigation_rollout_flag_invalid:recording');
    }
  );

  it('enables record-only execution without shadow or critic', () => {
    const rollout = resolveProductionReviewInvestigationRollout({
      flags: rolloutFlags({ recordingEnabled: true }),
      agenticContext: true,
      authorization: authorizationWithInvestigation(),
      primaryProviderKind: ReviewExecutionProviderKind.Codex,
    });

    expect(rollout).toEqual(
      rolloutFlags({
        recordingEnabled: true,
      })
    );
    expect(productionReviewInvestigationRecordingMode(rollout)).toBe(
      ReviewInvestigationRecordingMode.RecordOnly
    );
  });

  it.each([
    {
      capability: ReviewInvestigationRolloutCapability.Recording,
      grants: [ReviewInvestigationRolloutCapability.Recording],
      expected: rolloutFlags({ recordingEnabled: true }),
    },
    {
      capability: ReviewInvestigationRolloutCapability.Shadow,
      grants: [
        ReviewInvestigationRolloutCapability.Recording,
        ReviewInvestigationRolloutCapability.Shadow,
      ],
      expected: rolloutFlags({
        recordingEnabled: true,
        shadowEnabled: true,
      }),
    },
    {
      capability: ReviewInvestigationRolloutCapability.ContextCritic,
      grants: [
        ReviewInvestigationRolloutCapability.ContextCritic,
        ReviewInvestigationRolloutCapability.Recording,
        ReviewInvestigationRolloutCapability.Shadow,
      ],
      expected: rolloutFlags({
        recordingEnabled: true,
        shadowEnabled: true,
        contextCriticEnabled: true,
      }),
    },
    {
      capability: ReviewInvestigationRolloutCapability.CrossRevisionReplay,
      grants: [
        ReviewInvestigationRolloutCapability.CrossRevisionReplay,
        ReviewInvestigationRolloutCapability.Recording,
        ReviewInvestigationRolloutCapability.Shadow,
      ],
      expected: rolloutFlags({
        recordingEnabled: true,
        shadowEnabled: true,
        crossRevisionReplayEnabled: true,
      }),
    },
    {
      capability: ReviewInvestigationRolloutCapability.ProductionEffects,
      grants: [
        ReviewInvestigationRolloutCapability.ContextCritic,
        ReviewInvestigationRolloutCapability.ProductionEffects,
        ReviewInvestigationRolloutCapability.Recording,
        ReviewInvestigationRolloutCapability.Shadow,
      ],
      expected: rolloutFlags({
        recordingEnabled: true,
        shadowEnabled: true,
        contextCriticEnabled: true,
        productionEffectsEnabled: true,
      }),
    },
    {
      capability: ReviewInvestigationRolloutCapability.VerifiedClean,
      grants: [
        ReviewInvestigationRolloutCapability.ContextCritic,
        ReviewInvestigationRolloutCapability.ProductionEffects,
        ReviewInvestigationRolloutCapability.Recording,
        ReviewInvestigationRolloutCapability.Shadow,
        ReviewInvestigationRolloutCapability.VerifiedClean,
      ],
      expected: rolloutFlags({
        recordingEnabled: true,
        shadowEnabled: true,
        contextCriticEnabled: true,
        productionEffectsEnabled: true,
        verifiedCleanEnabled: true,
      }),
    },
  ])(
    'isolates the $capability server grant from locally enabled capabilities',
    ({ grants, expected }) => {
      const rollout = resolveProductionReviewInvestigationRollout({
        flags: rolloutFlags({
          recordingEnabled: true,
          shadowEnabled: true,
          contextCriticEnabled: true,
          verifiedCleanEnabled: true,
          crossRevisionReplayEnabled: true,
          productionEffectsEnabled: true,
        }),
        agenticContext: true,
        authorization: authorizationWithInvestigationCapabilities([
          {
            providerKind: ReviewExecutionProviderKind.Codex,
            capabilities: grants,
          },
        ]),
        primaryProviderKind: ReviewExecutionProviderKind.Codex,
      });

      expect(rollout).toEqual(expected);
    }
  );

  it('keeps all investigation capabilities disabled for legacy V2 authorization', () => {
    const rollout = resolveProductionReviewInvestigationRollout({
      flags: rolloutFlags({
        recordingEnabled: true,
        shadowEnabled: true,
        contextCriticEnabled: true,
        verifiedCleanEnabled: true,
        crossRevisionReplayEnabled: true,
        productionEffectsEnabled: true,
      }),
      agenticContext: true,
      authorization: authorizationWithLegacyInvestigation(),
      primaryProviderKind: ReviewExecutionProviderKind.Codex,
    });

    expect(rollout).toEqual(rolloutFlags());
  });

  it('applies provider-specific grants independently', () => {
    const authorization = authorizationWithInvestigationCapabilities([
      {
        providerKind: ReviewExecutionProviderKind.Codex,
        capabilities: allInvestigationCapabilities,
      },
      {
        providerKind: ReviewExecutionProviderKind.ClaudeCode,
        capabilities: [ReviewInvestigationRolloutCapability.Recording],
      },
    ]);
    const flags = rolloutFlags({
      recordingEnabled: true,
      shadowEnabled: true,
      contextCriticEnabled: true,
      verifiedCleanEnabled: true,
      crossRevisionReplayEnabled: true,
      productionEffectsEnabled: true,
    });

    expect(
      resolveProductionReviewInvestigationRollout({
        flags,
        agenticContext: true,
        authorization,
        primaryProviderKind: ReviewExecutionProviderKind.Codex,
      })
    ).toEqual(flags);
    expect(
      resolveProductionReviewInvestigationRollout({
        flags,
        agenticContext: true,
        authorization,
        primaryProviderKind: ReviewExecutionProviderKind.ClaudeCode,
      })
    ).toEqual(rolloutFlags({ recordingEnabled: true }));
  });

  it('allows cross-revision replay in shadow without production effects', () => {
    const rollout = resolveProductionReviewInvestigationRollout({
      flags: rolloutFlags({
        recordingEnabled: true,
        shadowEnabled: true,
        crossRevisionReplayEnabled: true,
      }),
      agenticContext: true,
      authorization: authorizationWithInvestigation(),
      primaryProviderKind: ReviewExecutionProviderKind.Codex,
    });

    expect(rollout.crossRevisionReplayEnabled).toBe(true);
    expect(rollout.productionEffectsEnabled).toBe(false);
    expect(productionReviewInvestigationRecordingMode(rollout)).toBe(
      ReviewInvestigationRecordingMode.RecordOnly
    );
  });

  it('keeps authoritative effects separate from shadow execution', () => {
    const base = {
      agenticContext: true,
      authorization: authorizationWithInvestigation(),
      primaryProviderKind: ReviewExecutionProviderKind.Codex,
    } as const;
    const shadow = resolveProductionReviewInvestigationRollout({
      ...base,
      flags: rolloutFlags({
        recordingEnabled: true,
        shadowEnabled: true,
        contextCriticEnabled: true,
      }),
    });
    const authoritative = resolveProductionReviewInvestigationRollout({
      ...base,
      flags: rolloutFlags({
        recordingEnabled: true,
        shadowEnabled: true,
        contextCriticEnabled: true,
        productionEffectsEnabled: true,
      }),
    });

    expect(productionReviewInvestigationRecordingMode(shadow)).toBe(
      ReviewInvestigationRecordingMode.RecordOnly
    );
    expect(productionReviewInvestigationRecordingMode(authoritative)).toBe(
      ReviewInvestigationRecordingMode.Authoritative
    );
  });

  it('rejects shadow without independently enabled recording', () => {
    expect(() =>
      resolveProductionReviewInvestigationRollout({
        flags: rolloutFlags({ shadowEnabled: true }),
        agenticContext: true,
        authorization: authorizationWithInvestigation(),
        primaryProviderKind: ReviewExecutionProviderKind.Codex,
      })
    ).toThrow('rollout_dependency_missing:shadow:recording');
  });

  it('enables investigation only for the exact V3 contract and allowed provider', () => {
    const negotiated = authorizationWithInvestigation();
    const descriptor = negotiated.facts.reviewInvestigation as unknown as
      Readonly<Record<string, unknown>> | undefined;
    if (descriptor === undefined) {
      throw new Error('expected V3 investigation descriptor');
    }
    const withDescriptor = (
      overrides: Readonly<Record<string, unknown>>
    ): ReviewRunAuthorization =>
      ({
        ...negotiated,
        facts: {
          ...negotiated.facts,
          reviewInvestigation: { ...descriptor, ...overrides },
        },
      }) as unknown as ReviewRunAuthorization;
    const enabled = (
      authorizationOverride: ReviewRunAuthorization = negotiated
    ) =>
      resolveProductionReviewInvestigationRollout({
        flags: rolloutFlags({ recordingEnabled: true }),
        agenticContext: true,
        authorization: authorizationOverride,
        primaryProviderKind: ReviewExecutionProviderKind.Codex,
      }).recordingEnabled;

    expect(enabled()).toBe(true);
    expect(
      enabled(withDescriptor({ coverageProfileHash: 'e'.repeat(64) }))
    ).toBe(false);
    expect(enabled(withDescriptor({ policyHash: 'f'.repeat(64) }))).toBe(false);
    for (const [field, value] of [
      ['extensionId', 'review-investigation-shadow.future'],
      ['extensionSchemaDigest', 'a'.repeat(64)],
      ['extensionCanonicalizerDigest', 'b'.repeat(64)],
    ] as const) {
      expect(enabled(withDescriptor({ [field]: value }))).toBe(false);
    }
    expect(
      enabled(
        withDescriptor({
          providerCapabilities: [
            {
              providerKind: ReviewExecutionProviderKind.ClaudeCode,
              capabilities: allInvestigationCapabilities,
            },
          ],
        })
      )
    ).toBe(false);
  });

  it('selects a configured and authorized Claude critic', () => {
    const codex = agent();
    const claude = agent();
    const selector = createProductionReviewInvestigationAgentSelector({
      authorization: authorizationWithInvestigation([
        ReviewExecutionProviderKind.Codex,
        ReviewExecutionProviderKind.ClaudeCode,
      ]),
      primaryProviderKind: ReviewAgentProviderKind.Codex,
      contextCriticEnabled: true,
      agents: [
        {
          providerKind: ReviewAgentProviderKind.Codex,
          requestedModel: 'gpt-5.6-terra',
          agent: codex,
        },
        {
          providerKind: ReviewAgentProviderKind.ClaudeCode,
          requestedModel: 'claude-sonnet-4-5',
          agent: claude,
        },
      ],
    });

    expect(
      selector.resolve({
        primaryProviderKind: ReviewAgentProviderKind.Codex,
        primaryRequestedModel: 'gpt-5.6-terra',
        executionAuthority: {
          providerKind: ReviewAgentProviderKind.ClaudeCode,
          requestedModel: 'claude-sonnet-4-5',
        },
        purpose: ReviewTurnPurpose.Critic,
        maximumSemanticRiskPriority: 900_000,
      })
    ).toEqual({
      agent: claude,
      providerKind: ReviewAgentProviderKind.ClaudeCode,
      requestedModel: 'claude-sonnet-4-5',
    });
  });

  it('does not let recording authority imply critic authority for another provider', () => {
    const selector = createProductionReviewInvestigationAgentSelector({
      authorization: authorizationWithInvestigationCapabilities([
        {
          providerKind: ReviewExecutionProviderKind.Codex,
          capabilities: [
            ReviewInvestigationRolloutCapability.ContextCritic,
            ReviewInvestigationRolloutCapability.Recording,
            ReviewInvestigationRolloutCapability.Shadow,
          ],
        },
        {
          providerKind: ReviewExecutionProviderKind.ClaudeCode,
          capabilities: [ReviewInvestigationRolloutCapability.Recording],
        },
      ]),
      primaryProviderKind: ReviewAgentProviderKind.Codex,
      contextCriticEnabled: true,
      agents: [
        {
          providerKind: ReviewAgentProviderKind.Codex,
          requestedModel: 'gpt-5.6-terra',
          agent: agent(),
        },
        {
          providerKind: ReviewAgentProviderKind.ClaudeCode,
          requestedModel: 'claude-sonnet-4-5',
          agent: agent(),
        },
      ],
    });

    expect(() =>
      selector.resolve({
        primaryProviderKind: ReviewAgentProviderKind.Codex,
        primaryRequestedModel: 'gpt-5.6-terra',
        executionAuthority: {
          providerKind: ReviewAgentProviderKind.ClaudeCode,
          requestedModel: 'claude-sonnet-4-5',
        },
        purpose: ReviewTurnPurpose.Critic,
        maximumSemanticRiskPriority: 900_000,
      })
    ).toThrow('review_agent_independent_critic_unavailable');
  });

  it('does not silently use the primary provider for a high-risk clean critic', () => {
    const selector = createProductionReviewInvestigationAgentSelector({
      authorization: authorizationWithInvestigation(),
      primaryProviderKind: ReviewAgentProviderKind.Codex,
      contextCriticEnabled: true,
      agents: [
        {
          providerKind: ReviewAgentProviderKind.Codex,
          requestedModel: 'gpt-5.6-terra',
          agent: agent(),
        },
      ],
    });

    expect(() =>
      selector.resolve({
        primaryProviderKind: ReviewAgentProviderKind.Codex,
        primaryRequestedModel: 'gpt-5.6-terra',
        purpose: ReviewTurnPurpose.Critic,
        maximumSemanticRiskPriority: 900_000,
      })
    ).toThrow('review_agent_critic_execution_authority_unavailable');
  });

  it('fails closed when authorized independent critic capacity is unavailable', () => {
    const selector = createProductionReviewInvestigationAgentSelector({
      authorization: authorizationWithInvestigation([
        ReviewExecutionProviderKind.Codex,
        ReviewExecutionProviderKind.ClaudeCode,
      ]),
      primaryProviderKind: ReviewAgentProviderKind.Codex,
      contextCriticEnabled: true,
      agents: [
        {
          providerKind: ReviewAgentProviderKind.Codex,
          requestedModel: 'gpt-5.6-terra',
          agent: agent(),
        },
      ],
    });

    expect(() =>
      selector.resolve({
        primaryProviderKind: ReviewAgentProviderKind.Codex,
        primaryRequestedModel: 'gpt-5.6-terra',
        executionAuthority: {
          providerKind: ReviewAgentProviderKind.ClaudeCode,
          requestedModel: 'claude-sonnet-4-5',
        },
        purpose: ReviewTurnPurpose.Critic,
        maximumSemanticRiskPriority: 900_000,
      })
    ).toThrow('review_agent_independent_critic_unavailable');
  });

  it('rejects critic turns when the critic rollout is disabled', () => {
    const selector = createProductionReviewInvestigationAgentSelector({
      authorization: authorizationWithInvestigation(),
      primaryProviderKind: ReviewAgentProviderKind.Codex,
      contextCriticEnabled: false,
      agents: [
        {
          providerKind: ReviewAgentProviderKind.Codex,
          requestedModel: 'gpt-5.6-terra',
          agent: agent(),
        },
      ],
    });

    expect(() =>
      selector.resolve({
        primaryProviderKind: ReviewAgentProviderKind.Codex,
        primaryRequestedModel: 'gpt-5.6-terra',
        purpose: ReviewTurnPurpose.Critic,
        maximumSemanticRiskPriority: 500_000,
      })
    ).toThrow('review_agent_context_critic_disabled');
  });

  it('falls back only when capability is disabled before investigation admission', async () => {
    const preOpenError = new ReviewInvestigationControlPlaneError(
      ReviewInvestigationControlPlaneFailureClass.CapabilityDisabled,
      'investigation_rollout_disabled_before_open'
    );
    const postOpenError = new ReviewInvestigationControlPlaneError(
      ReviewInvestigationControlPlaneFailureClass.CapabilityDisabled,
      'investigation_rollout_disabled_after_open'
    );
    const delegate = {
      open: jest
        .fn()
        .mockRejectedValueOnce(preOpenError)
        .mockResolvedValueOnce({
          investigationId: 'investigation-1',
        }),
      planTurn: jest.fn().mockRejectedValue(postOpenError),
    } as never;
    const controlPlane =
      new LegacyFallbackBeforeInvestigationAuthorityControlPlane(delegate);

    await expect(controlPlane.open({} as never)).rejects.toBeInstanceOf(
      ReviewInvestigationLegacyFallbackSignal
    );
    await expect(controlPlane.open({} as never)).resolves.toMatchObject({
      investigationId: 'investigation-1',
    });
    await expect(controlPlane.planTurn({} as never)).rejects.toBe(
      postOpenError
    );
  });

  it('maps initial revision guard failures into terminal v2 outcomes', () => {
    for (const blockingFailure of [
      'review_action_v2_revision_guard_unavailable',
      'review_action_v2_revision_guard_failed',
    ]) {
      expect(
        mapRevisionGuardErrorToCodexOutcome(new Error(blockingFailure))
      ).toEqual({
        outcome: CodexOAuthV2ReviewOutcome.Failed,
        reason:
          blockingFailure === 'review_action_v2_revision_guard_unavailable'
            ? CodexOAuthV2TerminalReason.RevisionGuardUnavailable
            : CodexOAuthV2TerminalReason.RevisionGuardFailed,
        blockingFailure,
      });
    }
    expect(
      mapRevisionGuardErrorToCodexOutcome(new Error('unexpected_failure'))
    ).toBeUndefined();
  });

  it('refreshes an expiring SCM read capability before the next read', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const refresh = jest.fn(async () => ({
      token: 'ghs_refreshed',
      expiresAt: '2026-08-03T13:00:00.000Z',
    }));
    const provider = createScmReadTokenProvider({
      token: 'ghs_expiring',
      expiresAt: '2026-08-03T12:00:20.000Z',
      refresh,
    });

    await expect(provider.getToken()).resolves.toBe('ghs_refreshed');
    await expect(provider.getToken()).resolves.toBe('ghs_refreshed');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent SCM token refreshes', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const refresh = jest.fn(async () => ({
      token: 'ghs_refreshed',
      expiresAt: '2026-08-03T13:00:00.000Z',
    }));
    const provider = createScmReadTokenProvider({
      token: 'ghs_expiring',
      expiresAt: '2026-08-03T12:00:20.000Z',
      refresh,
    });

    await expect(
      Promise.all([provider.getToken(), provider.getToken()])
    ).resolves.toEqual(['ghs_refreshed', 'ghs_refreshed']);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('rejects stale refreshed SCM capabilities as temporarily unavailable', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const refresh = jest.fn(async () => ({
      token: 'ghs_still_expiring',
      expiresAt: '2026-08-03T12:00:25.000Z',
    }));
    const provider = createScmReadTokenProvider({
      token: 'ghs_initial',
      expiresAt: '2026-08-03T13:00:00.000Z',
      refresh,
    });

    await expect(provider.refreshToken()).rejects.toThrow(
      'review_action_v2_revision_guard_unavailable'
    );
    await expect(provider.getToken()).resolves.toBe('ghs_initial');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('normalizes SCM token refresh errors for terminal reporting', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const provider = createScmReadTokenProvider({
      token: 'ghs_expiring',
      expiresAt: '2026-08-03T12:00:20.000Z',
      refresh: jest.fn(async () => {
        throw new Error('control_plane_unavailable');
      }),
    });

    await expect(provider.getToken()).rejects.toThrow(
      'review_action_v2_revision_guard_unavailable'
    );
  });

  it('distinguishes permanent and transient SCM token endpoint failures', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const providerFor = (message: string) =>
      createScmReadTokenProvider({
        token: 'ghs_expiring',
        expiresAt: '2026-08-03T12:00:20.000Z',
        refresh: jest.fn(async () => {
          throw new Error(message);
        }),
      });

    await expect(
      providerFor(
        'codex_oauth_control_plane_error:403:permission_required'
      ).getToken()
    ).rejects.toThrow('review_action_v2_revision_guard_failed');
    for (const status of [429, 503]) {
      await expect(
        providerFor(
          `codex_oauth_control_plane_error:${status}:temporarily_unavailable`
        ).getToken()
      ).rejects.toThrow('review_action_v2_revision_guard_unavailable');
    }
  });
});

function authorizationWithInvestigation(
  providerKinds: readonly (
    ReviewExecutionProviderKind.Codex | ReviewExecutionProviderKind.ClaudeCode
  )[] = [ReviewExecutionProviderKind.Codex]
): ReviewRunAuthorization {
  return authorizationWithInvestigationCapabilities(
    providerKinds.map((providerKind) => ({
      providerKind,
      capabilities: allInvestigationCapabilities,
    }))
  );
}

function authorizationWithInvestigationCapabilities(
  providerCapabilities: readonly {
    readonly providerKind:
      | ReviewExecutionProviderKind.Codex
      | ReviewExecutionProviderKind.ClaudeCode;
    readonly capabilities: readonly ReviewInvestigationRolloutCapability[];
  }[]
): ReviewRunAuthorization {
  const base = authorization(1);
  const canonicalProviderCapabilities = [...providerCapabilities]
    .sort((left, right) =>
      left.providerKind < right.providerKind
        ? -1
        : left.providerKind > right.providerKind
          ? 1
          : 0
    )
    .map((row) => ({
      providerKind: row.providerKind,
      capabilities: [...row.capabilities].sort(),
    }));
  return {
    ...base,
    facts: {
      ...base.facts,
      providerVoteLanes: canonicalProviderCapabilities.map(
        ({ providerKind }, index) => ({
          providerKind,
          providerVoteIdentityHash: `${index + 6}`.repeat(64),
        })
      ),
      reviewInvestigation: {
        extensionId: reviewInvestigationExtensionV1.extensionId,
        extensionSchemaDigest: reviewInvestigationExtensionV1.schemaDigest,
        extensionCanonicalizerDigest:
          reviewInvestigationExtensionV1.canonicalizerDigest,
        authorizationDescriptorVersion:
          reviewInvestigationRolloutAuthorizationV3Contract.authorizationDescriptorVersion,
        capability: ReviewCapabilityKind.ReviewInvestigationV1,
        coverageProfileHash: reviewInvestigationCoverageProfileHash(),
        policyHash: reviewInvestigationPolicyHash(),
        providerCapabilities: canonicalProviderCapabilities,
      },
    },
  } as unknown as ReviewRunAuthorization;
}

function authorizationWithLegacyInvestigation(
  providerKinds: readonly (
    ReviewExecutionProviderKind.Codex | ReviewExecutionProviderKind.ClaudeCode
  )[] = [ReviewExecutionProviderKind.Codex]
): ReviewRunAuthorization {
  const base = authorization(1);
  return {
    ...base,
    facts: {
      ...base.facts,
      providerVoteLanes: providerKinds.map((providerKind, index) => ({
        providerKind,
        providerVoteIdentityHash: `${index + 6}`.repeat(64),
      })),
      reviewInvestigation: {
        authorizationDescriptorVersion: 2,
        capability: ReviewCapabilityKind.ReviewInvestigationV1,
        coverageProfileHash: reviewInvestigationCoverageProfileHash(),
        policyHash: reviewInvestigationPolicyHash(),
        providerCapabilities: providerKinds.map((providerKind) => ({
          providerKind,
          capabilities: allInvestigationCapabilities,
        })),
      },
    },
  } as unknown as ReviewRunAuthorization;
}

const allInvestigationCapabilities = Object.freeze([
  ReviewInvestigationRolloutCapability.ContextCritic,
  ReviewInvestigationRolloutCapability.CrossRevisionReplay,
  ReviewInvestigationRolloutCapability.ProductionEffects,
  ReviewInvestigationRolloutCapability.Recording,
  ReviewInvestigationRolloutCapability.Shadow,
  ReviewInvestigationRolloutCapability.VerifiedClean,
]);

function rolloutFlags(
  overrides: Partial<ProductionReviewInvestigationRolloutFlags> = {}
): ProductionReviewInvestigationRolloutFlags {
  return {
    recordingEnabled: false,
    shadowEnabled: false,
    contextCriticEnabled: false,
    verifiedCleanEnabled: false,
    crossRevisionReplayEnabled: false,
    productionEffectsEnabled: false,
    ...overrides,
  };
}

function agent(): ReviewAgentPort {
  return {
    negotiate: jest.fn(),
    executeTurn: jest.fn(),
    cancel: jest.fn(),
  };
}

function authorization(maxWorkSlots: number) {
  return {
    authorizationId: 'authorization-1',
    authorizationToken: 'token',
    producerReleaseId: 'release-1',
    protocolLimitsProfileId: 'limits-1',
    operationalSloProfileId: 'slo-1',
    mutationEpoch: '1',
    expiresAt: '2026-07-24T00:00:00.000Z',
    limits: {
      maxWorkSlots,
      maxAttemptsPerSlot: 3,
      maxObservationBytes: 100_000,
      maxObservationFindings: 100,
      maxProjectionBytes: 100_000,
      maxProjectionFindings: 100,
      maxPublicationOperations: 100,
      maxPublicationChunks: 10,
      maxPublicationBodyBytes: 100_000,
      maxRequestBatchSize: 10,
      maxLeaseDurationMs: 60_000,
      maxResultReportDurationMs: 60_000,
      maxReconciliationDurationMs: 60_000,
    },
    facts: {
      workspaceId: 'workspace-1',
      repositoryConnectionId: 'connection-1',
      scmRepositoryIdentityId: 'repo-1',
      pullRequestNumber: 1,
      sourceRunId: 'run-1',
      sourceRunAttempt: '1',
      baseSha: '1'.repeat(40),
      mergeBaseSha: '2'.repeat(40),
      headSha: '3'.repeat(40),
      reviewRevisionHash: '4'.repeat(64),
      trustDomain: 'github-actions',
      producerReleaseId: 'release-1',
      selectedProtocolVersion: '2',
      schemaDigest: '5'.repeat(64),
      providerVoteLanes: [
        {
          providerKind: ReviewExecutionProviderKind.Codex,
          providerVoteIdentityHash: '6'.repeat(64),
        },
      ],
    },
  };
}

function pullRequest(paths: string[]): PRContext {
  const files = paths.map((filename) => ({
    filename,
    status: 'modified' as const,
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: '@@ -1 +1 @@\n+changed',
  }));
  return {
    number: 1,
    title: 'Bounded batches',
    body: '',
    author: 'reviewer',
    draft: false,
    labels: [],
    files,
    diff: files
      .map(
        (file) =>
          `diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n@@ -1 +1 @@\n+changed`
      )
      .join('\n'),
    additions: files.length,
    deletions: 0,
    baseSha: '1'.repeat(40),
    headSha: '3'.repeat(40),
  };
}
