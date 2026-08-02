import { Review } from '../types';
import { normalizeReviewError } from '../errors/review-router-error';
import { RuntimeConfigResult } from './runtime-config';

type HealthReportLogger = {
  info(message: string): void;
  warn(message: string): void;
};

type HealthReportFetch = typeof fetch;

type ProviderSetupState =
  | 'unknown'
  | 'missing'
  | 'configured'
  | 'stale_or_invalid'
  | 'unavailable_in_fork_pr';

type ProviderHealth = 'ok' | 'skipped' | 'failed' | 'degraded';

type SafeErrorCategory =
  | 'none'
  | 'oidc_unavailable'
  | 'config_unavailable'
  | 'provider_auth_missing'
  | 'provider_auth_invalid'
  | 'provider_rate_limited'
  | 'runtime_error';

export type ControlPlaneHealthReportInput = {
  readonly runtimeConfig: RuntimeConfigResult | undefined;
  readonly review?: Review | null;
  readonly error?: unknown;
  readonly startedAt: Date;
  readonly finishedAt?: Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: HealthReportFetch;
  readonly logger?: HealthReportLogger;
};

export async function reportControlPlaneActionHealth(
  input: ControlPlaneHealthReportInput
): Promise<void> {
  if (!input.runtimeConfig || input.runtimeConfig.status !== 'applied') {
    return;
  }

  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? fetch;
  const outcome = classifyOutcome({
    review: input.review,
    error: input.error,
    env,
  });

  const report = {
    actionVersion: input.runtimeConfig.actionVersion,
    configVersion: input.runtimeConfig.configVersion,
    providerSetupState: outcome.providerSetupState,
    providerHealth: outcome.providerHealth,
    safeErrorCategory: outcome.safeErrorCategory,
    ...(outcome.safeErrorSummary
      ? { safeErrorSummary: outcome.safeErrorSummary }
      : {}),
    startedAt: input.startedAt.toISOString(),
    finishedAt: (input.finishedAt ?? new Date()).toISOString(),
  };

  try {
    const response = await fetchImpl(
      joinApiPath(input.runtimeConfig.apiUrl, '/api/action/v1/health-report'),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.runtimeConfig.sessionToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(report),
      }
    );
    if (!response.ok) {
      input.logger?.warn(
        `ReviewRouter health report was not accepted (${response.status}).`
      );
      return;
    }
    input.logger?.info('ReviewRouter health report sent.');
  } catch {
    input.logger?.warn('ReviewRouter health report could not be sent.');
  }
}

export function classifyOutcome(input: {
  readonly review?: Review | null;
  readonly error?: unknown;
  readonly env?: NodeJS.ProcessEnv;
}): {
  readonly providerSetupState: ProviderSetupState;
  readonly providerHealth: ProviderHealth;
  readonly safeErrorCategory: SafeErrorCategory;
  readonly safeErrorSummary?: string;
} {
  const missingSecretCategory = classifyMissingProviderSecret(input.env);
  if (missingSecretCategory) {
    return {
      providerSetupState: 'missing',
      providerHealth: 'failed',
      safeErrorCategory: 'provider_auth_missing',
      safeErrorSummary: missingSecretCategory,
    };
  }

  if (input.error) {
    const category = classifyErrorCategory(input.error);
    return {
      providerSetupState:
        category === 'provider_auth_invalid' ? 'stale_or_invalid' : 'unknown',
      providerHealth:
        category === 'provider_rate_limited' ? 'degraded' : 'failed',
      safeErrorCategory: category,
      safeErrorSummary: safeErrorSummaryForCategory(category),
    };
  }

  if (!input.review) {
    return {
      providerSetupState: 'configured',
      providerHealth: 'skipped',
      safeErrorCategory: 'none',
    };
  }

  const providersFailed = input.review.metrics.providersFailed;
  const providersSuccess = input.review.metrics.providersSuccess;
  if (providersSuccess === 0 && providersFailed > 0) {
    return {
      providerSetupState: 'unknown',
      providerHealth: 'failed',
      safeErrorCategory: 'runtime_error',
      safeErrorSummary: 'Review providers did not complete successfully.',
    };
  }
  if (providersFailed > 0) {
    return {
      providerSetupState: 'configured',
      providerHealth: 'degraded',
      safeErrorCategory: 'runtime_error',
      safeErrorSummary: 'Review completed with at least one provider failure.',
    };
  }

  return {
    providerSetupState: 'configured',
    providerHealth: 'ok',
    safeErrorCategory: 'none',
  };
}

function classifyMissingProviderSecret(
  env: NodeJS.ProcessEnv | undefined
): string | undefined {
  const authMode = env?.REVIEW_AUTH_MODE;
  if (authMode === 'codex-oauth' && !env?.CODEX_AUTH_JSON) {
    return 'CODEX_AUTH_JSON GitHub Actions secret is missing.';
  }
  if (authMode === 'claude-oauth' && !env?.CLAUDE_CODE_OAUTH_TOKEN) {
    return 'CLAUDE_CODE_OAUTH_TOKEN GitHub Actions secret is missing.';
  }
  if (authMode === 'openai-api' && !env?.OPENAI_API_KEY) {
    return 'OPENAI_API_KEY GitHub Actions secret is missing.';
  }
  if (authMode === 'openrouter-api' && !env?.OPENROUTER_API_KEY) {
    return 'OPENROUTER_API_KEY GitHub Actions secret is missing.';
  }
  return undefined;
}

function classifyErrorCategory(error: unknown): SafeErrorCategory {
  const normalized = normalizeReviewError(error);
  switch (normalized.code) {
    case 'provider_capacity_limited':
    case 'github_rate_limited':
      return 'provider_rate_limited';
    case 'codex_oauth_invalid_secret':
    case 'codex_oauth_stale':
    case 'codex_api_key_invalid':
    case 'claude_oauth_invalid_secret':
    case 'openrouter_api_key_invalid':
      return 'provider_auth_invalid';
    case 'oidc_unavailable':
      return 'oidc_unavailable';
    case 'runtime_config_unavailable':
      return 'config_unavailable';
    default:
      return 'runtime_error';
  }
}

function safeErrorSummaryForCategory(
  category: SafeErrorCategory
): string | undefined {
  switch (category) {
    case 'provider_rate_limited':
      return 'Provider rate limit was reached.';
    case 'provider_auth_invalid':
      return 'Provider authentication failed or is stale.';
    case 'runtime_error':
      return 'Review failed before completion. See GitHub Actions logs.';
    case 'oidc_unavailable':
      return 'GitHub OIDC was unavailable or rejected.';
    case 'config_unavailable':
      return 'Runtime config could not be loaded from the control plane.';
    case 'none':
    case 'provider_auth_missing':
      return undefined;
  }
}

function joinApiPath(apiUrl: string, path: string): string {
  return new URL(path, ensureTrailingSlash(apiUrl)).toString();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
