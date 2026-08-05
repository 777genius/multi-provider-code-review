import { CONTEXT_GATEWAY_V4_POLICY_VERSION } from '../../context-gateway/context-gateway-v4-contract';
import {
  ReviewInvestigationGatewayConfigurationError,
  ReviewInvestigationGatewayConfigurationFailureReason,
  type AcceptedInvestigationAttestation,
  type ReviewInvestigationGatewayOpenInput,
  type ReviewInvestigationGatewayRevision,
  type ReviewInvestigationGatewaySessionFactoryPort,
  type ReviewInvestigationGatewaySessionPort,
  type ReviewInvestigationTurnExecutionAuthority,
} from '../application/investigation-gateway-port';
import {
  ReviewAgentExecutionError,
  ReviewAgentExecutionSessionKind,
  ReviewAgentFailureClass,
  type ReviewAgentExecutionSession,
} from '../application/review-agent-port';
import {
  ReviewAgentExecutionProfile,
  ReviewAgentProviderKind,
} from '../domain/runtime-profile';
import type {
  ReviewAgentExecutionSessionResolverPort,
  ReviewAgentGatewayLaunchBinding,
} from './review-agent-execution-session';

type InvestigationContextGatewayInvocationLease = Readonly<{
  leaseId: string;
  attemptId: string;
  leaseCapability: string;
  fencingToken: string;
  expiresAt: string;
  resultReportUntil: string;
  renewalCeilingReached: boolean;
}>;

type InvestigationContextGatewayRuntimeConfig = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  gatewayBinaryHash: string;
  gatewayPolicyVersion: unknown;
  enabledTools: readonly string[];
  runtimeEnvironment: Readonly<Record<string, string | undefined>>;
}>;

type InvestigationContextGatewayCredentialBinding = Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
}>;

export interface InvestigationContextGatewayRuntimeSessionPort {
  readonly providerConfig: InvestigationContextGatewayRuntimeConfig;
  readonly credentialLease: InvestigationContextGatewayCredentialBinding;
  seal(input: {
    readonly actualModel: string;
    readonly terminalOutcomeHash: string;
  }): Promise<AcceptedInvestigationAttestation | null>;
  dispose(): Promise<void>;
}

export interface InvestigationContextGatewayRuntimeFactoryPort {
  open(input: {
    readonly invocationLease: InvestigationContextGatewayInvocationLease;
    readonly currentInvocationLease?: () => InvestigationContextGatewayInvocationLease;
    readonly sourceExecutionId: string;
    readonly sourceWorkSlotId: string;
    readonly sourceReviewRevisionHash: string;
    readonly providerKind: ReviewAgentProviderKind;
    readonly requestedModel: string;
    readonly executionProfile: ReviewAgentExecutionProfile;
    readonly providerInvocationKey: string;
    readonly toolPolicyHash: string;
    readonly openingIntentDiscriminator: string;
    readonly revision: ReviewInvestigationGatewayRevision;
  }): Promise<InvestigationContextGatewayRuntimeSessionPort>;
}

export enum InvestigationContextGatewayRuntimeConfigurationFailureReason {
  ContextGatewayPolicyMismatch = 'context_gateway_policy_mismatch',
}

export class InvestigationContextGatewayRuntimeConfigurationError extends Error {
  constructor(
    readonly reason: InvestigationContextGatewayRuntimeConfigurationFailureReason,
    options: ErrorOptions = {}
  ) {
    super(
      `investigation_context_gateway_runtime_configuration:${reason}`,
      options
    );
    this.name = 'InvestigationContextGatewayRuntimeConfigurationError';
  }
}

type ActiveReviewAgentExecutionSession = {
  active: boolean;
  readonly providerKind: ReviewAgentProviderKind;
  readonly binding: ReviewAgentGatewayLaunchBinding;
};

export class ContextGatewayV4InvestigationAdapter
  implements
    ReviewInvestigationGatewaySessionFactoryPort,
    ReviewAgentExecutionSessionResolverPort
{
  readonly executionAuthority: ReviewInvestigationTurnExecutionAuthority;
  private readonly agentSessions = new WeakMap<
    ReviewAgentExecutionSession,
    ActiveReviewAgentExecutionSession
  >();

  constructor(
    private readonly factory: InvestigationContextGatewayRuntimeFactoryPort,
    private readonly context: Readonly<{
      revision: ReviewInvestigationGatewayRevision;
      preparedManifestKey?: string;
      providerKind?: unknown;
      requestedModel?: string;
      executionProfile?: unknown;
      providerInvocationKey: string;
      toolPolicyHash: string;
    }>
  ) {
    // Independent critics stay gated until Review Executions supplies their
    // own fenced prepared manifest instead of the parent work-slot manifest.
    this.executionAuthority = Object.freeze({
      preparedManifestKey: requireAuthorityValue(
        context.preparedManifestKey,
        'investigation_prepared_manifest_key_missing'
      ),
      providerInvocationKey: requireAuthorityValue(
        context.providerInvocationKey,
        'investigation_provider_invocation_key_missing'
      ),
      providerKind: requireProviderKind(context.providerKind),
      requestedModel: requireAuthorityValue(
        context.requestedModel,
        'investigation_requested_model_missing'
      ),
      executionProfile: requireExecutionProfile(context.executionProfile),
      toolPolicyHash: requireAuthorityValue(
        context.toolPolicyHash,
        'investigation_tool_policy_hash_missing'
      ),
    });
  }

  async open(
    input: ReviewInvestigationGatewayOpenInput
  ): Promise<ReviewInvestigationGatewaySessionPort> {
    let session: InvestigationContextGatewayRuntimeSessionPort;
    try {
      session = await this.factory.open({
        invocationLease: runtimeLease(input.currentLease()),
        currentInvocationLease: () => runtimeLease(input.currentLease()),
        sourceExecutionId: input.executionId,
        sourceWorkSlotId: input.workSlotId,
        sourceReviewRevisionHash: input.reviewRevisionHash,
        providerKind: this.executionAuthority.providerKind,
        requestedModel: this.executionAuthority.requestedModel,
        executionProfile: this.executionAuthority.executionProfile,
        providerInvocationKey: this.executionAuthority.providerInvocationKey,
        toolPolicyHash: this.executionAuthority.toolPolicyHash,
        openingIntentDiscriminator: `${input.investigationId}:${input.turnId}`,
        revision: this.context.revision,
      });
    } catch (error) {
      throw mapRuntimeConfigurationFailure(error) ?? error;
    }
    if (
      session.providerConfig.gatewayPolicyVersion !==
      CONTEXT_GATEWAY_V4_POLICY_VERSION
    ) {
      await session.dispose();
      throw new Error('investigation_context_gateway_v4_required');
    }
    const agentSession: ReviewAgentExecutionSession = Object.freeze({
      kind: ReviewAgentExecutionSessionKind.ContextGatewayV4,
    });
    const activeSession: ActiveReviewAgentExecutionSession = {
      active: true,
      providerKind: this.executionAuthority.providerKind,
      binding: Object.freeze({
        policyVersion: CONTEXT_GATEWAY_V4_POLICY_VERSION,
        binaryHash: session.providerConfig.gatewayBinaryHash,
        command: session.providerConfig.command,
        args: Object.freeze([...session.providerConfig.args]),
        cwd: session.providerConfig.cwd,
        enabledTools: Object.freeze([...session.providerConfig.enabledTools]),
        runtimeEnvironment: Object.freeze({
          ...session.providerConfig.runtimeEnvironment,
        }),
        credentialEnvironment: Object.freeze({
          ...(session.credentialLease.environment ?? {}),
        }),
      }),
    };
    this.agentSessions.set(agentSession, activeSession);
    return Object.freeze({
      agentSession,
      seal: async (
        sealInput: Parameters<ReviewInvestigationGatewaySessionPort['seal']>[0]
      ): Promise<AcceptedInvestigationAttestation> => {
        const accepted = await session.seal(sealInput);
        if (!accepted) {
          throw new Error('investigation_context_attestation_rejected');
        }
        return accepted;
      },
      dispose: async (): Promise<void> => {
        activeSession.active = false;
        this.agentSessions.delete(agentSession);
        await session.dispose();
      },
    });
  }

  resolve(
    session: ReviewAgentExecutionSession,
    providerKind: ReviewAgentProviderKind
  ): ReviewAgentGatewayLaunchBinding {
    const activeSession = this.agentSessions.get(session);
    if (
      session.kind !== ReviewAgentExecutionSessionKind.ContextGatewayV4 ||
      !activeSession?.active
    ) {
      throw confinementViolation('review_agent_execution_session_unavailable');
    }
    if (activeSession.providerKind !== providerKind) {
      throw confinementViolation(
        'review_agent_execution_session_provider_mismatch'
      );
    }
    return activeSession.binding;
  }
}

function mapRuntimeConfigurationFailure(
  error: unknown
): ReviewInvestigationGatewayConfigurationError | null {
  if (
    !(error instanceof InvestigationContextGatewayRuntimeConfigurationError)
  ) {
    return null;
  }
  switch (error.reason) {
    case InvestigationContextGatewayRuntimeConfigurationFailureReason.ContextGatewayPolicyMismatch:
      return new ReviewInvestigationGatewayConfigurationError(
        ReviewInvestigationGatewayConfigurationFailureReason.ContextGatewayPolicyMismatch,
        { cause: error }
      );
  }
}

function requireProviderKind(value: unknown): ReviewAgentProviderKind {
  switch (value) {
    case ReviewAgentProviderKind.Codex:
      return ReviewAgentProviderKind.Codex;
    case ReviewAgentProviderKind.ClaudeCode:
      return ReviewAgentProviderKind.ClaudeCode;
    default:
      throw new Error('investigation_provider_kind_invalid');
  }
}

function requireExecutionProfile(value: unknown): ReviewAgentExecutionProfile {
  switch (value) {
    case ReviewAgentExecutionProfile.GatewayAttestedAgentV1:
      return ReviewAgentExecutionProfile.GatewayAttestedAgentV1;
    case ReviewAgentExecutionProfile.InvestigationGatewayV1:
      return ReviewAgentExecutionProfile.InvestigationGatewayV1;
    default:
      throw new Error('investigation_execution_profile_invalid');
  }
}

function requireAuthorityValue(
  value: string | undefined,
  error: string
): string {
  if (value === undefined || value.length === 0) throw new Error(error);
  return value;
}

function confinementViolation(message: string): ReviewAgentExecutionError {
  return new ReviewAgentExecutionError(
    ReviewAgentFailureClass.ConfinementViolation,
    null,
    message
  );
}

function runtimeLease(
  lease: ReturnType<ReviewInvestigationGatewayOpenInput['currentLease']>
): InvestigationContextGatewayInvocationLease {
  return Object.freeze({ ...lease, renewalCeilingReached: false });
}
