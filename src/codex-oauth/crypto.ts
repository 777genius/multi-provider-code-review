import { createHash, createHmac, randomUUID } from 'crypto';
import sodium from 'libsodium-wrappers';

export const CODEX_ROTATING_SECRET_NAME = 'REVIEWROUTER_CODEX_AUTH_JSON';
export const CODEX_ROTATING_AUTH_JSON_MAX_BYTES = 32 * 1024;

export type CompactCodexAuthJsonResult = {
  compactAuthJsonBytes: string;
  byteLength: number;
  exactBytesSha256: string;
};

export type CodexRotatingEncryptedWriteback = {
  compactAuthJsonBytes: string;
  compactByteLength: number;
  latestGenerationHash: string;
  encryptedValue: string;
  keyId: string;
};

export function compactCodexAuthJsonBytes(input: {
  authJsonBytes: string;
}): CompactCodexAuthJsonResult {
  const byteLength = Buffer.byteLength(input.authJsonBytes, 'utf8');
  if (byteLength === 0) {
    throw new Error('codex_auth_json_empty');
  }
  if (byteLength > CODEX_ROTATING_AUTH_JSON_MAX_BYTES) {
    throw new Error('codex_auth_json_too_large');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.authJsonBytes);
  } catch {
    throw new Error('codex_auth_json_invalid_json');
  }

  assertCodexChatGptAuth(parsed);
  const compactAuthJsonBytes = JSON.stringify(parsed);
  const compactByteLength = Buffer.byteLength(compactAuthJsonBytes, 'utf8');
  if (compactByteLength > CODEX_ROTATING_AUTH_JSON_MAX_BYTES) {
    throw new Error('codex_auth_json_too_large_after_compact');
  }

  return {
    compactAuthJsonBytes,
    byteLength: compactByteLength,
    exactBytesSha256: createHash('sha256')
      .update(input.authJsonBytes, 'utf8')
      .digest('hex'),
  };
}

export function computeCodexAuthGenerationHash(input: {
  authJsonBytes: string;
  generationHashSalt: string;
}): string {
  const salt = decodeSalt(input.generationHashSalt);
  if (salt.length < 16) {
    throw new Error('generation_hash_salt_too_short');
  }
  return createHmac('sha256', salt)
    .update(input.authJsonBytes, 'utf8')
    .digest('base64url');
}

export function computeCodexAccountIdentityHash(input: {
  authJsonBytes: string;
  accountFingerprintSalt: string;
}): string {
  const auth = JSON.parse(input.authJsonBytes) as {
    tokens?: { id_token?: unknown };
  };
  const idToken = auth.tokens?.id_token;
  if (typeof idToken !== 'string') {
    throw new Error('codex_account_identity_id_token_required');
  }
  const identity = deriveCodexStableAccountIdentityFromIdToken(idToken);
  const salt = decodeAccountFingerprintSalt(input.accountFingerprintSalt);
  if (salt.length < 16) {
    throw new Error('codex_account_identity_salt_invalid');
  }
  return createHmac('sha256', salt)
    .update(
      JSON.stringify({
        issuer: identity.issuer,
        subject: identity.subject,
        chatgptAccountId: identity.chatgptAccountId,
      }),
      'utf8'
    )
    .digest('base64url');
}

export function deriveCodexStableAccountIdentityFromIdToken(idToken: string): {
  issuer: string;
  subject: string;
  chatgptAccountId: string;
} {
  let claims: Record<string, unknown>;
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('jwt_shape');
    claims = JSON.parse(
      Buffer.from(parts[1]!, 'base64url').toString('utf8')
    ) as Record<string, unknown>;
  } catch {
    throw new Error('codex_account_identity_token_invalid');
  }
  const auth =
    claims['https://api.openai.com/auth'] &&
    typeof claims['https://api.openai.com/auth'] === 'object'
      ? (claims['https://api.openai.com/auth'] as Record<string, unknown>)
      : {};
  const accountIds = [
    claims.chatgpt_account_id,
    claims.account_id,
    auth.chatgpt_account_id,
    auth.account_id,
  ].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
  if (new Set(accountIds).size !== 1) {
    throw new Error('codex_account_identity_account_id_invalid');
  }
  return {
    issuer: requireStableIdentityClaim(claims.iss),
    subject: requireStableIdentityClaim(claims.sub),
    chatgptAccountId: accountIds[0]!,
  };
}

export async function encryptCodexAuthForGitHubSecret(input: {
  authJsonBytes: string;
  githubPublicKeyBase64: string;
  githubKeyId: string;
  generationHashSalt: string;
}): Promise<CodexRotatingEncryptedWriteback> {
  const compact = compactCodexAuthJsonBytes({
    authJsonBytes: input.authJsonBytes,
  });
  await sodium.ready;
  const publicKey = Buffer.from(input.githubPublicKeyBase64, 'base64');
  if (publicKey.length !== sodium.crypto_box_PUBLICKEYBYTES) {
    throw new Error('github_secret_public_key_invalid');
  }

  const encrypted = sodium.crypto_box_seal(
    compact.compactAuthJsonBytes,
    publicKey
  );
  return {
    compactAuthJsonBytes: compact.compactAuthJsonBytes,
    compactByteLength: compact.byteLength,
    latestGenerationHash: computeCodexAuthGenerationHash({
      authJsonBytes: compact.compactAuthJsonBytes,
      generationHashSalt: input.generationHashSalt,
    }),
    encryptedValue: Buffer.from(encrypted).toString('base64'),
    keyId: input.githubKeyId,
  };
}

export function buildCodexRotatingWritebackRequest(input: {
  leaseId: string;
  providerInstanceId: string;
  generation: number;
  latestGenerationHash: string;
  accountIdentityHash: string;
  encryptedValue: string;
  keyId: string;
  idempotencyKey?: string;
}) {
  if (looksLikePlaintextAuthJson(input.encryptedValue)) {
    throw new Error('writeback_plaintext_auth_rejected');
  }
  return {
    protocolVersion: 1 as const,
    leaseId: input.leaseId,
    providerInstanceId: input.providerInstanceId,
    generation: input.generation,
    latestGenerationHash: input.latestGenerationHash,
    accountIdentityHash: input.accountIdentityHash,
    accountIdentityAlgorithm: 'provider_issuer_subject_account_v1' as const,
    encryptedValue: input.encryptedValue,
    keyId: input.keyId,
    idempotencyKey: input.idempotencyKey ?? `wrb:${randomUUID()}`,
  };
}

function requireStableIdentityClaim(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('codex_account_identity_claim_invalid');
  }
  return value;
}

function decodeAccountFingerprintSalt(value: string): Buffer {
  if (!/^[A-Za-z0-9_+/=-]+$/.test(value)) {
    throw new Error('codex_account_identity_salt_invalid');
  }
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    throw new Error('codex_account_identity_salt_invalid');
  }
}

function assertCodexChatGptAuth(value: unknown): asserts value is {
  auth_mode: 'chatgpt';
  tokens: { refresh_token: string };
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('codex_auth_json_invalid_shape');
  }
  const record = value as {
    auth_mode?: unknown;
    tokens?: { refresh_token?: unknown };
  };
  if (record.auth_mode !== 'chatgpt') {
    throw new Error('codex_auth_json_auth_mode_not_chatgpt');
  }
  if (
    !record.tokens ||
    typeof record.tokens.refresh_token !== 'string' ||
    record.tokens.refresh_token.length === 0
  ) {
    throw new Error('codex_auth_json_refresh_token_missing');
  }
}

function decodeSalt(value: string): Buffer {
  if (!/^[A-Za-z0-9_+/=-]+$/.test(value)) {
    throw new Error('generation_hash_salt_invalid');
  }
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    return Buffer.from(value, 'base64');
  }
}

function looksLikePlaintextAuthJson(value: string): boolean {
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    return decoded.includes('"auth_mode"') || decoded.includes('refresh_token');
  } catch {
    return value.includes('"auth_mode"') || value.includes('refresh_token');
  }
}
