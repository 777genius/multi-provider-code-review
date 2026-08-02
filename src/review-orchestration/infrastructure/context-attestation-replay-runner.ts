import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdtemp, readFile, rm } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import {
  canonicalizeReviewContextReplayChainSeed,
  canonicalizeReviewContextReplayEvent,
} from '../../control-plane/generated/review-action-v2/review-action-v2';
import {
  CONTEXT_GATEWAY_MAX_OPERATIONS,
  CONTEXT_GATEWAY_POLICY_VERSION,
  canonicalJson,
  requireGitOid,
  requireSha256,
  sha256,
  type ContextDependencyEntry,
} from '../../context-gateway/context-gateway-contract';
import { ContextGatewayRecorder } from '../../context-gateway/context-gateway-recorder';
import { FilesystemContextGateway } from '../../context-gateway/filesystem-context-gateway';
import {
  CONTEXT_GATEWAY_V4_POLICY_VERSION,
  ContextGatewayV4OperationKind,
  ContextGatewayV4Revision,
  ContextOperationOutcomeKind,
} from '../../context-gateway/context-gateway-v4-contract';
import { ContextGatewayV4Recorder } from '../../context-gateway/context-gateway-v4-recorder';
import { FilesystemContextGatewayV4 } from '../../context-gateway/filesystem-context-gateway-v4';
import type {
  ContextDependencyReplayCandidate,
  ContextDependencyReplayPort,
  ReviewRevisionFacts,
} from '../application';
import type {
  InvestigationReceiptReplayPort,
  PreparedInvestigationReceiptReplay,
  ReviewInvestigationTargetRevision,
} from '../../review-investigation/application';

const execFileAsync = promisify(execFile);
const MAX_REPLAY_PLAN_BYTES = 512 * 1024;

type ReplayPlanDependency = Readonly<{
  sequence: number;
  operationKey: string;
  operation: ContextDependencyEntry['operation'];
  replayQuery: string | null;
}>;

type ReplayPlan = Readonly<{
  planVersion: 1;
  attestationId: string;
  attestationHash: string;
  gatewayPolicyVersion: string;
  gatewayBinaryHash: string;
  sourceDependencies: readonly ReplayPlanDependency[];
}>;

type ReplayPlanV4Operation = Readonly<{
  operationKind: ContextGatewayV4OperationKind;
  replayInput: Readonly<Record<string, unknown>>;
}>;

type ReplayPlanV4 = Readonly<{
  planVersion: 2;
  attestationId: string;
  attestationHash: string;
  gatewayPolicyVersion: typeof CONTEXT_GATEWAY_V4_POLICY_VERSION;
  gatewayBinaryHash: string;
  sourceOperationReceiptIds: readonly string[];
  sourceOperationReceiptIdsHash: string;
  operations: readonly ReplayPlanV4Operation[];
}>;

type ReplayCandidate = Readonly<{
  attestationId: string;
  attestationHash: string;
  replayPlanCanonicalJson: string;
  replayPlanHash: string;
  sourceOperationReceiptIdsHash?: string;
}>;

export class ContextAttestationReplayRunner
  implements ContextDependencyReplayPort, InvestigationReceiptReplayPort
{
  constructor(
    private readonly options: Readonly<{
      checkoutRoot: string;
      gatewayBundlePath: string;
    }>
  ) {
    if (
      !path.isAbsolute(options.checkoutRoot) ||
      !path.isAbsolute(options.gatewayBundlePath)
    ) {
      throw new Error('context_replay_path_invalid');
    }
  }

  async replay(input: {
    readonly candidate: ContextDependencyReplayCandidate;
    readonly targetRevision: ReviewRevisionFacts;
  }) {
    return this.replayCandidate(input.candidate, input.targetRevision);
  }

  async replayReceipt(input: {
    readonly prepared: PreparedInvestigationReceiptReplay;
    readonly targetRevision: ReviewInvestigationTargetRevision;
  }) {
    return this.replayCandidate(
      {
        attestationId: input.prepared.contextAttestationId,
        attestationHash: input.prepared.contextAttestationHash,
        replayPlanCanonicalJson: input.prepared.replayPlanCanonicalJson,
        replayPlanHash: input.prepared.replayPlanHash,
        sourceOperationReceiptIdsHash:
          input.prepared.sourceOperationReceiptIdsHash,
      },
      input.targetRevision
    );
  }

  private async replayCandidate(
    candidate: ReplayCandidate,
    targetRevision: ReviewRevisionFacts | ReviewInvestigationTargetRevision
  ) {
    const plan = parseReplayPlan(candidate);
    const [targetCheckoutTreeOid, gatewayBinaryHash] = await Promise.all([
      this.checkoutTreeOid(targetRevision.headSha),
      readFile(this.options.gatewayBundlePath).then(sha256),
    ]);
    if (plan.gatewayBinaryHash !== gatewayBinaryHash) {
      return null;
    }

    if (plan.planVersion === 2) {
      return this.replayV4({
        candidate,
        plan,
        targetRevision,
        targetCheckoutTreeOid,
        gatewayBinaryHash,
      });
    }
    if (plan.gatewayPolicyVersion !== CONTEXT_GATEWAY_POLICY_VERSION) {
      return null;
    }

    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'reviewrouter-context-replay-')
    );
    const secret = randomBytes(32);
    try {
      const eventChainSeedHash = sha256(
        canonicalizeReviewContextReplayChainSeed({
          planHash: candidate.replayPlanHash,
          attestationId: candidate.attestationId,
          targetReviewRevisionHash: targetRevision.reviewRevisionHash,
          targetCheckoutTreeOid,
        })
      );
      const recorder = new ContextGatewayRecorder({
        sessionId: `replay-${plan.attestationHash}`,
        transcriptPath: path.join(directory, 'transcript.json'),
        replayMaterialPath: path.join(directory, 'replay-material.json'),
        secret,
        gatewayBinaryHash,
        checkoutTreeOid: targetCheckoutTreeOid,
        eventChainSeedHash,
      });
      const gateway = await FilesystemContextGateway.create({
        root: this.options.checkoutRoot,
        checkoutTreeOid: targetCheckoutTreeOid,
        baseSha: requireGitOid(
          targetRevision.baseSha.toLowerCase(),
          'target_base_sha'
        ),
        mergeBaseSha: requireGitOid(
          targetRevision.mergeBaseSha.toLowerCase(),
          'target_merge_base_sha'
        ),
        headSha: requireGitOid(
          targetRevision.headSha.toLowerCase(),
          'target_head_sha'
        ),
        recorder,
      });
      const dependencies: ContextDependencyEntry[] = [];
      let previousEventHash = eventChainSeedHash;
      for (const source of plan.sourceDependencies) {
        await replayOperation(gateway, source);
        const observed = recorder.snapshotDependencies().at(-1);
        if (
          !observed ||
          observed.result.complete !== true ||
          observed.result.truncated
        ) {
          return null;
        }
        const operation =
          source.operation.kind === 'git_fact'
            ? observed.operation
            : source.operation;
        const operationKey = sha256(canonicalJson(operation));
        const eventWithoutHash = {
          sequence: source.sequence,
          previousEventHash,
          operationKey,
          operation,
          result: observed.result,
        };
        const eventHash = sha256(
          canonicalizeReviewContextReplayEvent(eventWithoutHash)
        );
        dependencies.push(Object.freeze({ ...eventWithoutHash, eventHash }));
        previousEventHash = eventHash;
      }
      const replayResultCanonicalJson = canonicalJson({
        manifestVersion: 2,
        gatewayPolicyVersion: plan.gatewayPolicyVersion,
        gatewayBinaryHash,
        checkoutTreeOid: targetCheckoutTreeOid,
        authenticatedChainHash: previousEventHash,
        complete: true,
        dependencies,
      });
      return Object.freeze({
        targetCheckoutTreeOid,
        replayResultCanonicalJson,
        replayResultHash: sha256(replayResultCanonicalJson),
      });
    } finally {
      secret.fill(0);
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async replayV4(input: {
    readonly candidate: ReplayCandidate;
    readonly plan: ReplayPlanV4;
    readonly targetRevision:
      ReviewRevisionFacts | ReviewInvestigationTargetRevision;
    readonly targetCheckoutTreeOid: string;
    readonly gatewayBinaryHash: string;
  }) {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'reviewrouter-context-replay-v4-')
    );
    const secret = randomBytes(32);
    try {
      const eventChainSeedHash = sha256(
        canonicalizeReviewContextReplayChainSeed({
          planHash: input.candidate.replayPlanHash,
          attestationId: input.candidate.attestationId,
          targetReviewRevisionHash: input.targetRevision.reviewRevisionHash,
          targetCheckoutTreeOid: input.targetCheckoutTreeOid,
        })
      );
      const sessionId = `replay-v4-${input.candidate.attestationHash.slice(0, 32)}`;
      const recorder = new ContextGatewayV4Recorder({
        sessionId,
        transcriptPath: path.join(directory, 'transcript.json'),
        secret,
        gatewayBinaryHash: input.gatewayBinaryHash,
        checkoutTreeOid: input.targetCheckoutTreeOid,
        eventChainSeedHash,
      });
      await recorder.initialize();
      const gateway = await FilesystemContextGatewayV4.create({
        root: this.options.checkoutRoot,
        sessionId,
        checkoutTreeOid: input.targetCheckoutTreeOid,
        mergeBaseSha: requireGitOid(
          input.targetRevision.mergeBaseSha.toLowerCase(),
          'target_merge_base_sha'
        ),
        headSha: requireGitOid(
          input.targetRevision.headSha.toLowerCase(),
          'target_head_sha'
        ),
        secret,
        recorder,
      });
      try {
        for (const operation of input.plan.operations) {
          await replayV4Operation(gateway, operation);
        }
      } catch {
        return null;
      }
      const transcript = recorder.snapshot();
      if (
        transcript.events.length === 0 ||
        transcript.confinementTainted ||
        transcript.terminalFailureClass !== null ||
        transcript.events.some(
          (event) =>
            event.outcome !== ContextOperationOutcomeKind.Succeeded ||
            event.result === null ||
            event.operationReceiptId === null
        )
      ) {
        return null;
      }
      let previousEventHash = eventChainSeedHash;
      const events = transcript.events.map((event, index) => {
        const identity = {
          sequence: index + 1,
          previousEventHash,
          operationKey: event.operationKey,
          operation: event.operation,
          result: event.result!,
        };
        const eventHash = sha256(
          canonicalizeReviewContextReplayEvent(identity)
        );
        const synthetic = Object.freeze({
          ...identity,
          eventHash,
          operationKind: event.operationKind,
          outcome: ContextOperationOutcomeKind.Succeeded,
          failureClass: null,
          operationReceiptId: event.operationReceiptId!,
          sanitizedReason: null,
        });
        previousEventHash = eventHash;
        return synthetic;
      });
      const replayResultCanonicalJson = canonicalJson({
        manifestVersion: 3,
        gatewayPolicyVersion: CONTEXT_GATEWAY_V4_POLICY_VERSION,
        gatewayBinaryHash: input.gatewayBinaryHash,
        checkoutTreeOid: input.targetCheckoutTreeOid,
        eventChainSeedHash,
        authenticatedChainHash: previousEventHash,
        complete: true,
        confinementTainted: false,
        terminalFailureClass: null,
        events,
      });
      return Object.freeze({
        targetCheckoutTreeOid: input.targetCheckoutTreeOid,
        replayResultCanonicalJson,
        replayResultHash: sha256(replayResultCanonicalJson),
      });
    } finally {
      secret.fill(0);
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async checkoutTreeOid(expectedHeadSha: string): Promise<string> {
    const expected = requireGitOid(
      expectedHeadSha.toLowerCase(),
      'target_head_sha'
    );
    const { stdout: headOutput } = await execFileAsync(
      'git',
      ['rev-parse', 'HEAD'],
      gitOptions(this.options.checkoutRoot)
    );
    if (headOutput.trim().toLowerCase() !== expected) {
      throw new Error('context_replay_checkout_revision_mismatch');
    }
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', 'HEAD^{tree}'],
      gitOptions(this.options.checkoutRoot)
    );
    return requireGitOid(
      stdout.trim().toLowerCase(),
      'target_checkout_tree_oid'
    );
  }
}

async function replayOperation(
  gateway: FilesystemContextGateway,
  source: ReplayPlanDependency
): Promise<void> {
  const operation = source.operation as Record<string, unknown> & {
    kind: string;
  };
  switch (operation.kind) {
    case 'file_read':
      requireNoReplayQuery(source);
      await gateway.readFile({
        path: stringField(operation, 'path'),
        startByte: integerField(operation, 'startByte', 0),
        maxBytes: integerField(operation, 'maxBytes', 1),
      });
      return;
    case 'directory_list':
      requireNoReplayQuery(source);
      requireExactReplayPolicy(operation, {
        ignorePolicyHash: sha256('git-index-ignore-policy.v1'),
        caseSensitive: true,
      });
      await gateway.listDirectory({
        path: stringField(operation, 'path'),
        maxDepth: integerField(operation, 'maxDepth', 1),
        includeHidden: booleanField(operation, 'includeHidden'),
        maxEntries: integerField(operation, 'maxEntries', 1),
      });
      return;
    case 'text_search': {
      const query = source.replayQuery;
      if (!query || query.length > 4_096 || query.includes('\0')) {
        throw new Error('context_replay_query_invalid');
      }
      requireExactReplayPolicy(operation, {
        includeGlobs: [],
        excludeGlobs: [],
        ignorePolicyHash: sha256('git-grep-ignore-policy.v1'),
        binaryPolicy: 'exclude',
        encoding: 'utf8',
      });
      await gateway.searchText({
        query,
        paths: stringArrayField(operation, 'paths'),
        maxResults: integerField(operation, 'maxResults', 1),
        caseSensitive: booleanField(operation, 'caseSensitive'),
      });
      return;
    }
    case 'git_fact':
      requireNoReplayQuery(source);
      await gateway.gitFact({
        fact: enumField(operation, 'fact', [
          'changed_paths',
          'diff_stat',
          'merge_base',
        ] as const),
      });
      return;
    default:
      throw new Error('context_replay_operation_kind_invalid');
  }
}

async function replayV4Operation(
  gateway: FilesystemContextGatewayV4,
  source: ReplayPlanV4Operation
): Promise<void> {
  switch (source.operationKind) {
    case ContextGatewayV4OperationKind.FileRead:
      await gateway.readFile(fileReadInput(source.replayInput));
      return;
    case ContextGatewayV4OperationKind.DirectoryList: {
      const replayInput = directoryListInput(source.replayInput);
      await replayAllPages((cursor) =>
        gateway.listDirectory({
          ...replayInput,
          ...(cursor === null ? {} : { cursor }),
        })
      );
      return;
    }
    case ContextGatewayV4OperationKind.TextSearch: {
      const replayInput = textSearchInput(source.replayInput);
      await replayAllPages((cursor) =>
        gateway.searchText({
          ...replayInput,
          ...(cursor === null ? {} : { cursor }),
        })
      );
      return;
    }
    case ContextGatewayV4OperationKind.CanonicalInventory: {
      const replayInput = canonicalInventoryInput(source.replayInput);
      await replayAllPages((cursor) =>
        gateway.canonicalInventory({
          ...replayInput,
          ...(cursor === null ? {} : { cursor }),
        })
      );
      return;
    }
    case ContextGatewayV4OperationKind.GitFact:
      await gateway.gitFact(gitFactInput(source.replayInput));
      return;
    case ContextGatewayV4OperationKind.UnsupportedTool:
      throw new Error('context_replay_v4_operation_unsupported');
  }
}

async function replayAllPages(
  call: (cursor: string | null) => Promise<unknown>
): Promise<void> {
  let cursor: string | null = null;
  for (let page = 0; page < CONTEXT_GATEWAY_MAX_OPERATIONS; page += 1) {
    const response = await call(cursor);
    if (!isRecord(response)) {
      throw new Error('context_replay_v4_page_invalid');
    }
    if (response.complete === true) {
      if (response.nextCursor !== null) {
        throw new Error('context_replay_v4_page_terminal_invalid');
      }
      return;
    }
    if (
      response.complete !== false ||
      typeof response.nextCursor !== 'string' ||
      response.nextCursor.length === 0
    ) {
      throw new Error('context_replay_v4_page_incomplete');
    }
    cursor = response.nextCursor;
  }
  throw new Error('context_replay_v4_page_budget_exceeded');
}

function fileReadInput(input: Readonly<Record<string, unknown>>): {
  readonly path: string;
  readonly revision?: ContextGatewayV4Revision;
  readonly startByte?: number;
  readonly maxBytes?: number;
} {
  requireAllowedKeys(input, ['path', 'revision', 'startByte', 'maxBytes']);
  return Object.freeze({
    path: stringField(input, 'path'),
    ...optionalRevision(input),
    ...optionalInteger(input, 'startByte', 0),
    ...optionalInteger(input, 'maxBytes', 1),
  });
}

function directoryListInput(input: Readonly<Record<string, unknown>>): {
  readonly path: string;
  readonly revision?: ContextGatewayV4Revision;
  readonly maxDepth?: number;
  readonly includeHidden?: boolean;
  readonly pageSize?: number;
} {
  requireAllowedKeys(input, [
    'path',
    'revision',
    'maxDepth',
    'includeHidden',
    'pageSize',
  ]);
  return Object.freeze({
    path: stringField(input, 'path'),
    ...optionalRevision(input),
    ...optionalInteger(input, 'maxDepth', 1),
    ...optionalBoolean(input, 'includeHidden'),
    ...optionalInteger(input, 'pageSize', 1),
  });
}

function textSearchInput(input: Readonly<Record<string, unknown>>): {
  readonly query: string;
  readonly paths?: readonly string[];
  readonly revision?: ContextGatewayV4Revision;
  readonly caseSensitive?: boolean;
  readonly pageSize?: number;
} {
  requireAllowedKeys(input, [
    'query',
    'paths',
    'revision',
    'caseSensitive',
    'pageSize',
  ]);
  return Object.freeze({
    query: stringField(input, 'query'),
    ...optionalStringArray(input, 'paths'),
    ...optionalRevision(input),
    ...optionalBoolean(input, 'caseSensitive'),
    ...optionalInteger(input, 'pageSize', 1),
  });
}

function canonicalInventoryInput(input: Readonly<Record<string, unknown>>): {
  readonly pageSize?: number;
} {
  requireAllowedKeys(input, ['pageSize']);
  return Object.freeze({ ...optionalInteger(input, 'pageSize', 1) });
}

function gitFactInput(input: Readonly<Record<string, unknown>>): {
  readonly fact: 'merge_base' | 'changed_paths' | 'diff_stat';
} {
  requireAllowedKeys(input, ['fact']);
  return Object.freeze({
    fact: enumField(input, 'fact', [
      'merge_base',
      'changed_paths',
      'diff_stat',
    ] as const),
  });
}

function parseReplayPlan(
  candidate: ReplayCandidate
): ReplayPlan | ReplayPlanV4 {
  if (
    Buffer.byteLength(candidate.replayPlanCanonicalJson, 'utf8') >
      MAX_REPLAY_PLAN_BYTES ||
    sha256(candidate.replayPlanCanonicalJson) !== candidate.replayPlanHash
  ) {
    throw new Error('context_replay_plan_identity_invalid');
  }
  const parsed = JSON.parse(candidate.replayPlanCanonicalJson) as unknown;
  if (!isRecord(parsed)) throw new Error('context_replay_plan_invalid');
  if (canonicalJson(parsed) !== candidate.replayPlanCanonicalJson) {
    throw new Error('context_replay_plan_not_canonical');
  }
  if (parsed.planVersion === 2) {
    return parseReplayPlanV4(parsed, candidate);
  }
  requireExactKeys(parsed, [
    'attestationHash',
    'attestationId',
    'gatewayBinaryHash',
    'gatewayPolicyVersion',
    'planVersion',
    'sourceDependencies',
  ]);
  if (
    parsed.planVersion !== 1 ||
    parsed.attestationId !== candidate.attestationId ||
    parsed.attestationHash !== candidate.attestationHash ||
    !Array.isArray(parsed.sourceDependencies) ||
    parsed.sourceDependencies.length === 0 ||
    parsed.sourceDependencies.length > CONTEXT_GATEWAY_MAX_OPERATIONS
  ) {
    throw new Error('context_replay_plan_scope_invalid');
  }
  const dependencies = parsed.sourceDependencies.map((value, index) => {
    if (!isRecord(value)) throw new Error('context_replay_dependency_invalid');
    requireExactKeys(value, [
      'operation',
      'operationKey',
      'replayQuery',
      'sequence',
    ]);
    if (
      value.sequence !== index + 1 ||
      !isRecord(value.operation) ||
      (value.replayQuery !== null && typeof value.replayQuery !== 'string')
    ) {
      throw new Error('context_replay_dependency_invalid');
    }
    const operationKey = requireSha256(
      stringField(value, 'operationKey'),
      'source_operation_key'
    );
    if (operationKey !== sha256(canonicalJson(value.operation))) {
      throw new Error('context_replay_operation_identity_invalid');
    }
    return Object.freeze({
      sequence: value.sequence,
      operationKey,
      operation: Object.freeze({
        ...value.operation,
      }) as ContextDependencyEntry['operation'],
      replayQuery: value.replayQuery,
    });
  });
  return Object.freeze({
    planVersion: 1,
    attestationId: candidate.attestationId,
    attestationHash: requireSha256(
      candidate.attestationHash,
      'source_attestation_hash'
    ),
    gatewayPolicyVersion: stringField(parsed, 'gatewayPolicyVersion'),
    gatewayBinaryHash: requireSha256(
      stringField(parsed, 'gatewayBinaryHash'),
      'source_gateway_binary_hash'
    ),
    sourceDependencies: Object.freeze(dependencies),
  });
}

function parseReplayPlanV4(
  parsed: Record<string, unknown>,
  candidate: ReplayCandidate
): ReplayPlanV4 {
  requireExactKeys(parsed, [
    'attestationHash',
    'attestationId',
    'gatewayBinaryHash',
    'gatewayPolicyVersion',
    'operations',
    'planVersion',
    'sourceOperationReceiptIds',
    'sourceOperationReceiptIdsHash',
  ]);
  const sourceOperationReceiptIds = requireDigestArray(
    parsed.sourceOperationReceiptIds,
    'source_operation_receipt_ids',
    CONTEXT_GATEWAY_MAX_OPERATIONS
  );
  const sourceOperationReceiptIdsHash = requireSha256(
    stringField(parsed, 'sourceOperationReceiptIdsHash'),
    'source_operation_receipt_ids_hash'
  );
  if (
    parsed.planVersion !== 2 ||
    parsed.attestationId !== candidate.attestationId ||
    parsed.attestationHash !== candidate.attestationHash ||
    parsed.gatewayPolicyVersion !== CONTEXT_GATEWAY_V4_POLICY_VERSION ||
    sourceOperationReceiptIdsHash !==
      sha256(
        canonicalJson({ operationReceiptIds: sourceOperationReceiptIds })
      ) ||
    (candidate.sourceOperationReceiptIdsHash !== undefined &&
      candidate.sourceOperationReceiptIdsHash !==
        sourceOperationReceiptIdsHash) ||
    !Array.isArray(parsed.operations) ||
    parsed.operations.length === 0 ||
    parsed.operations.length > CONTEXT_GATEWAY_MAX_OPERATIONS
  ) {
    throw new Error('context_replay_v4_plan_scope_invalid');
  }
  const operations = parsed.operations.map((value) => {
    if (!isRecord(value))
      throw new Error('context_replay_v4_operation_invalid');
    requireExactKeys(value, ['operationKind', 'replayInput']);
    const operationKind = enumField(value, 'operationKind', [
      ContextGatewayV4OperationKind.FileRead,
      ContextGatewayV4OperationKind.DirectoryList,
      ContextGatewayV4OperationKind.TextSearch,
      ContextGatewayV4OperationKind.CanonicalInventory,
      ContextGatewayV4OperationKind.GitFact,
    ] as const);
    if (!isRecord(value.replayInput)) {
      throw new Error('context_replay_v4_input_invalid');
    }
    return Object.freeze({
      operationKind,
      replayInput: Object.freeze({ ...value.replayInput }),
    });
  });
  return Object.freeze({
    planVersion: 2,
    attestationId: candidate.attestationId,
    attestationHash: requireSha256(
      candidate.attestationHash,
      'source_attestation_hash'
    ),
    gatewayPolicyVersion: CONTEXT_GATEWAY_V4_POLICY_VERSION,
    gatewayBinaryHash: requireSha256(
      stringField(parsed, 'gatewayBinaryHash'),
      'source_gateway_binary_hash'
    ),
    sourceOperationReceiptIds,
    sourceOperationReceiptIdsHash,
    operations: Object.freeze(operations),
  });
}

function gitOptions(cwd: string) {
  return {
    cwd,
    encoding: 'utf8' as const,
    timeout: 30_000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  };
}

function requireNoReplayQuery(source: ReplayPlanDependency): void {
  if (source.replayQuery !== null) {
    throw new Error('context_replay_query_unexpected');
  }
}

function requireExactReplayPolicy(
  operation: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  for (const [key, value] of Object.entries(expected)) {
    if (canonicalJson(operation[key]) !== canonicalJson(value)) {
      throw new Error('context_replay_policy_unsupported');
    }
  }
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== 'string' || result.length === 0) {
    throw new Error(`context_replay_${field}_invalid`);
  }
  return result;
}

function stringArrayField(
  value: Record<string, unknown>,
  field: string
): readonly string[] {
  const result = value[field];
  if (
    !Array.isArray(result) ||
    result.length === 0 ||
    result.some((entry) => typeof entry !== 'string')
  ) {
    throw new Error(`context_replay_${field}_invalid`);
  }
  return result;
}

function requireDigestArray(
  value: unknown,
  field: string,
  maximum: number
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new Error(`context_replay_${field}_invalid`);
  }
  const result = value.map((entry) => requireSha256(entry, field));
  const sorted = [...result].sort(compareCodeUnits);
  if (
    new Set(result).size !== result.length ||
    canonicalJson(result) !== canonicalJson(sorted)
  ) {
    throw new Error(`context_replay_${field}_invalid`);
  }
  return Object.freeze(result);
}

function integerField(
  value: Record<string, unknown>,
  field: string,
  minimum: number
): number {
  const result = value[field];
  if (!Number.isSafeInteger(result) || (result as number) < minimum) {
    throw new Error(`context_replay_${field}_invalid`);
  }
  return result as number;
}

function booleanField(value: Record<string, unknown>, field: string): boolean {
  const result = value[field];
  if (typeof result !== 'boolean') {
    throw new Error(`context_replay_${field}_invalid`);
  }
  return result;
}

function optionalRevision(value: Readonly<Record<string, unknown>>): {
  readonly revision?: ContextGatewayV4Revision;
} {
  if (value.revision === undefined) return {};
  return {
    revision: enumField(value, 'revision', [
      ContextGatewayV4Revision.Head,
      ContextGatewayV4Revision.MergeBase,
    ] as const),
  };
}

function optionalInteger<Field extends string>(
  value: Readonly<Record<string, unknown>>,
  field: Field,
  minimum: number
): Partial<Readonly<Record<Field, number>>> {
  if (value[field] === undefined) return {};
  return { [field]: integerField(value, field, minimum) } as Partial<
    Readonly<Record<Field, number>>
  >;
}

function optionalBoolean<Field extends string>(
  value: Readonly<Record<string, unknown>>,
  field: Field
): Partial<Readonly<Record<Field, boolean>>> {
  if (value[field] === undefined) return {};
  return { [field]: booleanField(value, field) } as Partial<
    Readonly<Record<Field, boolean>>
  >;
}

function optionalStringArray<Field extends string>(
  value: Readonly<Record<string, unknown>>,
  field: Field
): Partial<Readonly<Record<Field, readonly string[]>>> {
  if (value[field] === undefined) return {};
  return { [field]: stringArrayField(value, field) } as Partial<
    Readonly<Record<Field, readonly string[]>>
  >;
}

function enumField<const Values extends readonly string[]>(
  value: Record<string, unknown>,
  field: string,
  values: Values
): Values[number] {
  const result = stringField(value, field);
  if (!values.includes(result)) {
    throw new Error(`context_replay_${field}_invalid`);
  }
  return result as Values[number];
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): void {
  const actual = Object.keys(value).sort();
  if (canonicalJson(actual) !== canonicalJson([...expected].sort())) {
    throw new Error('context_replay_object_shape_invalid');
  }
}

function requireAllowedKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[]
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new Error('context_replay_object_shape_invalid');
  }
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
