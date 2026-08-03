import * as core from '../actions/core';
import * as fs from 'fs';
import { Octokit } from '@octokit/rest';
import { GitHubRateLimitTracker } from './rate-limit';
import { GitHubTokenProvider } from './token-provider';

export class GitHubClient {
  public readonly octokit: Octokit;
  public readonly owner: string;
  public readonly repo: string;
  private readonly rateLimitTracker = new GitHubRateLimitTracker();

  constructor(
    token: string,
    options: {
      readonly tokenProvider?: GitHubTokenProvider;
      readonly sleep?: (delayMs: number) => Promise<void>;
    } = {}
  ) {
    this.octokit = createResilientOctokit(
      token,
      options.tokenProvider,
      options.sleep
    );

    // Prefer the explicit Actions env var, then fall back to the event payload.
    const repoEnv =
      process.env.GITHUB_REPOSITORY || getRepositoryFromEventPayload() || '/';

    const [owner, repo] = repoEnv.split('/');
    this.owner = owner || '';
    this.repo = repo || '';

    core.debug(`GitHub client initialized for ${this.owner}/${this.repo}`);
  }

  /**
   * Get current GitHub API rate limit status
   */
  getRateLimitStatus() {
    return this.rateLimitTracker.getStatus();
  }

  /**
   * Check if we're approaching rate limit and log warning
   */
  checkRateLimitStatus(): void {
    if (this.rateLimitTracker.isApproachingLimit()) {
      const status = this.rateLimitTracker.getStatus();
      core.warning(
        `Approaching GitHub API rate limit: ${status?.remaining}/${status?.limit} remaining`
      );
    }
  }

  /**
   * Implement exponential backoff when approaching rate limit
   * Returns delay in milliseconds to wait before making next API call
   */
  private calculateBackoffDelay(): number {
    const status = this.rateLimitTracker.getStatus();
    if (!status) return 0;

    const percentRemaining = (status.remaining / status.limit) * 100;

    // No delay if plenty of requests remaining (>25%)
    if (percentRemaining > 25) {
      return 0;
    }

    // Progressive backoff as we approach limit:
    // 25% remaining: 100ms delay
    // 10% remaining: 500ms delay
    // 5% remaining: 1000ms delay
    // 1% remaining: 2000ms delay
    if (percentRemaining > 10) {
      return 100;
    } else if (percentRemaining > 5) {
      return 500;
    } else if (percentRemaining > 1) {
      return 1000;
    } else {
      return 2000;
    }
  }

  /**
   * Throttle requests when approaching rate limit
   */
  private async throttleIfNeeded(): Promise<void> {
    const delay = this.calculateBackoffDelay();
    if (delay > 0) {
      const status = this.rateLimitTracker.getStatus();
      core.debug(
        `Throttling GitHub API request (${delay}ms delay, ${status?.remaining} requests remaining)`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /**
   * Wait for rate limit to reset if exceeded
   */
  private async handleRateLimit(): Promise<void> {
    if (this.rateLimitTracker.isExceeded()) {
      await this.rateLimitTracker.waitForReset();
    }
  }

  /**
   * Fetch file content from a specific ref (commit SHA, branch, or tag)
   * @param filePath - Path to the file in the repository
   * @param ref - Git ref (commit SHA, branch name, or tag)
   * @returns File content as string, or null if file doesn't exist/inaccessible
   */
  async getFileContent(filePath: string, ref: string): Promise<string | null> {
    // Wait if rate limit is exceeded
    await this.handleRateLimit();

    // Throttle requests if approaching limit (exponential backoff)
    await this.throttleIfNeeded();

    try {
      const response = await this.octokit.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: filePath,
        ref,
      });

      // Update rate limit tracker from response headers
      // Validate headers structure before passing to rate limit tracker
      if (
        response.headers &&
        typeof response.headers === 'object' &&
        !Array.isArray(response.headers)
      ) {
        // Convert headers to Record<string, string | undefined> for type safety
        // Octokit headers are typed as { [header: string]: string | number | undefined }
        const headers: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          headers[key] = value !== undefined ? String(value) : undefined;
        }
        this.rateLimitTracker.updateFromHeaders(headers);
      }

      // Check if the response is a file (not a directory)
      if ('content' in response.data && !Array.isArray(response.data)) {
        // Handle empty content or encoding "none" for large files
        if (
          !response.data.content ||
          response.data.content === '' ||
          response.data.encoding === 'none'
        ) {
          // File is empty or too large
          core.debug(`File content empty or encoding 'none': ${filePath}`);
          return '';
        }
        // Content is base64 encoded
        return Buffer.from(response.data.content, 'base64').toString('utf-8');
      }

      return null;
    } catch (error) {
      const err = error as { status?: number };
      if (err.status === 404) {
        // File not found - this is expected for new files in PRs
        core.debug(`File not found: ${filePath} at ref ${ref}`);
        return null;
      }
      // Log other errors but don't throw - gracefully degrade
      core.warning(
        `Failed to fetch file content for ${filePath}: ${(error as Error).message}`
      );
      return null;
    }
  }
}

function createResilientOctokit(
  initialToken: string,
  tokenProvider?: GitHubTokenProvider,
  sleep: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs))
): Octokit {
  const octokit = new Octokit();
  octokit.hook.wrap('request', async (request, options) => {
    const requestWithToken = (token: string) => {
      options.headers.authorization = tokenProvider
        ? `Bearer ${token}`
        : `token ${token}`;
      return request(options);
    };
    let token = tokenProvider ? await tokenProvider.getToken() : initialToken;
    let authRefreshAttempted = false;
    let transientFailures = 0;

    for (;;) {
      try {
        return await requestWithToken(token);
      } catch (error) {
        const status = getHttpStatus(error);
        if (status === 401 && tokenProvider && !authRefreshAttempted) {
          token = await tokenProvider.refreshToken();
          authRefreshAttempted = true;
          continue;
        }
        if (
          isSafeRetryMethod(options.method) &&
          isTransientGitHubRequestError(error) &&
          transientFailures < 2
        ) {
          const delayMs = githubRetryDelayMs(error, transientFailures);
          if (delayMs === undefined) throw error;
          transientFailures += 1;
          await sleep(delayMs);
          continue;
        }
        throw error;
      }
    }
  });
  return octokit;
}

function getHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

const MAX_GITHUB_RETRY_DELAY_MS = 10_000;
const TRANSIENT_GITHUB_NETWORK_ERROR_CODES = [
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
] as const;

function isSafeRetryMethod(method: unknown): boolean {
  return (
    typeof method === 'string' &&
    ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
  );
}

function isTransientGitHubRequestError(error: unknown): boolean {
  const status = getHttpStatus(error);
  if (
    status === 408 ||
    status === 429 ||
    (status !== undefined && status >= 500 && status <= 599)
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : undefined;
  if (
    status === 403 &&
    typeof message === 'string' &&
    /rate limit|secondary rate limit|abuse detection/i.test(message)
  ) {
    return true;
  }
  return hasTransientNetworkErrorCode(error);
}

function githubRetryDelayMs(
  error: unknown,
  transientFailures: number
): number | undefined {
  const serverDelayMs = githubServerRetryDelayMs(error);
  if (serverDelayMs !== undefined) {
    return serverDelayMs <= MAX_GITHUB_RETRY_DELAY_MS
      ? serverDelayMs
      : undefined;
  }
  return transientFailures === 0 ? 250 : 1_000;
}

function githubServerRetryDelayMs(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const response = readOwnDataProperty(error, 'response');
  if (!response || typeof response !== 'object') return undefined;
  const headers = readOwnDataProperty(response, 'headers');
  if (!headers || typeof headers !== 'object') return undefined;

  const retryAfter = readHeader(headers, 'retry-after');
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1_000);
    }
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now());
  }

  const reset = readHeader(headers, 'x-ratelimit-reset');
  const resetSeconds = reset === undefined ? NaN : Number(reset);
  return Number.isFinite(resetSeconds)
    ? Math.max(0, Math.ceil(resetSeconds * 1_000 - Date.now()))
    : undefined;
}

function readHeader(headers: object, expectedName: string): string | undefined {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== expectedName) continue;
    const value = readOwnDataProperty(headers, key);
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }
  }
  return undefined;
}

function hasTransientNetworkErrorCode(
  error: unknown,
  visited = new Set<object>(),
  depth = 0
): boolean {
  if (!error || typeof error !== 'object' || depth > 4 || visited.has(error)) {
    return false;
  }
  visited.add(error);
  const code = readOwnDataProperty(error, 'code');
  if (
    typeof code === 'string' &&
    TRANSIENT_GITHUB_NETWORK_ERROR_CODES.some(
      (transientCode) => transientCode === code
    )
  ) {
    return true;
  }
  const cause = readOwnDataProperty(error, 'cause');
  if (hasTransientNetworkErrorCode(cause, visited, depth + 1)) return true;
  const errors = readOwnDataProperty(error, 'errors');
  return (
    Array.isArray(errors) &&
    errors.some((nested) =>
      hasTransientNetworkErrorCode(nested, visited, depth + 1)
    )
  );
}

function readOwnDataProperty(value: object, property: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, property);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function getRepositoryFromEventPayload(): string | undefined {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    return undefined;
  }

  try {
    const payload = JSON.parse(fs.readFileSync(eventPath, 'utf8')) as {
      repository?: {
        full_name?: string;
        name?: string;
        owner?: {
          login?: string;
          name?: string;
        };
      };
      organization?: {
        login?: string;
      };
    };

    if (payload.repository?.full_name) {
      return payload.repository.full_name;
    }

    const owner =
      payload.repository?.owner?.login ||
      payload.repository?.owner?.name ||
      payload.organization?.login;
    if (owner && payload.repository?.name) {
      return `${owner}/${payload.repository.name}`;
    }
  } catch {
    return undefined;
  }

  return undefined;
}
