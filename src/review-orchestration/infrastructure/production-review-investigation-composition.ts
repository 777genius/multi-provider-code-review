import { ReviewDepth, type ReviewConfig } from '../../types';
import {
  reviewInvestigationExtensionV1,
  reviewInvestigationRolloutAuthorizationV3Contract,
} from '../../control-plane/generated/review-action-v2/review-action-v2';
import {
  DeterministicReviewAgentSelector,
  InvestigationContextGatewayRuntimeConfigurationError,
  InvestigationContextGatewayRuntimeConfigurationFailureReason,
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

export enum ProductionReviewInvestigationRolloutReason {
  Enabled = 'enabled',
  ReviewDepthEconomy = 'review_depth_economy',
  RecordingFlagDisabled = 'recording_flag_disabled',
  AgenticContextDisabled = 'agentic_context_disabled',
  AuthorizationDescriptorMissing = 'authorization_descriptor_missing',
  AuthorizationDescriptorVersionMismatch = 'authorization_descriptor_version_mismatch',
  CapabilityMismatch = 'capability_mismatch',
  ExtensionIdMismatch = 'extension_id_mismatch',
  ExtensionSchemaDigestMismatch = 'extension_schema_digest_mismatch',
  ExtensionCanonicalizerDigestMismatch = 'extension_canonicalizer_digest_mismatch',
  CoverageProfileHashMismatch = 'coverage_profile_hash_mismatch',
  PolicyHashMismatch = 'policy_hash_mismatch',
  ProviderVoteLaneMissing = 'provider_vote_lane_missing',
  ProviderCapabilitiesMissing = 'provider_capabilities_missing',
  ProviderGrantMissing = 'provider_grant_missing',
  RecordingGrantMissing = 'recording_grant_missing',
}

export type ProductionReviewInvestigationRolloutResolution = Readonly<{
  rollout: ProductionReviewInvestigationRollout;
  reason: ProductionReviewInvestigationRolloutReason;
}>;

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
    | ReviewExecutionProviderKind.Codex
    | ReviewExecutionProviderKind.ClaudeCode;
  readonly reviewDepth?: ReviewDepth;
}): ProductionReviewInvestigationRollout {
  return resolveProductionReviewInvestigationRolloutResolution(input).rollout;
}

export function resolveProductionReviewInvestigationRolloutResolution(input: {
  readonly flags: ProductionReviewInvestigationRolloutFlags;
  readonly agenticContext: boolean;
  readonly authorization: ReviewRunAuthorization;
  readonly primaryProviderKind:
    | ReviewExecutionProviderKind.Codex
    | ReviewExecutionProviderKind.ClaudeCode;
  readonly reviewDepth?: ReviewDepth;
}): ProductionReviewInvestigationRolloutResolution {
  if (input.reviewDepth === ReviewDepth.Economy) {
    return Object.freeze({
      rollout: disabledProductionReviewInvestigationRollout(),
      reason: ProductionReviewInvestigationRolloutReason.ReviewDepthEconomy,
    });
  }
  assertCanonicalRolloutDependencies(input.flags);
  const recordingDecision = resolveRecordingCapability({
    ...input,
    capability: ReviewInvestigationRolloutCapability.Recording,
  });
  const recordingEnabled =
    recordingDecision === ProductionReviewInvestigationRolloutReason.Enabled;
  const contextCriticEnabled =
    recordingEnabled &&
    input.flags.contextCriticEnabled &&
    matchesReviewInvestigationCapability({
      facts: input.authorization.facts,
      providerKind: input.primaryProviderKind,
      capability: ReviewInvestigationRolloutCapability.ContextCritic,
    });

  const rollout = Object.freeze({
    recordingEnabled,
    shadowEnabled:
      recordingEnabled &&
      input.flags.shadowEnabled &&
      matchesReviewInvestigationCapability({
        facts: input.authorization.facts,
        providerKind: input.primaryProviderKind,
        capability: ReviewInvestigationRolloutCapability.Shadow,
      }),
    contextCriticEnabled,
    verifiedCleanEnabled:
      recordingEnabled &&
      contextCriticEnabled &&
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
  return Object.freeze({ rollout, reason: recordingDecision });
}

function disabledProductionReviewInvestigationRollout(): ProductionReviewInvestigationRollout {
  return Object.freeze({
    recordingEnabled: false,
    shadowEnabled: false,
    contextCriticEnabled: false,
    verifiedCleanEnabled: false,
    crossRevisionReplayEnabled: false,
    productionEffectsEnabled: false,
  });
}

export function createProductionReviewInvestigationInvocation<T>(input: {
  readonly rollout: ProductionReviewInvestigationRollout;
  readonly create: () => T;
}): T | undefined {
  return input.rollout.recordingEnabled ? input.create() : undefined;
}

function resolveRecordingCapability(input: {
  readonly flags: ProductionReviewInvestigationRolloutFlags;
  readonly agenticContext: boolean;
  readonly authorization: ReviewRunAuthorization;
  readonly primaryProviderKind:
    | ReviewExecutionProviderKind.Codex
    | ReviewExecutionProviderKind.ClaudeCode;
  readonly capability: ReviewInvestigationRolloutCapability.Recording;
}): ProductionReviewInvestigationRolloutReason {
  if (!input.flags.recordingEnabled) {
    return ProductionReviewInvestigationRolloutReason.RecordingFlagDisabled;
  }
  if (!input.agenticContext) {
    return ProductionReviewInvestigationRolloutReason.AgenticContextDisabled;
  }
  return (
    reviewInvestigationCapabilityMismatchReason({
      facts: input.authorization.facts,
      providerKind: input.primaryProviderKind,
      capability: input.capability,
    }) ?? ProductionReviewInvestigationRolloutReason.Enabled
  );
}

function reviewInvestigationCapabilityMismatchReason(input: {
  readonly facts: ReviewRunAuthorization['facts'];
  readonly providerKind:
    | ReviewExecutionProviderKind.Codex
    | ReviewExecutionProviderKind.ClaudeCode;
  readonly capability: ReviewInvestigationRolloutCapability;
}): ProductionReviewInvestigationRolloutReason | null {
  const descriptor = input.facts.reviewInvestigation;
  if (!descriptor) {
    return ProductionReviewInvestigationRolloutReason.AuthorizationDescriptorMissing;
  }
  if (
    descriptor.authorizationDescriptorVersion !==
    reviewInvestigationRolloutAuthorizationV3Contract.authorizationDescriptorVersion
  ) {
    return ProductionReviewInvestigationRolloutReason.AuthorizationDescriptorVersionMismatch;
  }
  if (
    descriptor.capability !== ReviewCapabilityKind.ReviewInvestigationV1 ||
    descriptor.capability !==
      reviewInvestigationRolloutAuthorizationV3Contract.capability
  ) {
    return ProductionReviewInvestigationRolloutReason.CapabilityMismatch;
  }
  if (descriptor.extensionId !== reviewInvestigationExtensionV1.extensionId) {
    return ProductionReviewInvestigationRolloutReason.ExtensionIdMismatch;
  }
  if (
    descriptor.extensionSchemaDigest !==
    reviewInvestigationExtensionV1.schemaDigest
  ) {
    return ProductionReviewInvestigationRolloutReason.ExtensionSchemaDigestMismatch;
  }
  if (
    descriptor.extensionCanonicalizerDigest !==
    reviewInvestigationExtensionV1.canonicalizerDigest
  ) {
    return ProductionReviewInvestigationRolloutReason.ExtensionCanonicalizerDigestMismatch;
  }
  if (
    descriptor.coverageProfileHash !== reviewInvestigationCoverageProfileHash()
  ) {
    return ProductionReviewInvestigationRolloutReason.CoverageProfileHashMismatch;
  }
  if (descriptor.policyHash !== reviewInvestigationPolicyHash()) {
    return ProductionReviewInvestigationRolloutReason.PolicyHashMismatch;
  }
  if (
    !input.facts.providerVoteLanes.some(
      (lane) => lane.providerKind === input.providerKind
    )
  ) {
    return ProductionReviewInvestigationRolloutReason.ProviderVoteLaneMissing;
  }
  if (!Array.isArray(descriptor.providerCapabilities)) {
    return ProductionReviewInvestigationRolloutReason.ProviderCapabilitiesMissing;
  }
  const providerGrant = descriptor.providerCapabilities.find(
    (row) => row?.providerKind === input.providerKind
  );
  if (!providerGrant || !Array.isArray(providerGrant.capabilities)) {
    return ProductionReviewInvestigationRolloutReason.ProviderGrantMissing;
  }
  if (!providerGrant.capabilities.includes(input.capability)) {
    return input.capability === ReviewInvestigationRolloutCapability.Recording
      ? ProductionReviewInvestigationRolloutReason.RecordingGrantMissing
      : ProductionReviewInvestigationRolloutReason.ProviderGrantMissing;
  }
  return null;
}

export function formatProductionReviewInvestigationRolloutTelemetry(
  resolution: ProductionReviewInvestigationRolloutResolution
): string {
  const rollout = resolution.rollout;
  return [
    'Review investigation rollout:',
    `recording=${rollout.recordingEnabled}`,
    `reason=${resolution.reason}`,
    `shadow=${rollout.shadowEnabled}`,
    `contextCritic=${rollout.contextCriticEnabled}`,
    `verifiedClean=${rollout.verifiedCleanEnabled}`,
    `crossRevisionReplay=${rollout.crossRevisionReplayEnabled}`,
    `productionEffects=${rollout.productionEffectsEnabled}`,
  ].join(' ');
}

function matchesReviewInvestigationCapability(input: {
  readonly facts: ReviewRunAuthorization['facts'];
  readonly providerKind:
    | ReviewExecutionProviderKind.Codex
    | ReviewExecutionProviderKind.ClaudeCode;
  readonly capability: ReviewInvestigationRolloutCapability;
}): boolean {
  return reviewInvestigationCapabilityMismatchReason(input) === null;
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
