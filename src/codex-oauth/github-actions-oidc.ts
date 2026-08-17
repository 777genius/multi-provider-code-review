import * as core from '../actions/core';

export type GitHubActionsOidcTokenProviderOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};

export class GitHubActionsOidcTokenProvider {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private requestCredentials:
    | { readonly requestToken: string; readonly requestUrl: string }
    | undefined;

  constructor(options: GitHubActionsOidcTokenProviderOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async requestToken(audience: string): Promise<string> {
    const { requestToken, requestUrl: requestUrlValue } =
      this.readRequestCredentials();
    const requestUrl = parseTrustedGitHubActionsOidcUrl(
      requestUrlValue,
      'codex_oauth_oidc_url_untrusted'
    );
    requestUrl.searchParams.set('audience', audience);
    core.setSecret(requestToken);

    const response = await this.fetchImpl(requestUrl.toString(), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${requestToken}`,
      },
      redirect: 'error',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        `codex_oauth_oidc_http_error:${response.status}:${safeOidcErrorCode(payload)}`
      );
    }

    const token =
      payload && typeof payload === 'object' && 'value' in payload
        ? (payload as { value?: unknown }).value
        : undefined;
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('codex_oauth_oidc_invalid_response');
    }
    core.setSecret(token);
    return token;
  }

  private readRequestCredentials(): {
    readonly requestToken: string;
    readonly requestUrl: string;
  } {
    if (this.requestCredentials) return this.requestCredentials;
    this.requestCredentials = {
      requestToken: requireEnv(this.env, 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'),
      requestUrl: requireEnv(this.env, 'ACTIONS_ID_TOKEN_REQUEST_URL'),
    };
    return this.requestCredentials;
  }
}

export function parseTrustedGitHubActionsOidcUrl(
  value: string,
  errorCode = 'github_oidc_url_untrusted'
): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(errorCode);
  }
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname.endsWith('.actions.githubusercontent.com') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== ''
  ) {
    throw new Error(errorCode);
  }
  return parsed;
}

export function clearGitHubActionsOidcRequestEnv(
  env: NodeJS.ProcessEnv = process.env
): void {
  delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`codex_oauth_missing_${key}`);
  }
  return value;
}

function safeOidcErrorCode(payload: unknown): string {
  if (
    payload &&
    typeof payload === 'object' &&
    'message' in payload &&
    typeof (payload as { message?: unknown }).message === 'string'
  ) {
    return 'oidc_request_failed';
  }
  return 'unknown_oidc_error';
}
