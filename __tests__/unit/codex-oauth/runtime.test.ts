import sodium from 'libsodium-wrappers';
import path from 'path';
import {
  CodexOAuthLegacyRuntimePorts,
  CodexOAuthReviewRuntimeMode,
  runCodexOAuthRotatingRuntime,
  CodexOAuthV2ReviewOutcome,
  type CodexOAuthV2ReviewResult,
  type CodexOAuthV2ReviewRunnerPort,
  CodexOAuthV2RuntimePorts,
} from '../../../src/codex-oauth/runtime';
import { MergeGateConclusion } from '../../../src/review-projection/domain';

describe('Codex OAuth rotating runtime', () => {
  const idToken = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(
    JSON.stringify({
      iss: 'https://auth.openai.com',
      sub: 'user:123',
      'https://api.openai.com/auth': { chatgpt_account_id: 'account:456' },
    })
  ).toString('base64url')}.signature`;
  const authJsonBytes = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { refresh_token: 'refresh-token-secret', id_token: idToken },
    last_refresh: '2026-05-25T00:00:00.000Z',
  });
  const refreshedAuthJsonBytes = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { refresh_token: 'refreshed-token-secret', id_token: idToken },
    last_refresh: '2026-05-25T01:00:00.000Z',
  });
  const salt = Buffer.from('runtime-generation-hash-salt-32').toString(
    'base64url'
  );
  const accountFingerprintSalt = Buffer.from(
    'runtime-account-fingerprint-salt-32'
  ).toString('base64url');

  let publicKey: string;
  let logSpy: jest.SpyInstance;

  beforeAll(async () => {
    await sodium.ready;
    publicKey = Buffer.from(sodium.crypto_box_keypair().publicKey).toString(
      'base64'
    );
  });

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    process.env['INPUT_AUTH-JSON'] = authJsonBytes;
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'oidc-request-token';
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL =
      'https://token.actions.githubusercontent.com';
  });

  afterEach(() => {
    logSpy.mockRestore();
    delete process.env['INPUT_AUTH-JSON'];
    delete process.env.INPUT_AUTH_JSON;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.CODEX_HOME;
  });

  it('runs prelease before auth read, writeback before checkout, and comments after auth clear', async () => {
    const events: string[] = [];
    const ports = buildPorts(events);

    const result = await runCodexOAuthRotatingRuntime(
      {
        apiUrl: 'https://api.reviewrouter.site',
        audience: 'reviewrouter',
        providerInstanceId: 'codex-rotating:123456',
        workflowSchemaVersion: 1,
        repository: '777genius/agent-teams-ai',
        pullRequestNumber: 252,
        headSha: '0123456789abcdef0123456789abcdef01234567',
        workspacePath: '/tmp/workspace',
      },
      ports
    );

    expect(result).toEqual({
      status: 'completed',
      review: {
        skipped: false,
        markdown: 'summary',
        reviewedHeadSha: '0123456789abcdef0123456789abcdef01234567',
      },
    });
    expect(process.env.REVIEWROUTER_CODEX_BINARY).toBeUndefined();
    expect(events).toEqual([
      'oidc',
      'prelease',
      'prepare-codex',
      'finalize',
      'public-key',
      'writeback-preflight',
      'refresh',
      'writeback',
      'checkout-token',
      'checkout',
      'review',
      'clear-oidc-env',
      'clear-auth-material',
      'clear-process-auth-env',
      'comment-token',
      'comment',
    ]);
    expect(process.env['INPUT_AUTH-JSON']).toBeUndefined();
  });

  it('stops before reading auth or preparing Codex when server admission skips the PR', async () => {
    const events: string[] = [];
    const ports = buildPorts(events);
    ports.controlPlane.prelease = jest.fn(async () => {
      events.push('prelease');
      expect(process.env['INPUT_AUTH-JSON']).toBe(authJsonBytes);
      return {
        protocolVersion: 1 as const,
        status: 'skipped' as const,
        reason: 'max_changed_lines_exceeded' as const,
        changedLines: 346_978,
        maxChangedLines: 250_000,
        decisionHash: 'a'.repeat(64),
        leaseId: 'defense-in-depth-unexpected-lease',
      };
    });

    const result = await runCodexOAuthRotatingRuntime(
      {
        apiUrl: 'https://api.reviewrouter.site',
        audience: 'reviewrouter',
        providerInstanceId: 'codex-rotating:123456',
        workflowSchemaVersion: 1,
        repository: '777genius/agent-teams-ai',
        pullRequestNumber: 252,
        headSha: '0123456789abcdef0123456789abcdef01234567',
        workspacePath: '/tmp/workspace',
      },
      ports
    );

    expect(result).toEqual({
      status: 'skipped',
      reason: 'max_changed_lines_exceeded',
      changedLines: 346_978,
      maxChangedLines: 250_000,
      decisionHash: 'a'.repeat(64),
    });
    expect(events).toEqual([
      'oidc',
      'prelease',
      'clear-oidc-env',
      'clear-process-auth-env',
    ]);
    expect(process.env['INPUT_AUTH-JSON']).toBe(authJsonBytes);
  });

  it('skips stale queued secrets without refreshing, checkout, or comments', async () => {
    const events: string[] = [];
    const ports = buildPorts(events);
    ports.controlPlane.finalize = jest.fn(async () => {
      events.push('finalize');
      return {
        protocolVersion: 1 as const,
        leaseId: 'lease:12345678',
        nextGeneration: 2,
        status: 'stale_queued_secret' as const,
      };
    });

    const result = await runCodexOAuthRotatingRuntime(
      {
        apiUrl: 'https://api.reviewrouter.site',
        audience: 'reviewrouter',
        providerInstanceId: 'codex-rotating:123456',
        workflowSchemaVersion: 1,
        repository: '777genius/agent-teams-ai',
        pullRequestNumber: 252,
        headSha: '0123456789abcdef0123456789abcdef01234567',
        workspacePath: '/tmp/workspace',
      },
      ports
    );

    expect(result).toEqual({
      status: 'skipped',
      reason: 'stale_queued_secret',
    });
    expect(events).toEqual([
      'oidc',
      'prelease',
      'prepare-codex',
      'finalize',
      'clear-oidc-env',
      'clear-process-auth-env',
    ]);
  });

  it('runs server-published v2 without exposing a comment token or v1 comments', async () => {
    const events: string[] = [];
    const v2Review: CodexOAuthV2ReviewRunnerPort['run'] = jest.fn(
      async (input): Promise<CodexOAuthV2ReviewResult> => {
        expect(input).toMatchObject({
          repository: '777genius/agent-teams-ai',
          pullRequestNumber: 252,
          headSha: '0123456789abcdef0123456789abcdef01234567',
          workspacePath: '/tmp/workspace',
          codexHome: '/tmp/codex-home',
          codexBinaryPath: '/tmp/codex-bin',
          scmReadToken: 'ghs_checkout',
          scmReadTokenExpiresAt: '2026-05-25T12:15:00.000Z',
          refreshScmReadToken: expect.any(Function),
        });
        await expect(input.refreshScmReadToken()).resolves.toEqual({
          token: 'ghs_checkout',
          expiresAt: '2026-05-25T12:15:00.000Z',
        });
        events.push('v2-review');
        expect(input).not.toHaveProperty('commentToken');
        expect(input).not.toHaveProperty('commentTokenProvider');
        expect(input).not.toHaveProperty('comments');
        expect(input).not.toHaveProperty('write');
        expect(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe(
          'oidc-request-token'
        );
        return {
          outcome: CodexOAuthV2ReviewOutcome.Completed,
          mergeGateConclusion: MergeGateConclusion.Pass,
        };
      }
    );
    const ports = buildV2Ports(events, { run: v2Review });

    const result = await runCodexOAuthRotatingRuntime(
      {
        apiUrl: 'https://api.reviewrouter.site',
        audience: 'reviewrouter',
        providerInstanceId: 'codex-rotating:123456',
        workflowSchemaVersion: 1,
        repository: '777genius/agent-teams-ai',
        pullRequestNumber: 252,
        headSha: '0123456789abcdef0123456789abcdef01234567',
        workspacePath: '/tmp/workspace',
        reviewMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
      },
      ports
    );

    expect(result).toEqual({
      status: 'completed',
      publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
      v2Review: {
        outcome: CodexOAuthV2ReviewOutcome.Completed,
        mergeGateConclusion: MergeGateConclusion.Pass,
      },
    });
    expect(v2Review).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      'oidc',
      'prelease',
      'prepare-codex',
      'finalize',
      'public-key',
      'writeback-preflight',
      'refresh',
      'writeback',
      'checkout-token',
      'checkout',
      'checkout-token',
      'v2-review',
      'clear-oidc-env',
      'clear-auth-material',
      'clear-process-auth-env',
    ]);
    expect(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
    expect(process.env['INPUT_AUTH-JSON']).toBeUndefined();
  });

  it('fails closed and clears auth when v2 composition is missing', async () => {
    const events: string[] = [];
    const ports = buildV2Ports(events);

    await expect(
      runCodexOAuthRotatingRuntime(
        {
          apiUrl: 'https://api.reviewrouter.site',
          audience: 'reviewrouter',
          providerInstanceId: 'codex-rotating:123456',
          workflowSchemaVersion: 1,
          repository: '777genius/agent-teams-ai',
          pullRequestNumber: 252,
          headSha: '0123456789abcdef0123456789abcdef01234567',
          workspacePath: '/tmp/workspace',
          reviewMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
        },
        ports
      )
    ).rejects.toThrow('review_action_v2_runner_missing');

    expect(events).not.toContain('comment-token');
    expect(events).not.toContain('comment');
    expect(events.slice(-3)).toEqual([
      'clear-oidc-env',
      'clear-auth-material',
      'clear-process-auth-env',
    ]);
    expect(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
    expect(process.env['INPUT_AUTH-JSON']).toBeUndefined();
  });

  it('rejects a checkout capability if the control plane widens it to write', async () => {
    const events: string[] = [];
    const v2Review: CodexOAuthV2ReviewRunnerPort['run'] = jest.fn(
      async (): Promise<CodexOAuthV2ReviewResult> => ({
        outcome: CodexOAuthV2ReviewOutcome.Completed,
        mergeGateConclusion: MergeGateConclusion.Pass,
      })
    );
    const ports = buildV2Ports(events, { run: v2Review });
    ports.controlPlane.checkoutToken = jest.fn(async () => ({
      protocolVersion: 1 as const,
      token: 'ghs_widened',
      expiresAt: '2026-05-25T12:15:00.000Z',
      repository: '777genius/agent-teams-ai',
      permissions: {
        contents: 'read' as const,
        pullRequests: 'write',
      },
    })) as never;

    await expect(
      runCodexOAuthRotatingRuntime(
        {
          apiUrl: 'https://api.reviewrouter.site',
          audience: 'reviewrouter',
          providerInstanceId: 'codex-rotating:123456',
          workflowSchemaVersion: 1,
          repository: '777genius/agent-teams-ai',
          pullRequestNumber: 252,
          headSha: '0123456789abcdef0123456789abcdef01234567',
          workspacePath: '/tmp/workspace',
          reviewMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
        },
        ports
      )
    ).rejects.toThrow('review_action_v2_scm_read_token_scope_invalid');

    expect(v2Review).not.toHaveBeenCalled();
    expect(events).not.toContain('comment-token');
    expect(events.slice(-3)).toEqual([
      'clear-oidc-env',
      'clear-auth-material',
      'clear-process-auth-env',
    ]);
  });

  it('preserves stale queued secret semantics in v2 mode', async () => {
    const events: string[] = [];
    const v2Review: CodexOAuthV2ReviewRunnerPort['run'] = jest.fn(
      async (): Promise<CodexOAuthV2ReviewResult> => ({
        outcome: CodexOAuthV2ReviewOutcome.Completed,
        mergeGateConclusion: MergeGateConclusion.Pass,
      })
    );
    const ports = buildV2Ports(events, { run: v2Review });
    ports.controlPlane.finalize = jest.fn(async () => {
      events.push('finalize');
      return {
        protocolVersion: 1 as const,
        leaseId: 'lease:12345678',
        nextGeneration: 2,
        status: 'stale_queued_secret' as const,
      };
    });

    const result = await runCodexOAuthRotatingRuntime(
      {
        apiUrl: 'https://api.reviewrouter.site',
        audience: 'reviewrouter',
        providerInstanceId: 'codex-rotating:123456',
        workflowSchemaVersion: 1,
        repository: '777genius/agent-teams-ai',
        pullRequestNumber: 252,
        headSha: '0123456789abcdef0123456789abcdef01234567',
        workspacePath: '/tmp/workspace',
        reviewMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
      },
      ports
    );

    expect(result).toEqual({
      status: 'skipped',
      reason: 'stale_queued_secret',
    });
    expect(v2Review).not.toHaveBeenCalled();
    expect(events).toEqual([
      'oidc',
      'prelease',
      'prepare-codex',
      'finalize',
      'clear-oidc-env',
      'clear-process-auth-env',
    ]);
  });

  function buildPorts(events: string[]): CodexOAuthLegacyRuntimePorts {
    return {
      oidc: {
        requestToken: jest.fn(async () => {
          events.push('oidc');
          return 'oidc.jwt';
        }),
      },
      controlPlane: {
        prelease: jest.fn(async () => {
          events.push('prelease');
          expect(process.env['INPUT_AUTH-JSON']).toBe(authJsonBytes);
          return {
            protocolVersion: 1 as const,
            leaseId: 'lease:12345678',
            providerInstanceId: 'codex-rotating:123456',
            repository: '777genius/agent-teams-ai',
            generationHashSalt: salt,
            accountFingerprintSalt,
            currentGeneration: 1,
            expiresAt: '2026-05-25T12:00:00.000Z',
          };
        }),
        finalize: jest.fn(async () => {
          events.push('finalize');
          expect(process.env['INPUT_AUTH-JSON']).toBeUndefined();
          return {
            protocolVersion: 1 as const,
            leaseId: 'lease:12345678',
            nextGeneration: 2,
            status: 'finalized' as const,
            repositoryOwner: '777genius',
            repositoryName: 'agent-teams-ai',
            publicKeyReadToken: 'ghs_public_key_read',
            publicKeyReadTokenExpiresAt: '2026-05-25T12:15:00.000Z',
          };
        }),
        writebackPreflight: jest.fn(async () => {
          events.push('writeback-preflight');
          return { protocolVersion: 1 as const, status: 'ready' as const };
        }),
        writeback: jest.fn(async (body) => {
          events.push('writeback');
          expect(JSON.stringify(body)).not.toContain('refreshed-token-secret');
          expect(body).toMatchObject({
            accountIdentityHash: expect.any(String),
            accountIdentityAlgorithm: 'provider_issuer_subject_account_v1',
          });
          return { protocolVersion: 1 as const, status: 'accepted' as const };
        }),
        checkoutToken: jest.fn(async () => {
          events.push('checkout-token');
          return {
            protocolVersion: 1 as const,
            token: 'ghs_checkout',
            expiresAt: '2026-05-25T12:15:00.000Z',
            repository: '777genius/agent-teams-ai',
            permissions: {
              contents: 'read' as const,
              pullRequests: 'read' as const,
            },
          };
        }),
        commentToken: jest.fn(async () => {
          events.push('comment-token');
          expect(events).toContain('clear-auth-material');
          return {
            protocolVersion: 1 as const,
            token: 'ghs_comment',
            expiresAt: '2026-05-25T12:15:00.000Z',
            repository: '777genius/agent-teams-ai',
            permissions: {
              contents: 'read' as const,
              pullRequests: 'write' as const,
              issues: 'write' as const,
            },
          };
        }),
      },
      githubSecrets: {
        fetchPublicKey: jest.fn(async () => {
          events.push('public-key');
          return { keyId: 'github-key-id', key: publicKey };
        }),
      },
      codex: {
        prepareCli: jest.fn(async () => {
          events.push('prepare-codex');
          expect(process.env['INPUT_AUTH-JSON']).toBe(authJsonBytes);
          return { binaryPath: '/tmp/codex-bin' };
        }),
        refreshAuth: jest.fn(async (input) => {
          events.push('refresh');
          expect(input.codexBinaryPath).toBe('/tmp/codex-bin');
          return {
            authJsonBytes: refreshedAuthJsonBytes,
            codexHome: '/tmp/codex-home',
            async clearAuthMaterial() {
              events.push('clear-auth-material');
            },
          };
        }),
      },
      checkout: {
        checkoutExactHead: jest.fn(async () => {
          events.push('checkout');
          expect(events).toContain('writeback');
        }),
      },
      review: {
        run: jest.fn(async (input) => {
          events.push('review');
          expect(input.codexBinaryPath).toBe('/tmp/codex-bin');
          expect(process.env.REVIEWROUTER_CODEX_BINARY).toBe('/tmp/codex-bin');
          expect(process.env.PATH?.split(path.delimiter)[0]).toBe('/tmp');
          expect(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe(
            'oidc-request-token'
          );
          return { skipped: false, markdown: 'summary' };
        }),
      },
      comments: {
        post: jest.fn(async (input) => {
          events.push('comment');
          expect(input.review.reviewedHeadSha).toBe(
            '0123456789abcdef0123456789abcdef01234567'
          );
        }),
      },
      lifecycle: {
        clearOidcEnv: () => {
          events.push('clear-oidc-env');
          delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
          delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
        },
        clearProcessAuthEnv: () => {
          events.push('clear-process-auth-env');
          delete process.env.CODEX_HOME;
        },
      },
    };
  }

  function buildV2Ports(
    events: string[],
    v2Review?: CodexOAuthV2RuntimePorts['v2Review']
  ): CodexOAuthV2RuntimePorts {
    const legacy = buildPorts(events);
    return {
      oidc: legacy.oidc,
      controlPlane: {
        prelease: legacy.controlPlane.prelease,
        finalize: legacy.controlPlane.finalize,
        writebackPreflight: legacy.controlPlane.writebackPreflight,
        writeback: legacy.controlPlane.writeback,
        checkoutToken: legacy.controlPlane.checkoutToken,
      },
      githubSecrets: legacy.githubSecrets,
      codex: legacy.codex,
      checkout: legacy.checkout,
      lifecycle: legacy.lifecycle,
      ...(v2Review ? { v2Review } : {}),
    };
  }
});
