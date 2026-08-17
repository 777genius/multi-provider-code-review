import { applyCodexRotatingReviewRuntimeConfig } from '../../../src/codex-oauth/action';

describe('Codex OAuth rotating review runtime config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'github-request-token',
      ACTIONS_ID_TOKEN_REQUEST_URL:
        'https://token.actions.githubusercontent.com/request',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('forces OIDC runtime config and applies provider env before review config loads', async () => {
    const fetchImpl = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValueOnce(jsonResponse({ value: 'github-oidc-token' }))
      .mockResolvedValueOnce(jsonResponse({ sessionToken: 'rr-session' }))
      .mockResolvedValueOnce(
        jsonResponse({
          protocolVersion: 1,
          configVersion: 11,
          runtimeEnv: {
            REVIEW_PROVIDERS: 'codex/gpt-5.5,claude/sonnet',
            REQUIRED_HEALTHY_PROVIDERS: 'codex/gpt-5.5',
            PROVIDER_MAX_PARALLEL: '2',
            INLINE_MIN_AGREEMENT: '1',
          },
        })
      );

    await applyCodexRotatingReviewRuntimeConfig({
      apiUrl: 'https://api.reviewrouter.site',
      audience: 'reviewrouter',
      fetchImpl,
    });

    expect(process.env.REVIEWROUTER_RUNTIME_CONFIG_MODE).toBe('oidc');
    expect(process.env.REVIEWROUTER_API_URL).toBe(
      'https://api.reviewrouter.site'
    );
    expect(process.env.REVIEWROUTER_STATIC_CONFIG_FALLBACK).toBe('false');
    expect(process.env.REVIEW_PROVIDERS).toBe('codex/gpt-5.5,claude/sonnet');
    expect(process.env.PROVIDER_MAX_PARALLEL).toBe('2');
    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      'audience=reviewrouter'
    );
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    expect(process.env.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
    expect(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
  });

  it('fails closed instead of falling back to dynamic provider discovery', async () => {
    const fetchImpl = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockRejectedValueOnce(new Error('network_down'));

    await expect(
      applyCodexRotatingReviewRuntimeConfig({
        apiUrl: 'https://api.reviewrouter.site',
        audience: 'reviewrouter',
        fetchImpl,
      })
    ).rejects.toThrow('network_down');
    expect(process.env.REVIEW_PROVIDERS).toBeUndefined();
  });

  it('keeps static runtime config for the post-lease review child process', async () => {
    process.env = {
      REVIEWROUTER_RUNTIME_CONFIG_MODE: 'static',
      REVIEWROUTER_API_URL: 'https://api.reviewrouter.site',
      REVIEWROUTER_STATIC_CONFIG_FALLBACK: 'false',
      REVIEW_PROVIDERS: 'codex/gpt-5.5',
    };
    const fetchImpl = jest.fn<
      Promise<Response>,
      [RequestInfo | URL, RequestInit?]
    >();

    await applyCodexRotatingReviewRuntimeConfig({
      apiUrl: 'https://api.reviewrouter.site',
      audience: 'reviewrouter',
      fetchImpl,
    });

    expect(process.env.REVIEWROUTER_RUNTIME_CONFIG_MODE).toBe('static');
    expect(process.env.REVIEWROUTER_API_URL).toBe(
      'https://api.reviewrouter.site'
    );
    expect(process.env.REVIEWROUTER_STATIC_CONFIG_FALLBACK).toBe('false');
    expect(process.env.REVIEW_PROVIDERS).toBe('codex/gpt-5.5');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}
