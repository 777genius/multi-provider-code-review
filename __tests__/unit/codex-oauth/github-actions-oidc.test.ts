import {
  clearGitHubActionsOidcRequestEnv,
  GitHubActionsOidcTokenProvider,
  parseTrustedGitHubActionsOidcUrl,
} from '../../../src/codex-oauth/github-actions-oidc';

describe('GitHubActionsOidcTokenProvider', () => {
  it.each([
    'http://token.actions.githubusercontent.com/request',
    'https://actions.githubusercontent.com/request',
    'https://token.actions.githubusercontent.com.attacker.example/request',
    'https://user@token.actions.githubusercontent.com/request',
    'https://token.actions.githubusercontent.com:444/request',
  ])('rejects the untrusted URL %s', (requestUrl) => {
    expect(() => parseTrustedGitHubActionsOidcUrl(requestUrl)).toThrow(
      'github_oidc_url_untrusted'
    );
  });

  it('retains credentials for same-run refreshes after env cleanup', async () => {
    const env: NodeJS.ProcessEnv = {
      ACTIONS_ID_TOKEN_REQUEST_URL:
        'https://token.actions.githubusercontent.com/request',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'github-request-token',
    };
    const fetchImpl = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValueOnce(jsonResponse({ value: 'oidc-token-1' }))
      .mockResolvedValueOnce(jsonResponse({ value: 'oidc-token-2' }));
    const provider = new GitHubActionsOidcTokenProvider({ env, fetchImpl });

    await expect(provider.requestToken('reviewrouter')).resolves.toBe(
      'oidc-token-1'
    );
    clearGitHubActionsOidcRequestEnv(env);
    expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
    expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
    await expect(provider.requestToken('reviewrouter-refresh')).resolves.toBe(
      'oidc-token-2'
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    expect(String(fetchImpl.mock.calls[1][0])).toContain(
      'audience=reviewrouter-refresh'
    );
  });
});

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}
