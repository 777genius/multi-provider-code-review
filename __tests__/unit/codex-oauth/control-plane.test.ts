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
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
