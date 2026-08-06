import { ReviewLifecycleObservationVersion } from './review-lifecycle-observation';

export enum ReviewProjectionEnvelopeVersion {
  V1 = 'review_projection.v1',
}

export enum ProjectionCoverageState {
  Complete = 'complete',
  Partial = 'partial',
}

export enum FindingSeverity {
  Critical = 'critical',
  Major = 'major',
  Minor = 'minor',
}

export enum FindingOccurrenceState {
  New = 'new',
  Reconfirmed = 'reconfirmed',
  Changed = 'changed',
  CarriedUnverified = 'carried_unverified',
  Resolved = 'resolved',
  Uncertain = 'uncertain',
  SuppressedByHuman = 'suppressed_by_human',
}

export enum FindingPlacementKind {
  Inline = 'inline',
  File = 'file',
  Summary = 'summary',
}

export enum RevisionFileStatus {
  Added = 'added',
  Modified = 'modified',
  Removed = 'removed',
  Renamed = 'renamed',
}

export enum LifecycleTargetDisposition {
  Active = 'active',
  HumanReply = 'human_reply',
  CommandSuppressed = 'command_suppressed',
}

export enum LifecycleResolutionMarkerTrust {
  Trusted = 'trusted',
  Untrusted = 'untrusted',
}

export enum LifecycleRevalidationVerdict {
  Resolved = 'resolved',
  StillValid = 'still_valid',
  Uncertain = 'uncertain',
}

export enum MergeGateConclusion {
  Pass = 'pass',
  Fail = 'fail',
  Inconclusive = 'inconclusive',
}

export enum CheckConclusion {
  Success = 'success',
  Failure = 'failure',
  Neutral = 'neutral',
}

export interface ReviewProjectionScope {
  readonly scmRepositoryIdentityId: string;
  readonly pullRequestNumber: number;
  readonly baseSha: string;
  readonly reviewedHeadSha: string;
  readonly reviewRevisionHash: string;
}

export interface ReviewProjectionPresentationContext {
  readonly title: string;
  readonly author: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface CurrentFindingCandidate {
  readonly sourceFindingId: string;
  readonly category: string;
  readonly normalizedFailureModeHash: string;
  readonly symbolAnchor?: string;
  readonly trustedMarker?: string;
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly message: string;
  readonly suggestion?: string;
  readonly filePath: string;
  readonly startLine?: number;
  readonly line?: number;
  readonly endLine?: number;
  readonly confidence?: number;
  readonly providerIds: readonly string[];
  readonly providerVoteKeys: readonly string[];
  readonly observationIds: readonly string[];
}

export interface SelectedCurrentFinding extends CurrentFindingCandidate {
  readonly sourceFindingIds: readonly string[];
}

export interface RevisionFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: RevisionFileStatus;
  readonly patch?: string;
}

export interface ReviewCoverageFact {
  readonly state: ProjectionCoverageState;
  readonly mode: 'full' | 'incremental';
  readonly totalFiles: number;
  readonly reviewedFiles: number;
  readonly unreviewedFiles: number;
  readonly limitations: readonly string[];
}

export interface PriorLineageHint {
  readonly lineageId: string;
  readonly category: string;
  readonly normalizedFailureModeHash: string;
  readonly symbolAnchor?: string;
  readonly trustedMarker?: string;
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly message: string;
  readonly filePath: string;
  readonly startLine?: number;
  readonly line?: number;
  readonly endLine?: number;
  readonly firstSeenHeadSha: string;
  readonly lastSeenHeadSha: string;
  readonly active: boolean;
}

export interface LiveLifecycleTarget {
  readonly targetId: string;
  readonly threadId: string;
  readonly trustedMarker: string;
  readonly title: string;
  readonly message: string;
  readonly severity: FindingSeverity | 'unknown';
  readonly originalPath: string;
  readonly currentPath?: string;
  readonly originalLine?: number;
  readonly currentLine?: number;
  readonly parentCommentUpdatedAt: string;
  readonly threadCommentCount: number;
  readonly threadStateHash: string;
  readonly disposition: LifecycleTargetDisposition;
  readonly viewerCanResolve: boolean;
  /**
   * The SCM inventory adapter may set this only after parsing the exact marker
   * schema and classifying its author against the trusted actor policy. The
   * domain still verifies target and fingerprint binding before using it.
   */
  readonly resolutionMarker?: {
    readonly schemaVersion: 'reviewrouter-lifecycle-resolution.v1';
    readonly targetId: string;
    readonly fingerprint: string;
    readonly trust: LifecycleResolutionMarkerTrust;
  };
}

export interface CurrentLifecycleInventory {
  readonly inventoryVersion: 'review_lifecycle_inventory.v1';
  readonly loadedForHeadSha: string;
  readonly lifecycleStateHash: string;
  readonly commandLedgerWatermark: string;
  readonly complete: boolean;
  readonly warnings: readonly string[];
  readonly targets: readonly LiveLifecycleTarget[];
}

export interface LifecycleRevalidation {
  readonly targetId: string;
  readonly providerVoteKey: string;
  readonly verdict: LifecycleRevalidationVerdict;
  readonly confidence?: number;
  readonly rationale?: string;
}

export interface LifecycleProjectionDecision {
  readonly targetId: string;
  readonly verdict: LifecycleRevalidationVerdict;
  readonly reasonCodes: readonly string[];
}

export interface FindingPlacementDecision {
  readonly lineageId: string;
  readonly kind: FindingPlacementKind;
  readonly path: string;
  readonly startLine?: number;
  readonly line?: number;
  readonly endLine?: number;
  readonly body?: string;
  readonly reason?: string;
}

export interface FindingOccurrence {
  readonly lineageId: string;
  readonly sourceFindingIds: readonly string[];
  readonly state: FindingOccurrenceState;
  readonly severity: FindingSeverity;
  readonly previousSeverity?: FindingSeverity;
  readonly category: string;
  readonly normalizedFailureModeHash: string;
  readonly symbolAnchor?: string;
  readonly trustedMarker?: string;
  readonly title: string;
  readonly message: string;
  readonly suggestion?: string;
  readonly filePath: string;
  readonly startLine?: number;
  readonly line?: number;
  readonly endLine?: number;
  readonly placement: FindingPlacementDecision;
  readonly providerVoteKeys: readonly string[];
  readonly observationIds: readonly string[];
  readonly firstSeenHeadSha: string;
  readonly sourceHeadSha: string;
  readonly blocking: boolean;
}

export interface ReviewProjectionSummaryFact {
  readonly marker: string;
  readonly body: string;
  readonly allClear: boolean;
  readonly occurrenceCounts: Readonly<Record<FindingOccurrenceState, number>>;
}

export interface ReviewProjectionCheckFact {
  readonly marker: string;
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  readonly conclusion: CheckConclusion;
}

export interface ReviewProjectionInlineCommentFact {
  readonly lineageId: string;
  readonly marker: string;
  readonly path: string;
  readonly startLine?: number;
  readonly line: number;
  readonly endLine?: number;
  readonly body: string;
}

export interface ReviewProjectionInlineChunkFact {
  readonly chunkIndex: number;
  readonly marker: string;
  readonly bodyHash: string;
  readonly comments: readonly ReviewProjectionInlineCommentFact[];
}

export interface ReviewProjectionLifecycleFact {
  readonly targetId: string;
  readonly threadId: string;
  readonly markerFingerprint: string;
  readonly threadStateHash: string;
  readonly lineageId?: string;
  readonly verdict: LifecycleRevalidationVerdict | 'suppressed_by_human';
  readonly reasonCodes: readonly string[];
  readonly mutationEligible: boolean;
}

export interface OccurrenceProvenanceFact {
  readonly lineageId: string;
  readonly state: FindingOccurrenceState;
  readonly sourceHeadSha: string;
  readonly firstSeenHeadSha: string;
  readonly observationIds: readonly string[];
  readonly providerVoteKeys: readonly string[];
  readonly filePath: string;
  readonly line?: number;
}

export interface LineageHintFact {
  readonly lineageId: string;
  readonly category: string;
  readonly normalizedFailureModeHash: string;
  readonly symbolAnchor?: string;
  readonly trustedMarker?: string;
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly message: string;
  readonly filePath: string;
  readonly startLine?: number;
  readonly line?: number;
  readonly endLine?: number;
  readonly firstSeenHeadSha: string;
  readonly lastSeenHeadSha: string;
  readonly active: boolean;
}

export interface ReviewProjectionPublishingFacts {
  readonly lifecycleObservationVersion: ReviewLifecycleObservationVersion.V1;
  readonly summary: ReviewProjectionSummaryFact;
  readonly check: ReviewProjectionCheckFact;
  readonly inlineReviewChunks: readonly ReviewProjectionInlineChunkFact[];
  readonly lifecycle: readonly ReviewProjectionLifecycleFact[];
}

export interface ReviewProjectionSnapshotFacts {
  readonly occurrenceProvenance: readonly OccurrenceProvenanceFact[];
  readonly lineageHints: readonly LineageHintFact[];
}

export interface ReviewProjectionEnvelopeV1 {
  readonly envelopeVersion: ReviewProjectionEnvelopeVersion.V1;
  readonly projectionPolicyVersion: string;
  readonly authoritativeObservationIds: readonly string[];
  readonly scope: ReviewProjectionScope;
  readonly coverage: ReviewCoverageFact;
  readonly lifecycleStateHash: string;
  readonly commandLedgerWatermark: string;
  readonly occurrences: readonly FindingOccurrence[];
  readonly mergeGate: {
    readonly conclusion: MergeGateConclusion;
    readonly blockingLineageIds: readonly string[];
    readonly reasonCodes: readonly string[];
  };
  readonly publishing: ReviewProjectionPublishingFacts;
  readonly snapshot: ReviewProjectionSnapshotFacts;
}

export interface BuiltCurrentReviewProjection {
  readonly envelope: ReviewProjectionEnvelopeV1;
  readonly canonicalJson: string;
  readonly projectionHash: string;
  readonly byteCount: number;
  readonly findingCount: number;
}
