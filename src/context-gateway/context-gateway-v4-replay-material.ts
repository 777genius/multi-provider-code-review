import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'crypto';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import {
  canonicalJson,
  requireSha256,
  sha256,
} from './context-gateway-contract';
import {
  ContextGatewayV4OperationKind,
  type ContextGatewayV4OutcomeEvent,
} from './context-gateway-v4-contract';
import type { ContextGatewayV4TranscriptEvent } from './context-gateway-v4-recorder';

const MAX_ENTRIES = 2_000;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_ENCRYPTED_STATE_BYTES = Math.ceil((MAX_STATE_BYTES * 4) / 3) + 4_096;
const REPLAY_ENCRYPTION_VERSION = 1 as const;
const REPLAY_ENCRYPTION_ALGORITHM = 'aes-256-gcm' as const;

export type ContextGatewayV4ReplayMaterialEntry = Readonly<{
  sequence: number;
  operationReceiptId: string;
  operationKey: string;
  operationKind: ContextGatewayV4OperationKind;
  replayInput: Readonly<Record<string, unknown>>;
}>;

export type ContextGatewayV4ReplayMaterial = Readonly<{
  replayMaterialVersion: 2;
  sessionId: string;
  entries: readonly ContextGatewayV4ReplayMaterialEntry[];
}>;

export class ContextGatewayV4ReplayMaterialRecorder {
  private readonly entries: ContextGatewayV4ReplayMaterialEntry[] = [];
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: Readonly<{
      sessionId: string;
      replayMaterialPath: string;
      secret: Buffer;
    }>
  ) {
    assertReplaySecret(config.secret);
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.config.replayMaterialPath), {
      recursive: true,
      mode: 0o700,
    });
    try {
      await writeFile(this.config.replayMaterialPath, '', {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
    } catch {
      throw new Error('context_gateway_v4_replay_already_initialized');
    }
    await this.flush();
  }

  async resume(): Promise<void> {
    if (this.entries.length > 0) {
      throw new Error('context_gateway_v4_replay_already_active');
    }
    const encrypted = await readFile(this.config.replayMaterialPath, 'utf8');
    const raw = decryptContextGatewayV4ReplayMaterial({
      encryptedCanonicalJson: encrypted,
      secret: this.config.secret,
      sessionId: this.config.sessionId,
    });
    const parsed = JSON.parse(raw) as ContextGatewayV4ReplayMaterial;
    if (
      canonicalJson(parsed) !== raw ||
      parsed.replayMaterialVersion !== 2 ||
      parsed.sessionId !== this.config.sessionId ||
      !Array.isArray(parsed.entries) ||
      parsed.entries.length > MAX_ENTRIES
    ) {
      throw new Error('context_gateway_v4_replay_identity_invalid');
    }
    let previousSequence = 0;
    for (const candidate of parsed.entries) {
      const entry = normalizeEntry(candidate, previousSequence);
      this.entries.push(entry);
      previousSequence = entry.sequence;
    }
  }

  recordSucceeded(input: {
    readonly event: ContextGatewayV4TranscriptEvent &
      ContextGatewayV4OutcomeEvent;
    readonly replayInput: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    const operationReceiptId = input.event.operationReceiptId;
    if (!operationReceiptId) {
      throw new Error('context_gateway_v4_replay_receipt_missing');
    }
    return this.serializeMutation(async () => {
      const existing = this.entries.find(
        (entry) => entry.operationReceiptId === operationReceiptId
      );
      if (existing) {
        if (
          existing.sequence !== input.event.sequence ||
          existing.operationKey !== input.event.operationKey ||
          existing.operationKind !== input.event.operationKind ||
          canonicalJson(existing.replayInput) !==
            canonicalJson(input.replayInput)
        ) {
          throw new Error('context_gateway_v4_replay_receipt_collision');
        }
        return;
      }
      if (
        this.entries.length >= MAX_ENTRIES ||
        input.event.sequence <= (this.entries.at(-1)?.sequence ?? 0)
      ) {
        throw new Error('context_gateway_v4_replay_sequence_invalid');
      }
      const entry = normalizeEntry(
        {
          sequence: input.event.sequence,
          operationReceiptId,
          operationKey: input.event.operationKey,
          operationKind: input.event.operationKind,
          replayInput: input.replayInput,
        },
        this.entries.at(-1)?.sequence ?? 0
      );
      if (
        operationForReplayInput(entry.operationKind, entry.replayInput) !==
        input.event.operationKey
      ) {
        throw new Error('context_gateway_v4_replay_input_mismatch');
      }
      this.entries.push(entry);
      await this.flush();
    });
  }

  snapshot(): ContextGatewayV4ReplayMaterial {
    return Object.freeze({
      replayMaterialVersion: 2 as const,
      sessionId: this.config.sessionId,
      entries: Object.freeze([...this.entries]),
    });
  }

  private serializeMutation(operation: () => Promise<void>): Promise<void> {
    const mutation = this.mutationTail.then(operation);
    this.mutationTail = mutation.then(
      () => undefined,
      () => undefined
    );
    return mutation;
  }

  private async flush(): Promise<void> {
    const encrypted = encryptContextGatewayV4ReplayMaterial({
      plaintextCanonicalJson: canonicalJson(this.snapshot()),
      secret: this.config.secret,
      sessionId: this.config.sessionId,
    });
    await atomicPrivateWrite(this.config.replayMaterialPath, encrypted);
  }
}

export function decryptContextGatewayV4ReplayMaterial(input: {
  readonly encryptedCanonicalJson: string;
  readonly secret: Buffer;
  readonly sessionId: string;
}): string {
  assertReplaySecret(input.secret);
  if (
    Buffer.byteLength(input.encryptedCanonicalJson, 'utf8') >
    MAX_ENCRYPTED_STATE_BYTES
  ) {
    throw new Error('context_gateway_v4_replay_size_invalid');
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(input.encryptedCanonicalJson);
  } catch {
    throw new Error('context_gateway_v4_replay_envelope_invalid');
  }
  if (
    canonicalJson(envelope) !== input.encryptedCanonicalJson ||
    !isRecord(envelope) ||
    Object.keys(envelope).sort().join(',') !==
      'algorithm,authTag,ciphertext,encryptionVersion,nonce,sessionId' ||
    envelope.encryptionVersion !== REPLAY_ENCRYPTION_VERSION ||
    envelope.algorithm !== REPLAY_ENCRYPTION_ALGORITHM ||
    envelope.sessionId !== input.sessionId ||
    typeof envelope.nonce !== 'string' ||
    typeof envelope.authTag !== 'string' ||
    typeof envelope.ciphertext !== 'string'
  ) {
    throw new Error('context_gateway_v4_replay_envelope_invalid');
  }
  try {
    const nonce = Buffer.from(envelope.nonce, 'base64url');
    const authTag = Buffer.from(envelope.authTag, 'base64url');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64url');
    if (nonce.byteLength !== 12 || authTag.byteLength !== 16) {
      throw new Error('invalid_envelope');
    }
    const decipher = createDecipheriv(
      REPLAY_ENCRYPTION_ALGORITHM,
      replayEncryptionKey(input.secret, input.sessionId),
      nonce
    );
    decipher.setAAD(replayAssociatedData(input.sessionId));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
    if (
      Buffer.byteLength(plaintext, 'utf8') > MAX_STATE_BYTES ||
      canonicalJson(JSON.parse(plaintext)) !== plaintext
    ) {
      throw new Error('invalid_plaintext');
    }
    return plaintext;
  } catch {
    throw new Error('context_gateway_v4_replay_decryption_invalid');
  }
}

function encryptContextGatewayV4ReplayMaterial(input: {
  readonly plaintextCanonicalJson: string;
  readonly secret: Buffer;
  readonly sessionId: string;
}): string {
  assertReplaySecret(input.secret);
  if (
    Buffer.byteLength(input.plaintextCanonicalJson, 'utf8') > MAX_STATE_BYTES
  ) {
    throw new Error('context_gateway_v4_replay_size_invalid');
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    REPLAY_ENCRYPTION_ALGORITHM,
    replayEncryptionKey(input.secret, input.sessionId),
    nonce
  );
  cipher.setAAD(replayAssociatedData(input.sessionId));
  const ciphertext = Buffer.concat([
    cipher.update(input.plaintextCanonicalJson, 'utf8'),
    cipher.final(),
  ]);
  return canonicalJson({
    encryptionVersion: REPLAY_ENCRYPTION_VERSION,
    algorithm: REPLAY_ENCRYPTION_ALGORITHM,
    sessionId: input.sessionId,
    nonce: nonce.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url'),
  });
}

function replayEncryptionKey(secret: Buffer, sessionId: string): Buffer {
  return createHmac('sha256', secret)
    .update('reviewrouter.context-gateway-v4.replay-material.v1\0', 'utf8')
    .update(sessionId, 'utf8')
    .digest();
}

function replayAssociatedData(sessionId: string): Buffer {
  return Buffer.from(
    canonicalJson({
      encryptionVersion: REPLAY_ENCRYPTION_VERSION,
      algorithm: REPLAY_ENCRYPTION_ALGORITHM,
      sessionId,
    }),
    'utf8'
  );
}

function assertReplaySecret(secret: Buffer): void {
  if (!Buffer.isBuffer(secret) || secret.byteLength < 32) {
    throw new Error('context_gateway_v4_replay_secret_invalid');
  }
}

export function operationForReplayInput(
  kind: ContextGatewayV4OperationKind,
  replayInput: Readonly<Record<string, unknown>>
): string {
  switch (kind) {
    case ContextGatewayV4OperationKind.FileRead:
      return sha256(
        canonicalJson({
          kind,
          inputHash: sha256(canonicalJson(replayInput)),
        })
      );
    case ContextGatewayV4OperationKind.DirectoryList:
    case ContextGatewayV4OperationKind.CanonicalInventory:
      return sha256(
        canonicalJson({
          kind,
          inputHash: sha256(
            canonicalJson({
              ...replayInput,
              cursor:
                typeof replayInput.cursor === 'string'
                  ? sha256(replayInput.cursor)
                  : null,
            })
          ),
        })
      );
    case ContextGatewayV4OperationKind.TextSearch:
      return sha256(
        canonicalJson({
          kind,
          inputHash: sha256(
            canonicalJson({
              ...replayInput,
              query: sha256(String(replayInput.query)),
              cursor:
                typeof replayInput.cursor === 'string'
                  ? sha256(replayInput.cursor)
                  : null,
            })
          ),
        })
      );
    case ContextGatewayV4OperationKind.GitFact:
      return sha256(canonicalJson({ kind, fact: replayInput.fact }));
    case ContextGatewayV4OperationKind.UnsupportedTool:
      throw new Error('context_gateway_v4_replay_kind_unsupported');
  }
}

function normalizeEntry(
  candidate: ContextGatewayV4ReplayMaterialEntry,
  previousSequence: number
): ContextGatewayV4ReplayMaterialEntry {
  if (
    !Number.isSafeInteger(candidate.sequence) ||
    candidate.sequence <= previousSequence ||
    !Object.values(ContextGatewayV4OperationKind).includes(
      candidate.operationKind
    ) ||
    candidate.operationKind === ContextGatewayV4OperationKind.UnsupportedTool ||
    !isRecord(candidate.replayInput)
  ) {
    throw new Error('context_gateway_v4_replay_entry_invalid');
  }
  requireSha256(candidate.operationReceiptId, 'operation_receipt_id');
  requireSha256(candidate.operationKey, 'operation_key');
  return Object.freeze({
    ...candidate,
    replayInput: Object.freeze({ ...candidate.replayInput }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function atomicPrivateWrite(
  target: string,
  content: string
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
}
