import {
  ReviewAgentExecutionProfile,
  ReviewAgentProviderKind,
} from './runtime-profile';
import { canonicalJson, sha256 } from './canonical-json';

export const REVIEW_TURN_OUTPUT_VERSION = 2 as const;
export const REVIEW_TURN_OBSERVATION_VERSION = 2 as const;
const MAX_COLLECTION_ITEMS = 256;
export const REVIEW_TURN_MAX_OBLIGATION_PROPOSALS = 128;
const MAX_CANONICAL_SUBJECT_LENGTH = 4_096;
const MAX_CANONICAL_REQUIREMENT_LENGTH = 64_000;
const MAX_RISK_PRIORITY = 1_000_000;
const MAX_PROPOSAL_PATH_LENGTH = 2_000;
const COMPLETE_FILE_REQUIREMENT_VERSION = 1 as const;
const COMPLETE_FILE_REQUIREMENT_KIND = 'complete_file' as const;
const FILE_READ_SUBJECT_KIND = 'file_read' as const;
const FILE_READ_SUBJECT_VERSION = 1 as const;

export enum ReviewTurnPurpose {
  Discovery = 'discovery',
  Critic = 'critic',
}

export enum ReviewTurnFindingSeverity {
  Critical = 'critical',
  Major = 'major',
  Minor = 'minor',
}

export enum ReviewTurnObligationKind {
  InventoryWitness = 'inventory_witness',
  ChangedContent = 'changed_content',
  BaseContent = 'base_content',
  RelatedManifest = 'related_manifest',
  DirectReferenceSearch = 'direct_reference_search',
  DirectCaller = 'direct_caller',
  DirectCallee = 'direct_callee',
  TestEvidence = 'test_evidence',
  SchemaContract = 'schema_contract',
  ConfigurationContract = 'configuration_contract',
  MigrationContract = 'migration_contract',
  GeneratedSource = 'generated_source',
  DependencyContract = 'dependency_contract',
  SideEffectParity = 'side_effect_parity',
  ExternalContract = 'external_contract',
  BinaryArtifact = 'binary_artifact',
  ContextCritic = 'context_critic',
}

export const REVIEW_TURN_PROVIDER_PROPOSABLE_OBLIGATION_KINDS = Object.freeze([
  ReviewTurnObligationKind.BaseContent,
  ReviewTurnObligationKind.RelatedManifest,
  ReviewTurnObligationKind.DirectCaller,
  ReviewTurnObligationKind.DirectCallee,
  ReviewTurnObligationKind.TestEvidence,
  ReviewTurnObligationKind.SchemaContract,
  ReviewTurnObligationKind.ConfigurationContract,
  ReviewTurnObligationKind.MigrationContract,
  ReviewTurnObligationKind.GeneratedSource,
  ReviewTurnObligationKind.DependencyContract,
  ReviewTurnObligationKind.SideEffectParity,
  ReviewTurnObligationKind.ExternalContract,
] as const);

export type ReviewTurnProviderProposableObligationKind =
  (typeof REVIEW_TURN_PROVIDER_PROPOSABLE_OBLIGATION_KINDS)[number];

export enum ReviewTurnProposalRevision {
  Head = 'head',
  MergeBase = 'merge_base',
}

export enum ReviewTurnCriticDecision {
  Accept = 'accept',
  Veto = 'veto',
  Abstain = 'abstain',
}

export type ReviewTurnObligationProposal = Readonly<{
  kind: ReviewTurnProviderProposableObligationKind;
  canonicalSubject: string;
  canonicalRequirement: string;
  /** Advisory only. The control plane owns normalization and critic policy. */
  riskPriority: number;
}>;

export type ReviewAgentTurnOutput = Readonly<{
  outputVersion: typeof REVIEW_TURN_OUTPUT_VERSION;
  findings: readonly Readonly<{
    severity: ReviewTurnFindingSeverity;
    title: string;
    body: string;
    path: string;
    line: number | null;
    evidenceOperationReceiptIds: readonly string[];
  }>[];
  obligationProposals: readonly ReviewTurnObligationProposal[];
  closureClaims: readonly Readonly<{
    obligationId: string;
    operationReceiptIds: readonly string[];
  }>[];
  operationBackedDiscoveryClaims: readonly Readonly<{
    sourceObligationId: string;
    query: string;
    operationReceiptIds: readonly string[];
  }>[];
  unresolvableClaims: readonly Readonly<{
    obligationId: string;
    reason: string;
    evidenceOperationReceiptIds: readonly string[];
  }>[];
  criticDecision: ReviewTurnCriticDecision | null;
}>;

export type ReviewTurnUsage = Readonly<{
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}>;

export type ReviewTurnObservation = ReviewAgentTurnOutput &
  Readonly<{
    observationVersion: typeof REVIEW_TURN_OBSERVATION_VERSION;
    invocationId: string;
    turnId: string;
    dossierVersion: number;
    purpose: ReviewTurnPurpose;
    actualProviderKind: ReviewAgentProviderKind;
    actualModel: string;
    runtimeProfile: ReviewAgentExecutionProfile;
    usage: ReviewTurnUsage;
    durationMs: number;
    schemaComplete: true;
    streamComplete: true;
    contextAttestationReference: string | null;
  }>;

export function buildReviewAgentTurnOutputSchema(
  allowedObligationIds?: readonly string[]
): Readonly<Record<string, unknown>> {
  const receiptIds = {
    type: 'array',
    maxItems: MAX_COLLECTION_ITEMS,
    items: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  };
  const obligationClaimId =
    allowedObligationIds === undefined || allowedObligationIds.length === 0
      ? { type: 'string', pattern: '^[a-f0-9]{64}$' }
      : { type: 'string', enum: [...allowedObligationIds] };
  const obligationClaimMaxItems =
    allowedObligationIds === undefined
      ? MAX_COLLECTION_ITEMS
      : Math.min(MAX_COLLECTION_ITEMS, allowedObligationIds.length);
  return Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: [
      'outputVersion',
      'findings',
      'obligationProposals',
      'closureClaims',
      'operationBackedDiscoveryClaims',
      'unresolvableClaims',
      'criticDecision',
    ],
    properties: {
      outputVersion: {
        type: 'integer',
        const: REVIEW_TURN_OUTPUT_VERSION,
      },
      findings: {
        type: 'array',
        maxItems: MAX_COLLECTION_ITEMS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'severity',
            'title',
            'body',
            'path',
            'line',
            'evidenceOperationReceiptIds',
          ],
          properties: {
            severity: {
              type: 'string',
              enum: Object.values(ReviewTurnFindingSeverity),
            },
            title: { type: 'string', minLength: 1, maxLength: 240 },
            body: { type: 'string', minLength: 1, maxLength: 16_000 },
            path: { type: 'string', minLength: 1, maxLength: 2_000 },
            line: { type: ['integer', 'null'], minimum: 1 },
            evidenceOperationReceiptIds: receiptIds,
          },
        },
      },
      obligationProposals: {
        type: 'array',
        maxItems: REVIEW_TURN_MAX_OBLIGATION_PROPOSALS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'kind',
            'canonicalSubject',
            'canonicalRequirement',
            'riskPriority',
          ],
          properties: {
            kind: {
              type: 'string',
              enum: REVIEW_TURN_PROVIDER_PROPOSABLE_OBLIGATION_KINDS,
            },
            canonicalSubject: {
              type: 'string',
              minLength: 1,
              maxLength: MAX_CANONICAL_SUBJECT_LENGTH,
              description:
                'Canonical JSON file_read subject derived from canonicalRequirement pathHash and revision.',
            },
            canonicalRequirement: {
              type: 'string',
              minLength: 1,
              maxLength: MAX_CANONICAL_REQUIREMENT_LENGTH,
              description:
                'Canonical JSON complete_file requirement. pathHash must be SHA-256 of the UTF-8 path.',
            },
            riskPriority: {
              type: 'integer',
              minimum: 0,
              maximum: MAX_RISK_PRIORITY,
              description:
                'Advisory semantic risk only; the control plane normalizes authoritative risk.',
            },
          },
        },
      },
      closureClaims: {
        type: 'array',
        maxItems: obligationClaimMaxItems,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['obligationId', 'operationReceiptIds'],
          properties: {
            obligationId: obligationClaimId,
            operationReceiptIds: { ...receiptIds, minItems: 1 },
          },
        },
      },
      operationBackedDiscoveryClaims: {
        type: 'array',
        maxItems: MAX_COLLECTION_ITEMS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['sourceObligationId', 'query', 'operationReceiptIds'],
          properties: {
            sourceObligationId: {
              type: 'string',
              pattern: '^[a-f0-9]{64}$',
            },
            query: { type: 'string', minLength: 1, maxLength: 1_024 },
            operationReceiptIds: { ...receiptIds, minItems: 1 },
          },
        },
      },
      unresolvableClaims: {
        type: 'array',
        maxItems: obligationClaimMaxItems,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['obligationId', 'reason', 'evidenceOperationReceiptIds'],
          properties: {
            obligationId: obligationClaimId,
            reason: { type: 'string', minLength: 1, maxLength: 2_000 },
            evidenceOperationReceiptIds: receiptIds,
          },
        },
      },
      criticDecision: {
        description:
          'Must be null when the authenticated turn purpose is discovery. For a critic turn, must be exactly accept, veto, or abstain.',
        anyOf: [
          { type: 'null' },
          {
            type: 'string',
            enum: Object.values(ReviewTurnCriticDecision),
          },
        ],
      },
    },
  });
}

export function parseReviewAgentTurnOutput(
  value: unknown
): ReviewAgentTurnOutput {
  const root = requireRecord(value, 'turn_output');
  requireExactKeys(root, [
    'outputVersion',
    'findings',
    'obligationProposals',
    'closureClaims',
    'operationBackedDiscoveryClaims',
    'unresolvableClaims',
    'criticDecision',
  ]);
  if (root.outputVersion !== REVIEW_TURN_OUTPUT_VERSION) {
    throw new Error('review_agent_output_version_invalid');
  }
  return Object.freeze({
    outputVersion: REVIEW_TURN_OUTPUT_VERSION,
    findings: requireArray(root.findings, 'findings').map((item) => {
      const record = requireRecord(item, 'finding');
      requireExactKeys(record, [
        'severity',
        'title',
        'body',
        'path',
        'line',
        'evidenceOperationReceiptIds',
      ]);
      return Object.freeze({
        severity: requireEnum(
          record.severity,
          ReviewTurnFindingSeverity,
          'finding_severity'
        ),
        title: requireString(record.title, 'finding_title', 240),
        body: requireString(record.body, 'finding_body', 16_000),
        path: requireString(record.path, 'finding_path', 2_000),
        line: requireNullablePositiveInteger(record.line, 'finding_line'),
        evidenceOperationReceiptIds: requireDigestArray(
          record.evidenceOperationReceiptIds,
          'finding_receipts'
        ),
      });
    }),
    obligationProposals: parseReviewTurnObligationProposals(
      root.obligationProposals
    ),
    closureClaims: requireArray(root.closureClaims, 'closure_claims').map(
      (item) => {
        const record = requireRecord(item, 'closure_claim');
        requireExactKeys(record, ['obligationId', 'operationReceiptIds']);
        const operationReceiptIds = requireDigestArray(
          record.operationReceiptIds,
          'closure_receipts'
        );
        if (operationReceiptIds.length === 0) {
          throw new Error('review_agent_closure_receipts_required');
        }
        return Object.freeze({
          obligationId: requireDigest(record.obligationId, 'obligation_id'),
          operationReceiptIds,
        });
      }
    ),
    operationBackedDiscoveryClaims: requireArray(
      root.operationBackedDiscoveryClaims,
      'operation_backed_discovery_claims'
    ).map((item) => {
      const record = requireRecord(item, 'operation_backed_discovery_claim');
      requireExactKeys(record, [
        'sourceObligationId',
        'query',
        'operationReceiptIds',
      ]);
      const operationReceiptIds = requireDigestArray(
        record.operationReceiptIds,
        'operation_backed_discovery_receipts'
      );
      if (operationReceiptIds.length === 0) {
        throw new Error(
          'review_agent_operation_backed_discovery_receipts_required'
        );
      }
      return Object.freeze({
        sourceObligationId: requireDigest(
          record.sourceObligationId,
          'source_obligation_id'
        ),
        query: requireStrictString(
          record.query,
          'operation_backed_discovery_query',
          1_024
        ),
        operationReceiptIds,
      });
    }),
    unresolvableClaims: requireArray(
      root.unresolvableClaims,
      'unresolvable_claims'
    ).map((item) => {
      const record = requireRecord(item, 'unresolvable_claim');
      requireExactKeys(record, [
        'obligationId',
        'reason',
        'evidenceOperationReceiptIds',
      ]);
      return Object.freeze({
        obligationId: requireDigest(record.obligationId, 'obligation_id'),
        reason: requireString(record.reason, 'unresolvable_reason', 2_000),
        evidenceOperationReceiptIds: requireDigestArray(
          record.evidenceOperationReceiptIds,
          'unresolvable_receipts'
        ),
      });
    }),
    criticDecision:
      root.criticDecision === null
        ? null
        : requireEnum(
            root.criticDecision,
            ReviewTurnCriticDecision,
            'critic_decision'
          ),
  });
}

export function parseReviewTurnObligationProposals(
  value: unknown
): readonly ReviewTurnObligationProposal[] {
  const identities = new Set<string>();
  const proposals = requireArray(
    value,
    'obligation_proposals',
    REVIEW_TURN_MAX_OBLIGATION_PROPOSALS
  ).map((item) => {
    const proposal = parseReviewTurnObligationProposal(item);
    const identity = canonicalJson({
      kind: proposal.kind,
      canonicalSubject: proposal.canonicalSubject,
      canonicalRequirement: proposal.canonicalRequirement,
    });
    if (identities.has(identity)) {
      throw new Error('review_agent_obligation_proposal_duplicate');
    }
    identities.add(identity);
    return proposal;
  });
  return Object.freeze(proposals);
}

function parseReviewTurnObligationProposal(
  value: unknown
): ReviewTurnObligationProposal {
  const record = requireRecord(value, 'obligation_proposal');
  requireExactKeys(record, [
    'kind',
    'canonicalSubject',
    'canonicalRequirement',
    'riskPriority',
  ]);
  const kind = requireProviderProposableObligationKind(record.kind);
  const canonicalRequirement = requireCanonicalText(
    record.canonicalRequirement,
    'obligation_requirement',
    MAX_CANONICAL_REQUIREMENT_LENGTH
  );
  const requirement =
    parseCanonicalCompleteFileRequirement(canonicalRequirement);
  const expectedSubject = canonicalJson({
    kind: FILE_READ_SUBJECT_KIND,
    pathHash: requirement.pathHash,
    revision: requirement.revision,
    subjectVersion: FILE_READ_SUBJECT_VERSION,
  });
  const canonicalSubject = requireCanonicalText(
    record.canonicalSubject,
    'obligation_subject',
    MAX_CANONICAL_SUBJECT_LENGTH
  );
  if (canonicalSubject !== expectedSubject) {
    throw new Error('review_agent_obligation_subject_mismatch');
  }
  return Object.freeze({
    kind,
    canonicalSubject: expectedSubject,
    canonicalRequirement,
    riskPriority: requireBoundedInteger(
      record.riskPriority,
      'risk_priority',
      0,
      MAX_RISK_PRIORITY
    ),
  });
}

function parseCanonicalCompleteFileRequirement(value: string): Readonly<{
  path: string;
  pathHash: string;
  revision: ReviewTurnProposalRevision;
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('review_agent_obligation_requirement_invalid');
  }
  const requirement = requireRecord(parsed, 'obligation_requirement');
  requireExactKeysForField(
    requirement,
    ['kind', 'path', 'pathHash', 'requirementVersion', 'revision'],
    'obligation_requirement'
  );
  if (
    requirement.kind !== COMPLETE_FILE_REQUIREMENT_KIND ||
    requirement.requirementVersion !== COMPLETE_FILE_REQUIREMENT_VERSION
  ) {
    throw new Error('review_agent_obligation_requirement_unsupported');
  }
  const path = requireString(
    requirement.path,
    'obligation_requirement_path',
    MAX_PROPOSAL_PATH_LENGTH
  );
  const pathHash = requireDigest(
    requirement.pathHash,
    'obligation_requirement_path_hash'
  );
  if (pathHash !== sha256(path)) {
    throw new Error('review_agent_obligation_requirement_path_hash_mismatch');
  }
  const revision = requireEnum(
    requirement.revision,
    ReviewTurnProposalRevision,
    'obligation_requirement_revision'
  );
  const normalized = Object.freeze({
    requirementVersion: COMPLETE_FILE_REQUIREMENT_VERSION,
    kind: COMPLETE_FILE_REQUIREMENT_KIND,
    path,
    pathHash,
    revision,
  });
  if (value !== canonicalJson(normalized)) {
    throw new Error('review_agent_obligation_requirement_non_canonical');
  }
  return normalized;
}

function requireProviderProposableObligationKind(
  value: unknown
): ReviewTurnProviderProposableObligationKind {
  if (
    typeof value !== 'string' ||
    !REVIEW_TURN_PROVIDER_PROPOSABLE_OBLIGATION_KINDS.includes(
      value as ReviewTurnProviderProposableObligationKind
    )
  ) {
    throw new Error('review_agent_obligation_kind_unsupported');
  }
  return value as ReviewTurnProviderProposableObligationKind;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`review_agent_${field}_invalid`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[]
) {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error('review_agent_output_fields_invalid');
  }
}

function requireExactKeysForField(
  record: Record<string, unknown>,
  keys: readonly string[],
  field: string
): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`review_agent_${field}_invalid`);
  }
}

function requireArray(
  value: unknown,
  field: string,
  maximumItems = MAX_COLLECTION_ITEMS
): unknown[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`review_agent_${field}_invalid`);
  }
  return value;
}

function requireString(
  value: unknown,
  field: string,
  maxLength: number
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maxLength ||
    value.includes('\0')
  ) {
    throw new Error(`review_agent_${field}_invalid`);
  }
  return value;
}

function requireCanonicalText(
  value: unknown,
  field: string,
  maxLength: number
): string {
  const parsed = requireString(value, field, maxLength);
  if (
    parsed.trim() !== parsed ||
    [...parsed].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    })
  ) {
    throw new Error(`review_agent_${field}_invalid`);
  }
  return parsed;
}

function requireStrictString(
  value: unknown,
  field: string,
  maxLength: number
): string {
  const parsed = requireString(value, field, maxLength);
  if (
    parsed.trim() !== parsed ||
    parsed.includes('\0') ||
    /[\r\n]/u.test(parsed)
  ) {
    throw new Error(`review_agent_${field}_invalid`);
  }
  return parsed;
}

function requireDigest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`review_agent_${field}_invalid`);
  }
  return value;
}

function requireDigestArray(value: unknown, field: string): readonly string[] {
  const values = requireArray(value, field).map((item) =>
    requireDigest(item, field)
  );
  if (new Set(values).size !== values.length) {
    throw new Error(`review_agent_${field}_duplicate`);
  }
  return Object.freeze(values);
}

function requireNullablePositiveInteger(
  value: unknown,
  field: string
): number | null {
  if (value === null) return null;
  return requireBoundedInteger(value, field, 1, Number.MAX_SAFE_INTEGER);
}

function requireBoundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(`review_agent_${field}_invalid`);
  }
  return value as number;
}

function requireEnum<T extends Record<string, string>>(
  value: unknown,
  enumeration: T,
  field: string
): T[keyof T] {
  if (
    typeof value !== 'string' ||
    !Object.values(enumeration).includes(value)
  ) {
    throw new Error(`review_agent_${field}_invalid`);
  }
  return value as T[keyof T];
}
