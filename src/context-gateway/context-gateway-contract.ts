import { createHash, createHmac } from 'crypto';

export const CONTEXT_GATEWAY_MANIFEST_VERSION = 2 as const;
export const CONTEXT_GATEWAY_POLICY_VERSION = 'context-gateway-v3' as const;
export const CONTEXT_GATEWAY_MAX_OPERATIONS = 2_000;
export const CONTEXT_GIT_DIFF_POLICY_VERSION = 'git-diff-stat-v2' as const;

export type ContextDependencyKind =
  'file_read' | 'directory_list' | 'text_search' | 'git_fact';

export type ContextGitFactKind = 'changed_paths' | 'diff_stat' | 'merge_base';

export type ContextDependencyEntry = Readonly<{
  sequence: number;
  previousEventHash: string;
  eventHash: string;
  operationKey: string;
  operation: Readonly<Record<string, unknown>> & {
    readonly kind: ContextDependencyKind;
  };
  result: Readonly<Record<string, unknown>> & {
    readonly kind: ContextDependencyKind;
    readonly complete: boolean;
    readonly truncated: boolean;
  };
}>;

export type ContextGatewayTranscript = Readonly<{
  transcriptVersion: 1;
  sessionId: string;
  gatewayPolicyVersion: typeof CONTEXT_GATEWAY_POLICY_VERSION;
  gatewayBinaryHash: string;
  checkoutTreeOid: string;
  eventChainSeedHash: string;
  authenticatedChainHash: string;
  dependencies: readonly ContextDependencyEntry[];
  hadFailure: boolean;
  updatedAtMs: number;
}>;

export type ContextGatewayReplayMaterial = Readonly<{
  replayMaterialVersion: 1;
  sessionId: string;
  entries: readonly Readonly<{
    replayHandle: string;
    operationKey: string;
    kind: 'text_search';
    query: string;
  }>[];
}>;

export enum ChangedPathsWitnessStatus {
  Present = 'present',
  Missing = 'missing',
  Invalid = 'invalid',
}

export function contextGitFactOperandsHash(
  input:
    | Readonly<{
        fact: 'changed_paths';
        mergeBaseTreeOid: string;
        headTreeOid: string;
      }>
    | Readonly<{
        fact: 'diff_stat';
        mergeBaseTreeOid: string;
        headTreeOid: string;
        diffPolicyHash: string;
      }>
    | Readonly<{
        fact: 'merge_base';
        mergeBaseSha: string;
      }>
): string {
  switch (input.fact) {
    case 'changed_paths':
      return sha256(
        canonicalJson({
          mergeBaseTreeOid: requireGitOid(
            input.mergeBaseTreeOid,
            'merge_base_tree_oid'
          ),
          headTreeOid: requireGitOid(input.headTreeOid, 'head_tree_oid'),
        })
      );
    case 'diff_stat':
      return sha256(
        canonicalJson({
          diffPolicyHash: requireSha256(
            input.diffPolicyHash,
            'diff_policy_hash'
          ),
          mergeBaseTreeOid: requireGitOid(
            input.mergeBaseTreeOid,
            'merge_base_tree_oid'
          ),
          headTreeOid: requireGitOid(input.headTreeOid, 'head_tree_oid'),
        })
      );
    case 'merge_base':
      return sha256(
        canonicalJson({
          mergeBaseSha: requireGitOid(input.mergeBaseSha, 'merge_base_sha'),
        })
      );
  }
}

export function contextGitDiffPolicyHash(
  infoAttributesHash: string | null
): string {
  return sha256(
    canonicalJson({
      infoAttributesHash:
        infoAttributesHash === null
          ? null
          : requireSha256(infoAttributesHash, 'info_attributes_hash'),
      policyVersion: CONTEXT_GIT_DIFF_POLICY_VERSION,
    })
  );
}

export function changedPathsWitnessStatus(
  transcript: ContextGatewayTranscript,
  expectedOperandsHash: string
): ChangedPathsWitnessStatus {
  let foundCandidate = false;
  for (const dependency of transcript.dependencies) {
    const operation = dependency.operation;
    if (operation.kind !== 'git_fact' || operation.fact !== 'changed_paths') {
      continue;
    }
    foundCandidate = true;
    const result = dependency.result;
    if (
      hasExactKeys(operation, ['kind', 'fact', 'operandsHash']) &&
      hasExactKeys(result, [
        'kind',
        'resultHash',
        'itemCount',
        'byteCount',
        'complete',
        'truncated',
      ]) &&
      operation.operandsHash === expectedOperandsHash &&
      result.kind === 'git_fact' &&
      isSha256(result.resultHash) &&
      isNonNegativeSafeInteger(result.itemCount) &&
      isNonNegativeSafeInteger(result.byteCount) &&
      result.complete === true &&
      result.truncated === false
    ) {
      return ChangedPathsWitnessStatus.Present;
    }
  }
  return foundCandidate
    ? ChangedPathsWitnessStatus.Invalid
    : ChangedPathsWitnessStatus.Missing;
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return '{"$undefined":true}';
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('context_gateway_non_finite_number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('context_gateway_canonical_value_invalid');
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function keyedSha256(secret: Buffer, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function requireSha256(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

export function requireGitOid(value: string, field: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
