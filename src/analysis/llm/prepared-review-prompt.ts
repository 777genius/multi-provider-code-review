import type { ReviewInvestigationProbePlan } from '../../review-investigation/domain/deterministic-context-probe-plan';

export enum PreparedPromptPathCoverageKind {
  FullPatch = 'full_patch',
  TrustedRead = 'trusted_read',
  SummaryOnly = 'summary_only',
  MetadataOnly = 'metadata_only',
  PolicyExcluded = 'policy_excluded',
  Trimmed = 'trimmed',
  Unavailable = 'unavailable',
}

export type PreparedPromptPathCoverage = Readonly<{
  path: string;
  kind: PreparedPromptPathCoverageKind;
  contentHash: string | null;
}>;

export type PreparedReviewPromptV3 = Readonly<{
  version: 'prepared_review_prompt.v3';
  /** Shared review context without a terminal provider output contract. */
  investigationContextPrompt: string;
  /** Legacy single-turn review prompt, including its terminal output contract. */
  prompt: string;
  pathCoverage: readonly PreparedPromptPathCoverage[];
  investigationProbePlan: ReviewInvestigationProbePlan;
}>;
