import { type ReviewAgentPort } from '../../../src/review-investigation/application/review-agent-port';
import { ReviewAgentProviderKind } from '../../../src/review-investigation/domain/runtime-profile';
import { ReviewTurnPurpose } from '../../../src/review-investigation/domain/turn-observation';
import { DeterministicReviewAgentSelector } from '../../../src/review-investigation/infrastructure/deterministic-review-agent-selector';

describe('DeterministicReviewAgentSelector', () => {
  it('keeps discovery on the primary provider and model', () => {
    const codex = agent();
    const selector = new DeterministicReviewAgentSelector(
      [
        {
          providerKind: ReviewAgentProviderKind.Codex,
          agent: codex,
        },
      ],
      { allowedProviderKinds: [ReviewAgentProviderKind.Codex] }
    );

    expect(
      selector.resolve({
        primaryProviderKind: ReviewAgentProviderKind.Codex,
        primaryRequestedModel: 'gpt-primary',
        purpose: ReviewTurnPurpose.Discovery,
        maximumSemanticRiskPriority: 900_000,
      })
    ).toEqual({
      agent: codex,
      providerKind: ReviewAgentProviderKind.Codex,
      requestedModel: 'gpt-primary',
    });
  });

  it('routes a critic only when independent provider and model authority match', () => {
    const codex = agent();
    const claude = agent();
    const selector = new DeterministicReviewAgentSelector(
      [
        {
          providerKind: ReviewAgentProviderKind.Codex,
          agent: codex,
        },
        {
          providerKind: ReviewAgentProviderKind.ClaudeCode,
          agent: claude,
        },
      ],
      {
        allowedProviderKinds: [
          ReviewAgentProviderKind.Codex,
          ReviewAgentProviderKind.ClaudeCode,
        ],
        critic: {
          providerKind: ReviewAgentProviderKind.ClaudeCode,
          requestedModel: 'claude-critic',
        },
        requireIndependentCriticAtOrAboveRiskPriority: 800_000,
      }
    );

    expect(
      selector.resolve({
        primaryProviderKind: ReviewAgentProviderKind.Codex,
        primaryRequestedModel: 'gpt-primary',
        executionAuthority: {
          providerKind: ReviewAgentProviderKind.ClaudeCode,
          requestedModel: 'claude-critic',
        },
        purpose: ReviewTurnPurpose.Critic,
        maximumSemanticRiskPriority: 900_000,
      })
    ).toEqual({
      agent: claude,
      providerKind: ReviewAgentProviderKind.ClaudeCode,
      requestedModel: 'claude-critic',
    });
  });

  it('rejects an independent critic under the parent provider manifest', () => {
    const selector = new DeterministicReviewAgentSelector(
      [
        {
          providerKind: ReviewAgentProviderKind.Codex,
          agent: agent(),
        },
        {
          providerKind: ReviewAgentProviderKind.ClaudeCode,
          agent: agent(),
        },
      ],
      {
        allowedProviderKinds: [
          ReviewAgentProviderKind.Codex,
          ReviewAgentProviderKind.ClaudeCode,
        ],
        critic: {
          providerKind: ReviewAgentProviderKind.ClaudeCode,
          requestedModel: 'claude-critic',
        },
      }
    );

    expect(() =>
      selector.resolve({
        primaryProviderKind: ReviewAgentProviderKind.Codex,
        primaryRequestedModel: 'gpt-primary',
        purpose: ReviewTurnPurpose.Critic,
        maximumSemanticRiskPriority: 900_000,
      })
    ).toThrow('review_agent_critic_execution_authority_unavailable');
  });

  it('fails closed when a high-risk critic is configured on the primary provider', () => {
    const selector = new DeterministicReviewAgentSelector(
      [
        {
          providerKind: ReviewAgentProviderKind.Codex,
          agent: agent(),
        },
      ],
      {
        allowedProviderKinds: [ReviewAgentProviderKind.Codex],
        critic: {
          providerKind: ReviewAgentProviderKind.Codex,
          requestedModel: 'gpt-critic',
        },
        requireIndependentCriticAtOrAboveRiskPriority: 800_000,
      }
    );

    expect(() =>
      selector.resolve({
        primaryProviderKind: ReviewAgentProviderKind.Codex,
        primaryRequestedModel: 'gpt-primary',
        executionAuthority: {
          providerKind: ReviewAgentProviderKind.Codex,
          requestedModel: 'gpt-critic',
        },
        purpose: ReviewTurnPurpose.Critic,
        maximumSemanticRiskPriority: 800_000,
      })
    ).toThrow('review_agent_critic_execution_authority_unavailable');
  });

  it('allows a fresh same-provider critic below the independent threshold', () => {
    const codex = agent();
    const selector = new DeterministicReviewAgentSelector(
      [
        {
          providerKind: ReviewAgentProviderKind.Codex,
          agent: codex,
        },
      ],
      {
        allowedProviderKinds: [ReviewAgentProviderKind.Codex],
        critic: {
          providerKind: ReviewAgentProviderKind.Codex,
          requestedModel: 'gpt-critic',
        },
        requireIndependentCriticAtOrAboveRiskPriority: 800_000,
      }
    );

    expect(
      selector.resolve({
        primaryProviderKind: ReviewAgentProviderKind.Codex,
        primaryRequestedModel: 'gpt-primary',
        executionAuthority: {
          providerKind: ReviewAgentProviderKind.Codex,
          requestedModel: 'gpt-critic',
        },
        purpose: ReviewTurnPurpose.Critic,
        maximumSemanticRiskPriority: 799_999,
      })
    ).toMatchObject({
      agent: codex,
      providerKind: ReviewAgentProviderKind.Codex,
      requestedModel: 'gpt-critic',
    });
  });

  it('keeps a high-risk critic on the primary provider and model when independent policy is omitted', () => {
    const codex = agent();
    const selector = new DeterministicReviewAgentSelector(
      [
        {
          providerKind: ReviewAgentProviderKind.Codex,
          agent: codex,
        },
      ],
      { allowedProviderKinds: [ReviewAgentProviderKind.Codex] }
    );

    expect(
      selector.resolve({
        primaryProviderKind: ReviewAgentProviderKind.Codex,
        primaryRequestedModel: 'gpt-primary',
        purpose: ReviewTurnPurpose.Critic,
        maximumSemanticRiskPriority: 900_000,
      })
    ).toMatchObject({
      agent: codex,
      providerKind: ReviewAgentProviderKind.Codex,
      requestedModel: 'gpt-primary',
    });
  });

  it('rejects a critic provider omitted from the negotiated allowlist', () => {
    const selector = new DeterministicReviewAgentSelector(
      [
        {
          providerKind: ReviewAgentProviderKind.Codex,
          agent: agent(),
        },
        {
          providerKind: ReviewAgentProviderKind.ClaudeCode,
          agent: agent(),
        },
      ],
      {
        allowedProviderKinds: [ReviewAgentProviderKind.Codex],
        critic: {
          providerKind: ReviewAgentProviderKind.ClaudeCode,
          requestedModel: 'claude-critic',
        },
      }
    );

    expect(() =>
      selector.resolve({
        primaryProviderKind: ReviewAgentProviderKind.Codex,
        primaryRequestedModel: 'gpt-primary',
        purpose: ReviewTurnPurpose.Critic,
        maximumSemanticRiskPriority: 900_000,
      })
    ).toThrow('review_agent_provider_not_authorized');
  });
});

function agent(): ReviewAgentPort {
  return {
    negotiate: jest.fn(),
    executeTurn: jest.fn(),
    cancel: jest.fn(),
  };
}
