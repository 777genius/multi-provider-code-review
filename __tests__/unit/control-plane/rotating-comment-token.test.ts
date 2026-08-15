import { createRotatingCommentTokenProvider } from '../../../src/control-plane/rotating-comment-token';

const now = Date.parse('2026-07-16T12:00:00.000Z');
const supportedModes = ['codex-oauth-rotating', 'hosted-relay'] as const;
const baseEnv = {
  REVIEWROUTER_COMMENT_TOKEN_MODE: 'codex-oauth-rotating',
  REVIEWROUTER_COMMENT_TOKEN_REFRESH_URL:
    'https://reviewrouter.test/api/action/v1/codex-oauth/comment-token',
  REVIEWROUTER_COMMENT_TOKEN_LEASE_ID: 'lease_123',
  REVIEWROUTER_COMMENT_TOKEN_PROVIDER_INSTANCE_ID: 'provider_123',
  REVIEWROUTER_REPOSITORY_FULL_NAME: '777genius/agent-teams-ai',
};

describe('rotating comment token provider', () => {
  it('rejects unknown comment token modes', () => {
    expect(
      createRotatingCommentTokenProvider({
        initialToken: 'ghs_initial',
        env: {
          ...baseEnv,
          REVIEWROUTER_COMMENT_TOKEN_MODE: 'unknown-mode',
        },
      })
    ).toBeUndefined();
  });

  it('keeps a valid token without control-plane traffic', async () => {
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    const provider = createRotatingCommentTokenProvider({
      initialToken: 'ghs_initial',
      env: {
        ...baseEnv,
        REVIEWROUTER_COMMENT_TOKEN_EXPIRES_AT: '2026-07-16T13:00:00.000Z',
      },
      fetchImpl,
      now: () => now,
    });

    await expect(provider?.getToken()).resolves.toBe('ghs_initial');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(supportedModes)(
    'refreshes near expiry once for concurrent callers in %s mode',
    async (mode) => {
      const onToken = jest.fn();
      const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
      fetchImpl.mockResolvedValue(
        jsonResponse({
          protocolVersion: 1,
          token: 'ghs_refreshed',
          expiresAt: '2026-07-16T14:00:00.000Z',
          repository: '777genius/agent-teams-ai',
        })
      );
      const provider = createRotatingCommentTokenProvider({
        initialToken: 'ghs_initial',
        env: {
          ...baseEnv,
          REVIEWROUTER_COMMENT_TOKEN_MODE: mode,
          REVIEWROUTER_COMMENT_TOKEN_EXPIRES_AT: '2026-07-16T12:04:00.000Z',
        },
        fetchImpl,
        now: () => now,
        onToken,
      })!;

      await expect(
        Promise.all([provider.getToken(), provider.getToken()])
      ).resolves.toEqual(['ghs_refreshed', 'ghs_refreshed']);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(onToken).toHaveBeenCalledWith('ghs_refreshed');
      expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
        leaseId: 'lease_123',
        providerInstanceId: 'provider_123',
        authCleared: true,
      });
    }
  );

  it('keeps an unexpired token when proactive refresh is transiently unavailable', async () => {
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockRejectedValue(new Error('network_unavailable'));
    const provider = createRotatingCommentTokenProvider({
      initialToken: 'ghs_initial',
      env: {
        ...baseEnv,
        REVIEWROUTER_COMMENT_TOKEN_EXPIRES_AT: '2026-07-16T12:04:00.000Z',
      },
      fetchImpl,
      now: () => now,
    })!;

    await expect(provider.getToken()).resolves.toBe('ghs_initial');
    await expect(provider.getToken()).resolves.toBe('ghs_initial');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a refreshed token for another repository', async () => {
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockResolvedValue(
      jsonResponse({
        protocolVersion: 1,
        token: 'ghs_wrong_repository',
        expiresAt: '2026-07-16T14:00:00.000Z',
        repository: 'attacker/repository',
      })
    );
    const provider = createRotatingCommentTokenProvider({
      initialToken: 'ghs_initial',
      env: baseEnv,
      fetchImpl,
      now: () => now,
    })!;

    await expect(provider.getToken()).rejects.toThrow(
      'rotating_comment_token_repository_mismatch'
    );
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
