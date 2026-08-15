import { GitHubTokenProvider } from '../github/token-provider';

const rotatingCommentTokenModes = new Set([
  'codex-oauth-rotating',
  'hosted-relay',
]);
const tokenRefreshLeadTimeMs = 5 * 60 * 1000;
const tokenRefreshRetryDelayMs = 30 * 1000;
const tokenRequestTimeoutMs = 30_000;

type RotatingCommentTokenResponse = {
  readonly protocolVersion: 1;
  readonly token: string;
  readonly expiresAt: string;
  readonly repository: string;
};

export function createRotatingCommentTokenProvider(input: {
  readonly initialToken: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly onToken?: (token: string) => void;
}): GitHubTokenProvider | undefined {
  const env = input.env ?? process.env;
  if (
    !rotatingCommentTokenModes.has(env.REVIEWROUTER_COMMENT_TOKEN_MODE ?? '')
  ) {
    return undefined;
  }

  const refreshUrl = requireEnvironmentValue(
    env,
    'REVIEWROUTER_COMMENT_TOKEN_REFRESH_URL'
  );
  assertSafeRefreshUrl(refreshUrl);
  const leaseId = requireEnvironmentValue(
    env,
    'REVIEWROUTER_COMMENT_TOKEN_LEASE_ID'
  );
  const providerInstanceId = requireEnvironmentValue(
    env,
    'REVIEWROUTER_COMMENT_TOKEN_PROVIDER_INSTANCE_ID'
  );
  const repository = requireEnvironmentValue(
    env,
    'REVIEWROUTER_REPOSITORY_FULL_NAME'
  );
  const initialExpiresAt = parseExpiry(
    env.REVIEWROUTER_COMMENT_TOKEN_EXPIRES_AT
  );

  return new RotatingCommentTokenProvider({
    initialToken: input.initialToken,
    initialExpiresAt,
    refreshUrl,
    leaseId,
    providerInstanceId,
    repository,
    fetchImpl: input.fetchImpl ?? fetch,
    now: input.now ?? Date.now,
    onToken: input.onToken,
  });
}

class RotatingCommentTokenProvider implements GitHubTokenProvider {
  private token: string;
  private expiresAt: number;
  private refreshRetryAt = 0;
  private refreshInFlight: Promise<string> | undefined;

  constructor(
    private readonly input: {
      readonly initialToken: string;
      readonly initialExpiresAt: number;
      readonly refreshUrl: string;
      readonly leaseId: string;
      readonly providerInstanceId: string;
      readonly repository: string;
      readonly fetchImpl: typeof fetch;
      readonly now: () => number;
      readonly onToken?: ((token: string) => void) | undefined;
    }
  ) {
    this.token = input.initialToken;
    this.expiresAt = input.initialExpiresAt;
  }

  async getToken(): Promise<string> {
    const now = this.input.now();
    if (
      now + tokenRefreshLeadTimeMs < this.expiresAt ||
      (now < this.expiresAt && now < this.refreshRetryAt)
    ) {
      return this.token;
    }
    try {
      return await this.refreshToken();
    } catch (error) {
      if (this.input.now() < this.expiresAt) {
        this.refreshRetryAt = this.input.now() + tokenRefreshRetryDelayMs;
        return this.token;
      }
      throw error;
    }
  }

  refreshToken(): Promise<string> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.issueToken().finally(() => {
        this.refreshInFlight = undefined;
      });
    }
    return this.refreshInFlight;
  }

  private async issueToken(): Promise<string> {
    const response = await this.input.fetchImpl(this.input.refreshUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        leaseId: this.input.leaseId,
        providerInstanceId: this.input.providerInstanceId,
        authCleared: true,
      }),
      signal: AbortSignal.timeout(tokenRequestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `rotating_comment_token_refresh_failed:${response.status}`
      );
    }
    const refreshed = parseResponse(await response.json());
    if (refreshed.repository !== this.input.repository) {
      throw new Error('rotating_comment_token_repository_mismatch');
    }
    const expiresAt = parseExpiry(refreshed.expiresAt);
    if (expiresAt <= this.input.now()) {
      throw new Error('rotating_comment_token_expiry_invalid');
    }
    this.token = refreshed.token;
    this.expiresAt = expiresAt;
    this.refreshRetryAt = 0;
    this.input.onToken?.(refreshed.token);
    return refreshed.token;
  }
}

function parseResponse(value: unknown): RotatingCommentTokenResponse {
  if (!value || typeof value !== 'object') {
    throw new Error('rotating_comment_token_response_invalid');
  }
  const response = value as Partial<RotatingCommentTokenResponse>;
  if (
    response.protocolVersion !== 1 ||
    typeof response.token !== 'string' ||
    response.token.length === 0 ||
    typeof response.expiresAt !== 'string' ||
    typeof response.repository !== 'string' ||
    response.repository.length === 0
  ) {
    throw new Error('rotating_comment_token_response_invalid');
  }
  return response as RotatingCommentTokenResponse;
}

function parseExpiry(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function requireEnvironmentValue(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`rotating_comment_token_environment_missing:${key}`);
  }
  return value;
}

function assertSafeRefreshUrl(value: string): void {
  const url = new URL(value);
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('rotating_comment_token_refresh_url_insecure');
  }
}
