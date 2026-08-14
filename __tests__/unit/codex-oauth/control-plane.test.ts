import { CodexOAuthControlPlaneClient } from '../../../src/codex-oauth/control-plane';

describe('Codex OAuth control-plane client', () => {
  it('rejects an unknown prelease status even when lease fields are valid', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({
        protocolVersion: 1,
        status: 'unexpected',
        leaseId: 'lease_1',
        providerInstanceId: 'codex-rotating:123456',
        repository: '777genius/agent-teams-ai',
        generationHashSalt: 'salt',
        accountFingerprintSalt: 'account-salt',
        currentGeneration: 1,
        expiresAt: '2026-07-25T12:00:00.000Z',
      })
    ) as unknown as typeof fetch;
    const client = new CodexOAuthControlPlaneClient({
      apiUrl: 'https://api.reviewrouter.site',
      fetchImpl,
    });

    await expect(
      client.prelease({
        oidcToken: 'oidc-token',
        audience: 'reviewrouter',
        providerInstanceId: 'codex-rotating:123456',
        workflowSchemaVersion: 1,
      })
    ).rejects.toThrow('codex_oauth_control_plane_invalid_response');
  });

  it('rejects a lease response without an account fingerprint salt', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({
        protocolVersion: 1,
        leaseId: 'lease_12345678',
        providerInstanceId: 'codex-rotating:123456',
        repository: '777genius/agent-teams-ai',
        generationHashSalt: 'generation-salt',
        currentGeneration: 1,
        expiresAt: '2026-07-25T12:00:00.000Z',
      })
    ) as unknown as typeof fetch;
    const client = new CodexOAuthControlPlaneClient({
      apiUrl: 'https://api.reviewrouter.site',
      fetchImpl,
    });

    await expect(
      client.prelease({
        oidcToken: 'oidc-token',
        audience: 'reviewrouter',
        providerInstanceId: 'codex-rotating:123456',
        workflowSchemaVersion: 4,
      })
    ).rejects.toThrow('codex_oauth_control_plane_invalid_response');
  });

  it('rejects a skipped prelease response containing lease fields', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({
        protocolVersion: 1,
        status: 'skipped',
        reason: 'max_changed_lines_exceeded',
        changedLines: 346_978,
        maxChangedLines: 250_000,
        decisionHash: 'a'.repeat(64),
        leaseId: 'unexpected-lease',
      })
    ) as unknown as typeof fetch;
    const client = new CodexOAuthControlPlaneClient({
      apiUrl: 'https://api.reviewrouter.site',
      fetchImpl,
    });

    await expect(
      client.prelease({
        oidcToken: 'oidc-token',
        audience: 'reviewrouter',
        providerInstanceId: 'codex-rotating:123456',
        workflowSchemaVersion: 1,
      })
    ).rejects.toThrow('codex_oauth_control_plane_invalid_response');
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
