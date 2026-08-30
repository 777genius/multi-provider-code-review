import {
  Finding,
  LifecycleAssignmentRecord,
  LifecycleQuorumMode,
  LifecycleReasonCode,
  LifecycleSeverity,
  LifecycleTarget,
  LifecycleThreadRecord,
  ProviderLifecycleRevalidation,
  ProviderLifecycleVote,
  ProviderResult,
  ReviewConfig,
  ReviewThreadLifecycleMode,
  ReviewThreadLifecycleResult,
  Severity,
} from '../types';
import {
  findingFingerprintFromFinding,
  InlineCommentReference,
  sameSemanticLineage,
} from '../github/comment-fingerprint';

export interface ThreadLifecycleAggregationInput {
  mode: ReviewThreadLifecycleMode;
  targets: LifecycleTarget[];
  plannedProviders: string[];
  providerResults: ProviderResult[];
  currentFindings: Finding[];
  assignmentRecords?: LifecycleAssignmentRecord[];
  initialManualAttention?: LifecycleThreadRecord[];
  skipped?: LifecycleThreadRecord[];
  warnings?: string[];
  inventoryFailed?: boolean;
  config?: Pick<ReviewConfig, 'reviewThreadLifecycleResolveConfidence'>;
}

const DEFAULT_RESOLVE_CONFIDENCE: Record<LifecycleSeverity, number> = {
  critical: 0.9,
  major: 0.85,
  minor: 0.8,
  unknown: 0.9,
};

export class ThreadLifecycleAggregator {
  aggregate(
    input: ThreadLifecycleAggregationInput
  ): ReviewThreadLifecycleResult {
    const plannedProviders = unique(input.plannedProviders);
    const quorumMode: LifecycleQuorumMode =
      plannedProviders.length >= 2 ? 'multi-provider' : 'single-provider';
    const thresholds = resolveConfidenceThresholds(
      input.config?.reviewThreadLifecycleResolveConfidence
    );
    const currentFingerprints = new Set(
      input.currentFindings.map((finding) =>
        findingFingerprintFromFinding(finding)
      )
    );
    const providerCurrentFindings = input.providerResults.flatMap(
      (result) => result.result?.findings ?? []
    );
    const votes = this.collectVotes(input, thresholds);
    const assignmentByTarget = new Map(
      (input.assignmentRecords ?? []).map((record) => [record.targetId, record])
    );
    const commandDismissedTargetIds = new Set(
      (input.skipped ?? [])
        .filter((record) => record.reasonCodes.includes('command_dismissed'))
        .map((record) => record.target.targetId)
    );

    const result: ReviewThreadLifecycleResult = {
      mode: input.mode,
      quorumMode,
      plannedProviders,
      resolvedCandidates: [],
      resolvedByLifecycle: [],
      previousStillValid: [],
      previousUncertain: [],
      manualAttention: (input.initialManualAttention ?? []).filter(
        (record) => !commandDismissedTargetIds.has(record.target.targetId)
      ),
      mutationSkipped: [],
      mutationFailed: [],
      skipped: [...(input.skipped ?? [])],
      warnings: [...(input.warnings ?? [])],
      inventoryFailed: input.inventoryFailed,
    };

    if (input.inventoryFailed) {
      result.warnings.push('review thread lifecycle inventory failed');
      for (const target of input.targets) {
        result.previousUncertain.push({
          target,
          reasonCodes: unique([
            ...(target.reasonCodes ?? []),
            'inventory_failed',
          ]) as LifecycleReasonCode[],
        });
      }
      return result;
    }

    for (const target of input.targets) {
      const targetVotes = Array.from(
        votes.get(target.targetId)?.values() ?? []
      );
      const record = (
        reasonCodes: LifecycleReasonCode[]
      ): LifecycleThreadRecord => ({
        target,
        reasonCodes: unique([
          ...(target.reasonCodes ?? []),
          ...reasonCodes,
        ]) as LifecycleReasonCode[],
        providerVotes: targetVotes,
      });

      if (target.hasHumanReply || !target.trustedAuthor) {
        const reasonCodes: LifecycleReasonCode[] = [];
        if (target.hasHumanReply) reasonCodes.push('human_reply');
        if (!target.trustedAuthor) reasonCodes.push('untrusted_author');
        result.manualAttention.push(record(reasonCodes));
        continue;
      }

      if (
        currentFingerprints.has(target.fingerprint) ||
        input.currentFindings.some((finding) =>
          currentFindingMatchesTarget(finding, target)
        )
      ) {
        result.previousStillValid.push(record(['current_finding_present']));
        continue;
      }
      if (
        providerCurrentFindings.some((finding) =>
          currentFindingMatchesTarget(finding, target)
        )
      ) {
        result.previousStillValid.push(
          record(['provider_current_finding_present'])
        );
        continue;
      }

      const assignment = assignmentByTarget.get(target.targetId);
      const assignedProviders =
        assignment?.assignedProviderIds ?? plannedProviders;
      const missingProviderReasons = plannedProviders
        .filter((provider) => !assignedProviders.includes(provider))
        .map(() => 'outside_review_scope' as LifecycleReasonCode);
      if (
        assignment &&
        (assignment.scopeStatus !== 'in_scope' ||
          assignedProviders.length === 0)
      ) {
        result.previousUncertain.push(
          record(
            unique([
              ...missingProviderReasons,
              'outside_review_scope',
              'insufficient_resolved_quorum',
            ]) as LifecycleReasonCode[]
          )
        );
        continue;
      }

      const stillValidVotes = targetVotes.filter(
        (vote) => vote.valid && vote.verdict === 'still_valid'
      );
      if (stillValidVotes.length > 0) {
        result.previousStillValid.push(record(['still_valid_vote']));
        continue;
      }

      const expectedProviders = plannedProviders.filter((provider) =>
        assignedProviders.includes(provider)
      );
      const providerFailures = assignment
        ? new Set(assignment.failedProviderIds ?? [])
        : this.providerFailures(input.providerResults);
      const missingOrFailedReasons: LifecycleReasonCode[] = [
        ...missingProviderReasons,
      ];

      for (const provider of expectedProviders) {
        if (providerFailures.has(provider)) {
          missingOrFailedReasons.push('provider_failed');
          continue;
        }
        if (!votes.get(target.targetId)?.has(provider)) {
          missingOrFailedReasons.push('provider_missing_revalidation');
        }
      }

      const resolvedVotes = targetVotes.filter(
        (vote) => vote.valid && vote.verdict === 'resolved'
      );
      const uncertainVotes = targetVotes.filter(
        (vote) => vote.valid && vote.verdict === 'uncertain'
      );
      const invalidVoteReasons = targetVotes.flatMap((vote) =>
        vote.valid ? [] : vote.reasonCodes
      );
      const hasResolvedQuorum =
        quorumMode === 'single-provider'
          ? resolvedVotes.length === 1 && plannedProviders.length === 1
          : resolvedVotes.length >= 2;

      if (hasResolvedQuorum) {
        if (input.mode === 'report') {
          result.mutationSkipped.push(record(['report_mode']));
        } else {
          result.resolvedCandidates.push(record([]));
        }
        continue;
      }

      result.previousUncertain.push(
        record(
          unique([
            ...missingOrFailedReasons,
            ...invalidVoteReasons,
            ...(uncertainVotes.length > 0
              ? (['provider_uncertain'] as LifecycleReasonCode[])
              : []),
            'insufficient_resolved_quorum',
          ]) as LifecycleReasonCode[]
        )
      );
    }

    return result;
  }

  private collectVotes(
    input: ThreadLifecycleAggregationInput,
    thresholds: Record<LifecycleSeverity, number>
  ): Map<string, Map<string, ProviderLifecycleVote>> {
    const targetIds = new Set(input.targets.map((target) => target.targetId));
    const targetsById = new Map(
      input.targets.map((target) => [target.targetId, target])
    );
    const plannedProviders = new Set(input.plannedProviders);
    const votes = new Map<string, Map<string, ProviderLifecycleVote>>();

    for (const result of input.providerResults) {
      if (!plannedProviders.has(result.name)) continue;
      if (result.status !== 'success') continue;
      const assignedTargetIds = result.lifecycleAssignedTargetIds
        ? new Set(result.lifecycleAssignedTargetIds)
        : null;
      for (const raw of result.result?.revalidations ?? []) {
        const rawTargetId = raw.targetId || '';
        if (assignedTargetIds && !assignedTargetIds.has(rawTargetId)) {
          continue;
        }
        const vote = this.normalizeVote(
          result.name,
          raw,
          targetIds,
          targetsById,
          thresholds
        );
        if (!vote) continue;
        if (!votes.has(vote.targetId)) {
          votes.set(vote.targetId, new Map());
        }
        const providerVotes = votes.get(vote.targetId)!;
        const existing = providerVotes.get(vote.providerId);
        providerVotes.set(
          vote.providerId,
          existing ? safestVote(existing, vote) : vote
        );
      }
    }

    return votes;
  }

  private normalizeVote(
    providerId: string,
    raw: ProviderLifecycleRevalidation,
    targetIds: Set<string>,
    targetsById: Map<string, LifecycleTarget>,
    thresholds: Record<LifecycleSeverity, number>
  ): ProviderLifecycleVote | null {
    const reasonCodes: LifecycleReasonCode[] = [];
    if (!raw.targetId) {
      return {
        providerId,
        targetId: '',
        fingerprint: raw.fingerprint,
        verdict: 'uncertain',
        confidence: raw.confidence,
        evidence: raw.evidence,
        rationale: raw.rationale,
        valid: false,
        reasonCodes: ['missing_target_id'],
      };
    }
    if (!targetIds.has(raw.targetId)) {
      return null;
    }
    const target = targetsById.get(raw.targetId)!;
    const evidence = Array.isArray(raw.evidence) ? raw.evidence : [];
    const rationale = typeof raw.rationale === 'string' ? raw.rationale : '';
    const verdict = this.validVerdict(raw.verdict) ? raw.verdict : 'uncertain';

    if (raw.fingerprint && raw.fingerprint !== target.fingerprint) {
      reasonCodes.push('unknown_target_id');
    }

    if (verdict === 'resolved') {
      const threshold = thresholds[target.severity] ?? thresholds.unknown;
      const confidence =
        typeof raw.confidence === 'number' ? raw.confidence : 0;
      if (
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1 ||
        confidence < threshold ||
        !hasConcreteEvidence(evidence)
      ) {
        reasonCodes.push('invalid_resolved_evidence');
      }
    }

    if (
      verdict === 'still_valid' &&
      !rationale.trim() &&
      !hasConcreteEvidence(evidence)
    ) {
      reasonCodes.push('invalid_resolved_evidence');
    }

    return {
      providerId,
      targetId: raw.targetId,
      fingerprint: raw.fingerprint,
      verdict,
      confidence: raw.confidence,
      evidence,
      rationale,
      valid: reasonCodes.length === 0,
      reasonCodes,
    };
  }

  private validVerdict(
    value: string
  ): value is ProviderLifecycleRevalidation['verdict'] {
    return (
      value === 'resolved' || value === 'still_valid' || value === 'uncertain'
    );
  }

  private providerFailures(results: ProviderResult[]): Set<string> {
    return new Set(
      results
        .filter((result) => result.status !== 'success')
        .map((result) => result.name)
    );
  }
}

export function countPreviousStillValidBySeverity(
  lifecycle: ReviewThreadLifecycleResult | undefined
): Record<Severity, number> {
  const counts: Record<Severity, number> = {
    critical: 0,
    major: 0,
    minor: 0,
  };
  for (const record of lifecycle?.previousStillValid ?? []) {
    if (isLinkedCurrentFinding(record)) continue;
    const severity = record.target.severity;
    if (
      severity === 'critical' ||
      severity === 'major' ||
      severity === 'minor'
    ) {
      counts[severity] += 1;
    }
  }
  return counts;
}

export function isLinkedCurrentFinding(record: LifecycleThreadRecord): boolean {
  return record.reasonCodes.includes('current_finding_present');
}

export function hasLifecycleUncertainty(
  lifecycle: ReviewThreadLifecycleResult | undefined
): boolean {
  if (!lifecycle || lifecycle.mode === 'off') return false;
  return Boolean(
    lifecycle.inventoryFailed ||
    lifecycle.warnings.length > 0 ||
    lifecycle.previousUncertain.length > 0 ||
    lifecycle.manualAttention.length > 0 ||
    lifecycle.mutationSkipped.length > 0 ||
    lifecycle.mutationFailed.length > 0 ||
    lifecycle.skipped.some(
      (record) =>
        !record.reasonCodes.every((reason) => reason === 'command_dismissed')
    )
  );
}

export function reconcileCarriedFindingsWithLifecycle(input: {
  mergedFindings: readonly Finding[];
  carriedFindings: readonly Finding[];
  lifecycle: ReviewThreadLifecycleResult;
}): { findings: Finding[]; removed: Finding[] } {
  if (input.carriedFindings.length === 0 || input.lifecycle.inventoryFailed) {
    return { findings: [...input.mergedFindings], removed: [] };
  }

  const carried = new Set(input.carriedFindings);
  const projectionInactiveTargets = [
    ...input.lifecycle.resolvedByLifecycle.map((record) => record.target),
    ...input.lifecycle.mutationFailed
      .filter((record) => hasTrustedResolutionFallback(record, input.lifecycle))
      .map((record) => record.target),
    ...allLifecycleRecords(input.lifecycle)
      .filter((record) => hasTrustedRecordedResolution(record.target))
      .map((record) => record.target),
  ];
  if (projectionInactiveTargets.length === 0) {
    return { findings: [...input.mergedFindings], removed: [] };
  }

  const removed: Finding[] = [];
  const findings = input.mergedFindings.filter((finding) => {
    if (!carried.has(finding)) return true;
    const inactive = projectionInactiveTargets.some((target) =>
      currentFindingMatchesTarget(finding, target)
    );
    if (inactive) removed.push(finding);
    return !inactive;
  });

  return { findings, removed };
}

function allLifecycleRecords(
  lifecycle: ReviewThreadLifecycleResult
): LifecycleThreadRecord[] {
  return [
    ...lifecycle.resolvedCandidates,
    ...lifecycle.resolvedByLifecycle,
    ...lifecycle.previousStillValid,
    ...lifecycle.previousUncertain,
    ...lifecycle.manualAttention,
    ...lifecycle.mutationSkipped,
    ...lifecycle.mutationFailed,
    ...lifecycle.skipped,
  ];
}

function hasTrustedRecordedResolution(target: LifecycleTarget): boolean {
  const marker = target.trustedResolutionMarker;
  return Boolean(
    marker &&
    target.trustedAuthor &&
    !target.hasHumanReply &&
    marker.schemaVersion === 'reviewrouter-lifecycle-resolution.v1' &&
    marker.targetId === target.targetId &&
    marker.fingerprint === target.fingerprint
  );
}

function hasTrustedResolutionFallback(
  record: LifecycleThreadRecord,
  lifecycle: ReviewThreadLifecycleResult
): boolean {
  const reasonCodes = new Set(record.reasonCodes);
  if (
    lifecycle.mode !== 'resolve' ||
    !record.target.trustedAuthor ||
    record.target.hasHumanReply ||
    !reasonCodes.has('mutation_permission_denied') ||
    !reasonCodes.has('resolution_comment_posted') ||
    Array.from(reasonCodes).some(
      (reason) =>
        reason !== 'mutation_permission_denied' &&
        reason !== 'resolution_comment_posted'
    )
  ) {
    return false;
  }

  const resolvedProviders = new Set(
    (record.providerVotes ?? [])
      .filter((vote) => vote.valid && vote.verdict === 'resolved')
      .map((vote) => vote.providerId)
  );
  return lifecycle.quorumMode === 'single-provider'
    ? resolvedProviders.size >= 1
    : resolvedProviders.size >= 2;
}

function hasConcreteEvidence(
  evidence: Array<{ path?: string; reason?: string }>
): boolean {
  return evidence.some(
    (item) =>
      typeof item.path === 'string' &&
      item.path.trim().length > 0 &&
      typeof item.reason === 'string' &&
      item.reason.trim().length > 0
  );
}

function resolveConfidenceThresholds(
  overrides?: Partial<Record<LifecycleSeverity, number>>
): Record<LifecycleSeverity, number> {
  const thresholds = { ...DEFAULT_RESOLVE_CONFIDENCE };
  for (const severity of Object.keys(thresholds) as LifecycleSeverity[]) {
    const value = overrides?.[severity];
    if (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1
    ) {
      thresholds[severity] = value;
    }
  }
  return thresholds;
}

function currentFindingMatchesTarget(
  finding: Finding,
  target: LifecycleTarget
): boolean {
  const targetPath = target.currentPath || target.originalPath;
  const targetLine = target.currentLine ?? target.originalLine ?? null;
  const targetReference: InlineCommentReference = {
    path: targetPath,
    line: targetLine,
    body: lifecycleTargetBody(target),
  };
  const findingReference: InlineCommentReference = {
    path: finding.file,
    line: finding.line,
    body: `**${finding.severity} - ${finding.title}**\n\n${finding.message}`,
  };
  return sameSemanticLineage(targetReference, findingReference);
}

function lifecycleTargetBody(target: LifecycleTarget): string {
  const severity =
    target.severity === 'critical' ||
    target.severity === 'major' ||
    target.severity === 'minor'
      ? target.severity
      : 'minor';
  return `**${severity} - ${target.title}**\n\n${target.message}`;
}

function safestVote(
  left: ProviderLifecycleVote,
  right: ProviderLifecycleVote
): ProviderLifecycleVote {
  const rank = (vote: ProviderLifecycleVote): number => {
    if (vote.valid && vote.verdict === 'still_valid') return 3;
    if (!vote.valid || vote.verdict === 'uncertain') return 2;
    if (vote.valid && vote.verdict === 'resolved') return 1;
    return 0;
  };
  return rank(right) > rank(left) ? right : left;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
