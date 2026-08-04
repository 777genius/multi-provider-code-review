export type FetchLike = typeof fetch;

export type CodexRotatingPreleaseResponse =
  | {
      protocolVersion: 1;
      leaseId: string;
      providerInstanceId: string;
      repository: string;
      generationHashSalt: string;
      currentGeneration: number;
      currentGenerationHash?: string;
      expiresAt: string;
    }
  | {
      protocolVersion: 1;
      status: 'skipped';
      reason: 'max_changed_lines_exceeded';
      changedLines: number;
      maxChangedLines: number;
      decisionHash: string;
    };

export type CodexRotatingFinalizeResponse = {
  protocolVersion: 1;
  leaseId: string;
  nextGeneration: number;
} & (
  | {
      status: 'finalized';
      repositoryOwner: string;
      repositoryName: string;
      publicKeyReadToken: string;
      publicKeyReadTokenExpiresAt: string;
    }
  | { status: 'stale_queued_secret' }
);

export type CodexRotatingWritebackPreflightResponse =
  | { protocolVersion: 1; status: 'ready' }
  | {
      protocolVersion: 1;
      status: 'skipped';
      reason:
        'lease_not_active' | 'stale_queued_secret' | 'permission_required';
    };

export type CodexRotatingWritebackResponse = {
  protocolVersion: 1;
  status:
    | 'accepted'
    | 'idempotent_replay'
    | 'github_put_failed'
    | 'writeback_idempotency_conflict';
};

export type CodexRotatingCheckoutTokenResponse = {
  protocolVersion: 1;
  token: string;
  expiresAt: string;
  repository: string;
  permissions: {
    contents: 'read';
    pullRequests: 'read';
  };
};

export type CodexRotatingCommentTokenResponse = {
  protocolVersion: 1;
  token: string;
  expiresAt: string;
  repository: string;
  permissions: {
    contents: 'read';
    pullRequests: 'write';
    issues: 'write';
  };
};

export type ActionSessionExchangeResponse = {
  protocolVersion?: 1;
  sessionToken: string;
  expiresAt?: string;
};

export type ActionCommentTokenResponse = {
  protocolVersion: 1;
  token: string;
  expiresAt: string;
  repository: string;
};

export class CodexOAuthControlPlaneClient {
  private readonly apiUrl: URL;
  private readonly fetchImpl: FetchLike;

  constructor(options: { apiUrl: string; fetchImpl?: FetchLike }) {
    this.apiUrl = parseTrustedApiUrl(options.apiUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  prelease(input: {
    oidcToken: string;
    audience: string;
    providerInstanceId: string;
    workflowSchemaVersion: number;
  }): Promise<CodexRotatingPreleaseResponse> {
    return this.postJson(
      '/api/action/v1/codex-oauth/prelease',
      {
        oidcToken: input.oidcToken,
        audience: input.audience,
        providerInstanceId: input.providerInstanceId,
        workflowSchemaVersion: input.workflowSchemaVersion,
      },
      isCodexRotatingPreleaseResponse
    );
  }

  finalize(input: {
    leaseId: string;
    providerInstanceId: string;
    restoredGenerationHash: string;
  }): Promise<CodexRotatingFinalizeResponse> {
    return this.postJson(
      '/api/action/v1/codex-oauth/finalize',
      input,
      isCodexRotatingFinalizeResponse
    );
  }

  writebackPreflight(input: {
    leaseId: string;
    providerInstanceId: string;
    githubKeyId: string;
  }): Promise<CodexRotatingWritebackPreflightResponse> {
    return this.postJson(
      '/api/action/v1/codex-oauth/writeback-preflight',
      input,
      isCodexRotatingWritebackPreflightResponse
    );
  }

  writeback(
    body: Record<string, unknown>
  ): Promise<CodexRotatingWritebackResponse> {
    return this.postJson(
      '/api/action/v1/codex-oauth/writeback',
      body,
      isCodexRotatingWritebackResponse
    );
  }

  checkoutToken(input: {
    leaseId: string;
    providerInstanceId: string;
  }): Promise<CodexRotatingCheckoutTokenResponse> {
    return this.postJson(
      '/api/action/v1/codex-oauth/checkout-token',
      input,
      isCodexRotatingCheckoutTokenResponse
    );
  }

  commentToken(input: {
    leaseId: string;
    providerInstanceId: string;
    authCleared: true;
  }): Promise<CodexRotatingCommentTokenResponse> {
    return this.postJson(
      '/api/action/v1/codex-oauth/comment-token',
      input,
      isCodexRotatingCommentTokenResponse
    );
  }

  actionSession(input: {
    oidcToken: string;
    audience: string;
  }): Promise<ActionSessionExchangeResponse> {
    return this.postJson(
      '/api/action/v1/session/exchange',
      {
        oidcToken: input.oidcToken,
        audience: input.audience,
      },
      isActionSessionExchangeResponse
    );
  }

  actionCommentToken(input: {
    sessionToken: string;
  }): Promise<ActionCommentTokenResponse> {
    return this.postJsonWithAuthorization(
      '/api/action/v1/comment-token',
      input.sessionToken,
      {},
      isActionCommentTokenResponse
    );
  }

  private async postJson<T>(
    path: string,
    body: Record<string, unknown>,
    guard: (value: unknown) => value is T
  ): Promise<T> {
    const response = await this.fetchImpl(resolveApiPath(this.apiUrl, path), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        `codex_oauth_control_plane_error:${response.status}:${safeErrorCode(payload)}`
      );
    }
    if (!guard(payload)) {
      throw new Error('codex_oauth_control_plane_invalid_response');
    }
    return payload;
  }

  private async postJsonWithAuthorization<T>(
    path: string,
    bearerToken: string,
    body: Record<string, unknown>,
    guard: (value: unknown) => value is T
  ): Promise<T> {
    const response = await this.fetchImpl(resolveApiPath(this.apiUrl, path), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        `codex_oauth_control_plane_error:${response.status}:${safeErrorCode(payload)}`
      );
    }
    if (!guard(payload)) {
      throw new Error('codex_oauth_control_plane_invalid_response');
    }
    return payload;
  }
}

function isCodexRotatingPreleaseResponse(
  value: unknown
): value is CodexRotatingPreleaseResponse {
  const input = asRecord(value);
  if (input?.protocolVersion !== 1) return false;
  if (input.status === 'skipped') {
    return (
      input.reason === 'max_changed_lines_exceeded' &&
      isNonNegativeSafeInteger(input.changedLines) &&
      isNonNegativeSafeInteger(input.maxChangedLines) &&
      input.maxChangedLines > 0 &&
      input.changedLines > input.maxChangedLines &&
      isSha256(input.decisionHash) &&
      input.leaseId === undefined &&
      input.providerInstanceId === undefined &&
      input.repository === undefined &&
      input.generationHashSalt === undefined &&
      input.currentGeneration === undefined &&
      input.currentGenerationHash === undefined &&
      input.expiresAt === undefined
    );
  }
  if (input.status !== undefined) return false;
  return (
    isNonEmptyString(input.leaseId) &&
    isNonEmptyString(input.providerInstanceId) &&
    isNonEmptyString(input.repository) &&
    isNonEmptyString(input.generationHashSalt) &&
    typeof input.currentGeneration === 'number' &&
    Number.isInteger(input.currentGeneration) &&
    input.currentGeneration > 0 &&
    isNonEmptyString(input.expiresAt)
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isCodexRotatingFinalizeResponse(
  value: unknown
): value is CodexRotatingFinalizeResponse {
  const input = asRecord(value);
  if (
    input?.protocolVersion !== 1 ||
    !isNonEmptyString(input.leaseId) ||
    !Number.isInteger(input.nextGeneration)
  ) {
    return false;
  }
  if (input.status === 'stale_queued_secret') {
    return true;
  }
  return (
    input.status === 'finalized' &&
    isNonEmptyString(input.repositoryOwner) &&
    isNonEmptyString(input.repositoryName) &&
    isNonEmptyString(input.publicKeyReadToken) &&
    isNonEmptyString(input.publicKeyReadTokenExpiresAt)
  );
}

function isCodexRotatingWritebackPreflightResponse(
  value: unknown
): value is CodexRotatingWritebackPreflightResponse {
  const input = asRecord(value);
  if (input?.protocolVersion !== 1) return false;
  if (input.status === 'ready') return true;
  return (
    input.status === 'skipped' &&
    (input.reason === 'lease_not_active' ||
      input.reason === 'stale_queued_secret' ||
      input.reason === 'permission_required')
  );
}

function isCodexRotatingWritebackResponse(
  value: unknown
): value is CodexRotatingWritebackResponse {
  const input = asRecord(value);
  return (
    input?.protocolVersion === 1 &&
    (input.status === 'accepted' ||
      input.status === 'idempotent_replay' ||
      input.status === 'github_put_failed' ||
      input.status === 'writeback_idempotency_conflict')
  );
}

function isCodexRotatingCheckoutTokenResponse(
  value: unknown
): value is CodexRotatingCheckoutTokenResponse {
  const input = asRecord(value);
  const permissions = asRecord(input?.permissions);
  return (
    input?.protocolVersion === 1 &&
    isNonEmptyString(input.token) &&
    isNonEmptyString(input.expiresAt) &&
    isNonEmptyString(input.repository) &&
    permissions?.contents === 'read' &&
    permissions.pullRequests === 'read'
  );
}

function isCodexRotatingCommentTokenResponse(
  value: unknown
): value is CodexRotatingCommentTokenResponse {
  const input = asRecord(value);
  const permissions = asRecord(input?.permissions);
  return (
    input?.protocolVersion === 1 &&
    isNonEmptyString(input.token) &&
    isNonEmptyString(input.expiresAt) &&
    isNonEmptyString(input.repository) &&
    permissions?.contents === 'read' &&
    permissions.pullRequests === 'write' &&
    permissions.issues === 'write'
  );
}

function isActionSessionExchangeResponse(
  value: unknown
): value is ActionSessionExchangeResponse {
  const input = asRecord(value);
  return (
    input !== undefined &&
    (input.protocolVersion === undefined || input.protocolVersion === 1) &&
    isNonEmptyString(input.sessionToken) &&
    (input.expiresAt === undefined || isNonEmptyString(input.expiresAt))
  );
}

function isActionCommentTokenResponse(
  value: unknown
): value is ActionCommentTokenResponse {
  const input = asRecord(value);
  return (
    input?.protocolVersion === 1 &&
    isNonEmptyString(input.token) &&
    isNonEmptyString(input.expiresAt) &&
    isNonEmptyString(input.repository)
  );
}

function parseTrustedApiUrl(apiUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error('codex_oauth_api_url_invalid');
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('codex_oauth_api_url_invalid');
  }
  if (parsed.protocol === 'https:') {
    return parsed;
  }
  if (parsed.protocol === 'http:' && isLocalhost(parsed.hostname)) {
    return parsed;
  }
  throw new Error('codex_oauth_api_url_invalid');
}

function resolveApiPath(apiUrl: URL, path: string): string {
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\') ||
    path.includes('?') ||
    path.includes('#') ||
    path.includes('..') ||
    /%2e|%2f|%5c/i.test(path)
  ) {
    throw new Error('codex_oauth_api_path_invalid');
  }
  const resolved = new URL(path, apiUrl);
  if (resolved.origin !== apiUrl.origin) {
    throw new Error('codex_oauth_api_path_invalid');
  }
  return resolved.toString();
}

function isLocalhost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

function safeErrorCode(payload: unknown): string {
  const input = asRecord(payload);
  const raw =
    typeof input?.error === 'string'
      ? input.error
      : typeof asRecord(input?.error)?.code === 'string'
        ? asRecord(input?.error)?.code
        : 'unknown_error';
  return String(raw)
    .replace(/ghs_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .replace(/[^\w:-]/g, '_')
    .slice(0, 120);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
