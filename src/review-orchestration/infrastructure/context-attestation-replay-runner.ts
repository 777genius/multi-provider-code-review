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
import type {
  ContextDependencyReplayCandidate,
  ContextDependencyReplayPort,
  ReviewRevisionFacts,
} from '../application';

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

export class ContextAttestationReplayRunner implements ContextDependencyReplayPort {
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
    const plan = parseReplayPlan(input.candidate);
    const [targetCheckoutTreeOid, gatewayBinaryHash] = await Promise.all([
      this.checkoutTreeOid(input.targetRevision.headSha),
      readFile(this.options.gatewayBundlePath).then(sha256),
    ]);
    if (
      plan.gatewayPolicyVersion !== CONTEXT_GATEWAY_POLICY_VERSION ||
      plan.gatewayBinaryHash !== gatewayBinaryHash
    ) {
      return null;
    }

    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'reviewrouter-context-replay-')
    );
    const secret = randomBytes(32);
    try {
      const eventChainSeedHash = sha256(
        canonicalizeReviewContextReplayChainSeed({
          planHash: input.candidate.replayPlanHash,
          attestationId: input.candidate.attestationId,
          targetReviewRevisionHash: input.targetRevision.reviewRevisionHash,
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
          input.targetRevision.baseSha.toLowerCase(),
          'target_base_sha'
        ),
        mergeBaseSha: requireGitOid(
          input.targetRevision.mergeBaseSha.toLowerCase(),
          'target_merge_base_sha'
        ),
        headSha: requireGitOid(
          input.targetRevision.headSha.toLowerCase(),
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

function parseReplayPlan(
  candidate: ContextDependencyReplayCandidate
): ReplayPlan {
  if (
    Buffer.byteLength(candidate.replayPlanCanonicalJson, 'utf8') >
      MAX_REPLAY_PLAN_BYTES ||
    sha256(candidate.replayPlanCanonicalJson) !== candidate.replayPlanHash
  ) {
    throw new Error('context_replay_plan_identity_invalid');
  }
  const parsed = JSON.parse(candidate.replayPlanCanonicalJson) as unknown;
  if (!isRecord(parsed)) throw new Error('context_replay_plan_invalid');
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
