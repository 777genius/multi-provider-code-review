import { resolveProviderCliPlan } from '../../../src/control-plane/provider-cli-plan';

describe('resolveProviderCliPlan', () => {
  it('requires Codex CLI for Codex OAuth runtime config', () => {
    const plan = resolveProviderCliPlan({
      REVIEW_AUTH_MODE: 'codex-oauth',
    });

    expect(plan.codexCliNeeded).toBe(true);
    expect(plan.codexOauthNeeded).toBe(true);
  });

  it('requires Codex CLI for OpenAI API-key runtime config', () => {
    const plan = resolveProviderCliPlan({
      REVIEW_AUTH_MODE: 'openai-api',
      REVIEW_PROVIDERS: 'codex/gpt-5.6-sol',
      CODEX_AUTH_JSON_PRESENT: '1',
    });

    expect(plan.codexCliNeeded).toBe(true);
    expect(plan.codexOauthNeeded).toBe(false);
  });

  it('restores legacy Codex OAuth when its secret is available', () => {
    const plan = resolveProviderCliPlan({
      REVIEW_PROVIDERS: 'codex/gpt-5.6-sol',
      CODEX_AUTH_JSON_PRESENT: '1',
    });

    expect(plan.codexCliNeeded).toBe(true);
    expect(plan.codexOauthNeeded).toBe(true);
  });

  it('requires Claude CLI for Claude OAuth runtime config', () => {
    const plan = resolveProviderCliPlan({
      REVIEW_AUTH_MODE: 'claude-oauth',
    });

    expect(plan.claudeCliNeeded).toBe(true);
    expect(plan.codexCliNeeded).toBe(false);
    expect(plan.codexOauthNeeded).toBe(false);
  });

  it('detects explicit provider lists and synthesis models', () => {
    const plan = resolveProviderCliPlan({
      REVIEW_PROVIDERS: 'openrouter/free, claude/sonnet',
      SYNTHESIS_MODEL: 'codex/gpt-5.5',
    });

    expect(plan.codexCliNeeded).toBe(true);
    expect(plan.codexOauthNeeded).toBe(false);
    expect(plan.claudeCliNeeded).toBe(true);
  });

  it('does not let stale static model env override explicit runtime providers', () => {
    const plan = resolveProviderCliPlan({
      REVIEW_AUTH_MODE: 'codex-oauth',
      REVIEW_PROVIDERS: 'codex/gpt-5.5',
      SYNTHESIS_MODEL: 'codex/gpt-5.5',
      CLAUDE_MODEL: 'sonnet',
    });

    expect(plan.codexCliNeeded).toBe(true);
    expect(plan.codexOauthNeeded).toBe(true);
    expect(plan.claudeCliNeeded).toBe(false);
  });

  it('requires Codex CLI but not Codex OAuth for OpenRouter config', () => {
    const plan = resolveProviderCliPlan({
      REVIEW_AUTH_MODE: 'openrouter-api',
      REVIEW_PROVIDERS: 'openrouter/anthropic/claude-sonnet-4.5',
      SYNTHESIS_MODEL: 'openrouter/anthropic/claude-sonnet-4.5',
      CODEX_AUTH_JSON_PRESENT: '1',
    });

    expect(plan.codexCliNeeded).toBe(true);
    expect(plan.codexOauthNeeded).toBe(false);
    expect(plan.claudeCliNeeded).toBe(false);
  });
});
