import { redactSensitiveText } from '../utils/redaction';
import {
  CapacitySignal,
  classifyProviderCapacitySignal,
} from '../review-execution/domain/capacity-signal';

export type ReviewErrorCategory =
  | 'configuration'
  | 'provider_auth'
  | 'provider_runtime'
  | 'github'
  | 'control_plane'
  | 'timeout'
  | 'filesystem'
  | 'unknown';

export type ReviewErrorCode =
  | 'configuration_invalid'
  | 'codex_oauth_stale'
  | 'codex_oauth_invalid_secret'
  | 'codex_api_key_invalid'
  | 'claude_oauth_invalid_secret'
  | 'openrouter_api_key_invalid'
  | 'codex_cli_missing'
  | 'required_provider_unhealthy'
  | 'no_healthy_providers'
  | 'provider_capacity_limited'
  | 'all_providers_failed'
  | 'github_permission_denied'
  | 'github_inline_comment_failed'
  | 'github_rate_limited'
  | 'runtime_config_unavailable'
  | 'control_plane_protocol_error'
  | 'oidc_unavailable'
  | 'timeout'
  | 'filesystem'
  | 'unknown';

type ReviewErrorDescriptor = {
  readonly code: ReviewErrorCode;
  readonly category: ReviewErrorCategory;
  readonly summary: string;
  readonly whyItMatters: string;
  readonly nextSteps: readonly string[];
  readonly isRetryable: boolean;
  readonly isUserActionable: boolean;
};

export class ReviewRouterError extends Error {
  readonly code: ReviewErrorCode;
  readonly category: ReviewErrorCategory;
  readonly safeMessage: string;
  readonly rawMessage: string;
  readonly summary: string;
  readonly whyItMatters: string;
  readonly nextSteps: readonly string[];
  readonly isRetryable: boolean;
  readonly isUserActionable: boolean;
  readonly originalError?: unknown;

  constructor(
    input: ReviewErrorDescriptor & {
      readonly safeMessage: string;
      readonly rawMessage: string;
      readonly originalError?: unknown;
      readonly stack?: string;
    }
  ) {
    super(input.safeMessage);
    this.name = 'ReviewRouterError';
    this.code = input.code;
    this.category = input.category;
    this.safeMessage = input.safeMessage;
    this.rawMessage = input.rawMessage;
    this.summary = input.summary;
    this.whyItMatters = input.whyItMatters;
    this.nextSteps = input.nextSteps;
    this.isRetryable = input.isRetryable;
    this.isUserActionable = input.isUserActionable;
    this.originalError = input.originalError;
    if (input.stack) {
      this.stack = input.stack;
    }
  }
}

export function normalizeReviewError(error: unknown): ReviewRouterError {
  if (error instanceof ReviewRouterError) {
    return error;
  }

  const rawMessage = getErrorMessage(error);
  const safeMessage = sanitizeErrorMessage(rawMessage);
  const descriptor = descriptorFor(rawMessage, error);

  return new ReviewRouterError({
    ...descriptor,
    safeMessage: safeMessage || descriptor.summary,
    rawMessage,
    originalError: error,
    stack:
      error instanceof Error && error.stack
        ? sanitizeErrorMessage(error.stack)
        : undefined,
  });
}

export function formatActionError(error: unknown): string {
  const normalized = normalizeReviewError(error);
  const retryText = normalized.isRetryable ? 'yes' : 'no';
  const actionText = normalized.isUserActionable ? 'yes' : 'no';

  return [
    `Review failed [${normalized.code}]: ${normalized.summary}`,
    '',
    normalized.whyItMatters,
    '',
    'How to fix:',
    ...normalized.nextSteps.map((step) => `- ${step}`),
    '',
    `Retryable: ${retryText}. User action required: ${actionText}.`,
    `Details: ${normalized.safeMessage}`,
  ].join('\n');
}

export function sanitizeErrorMessage(message: string): string {
  const redacted = redactSensitiveText(message);

  return redacted.length > 1600
    ? `${redacted.slice(0, 1600)}\n... truncated ...`
    : redacted;
}

function descriptorFor(
  rawMessage: string,
  error: unknown
): ReviewErrorDescriptor {
  const message =
    `${error instanceof Error ? error.name : ''} ${rawMessage}`.toLowerCase();

  if (
    message.includes('refresh token has already been used') ||
    message.includes('refresh token has been invalidated') ||
    message.includes('access token could not be refreshed') ||
    (message.includes('codex') && message.includes('reseed auth.json')) ||
    (message.includes('codex') && message.includes('refresh token'))
  ) {
    return descriptors.codex_oauth_stale;
  }

  if (
    message.includes('codex_auth_json') ||
    message.includes('auth.json') ||
    message.includes('refresh_token is missing') ||
    message.includes('auth_mode must be chatgpt') ||
    message.includes('not valid json') ||
    message.includes('tokens.refresh_token')
  ) {
    return descriptors.codex_oauth_invalid_secret;
  }

  if (
    message.includes('openrouter') &&
    (message.includes('api key') ||
      message.includes('401') ||
      message.includes('unauthorized') ||
      message.includes('403'))
  ) {
    return descriptors.openrouter_api_key_invalid;
  }

  if (
    message.includes('openai_api_key') ||
    message.includes('openai api key') ||
    (message.includes('api key') && !message.includes('openrouter'))
  ) {
    return descriptors.codex_api_key_invalid;
  }

  if (
    message.includes('claude_code_oauth_token') ||
    (message.includes('claude') &&
      (message.includes('not logged in') ||
        message.includes('oauth') ||
        message.includes('unauthorized') ||
        message.includes('401') ||
        message.includes('403')))
  ) {
    return descriptors.claude_oauth_invalid_secret;
  }

  if (
    (message.includes('401') || message.includes('unauthorized')) &&
    (message.includes('auth') || message.includes('token'))
  ) {
    return descriptors.codex_api_key_invalid;
  }

  if (
    message.includes('codex cli is not available') ||
    message.includes('codex: command not found') ||
    (message.includes('codex-cli') && message.includes('not found')) ||
    (message.includes('enoent') && message.includes('codex'))
  ) {
    return descriptors.codex_cli_missing;
  }

  if (
    message.includes('resource not accessible by integration') ||
    message.includes('bad credentials') ||
    (message.includes('github') &&
      (message.includes('403') || message.includes('forbidden')))
  ) {
    return descriptors.github_permission_denied;
  }

  if (
    message.includes('unprocessable entity') ||
    (message.includes('internal error occurred') && message.includes('pull')) ||
    message.includes('inline comment') ||
    message.includes('create-a-review-for-a-pull-request')
  ) {
    return descriptors.github_inline_comment_failed;
  }

  if (
    message.includes('github') &&
    (message.includes('rate limit') ||
      message.includes('rate-limit') ||
      message.includes('429'))
  ) {
    return descriptors.github_rate_limited;
  }

  if (message.includes('github_oidc_unavailable') || message.includes('oidc')) {
    return descriptors.oidc_unavailable;
  }

  if (
    message.includes('runtime_config') ||
    message.includes('action_session') ||
    message.includes('control plane') ||
    message.includes('action_version_blocked')
  ) {
    return descriptors.runtime_config_unavailable;
  }

  if (message.includes('review_action_v2_')) {
    return descriptors.control_plane_protocol_error;
  }

  if (
    message.includes('configuration error') ||
    message.includes('validationerror') ||
    message.includes('input required and not supplied') ||
    message.includes('invalid workflow') ||
    message.includes('invalid reviewrouter')
  ) {
    return descriptors.configuration_invalid;
  }

  if (isProviderCapacityError(rawMessage)) {
    return descriptors.provider_capacity_limited;
  }

  if (message.includes('no healthy providers')) {
    return descriptors.no_healthy_providers;
  }

  if (message.includes('required healthy provider')) {
    return descriptors.required_provider_unhealthy;
  }

  if (
    message.includes('all llm providers failed') ||
    message.includes('all llm batches failed') ||
    message.includes('all batches failed')
  ) {
    return descriptors.all_providers_failed;
  }

  if (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('etimedout')
  ) {
    return descriptors.timeout;
  }

  if (
    message.includes('enoent') ||
    message.includes('eacces') ||
    message.includes('file not found') ||
    message.includes('permission denied')
  ) {
    return descriptors.filesystem;
  }

  return descriptors.unknown;
}

function isProviderCapacityError(rawMessage: string): boolean {
  const hasProviderContext =
    /\b(?:codex|openai|openrouter|claude|llm|provider)\b/i.test(rawMessage);
  const isExplicitCodexUsageLimit =
    /(?:\byou(?:'|\u2019)ve hit your usage limit\b|\bpurchase more credits\b)/i.test(
      rawMessage
    );

  return (
    (hasProviderContext || isExplicitCodexUsageLimit) &&
    classifyProviderCapacitySignal({ error: rawMessage }) ===
      CapacitySignal.CapacityPressure
  );
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

const descriptors: Record<ReviewErrorCode, ReviewErrorDescriptor> = {
  configuration_invalid: {
    code: 'configuration_invalid',
    category: 'configuration',
    summary: 'ReviewRouter configuration is invalid.',
    whyItMatters:
      'The review cannot start until workflow inputs and required environment values are valid.',
    nextSteps: [
      'Check the ReviewRouter workflow inputs and generated static fallback config.',
      'Verify required values such as `GITHUB_TOKEN`, `PR_NUMBER`, model, and provider mode.',
      'Re-run setup if the workflow was manually edited.',
    ],
    isRetryable: false,
    isUserActionable: true,
  },
  codex_oauth_stale: {
    code: 'codex_oauth_stale',
    category: 'provider_auth',
    summary: 'Codex OAuth is stale or expired.',
    whyItMatters:
      'Codex could not create a review because the ChatGPT subscription refresh token no longer works in CI.',
    nextSteps: [
      'Run `codex login` on a trusted machine.',
      'Reseed `CODEX_AUTH_JSON` in the repository or selected organization Actions secrets.',
      'If you need automatic refresh, use a trusted self-hosted runner with persistent `CODEX_HOME`.',
    ],
    isRetryable: false,
    isUserActionable: true,
  },
  codex_oauth_invalid_secret: {
    code: 'codex_oauth_invalid_secret',
    category: 'provider_auth',
    summary: 'Codex OAuth secret is missing or invalid.',
    whyItMatters:
      'The workflow cannot restore a valid Codex ChatGPT subscription session.',
    nextSteps: [
      'Verify `CODEX_AUTH_JSON` exists in repository or selected organization Actions secrets.',
      'Verify it contains `auth_mode=chatgpt` and `tokens.refresh_token`.',
      'Reseed with the ReviewRouter Codex auth command from the dashboard or installer.',
    ],
    isRetryable: false,
    isUserActionable: true,
  },
  codex_api_key_invalid: {
    code: 'codex_api_key_invalid',
    category: 'provider_auth',
    summary: 'OpenAI API key mode is missing or invalid.',
    whyItMatters: 'ReviewRouter cannot call the configured OpenAI/Codex model.',
    nextSteps: [
      'Verify `OPENAI_API_KEY` is available to this workflow.',
      'Verify the key has access to the configured model.',
      'If you intended to use ChatGPT subscription OAuth, switch provider auth mode to Codex OAuth.',
    ],
    isRetryable: false,
    isUserActionable: true,
  },
  claude_oauth_invalid_secret: {
    code: 'claude_oauth_invalid_secret',
    category: 'provider_auth',
    summary: 'Claude Code OAuth token is missing or invalid.',
    whyItMatters:
      'Claude Code could not create a review because subscription OAuth is unavailable in CI.',
    nextSteps: [
      'Run `claude setup-token` on a trusted machine logged in to Claude Code.',
      'Store the printed token as `CLAUDE_CODE_OAUTH_TOKEN` in repository or selected organization Actions secrets.',
      'Make sure the secret value is only the token, not a pasted `pbpaste | gh secret set ...` command.',
      'Verify the workflow does not use Claude Code bare mode, because bare mode does not read subscription OAuth tokens.',
    ],
    isRetryable: false,
    isUserActionable: true,
  },
  openrouter_api_key_invalid: {
    code: 'openrouter_api_key_invalid',
    category: 'provider_auth',
    summary: 'OpenRouter API key mode is missing or invalid.',
    whyItMatters: 'ReviewRouter cannot call the configured OpenRouter model.',
    nextSteps: [
      'Verify `OPENROUTER_API_KEY` is available to this workflow.',
      'Verify the key has quota and access to the configured model.',
      'Re-run the workflow after updating the secret.',
    ],
    isRetryable: false,
    isUserActionable: true,
  },
  codex_cli_missing: {
    code: 'codex_cli_missing',
    category: 'provider_runtime',
    summary: 'Codex CLI is not available in CI.',
    whyItMatters:
      'The provider process could not start, so no LLM review can run.',
    nextSteps: [
      'Verify the workflow installs `@openai/codex@0.145.0` before ReviewRouter runs.',
      'Check that Node 24 setup completed successfully.',
      'Re-run after dependency installation succeeds.',
    ],
    isRetryable: true,
    isUserActionable: true,
  },
  required_provider_unhealthy: {
    code: 'required_provider_unhealthy',
    category: 'provider_runtime',
    summary: 'A required review provider was unavailable or unhealthy.',
    whyItMatters:
      'This provider is marked as required, so ReviewRouter must fail rather than silently relying on optional provider output.',
    nextSteps: [
      'Verify `REQUIRED_HEALTHY_PROVIDERS` only lists providers that are selected for this workflow.',
      'Check the required provider credentials, CLI setup, model name, and quota.',
      'If this provider should be best-effort only, remove it from the required healthy provider list.',
    ],
    isRetryable: true,
    isUserActionable: true,
  },
  no_healthy_providers: {
    code: 'no_healthy_providers',
    category: 'provider_runtime',
    summary: 'No configured review provider passed health checks.',
    whyItMatters:
      'ReviewRouter would otherwise report a misleading clean review without model coverage.',
    nextSteps: [
      'Check provider credentials and model names.',
      'For Codex OAuth, reseed `CODEX_AUTH_JSON` if the token is stale.',
      'For API-key modes, verify the key secret is available to this repository.',
    ],
    isRetryable: true,
    isUserActionable: true,
  },
  provider_capacity_limited: {
    code: 'provider_capacity_limited',
    category: 'provider_runtime',
    summary: 'A review provider reached its quota or capacity limit.',
    whyItMatters:
      'The required LLM review did not complete, so ReviewRouter marked the run as failed instead of reporting incomplete coverage as a successful review.',
    nextSteps: [
      'Wait for the provider limit to reset, then re-run the workflow.',
      'Switch to another configured provider with available quota or capacity.',
      'Check the provider usage or billing page if the limit is unexpected.',
    ],
    isRetryable: true,
    isUserActionable: true,
  },
  all_providers_failed: {
    code: 'all_providers_failed',
    category: 'provider_runtime',
    summary: 'All configured review providers failed during review.',
    whyItMatters:
      'Static checks may still run, but the LLM review did not complete.',
    nextSteps: [
      'Open the `Run ReviewRouter` step and check the provider-specific error.',
      'Fix provider auth, model, quota, or CLI setup.',
      'Re-run the workflow after the provider is healthy.',
    ],
    isRetryable: true,
    isUserActionable: true,
  },
  github_permission_denied: {
    code: 'github_permission_denied',
    category: 'github',
    summary: 'GitHub denied the token permission needed by ReviewRouter.',
    whyItMatters:
      'ReviewRouter cannot post comments, update PR metadata, or rerun workflows without the required permission.',
    nextSteps: [
      'Verify workflow permissions include `pull-requests: write` and `issues: write`.',
      'If using App comments, verify the ReviewRouter App installation has access to this repository.',
      'For interaction reruns, verify `actions: write` is present.',
    ],
    isRetryable: false,
    isUserActionable: true,
  },
  github_inline_comment_failed: {
    code: 'github_inline_comment_failed',
    category: 'github',
    summary: 'GitHub rejected inline review comments.',
    whyItMatters:
      'Findings may need to be posted as a fallback PR comment, or retried without committable suggestions.',
    nextSteps: [
      'Re-run the workflow once if GitHub returned an internal 422 error.',
      'Check whether the finding line is still inside the PR diff.',
      'If fallback comments were posted, the severity gate still uses those findings.',
    ],
    isRetryable: true,
    isUserActionable: false,
  },
  github_rate_limited: {
    code: 'github_rate_limited',
    category: 'github',
    summary: 'GitHub API rate limit was reached.',
    whyItMatters:
      'ReviewRouter could not complete GitHub API operations for this run.',
    nextSteps: [
      'Re-run after the GitHub rate limit resets.',
      'Reduce repeated manual reruns on the same PR.',
      'Use the GitHub App token path where possible.',
    ],
    isRetryable: true,
    isUserActionable: false,
  },
  runtime_config_unavailable: {
    code: 'runtime_config_unavailable',
    category: 'control_plane',
    summary: 'ReviewRouter runtime config could not be loaded.',
    whyItMatters:
      'The action could not fetch dashboard-managed config and may need static fallback.',
    nextSteps: [
      'Verify `REVIEWROUTER_API_URL` is reachable.',
      'Verify this repository is still connected in the dashboard.',
      'Use static fallback mode only if the SaaS config path is unavailable.',
    ],
    isRetryable: true,
    isUserActionable: true,
  },
  control_plane_protocol_error: {
    code: 'control_plane_protocol_error',
    category: 'control_plane',
    summary: 'ReviewRouter control-plane protocol rejected the review run.',
    whyItMatters:
      'The review stopped before provider execution because the server-side run contract was not satisfied.',
    nextSteps: [
      'Inspect the protocol operation, HTTP status, error code, and issues in the details line.',
      'Fix the named server-side invariant or retry after a transient control-plane condition is resolved.',
      'Do not reseed provider credentials unless the issue explicitly reports provider authentication.',
    ],
    isRetryable: false,
    isUserActionable: false,
  },
  oidc_unavailable: {
    code: 'oidc_unavailable',
    category: 'control_plane',
    summary: 'GitHub OIDC token was unavailable or rejected.',
    whyItMatters:
      'The action cannot authenticate to the ReviewRouter control plane for runtime config.',
    nextSteps: [
      'Verify workflow permissions include `id-token: write`.',
      'Verify the workflow path is the expected ReviewRouter caller workflow.',
      'Use static fallback if OIDC is unavailable.',
    ],
    isRetryable: true,
    isUserActionable: true,
  },
  timeout: {
    code: 'timeout',
    category: 'timeout',
    summary: 'ReviewRouter timed out before completion.',
    whyItMatters: 'The review result may be incomplete.',
    nextSteps: [
      'Reduce PR size or keep smart diff compaction enabled.',
      'Check provider logs for repeated retries.',
      'Increase `RUN_TIMEOUT_SECONDS` only after confirming provider health.',
    ],
    isRetryable: true,
    isUserActionable: true,
  },
  filesystem: {
    code: 'filesystem',
    category: 'filesystem',
    summary: 'ReviewRouter could not access a required file or directory.',
    whyItMatters:
      'The action could not read repository files, config, or generated reports.',
    nextSteps: [
      'Verify checkout completed successfully.',
      'Check file permissions and generated artifact paths.',
      'Re-run after fixing the missing or inaccessible path.',
    ],
    isRetryable: true,
    isUserActionable: true,
  },
  unknown: {
    code: 'unknown',
    category: 'unknown',
    summary: 'ReviewRouter failed with an unexpected error.',
    whyItMatters:
      'The review did not complete and the exact failure class is unknown.',
    nextSteps: [
      'Open the failed workflow run and inspect the `Run ReviewRouter` step.',
      'Verify credentials, model variables, and repository permissions.',
      'File an issue with the sanitized workflow log if this looks internal.',
    ],
    isRetryable: true,
    isUserActionable: true,
  },
};
