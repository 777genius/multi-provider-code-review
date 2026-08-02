import { randomBytes } from 'crypto';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import {
  canonicalJson,
  keyedSha256,
  requireGitOid,
  requireSha256,
  sha256,
} from './context-gateway-contract';
import {
  CONTEXT_GATEWAY_V4_POLICY_VERSION,
  ContextGatewayV4OperationKind,
  ContextOperationFailureClass,
  ContextOperationOutcomeKind,
  type ContextGatewayV4OutcomeEvent,
} from './context-gateway-v4-contract';

const MAX_EVENTS = 2_000;
const MAX_STATE_BYTES = 4 * 1024 * 1024;

export type ContextGatewayV4TranscriptEvent = ContextGatewayV4OutcomeEvent &
  Readonly<{
    sequence: number;
    previousEventHash: string;
    eventHash: string;
    operationKey: string;
    operation: Readonly<Record<string, unknown>> & {
      readonly kind: ContextGatewayV4OperationKind;
    };
    result: Readonly<Record<string, unknown>> | null;
  }>;

export type ContextGatewayV4Transcript = Readonly<{
  transcriptVersion: 2;
  sessionId: string;
  gatewayPolicyVersion: typeof CONTEXT_GATEWAY_V4_POLICY_VERSION;
  gatewayBinaryHash: string;
  checkoutTreeOid: string;
  eventChainSeedHash: string;
  authenticatedChainHash: string;
  events: readonly ContextGatewayV4TranscriptEvent[];
  confinementTainted: boolean;
  terminalFailureClass: ContextOperationFailureClass | null;
  updatedAtMs: number;
}>;

export type ContextGatewayV4RecorderConfig = Readonly<{
  sessionId: string;
  transcriptPath: string;
  secret: Buffer;
  gatewayBinaryHash: string;
  checkoutTreeOid: string;
  eventChainSeedHash: string;
  now?: () => number;
}>;

export class ContextGatewayV4Recorder {
  private readonly events: ContextGatewayV4TranscriptEvent[] = [];
  private mutationTail: Promise<void> = Promise.resolve();
  private confinementTainted = false;
  private terminalFailureClass: ContextOperationFailureClass | null = null;
  private readonly now: () => number;

  constructor(private readonly config: ContextGatewayV4RecorderConfig) {
    requireSha256(config.gatewayBinaryHash, 'gateway_binary_hash');
    requireGitOid(config.checkoutTreeOid, 'checkout_tree_oid');
    requireSha256(config.eventChainSeedHash, 'event_chain_seed_hash');
    if (!Buffer.isBuffer(config.secret) || config.secret.byteLength < 32) {
      throw new Error('context_gateway_v4_recorder_secret_invalid');
    }
    this.now = config.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.config.transcriptPath), {
      recursive: true,
      mode: 0o700,
    });
    try {
      await writeFile(this.config.transcriptPath, '', {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
    } catch {
      throw new Error('context_gateway_v4_recorder_already_initialized');
    }
    await this.flush();
  }

  async resume(): Promise<void> {
    if (this.events.length > 0) {
      throw new Error('context_gateway_v4_recorder_already_active');
    }
    const raw = await readFile(this.config.transcriptPath, 'utf8');
    if (raw.length < 2 || Buffer.byteLength(raw, 'utf8') > MAX_STATE_BYTES) {
      throw new Error('context_gateway_v4_recorder_state_size_invalid');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('context_gateway_v4_recorder_json_invalid');
    }
    if (canonicalJson(parsed) !== raw) {
      throw new Error('context_gateway_v4_recorder_canonical_invalid');
    }
    this.restore(parsed as ContextGatewayV4Transcript);
  }

  recordSucceeded(input: {
    readonly operation: ContextGatewayV4TranscriptEvent['operation'];
    readonly result: Readonly<Record<string, unknown>>;
    readonly operationReceiptId: string;
  }): Promise<ContextGatewayV4TranscriptEvent> {
    requireSha256(input.operationReceiptId, 'operation_receipt_id');
    return this.serializeMutation(() =>
      this.append({
        outcome: ContextOperationOutcomeKind.Succeeded,
        failureClass: null,
        operation: input.operation,
        result: input.result,
        operationReceiptId: input.operationReceiptId,
        sanitizedReason: null,
      })
    );
  }

  recordRejected(input: {
    readonly operation: ContextGatewayV4TranscriptEvent['operation'];
    readonly failureClass:
      | ContextOperationFailureClass.RecoverableRequest
      | ContextOperationFailureClass.IncompleteResult
      | ContextOperationFailureClass.ConfinementViolation
      | ContextOperationFailureClass.BudgetExceeded;
    readonly sanitizedReason: string;
  }): Promise<ContextGatewayV4TranscriptEvent> {
    return this.serializeMutation(() =>
      this.append({
        outcome: ContextOperationOutcomeKind.Rejected,
        failureClass: input.failureClass,
        operation: input.operation,
        result: null,
        operationReceiptId: null,
        sanitizedReason: sanitizeReason(input.sanitizedReason),
      })
    );
  }

  recordFailed(input: {
    readonly operation: ContextGatewayV4TranscriptEvent['operation'];
    readonly sanitizedReason: string;
  }): Promise<ContextGatewayV4TranscriptEvent> {
    return this.serializeMutation(() =>
      this.append({
        outcome: ContextOperationOutcomeKind.Failed,
        failureClass: ContextOperationFailureClass.InfrastructureFailure,
        operation: input.operation,
        result: null,
        operationReceiptId: null,
        sanitizedReason: sanitizeReason(input.sanitizedReason),
      })
    );
  }

  snapshot(): ContextGatewayV4Transcript {
    return this.toTranscript();
  }

  private async append(input: {
    readonly outcome: ContextOperationOutcomeKind;
    readonly failureClass: ContextOperationFailureClass | null;
    readonly operation: ContextGatewayV4TranscriptEvent['operation'];
    readonly result: Readonly<Record<string, unknown>> | null;
    readonly operationReceiptId: string | null;
    readonly sanitizedReason: string | null;
  }): Promise<ContextGatewayV4TranscriptEvent> {
    if (this.events.length >= MAX_EVENTS) {
      this.terminalFailureClass = ContextOperationFailureClass.BudgetExceeded;
      await this.flush();
      throw new Error('context_gateway_v4_operation_limit_exceeded');
    }
    if (this.confinementTainted) {
      throw new Error('context_gateway_v4_session_tainted');
    }
    if (
      this.terminalFailureClass ===
      ContextOperationFailureClass.InfrastructureFailure
    ) {
      throw new Error('context_gateway_v4_session_terminal');
    }
    const sequence = this.events.length + 1;
    const previousEventHash =
      this.events.at(-1)?.eventHash ?? this.config.eventChainSeedHash;
    const operationKey = sha256(canonicalJson(input.operation));
    const eventIdentity = {
      sessionId: this.config.sessionId,
      sequence,
      previousEventHash,
      operationKey,
      outcome: input.outcome,
      failureClass: input.failureClass,
      operation: input.operation,
      result: input.result,
      operationReceiptId: input.operationReceiptId,
      sanitizedReason: input.sanitizedReason,
    };
    const event: ContextGatewayV4TranscriptEvent = Object.freeze({
      sequence,
      previousEventHash,
      eventHash: keyedSha256(this.config.secret, canonicalJson(eventIdentity)),
      operationKey,
      operationKind: input.operation.kind,
      outcome: input.outcome,
      failureClass: input.failureClass,
      operation: Object.freeze({ ...input.operation }),
      result: input.result ? Object.freeze({ ...input.result }) : null,
      operationReceiptId: input.operationReceiptId,
      sanitizedReason: input.sanitizedReason,
    });
    this.events.push(event);
    if (
      input.failureClass === ContextOperationFailureClass.ConfinementViolation
    ) {
      this.confinementTainted = true;
    }
    if (
      input.failureClass === ContextOperationFailureClass.InfrastructureFailure
    ) {
      this.terminalFailureClass = input.failureClass;
    }
    await this.flush();
    return event;
  }

  private restore(transcript: ContextGatewayV4Transcript): void {
    if (
      transcript.transcriptVersion !== 2 ||
      transcript.sessionId !== this.config.sessionId ||
      transcript.gatewayPolicyVersion !== CONTEXT_GATEWAY_V4_POLICY_VERSION ||
      transcript.gatewayBinaryHash !== this.config.gatewayBinaryHash ||
      transcript.checkoutTreeOid !== this.config.checkoutTreeOid ||
      transcript.eventChainSeedHash !== this.config.eventChainSeedHash ||
      !Array.isArray(transcript.events) ||
      transcript.events.length > MAX_EVENTS
    ) {
      throw new Error('context_gateway_v4_recorder_identity_invalid');
    }
    let previousEventHash = this.config.eventChainSeedHash;
    let confinementTainted = false;
    let terminalFailureClass: ContextOperationFailureClass | null = null;
    for (let index = 0; index < transcript.events.length; index += 1) {
      const event = transcript.events[index];
      const eventIdentity = {
        sessionId: this.config.sessionId,
        sequence: event.sequence,
        previousEventHash: event.previousEventHash,
        operationKey: event.operationKey,
        outcome: event.outcome,
        failureClass: event.failureClass,
        operation: event.operation,
        result: event.result,
        operationReceiptId: event.operationReceiptId,
        sanitizedReason: event.sanitizedReason,
      };
      if (
        event.sequence !== index + 1 ||
        event.previousEventHash !== previousEventHash ||
        event.operationKind !== event.operation.kind ||
        event.operationKey !== sha256(canonicalJson(event.operation)) ||
        event.eventHash !==
          keyedSha256(this.config.secret, canonicalJson(eventIdentity))
      ) {
        throw new Error('context_gateway_v4_recorder_chain_invalid');
      }
      if (
        event.failureClass === ContextOperationFailureClass.ConfinementViolation
      ) {
        confinementTainted = true;
      }
      if (
        event.failureClass ===
        ContextOperationFailureClass.InfrastructureFailure
      ) {
        terminalFailureClass = event.failureClass;
      }
      this.events.push(Object.freeze(event));
      previousEventHash = event.eventHash;
    }
    if (
      transcript.authenticatedChainHash !== previousEventHash ||
      transcript.confinementTainted !== confinementTainted ||
      transcript.terminalFailureClass !== terminalFailureClass
    ) {
      throw new Error('context_gateway_v4_recorder_state_invalid');
    }
    this.confinementTainted = confinementTainted;
    this.terminalFailureClass = terminalFailureClass;
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const mutation = this.mutationTail.then(operation);
    this.mutationTail = mutation.then(
      () => undefined,
      () => undefined
    );
    return mutation;
  }

  private toTranscript(): ContextGatewayV4Transcript {
    return Object.freeze({
      transcriptVersion: 2,
      sessionId: this.config.sessionId,
      gatewayPolicyVersion: CONTEXT_GATEWAY_V4_POLICY_VERSION,
      gatewayBinaryHash: this.config.gatewayBinaryHash,
      checkoutTreeOid: this.config.checkoutTreeOid,
      eventChainSeedHash: this.config.eventChainSeedHash,
      authenticatedChainHash:
        this.events.at(-1)?.eventHash ?? this.config.eventChainSeedHash,
      events: Object.freeze([...this.events]),
      confinementTainted: this.confinementTainted,
      terminalFailureClass: this.terminalFailureClass,
      updatedAtMs: this.now(),
    });
  }

  private async flush(): Promise<void> {
    await atomicPrivateWrite(
      this.config.transcriptPath,
      canonicalJson(this.toTranscript())
    );
  }
}

function sanitizeReason(value: string): string {
  if (!/^[a-z0-9_]{1,160}$/u.test(value)) {
    return 'operation_failed';
  }
  return value;
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
