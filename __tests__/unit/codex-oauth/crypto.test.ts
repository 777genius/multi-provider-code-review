import sodium from 'libsodium-wrappers';
import {
  buildCodexRotatingWritebackRequest,
  compactCodexAuthJsonBytes,
  computeCodexAccountIdentityHash,
  computeCodexAuthGenerationHash,
  deriveCodexStableAccountIdentityFromIdToken,
  encryptCodexAuthForGitHubSecret,
} from '../../../src/codex-oauth/crypto';

describe('Codex OAuth rotating crypto helpers', () => {
  const idToken = createIdToken({
    iss: 'https://auth.openai.com',
    sub: 'user:123',
    'https://api.openai.com/auth': { chatgpt_account_id: 'account:456' },
  });
  const prettyAuthJson = JSON.stringify(
    {
      auth_mode: 'chatgpt',
      tokens: { refresh_token: 'refresh-token-secret', id_token: idToken },
      last_refresh: '2026-05-25T00:00:00.000Z',
    },
    null,
    2
  );
  const salt = Buffer.from('generation-hash-salt-32-bytes!!').toString(
    'base64url'
  );
  const accountFingerprintSalt = Buffer.from(
    'account-fingerprint-salt-32-bytes'
  ).toString('base64url');

  it('compacts auth JSON but computes generation hashes over the exact bytes given', () => {
    const compact = compactCodexAuthJsonBytes({
      authJsonBytes: prettyAuthJson,
    });

    expect(compact.compactAuthJsonBytes).not.toBe(prettyAuthJson);
    expect(compact.compactAuthJsonBytes).toContain('refresh-token-secret');
    expect(
      computeCodexAuthGenerationHash({
        authJsonBytes: prettyAuthJson,
        generationHashSalt: salt,
      })
    ).not.toEqual(
      computeCodexAuthGenerationHash({
        authJsonBytes: compact.compactAuthJsonBytes,
        generationHashSalt: salt,
      })
    );
  });

  it('encrypts only the compact auth snapshot for GitHub secret writeback', async () => {
    await sodium.ready;
    const keyPair = sodium.crypto_box_keypair();

    const encrypted = await encryptCodexAuthForGitHubSecret({
      authJsonBytes: prettyAuthJson,
      githubPublicKeyBase64: Buffer.from(keyPair.publicKey).toString('base64'),
      githubKeyId: 'github-key-id',
      generationHashSalt: salt,
    });

    expect(encrypted.compactAuthJsonBytes).toContain('refresh-token-secret');
    expect(encrypted.encryptedValue).not.toContain('refresh-token-secret');
    expect(
      Buffer.from(encrypted.encryptedValue, 'base64').toString('utf8')
    ).not.toContain('auth_mode');
    expect(
      buildCodexRotatingWritebackRequest({
        leaseId: 'lease:12345678',
        providerInstanceId: 'codex-rotating:123456',
        generation: 2,
        latestGenerationHash: encrypted.latestGenerationHash,
        accountIdentityHash: computeCodexAccountIdentityHash({
          authJsonBytes: encrypted.compactAuthJsonBytes,
          accountFingerprintSalt,
        }),
        encryptedValue: encrypted.encryptedValue,
        keyId: encrypted.keyId,
        idempotencyKey: 'wrb:12345678',
      })
    ).toMatchObject({
      protocolVersion: 1,
      keyId: 'github-key-id',
      generation: 2,
      accountIdentityAlgorithm: 'provider_issuer_subject_account_v1',
    });
  });

  it('keeps account identity stable across token lifecycle claims', () => {
    const renewed = createIdToken({
      iss: 'https://auth.openai.com',
      sub: 'user:123',
      iat: 200,
      exp: 300,
      'https://api.openai.com/auth': { chatgpt_account_id: 'account:456' },
    });

    expect(deriveCodexStableAccountIdentityFromIdToken(renewed)).toEqual(
      deriveCodexStableAccountIdentityFromIdToken(idToken)
    );
  });
});

function createIdToken(claims: Record<string, unknown>): string {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(
    JSON.stringify(claims)
  ).toString('base64url')}.signature`;
}
