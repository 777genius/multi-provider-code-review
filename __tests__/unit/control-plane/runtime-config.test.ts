import { applyControlPlaneRuntimeConfig } from '../../../src/control-plane/runtime-config';
import { readProductionReviewInvestigationRolloutFlags } from '../../../src/review-orchestration/infrastructure/production-review-investigation-composition';

describe('applyControlPlaneRuntimeConfig', () => {
  const baseEnv = {
    REVIEWROUTER_RUNTIME_CONFIG_MODE: 'oidc',
    REVIEWROUTER_API_URL: 'https://app.reviewrouter.dev',
    REVIEWROUTER_OIDC_AUDIENCE: 'reviewrouter',
    REVIEWROUTER_STATIC_CONFIG_FALLBACK: 'true',
    REVIEWROUTER_ACTION_VERSION: 'v1.0.6',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'github-request-token',
    ACTIONS_ID_TOKEN_REQUEST_URL:
      'https://token.actions.githubusercontent.com/request',
    CODEX_MODEL: 'static-model',
  };

  it('skips when OIDC runtime config mode is not enabled', async () => {
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      REVIEWROUTER_RUNTIME_CONFIG_MODE: 'static',
    };
    const fetchImpl = jest.fn();

    await expect(
      applyControlPlaneRuntimeConfig({ env, fetchImpl })
    ).resolves.toEqual({ status: 'skipped' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches runtime config through GitHub OIDC and applies safe env values', async () => {
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    const fetchImpl = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValueOnce(jsonResponse({ value: 'github-oidc-token' }))
      .mockResolvedValueOnce(jsonResponse({ sessionToken: 'rr-session' }))
      .mockResolvedValueOnce(
        jsonResponse({
          protocolVersion: 1,
          configVersion: 7,
          runtimeEnv: {
            CODEX_MODEL: 'gpt-5.5',
            CODEX_REASONING_EFFORT: 'medium',
            REVIEW_AUTH_MODE: 'codex-oauth',
            REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED: '1',
            REVIEW_ROUTER_REVIEW_INVESTIGATION_SHADOW_ENABLED: '1',
            REVIEW_ROUTER_REVIEW_INVESTIGATION_CONTEXT_CRITIC_ENABLED: '1',
            REVIEW_ROUTER_REVIEW_INVESTIGATION_CROSS_REVISION_REPLAY_ENABLED:
              '1',
          },
        })
      );

    const result = await applyControlPlaneRuntimeConfig({ env, fetchImpl });

    expect(result).toEqual({
      status: 'applied',
      apiUrl: 'https://app.reviewrouter.dev',
      actionVersion: 'v1.0.6',
      configVersion: 7,
      sessionToken: 'rr-session',
    });
    expect(env.CODEX_MODEL).toBe('gpt-5.5');
    expect(env.CODEX_REASONING_EFFORT).toBe('medium');
    expect(env.REVIEW_AUTH_MODE).toBe('codex-oauth');
    expect(readProductionReviewInvestigationRolloutFlags(env)).toMatchObject({
      recordingEnabled: true,
      shadowEnabled: true,
      contextCriticEnabled: true,
      crossRevisionReplayEnabled: true,
    });
    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      'audience=reviewrouter'
    );
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
    });
    expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
    expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
    expect(fetchImpl.mock.calls[2][1]?.headers).toMatchObject({
      Authorization: 'Bearer rr-session',
      'x-reviewrouter-action-version': 'v1.0.6',
    });
  });

  it('applies the ultra timeout fallback after dynamic config resolution', async () => {
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    delete env.RUN_TIMEOUT_SECONDS;
    const fetchImpl = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValueOnce(jsonResponse({ value: 'github-oidc-token' }))
      .mockResolvedValueOnce(jsonResponse({ sessionToken: 'rr-session' }))
      .mockResolvedValueOnce(
        jsonResponse({
          protocolVersion: 1,
          configVersion: 8,
          runtimeEnv: {
            CODEX_MODEL: 'gpt-5.6-sol',
            CODEX_REASONING_EFFORT: 'ultra',
            REVIEW_PROVIDERS: 'codex/gpt-5.6-sol',
            SYNTHESIS_MODEL: 'codex/gpt-5.6-sol',
          },
        })
      );

    await applyControlPlaneRuntimeConfig({ env, fetchImpl });

    expect(env.RUN_TIMEOUT_SECONDS).toBe('1800');
  });

  it.each([
    {
      name: 'an explicit workflow timeout',
      initialTimeout: '900',
      runtimeTimeout: undefined,
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      expectedTimeout: '900',
    },
    {
      name: 'an authoritative server timeout',
      initialTimeout: '900',
      runtimeTimeout: '1200',
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      expectedTimeout: '1200',
    },
    {
      name: 'a blank authoritative server timeout',
      initialTimeout: undefined,
      runtimeTimeout: '  ',
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      expectedTimeout: '  ',
    },
    {
      name: 'another model',
      initialTimeout: undefined,
      runtimeTimeout: undefined,
      model: 'gpt-5.5',
      effort: 'ultra',
      expectedTimeout: undefined,
    },
    {
      name: 'another effort',
      initialTimeout: undefined,
      runtimeTimeout: undefined,
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      expectedTimeout: undefined,
    },
  ])('preserves $name', async (testCase) => {
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      ...(testCase.initialTimeout
        ? { RUN_TIMEOUT_SECONDS: testCase.initialTimeout }
        : {}),
    };
    const runtimeEnv = {
      CODEX_MODEL: testCase.model,
      CODEX_REASONING_EFFORT: testCase.effort,
      ...(testCase.runtimeTimeout !== undefined
        ? { RUN_TIMEOUT_SECONDS: testCase.runtimeTimeout }
        : {}),
    };
    const fetchImpl = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValueOnce(jsonResponse({ value: 'github-oidc-token' }))
      .mockResolvedValueOnce(jsonResponse({ sessionToken: 'rr-session' }))
      .mockResolvedValueOnce(
        jsonResponse({ protocolVersion: 1, configVersion: 8, runtimeEnv })
      );

    await applyControlPlaneRuntimeConfig({ env, fetchImpl });

    expect(env.RUN_TIMEOUT_SECONDS).toBe(testCase.expectedTimeout);
  });

  it('falls back to static workflow env when config fetch is unavailable', async () => {
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    const warnings: string[] = [];
    const fetchImpl = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockRejectedValueOnce(new Error('network_down'));

    const result = await applyControlPlaneRuntimeConfig({
      env,
      fetchImpl,
      logger: { info: jest.fn(), warn: (message) => warnings.push(message) },
    });

    expect(result).toEqual({ status: 'fallback', reason: 'network_down' });
    expect(env.CODEX_MODEL).toBe('static-model');
    expect(warnings[0]).toContain('using static workflow config');
    expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
    expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
  });

  it('rejects an untrusted GitHub Actions OIDC request URL before fetch', async () => {
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      REVIEWROUTER_STATIC_CONFIG_FALLBACK: 'false',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://attacker.example/oidc',
    };
    const fetchImpl = jest.fn<
      Promise<Response>,
      [RequestInfo | URL, RequestInit?]
    >();

    await expect(
      applyControlPlaneRuntimeConfig({ env, fetchImpl })
    ).rejects.toThrow('codex_oauth_oidc_url_untrusted');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
    expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
  });

  it('blocks redirect following before an OIDC bearer can leak', async () => {
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      REVIEWROUTER_STATIC_CONFIG_FALLBACK: 'false',
    };
    let leakedAuthorization = false;
    const fetchImpl = jest.fn(
      async (
        _url: RequestInfo | URL,
        init?: RequestInit
      ): Promise<Response> => {
        if (init?.redirect !== 'error') {
          leakedAuthorization = Boolean(
            (init?.headers as Record<string, string> | undefined)?.authorization
          );
          return jsonResponse({ value: 'attacker-controlled-token' });
        }
        throw new TypeError('redirect mode is error');
      }
    );

    await expect(
      applyControlPlaneRuntimeConfig({ env, fetchImpl })
    ).rejects.toThrow('redirect mode is error');
    expect(leakedAuthorization).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
    expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
  });

  it('includes safe OIDC exchange error codes in fallback warnings', async () => {
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    const warnings: string[] = [];
    const fetchImpl = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValueOnce(jsonResponse({ value: 'github-oidc-token' }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 'repository_not_selected',
              message: 'Repository is not selected in ReviewRouter.',
            },
          },
          403
        )
      );

    const result = await applyControlPlaneRuntimeConfig({
      env,
      fetchImpl,
      logger: { info: jest.fn(), warn: (message) => warnings.push(message) },
    });

    expect(result).toEqual({
      status: 'fallback',
      reason: 'action_session_exchange_failed:403:repository_not_selected',
    });
    expect(warnings[0]).toContain(
      'action_session_exchange_failed:403:repository_not_selected'
    );
  });

  it('does not fall back when the installed action version is blocked', async () => {
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    const fetchImpl = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValueOnce(jsonResponse({ value: 'github-oidc-token' }))
      .mockResolvedValueOnce(jsonResponse({ sessionToken: 'rr-session' }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 'action_version_blocked',
              message: 'blocked',
              retryable: false,
            },
          },
          426
        )
      );

    await expect(
      applyControlPlaneRuntimeConfig({ env, fetchImpl })
    ).rejects.toThrow('Installed ReviewRouter Action version is blocked');
  });

  it('ignores unsafe runtime env keys without losing the OIDC session', async () => {
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    const warnings: string[] = [];
    const fetchImpl = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValueOnce(jsonResponse({ value: 'github-oidc-token' }))
      .mockResolvedValueOnce(jsonResponse({ sessionToken: 'rr-session' }))
      .mockResolvedValueOnce(
        jsonResponse({
          protocolVersion: 1,
          configVersion: 7,
          runtimeEnv: {
            CODEX_MODEL: 'gpt-5.5',
            TARGET_TOKENS_PER_BATCH: '50000',
            OPENAI_API_KEY: 'must-not-be-sent-by-control-plane',
          },
        })
      );

    await expect(
      applyControlPlaneRuntimeConfig({
        env,
        fetchImpl,
        logger: { info: jest.fn(), warn: (message) => warnings.push(message) },
      })
    ).resolves.toMatchObject({
      status: 'applied',
      sessionToken: 'rr-session',
    });
    expect(env.CODEX_MODEL).toBe('gpt-5.5');
    expect(env.TARGET_TOKENS_PER_BATCH).toBe('50000');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(warnings[0]).toContain('OPENAI_API_KEY');
    expect(warnings[0]).not.toContain('TARGET_TOKENS_PER_BATCH');
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}
