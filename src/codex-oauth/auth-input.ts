import * as core from '../actions/core';
import { clearGitHubActionsOidcRequestEnv } from './github-actions-oidc';

export const CODEX_ROTATING_AUTH_INPUT_ENV_NAMES = [
  'INPUT_AUTH-JSON',
  'INPUT_AUTH_JSON',
] as const;

export const REVIEW_ACTION_V2_SCM_MUTATION_ENV_NAMES = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'INPUT_GITHUB_TOKEN',
  'INPUT_GITHUB-TOKEN',
  'REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN',
  'INPUT_REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN',
  'INPUT_REVIEW-THREAD-LIFECYCLE-RESOLVE-TOKEN',
  'REVIEW_APP_PRIVATE_KEY',
  'REVIEW_ROUTER_APP_PRIVATE_KEY',
  'REVIEWROUTER_APP_PRIVATE_KEY',
  'INPUT_REVIEW_APP_PRIVATE_KEY',
  'INPUT_REVIEW-APP-PRIVATE-KEY',
  'GITHUB_APP_TOKEN',
  'REVIEW_APP_TOKEN',
  'REVIEW_ROUTER_APP_TOKEN',
  'REVIEWROUTER_APP_TOKEN',
  'REVIEW_ROUTER_COMMENT_TOKEN',
  'REVIEWROUTER_COMMENT_TOKEN',
] as const;

const REVIEW_ACTION_V2_SCM_MUTATION_ENV_NAME_SET = new Set<string>(
  REVIEW_ACTION_V2_SCM_MUTATION_ENV_NAMES
);

const CODEX_ROTATING_PROVIDER_SECRET_INPUT_ENV_NAMES = {
  claudeCodeOAuthToken: [
    'INPUT_CLAUDE-CODE-OAUTH-TOKEN',
    'INPUT_CLAUDE_CODE_OAUTH_TOKEN',
  ],
  openRouterApiKey: ['INPUT_OPENROUTER-API-KEY', 'INPUT_OPENROUTER_API_KEY'],
} as const;

export type CodexRotatingProviderSecretInputs = {
  claudeCodeOAuthToken?: string;
  openRouterApiKey?: string;
};

export type CodexRotatingAuthInput = {
  authJsonBytes: string;
};

export function readCodexRotatingAuthInput(
  env: NodeJS.ProcessEnv = process.env
): CodexRotatingAuthInput {
  const authJsonBytes = CODEX_ROTATING_AUTH_INPUT_ENV_NAMES.map(
    (name) => env[name]
  ).find((value): value is string => value !== undefined);

  if (!authJsonBytes) {
    clearCodexRotatingAuthInput(env);
    throw new Error('codex_oauth_auth_json_input_missing');
  }

  maskCodexAuthJson(authJsonBytes);
  clearCodexRotatingAuthInput(env);
  return { authJsonBytes };
}

export function hasCodexRotatingAuthInput(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return CODEX_ROTATING_AUTH_INPUT_ENV_NAMES.some(
    (name) => (env[name] ?? '').trim().length > 0
  );
}

export function clearCodexRotatingAuthInput(
  env: NodeJS.ProcessEnv = process.env
): void {
  for (const name of CODEX_ROTATING_AUTH_INPUT_ENV_NAMES) {
    delete env[name];
  }
}

export function readCodexRotatingProviderSecretInputs(
  env: NodeJS.ProcessEnv = process.env
): CodexRotatingProviderSecretInputs {
  const claudeCodeOAuthToken = readOptionalSecretInput(
    CODEX_ROTATING_PROVIDER_SECRET_INPUT_ENV_NAMES.claudeCodeOAuthToken,
    env
  );
  const openRouterApiKey = readOptionalSecretInput(
    CODEX_ROTATING_PROVIDER_SECRET_INPUT_ENV_NAMES.openRouterApiKey,
    env
  );

  clearCodexRotatingProviderSecretInputs(env);
  return {
    ...(claudeCodeOAuthToken ? { claudeCodeOAuthToken } : {}),
    ...(openRouterApiKey ? { openRouterApiKey } : {}),
  };
}

export function applyCodexRotatingProviderSecretInputs(
  input: CodexRotatingProviderSecretInputs,
  env: NodeJS.ProcessEnv = process.env
): void {
  clearCodexRotatingProviderSecretEnv(env);
  if (input.claudeCodeOAuthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = input.claudeCodeOAuthToken;
  }
  if (input.openRouterApiKey) {
    env.OPENROUTER_API_KEY = input.openRouterApiKey;
  }
}

export function clearCodexRotatingProviderSecretInputs(
  env: NodeJS.ProcessEnv = process.env
): void {
  for (const names of Object.values(
    CODEX_ROTATING_PROVIDER_SECRET_INPUT_ENV_NAMES
  )) {
    for (const name of names) {
      delete env[name];
    }
  }
}

export function clearCodexRotatingProviderSecretEnv(
  env: NodeJS.ProcessEnv = process.env
): void {
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.OPENROUTER_API_KEY;
}

export function clearCodexRotatingOidcRequestEnv(
  env: NodeJS.ProcessEnv = process.env
): void {
  clearGitHubActionsOidcRequestEnv(env);
}

export function scrubAndAssertReviewActionV2ScmMutationEnv(
  env: NodeJS.ProcessEnv = process.env
): readonly string[] {
  const scrubbed = REVIEW_ACTION_V2_SCM_MUTATION_ENV_NAMES.filter(
    (name) => env[name] !== undefined
  ).sort();
  for (const name of scrubbed) {
    delete env[name];
  }
  const unexpected = Object.keys(env)
    .filter(isReviewActionV2ScmMutationEnvName)
    .sort();
  for (const name of unexpected) {
    delete env[name];
  }
  assertReviewActionV2ScmMutationEnvAbsent(env);
  if (unexpected.length > 0) {
    throw new Error(
      `review_action_v2_unexpected_scm_mutation_env_scrubbed:${unexpected.join(',')}`
    );
  }
  return Object.freeze(scrubbed);
}

export function assertReviewActionV2ScmMutationEnvAbsent(
  env: NodeJS.ProcessEnv = process.env
): void {
  const remaining = Object.keys(env)
    .filter(isReviewActionV2ScmMutationEnvName)
    .sort();
  if (remaining.length > 0) {
    throw new Error(
      `review_action_v2_scm_mutation_env_present:${remaining.join(',')}`
    );
  }
}

export function clearCodexRotatingProcessAuthEnv(
  env: NodeJS.ProcessEnv = process.env
): void {
  delete env.CODEX_AUTH_JSON;
  delete env.CODEX_CONFIG_TOML;
  delete env.OPENAI_API_KEY;
  delete env.CODEX_HOME;
  clearCodexRotatingAuthInput(env);
  clearCodexRotatingProviderSecretInputs(env);
  clearCodexRotatingProviderSecretEnv(env);
}

function maskCodexAuthJson(authJsonBytes: string): void {
  core.setSecret(authJsonBytes);
  try {
    const parsed = JSON.parse(authJsonBytes) as {
      tokens?: Record<string, unknown>;
    };
    for (const key of ['refresh_token', 'access_token', 'id_token']) {
      const value = parsed.tokens?.[key];
      if (typeof value === 'string' && value.length > 0) {
        core.setSecret(value);
      }
    }
  } catch {
    // The validator reports invalid JSON later. The raw bytes are already masked.
  }
}

function readOptionalSecretInput(
  envNames: readonly string[],
  env: NodeJS.ProcessEnv
): string | undefined {
  const value = envNames
    .map((name) => env[name]?.trim())
    .find((raw): raw is string => Boolean(raw));
  if (value) {
    core.setSecret(value);
  }
  return value;
}

function isReviewActionV2ScmMutationEnvName(name: string): boolean {
  const normalized = name.replace(/-/g, '_').toUpperCase();
  if (REVIEW_ACTION_V2_SCM_MUTATION_ENV_NAME_SET.has(name)) return true;
  if (/^(?:INPUT_)?(?:GITHUB|GH)_TOKEN$/.test(normalized)) return true;
  return /^(?:INPUT_)?(?:REVIEW|REVIEW_ROUTER|REVIEWROUTER)_(?:APP_(?:TOKEN|PRIVATE_KEY)|THREAD_LIFECYCLE_RESOLVE_TOKEN|(?:SCM_)?(?:WRITE|MUTATION|COMMENT)_TOKEN)$/.test(
    normalized
  );
}
