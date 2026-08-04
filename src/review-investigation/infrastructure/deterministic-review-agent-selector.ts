import {
  ReviewAgentExecutionError,
  ReviewAgentFailureClass,
  type ReviewAgentPort,
  type ReviewAgentSelection,
  type ReviewAgentSelectionPort,
  type ReviewAgentSelectionRequest,
} from '../application/review-agent-port';
import { ReviewAgentProviderKind } from '../domain/runtime-profile';
import { ReviewTurnPurpose } from '../domain/turn-observation';

export type RegisteredReviewAgent = Readonly<{
  providerKind: ReviewAgentProviderKind;
  agent: ReviewAgentPort;
}>;

export type DeterministicReviewAgentSelectorOptions = Readonly<{
  allowedProviderKinds: readonly ReviewAgentProviderKind[];
  critic?: Readonly<{
    providerKind: ReviewAgentProviderKind;
    requestedModel: string;
  }>;
  requireIndependentCriticAtOrAboveRiskPriority?: number;
}>;

export class DeterministicReviewAgentSelector implements ReviewAgentSelectionPort {
  private readonly registrations: ReadonlyMap<
    ReviewAgentProviderKind,
    RegisteredReviewAgent
  >;

  constructor(
    registrations: readonly RegisteredReviewAgent[],
    private readonly options: DeterministicReviewAgentSelectorOptions
  ) {
    if (
      registrations.length === 0 ||
      new Set(registrations.map((item) => item.providerKind)).size !==
        registrations.length
    ) {
      throw new Error('review_agent_registrations_invalid');
    }
    if (
      options.allowedProviderKinds.length === 0 ||
      new Set(options.allowedProviderKinds).size !==
        options.allowedProviderKinds.length
    ) {
      throw new Error('review_agent_allowed_providers_invalid');
    }
    const threshold = options.requireIndependentCriticAtOrAboveRiskPriority;
    if (
      threshold !== undefined &&
      (!Number.isSafeInteger(threshold) ||
        threshold < 0 ||
        threshold > 1_000_000)
    ) {
      throw new Error('review_agent_independent_critic_threshold_invalid');
    }
    if (options.critic?.requestedModel.length === 0) {
      throw new Error('review_agent_critic_model_missing');
    }
    this.registrations = new Map(
      registrations.map((registration) => [
        registration.providerKind,
        registration,
      ])
    );
  }

  resolve(input: ReviewAgentSelectionRequest): ReviewAgentSelection {
    const criticRoute =
      input.purpose === ReviewTurnPurpose.Critic
        ? this.options.critic
        : undefined;
    const providerKind = criticRoute?.providerKind ?? input.primaryProviderKind;
    const requestedModel =
      criticRoute?.requestedModel ?? input.primaryRequestedModel;
    const executionAuthority = input.executionAuthority ?? {
      providerKind: input.primaryProviderKind,
      requestedModel: input.primaryRequestedModel,
    };
    const threshold =
      this.options.requireIndependentCriticAtOrAboveRiskPriority;
    if (!this.options.allowedProviderKinds.includes(providerKind)) {
      throw new ReviewAgentExecutionError(
        ReviewAgentFailureClass.CapabilityUnavailable,
        null,
        'review_agent_provider_not_authorized'
      );
    }
    if (
      input.purpose === ReviewTurnPurpose.Critic &&
      threshold !== undefined &&
      input.maximumSemanticRiskPriority >= threshold &&
      providerKind === input.primaryProviderKind
    ) {
      throw new ReviewAgentExecutionError(
        ReviewAgentFailureClass.ConfinementViolation,
        null,
        'review_agent_critic_execution_authority_unavailable'
      );
    }
    if (
      providerKind !== executionAuthority.providerKind ||
      requestedModel !== executionAuthority.requestedModel
    ) {
      throw new ReviewAgentExecutionError(
        ReviewAgentFailureClass.ConfinementViolation,
        null,
        input.purpose === ReviewTurnPurpose.Critic
          ? 'review_agent_critic_execution_authority_unavailable'
          : 'review_agent_execution_authority_mismatch'
      );
    }
    const registration = this.registrations.get(providerKind);
    if (!registration) {
      throw new ReviewAgentExecutionError(
        ReviewAgentFailureClass.CapabilityUnavailable,
        null,
        'review_agent_provider_not_registered'
      );
    }
    return Object.freeze({
      agent: registration.agent,
      providerKind,
      requestedModel,
    });
  }
}
