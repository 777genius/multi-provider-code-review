import { ConsensusEngine } from '../../../analysis/consensus';
import { Deduplicator } from '../../../analysis/deduplicator';
import { FindingFilter } from '../../../analysis/finding-filter';
import { SynthesisEngine } from '../../../analysis/synthesis';
import { ThreadLifecycleAggregator } from '../../../analysis/thread-lifecycle';
import { getBlockingFindingBreakdown } from '../../../output/severity-gate';
import {
  FileChange,
  Finding,
  LifecycleReasonCode,
  LifecycleTarget,
  LifecycleThreadRecord,
  PRContext,
  ProviderResult,
  Review,
  ReviewConfig,
  Severity,
} from '../../../types';
import {
  chooseBestAddedLineForComment,
  mapLinesToPositions,
} from '../../../utils/diff';
import {
  CheckConclusion,
  CurrentFindingCandidate,
  FindingOccurrence,
  FindingOccurrenceState,
  FindingPlacementDecision,
  FindingPlacementKind,
  FindingSeverity,
  LifecycleProjectionDecision,
  LifecycleRevalidationVerdict,
  LifecycleTargetDisposition,
  MergeGateConclusion,
  ProjectionCoverageState,
  RevisionFile,
  RevisionFileStatus,
  SelectedCurrentFinding,
} from '../../domain/review-projection';
import {
  CurrentFindingPolicyPort,
  EvaluateMergeGateQuery,
  MergeGateDecision,
  ProjectedReviewPresentation,
  ProjectLifecycleQuery,
  ProjectReviewPresentationQuery,
  ReviewLifecyclePolicyPort,
  ReviewMergeGatePolicyPort,
  ReviewPresentationPolicyPort,
  SelectCurrentFindingsQuery,
} from '../../application/review-projection-ports';

type FindingWithProjectionMetadata = Finding & {
  readonly projectionSourceFindingId: string;
  readonly projectionCategory: string;
  readonly projectionFailureModeHash: string;
  readonly projectionSymbolAnchor?: string;
  readonly projectionTrustedMarker?: string;
  readonly projectionObservationIds: readonly string[];
};

/**
 * Anti-corruption adapter for the current v1 review policies. It owns mapping
 * only; the review-projection domain remains independent of legacy Review types.
 */
export class LegacyReviewProjectionPolicyAdapter
  implements
    CurrentFindingPolicyPort,
    ReviewLifecyclePolicyPort,
    ReviewPresentationPolicyPort,
    ReviewMergeGatePolicyPort
{
  private readonly consensus: ConsensusEngine;
  private readonly synthesis: SynthesisEngine;

  constructor(private readonly config: ReviewConfig) {
    this.consensus = new ConsensusEngine({
      minAgreement: Math.max(1, config.inlineMinAgreement),
      minSeverity: 'minor',
      maxComments: config.inlineMaxComments,
    });
    this.synthesis = new SynthesisEngine(config);
  }

  async selectCurrent(
    query: SelectCurrentFindingsQuery
  ): Promise<readonly SelectedCurrentFinding[]> {
    const legacyFindings = query.findings.map(toLegacyFinding);
    const deduped = new Deduplicator().dedupe(legacyFindings);
    const consensus = this.consensus.filter(deduped);
    const filtered = new FindingFilter().filter(consensus, query.diff).findings;

    return filtered.map((finding) => {
      const metadata = finding as FindingWithProjectionMetadata;
      const contributors = query.findings.filter((candidate) =>
        candidateContributedToFinding(candidate, finding)
      );
      const representative =
        contributors.find(
          (candidate) =>
            candidate.sourceFindingId === metadata.projectionSourceFindingId
        ) ?? contributors[0];
      if (!representative) {
        throw new Error('legacy finding policy returned an unknown finding');
      }

      return {
        ...representative,
        sourceFindingId: representative.sourceFindingId,
        sourceFindingIds: sortedUnique(
          contributors.map((candidate) => candidate.sourceFindingId)
        ),
        severity: toProjectionSeverity(finding.severity),
        title: finding.title,
        message: finding.message,
        ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
        filePath: finding.file,
        ...(finding.startLine !== undefined
          ? { startLine: finding.startLine }
          : {}),
        line: finding.line,
        ...(finding.endLine !== undefined ? { endLine: finding.endLine } : {}),
        ...(finding.confidence !== undefined
          ? { confidence: finding.confidence }
          : {}),
        providerIds: sortedUnique([
          ...(finding.providers ?? []),
          ...(finding.provider ? [finding.provider] : []),
        ]),
        providerVoteKeys: sortedUnique(
          contributors.flatMap((candidate) => candidate.providerVoteKeys)
        ),
        observationIds: sortedUnique(
          contributors.flatMap((candidate) => candidate.observationIds)
        ),
      };
    });
  }

  async projectLifecycle(
    query: ProjectLifecycleQuery
  ): Promise<readonly LifecycleProjectionDecision[]> {
    const targets = query.inventory.targets
      .filter(
        (target) =>
          target.disposition !== LifecycleTargetDisposition.CommandSuppressed
      )
      .map(toLegacyLifecycleTarget);
    const skipped = query.inventory.targets
      .filter(
        (target) =>
          target.disposition === LifecycleTargetDisposition.CommandSuppressed
      )
      .map((target) =>
        legacyLifecycleRecord(toLegacyLifecycleTarget(target), [
          'command_dismissed',
        ])
      );
    const manualAttention = query.inventory.targets
      .filter(
        (target) => target.disposition === LifecycleTargetDisposition.HumanReply
      )
      .map((target) =>
        legacyLifecycleRecord(toLegacyLifecycleTarget(target), ['human_reply'])
      );
    const providerResults = lifecycleProviderResults(query);
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'report',
      targets,
      plannedProviders: providerResults.map((result) => result.name),
      providerResults,
      currentFindings: query.findings.map(toLegacyFinding),
      initialManualAttention: manualAttention,
      skipped,
      warnings: [...query.inventory.warnings],
      inventoryFailed: !query.inventory.complete,
      config: this.config,
    });

    const decisions = new Map<string, LifecycleProjectionDecision>();
    const collect = (
      records: readonly LifecycleThreadRecord[],
      verdict: LifecycleRevalidationVerdict
    ): void => {
      for (const record of records) {
        decisions.set(record.target.targetId, {
          targetId: record.target.targetId,
          verdict,
          reasonCodes: sortedUnique(record.reasonCodes),
        });
      }
    };
    collect(
      [...lifecycle.resolvedCandidates, ...lifecycle.resolvedByLifecycle],
      LifecycleRevalidationVerdict.Resolved
    );
    collect(
      lifecycle.previousStillValid,
      LifecycleRevalidationVerdict.StillValid
    );
    collect(
      [
        ...lifecycle.previousUncertain,
        ...lifecycle.manualAttention,
        ...lifecycle.skipped,
      ],
      LifecycleRevalidationVerdict.Uncertain
    );

    return Array.from(decisions.values()).sort((left, right) =>
      left.targetId.localeCompare(right.targetId)
    );
  }

  async projectPresentation(
    query: ProjectReviewPresentationQuery
  ): Promise<ProjectedReviewPresentation> {
    const activeOccurrences = query.occurrences.filter(
      (occurrence) =>
        occurrence.state !== FindingOccurrenceState.Resolved &&
        occurrence.state !== FindingOccurrenceState.SuppressedByHuman
    );
    const currentOccurrences = activeOccurrences.filter(isCurrentOccurrence);
    const pr = toLegacyPrContext(query);
    const review = this.synthesis.synthesizeWithProviderExecutionSummary(
      currentOccurrences.map(toLegacyFinding),
      pr,
      {
        planned: query.providerExecution.plannedProviders,
        succeeded: query.providerExecution.succeededProviders,
      }
    );
    const placements = query.occurrences.map((occurrence) =>
      this.placeOccurrence(occurrence, review, query.revisionFiles)
    );
    const lifecycleLines = formatLifecycleLines(
      query.scope.reviewedHeadSha,
      query.occurrences
    );
    const coverageLines =
      query.coverage.state === ProjectionCoverageState.Partial
        ? [
            '',
            '### Coverage not completed',
            ...query.coverage.limitations.map(
              (limitation) => `- ${limitation}`
            ),
          ]
        : [];
    const reviewSummary =
      query.coverage.state === ProjectionCoverageState.Partial
        ? formatPartialReviewSummary(review.summary, currentOccurrences.length)
        : review.summary;
    const summaryBody = [
      reviewSummary,
      ...(lifecycleLines.length > 0 ? ['', ...lifecycleLines] : []),
      ...coverageLines,
    ].join('\n');

    return {
      summaryBody,
      checkName: 'ReviewRouter',
      checkTitle:
        query.coverage.state === ProjectionCoverageState.Partial
          ? 'Review incomplete - partial coverage'
          : 'Review completed',
      checkSummary: summaryBody,
      checkConclusion:
        query.coverage.state === ProjectionCoverageState.Partial
          ? CheckConclusion.Neutral
          : undefined,
      placements,
    };
  }

  evaluateMergeGate(query: EvaluateMergeGateQuery): MergeGateDecision {
    const eligible = query.occurrences.filter(isCurrentOccurrence);
    const threshold = query.failOnSeverity;
    const blockingLineageIds = threshold
      ? eligible
          .filter((occurrence) =>
            this.isBlockingOccurrence(occurrence, threshold)
          )
          .map((occurrence) => occurrence.lineageId)
      : [];
    const incomplete =
      query.coverage.state === ProjectionCoverageState.Partial ||
      !query.lifecycleInventoryComplete;

    if (blockingLineageIds.length > 0) {
      return {
        conclusion: MergeGateConclusion.Fail,
        blockingLineageIds: sortedUnique(blockingLineageIds),
        reasonCodes: [
          'blocking_current_findings',
          ...(incomplete ? ['partial_coverage'] : []),
        ],
      };
    }
    if (incomplete) {
      return {
        conclusion: MergeGateConclusion.Inconclusive,
        blockingLineageIds: [],
        reasonCodes: ['partial_coverage'],
      };
    }
    return {
      conclusion: MergeGateConclusion.Pass,
      blockingLineageIds: [],
      reasonCodes: [],
    };
  }

  private isBlockingOccurrence(
    occurrence: FindingOccurrence,
    threshold: FindingSeverity
  ): boolean {
    const review = minimalLegacyReview([toLegacyFinding(occurrence)]);
    return (
      getBlockingFindingBreakdown(review, toLegacySeverity(threshold)).total > 0
    );
  }

  private placeOccurrence(
    occurrence: FindingOccurrence,
    review: Review,
    revisionFiles: readonly RevisionFile[]
  ): FindingPlacementDecision {
    if (!isCurrentOccurrence(occurrence)) {
      return summaryPlacement(occurrence, 'historical lifecycle occurrence');
    }
    const revisionFile = findRevisionFile(occurrence.filePath, revisionFiles);
    if (!revisionFile) {
      return summaryPlacement(occurrence, 'file is outside the current diff');
    }
    if (revisionFile.status === RevisionFileStatus.Removed) {
      return summaryPlacement(occurrence, 'file was deleted');
    }
    const line = occurrence.line ?? occurrence.endLine;
    if (line === undefined) {
      return {
        lineageId: occurrence.lineageId,
        kind: FindingPlacementKind.File,
        path: revisionFile.path,
        reason: 'finding has no current line anchor',
      };
    }
    const inline = review.inlineComments.find(
      (comment) =>
        normalizePath(comment.path) === normalizePath(occurrence.filePath) &&
        comment.line === line
    );
    if (!inline) {
      return {
        lineageId: occurrence.lineageId,
        kind: FindingPlacementKind.File,
        path: revisionFile.path,
        reason: 'legacy synthesis did not select inline placement',
      };
    }
    const correctedLine = chooseBestAddedLineForComment(
      revisionFile.patch,
      inline.line,
      inline.body
    );
    if (!mapLinesToPositions(revisionFile.patch).has(correctedLine)) {
      return {
        lineageId: occurrence.lineageId,
        kind: FindingPlacementKind.File,
        path: revisionFile.path,
        reason: 'line is not provably placeable in the current diff',
      };
    }
    return {
      lineageId: occurrence.lineageId,
      kind: FindingPlacementKind.Inline,
      path: revisionFile.path,
      ...(inline.startLine !== undefined
        ? { startLine: inline.startLine }
        : {}),
      line: correctedLine,
      ...(inline.endLine !== undefined ? { endLine: inline.endLine } : {}),
      body: inline.body,
    };
  }
}

function formatPartialReviewSummary(
  summary: string,
  preliminaryFindingCount: number
): string {
  const findingLabel = preliminaryFindingCount === 1 ? 'finding' : 'findings';
  const partialHeading = `## Review incomplete - ${preliminaryFindingCount} preliminary ${findingLabel} preserved ⚠️`;
  const partialNote =
    '<sub>These preliminary findings were preserved in this summary. Inline comments and lifecycle changes were withheld because required coverage did not complete.</sub>';
  const completeHeading = /^## Review complete[^\n]*$/m;
  const synthesisNote = /^<sub>[^\n]*<\/sub>$/m;
  if (!completeHeading.test(summary) || !synthesisNote.test(summary)) {
    throw new Error('legacy_partial_review_summary_contract_invalid');
  }

  return summary
    .replace(completeHeading, partialHeading)
    .replace(synthesisNote, partialNote);
}

function toLegacyFinding(
  finding: CurrentFindingCandidate | SelectedCurrentFinding | FindingOccurrence
): FindingWithProjectionMetadata {
  const occurrence = 'lineageId' in finding ? finding : undefined;
  const sourceFindingId =
    'sourceFindingId' in finding
      ? finding.sourceFindingId
      : (occurrence?.sourceFindingIds[0] ??
        occurrence?.lineageId ??
        'historical');
  return {
    file: 'filePath' in finding ? finding.filePath : '',
    ...(finding.startLine !== undefined
      ? { startLine: finding.startLine }
      : {}),
    line: finding.line ?? finding.endLine ?? 1,
    ...(finding.endLine !== undefined ? { endLine: finding.endLine } : {}),
    severity: toLegacySeverity(finding.severity),
    title: finding.title,
    message: finding.message,
    ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
    provider: 'providerIds' in finding ? finding.providerIds[0] : undefined,
    providers: 'providerIds' in finding ? [...finding.providerIds] : undefined,
    providerVoteKeys: [...finding.providerVoteKeys],
    confidence: 'confidence' in finding ? finding.confidence : undefined,
    category: finding.category,
    projectionSourceFindingId: sourceFindingId,
    projectionCategory: finding.category,
    projectionFailureModeHash: finding.normalizedFailureModeHash,
    ...(finding.symbolAnchor
      ? { projectionSymbolAnchor: finding.symbolAnchor }
      : {}),
    ...(finding.trustedMarker
      ? { projectionTrustedMarker: finding.trustedMarker }
      : {}),
    projectionObservationIds: [...finding.observationIds],
  };
}

function candidateContributedToFinding(
  candidate: CurrentFindingCandidate,
  finding: Finding
): boolean {
  return (
    normalizePath(candidate.filePath) === normalizePath(finding.file) &&
    Math.abs((candidate.line ?? candidate.endLine ?? 1) - finding.line) <= 2 &&
    (candidate.normalizedFailureModeHash ===
      (finding as FindingWithProjectionMetadata).projectionFailureModeHash ||
      normalizeText(candidate.title) === normalizeText(finding.title))
  );
}

function lifecycleProviderResults(
  query: ProjectLifecycleQuery
): ProviderResult[] {
  const byProvider = new Map<string, typeof query.revalidations>();
  for (const revalidation of query.revalidations) {
    const existing = byProvider.get(revalidation.providerVoteKey) ?? [];
    byProvider.set(revalidation.providerVoteKey, [...existing, revalidation]);
  }
  return Array.from(byProvider.entries()).map(([provider, revalidations]) => ({
    name: provider,
    status: 'success',
    durationSeconds: 0,
    lifecycleAssignedTargetIds: revalidations.map(
      (revalidation) => revalidation.targetId
    ),
    result: {
      content: '',
      revalidations: revalidations.map((revalidation) => ({
        targetId: revalidation.targetId,
        verdict: revalidation.verdict,
        ...(revalidation.confidence !== undefined
          ? { confidence: revalidation.confidence }
          : {}),
        ...(revalidation.rationale
          ? { rationale: revalidation.rationale }
          : {}),
      })),
    },
  }));
}

function toLegacyLifecycleTarget(
  target: ProjectLifecycleQuery['inventory']['targets'][number]
): LifecycleTarget {
  return {
    targetId: target.targetId,
    threadId: target.threadId,
    fingerprint: target.trustedMarker,
    severity: target.severity,
    title: target.title,
    message: target.message,
    originalPath: target.originalPath,
    ...(target.currentPath ? { currentPath: target.currentPath } : {}),
    ...(target.originalLine !== undefined
      ? { originalLine: target.originalLine }
      : {}),
    ...(target.currentLine !== undefined
      ? { currentLine: target.currentLine }
      : {}),
    parentCommentId: target.targetId,
    parentCommentUpdatedAt: target.parentCommentUpdatedAt,
    threadCommentCount: target.threadCommentCount,
    viewerCanResolve: target.viewerCanResolve,
    hasHumanReply: target.disposition === LifecycleTargetDisposition.HumanReply,
    trustedAuthor: true,
  };
}

function legacyLifecycleRecord(
  target: LifecycleTarget,
  reasonCodes: LifecycleReasonCode[]
): LifecycleThreadRecord {
  return { target, reasonCodes };
}

function toLegacyPrContext(query: ProjectReviewPresentationQuery): PRContext {
  return {
    number: query.scope.pullRequestNumber,
    title: query.presentation.title,
    body: '',
    author: query.presentation.author,
    draft: false,
    labels: [],
    files: query.revisionFiles.map(toLegacyFileChange),
    diff: query.revisionFiles
      .map((file) => file.patch ?? '')
      .filter(Boolean)
      .join('\n'),
    additions: query.presentation.additions,
    deletions: query.presentation.deletions,
    baseSha: query.scope.baseSha,
    headSha: query.scope.reviewedHeadSha,
  };
}

function toLegacyFileChange(file: RevisionFile): FileChange {
  return {
    filename: file.path,
    status: file.status,
    additions: 0,
    deletions: 0,
    changes: 0,
    ...(file.patch ? { patch: file.patch } : {}),
    ...(file.previousPath ? { previousFilename: file.previousPath } : {}),
  };
}

function minimalLegacyReview(findings: Finding[]): Review {
  return {
    summary: '',
    findings,
    inlineComments: [],
    actionItems: [],
    metrics: {
      totalFindings: findings.length,
      critical: findings.filter((finding) => finding.severity === 'critical')
        .length,
      major: findings.filter((finding) => finding.severity === 'major').length,
      minor: findings.filter((finding) => finding.severity === 'minor').length,
      providersUsed: 0,
      providersSuccess: 0,
      providersFailed: 0,
      totalTokens: 0,
      totalCost: 0,
      durationSeconds: 0,
    },
  };
}

function formatLifecycleLines(
  headSha: string,
  occurrences: readonly FindingOccurrence[]
): string[] {
  return occurrences.map((occurrence) => {
    switch (occurrence.state) {
      case FindingOccurrenceState.New:
        return `New on ${headSha}: ${occurrence.title}`;
      case FindingOccurrenceState.Reconfirmed:
        return `Reconfirmed on ${headSha}: ${occurrence.title}`;
      case FindingOccurrenceState.Changed:
        return `Severity changed: ${occurrence.previousSeverity ?? 'unknown'} -> ${occurrence.severity} on ${headSha}: ${occurrence.title}`;
      case FindingOccurrenceState.CarriedUnverified:
        return `Carried from ${occurrence.firstSeenHeadSha} - not revalidated: ${occurrence.title}`;
      case FindingOccurrenceState.Resolved:
        return `Resolved on ${headSha} after revalidation: ${occurrence.title}`;
      case FindingOccurrenceState.Uncertain:
        return `Needs lifecycle attention on ${headSha}: ${occurrence.title}`;
      case FindingOccurrenceState.SuppressedByHuman:
        return `Suppressed by current human command: ${occurrence.title}`;
    }
  });
}

function findRevisionFile(
  path: string,
  revisionFiles: readonly RevisionFile[]
): RevisionFile | undefined {
  const normalized = normalizePath(path);
  return revisionFiles.find(
    (file) =>
      normalizePath(file.path) === normalized ||
      (file.previousPath && normalizePath(file.previousPath) === normalized)
  );
}

function summaryPlacement(
  occurrence: FindingOccurrence,
  reason: string
): FindingPlacementDecision {
  return {
    lineageId: occurrence.lineageId,
    kind: FindingPlacementKind.Summary,
    path: occurrence.filePath,
    reason,
  };
}

function isCurrentOccurrence(occurrence: FindingOccurrence): boolean {
  return (
    occurrence.state === FindingOccurrenceState.New ||
    occurrence.state === FindingOccurrenceState.Reconfirmed ||
    occurrence.state === FindingOccurrenceState.Changed
  );
}

function toProjectionSeverity(severity: Severity): FindingSeverity {
  return severity as FindingSeverity;
}

function toLegacySeverity(severity: FindingSeverity): Severity {
  return severity as Severity;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function sortedUnique(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) =>
    left.localeCompare(right)
  );
}
