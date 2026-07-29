import { createHash } from 'crypto';
import {
  canonicalizeProviderInvocationManifestV1,
  providerInvocationIdentityPreimageV1,
} from '../../../src/control-plane/generated/review-action-v2/provider-invocation-manifest-v1';
import {
  createPreparedProviderInvocation,
  ProviderKind,
} from '../../../src/providers/prepared-invocation';
import type { CodexProvider } from '../../../src/providers/codex';
import type { PromptBuilder } from '../../../src/analysis/llm/prompt-builder';
import type { ReviewConfig } from '../../../src/types';
import type { ContextGatewayInvocationSessionFactoryPort } from '../../../src/review-orchestration/infrastructure/context-gateway-invocation-session';
import { logger } from '../../../src/utils/logger';
import {
  ReviewContextInspectionFailure,
  ReviewContextInspectionFailureReason,
  ReviewExecutionProviderKind,
  ReviewTaskKind,
  RetryableReviewContextInspectionFailure,
  type ReviewRunAuthorization,
} from '../../../src/review-orchestration/application';
import {
  CodexReviewInvocationAdapter,
  CooperativeReviewLeaseSupervisor,
  GeneratedProviderInvocationManifestAssembler,
} from '../../../src/review-orchestration/infrastructure';
import { createReviewPromptCoverageManifest } from '../../../src/review-orchestration/domain';

describe('Codex T0 prepared invocation', () => {
  it('executes the exact branded object that was prepared', async () => {
    const prepared = createPreparedProviderInvocation({
      providerKind: ProviderKind.CodexCli,
      providerName: 'codex/gpt-test',
      requestedModel: 'gpt-test',
      timeoutMs: 10_000,
      request: {
        prompt: 'prepared prompt',
        outputSchema: { type: 'object' },
        environment: { PATH: '/usr/bin' },
      },
    });
    const provider = {
      name: 'codex/gpt-test',
      describePreparedEnvironmentContract: jest
        .fn()
        .mockReturnValue({ PATH: '/usr/bin' }),
      prepareInvocation: jest.fn().mockResolvedValue(prepared),
      executePreparedInvocation: jest.fn(async (actual) => {
        expect(actual).toBe(prepared);
        return { content: '{}', findings: [], revalidations: [] };
      }),
    } as unknown as CodexProvider;
    const promptBuilder = {
      buildPreparedV2: jest.fn().mockResolvedValue({
        version: 'prepared_review_prompt.v2',
        prompt: 'prepared prompt',
        pathCoverage: [],
      }),
    } as unknown as PromptBuilder;
    const adapter = new CodexReviewInvocationAdapter(
      provider,
      promptBuilder,
      [assignment],
      10_000,
      true
    );

    const invocation = await adapter.prepare({
      workSlot: assignment.workSlot,
      attemptOrdinal: 1,
    });
    const observation = await adapter.execute({
      invocation,
      manifest: manifestFixture,
      lease: leaseFixture,
      sourceExecutionId: 'execution-1',
      sourceReviewRevisionHash: hash('revision'),
      signal: new AbortController().signal,
    });

    expect(invocation.immutableRequest).toBe(prepared);
    expect(provider.executePreparedInvocation).toHaveBeenCalledWith(
      prepared,
      undefined,
      expect.any(AbortSignal)
    );
    expect(observation.schemaValidated).toBe(true);
  });

  it('materializes a lease-bound gateway session without changing semantic identity', async () => {
    const planningPrepared = createPreparedProviderInvocation({
      providerKind: ProviderKind.CodexCli,
      providerName: 'codex/gpt-test',
      requestedModel: 'gpt-test',
      timeoutMs: 10_000,
      request: {
        prompt: 'planning prompt',
        outputSchema: { type: 'object' },
        environment: { PATH: '/usr/bin' },
      },
      observableRequest: { semantic: 'same' },
    });
    const runtimePrepared = createPreparedProviderInvocation({
      providerKind: ProviderKind.CodexCli,
      providerName: 'codex/gpt-test',
      requestedModel: 'gpt-test',
      timeoutMs: 10_000,
      request: {
        prompt: 'runtime prompt',
        outputSchema: { type: 'object' },
        environment: { PATH: '/usr/bin' },
      },
      observableRequest: { semantic: 'same' },
    });
    const provider = {
      name: 'codex/gpt-test',
      describePreparedEnvironmentContract: jest
        .fn()
        .mockReturnValue({ PATH: '/usr/bin' }),
      prepareInvocation: jest
        .fn()
        .mockResolvedValueOnce(planningPrepared)
        .mockResolvedValueOnce(runtimePrepared),
      executePreparedInvocation: jest.fn().mockResolvedValue({
        content: '{}',
        findings: [],
        revalidations: [],
        actualModel: 'gpt-test-actual',
      }),
    } as unknown as CodexProvider;
    const promptBuilder = {
      buildPreparedV2: jest.fn().mockResolvedValue({
        version: 'prepared_review_prompt.v2',
        prompt: 'prepared prompt',
        pathCoverage: [],
      }),
    } as unknown as PromptBuilder;
    const session = {
      providerConfig: gatewayConfig,
      credentialLease: {
        environment: {
          REVIEWROUTER_CONTEXT_GATEWAY_SECRET: 'secret',
        },
      },
      seal: jest.fn().mockResolvedValue({
        attestationId: 'attestation-1',
        attestationHash: hash('attestation'),
      }),
      dispose: jest.fn().mockResolvedValue(undefined),
    };
    const gatewayFactory = {
      planningConfig: jest.fn().mockResolvedValue(gatewayConfig),
      open: jest.fn().mockResolvedValue(session),
    } as unknown as ContextGatewayInvocationSessionFactoryPort;
    const infoSpy = jest
      .spyOn(logger, 'info')
      .mockImplementation(() => undefined);
    const adapter = new CodexReviewInvocationAdapter(
      provider,
      promptBuilder,
      [assignment],
      10_000,
      true,
      gatewayFactory
    );

    try {
      const invocation = await adapter.prepare({
        workSlot: assignment.workSlot,
        attemptOrdinal: 1,
      });
      const observation = await adapter.execute({
        invocation,
        manifest: manifestFixture,
        lease: leaseFixture,
        sourceExecutionId: 'execution-1',
        sourceReviewRevisionHash: hash('revision'),
        signal: new AbortController().signal,
      });

      expect(gatewayFactory.open).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceExecutionId: 'execution-1',
          sourceWorkSlotId: 'slot-1',
        })
      );
      expect(provider.executePreparedInvocation).toHaveBeenCalledWith(
        runtimePrepared,
        session.credentialLease,
        expect.any(AbortSignal)
      );
      expect(session.seal).toHaveBeenCalledWith({
        actualModel: 'gpt-test-actual',
        terminalOutcomeHash: observation.payloadHash,
      });
      expect(observation).toMatchObject({
        contextDependencyAttestationId: 'attestation-1',
        contextDependencyAttestationHash: hash('attestation'),
        qualityFlags: [],
      });
      expect(infoSpy).toHaveBeenCalledWith(
        'Codex execution model: requested=gpt-test, actual=gpt-test-actual'
      );
      expect(session.dispose).toHaveBeenCalledTimes(1);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it.each([
    {
      name: 'the provider does not report the actual model',
      actualModel: undefined,
      expectedQualityFlags: [
        'provider_warning',
        'context_attestation_unavailable',
        'cross_revision_reuse_disabled',
      ],
      expectedSealCalls: 0,
      expectedSealedModel: undefined,
    },
    {
      name: 'the gateway has no reusable dependencies',
      actualModel: 'gpt-test-actual',
      expectedQualityFlags: [
        'context_attestation_unavailable',
        'cross_revision_reuse_disabled',
      ],
      expectedSealCalls: 1,
      expectedSealedModel: 'gpt-test-actual',
    },
  ])(
    'uses protocol-safe quality flags when $name',
    async ({
      actualModel,
      expectedQualityFlags,
      expectedSealCalls,
      expectedSealedModel,
    }) => {
      const planningPrepared = preparedInvocation('planning prompt');
      const runtimePrepared = preparedInvocation('runtime prompt');
      const provider = {
        name: 'codex/gpt-test',
        describePreparedEnvironmentContract: jest
          .fn()
          .mockReturnValue({ PATH: '/usr/bin' }),
        prepareInvocation: jest
          .fn()
          .mockResolvedValueOnce(planningPrepared)
          .mockResolvedValueOnce(runtimePrepared),
        executePreparedInvocation: jest.fn().mockResolvedValue({
          content: '{}',
          findings: [],
          revalidations: [],
          ...(actualModel ? { actualModel } : {}),
        }),
      } as unknown as CodexProvider;
      const session = {
        providerConfig: gatewayConfig,
        credentialLease: {
          environment: {
            REVIEWROUTER_CONTEXT_GATEWAY_SECRET: 'secret',
          },
        },
        seal: jest.fn().mockResolvedValue(null),
        dispose: jest.fn().mockResolvedValue(undefined),
      };
      const gatewayFactory = {
        planningConfig: jest.fn().mockResolvedValue(gatewayConfig),
        open: jest.fn().mockResolvedValue(session),
      } as unknown as ContextGatewayInvocationSessionFactoryPort;
      const adapter = new CodexReviewInvocationAdapter(
        provider,
        {
          buildPreparedV2: jest.fn().mockResolvedValue({
            version: 'prepared_review_prompt.v2',
            prompt: 'prepared prompt',
            pathCoverage: [],
          }),
        } as unknown as PromptBuilder,
        [assignment],
        10_000,
        true,
        gatewayFactory
      );

      const invocation = await adapter.prepare({
        workSlot: assignment.workSlot,
        attemptOrdinal: 1,
      });
      const observation = await adapter.execute({
        invocation,
        manifest: manifestFixture,
        lease: leaseFixture,
        sourceExecutionId: 'execution-1',
        sourceReviewRevisionHash: hash('revision'),
        signal: new AbortController().signal,
      });

      expect(observation.qualityFlags).toEqual(expectedQualityFlags);
      expect(observation.contextDependencyAttestationId).toBeUndefined();
      expect(observation.contextDependencyAttestationHash).toBeUndefined();
      expect(session.seal).toHaveBeenCalledTimes(expectedSealCalls);
      if (expectedSealedModel) {
        expect(session.seal).toHaveBeenCalledWith({
          actualModel: expectedSealedModel,
          terminalOutcomeHash: observation.payloadHash,
        });
      }
      expect(session.dispose).toHaveBeenCalledTimes(1);
    }
  );

  it('logs protocol-safe local seal parse failures before falling back to non-reusable evidence', async () => {
    const planningPrepared = preparedInvocation('planning prompt');
    const runtimePrepared = preparedInvocation('runtime prompt');
    const provider = {
      name: 'codex/gpt-test',
      describePreparedEnvironmentContract: jest
        .fn()
        .mockReturnValue({ PATH: '/usr/bin' }),
      prepareInvocation: jest
        .fn()
        .mockResolvedValueOnce(planningPrepared)
        .mockResolvedValueOnce(runtimePrepared),
      executePreparedInvocation: jest.fn().mockResolvedValue({
        content: '{}',
        findings: [],
        revalidations: [],
        actualModel: 'gpt-test-actual',
      }),
    } as unknown as CodexProvider;
    const session = {
      providerConfig: gatewayConfig,
      credentialLease: {
        environment: {
          REVIEWROUTER_CONTEXT_GATEWAY_SECRET: 'secret',
        },
      },
      seal: jest
        .fn()
        .mockRejectedValue(
          new Error(
            'review_action_v2_context_dependency_attestation_id_missing'
          )
        ),
      dispose: jest.fn().mockResolvedValue(undefined),
    };
    const gatewayFactory = {
      planningConfig: jest.fn().mockResolvedValue(gatewayConfig),
      open: jest.fn().mockResolvedValue(session),
    } as unknown as ContextGatewayInvocationSessionFactoryPort;
    const warnSpy = jest
      .spyOn(logger, 'warn')
      .mockImplementation(() => undefined);
    const adapter = new CodexReviewInvocationAdapter(
      provider,
      {
        buildPreparedV2: jest.fn().mockResolvedValue({
          version: 'prepared_review_prompt.v2',
          prompt: 'prepared prompt',
          pathCoverage: [],
        }),
      } as unknown as PromptBuilder,
      [assignment],
      10_000,
      true,
      gatewayFactory
    );

    try {
      const invocation = await adapter.prepare({
        workSlot: assignment.workSlot,
        attemptOrdinal: 1,
      });
      const observation = await adapter.execute({
        invocation,
        manifest: manifestFixture,
        lease: leaseFixture,
        sourceExecutionId: 'execution-1',
        sourceReviewRevisionHash: hash('revision'),
        signal: new AbortController().signal,
      });

      expect(observation.qualityFlags).toEqual([
        'context_attestation_unavailable',
        'cross_revision_reuse_disabled',
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'review_action_v2_context_dependency_attestation_id_missing'
        )
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('logs protocol-safe context gateway seal failures before falling back to non-reusable evidence', async () => {
    const planningPrepared = preparedInvocation('planning prompt');
    const runtimePrepared = preparedInvocation('runtime prompt');
    const provider = {
      name: 'codex/gpt-test',
      describePreparedEnvironmentContract: jest
        .fn()
        .mockReturnValue({ PATH: '/usr/bin' }),
      prepareInvocation: jest
        .fn()
        .mockResolvedValueOnce(planningPrepared)
        .mockResolvedValueOnce(runtimePrepared),
      executePreparedInvocation: jest.fn().mockResolvedValue({
        content: '{}',
        findings: [],
        revalidations: [],
        actualModel: 'gpt-test-actual',
      }),
    } as unknown as CodexProvider;
    const session = {
      providerConfig: gatewayConfig,
      credentialLease: {
        environment: {
          REVIEWROUTER_CONTEXT_GATEWAY_SECRET: 'secret',
        },
      },
      seal: jest
        .fn()
        .mockRejectedValue(
          new Error('context_gateway_transcript_terminal_hash_invalid')
        ),
      dispose: jest.fn().mockResolvedValue(undefined),
    };
    const gatewayFactory = {
      planningConfig: jest.fn().mockResolvedValue(gatewayConfig),
      open: jest.fn().mockResolvedValue(session),
    } as unknown as ContextGatewayInvocationSessionFactoryPort;
    const warnSpy = jest
      .spyOn(logger, 'warn')
      .mockImplementation(() => undefined);
    const adapter = new CodexReviewInvocationAdapter(
      provider,
      {
        buildPreparedV2: jest.fn().mockResolvedValue({
          version: 'prepared_review_prompt.v2',
          prompt: 'prepared prompt',
          pathCoverage: [],
        }),
      } as unknown as PromptBuilder,
      [assignment],
      10_000,
      true,
      gatewayFactory
    );

    try {
      const invocation = await adapter.prepare({
        workSlot: assignment.workSlot,
        attemptOrdinal: 1,
      });
      const observation = await adapter.execute({
        invocation,
        manifest: manifestFixture,
        lease: leaseFixture,
        sourceExecutionId: 'execution-1',
        sourceReviewRevisionHash: hash('revision'),
        signal: new AbortController().signal,
      });

      expect(observation.qualityFlags).toEqual([
        'context_attestation_unavailable',
        'cross_revision_reuse_disabled',
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'context_gateway_transcript_terminal_hash_invalid'
        )
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns a typed retryable failure with current-revision-only evidence when the witness is missing', async () => {
    const planningPrepared = preparedInvocation('planning prompt');
    const runtimePrepared = preparedInvocation('runtime prompt');
    const provider = {
      name: 'codex/gpt-test',
      describePreparedEnvironmentContract: jest
        .fn()
        .mockReturnValue({ PATH: '/usr/bin' }),
      prepareInvocation: jest
        .fn()
        .mockResolvedValueOnce(planningPrepared)
        .mockResolvedValueOnce(runtimePrepared),
      executePreparedInvocation: jest.fn().mockResolvedValue({
        content: '{}',
        findings: [],
        revalidations: [],
        actualModel: 'gpt-test-actual',
      }),
    } as unknown as CodexProvider;
    const session = {
      providerConfig: gatewayConfig,
      credentialLease: {
        environment: {
          REVIEWROUTER_CONTEXT_GATEWAY_SECRET: 'secret',
        },
      },
      seal: jest
        .fn()
        .mockRejectedValue(
          new ReviewContextInspectionFailure(
            ReviewContextInspectionFailureReason.MissingChangedPathsWitness
          )
        ),
      dispose: jest.fn().mockResolvedValue(undefined),
    };
    const gatewayFactory = {
      planningConfig: jest.fn().mockResolvedValue(gatewayConfig),
      open: jest.fn().mockResolvedValue(session),
    } as unknown as ContextGatewayInvocationSessionFactoryPort;
    const adapter = new CodexReviewInvocationAdapter(
      provider,
      {
        buildPreparedV2: jest.fn().mockResolvedValue({
          version: 'prepared_review_prompt.v2',
          prompt: 'prepared prompt',
          pathCoverage: [],
        }),
      } as unknown as PromptBuilder,
      [assignment],
      10_000,
      true,
      gatewayFactory
    );
    const invocation = await adapter.prepare({
      workSlot: assignment.workSlot,
      attemptOrdinal: 1,
    });

    const failure = await adapter
      .execute({
        invocation,
        manifest: manifestFixture,
        lease: leaseFixture,
        sourceExecutionId: 'execution-1',
        sourceReviewRevisionHash: hash('revision'),
        signal: new AbortController().signal,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RetryableReviewContextInspectionFailure);
    expect(failure).toMatchObject({
      name: 'RetryableReviewContextInspectionFailure',
      reason: ReviewContextInspectionFailureReason.MissingChangedPathsWitness,
      currentRevisionObservation: {
        qualityFlags: [
          'context_inspection_incomplete',
          'cross_revision_reuse_disabled',
        ],
      },
    });
    if (!(failure instanceof RetryableReviewContextInspectionFailure)) {
      throw new Error('expected_retryable_context_inspection_failure');
    }
    expect(failure.currentRevisionObservation).not.toHaveProperty(
      'contextDependencyAttestationId'
    );
    expect(failure.currentRevisionObservation).not.toHaveProperty(
      'contextDependencyAttestationHash'
    );
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it('derives manifest and provider invocation keys only from generated canonicalizers', async () => {
    const infoSpy = jest
      .spyOn(logger, 'info')
      .mockImplementation(() => undefined);
    const adapter = new GeneratedProviderInvocationManifestAssembler(
      authorization,
      {} as ReviewConfig,
      hash('compatibility')
    );
    const invocation = {
      workSlotId: 'slot-1',
      attemptOrdinal: 1,
      provider: 'codex/gpt-test',
      requestedModel: 'gpt-test',
      immutableRequest: Object.freeze({}),
      coverageManifest: createReviewPromptCoverageManifest({
        workSlotId: 'slot-1',
        reviewRevisionHash: hash('revision'),
        assignedPaths: [],
        pathCoverage: [],
      }),
      manifestFacts: {
        taskKindSet: [ReviewTaskKind.FindingDiscovery],
        providerKind: ReviewExecutionProviderKind.Codex,
        providerCapabilityHash: hash('capability'),
        providerRequestEnvelopeHash: hash('request'),
        outputSchemaHash: hash('schema'),
        filePatchManifestHash: hash('patch'),
        contextManifestHash: hash('context'),
        lifecycleTargetSetHash: null,
        liveLifecycleStateHash: null,
        toolPolicyHash: hash('tool'),
        executionProfile: 'agentic_unbounded_v1' as const,
        baseTreeHash: null,
        environmentContractHash: hash('environment'),
      },
    };

    try {
      const manifest = await adapter.assemble(invocation);
      const manifestInput = JSON.parse(manifest.manifestCanonicalJson);
      const expectedManifestKey = hashBytes(
        canonicalizeProviderInvocationManifestV1(manifestInput)
      );
      const expectedInvocationKey = hashBytes(
        providerInvocationIdentityPreimageV1(
          expectedManifestKey,
          authorization.facts.providerVoteLanes[0].providerVoteIdentityHash
        )
      );

      expect(manifest.manifestKey).toBe(expectedManifestKey);
      expect(manifest.providerInvocationKey).toBe(expectedInvocationKey);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `Review invocation manifest: manifest=${expectedManifestKey.slice(
            0,
            12
          )} invocation=${expectedInvocationKey.slice(0, 12)}`
        )
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('clears the pending renewal timer when execution finishes', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-23T11:00:00.000Z'));
    try {
      const supervisor = new CooperativeReviewLeaseSupervisor();

      await expect(
        supervisor.run({
          lease: leaseFixture,
          renew: jest.fn(),
          operation: async () => 'completed',
        })
      ).resolves.toBe('completed');

      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('aborts the operation immediately when lease renewal fails', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-23T11:00:00.000Z'));
    try {
      const supervisor = new CooperativeReviewLeaseSupervisor();
      const renewalError = new Error('lease_renewal_lost');
      let operationSignal: AbortSignal | undefined;
      const operation = jest.fn(
        (signal: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            operationSignal = signal;
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          })
      );
      const running = supervisor.run({
        lease: leaseFixture,
        renew: jest.fn().mockRejectedValue(renewalError),
        operation,
      });
      const rejected = expect(running).rejects.toBe(renewalError);

      await jest.advanceTimersByTimeAsync(30_000);

      await rejected;
      expect(operationSignal?.aborted).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not renew beyond the fixed ceiling and aborts at expiry', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-23T11:00:00.000Z'));
    try {
      const supervisor = new CooperativeReviewLeaseSupervisor();
      const renew = jest.fn();
      const running = supervisor.run({
        lease: {
          ...leaseFixture,
          expiresAt: '2026-07-23T11:00:01.000Z',
          renewalCeilingReached: true,
        },
        renew,
        operation: (signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          }),
      });
      const rejected = expect(running).rejects.toThrow(
        'review_action_v2_lease_expired'
      );

      await jest.advanceTimersByTimeAsync(1_000);

      await rejected;
      expect(renew).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

const workSlot = Object.freeze({
  workSlotId: 'slot-1',
  taskKind: ReviewTaskKind.FindingDiscovery,
  providerKind: ReviewExecutionProviderKind.Codex,
  providerVoteIdentityHash: hash('vote'),
  shardKey: 'batch-1',
  required: true,
  attemptBudget: 1,
  retryPolicyVersion: 'retry-v1',
});

const assignment = Object.freeze({
  workSlot,
  reviewRevisionHash: hash('revision'),
  mergeBaseSha: '2'.repeat(40),
  context: {
    number: 252,
    title: 'PR',
    body: '',
    author: 'author',
    draft: false,
    labels: [],
    files: [],
    diff: '',
    additions: 0,
    deletions: 0,
    baseSha: '1'.repeat(40),
    headSha: '3'.repeat(40),
  },
  lifecycleTargets: [],
  liveLifecycleStateHash: hash('lifecycle'),
});

const authorization: ReviewRunAuthorization = {
  authorizationId: 'authorization-1',
  authorizationToken: 'authorization.token',
  producerReleaseId: 'release-1',
  protocolLimitsProfileId: 'limits-1',
  operationalSloProfileId: 'slo-1',
  mutationEpoch: '1',
  expiresAt: '2026-07-24T00:00:00.000Z',
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

const leaseFixture = {
  leaseId: 'lease-1',
  attemptId: 'attempt-1',
  leaseCapability: 'lease.capability',
  fencingToken: '1',
  expiresAt: '2026-07-23T12:00:00.000Z',
  resultReportUntil: '2026-07-23T12:10:00.000Z',
  renewalCeilingReached: false,
};

const manifestFixture = Object.freeze({
  manifestCanonicalJson: '{}',
  manifestKey: hash('manifest'),
  providerInvocationKey: hash('provider-invocation'),
  providerVoteIdentityHash: hash('vote'),
});

const gatewayConfig = Object.freeze({
  command: process.execPath,
  args: Object.freeze(['/tmp/context-gateway.js']),
  cwd: '/tmp/checkout',
  gatewayBinaryHash: hash('gateway'),
  gatewayPolicyVersion: 'context-gateway-v3',
  enabledTools: Object.freeze([
    'review_read_file',
    'review_list_directory',
    'review_search_text',
    'review_git_fact',
  ]),
  runtimeEnvironment: Object.freeze({
    REVIEWROUTER_CONTEXT_SESSION_ID: 'session-1',
    REVIEWROUTER_CONTEXT_ROOT: '/tmp/checkout',
    REVIEWROUTER_CONTEXT_TRANSCRIPT_PATH: '/tmp/transcript.json',
    REVIEWROUTER_CONTEXT_REPLAY_MATERIAL_PATH: '/tmp/replay.json',
    REVIEWROUTER_CONTEXT_GATEWAY_BINARY_HASH: hash('gateway'),
    REVIEWROUTER_CONTEXT_CHECKOUT_TREE_OID: '4'.repeat(40),
    REVIEWROUTER_CONTEXT_EVENT_CHAIN_SEED_HASH: hash('seed'),
    REVIEWROUTER_CONTEXT_BASE_SHA: '1'.repeat(40),
    REVIEWROUTER_CONTEXT_MERGE_BASE_SHA: '2'.repeat(40),
    REVIEWROUTER_CONTEXT_HEAD_SHA: '3'.repeat(40),
  }),
});

function preparedInvocation(prompt: string) {
  return createPreparedProviderInvocation({
    providerKind: ProviderKind.CodexCli,
    providerName: 'codex/gpt-test',
    requestedModel: 'gpt-test',
    timeoutMs: 10_000,
    request: {
      prompt,
      outputSchema: { type: 'object' },
      environment: { PATH: '/usr/bin' },
    },
    observableRequest: { semantic: 'same' },
  });
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
