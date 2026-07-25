import { randomBytes } from 'crypto';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import * as path from 'path';
import {
  canonicalizeReviewContextGatewayEvent,
  canonicalizeReviewContextReplayHandle,
  canonicalizeReviewContextSearchQuery,
} from '../control-plane/generated/review-action-v2/review-action-v2';
import {
  CONTEXT_GATEWAY_MAX_OPERATIONS,
  CONTEXT_GATEWAY_POLICY_VERSION,
  canonicalJson,
  keyedSha256,
  requireGitOid,
  requireSha256,
  sha256,
  type ContextDependencyEntry,
  type ContextGatewayReplayMaterial,
  type ContextGatewayTranscript,
} from './context-gateway-contract';

export type ContextGatewayRecorderConfig = Readonly<{
  sessionId: string;
  transcriptPath: string;
  replayMaterialPath: string;
  secret: Buffer;
  gatewayBinaryHash: string;
  checkoutTreeOid: string;
  eventChainSeedHash: string;
}>;

const MAX_RECORDER_STATE_BYTES = 512 * 1024;

export class ContextGatewayRecorder {
  private readonly dependencies: ContextDependencyEntry[] = [];
  private readonly replayEntries: Array<
    ContextGatewayReplayMaterial['entries'][number]
  > = [];
  private hadFailure = false;

  constructor(private readonly config: ContextGatewayRecorderConfig) {
    requireSha256(config.gatewayBinaryHash, 'gateway_binary_hash');
    requireGitOid(config.checkoutTreeOid, 'checkout_tree_oid');
    requireSha256(config.eventChainSeedHash, 'event_chain_seed_hash');
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(path.dirname(this.config.transcriptPath), {
        recursive: true,
        mode: 0o700,
      }),
      mkdir(path.dirname(this.config.replayMaterialPath), {
        recursive: true,
        mode: 0o700,
      }),
    ]);
    try {
      await writeFile(this.config.transcriptPath, '', {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await writeFile(this.config.replayMaterialPath, '', {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
    } catch {
      throw new Error('context_gateway_recorder_already_initialized');
    }
    await this.flush();
  }

  async resume(): Promise<void> {
    if (this.dependencies.length > 0 || this.replayEntries.length > 0) {
      throw new Error('context_gateway_recorder_already_active');
    }
    const [transcriptRaw, replayRaw] = await Promise.all([
      readBoundedState(this.config.transcriptPath),
      readBoundedState(this.config.replayMaterialPath),
    ]);
    const transcript = parseCanonicalState<ContextGatewayTranscript>(
      transcriptRaw,
      'transcript'
    );
    const replay = parseCanonicalState<ContextGatewayReplayMaterial>(
      replayRaw,
      'replay_material'
    );
    this.restoreTranscript(transcript);
    this.restoreReplayMaterial(replay);
  }

  async record(
    operation: ContextDependencyEntry['operation'],
    result: ContextDependencyEntry['result'],
    replayQuery?: string
  ): Promise<ContextDependencyEntry> {
    if (this.dependencies.length >= CONTEXT_GATEWAY_MAX_OPERATIONS) {
      await this.recordFailure();
      throw new Error('context_gateway_operation_limit_exceeded');
    }
    const sequence = this.dependencies.length + 1;
    const previousEventHash =
      this.dependencies.at(-1)?.eventHash ?? this.config.eventChainSeedHash;
    const operationKey = sha256(canonicalJson(operation));
    let replayHandle: string | undefined;
    if (replayQuery !== undefined) {
      replayHandle = keyedSha256(
        this.config.secret,
        canonicalizeReviewContextReplayHandle({
          sessionId: this.config.sessionId,
          sequence,
          query: replayQuery,
        })
      );
      this.replayEntries.push(
        Object.freeze({
          replayHandle,
          operationKey,
          kind: 'text_search' as const,
          query: replayQuery,
        })
      );
    }
    const eventWithoutHash = {
      sequence,
      previousEventHash,
      operationKey,
      operation,
      result,
    };
    const eventHash = keyedSha256(
      this.config.secret,
      canonicalizeReviewContextGatewayEvent({
        sessionId: this.config.sessionId,
        ...eventWithoutHash,
      })
    );
    const entry = Object.freeze({
      ...eventWithoutHash,
      eventHash,
    });
    this.dependencies.push(entry);
    if (result.complete !== true || result.truncated !== false) {
      this.hadFailure = true;
    }
    await this.flush();
    return entry;
  }

  async recordFailure(): Promise<void> {
    this.hadFailure = true;
    await this.flush();
  }

  createReplayReference(query: string): Readonly<{
    queryDigest: string;
    replayHandleHash: string;
  }> {
    const sequence = this.dependencies.length + 1;
    const replayHandle = keyedSha256(
      this.config.secret,
      canonicalizeReviewContextReplayHandle({
        sessionId: this.config.sessionId,
        sequence,
        query,
      })
    );
    return Object.freeze({
      queryDigest: keyedSha256(
        this.config.secret,
        canonicalizeReviewContextSearchQuery(query)
      ),
      replayHandleHash: sha256(replayHandle),
    });
  }

  snapshotDependencies(): readonly ContextDependencyEntry[] {
    return Object.freeze([...this.dependencies]);
  }

  private restoreTranscript(transcript: ContextGatewayTranscript): void {
    if (
      transcript.transcriptVersion !== 1 ||
      transcript.sessionId !== this.config.sessionId ||
      transcript.gatewayPolicyVersion !== CONTEXT_GATEWAY_POLICY_VERSION ||
      transcript.gatewayBinaryHash !== this.config.gatewayBinaryHash ||
      transcript.checkoutTreeOid !== this.config.checkoutTreeOid ||
      transcript.eventChainSeedHash !== this.config.eventChainSeedHash ||
      typeof transcript.hadFailure !== 'boolean' ||
      !Number.isSafeInteger(transcript.updatedAtMs) ||
      transcript.updatedAtMs < 0 ||
      !Array.isArray(transcript.dependencies) ||
      transcript.dependencies.length > CONTEXT_GATEWAY_MAX_OPERATIONS
    ) {
      throw new Error('context_gateway_recorder_transcript_identity_invalid');
    }
    let previousEventHash = this.config.eventChainSeedHash;
    for (let index = 0; index < transcript.dependencies.length; index += 1) {
      const entry = transcript.dependencies[index];
      if (
        !entry ||
        entry.sequence !== index + 1 ||
        entry.previousEventHash !== previousEventHash ||
        entry.operationKey !== sha256(canonicalJson(entry.operation)) ||
        entry.eventHash !==
          keyedSha256(
            this.config.secret,
            canonicalizeReviewContextGatewayEvent({
              sessionId: this.config.sessionId,
              sequence: entry.sequence,
              previousEventHash: entry.previousEventHash,
              operationKey: entry.operationKey,
              operation: entry.operation,
              result: entry.result,
            })
          ) ||
        typeof entry.result?.complete !== 'boolean' ||
        typeof entry.result?.truncated !== 'boolean'
      ) {
        throw new Error('context_gateway_recorder_transcript_chain_invalid');
      }
      this.dependencies.push(Object.freeze(entry));
      previousEventHash = entry.eventHash;
    }
    if (
      transcript.authenticatedChainHash !== previousEventHash ||
      (this.dependencies.some(
        (entry) =>
          entry.result.complete !== true || entry.result.truncated !== false
      ) &&
        !transcript.hadFailure)
    ) {
      throw new Error('context_gateway_recorder_transcript_state_invalid');
    }
    this.hadFailure = transcript.hadFailure;
  }

  private restoreReplayMaterial(replay: ContextGatewayReplayMaterial): void {
    if (
      replay.replayMaterialVersion !== 1 ||
      replay.sessionId !== this.config.sessionId ||
      !Array.isArray(replay.entries) ||
      replay.entries.length > this.dependencies.length
    ) {
      throw new Error('context_gateway_recorder_replay_identity_invalid');
    }
    for (const entry of replay.entries) {
      if (
        !entry ||
        entry.kind !== 'text_search' ||
        typeof entry.query !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(entry.operationKey) ||
        !/^[a-f0-9]{64}$/u.test(entry.replayHandle)
      ) {
        throw new Error('context_gateway_recorder_replay_entry_invalid');
      }
      const matchingDependency = this.dependencies.find(
        (dependency) =>
          dependency.operationKey === entry.operationKey &&
          dependency.operation.kind === 'text_search' &&
          entry.replayHandle ===
            keyedSha256(
              this.config.secret,
              canonicalizeReviewContextReplayHandle({
                sessionId: this.config.sessionId,
                sequence: dependency.sequence,
                query: entry.query,
              })
            )
      );
      if (!matchingDependency) {
        throw new Error('context_gateway_recorder_replay_chain_invalid');
      }
      this.replayEntries.push(Object.freeze(entry));
    }
  }

  private async flush(): Promise<void> {
    const transcript: ContextGatewayTranscript = Object.freeze({
      transcriptVersion: 1,
      sessionId: this.config.sessionId,
      gatewayPolicyVersion: CONTEXT_GATEWAY_POLICY_VERSION,
      gatewayBinaryHash: this.config.gatewayBinaryHash,
      checkoutTreeOid: this.config.checkoutTreeOid,
      eventChainSeedHash: this.config.eventChainSeedHash,
      authenticatedChainHash:
        this.dependencies.at(-1)?.eventHash ?? this.config.eventChainSeedHash,
      dependencies: Object.freeze([...this.dependencies]),
      hadFailure: this.hadFailure,
      updatedAtMs: Date.now(),
    });
    const replay: ContextGatewayReplayMaterial = Object.freeze({
      replayMaterialVersion: 1,
      sessionId: this.config.sessionId,
      entries: Object.freeze([...this.replayEntries]),
    });
    await Promise.all([
      atomicPrivateWrite(this.config.transcriptPath, canonicalJson(transcript)),
      atomicPrivateWrite(this.config.replayMaterialPath, canonicalJson(replay)),
    ]);
  }
}

async function readBoundedState(file: string): Promise<string> {
  const value = await readFile(file, 'utf8');
  if (
    value.length < 2 ||
    Buffer.byteLength(value, 'utf8') > MAX_RECORDER_STATE_BYTES
  ) {
    throw new Error('context_gateway_recorder_state_size_invalid');
  }
  return value;
}

function parseCanonicalState<T>(raw: string, kind: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`context_gateway_recorder_${kind}_json_invalid`);
  }
  if (canonicalJson(parsed) !== raw) {
    throw new Error(`context_gateway_recorder_${kind}_canonical_invalid`);
  }
  return parsed as T;
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
