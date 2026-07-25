import {
  CheckConclusion,
  CurrentFindingCandidate,
  CurrentLifecycleInventory,
  FindingOccurrence,
  FindingPlacementDecision,
  FindingSeverity,
  LifecycleProjectionDecision,
  LifecycleRevalidation,
  MergeGateConclusion,
  PriorLineageHint,
  ReviewCoverageFact,
  ReviewProjectionPresentationContext,
  ReviewProjectionScope,
  RevisionFile,
  SelectedCurrentFinding,
} from '../domain/review-projection';
import { ReviewProjectionLimits } from '../domain/review-projection-limits';

export interface LoadCurrentLifecycleInventoryQuery {
  readonly scope: ReviewProjectionScope;
}

export interface CurrentLifecycleInventoryPort {
  loadCurrent(
    query: LoadCurrentLifecycleInventoryQuery
  ): Promise<CurrentLifecycleInventory>;
}

export interface SelectCurrentFindingsQuery {
  readonly findings: readonly CurrentFindingCandidate[];
  readonly revisionFiles: readonly RevisionFile[];
  readonly diff: string;
  readonly limits: ReviewProjectionLimits;
}

export interface CurrentFindingPolicyPort {
  selectCurrent(
    query: SelectCurrentFindingsQuery
  ): Promise<readonly SelectedCurrentFinding[]>;
}

export interface ProjectLifecycleQuery {
  readonly scope: ReviewProjectionScope;
  readonly findings: readonly SelectedCurrentFinding[];
  readonly priorLineageHints: readonly PriorLineageHint[];
  readonly inventory: CurrentLifecycleInventory;
  readonly revalidations: readonly LifecycleRevalidation[];
}

export interface ReviewLifecyclePolicyPort {
  projectLifecycle(
    query: ProjectLifecycleQuery
  ): Promise<readonly LifecycleProjectionDecision[]>;
}

export interface ProjectReviewPresentationQuery {
  readonly scope: ReviewProjectionScope;
  readonly presentation: ReviewProjectionPresentationContext;
  readonly providerExecution: ProviderExecutionSummaryFact;
  readonly coverage: ReviewCoverageFact;
  readonly occurrences: readonly FindingOccurrence[];
  readonly revisionFiles: readonly RevisionFile[];
  readonly limits: ReviewProjectionLimits;
}

export interface ProviderExecutionSummaryFact {
  readonly plannedProviders: number;
  readonly succeededProviders: number;
}

export interface ProjectedReviewPresentation {
  readonly summaryBody: string;
  readonly checkName: string;
  readonly checkTitle: string;
  readonly checkSummary: string;
  readonly checkConclusion?: CheckConclusion;
  readonly placements: readonly FindingPlacementDecision[];
}

export interface ReviewPresentationPolicyPort {
  projectPresentation(
    query: ProjectReviewPresentationQuery
  ): Promise<ProjectedReviewPresentation>;
}

export interface EvaluateMergeGateQuery {
  readonly failOnSeverity?: FindingSeverity;
  readonly occurrences: readonly FindingOccurrence[];
  readonly coverage: ReviewCoverageFact;
  readonly lifecycleInventoryComplete: boolean;
}

export interface MergeGateDecision {
  readonly conclusion: MergeGateConclusion;
  readonly blockingLineageIds: readonly string[];
  readonly reasonCodes: readonly string[];
}

export interface ReviewMergeGatePolicyPort {
  evaluateMergeGate(query: EvaluateMergeGateQuery): MergeGateDecision;
}
