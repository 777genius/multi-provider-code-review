import type { ReviewConfig } from '../../types';
import {
  reviewInvestigationExtensionV1,
  reviewInvestigationRolloutAuthorizationV3Contract,
} from '../../control-plane/generated/review-action-v2/review-action-v2';
import {
  DeterministicReviewAgentSelector,
  InvestigationContextGatewayRuntimeConfigurationError,
  InvestigationContextGatewayRuntimeConfigurationFailureReason,
  REVIEW_INVESTIGATION_INDEPENDENT_CRITIC_RISK_PRIORITY_V1,
  ReviewAgentExecutionError,
  ReviewAgentFailureClass,
  ReviewAgentProviderKind,
  ReviewTurnPurpose,
  type ReviewAgentPort,
  type ReviewAgentSelectionPort,
  type ReviewAgentSelectionRequest,
  type InvestigationContextGatewayRuntimeFactoryPort,
} from '../../review-investigation';
import {
  ReviewCapabilityKind,
  ReviewExecutionProviderKind,
  ReviewInvocationConfigurationMismatchError,
  ReviewInvocationConfigurationMismatchReason,
  ReviewInvestigationRecordingMode,
  ReviewInvestigationRolloutCapability,
  type ReviewRunAuthorization,
} from '../application';
import {
  reviewInvestigationCoverageProfileHash,
  reviewInvestigationPolicyHash,
} from './review-investigation-recording-adapter';

export type ProductionReviewInvestigationRolloutFlags = Readonly<{
  recordingEnabled: boolean;
  shadowEnabled: boolean;
  contextCriticEnabled: boolean;
  verifiedCleanEnabled: boolean;
  crossRevisionReplayEnabled: boolean;
  productionEffectsEnabled: boolean;
}>;

export type ProductionReviewInvestigationRollout =
  ProductionReviewInvestigationRolloutFlags;

export type ConfiguredProductionReviewAgent = Readonly<{
  providerKind: ReviewAgentProviderKind;
  requestedModel: string;
  agent: ReviewAgentPort;
}>;

export function createProductionReviewInvestigationGatewayFactory(
  delegate: InvestigationContextGatewayRuntimeFactoryPort
): InvestigationContextGatewayRuntimeFactoryPort {
  return Object.freeze({
    open: async (
      input: Parameters<
        InvestigationContextGatewayRuntimeFactoryPort['open']
      >[0]
    ) => {
      try {
        return await delegate.open(input);
      } catch (error) {
        if (error instanceof ReviewInvocationConfigurationMismatchError) {
          switch (error.reason) {
            case ReviewInvocationConfigurationMismatchReason.ContextGatewayPolicyMismatch:
              throw new InvestigationContextGatewayRuntimeConfigurationError(
                InvestigationContextGatewayRuntimeConfigurationFailureReason.ContextGatewayPolicyMismatch,
                { cause: error }
              );
          }
        }
        throw error;
      }
    },
  });
}

const ROLLOUT_ENV = Object.freeze({
  recordingEnabled: 'REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED',
  shadowEnabled: 'REVIEW_ROUTER_REVIEW_INVESTIGATION_SHADOW_ENABLED',
  contextCriticEnabled:
    'REVIEW_ROUTER_REVIEW_INVESTIGATION_CONTEXT_CRITIC_ENABLED',
  verifiedCleanEnabled:
    'REVIEW_ROUTER_REVIEW_INVESTIGATION_VERIFIED_CLEAN_ENABLED',
  crossRevisionReplayEnabled:
    'REVIEW_ROUTER_REVIEW_INVESTIGATION_CROSS_REVISION_REPLAY_ENABLED',
  productionEffectsEnabled:
    'REVIEW_ROUTER_REVIEW_INVESTIGATION_PRODUCTION_EFFECTS_ENABLED',
});

export function readProductionReviewInvestigationRolloutFlags(
  env: Readonly<NodeJS.ProcessEnv> = process.env
): ProductionReviewInvestigationRolloutFlags {
  return Object.freeze({
    recordingEnabled: readBooleanFlag(
      env[ROLLOUT_ENV.recordingEnabled],
      'recording'
    ),
    shadowEnabled: readBooleanFlag(env[ROLLOUT_ENV.shadowEnabled], 'shadow'),
    contextCriticEnabled: readBooleanFlag(
      env[ROLLOUT_ENV.contextCriticEnabled],
      'context_critic'
    ),
    verifiedCleanEnabled: readBooleanFlag(
      env[ROLLOUT_ENV.verifiedCleanEnabled],
      'verified_clean'
    ),
    crossRevisionReplayEnabled: readBooleanFlag(
      env[ROLLOUT_ENV.crossRevisionReplayEnabled],
      'cross_revision_replay'
    ),
    productionEffectsEnabled: readBooleanFlag(
      env[ROLLOUT_ENV.productionEffectsEnabled],
      'production_effects'
    ),
  });
}

export function resolveProductionReviewInvestigationRollout(input: {
  readonly flags: ProductionReviewInvestigationRolloutFlags;
  readonly agenticContext: boolean;
  readonly authorization: ReviewRunAuthorization;
  readonly primaryProviderKind:
    ReviewExecutionProviderKind.Codex | ReviewExecutionProviderKind.ClaudeCode;
}): ProductionReviewInvestigationRollout {
  assertCanonicalRolloutDependencies(input.flags);
  const recordingEnabled =
    input.flags.recordingEnabled &&
    input.agenticContext &&
    matchesReviewInvestigationCapability({
      facts: input.authorization.facts,
      providerKind: input.primaryProviderKind,
      capability: ReviewInvestigationRolloutCapability.Recording,
    });

  return Object.freeze({
    recordingEnabled,
    shadowEnabled:
      recordingEnabled &&
      input.flags.shadowEnabled &&
      matchesReviewInvestigationCapability({
        facts: input.authorization.facts,
        providerKind: input.primaryProviderKind,
        capability: ReviewInvestigationRolloutCapability.Shadow,
      }),
    contextCriticEnabled:
      recordingEnabled &&
      input.flags.contextCriticEnabled &&
      matchesReviewInvestigationCapability({
        facts: input.authorization.facts,
        providerKind: input.primaryProviderKind,
        capability: ReviewInvestigationRolloutCapability.ContextCritic,
      }),
    verifiedCleanEnabled:
      recordingEnabled &&
      input.flags.verifiedCleanEnabled &&
      matchesReviewInvestigationCapability({
        facts: input.authorization.facts,
        providerKind: input.primaryProviderKind,
        capability: ReviewInvestigationRolloutCapability.VerifiedClean,
      }),
    crossRevisionReplayEnabled:
      recordingEnabled &&
      input.flags.crossRevisionReplayEnabled &&
      matchesReviewInvestigationCapability({
        facts: input.authorization.facts,
        providerKind: input.primaryProviderKind,
        capability: ReviewInvestigationRolloutCapability.CrossRevisionReplay,
      }),
    productionEffectsEnabled:
      recordingEnabled &&
      input.flags.productionEffectsEnabled &&
      matchesReviewInvestigationCapability({
        facts: input.authorization.facts,
        providerKind: input.primaryProviderKind,
        capability: ReviewInvestigationRolloutCapability.ProductionEffects,
      }),
  });
}

export function productionReviewInvestigationRecordingMode(
  rollout: ProductionReviewInvestigationRollout
): ReviewInvestigationRecordingMode {
  return rollout.productionEffectsEnabled
    ? ReviewInvestigationRecordingMode.Authoritative
    : ReviewInvestigationRecordingMode.RecordOnly;
}

export function configuredReviewAgentModel(
  config: ReviewConfig,
  providerKind: ReviewAgentProviderKind
): string | null {
  const prefix =
    providerKind === ReviewAgentProviderKind.Codex ? 'codex/' : 'claude/';
  const selected = [
    ...config.providers,
    ...config.fallbackProviders,
    config.synthesisModel,
  ].find(
    (provider): provider is string =>
      typeof provider === 'string' && provider.startsWith(prefix)
  );
  if (!selected || selected.length === prefix.length) return null;
  return selected.slice(prefix.length);
}

export function createProductionReviewInvestigationAgentSelector(input: {
  readonly authorization: ReviewRunAuthorization;
  readonly primaryProviderKind: ReviewAgentProviderKind;
  readonly contextCriticEnabled: boolean;
  readonly agents: readonly ConfiguredProductionReviewAgent[];
}): ReviewAgentSelectionPort {
  for (const registration of input.agents) {
    if (registration.requestedModel.length === 0) {
      throw new Error('review_agent_configured_model_missing');
    }
  }
  const authorizedAgents = input.agents.filter((registration) =>
    matchesReviewInvestigationCapability({
      facts: input.authorization.facts,
      providerKind: executionProviderKind(registration.providerKind),
      capability: ReviewInvestigationRolloutCapability.Recording,
    })
  );
  const authorizedCriticProviderKinds = new Set(
    authorizedAgents
      .filter((registration) =>
        matchesReviewInvestigationCapability({
          facts: input.authorization.facts,
          providerKind: executionProviderKind(registration.providerKind),
          capability: ReviewInvestigationRolloutCapability.ContextCritic,
        })
      )
      .map((registration) => registration.providerKind)
  );
  if (
    !authorizedAgents.some(
      (registration) => registration.providerKind === input.primaryProviderKind
    )
  ) {
    throw new Error('review_investigation_primary_agent_unavailable');
  }
  const registrations = authorizedAgents.map((registration) => ({
    providerKind: registration.providerKind,
    agent: registration.agent,
  }));
  const allowedProviderKinds = authorizedAgents.map(
    (registration) => registration.providerKind
  );
  const createDelegate = (critic?: ConfiguredProductionReviewAgent) =>
    new DeterministicReviewAgentSelector(registrations, {
      allowedProviderKinds,
      ...(critic
        ? {
            critic: {
              providerKind: critic.providerKind,
              requestedModel: critic.requestedModel,
            },
          }
        : {}),
      requireIndependentCriticAtOrAboveRiskPriority:
        REVIEW_INVESTIGATION_INDEPENDENT_CRITIC_RISK_PRIORITY_V1,
    });
  const primaryDelegate = createDelegate();
  const independentCriticDelegates = new Map(
    authorizedAgents
      .filter(
        (registration) =>
          registration.providerKind !== input.primaryProviderKind &&
          authorizedCriticProviderKinds.has(registration.providerKind)
      )
      .map((registration) => [
        registration.providerKind,
        createDelegate(registration),
      ])
  );
  return new RolloutGatedReviewAgentSelector(
    primaryDelegate,
    independentCriticDelegates,
    input.primaryProviderKind,
    input.contextCriticEnabled
  );
}

class RolloutGatedReviewAgentSelector implements ReviewAgentSelectionPort {
  constructor(
    private readonly primaryDelegate: ReviewAgentSelectionPort,
    private readonly independentCriticDelegates: ReadonlyMap<
      ReviewAgentProviderKind,
      ReviewAgentSelectionPort
    >,
    private readonly primaryProviderKind: ReviewAgentProviderKind,
    private readonly contextCriticEnabled: boolean
  ) {}

  resolve(input: ReviewAgentSelectionRequest) {
    if (input.primaryProviderKind !== this.primaryProviderKind) {
      throw capabilityUnavailable('review_agent_primary_provider_mismatch');
    }
    if (
      input.purpose === ReviewTurnPurpose.Critic &&
      !this.contextCriticEnabled
    ) {
      throw capabilityUnavailable('review_agent_context_critic_disabled');
    }
    const authorityProviderKind =
      input.executionAuthority?.providerKind ?? input.primaryProviderKind;
    if (
      input.purpose === ReviewTurnPurpose.Critic &&
      authorityProviderKind !== this.primaryProviderKind
    ) {
      const independent = this.independentCriticDelegates.get(
        authorityProviderKind
      );
      if (!independent) {
        throw capabilityUnavailable(
          'review_agent_independent_critic_unavailable'
        );
      }
      return independent.resolve(input);
    }
    return this.primaryDelegate.resolve(input);
  }
}

function assertCanonicalRolloutDependencies(
  flags: ProductionReviewInvestigationRolloutFlags
): void {
  const dependencies =
    reviewInvestigationRolloutAuthorizationV3Contract.dependencies as Readonly<
      Record<string, readonly string[]>
    >;
  for (const capability of reviewInvestigationRolloutAuthorizationV3Contract.capabilities) {
    for (const dependency of dependencies[capability]) {
      const capabilityKey = capability as ReviewInvestigationRolloutCapability;
      const dependencyKey = dependency as ReviewInvestigationRolloutCapability;
      assertDependency(
        flags[rolloutFlagByCapability[capabilityKey]],
        flags[rolloutFlagByCapability[dependencyKey]],
        capability,
        dependency
      );
    }
  }
}

function matchesReviewInvestigationCapability(input: {
  readonly facts: ReviewRunAuthorization['facts'];
  readonly providerKind:
    ReviewExecutionProviderKind.Codex | ReviewExecutionProviderKind.ClaudeCode;
  readonly capability: ReviewInvestigationRolloutCapability;
}): boolean {
  const descriptor = input.facts.reviewInvestigation;
  if (
    descriptor?.authorizationDescriptorVersion !==
      reviewInvestigationRolloutAuthorizationV3Contract.authorizationDescriptorVersion ||
    descriptor.capability !== ReviewCapabilityKind.ReviewInvestigationV1 ||
    descriptor.capability !==
      reviewInvestigationRolloutAuthorizationV3Contract.capability ||
    descriptor.extensionId !== reviewInvestigationExtensionV1.extensionId ||
    descriptor.extensionSchemaDigest !==
      reviewInvestigationExtensionV1.schemaDigest ||
    descriptor.extensionCanonicalizerDigest !==
      reviewInvestigationExtensionV1.canonicalizerDigest ||
    descriptor.coverageProfileHash !==
      reviewInvestigationCoverageProfileHash() ||
    descriptor.policyHash !== reviewInvestigationPolicyHash() ||
    !input.facts.providerVoteLanes.some(
      (lane) => lane.providerKind === input.providerKind
    ) ||
    !Array.isArray(descriptor.providerCapabilities)
  ) {
    return false;
  }
  const providerGrant = descriptor.providerCapabilities.find(
    (row) => row?.providerKind === input.providerKind
  );
  return (
    providerGrant !== undefined &&
    Array.isArray(providerGrant.capabilities) &&
    providerGrant.capabilities.includes(input.capability)
  );
}

const rolloutFlagByCapability = Object.freeze({
  [ReviewInvestigationRolloutCapability.ContextCritic]: 'contextCriticEnabled',
  [ReviewInvestigationRolloutCapability.CrossRevisionReplay]:
    'crossRevisionReplayEnabled',
  [ReviewInvestigationRolloutCapability.ProductionEffects]:
    'productionEffectsEnabled',
  [ReviewInvestigationRolloutCapability.Recording]: 'recordingEnabled',
  [ReviewInvestigationRolloutCapability.Shadow]: 'shadowEnabled',
  [ReviewInvestigationRolloutCapability.VerifiedClean]: 'verifiedCleanEnabled',
} as const satisfies Readonly<
  Record<
    ReviewInvestigationRolloutCapability,
    keyof ProductionReviewInvestigationRolloutFlags
  >
>);

function assertDependency(
  capabilityEnabled: boolean,
  dependencyEnabled: boolean,
  capability: string,
  dependency: string
): void {
  if (capabilityEnabled && !dependencyEnabled) {
    throw new Error(`rollout_dependency_missing:${capability}:${dependency}`);
  }
}

function executionProviderKind(
  providerKind: ReviewAgentProviderKind
): ReviewExecutionProviderKind.Codex | ReviewExecutionProviderKind.ClaudeCode {
  switch (providerKind) {
    case ReviewAgentProviderKind.Codex:
      return ReviewExecutionProviderKind.Codex;
    case ReviewAgentProviderKind.ClaudeCode:
      return ReviewExecutionProviderKind.ClaudeCode;
  }
}

function readBooleanFlag(
  value: string | undefined,
  capability: string
): boolean {
  if (value === undefined || value === '' || value === '0') {
    return false;
  }
  if (value === '1') return true;
  throw new Error(`review_investigation_rollout_flag_invalid:${capability}`);
}

function capabilityUnavailable(message: string): ReviewAgentExecutionError {
  return new ReviewAgentExecutionError(
    ReviewAgentFailureClass.CapabilityUnavailable,
    null,
    message
  );
}
