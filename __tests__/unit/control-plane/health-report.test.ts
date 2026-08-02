import {
  classifyOutcome,
  reportControlPlaneActionHealth,
} from '../../../src/control-plane/health-report';
import { Review } from '../../../src/types';

describe('reportControlPlaneActionHealth', () => {
  const startedAt = new Date('2026-05-04T00:00:00.000Z');
  const finishedAt = new Date('2026-05-04T00:00:05.000Z');
  const runtimeConfig = {
    status: 'applied' as const,
    apiUrl: 'https://app.reviewrouter.dev',
    actionVersion: 'main',
    configVersion: 4,
    sessionToken: 'rr-session',
  };

  it('posts metadata-only health report after a successful review', async () => {
    const fetchImpl = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValueOnce(jsonResponse({ recorded: true }));

    await reportControlPlaneActionHealth({
      runtimeConfig,
      review: review({ providersSuccess: 1, providersFailed: 0 }),
      startedAt,
      finishedAt,
      fetchImpl,
    });

    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://app.reviewrouter.dev/api/action/v1/health-report'
    );
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer rr-session',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      actionVersion: 'main',
      configVersion: 4,
      providerSetupState: 'configured',
      providerHealth: 'ok',
      safeErrorCategory: 'none',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    });
  });

  it('does not report when the OIDC session was unavailable', async () => {
    const fetchImpl = jest.fn();

    await reportControlPlaneActionHealth({
      runtimeConfig: { status: 'fallback', reason: 'network_down' },
      review: review({ providersSuccess: 1, providersFailed: 0 }),
      startedAt,
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps health reporting non-blocking when SaaS rejects the report', async () => {
    const warnings: string[] = [];
    const fetchImpl = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValueOnce(jsonResponse({ error: 'rate_limited' }, 429));

    await expect(
      reportControlPlaneActionHealth({
        runtimeConfig,
        review: review({ providersSuccess: 1, providersFailed: 0 }),
        startedAt,
        fetchImpl,
        logger: { info: jest.fn(), warn: (message) => warnings.push(message) },
      })
    ).resolves.toBeUndefined();
    expect(warnings[0]).toContain('not accepted');
  });
});

describe('classifyOutcome', () => {
  it('treats blocking findings as provider health ok', () => {
    expect(
      classifyOutcome({
        review: review({
          providersSuccess: 1,
          providersFailed: 0,
          critical: 1,
        }),
      })
    ).toMatchObject({
      providerSetupState: 'configured',
      providerHealth: 'ok',
      safeErrorCategory: 'none',
    });
  });

  it('marks missing Codex OAuth secret as provider setup missing', () => {
    expect(
      classifyOutcome({
        env: { REVIEW_AUTH_MODE: 'codex-oauth' },
      })
    ).toMatchObject({
      providerSetupState: 'missing',
      providerHealth: 'failed',
      safeErrorCategory: 'provider_auth_missing',
    });
  });

  it('classifies provider auth errors without leaking raw error text', () => {
    expect(
      classifyOutcome({
        error: new Error('401 Unauthorized: token abc123 failed'),
      })
    ).toEqual({
      providerSetupState: 'stale_or_invalid',
      providerHealth: 'failed',
      safeErrorCategory: 'provider_auth_invalid',
      safeErrorSummary: 'Provider authentication failed or is stale.',
    });
  });

  it('reports provider quota exhaustion as rate limited', () => {
    expect(
      classifyOutcome({
        error: new Error("You've hit your usage limit."),
      })
    ).toEqual({
      providerSetupState: 'unknown',
      providerHealth: 'degraded',
      safeErrorCategory: 'provider_rate_limited',
      safeErrorSummary: 'Provider rate limit was reached.',
    });
  });

  it('classifies OIDC and runtime config errors with safe categories', () => {
    expect(
      classifyOutcome({
        error: new Error(
          'github_oidc_unavailable: id-token permission missing'
        ),
      })
    ).toMatchObject({
      providerHealth: 'failed',
      safeErrorCategory: 'oidc_unavailable',
      safeErrorSummary: 'GitHub OIDC was unavailable or rejected.',
    });

    expect(
      classifyOutcome({
        error: new Error(
          'runtime_config_fetch_failed: control plane unavailable'
        ),
      })
    ).toMatchObject({
      providerHealth: 'failed',
      safeErrorCategory: 'config_unavailable',
      safeErrorSummary:
        'Runtime config could not be loaded from the control plane.',
    });
  });
});

function review(input: {
  readonly providersSuccess: number;
  readonly providersFailed: number;
  readonly critical?: number;
}): Review {
  return {
    summary: 'done',
    findings:
      input.critical && input.critical > 0
        ? [
            {
              file: 'auth.js',
              line: 5,
              severity: 'critical',
              title: 'Bug',
              message: 'Bug',
            },
          ]
        : [],
    inlineComments: [],
    actionItems: [],
    metrics: {
      totalFindings: input.critical ?? 0,
      critical: input.critical ?? 0,
      major: 0,
      minor: 0,
      providersUsed: input.providersSuccess + input.providersFailed,
      providersSuccess: input.providersSuccess,
      providersFailed: input.providersFailed,
      totalTokens: 0,
      totalCost: 0,
      durationSeconds: 1,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}
