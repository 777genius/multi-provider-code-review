import {
  ReviewAgentExecutionProfile,
  ReviewAgentProviderKind,
} from './runtime-profile';

export const REVIEW_TURN_OUTPUT_VERSION = 1 as const;
const MAX_COLLECTION_ITEMS = 256;

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

export enum ReviewTurnCriticDecision {
  Accept = 'accept',
  Veto = 'veto',
  Abstain = 'abstain',
}

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
  obligationProposals: readonly Readonly<{
    kind: ReviewTurnObligationKind;
    canonicalSubject: string;
    canonicalRequirement: string;
    riskPriority: number;
  }>[];
  closureClaims: readonly Readonly<{
    obligationId: string;
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
    observationVersion: 1;
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

export function buildReviewAgentTurnOutputSchema(): Readonly<
  Record<string, unknown>
> {
  const receiptIds = {
    type: 'array',
    maxItems: MAX_COLLECTION_ITEMS,
    uniqueItems: true,
    items: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  };
  return Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: [
      'outputVersion',
      'findings',
      'obligationProposals',
      'closureClaims',
      'unresolvableClaims',
      'criticDecision',
    ],
    properties: {
      outputVersion: { const: REVIEW_TURN_OUTPUT_VERSION },
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
            severity: { enum: Object.values(ReviewTurnFindingSeverity) },
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
        maxItems: MAX_COLLECTION_ITEMS,
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
            kind: { enum: Object.values(ReviewTurnObligationKind) },
            canonicalSubject: {
              type: 'string',
              minLength: 1,
              maxLength: 4_000,
            },
            canonicalRequirement: {
              type: 'string',
              minLength: 1,
              maxLength: 4_000,
            },
            riskPriority: { type: 'integer', minimum: 0, maximum: 1_000_000 },
          },
        },
      },
      closureClaims: {
        type: 'array',
        maxItems: MAX_COLLECTION_ITEMS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['obligationId', 'operationReceiptIds'],
          properties: {
            obligationId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            operationReceiptIds: receiptIds,
          },
        },
      },
      unresolvableClaims: {
        type: 'array',
        maxItems: MAX_COLLECTION_ITEMS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['obligationId', 'reason', 'evidenceOperationReceiptIds'],
          properties: {
            obligationId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            reason: { type: 'string', minLength: 1, maxLength: 2_000 },
            evidenceOperationReceiptIds: receiptIds,
          },
        },
      },
      criticDecision: {
        anyOf: [
          { type: 'null' },
          { enum: Object.values(ReviewTurnCriticDecision) },
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
    obligationProposals: requireArray(
      root.obligationProposals,
      'obligation_proposals'
    ).map((item) => {
      const record = requireRecord(item, 'obligation_proposal');
      requireExactKeys(record, [
        'kind',
        'canonicalSubject',
        'canonicalRequirement',
        'riskPriority',
      ]);
      return Object.freeze({
        kind: requireEnum(
          record.kind,
          ReviewTurnObligationKind,
          'obligation_kind'
        ),
        canonicalSubject: requireString(
          record.canonicalSubject,
          'obligation_subject',
          4_000
        ),
        canonicalRequirement: requireString(
          record.canonicalRequirement,
          'obligation_requirement',
          4_000
        ),
        riskPriority: requireBoundedInteger(
          record.riskPriority,
          'risk_priority',
          0,
          1_000_000
        ),
      });
    }),
    closureClaims: requireArray(root.closureClaims, 'closure_claims').map(
      (item) => {
        const record = requireRecord(item, 'closure_claim');
        requireExactKeys(record, ['obligationId', 'operationReceiptIds']);
        return Object.freeze({
          obligationId: requireDigest(record.obligationId, 'obligation_id'),
          operationReceiptIds: requireDigestArray(
            record.operationReceiptIds,
            'closure_receipts'
          ),
        });
      }
    ),
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

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_COLLECTION_ITEMS) {
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
    value.length > maxLength
  ) {
    throw new Error(`review_agent_${field}_invalid`);
  }
  return value;
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
