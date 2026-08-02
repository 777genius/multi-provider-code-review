import {
  formatActionError,
  normalizeReviewError,
  ReviewRouterError,
  sanitizeErrorMessage,
} from '../../../src/errors/review-router-error';

describe('normalizeReviewError', () => {
  it('classifies reused Codex refresh tokens as stale OAuth', () => {
    const error = normalizeReviewError(
      new Error(
        'codex failed: refresh token has already been used; reseed auth.json'
      )
    );

    expect(error.code).toBe('codex_oauth_stale');
    expect(error.category).toBe('provider_auth');
    expect(error.isUserActionable).toBe(true);
    expect(error.nextSteps.join('\n')).toContain('Reseed `CODEX_AUTH_JSON`');
  });

  it('classifies missing Codex refresh_token as invalid secret', () => {
    const error = normalizeReviewError(
      new Error('CODEX_AUTH_JSON auth.json tokens.refresh_token is missing')
    );

    expect(error.code).toBe('codex_oauth_invalid_secret');
    expect(error.summary).toContain('Codex OAuth secret');
  });

  it('classifies missing Codex CLI', () => {
    const error = normalizeReviewError(new Error('spawn codex ENOENT'));

    expect(error.code).toBe('codex_cli_missing');
    expect(error.category).toBe('provider_runtime');
  });

  it('classifies OpenAI and OpenRouter API key failures separately', () => {
    expect(
      normalizeReviewError(new Error('OPENAI_API_KEY is missing')).code
    ).toBe('codex_api_key_invalid');
    expect(
      normalizeReviewError(
        new Error('OpenRouter API error: 401 unauthorized API key')
      ).code
    ).toBe('openrouter_api_key_invalid');
  });

  it('classifies GitHub permission and inline comment failures', () => {
    expect(
      normalizeReviewError(new Error('Resource not accessible by integration'))
        .code
    ).toBe('github_permission_denied');
    expect(
      normalizeReviewError(
        new Error(
          'Validation Failed: Unprocessable Entity when creating inline comment'
        )
      ).code
    ).toBe('github_inline_comment_failed');
  });

  it('classifies provider health failures', () => {
    expect(
      normalizeReviewError(
        new Error(
          'No healthy providers available; failing because FAIL_ON_NO_HEALTHY_PROVIDERS=true'
        )
      ).code
    ).toBe('no_healthy_providers');
    expect(
      normalizeReviewError(new Error('All LLM providers failed during review'))
        .code
    ).toBe('all_providers_failed');
    expect(
      normalizeReviewError(
        new Error(
          'Required healthy provider codex/gpt-5.5 was not available during provider selection.'
        )
      ).code
    ).toBe('required_provider_unhealthy');
  });

  it('classifies provider usage exhaustion inside an all-provider failure', () => {
    const error = normalizeReviewError(
      new Error(
        "All LLM providers failed during review; failing because FAIL_ON_NO_HEALTHY_PROVIDERS=true. codex/gpt-5.6-sol: Codex CLI failed with exit code 1: You've hit your usage limit. Visit [redacted-url] to purchase more credits or try again at Aug 8th, 2026 1:18 PM."
      )
    );

    expect(error.code).toBe('provider_capacity_limited');
    expect(error.category).toBe('provider_runtime');
    expect(error.isRetryable).toBe(true);
    expect(error.nextSteps).toEqual(
      expect.arrayContaining([
        'Wait for the provider limit to reset, then re-run the workflow.',
        'Switch to another configured provider with available quota or capacity.',
      ])
    );
    expect(error.nextSteps.join('\n').toLowerCase()).not.toContain('reseed');
  });

  it('does not treat a generic retry hint as provider capacity exhaustion', () => {
    expect(
      normalizeReviewError(
        new Error('All LLM providers failed; try again after reconnecting')
      ).code
    ).toBe('all_providers_failed');
  });

  it('keeps protocol and non-provider quota errors out of provider capacity', () => {
    expect(
      normalizeReviewError(
        new Error(
          'review_action_v2_protocol_error http_status=429 error_code=capacity_limited'
        )
      ).code
    ).toBe('control_plane_protocol_error');
    expect(
      normalizeReviewError(new Error('Filesystem quota exceeded')).code
    ).toBe('unknown');
  });

  it('classifies Review Action v2 protocol failures as control-plane errors', () => {
    const error = normalizeReviewError(
      new Error(
        'review_action_v2_protocol_error operation=review_run_authorize http_status=404 error_code=not_found issues=release_profile_unavailable'
      )
    );

    expect(error.code).toBe('control_plane_protocol_error');
    expect(error.category).toBe('control_plane');
    expect(error.isUserActionable).toBe(false);
    expect(error.safeMessage).toContain('issues=release_profile_unavailable');
  });

  it('wraps unknown errors while preserving stack and sanitized details', () => {
    const source = new Error(
      'boom OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz'
    );
    source.stack =
      'Error: boom OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz\n    at test';

    const error = normalizeReviewError(source);

    expect(error).toBeInstanceOf(ReviewRouterError);
    expect(error.code).toBe('codex_api_key_invalid');
    expect(error.stack).toContain('OPENAI_API_KEY=***');
    expect(error.stack).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(error.safeMessage).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
  });
});

describe('sanitizeErrorMessage', () => {
  it('redacts common secrets and tokens', () => {
    const sanitized = sanitizeErrorMessage(
      [
        'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz',
        'OPENROUTER_API_KEY=or-secret-value-1234567890',
        'refresh_token: secret-refresh-token-value',
        'access_token: access-secret-token-value',
        'Authorization: Bearer ghp_secretsecretsecretsecret',
        '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
      ].join('\n')
    );

    expect(sanitized).toContain('OPENAI_API_KEY=***');
    expect(sanitized).toContain('OPENROUTER_API_KEY=***');
    expect(sanitized).toContain('refresh_token: ***');
    expect(sanitized).toContain('access_token: ***');
    expect(sanitized).toContain('Authorization: Bearer ***');
    expect(sanitized).toContain(
      '-----BEGIN PRIVATE KEY-----***-----END PRIVATE KEY-----'
    );
    expect(sanitized).not.toContain('secret-refresh-token-value');
    expect(sanitized).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
  });
});

describe('formatActionError', () => {
  it('formats compact actionable action failure text', () => {
    const formatted = formatActionError(
      new Error('CODEX_AUTH_JSON auth.json tokens.refresh_token is missing')
    );

    expect(formatted).toContain('Review failed [codex_oauth_invalid_secret]');
    expect(formatted).toContain('How to fix:');
    expect(formatted).toContain('User action required: yes');
  });
});
