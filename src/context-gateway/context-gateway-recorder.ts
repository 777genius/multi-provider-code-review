import { randomBytes } from 'crypto';
import { mkdir, rename, writeFile } from 'fs/promises';
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

async function atomicPrivateWrite(
  target: string,
  content: string
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
}
