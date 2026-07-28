import { createHash } from 'crypto';
import type { PRContext, ReviewConfig } from '../../types';
import { PullRequestLoadStatus } from '../../types';
import { trimDiff } from '../../utils/diff';
import {
  BuildCurrentReviewProjection,
  type BuildCurrentReviewProjectionCommand,
  type CurrentLifecycleInventoryPort,
} from '../../review-projection/application';
import {
  FindingSeverity,
  LifecycleRevalidationVerdict,
  ProjectionCoverageState,
  REVIEW_PROJECTION_ABSOLUTE_LIMITS,
  RevisionFileStatus,
  type CurrentFindingCandidate,
  type LifecycleRevalidation,
  type ReviewProjectionLimits,
} from '../../review-projection/domain';
import { LegacyReviewProjectionPolicyAdapter } from '../../review-projection/infrastructure/legacy/legacy-review-projection-policy-adapter';
import type {
  AcceptedReviewObservation,
  AcceptedReviewWorkSlotEvidence,
  ReviewExecutionProviderKind,
  ReviewProtocolLimits,
  ReviewRunAuthorizationFacts,
  ReviewTaskKind,
} from '../application';
import {
  createReviewPromptCoverageManifest,
  isReviewPromptCoverageComplete,
  ReviewPromptPathCoverageKind,
} from '../domain';
import {
  CurrentReviewProjectionBuilderAdapter,
  type ReviewProjectionCommandFactoryPort,
} from './current-review-projection-builder-adapter';

const productionReviewProjectionPolicyVersion =
  'review-projection-policy.v4-t0';

export type ProductionWorkAssignmentFacts = {
  readonly workSlotId: string;
  readonly taskKind: ReviewTaskKind;
  readonly providerKind: ReviewExecutionProviderKind;
  readonly required: boolean;
  readonly filePaths: readonly string[];
};

export function createProductionReviewProjectionBuilder(input: {
  readonly authorizationFacts: ReviewRunAuthorizationFacts;
  readonly pr: PRContext;
  readonly config: ReviewConfig;
  readonly protocolLimits: ReviewProtocolLimits;
  readonly assignments: readonly ProductionWorkAssignmentFacts[];
  readonly uncoveredPaths: readonly string[];
  readonly uncoveredLifecycleTargetIds: readonly string[];
  readonly lifecycleInventory: CurrentLifecycleInventoryPort;
}) {
  const limits = projectionLimits(input.config, input.protocolLimits);
  const policy = new LegacyReviewProjectionPolicyAdapter(input.config);
  const projection = new BuildCurrentReviewProjection({
    lifecycleInventory: input.lifecycleInventory,
    findingPolicy: policy,
    lifecyclePolicy: policy,
    presentationPolicy: policy,
    mergeGatePolicy: policy,
    limits,
  });
  return new CurrentReviewProjectionBuilderAdapter(
    projection,
    new ProductionReviewProjectionCommandFactory({
      ...input,
      limits,
    })
  );
}

class ProductionReviewProjectionCommandFactory implements ReviewProjectionCommandFactoryPort {
  constructor(
    private readonly input: {
      readonly authorizationFacts: ReviewRunAuthorizationFacts;
      readonly pr: PRContext;
      readonly config: ReviewConfig;
      readonly assignments: readonly ProductionWorkAssignmentFacts[];
      readonly uncoveredPaths: readonly string[];
      readonly uncoveredLifecycleTargetIds: readonly string[];
      readonly limits: ReviewProjectionLimits;
    }
  ) {}

  async create(input: {
    readonly acceptedEvidence: readonly AcceptedReviewWorkSlotEvidence[];
    readonly exhaustedWorkSlotIds: readonly string[];
    readonly reviewRevisionHash: string;
  }): Promise<BuildCurrentReviewProjectionCommand> {
    const evidence = validateAcceptedEvidence({
      assignments: this.input.assignments,
      evidence: input.acceptedEvidence,
      reviewRevisionHash: input.reviewRevisionHash,
    });
    const findings: CurrentFindingCandidate[] = [];
    const revalidations: LifecycleRevalidation[] = [];
    for (const { observation } of evidence.values()) {
      const payload = parseObservation(observation.payloadCanonicalJson);
      payload.normalizedFindings.forEach((finding, index) => {
        findings.push(toFinding(observation, finding, index));
      });
      for (const revalidation of payload.normalizedLifecycleRevalidations) {
        revalidations.push(toRevalidation(observation, revalidation));
      }
    }

    const requiredAssignments = this.input.assignments.filter(
      (assignment) => assignment.required
    );
    const requiredWorkSlotIds = new Set(
      requiredAssignments.map((assignment) => assignment.workSlotId)
    );
    const requiredExhaustedWorkSlotIds = input.exhaustedWorkSlotIds.filter(
      (workSlotId) => requiredWorkSlotIds.has(workSlotId)
    );
    const reviewedFiles = new Set<string>();
    const coverageLimitations: string[] = [];
    for (const assignment of requiredAssignments) {
      const accepted = evidence.get(assignment.workSlotId);
      if (!accepted) {
        coverageLimitations.push(
          `coverage_manifest_missing:${assignment.workSlotId}`
        );
        continue;
      }
      const manifest = accepted.coverageManifest;
      if (
        accepted.observation.qualityFlags.includes(
          'context_inspection_incomplete'
        )
      ) {
        coverageLimitations.push(
          `work_slot_context_inspection_incomplete:${assignment.workSlotId}`
        );
      }
      for (const path of manifest.paths) {
        if (path.kind === ReviewPromptPathCoverageKind.FullPatch) {
          reviewedFiles.add(path.path);
        } else {
          coverageLimitations.push(`path_coverage:${path.path}:${path.kind}`);
        }
      }
      if (!isReviewPromptCoverageComplete(manifest)) {
        coverageLimitations.push(
          `work_slot_coverage_incomplete:${assignment.workSlotId}`
        );
      }
    }
    const completeLoad =
      this.input.pr.loadCompleteness?.status !==
      PullRequestLoadStatus.Truncated;
    const complete =
      requiredExhaustedWorkSlotIds.length === 0 &&
      completeLoad &&
      this.input.uncoveredPaths.length === 0 &&
      this.input.uncoveredLifecycleTargetIds.length === 0 &&
      requiredAssignments.every((assignment) =>
        evidence.has(assignment.workSlotId)
      ) &&
      coverageLimitations.length === 0;
    const limitations = [
      ...(!completeLoad
        ? (this.input.pr.loadCompleteness?.omissions ?? []).map(
            (omission) => `pull_request_load:${omission.reason}`
          )
        : []),
      ...requiredExhaustedWorkSlotIds.map((id) => `work_slot_exhausted:${id}`),
      ...this.input.uncoveredPaths.map((path) => `work_slot_uncovered:${path}`),
      ...this.input.uncoveredLifecycleTargetIds.map(
        (targetId) => `lifecycle_target_uncovered:${targetId}`
      ),
      ...coverageLimitations,
    ].sort();
    const providerExecution = providerExecutionSummary(
      this.input.assignments,
      evidence
    );

    return Object.freeze({
      projectionPolicyVersion: productionReviewProjectionPolicyVersion,
      scope: {
        scmRepositoryIdentityId:
          this.input.authorizationFacts.scmRepositoryIdentityId,
        pullRequestNumber: this.input.authorizationFacts.pullRequestNumber,
        baseSha: this.input.authorizationFacts.baseSha,
        reviewedHeadSha: this.input.authorizationFacts.headSha,
        reviewRevisionHash: input.reviewRevisionHash,
      },
      presentation: {
        title: this.input.pr.title,
        author: this.input.pr.author,
        additions: this.input.pr.additions,
        deletions: this.input.pr.deletions,
      },
      providerExecution,
      currentFindings: Object.freeze(
        findings.sort((left, right) =>
          compareCodeUnits(left.sourceFindingId, right.sourceFindingId)
        )
      ),
      priorLineageHints: Object.freeze([]),
      lifecycleRevalidations: Object.freeze(
        revalidations.sort((left, right) =>
          compareCodeUnits(left.targetId, right.targetId)
        )
      ),
      coverage: {
        state: complete
          ? ProjectionCoverageState.Complete
          : ProjectionCoverageState.Partial,
        mode: 'full' as const,
        totalFiles: this.input.pr.files.length,
        reviewedFiles: complete
          ? this.input.pr.files.length
          : reviewedFiles.size,
        unreviewedFiles: Math.max(
          0,
          this.input.pr.files.length - reviewedFiles.size
        ),
        limitations: Object.freeze(limitations),
      },
      revisionFiles: Object.freeze(
        this.input.pr.files.map((file) => ({
          path: file.filename,
          ...(file.previousFilename
            ? { previousPath: file.previousFilename }
            : {}),
          status: toRevisionFileStatus(file.status),
          ...(file.patch ? { patch: file.patch } : {}),
        }))
      ),
      diff: trimDiff(this.input.pr.diff, this.input.limits.maxDiffBytes),
      ...(toFailOnSeverity(this.input.config.failOnSeverity)
        ? { failOnSeverity: toFailOnSeverity(this.input.config.failOnSeverity) }
        : {}),
    });
  }
}

function validateAcceptedEvidence(input: {
  readonly assignments: readonly ProductionWorkAssignmentFacts[];
  readonly evidence: readonly AcceptedReviewWorkSlotEvidence[];
  readonly reviewRevisionHash: string;
}): ReadonlyMap<string, AcceptedReviewWorkSlotEvidence> {
  const assignments = new Map(
    input.assignments.map((assignment) => [assignment.workSlotId, assignment])
  );
  const evidence = new Map<string, AcceptedReviewWorkSlotEvidence>();
  for (const accepted of input.evidence) {
    const { coverageManifest: manifest, workSlotId } = accepted;
    const assignment = assignments.get(workSlotId);
    if (
      manifest.workSlotId !== workSlotId ||
      !assignment ||
      accepted.observation.providerKind !== assignment.providerKind ||
      evidence.has(workSlotId)
    ) {
      throw new Error('review_projection_coverage_manifest_scope_invalid');
    }
    const rebuilt = createReviewPromptCoverageManifest({
      workSlotId: manifest.workSlotId,
      reviewRevisionHash: input.reviewRevisionHash,
      assignedPaths: [...assignment.filePaths].sort(),
      pathCoverage: manifest.paths,
    });
    if (
      manifest.reviewRevisionHash !== input.reviewRevisionHash ||
      rebuilt.coverageHash !== manifest.coverageHash
    ) {
      throw new Error('review_projection_coverage_manifest_hash_invalid');
    }
    evidence.set(workSlotId, accepted);
  }
  return evidence;
}

function providerExecutionSummary(
  assignments: readonly ProductionWorkAssignmentFacts[],
  evidence: ReadonlyMap<string, AcceptedReviewWorkSlotEvidence>
) {
  const byProvider = new Map<
    ProductionWorkAssignmentFacts['providerKind'],
    ProductionWorkAssignmentFacts[]
  >();
  for (const assignment of assignments) {
    const providerAssignments = byProvider.get(assignment.providerKind) ?? [];
    providerAssignments.push(assignment);
    byProvider.set(assignment.providerKind, providerAssignments);
  }
  const succeededProviders = [...byProvider.values()].filter(
    (providerAssignments) => {
      const required = providerAssignments.filter(
        (assignment) => assignment.required
      );
      const completionSet =
        required.length > 0 ? required : providerAssignments;
      return completionSet.every((assignment) =>
        evidence.has(assignment.workSlotId)
      );
    }
  ).length;
  return Object.freeze({
    plannedProviders: byProvider.size,
    succeededProviders,
  });
}

type NormalizedObservation = {
  readonly normalizedFindings: readonly Record<string, unknown>[];
  readonly normalizedLifecycleRevalidations: readonly Record<string, unknown>[];
};

function parseObservation(value: string): NormalizedObservation {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  if (
    parsed.payloadVersion !== 2 ||
    !Array.isArray(parsed.normalizedFindings) ||
    !Array.isArray(parsed.normalizedLifecycleRevalidations) ||
    parsed.normalizedFindings.some((item) => !isRecord(item)) ||
    parsed.normalizedLifecycleRevalidations.some((item) => !isRecord(item))
  ) {
    throw new Error('review_action_v2_observation_payload_invalid');
  }
  return {
    normalizedFindings: parsed.normalizedFindings as Record<string, unknown>[],
    normalizedLifecycleRevalidations:
      parsed.normalizedLifecycleRevalidations as Record<string, unknown>[],
  };
}

function toFinding(
  observation: AcceptedReviewObservation,
  value: Record<string, unknown>,
  index: number
): CurrentFindingCandidate {
  const category = optionalString(value.category) ?? 'correctness';
  const title = requireString(value.title, 'finding_title');
  const message = requireString(value.message, 'finding_message');
  const filePath = requireString(value.path, 'finding_file');
  const normalizedFailureModeHash = requireDigest(
    value.normalizedFailureModeHash,
    'finding_failure_mode_hash'
  );
  return Object.freeze({
    sourceFindingId: deterministicId('finding', [
      observation.observationId,
      String(index),
    ]),
    category,
    normalizedFailureModeHash,
    severity: toFindingSeverity(value.severity),
    title,
    message,
    ...(optionalString(value.suggestion)
      ? { suggestion: optionalString(value.suggestion) }
      : {}),
    filePath,
    ...(optionalPositiveInteger(value.startLine) !== undefined
      ? { startLine: optionalPositiveInteger(value.startLine) }
      : {}),
    ...(optionalPositiveInteger(value.startLine) !== undefined
      ? { line: optionalPositiveInteger(value.startLine) }
      : {}),
    ...(optionalPositiveInteger(value.endLine) !== undefined
      ? { endLine: optionalPositiveInteger(value.endLine) }
      : {}),
    ...(optionalConfidence(value.placementConfidence) !== undefined
      ? { confidence: optionalConfidence(value.placementConfidence) }
      : {}),
    providerIds: Object.freeze([observation.providerKind]),
    providerVoteKeys: Object.freeze([observation.providerVoteIdentityHash]),
    observationIds: Object.freeze([observation.observationId]),
  });
}

function toRevalidation(
  observation: AcceptedReviewObservation,
  value: Record<string, unknown>
): LifecycleRevalidation {
  const verdict = requireString(value.verdict, 'revalidation_verdict');
  if (
    !Object.values(LifecycleRevalidationVerdict).includes(
      verdict as LifecycleRevalidationVerdict
    )
  ) {
    throw new Error('review_action_v2_revalidation_verdict_invalid');
  }
  return Object.freeze({
    targetId: requireString(value.targetId, 'revalidation_target_id'),
    providerVoteKey: observation.providerVoteIdentityHash,
    verdict: verdict as LifecycleRevalidationVerdict,
    ...(optionalConfidence(value.confidence) !== undefined
      ? { confidence: optionalConfidence(value.confidence) }
      : {}),
    ...(optionalString(value.rationale)
      ? { rationale: optionalString(value.rationale) }
      : {}),
  });
}

function projectionLimits(
  config: ReviewConfig,
  protocol: ReviewProtocolLimits
): ReviewProjectionLimits {
  const absolute = REVIEW_PROJECTION_ABSOLUTE_LIMITS;
  return Object.freeze({
    maxProjectionBytes: Math.min(
      protocol.maxProjectionBytes,
      absolute.maxProjectionBytes
    ),
    maxFindings: Math.min(protocol.maxProjectionFindings, absolute.maxFindings),
    maxReferencesPerFinding: absolute.maxReferencesPerFinding,
    maxLineageHints: absolute.maxLineageHints,
    maxLifecycleTargets: Math.min(
      config.reviewThreadLifecycleMaxTargets ?? absolute.maxLifecycleTargets,
      absolute.maxLifecycleTargets
    ),
    maxRevisionFiles: absolute.maxRevisionFiles,
    maxDiffBytes: Math.min(config.diffMaxBytes, absolute.maxDiffBytes),
    maxSummaryBytes: Math.min(
      protocol.maxPublicationBodyBytes,
      absolute.maxSummaryBytes
    ),
    maxCheckSummaryBytes: Math.min(
      protocol.maxPublicationBodyBytes,
      absolute.maxCheckSummaryBytes
    ),
    maxInlineComments: Math.min(
      config.inlineMaxComments,
      protocol.maxPublicationOperations,
      absolute.maxInlineComments
    ),
    maxInlineCommentsPerChunk: Math.min(
      protocol.maxRequestBatchSize,
      absolute.maxInlineCommentsPerChunk
    ),
    maxInlineChunks: Math.min(
      protocol.maxPublicationChunks,
      absolute.maxInlineChunks
    ),
    maxInlineCommentBodyBytes: absolute.maxInlineCommentBodyBytes,
    maxStringBytes: absolute.maxStringBytes,
  });
}

function toRevisionFileStatus(value: string): RevisionFileStatus {
  switch (value) {
    case 'added':
      return RevisionFileStatus.Added;
    case 'removed':
      return RevisionFileStatus.Removed;
    case 'renamed':
      return RevisionFileStatus.Renamed;
    default:
      return RevisionFileStatus.Modified;
  }
}

function toFindingSeverity(value: unknown): FindingSeverity {
  switch (value) {
    case 'critical':
      return FindingSeverity.Critical;
    case 'major':
      return FindingSeverity.Major;
    case 'minor':
      return FindingSeverity.Minor;
    default:
      throw new Error('review_action_v2_finding_severity_invalid');
  }
}

function toFailOnSeverity(value: ReviewConfig['failOnSeverity']) {
  switch (value) {
    case 'critical':
      return FindingSeverity.Critical;
    case 'major':
      return FindingSeverity.Major;
    case 'minor':
      return FindingSeverity.Minor;
    default:
      return undefined;
  }
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : undefined;
}

function optionalConfidence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireString(value: unknown, field: string): string {
  const parsed = optionalString(value);
  if (!parsed) throw new Error(`review_action_v2_${field}_invalid`);
  return parsed;
}

function requireDigest(value: unknown, field: string): string {
  const parsed = requireString(value, field);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) {
    throw new Error(`review_action_v2_${field}_invalid`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deterministicId(namespace: string, parts: readonly string[]): string {
  return `rr:${namespace}:${sha256(parts.join('\0')).slice(0, 40)}`;
}

export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
