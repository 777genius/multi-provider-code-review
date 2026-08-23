import type { ReviewInvestigationLease } from '../../../src/review-investigation/application/investigation-control-plane-port';
import {
  ReviewInvestigationGatewayConfigurationError,
  ReviewInvestigationGatewayConfigurationFailureReason,
} from '../../../src/review-investigation/application/investigation-gateway-port';
import {
  ReviewAgentExecutionProfile,
  ReviewAgentProviderKind,
} from '../../../src/review-investigation/domain/runtime-profile';
import {
  ContextGatewayV4InvestigationAdapter,
  InvestigationContextGatewayRuntimeConfigurationError,
  InvestigationContextGatewayRuntimeConfigurationFailureReason,
  type InvestigationContextGatewayRuntimeFactoryPort,
} from '../../../src/review-investigation/infrastructure/context-gateway-v4-investigation-adapter';

const hash = 'a'.repeat(64);
const lease: ReviewInvestigationLease = Object.freeze({
  leaseId: 'lease-1',
  attemptId: 'attempt-1',
  leaseCapability: 'lease-capability',
  fencingToken: '7',
  expiresAt: '2026-08-04T10:05:00.000Z',
  resultReportUntil: '2026-08-04T10:10:00.000Z',
});

describe('ContextGatewayV4InvestigationAdapter', () => {
  it('fails closed when no prepared-manifest authority is available', () => {
    expect(
      () =>
        new ContextGatewayV4InvestigationAdapter(
          {} as InvestigationContextGatewayRuntimeFactoryPort,
          {
            revision: {
              baseSha: 'b'.repeat(40),
              mergeBaseSha: 'c'.repeat(40),
              headSha: 'd'.repeat(40),
            },
            executionProfile: 'investigation_gateway_v1',
            providerInvocationKey: 'parent-invocation',
            toolPolicyHash: hash,
          }
        )
    ).toThrow('investigation_prepared_manifest_key_missing');
  });

  it('rejects an unknown provider at the adapter boundary', () => {
    expect(
      () =>
        new ContextGatewayV4InvestigationAdapter(
          {} as InvestigationContextGatewayRuntimeFactoryPort,
          {
            revision: {
              baseSha: 'b'.repeat(40),
              mergeBaseSha: 'c'.repeat(40),
              headSha: 'd'.repeat(40),
            },
            preparedManifestKey: 'manifest-key',
            providerKind: 'unknown-provider',
            requestedModel: 'model',
            executionProfile: 'investigation_gateway_v1',
            providerInvocationKey: 'provider-invocation',
            toolPolicyHash: hash,
          }
        )
    ).toThrow('investigation_provider_kind_invalid');
  });

  it('rejects an unknown execution profile at the adapter boundary', () => {
    expect(
      () =>
        new ContextGatewayV4InvestigationAdapter(
          {} as InvestigationContextGatewayRuntimeFactoryPort,
          {
            revision: {
              baseSha: 'b'.repeat(40),
              mergeBaseSha: 'c'.repeat(40),
              headSha: 'd'.repeat(40),
            },
            preparedManifestKey: 'manifest-key',
            providerKind: ReviewAgentProviderKind.Codex,
            requestedModel: 'model',
            executionProfile: 'unknown-profile',
            providerInvocationKey: 'provider-invocation',
            toolPolicyHash: hash,
          }
        )
    ).toThrow('investigation_execution_profile_invalid');
  });

  it('maps runtime policy drift to a fatal investigation configuration error', async () => {
    const factory = {
      open: jest
        .fn()
        .mockRejectedValue(
          new InvestigationContextGatewayRuntimeConfigurationError(
            InvestigationContextGatewayRuntimeConfigurationFailureReason.ContextGatewayPolicyMismatch
          )
        ),
    } as unknown as InvestigationContextGatewayRuntimeFactoryPort;
    const adapter = new ContextGatewayV4InvestigationAdapter(factory, {
      revision: {
        baseSha: 'b'.repeat(40),
        mergeBaseSha: 'c'.repeat(40),
        headSha: 'd'.repeat(40),
      },
      preparedManifestKey: 'manifest-key',
      providerKind: ReviewAgentProviderKind.Codex,
      requestedModel: 'gpt-test',
      executionProfile: 'investigation_gateway_v1',
      providerInvocationKey: 'provider-invocation',
      toolPolicyHash: hash,
    });

    await expect(
      adapter.open({
        executionId: 'execution-1',
        workSlotId: 'slot-1',
        reviewRevisionHash: hash,
        investigationId: 'investigation-1',
        turnId: 'turn-1',
        maxOperations: 32,
        currentLease: () => lease,
      })
    ).rejects.toMatchObject({
      name: ReviewInvestigationGatewayConfigurationError.name,
      reason:
        ReviewInvestigationGatewayConfigurationFailureReason.ContextGatewayPolicyMismatch,
    });
  });

  it('opens confinement with prepared-manifest provider and model authority', async () => {
    const session = {
      providerConfig: Object.freeze({
        command: '/usr/bin/node',
        args: Object.freeze(['/tmp/context-gateway.cjs']),
        cwd: '/tmp/review',
        gatewayBinaryHash: hash,
        gatewayPolicyVersion: 'context-gateway-v4' as const,
        enabledTools: Object.freeze(['review_read_file']),
        runtimeEnvironment: Object.freeze({}),
      }),
      credentialLease: Object.freeze({ environment: Object.freeze({}) }),
      seal: jest.fn(async () => ({
        attestationId: 'attestation-1',
        attestationHash: hash,
      })),
      dispose: jest.fn(async () => undefined),
    };
    const factory = {
      planningConfig: jest.fn(),
      open: jest.fn(async () => session),
    } as unknown as InvestigationContextGatewayRuntimeFactoryPort;
    const adapter = new ContextGatewayV4InvestigationAdapter(factory, {
      revision: {
        baseSha: 'b'.repeat(40),
        mergeBaseSha: 'c'.repeat(40),
        headSha: 'd'.repeat(40),
      },
      preparedManifestKey: 'manifest-key',
      providerKind: ReviewAgentProviderKind.ClaudeCode,
      requestedModel: 'claude-critic',
      executionProfile: 'investigation_gateway_v1',
      providerInvocationKey: 'critic-invocation',
      toolPolicyHash: hash,
    });

    const opened = await adapter.open({
      executionId: 'execution-1',
      workSlotId: 'slot-1',
      reviewRevisionHash: hash,
      investigationId: 'investigation-1',
      turnId: 'turn-2',
      maxOperations: 64,
      currentLease: () => lease,
    });

    expect(adapter.executionAuthority).toMatchObject({
      preparedManifestKey: 'manifest-key',
      providerKind: ReviewAgentProviderKind.ClaudeCode,
      requestedModel: 'claude-critic',
      providerInvocationKey: 'critic-invocation',
      executionProfile: ReviewAgentExecutionProfile.InvestigationGatewayV1,
    });
    expect(factory.open).toHaveBeenCalledWith(
      expect.objectContaining({
        providerKind: ReviewAgentProviderKind.ClaudeCode,
        requestedModel: 'claude-critic',
        executionProfile: ReviewAgentExecutionProfile.InvestigationGatewayV1,
        providerInvocationKey: 'critic-invocation',
        openingIntentDiscriminator: 'investigation-1:turn-2',
        maxOperations: 64,
      })
    );
    expect(opened).not.toHaveProperty('providerConfig');
    expect(
      adapter.resolve(opened.agentSession, ReviewAgentProviderKind.ClaudeCode)
    ).toMatchObject({
      command: '/usr/bin/node',
      args: ['/tmp/context-gateway.cjs'],
      cwd: '/tmp/review',
      binaryHash: hash,
    });
    expect(() =>
      adapter.resolve(opened.agentSession, ReviewAgentProviderKind.Codex)
    ).toThrow('review_agent_execution_session_provider_mismatch');

    await opened.dispose();

    expect(() =>
      adapter.resolve(opened.agentSession, ReviewAgentProviderKind.ClaudeCode)
    ).toThrow('review_agent_execution_session_unavailable');
  });
});
