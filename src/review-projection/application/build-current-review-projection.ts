import {
  BuiltCurrentReviewProjection,
  CheckConclusion,
  CurrentFindingCandidate,
  CurrentLifecycleInventory,
  FindingOccurrence,
  FindingOccurrenceState,
  FindingPlacementDecision,
  FindingPlacementKind,
  FindingSeverity,
  LifecycleProjectionDecision,
  LifecycleRevalidation,
  LifecycleRevalidationVerdict,
  LifecycleResolutionMarkerTrust,
  LifecycleTargetDisposition,
  LineageHintFact,
  MergeGateConclusion,
  OccurrenceProvenanceFact,
  PriorLineageHint,
  ProjectionCoverageState,
  ReviewCoverageFact,
  ReviewProjectionEnvelopeV1,
  ReviewProjectionEnvelopeVersion,
  ReviewProjectionInlineChunkFact,
  ReviewProjectionLifecycleFact,
  ReviewProjectionPresentationContext,
  ReviewProjectionScope,
  RevisionFile,
  SelectedCurrentFinding,
} from '../domain/review-projection';
import {
  canonicalizeReviewProjection,
  deepFreezeProjection,
  hashProjectionFact,
  hashReviewProjectionCanonicalJson,
} from '../domain/review-projection-canonicalizer';
import {
  CurrentReviewProjector,
  hasValidTrustedResolutionMarker,
} from '../domain/current-review-projector';
import {
  assertWithinProjectionLimit,
  ReviewProjectionLimits,
  validateReviewProjectionLimits,
} from '../domain/review-projection-limits';
import {
  CurrentFindingPolicyPort,
  CurrentLifecycleInventoryPort,
  MergeGateDecision,
  ProviderExecutionSummaryFact,
  ReviewLifecyclePolicyPort,
  ReviewMergeGatePolicyPort,
  ReviewPresentationPolicyPort,
} from './review-projection-ports';

export interface BuildCurrentReviewProjectionCommand {
  readonly projectionPolicyVersion: string;
  readonly authoritativeObservationIds: readonly string[];
  readonly scope: ReviewProjectionScope;
  readonly presentation: ReviewProjectionPresentationContext;
  readonly providerExecution: ProviderExecutionSummaryFact;
  readonly currentFindings: readonly CurrentFindingCandidate[];
  readonly priorLineageHints: readonly PriorLineageHint[];
  readonly lifecycleRevalidations: readonly LifecycleRevalidation[];
  readonly coverage: ReviewCoverageFact;
  readonly revisionFiles: readonly RevisionFile[];
  readonly diff: string;
  readonly failOnSeverity?: FindingSeverity;
}

export interface BuildCurrentReviewProjectionDependencies {
  readonly lifecycleInventory: CurrentLifecycleInventoryPort;
  readonly findingPolicy: CurrentFindingPolicyPort;
  readonly lifecyclePolicy: ReviewLifecyclePolicyPort;
  readonly presentationPolicy: ReviewPresentationPolicyPort;
  readonly mergeGatePolicy: ReviewMergeGatePolicyPort;
  readonly limits: ReviewProjectionLimits;
}

export class BuildCurrentReviewProjection {
  private readonly limits: ReviewProjectionLimits;
  private readonly currentReviewProjector = new CurrentReviewProjector();

  constructor(
    private readonly dependencies: BuildCurrentReviewProjectionDependencies
  ) {
    this.limits = validateReviewProjectionLimits(dependencies.limits);
  }

  async execute(
    command: BuildCurrentReviewProjectionCommand
  ): Promise<BuiltCurrentReviewProjection> {
    this.validateCommand(command);

    // Loading belongs inside this use case so callers cannot reuse stale inventory.
    const inventory = await this.dependencies.lifecycleInventory.loadCurrent({
      scope: command.scope,
    });
    this.validateInventory(command.scope, inventory);

    const coverage = normalizeCoverage(command.coverage, inventory);
    const selectedFindings =
      await this.dependencies.findingPolicy.selectCurrent({
        findings: command.currentFindings,
        revisionFiles: command.revisionFiles,
        diff: command.diff,
        limits: this.limits,
      });
    assertWithinProjectionLimit(
      'maxFindings',
      selectedFindings.length,
      this.limits
    );
    validateSelectedFindings(
      command.currentFindings,
      selectedFindings,
      this.limits
    );

    const lifecycleDecisions =
      await this.dependencies.lifecyclePolicy.projectLifecycle({
        scope: command.scope,
        findings: selectedFindings,
        priorLineageHints: command.priorLineageHints,
        inventory,
        revalidations: command.lifecycleRevalidations,
      });
    validateLifecycleDecisions(inventory, lifecycleDecisions);

    let occurrences = this.currentReviewProjector.projectOccurrences({
      scope: command.scope,
      selectedFindings,
      priorLineageHints: command.priorLineageHints,
      inventory,
      lifecycleDecisions,
    });
    assertWithinProjectionLimit('maxFindings', occurrences.length, this.limits);
    assertUnique(
      'occurrence lineageId',
      occurrences.map((occurrence) => occurrence.lineageId)
    );

    const gate = this.dependencies.mergeGatePolicy.evaluateMergeGate({
      failOnSeverity: command.failOnSeverity,
      occurrences,
      coverage,
      lifecycleInventoryComplete: inventory.complete,
    });
    validateGateDecision(occurrences, gate);
    occurrences = applyBlockingDecision(occurrences, gate);

    const presentation =
      await this.dependencies.presentationPolicy.projectPresentation({
        scope: command.scope,
        presentation: command.presentation,
        providerExecution: command.providerExecution,
        coverage,
        occurrences,
        revisionFiles: command.revisionFiles,
        limits: this.limits,
      });
    occurrences = applyPlacementDecisions(occurrences, presentation.placements);

    const coverageOnly = coverage.state === ProjectionCoverageState.Partial;
    const allClear =
      !coverageOnly && canClaimAllClear(coverage, inventory, occurrences, gate);
    // Preserve target identities even for partial coverage so the control plane
    // can prove that live lifecycle state is still the state this projection saw.
    // buildLifecycleFacts already makes every partial-coverage target ineligible
    // for mutation.
    const lifecycleFacts = buildLifecycleFacts(
      inventory,
      lifecycleDecisions,
      command.priorLineageHints,
      coverage,
      occurrences
    );
    const inlineChunks = coverageOnly
      ? []
      : buildInlineChunks(occurrences, this.limits);
    const summaryBody = coverageOnly
      ? [
          'ReviewRouter did not complete required coverage. Preliminary findings are preserved below; inline comments and lifecycle changes were held back.',
          '',
          removeAllClearClaims(presentation.summaryBody),
        ].join('\n')
      : allClear
        ? presentation.summaryBody
        : removeAllClearClaims(presentation.summaryBody);
    const checkTitle = coverageOnly
      ? 'Review incomplete - partial coverage'
      : allClear
        ? presentation.checkTitle
        : removeAllClearClaims(presentation.checkTitle);
    const checkSummary = coverageOnly
      ? summaryBody
      : allClear
        ? presentation.checkSummary
        : removeAllClearClaims(presentation.checkSummary);
    if (coverageOnly) {
      assertPartialPresentationDoesNotClaimCompletion(
        summaryBody,
        checkTitle,
        checkSummary
      );
    }
    this.validateRenderedText(
      summaryBody,
      presentation.checkName,
      checkTitle,
      checkSummary,
      inlineChunks
    );

    const envelope: ReviewProjectionEnvelopeV1 = deepFreezeProjection({
      envelopeVersion: ReviewProjectionEnvelopeVersion.V1,
      projectionPolicyVersion: command.projectionPolicyVersion,
      authoritativeObservationIds: sortCodeUnits(
        command.authoritativeObservationIds
      ),
      scope: { ...command.scope },
      coverage,
      lifecycleStateHash: inventory.lifecycleStateHash,
      commandLedgerWatermark: inventory.commandLedgerWatermark,
      occurrences,
      mergeGate: {
        conclusion: gate.conclusion,
        blockingLineageIds: sortedUnique(gate.blockingLineageIds),
        reasonCodes: sortedUnique(gate.reasonCodes),
      },
      publishing: {
        summary: {
          marker: publicationMarker('summary', command.scope),
          body: summaryBody,
          allClear,
          occurrenceCounts: countOccurrenceStates(occurrences),
        },
        check: {
          marker: publicationMarker('check', command.scope),
          name: presentation.checkName,
          title: checkTitle,
          summary: checkSummary,
          conclusion: coverageOnly
            ? CheckConclusion.Neutral
            : resolveCheckConclusion(presentation.checkConclusion, gate),
        },
        inlineReviewChunks: inlineChunks,
        lifecycle: lifecycleFacts,
      },
      snapshot: coverageOnly
        ? { occurrenceProvenance: [], lineageHints: [] }
        : buildSnapshotFacts(occurrences),
    });

    const canonicalJson = canonicalizeReviewProjection(envelope);
    const byteCount = Buffer.byteLength(canonicalJson, 'utf8');
    assertWithinProjectionLimit('maxProjectionBytes', byteCount, this.limits);

    return deepFreezeProjection({
      envelope,
      canonicalJson,
      projectionHash: hashReviewProjectionCanonicalJson(canonicalJson),
      byteCount,
      findingCount: occurrences.length,
    });
  }

  private validateCommand(command: BuildCurrentReviewProjectionCommand): void {
    assertNonEmpty('projectionPolicyVersion', command.projectionPolicyVersion);
    validateAuthoritativeObservationIds(
      command.authoritativeObservationIds,
      this.limits
    );
    validateProviderExecutionSummary(command.providerExecution);
    assertNonEmpty(
      'scmRepositoryIdentityId',
      command.scope.scmRepositoryIdentityId
    );
    assertNonEmpty('baseSha', command.scope.baseSha);
    assertNonEmpty('reviewedHeadSha', command.scope.reviewedHeadSha);
    assertNonEmpty('reviewRevisionHash', command.scope.reviewRevisionHash);
    if (!Number.isSafeInteger(command.scope.pullRequestNumber)) {
      throw new Error('pullRequestNumber must be a safe integer');
    }
    assertWithinProjectionLimit(
      'maxFindings',
      command.currentFindings.length,
      this.limits
    );
    assertWithinProjectionLimit(
      'maxLineageHints',
      command.priorLineageHints.length,
      this.limits
    );
    assertWithinProjectionLimit(
      'maxLifecycleTargets',
      command.lifecycleRevalidations.length,
      this.limits
    );
    assertWithinProjectionLimit(
      'maxRevisionFiles',
      command.revisionFiles.length,
      this.limits
    );
    assertWithinProjectionLimit(
      'maxDiffBytes',
      Buffer.byteLength(command.diff, 'utf8'),
      this.limits
    );
    for (const finding of command.currentFindings) {
      validateFinding(finding, this.limits);
    }
    assertUnique(
      'sourceFindingId',
      command.currentFindings.map((finding) => finding.sourceFindingId)
    );
    assertUnique(
      'prior lineageId',
      command.priorLineageHints.map((hint) => hint.lineageId)
    );
    assertUnique(
      'revision file path',
      command.revisionFiles.map((file) => normalizePath(file.path))
    );
    for (const hint of command.priorLineageHints) {
      for (const value of [
        hint.lineageId,
        hint.category,
        hint.normalizedFailureModeHash,
        hint.symbolAnchor ?? '',
        hint.trustedMarker ?? '',
        hint.title,
        hint.message,
        hint.filePath,
      ]) {
        assertWithinProjectionLimit(
          'maxStringBytes',
          Buffer.byteLength(value, 'utf8'),
          this.limits
        );
      }
    }
  }

  private validateInventory(
    scope: ReviewProjectionScope,
    inventory: CurrentLifecycleInventory
  ): void {
    if (inventory.inventoryVersion !== 'review_lifecycle_inventory.v1') {
      throw new Error('unsupported lifecycle inventory version');
    }
    if (inventory.loadedForHeadSha !== scope.reviewedHeadSha) {
      throw new Error(
        'lifecycle inventory was not loaded for the reviewed head'
      );
    }
    assertNonEmpty('lifecycleStateHash', inventory.lifecycleStateHash);
    assertNonEmpty('commandLedgerWatermark', inventory.commandLedgerWatermark);
    assertWithinProjectionLimit(
      'maxLifecycleTargets',
      inventory.targets.length,
      this.limits
    );
    assertUnique(
      'lifecycle targetId',
      inventory.targets.map((target) => target.targetId)
    );
    for (const target of inventory.targets) {
      for (const value of [
        target.targetId,
        target.threadId,
        target.trustedMarker,
        target.title,
        target.message,
        target.originalPath,
        target.currentPath ?? '',
      ]) {
        assertWithinProjectionLimit(
          'maxStringBytes',
          Buffer.byteLength(value, 'utf8'),
          this.limits
        );
      }
    }
  }

  private validateRenderedText(
    summary: string,
    checkName: string,
    checkTitle: string,
    checkSummary: string,
    chunks: readonly ReviewProjectionInlineChunkFact[]
  ): void {
    assertWithinProjectionLimit(
      'maxSummaryBytes',
      Buffer.byteLength(summary, 'utf8'),
      this.limits
    );
    for (const value of [checkName, checkTitle]) {
      assertWithinProjectionLimit(
        'maxStringBytes',
        Buffer.byteLength(value, 'utf8'),
        this.limits
      );
    }
    assertWithinProjectionLimit(
      'maxCheckSummaryBytes',
      Buffer.byteLength(checkSummary, 'utf8'),
      this.limits
    );
    for (const chunk of chunks) {
      for (const comment of chunk.comments) {
        assertWithinProjectionLimit(
          'maxInlineCommentBodyBytes',
          Buffer.byteLength(comment.body, 'utf8'),
          this.limits
        );
      }
    }
  }
}

function validateProviderExecutionSummary(
  summary: ProviderExecutionSummaryFact
): void {
  if (
    !Number.isSafeInteger(summary.plannedProviders) ||
    summary.plannedProviders < 0
  ) {
    throw new Error('plannedProviders must be a non-negative safe integer');
  }
  if (
    !Number.isSafeInteger(summary.succeededProviders) ||
    summary.succeededProviders < 0 ||
    summary.succeededProviders > summary.plannedProviders
  ) {
    throw new Error(
      'succeededProviders must be between zero and plannedProviders'
    );
  }
}

function validateAuthoritativeObservationIds(
  observationIds: readonly string[],
  limits: ReviewProjectionLimits
): void {
  for (const observationId of observationIds) {
    assertNonEmpty('authoritative observationId', observationId);
    assertWithinProjectionLimit(
      'maxStringBytes',
      Buffer.byteLength(observationId, 'utf8'),
      limits
    );
  }
  assertUnique('authoritative observationId', observationIds);
}

function applyBlockingDecision(
  occurrences: readonly FindingOccurrence[],
  gate: MergeGateDecision
): FindingOccurrence[] {
  const blocking = new Set(gate.blockingLineageIds);
  return sortOccurrences(
    occurrences.map((occurrence) => ({
      ...occurrence,
      blocking: blocking.has(occurrence.lineageId),
    }))
  );
}

function applyPlacementDecisions(
  occurrences: readonly FindingOccurrence[],
  decisions: readonly FindingPlacementDecision[]
): FindingOccurrence[] {
  const byLineage = new Map<string, FindingPlacementDecision>();
  const knownLineages = new Set(
    occurrences.map((occurrence) => occurrence.lineageId)
  );
  for (const decision of decisions) {
    if (!knownLineages.has(decision.lineageId)) {
      throw new Error(
        `placement references unknown lineage ${decision.lineageId}`
      );
    }
    if (byLineage.has(decision.lineageId)) {
      throw new Error(`duplicate placement for lineage ${decision.lineageId}`);
    }
    byLineage.set(decision.lineageId, decision);
  }
  return sortOccurrences(
    occurrences.map((occurrence) => ({
      ...occurrence,
      placement:
        byLineage.get(occurrence.lineageId) ??
        summaryPlacement(
          occurrence.lineageId,
          occurrence.filePath,
          'placement unavailable'
        ),
    }))
  );
}

function buildInlineChunks(
  occurrences: readonly FindingOccurrence[],
  limits: ReviewProjectionLimits
): ReviewProjectionInlineChunkFact[] {
  const comments = occurrences
    .filter(
      (occurrence) =>
        occurrence.placement.kind === FindingPlacementKind.Inline &&
        occurrence.placement.line !== undefined &&
        occurrence.placement.body !== undefined &&
        occurrence.state !== FindingOccurrenceState.Resolved &&
        occurrence.state !== FindingOccurrenceState.SuppressedByHuman
    )
    .map((occurrence) => ({
      lineageId: occurrence.lineageId,
      marker: `reviewrouter:finding:v2:${occurrence.lineageId}`,
      path: occurrence.placement.path,
      ...(occurrence.placement.startLine !== undefined
        ? { startLine: occurrence.placement.startLine }
        : {}),
      line: occurrence.placement.line as number,
      ...(occurrence.placement.endLine !== undefined
        ? { endLine: occurrence.placement.endLine }
        : {}),
      body: occurrence.placement.body as string,
    }))
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.line - right.line ||
        left.lineageId.localeCompare(right.lineageId)
    );

  assertWithinProjectionLimit('maxInlineComments', comments.length, limits);
  const chunks: ReviewProjectionInlineChunkFact[] = [];
  for (let offset = 0; offset < comments.length; ) {
    const chunkComments = comments.slice(
      offset,
      offset + limits.maxInlineCommentsPerChunk
    );
    const chunkIndex = chunks.length;
    chunks.push({
      chunkIndex,
      marker: `reviewrouter:inline-chunk:v2:${chunkIndex}`,
      bodyHash: hashProjectionFact(chunkComments),
      comments: chunkComments,
    });
    offset += chunkComments.length;
  }
  assertWithinProjectionLimit('maxInlineChunks', chunks.length, limits);
  return chunks;
}

function buildLifecycleFacts(
  inventory: CurrentLifecycleInventory,
  decisions: readonly LifecycleProjectionDecision[],
  hints: readonly PriorLineageHint[],
  coverage: ReviewCoverageFact,
  occurrences: readonly FindingOccurrence[]
): ReviewProjectionLifecycleFact[] {
  const decisionByTarget = new Map(
    decisions.map((decision) => [decision.targetId, decision])
  );
  return [...inventory.targets]
    .sort((left, right) => left.targetId.localeCompare(right.targetId))
    .map((target) => {
      const decision = decisionByTarget.get(target.targetId);
      const matchingHints = hints.filter(
        (candidate) =>
          candidate.trustedMarker === target.trustedMarker && candidate.active
      );
      const hint = matchingHints.length === 1 ? matchingHints[0] : undefined;
      const suppressed =
        target.disposition === LifecycleTargetDisposition.CommandSuppressed;
      const currentOccurrencePresent = occurrences.some(
        (occurrence) =>
          occurrence.trustedMarker === target.trustedMarker &&
          (occurrence.state === FindingOccurrenceState.New ||
            occurrence.state === FindingOccurrenceState.Reconfirmed ||
            occurrence.state === FindingOccurrenceState.Changed)
      );
      const trustedResolved =
        !currentOccurrencePresent && hasValidTrustedResolutionMarker(target);
      const verdict = suppressed
        ? ('suppressed_by_human' as const)
        : trustedResolved
          ? LifecycleRevalidationVerdict.Resolved
          : (decision?.verdict ?? LifecycleRevalidationVerdict.Uncertain);
      const reasonCodes = sortedUnique([
        ...(decision?.reasonCodes ?? []),
        ...(target.disposition === LifecycleTargetDisposition.HumanReply
          ? ['human_reply']
          : []),
        ...(suppressed ? ['command_dismissed'] : []),
        ...(trustedResolved ? ['trusted_resolution_marker'] : []),
        ...(target.resolutionMarker?.trust ===
        LifecycleResolutionMarkerTrust.Untrusted
          ? ['untrusted_resolution_marker_ignored']
          : []),
        ...(!inventory.complete ? ['inventory_incomplete'] : []),
        ...(coverage.state === ProjectionCoverageState.Partial
          ? ['partial_coverage']
          : []),
      ]);
      return {
        targetId: target.targetId,
        threadId: target.threadId,
        ...(hint ? { lineageId: hint.lineageId } : {}),
        verdict,
        reasonCodes,
        mutationEligible:
          inventory.complete &&
          coverage.state === ProjectionCoverageState.Complete &&
          target.disposition === LifecycleTargetDisposition.Active &&
          target.viewerCanResolve &&
          !trustedResolved &&
          decision?.verdict === LifecycleRevalidationVerdict.Resolved,
      };
    });
}

function buildSnapshotFacts(occurrences: readonly FindingOccurrence[]): {
  occurrenceProvenance: OccurrenceProvenanceFact[];
  lineageHints: LineageHintFact[];
} {
  return {
    occurrenceProvenance: occurrences.map((occurrence) => ({
      lineageId: occurrence.lineageId,
      state: occurrence.state,
      sourceHeadSha: occurrence.sourceHeadSha,
      firstSeenHeadSha: occurrence.firstSeenHeadSha,
      observationIds: occurrence.observationIds,
      providerVoteKeys: occurrence.providerVoteKeys,
      filePath: occurrence.filePath,
      ...(occurrence.line !== undefined ? { line: occurrence.line } : {}),
    })),
    lineageHints: occurrences.map((occurrence) => ({
      lineageId: occurrence.lineageId,
      category: occurrence.category,
      normalizedFailureModeHash: occurrence.normalizedFailureModeHash,
      ...(occurrence.symbolAnchor
        ? { symbolAnchor: occurrence.symbolAnchor }
        : {}),
      ...(occurrence.trustedMarker
        ? { trustedMarker: occurrence.trustedMarker }
        : {}),
      severity: occurrence.severity,
      title: occurrence.title,
      message: occurrence.message,
      filePath: occurrence.filePath,
      ...(occurrence.startLine !== undefined
        ? { startLine: occurrence.startLine }
        : {}),
      ...(occurrence.line !== undefined ? { line: occurrence.line } : {}),
      ...(occurrence.endLine !== undefined
        ? { endLine: occurrence.endLine }
        : {}),
      firstSeenHeadSha: occurrence.firstSeenHeadSha,
      lastSeenHeadSha: occurrence.sourceHeadSha,
      active:
        occurrence.state !== FindingOccurrenceState.Resolved &&
        occurrence.state !== FindingOccurrenceState.SuppressedByHuman,
    })),
  };
}

function normalizeCoverage(
  coverage: ReviewCoverageFact,
  inventory: CurrentLifecycleInventory
): ReviewCoverageFact {
  const limitations = sortedUnique([
    ...coverage.limitations,
    ...inventory.warnings,
    ...(!inventory.complete ? ['lifecycle inventory incomplete'] : []),
  ]);
  const state =
    coverage.state === ProjectionCoverageState.Partial || !inventory.complete
      ? ProjectionCoverageState.Partial
      : ProjectionCoverageState.Complete;
  return deepFreezeProjection({
    ...coverage,
    state,
    limitations,
  });
}

function canClaimAllClear(
  coverage: ReviewCoverageFact,
  inventory: CurrentLifecycleInventory,
  occurrences: readonly FindingOccurrence[],
  gate: MergeGateDecision
): boolean {
  return (
    coverage.state === ProjectionCoverageState.Complete &&
    inventory.complete &&
    gate.conclusion === MergeGateConclusion.Pass &&
    occurrences.every(
      (occurrence) =>
        occurrence.state === FindingOccurrenceState.Resolved ||
        occurrence.state === FindingOccurrenceState.SuppressedByHuman
    )
  );
}

function resolveCheckConclusion(
  projected: CheckConclusion | undefined,
  gate: MergeGateDecision
): CheckConclusion {
  if (gate.conclusion === MergeGateConclusion.Fail) {
    return CheckConclusion.Failure;
  }
  if (gate.conclusion === MergeGateConclusion.Inconclusive) {
    return CheckConclusion.Neutral;
  }
  return projected ?? CheckConclusion.Success;
}

function removeAllClearClaims(body: string): string {
  return body
    .replace(/\ball[ -]?clear\b/gi, 'No blocking findings in reviewed coverage')
    .replace(/\bno issues? found\b/gi, 'No issues found in reviewed coverage');
}

function assertPartialPresentationDoesNotClaimCompletion(
  summaryBody: string,
  checkTitle: string,
  checkSummary: string
): void {
  const completedHeading = /^##\s+Review complete(?:d)?\b/im;
  const completedTitle = /^\s*Review complete(?:d)?\b/i;
  if (
    completedHeading.test(summaryBody) ||
    completedTitle.test(checkTitle) ||
    completedHeading.test(checkSummary)
  ) {
    throw new Error('partial review presentation must not claim completion');
  }
}

function countOccurrenceStates(
  occurrences: readonly FindingOccurrence[]
): Record<FindingOccurrenceState, number> {
  const counts: Record<FindingOccurrenceState, number> = {
    [FindingOccurrenceState.New]: 0,
    [FindingOccurrenceState.Reconfirmed]: 0,
    [FindingOccurrenceState.Changed]: 0,
    [FindingOccurrenceState.CarriedUnverified]: 0,
    [FindingOccurrenceState.Resolved]: 0,
    [FindingOccurrenceState.Uncertain]: 0,
    [FindingOccurrenceState.SuppressedByHuman]: 0,
  };
  for (const occurrence of occurrences) counts[occurrence.state] += 1;
  return counts;
}

function publicationMarker(
  kind: 'summary' | 'check',
  scope: ReviewProjectionScope
): string {
  return `reviewrouter:${kind}:v2:${scope.reviewRevisionHash}`;
}

function summaryPlacement(
  lineageId: string,
  path: string,
  reason: string
): FindingPlacementDecision {
  return {
    lineageId,
    kind: FindingPlacementKind.Summary,
    path,
    reason,
  };
}

function sortOccurrences(
  occurrences: readonly FindingOccurrence[]
): FindingOccurrence[] {
  const stateOrder: Record<FindingOccurrenceState, number> = {
    [FindingOccurrenceState.New]: 0,
    [FindingOccurrenceState.Changed]: 1,
    [FindingOccurrenceState.Reconfirmed]: 2,
    [FindingOccurrenceState.CarriedUnverified]: 3,
    [FindingOccurrenceState.Uncertain]: 4,
    [FindingOccurrenceState.Resolved]: 5,
    [FindingOccurrenceState.SuppressedByHuman]: 6,
  };
  const severityOrder: Record<FindingSeverity, number> = {
    [FindingSeverity.Critical]: 0,
    [FindingSeverity.Major]: 1,
    [FindingSeverity.Minor]: 2,
  };
  return [...occurrences].sort(
    (left, right) =>
      stateOrder[left.state] - stateOrder[right.state] ||
      severityOrder[left.severity] - severityOrder[right.severity] ||
      left.filePath.localeCompare(right.filePath) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      left.lineageId.localeCompare(right.lineageId)
  );
}

function validateFinding(
  finding: CurrentFindingCandidate,
  limits: ReviewProjectionLimits
): void {
  assertNonEmpty('sourceFindingId', finding.sourceFindingId);
  assertNonEmpty('category', finding.category);
  assertNonEmpty(
    'normalizedFailureModeHash',
    finding.normalizedFailureModeHash
  );
  assertNonEmpty('title', finding.title);
  assertNonEmpty('message', finding.message);
  assertNonEmpty('filePath', finding.filePath);
  for (const value of [
    finding.sourceFindingId,
    finding.category,
    finding.normalizedFailureModeHash,
    finding.symbolAnchor ?? '',
    finding.trustedMarker ?? '',
    finding.title,
    finding.message,
    finding.suggestion ?? '',
    finding.filePath,
  ]) {
    assertWithinProjectionLimit(
      'maxStringBytes',
      Buffer.byteLength(value, 'utf8'),
      limits
    );
  }
  for (const references of [
    finding.providerIds,
    finding.providerVoteKeys,
    finding.observationIds,
  ]) {
    assertWithinProjectionLimit(
      'maxReferencesPerFinding',
      references.length,
      limits
    );
    for (const value of references) {
      assertWithinProjectionLimit(
        'maxStringBytes',
        Buffer.byteLength(value, 'utf8'),
        limits
      );
    }
  }
  if (finding.line !== undefined && finding.line <= 0) {
    throw new Error('finding line must be positive when present');
  }
}

function validateSelectedFindings(
  candidates: readonly CurrentFindingCandidate[],
  selected: readonly SelectedCurrentFinding[],
  limits: ReviewProjectionLimits
): void {
  const candidateIds = new Set(
    candidates.map((candidate) => candidate.sourceFindingId)
  );
  for (const finding of selected) {
    validateFinding(finding, limits);
    if (finding.sourceFindingIds.length === 0) {
      throw new Error(
        'selected finding must retain at least one source finding'
      );
    }
    assertWithinProjectionLimit(
      'maxReferencesPerFinding',
      finding.sourceFindingIds.length,
      limits
    );
    assertUnique('selected sourceFindingId', finding.sourceFindingIds);
    for (const sourceFindingId of finding.sourceFindingIds) {
      if (!candidateIds.has(sourceFindingId)) {
        throw new Error(
          `selected finding references unknown source ${sourceFindingId}`
        );
      }
    }
  }
}

function validateLifecycleDecisions(
  inventory: CurrentLifecycleInventory,
  decisions: readonly LifecycleProjectionDecision[]
): void {
  const targetIds = new Set(inventory.targets.map((target) => target.targetId));
  assertUnique(
    'lifecycle decision targetId',
    decisions.map((decision) => decision.targetId)
  );
  for (const decision of decisions) {
    if (!targetIds.has(decision.targetId)) {
      throw new Error(
        `lifecycle decision references unknown target ${decision.targetId}`
      );
    }
  }
}

function validateGateDecision(
  occurrences: readonly FindingOccurrence[],
  gate: MergeGateDecision
): void {
  const lineageIds = new Set(
    occurrences.map((occurrence) => occurrence.lineageId)
  );
  assertUnique('blocking lineageId', gate.blockingLineageIds);
  for (const lineageId of gate.blockingLineageIds) {
    if (!lineageIds.has(lineageId)) {
      throw new Error(`merge gate references unknown lineage ${lineageId}`);
    }
  }
}

function assertNonEmpty(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function sortedUnique(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) =>
    left.localeCompare(right)
  );
}

function sortCodeUnits(values: readonly string[]): string[] {
  return [...values].sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
}

function assertUnique(name: string, values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${name} values must be unique`);
  }
}
