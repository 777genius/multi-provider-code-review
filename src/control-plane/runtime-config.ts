import packageJson from '../../package.json';
import {
  clearGitHubActionsOidcRequestEnv,
  GitHubActionsOidcTokenProvider,
} from '../codex-oauth/github-actions-oidc';

type RuntimeConfigLogger = {
  info(message: string): void;
  warn(message: string): void;
};

type RuntimeConfigFetch = typeof fetch;

type RuntimeConfigResponse = {
  readonly protocolVersion: 1;
  readonly configVersion: number;
  readonly runtimeEnv: Record<string, string>;
  readonly ignoredRuntimeEnvKeys: readonly string[];
};

export type RuntimeConfigResult =
  | { readonly status: 'skipped' }
  | {
      readonly status: 'applied';
      readonly apiUrl: string;
      readonly actionVersion: string;
      readonly configVersion: number;
      readonly sessionToken: string;
    }
  | { readonly status: 'fallback'; readonly reason: string };

export async function applyControlPlaneRuntimeConfig(
  input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly fetchImpl?: RuntimeConfigFetch;
    readonly logger?: RuntimeConfigLogger;
    readonly actionVersion?: string;
    readonly oidc?: { requestToken(audience: string): Promise<string> };
  } = {}
): Promise<RuntimeConfigResult> {
  const env = input.env ?? process.env;
  if (env.REVIEWROUTER_RUNTIME_CONFIG_MODE !== 'oidc') {
    return { status: 'skipped' };
  }

  const fallbackEnabled = env.REVIEWROUTER_STATIC_CONFIG_FALLBACK !== 'false';

  try {
    const apiUrl = requireEnv(env, 'REVIEWROUTER_API_URL');
    const audience = env.REVIEWROUTER_OIDC_AUDIENCE || 'reviewrouter';
    const oidc =
      input.oidc ??
      new GitHubActionsOidcTokenProvider({
        env,
        fetchImpl: input.fetchImpl ?? fetch,
      });
    const oidcToken = await oidc.requestToken(audience);
    const session = await exchangeActionSession({
      apiUrl,
      audience,
      oidcToken,
      fetchImpl: input.fetchImpl ?? fetch,
    });
    const actionVersion = input.actionVersion ?? resolveActionVersion(env);
    const config = await fetchRuntimeConfig({
      apiUrl,
      sessionToken: session.sessionToken,
      actionVersion,
      fetchImpl: input.fetchImpl ?? fetch,
    });

    applyRuntimeEnv(config.runtimeEnv, env);
    if (config.ignoredRuntimeEnvKeys.length > 0) {
      input.logger?.warn(
        `ReviewRouter runtime config ignored unsafe env keys: ${config.ignoredRuntimeEnvKeys.join(', ')}`
      );
    }
    input.logger?.info(
      `ReviewRouter runtime config applied (version ${config.configVersion}).`
    );
    return {
      status: 'applied',
      apiUrl,
      actionVersion,
      configVersion: config.configVersion,
      sessionToken: session.sessionToken,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown_error';
    if (message === 'action_version_blocked') {
      throw new Error(
        'Installed ReviewRouter Action version is blocked. Update the workflow action ref before retrying.'
      );
    }
    if (fallbackEnabled) {
      input.logger?.warn(
        `ReviewRouter runtime config unavailable; using static workflow config. Reason: ${safeReason(message)}`
      );
      return { status: 'fallback', reason: safeReason(message) };
    }
    throw error;
  } finally {
    clearGitHubActionsOidcRequestEnv(env);
  }
}

function resolveActionVersion(env: NodeJS.ProcessEnv): string {
  return (
    env.REVIEWROUTER_ACTION_VERSION?.trim() || packageJson.version || 'unknown'
  );
}

async function exchangeActionSession(input: {
  readonly apiUrl: string;
  readonly audience: string;
  readonly oidcToken: string;
  readonly fetchImpl: RuntimeConfigFetch;
}): Promise<{ readonly sessionToken: string }> {
  const response = await input.fetchImpl(
    joinApiPath(input.apiUrl, '/api/action/v1/session/exchange'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        oidcToken: input.oidcToken,
        audience: input.audience,
      }),
    }
  );
  if (!response.ok) {
    const code = await readSafeErrorCode(response);
    throw new Error(
      `action_session_exchange_failed:${response.status}${code ? `:${code}` : ''}`
    );
  }

  const body = (await response.json()) as { sessionToken?: unknown };
  if (typeof body.sessionToken !== 'string' || body.sessionToken.length === 0) {
    throw new Error('action_session_invalid_response');
  }
  return { sessionToken: body.sessionToken };
}

async function fetchRuntimeConfig(input: {
  readonly apiUrl: string;
  readonly sessionToken: string;
  readonly actionVersion: string;
  readonly fetchImpl: RuntimeConfigFetch;
}): Promise<RuntimeConfigResponse> {
  const response = await input.fetchImpl(
    joinApiPath(input.apiUrl, '/api/action/v1/config'),
    {
      headers: {
        Authorization: `Bearer ${input.sessionToken}`,
        'x-reviewrouter-action-version': input.actionVersion,
      },
    }
  );
  if (!response.ok) {
    const code = await readSafeErrorCode(response);
    if (response.status === 426 || code === 'action_version_blocked') {
      throw new Error('action_version_blocked');
    }
    throw new Error(
      `runtime_config_fetch_failed:${response.status}${code ? `:${code}` : ''}`
    );
  }

  return parseRuntimeConfig(await response.json());
}

function parseRuntimeConfig(value: unknown): RuntimeConfigResponse {
  if (!value || typeof value !== 'object') {
    throw new Error('runtime_config_invalid_response');
  }
  const input = value as {
    protocolVersion?: unknown;
    configVersion?: unknown;
    runtimeEnv?: unknown;
  };
  if (input.protocolVersion !== 1 || typeof input.configVersion !== 'number') {
    throw new Error('runtime_config_invalid_response');
  }
  if (!input.runtimeEnv || typeof input.runtimeEnv !== 'object') {
    throw new Error('runtime_config_invalid_response');
  }

  const runtimeEnv: Record<string, string> = {};
  const ignoredRuntimeEnvKeys: string[] = [];
  for (const [key, rawValue] of Object.entries(input.runtimeEnv)) {
    if (!isSafeRuntimeEnvKey(key) || typeof rawValue !== 'string') {
      ignoredRuntimeEnvKeys.push(safeEnvKeyLabel(key));
      continue;
    }
    runtimeEnv[key] = rawValue;
  }

  return {
    protocolVersion: 1,
    configVersion: input.configVersion,
    runtimeEnv,
    ignoredRuntimeEnvKeys,
  };
}

function applyRuntimeEnv(
  runtimeEnv: Record<string, string>,
  env: NodeJS.ProcessEnv
): void {
  for (const [key, value] of Object.entries(runtimeEnv)) {
    env[key] = value;
  }
}

function isSafeRuntimeEnvKey(key: string): boolean {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    return false;
  }
  if (key === 'TARGET_TOKENS_PER_BATCH') {
    return true;
  }
  return !/(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|AUTH_JSON)/.test(key);
}

function safeEnvKeyLabel(key: string): string {
  if (/^[A-Z_][A-Z0-9_]{0,80}$/.test(key)) {
    return key;
  }
  return '<invalid-env-key>';
}

async function readSafeErrorCode(
  response: Response
): Promise<string | undefined> {
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown } | string;
    };
    if (typeof body.error === 'string') {
      return safeReason(body.error);
    }
    if (typeof body.error?.code === 'string') {
      return safeReason(body.error.code);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function joinApiPath(apiUrl: string, path: string): string {
  return new URL(path, ensureTrailingSlash(apiUrl)).toString();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`missing_${key}`);
  }
  return value;
}

function safeReason(message: string): string {
  return message
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '<redacted>')
    .replace(/ghs_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .slice(0, 160);
}
