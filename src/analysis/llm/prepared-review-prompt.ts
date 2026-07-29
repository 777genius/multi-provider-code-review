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

export type PreparedReviewPromptV2 = Readonly<{
  version: 'prepared_review_prompt.v2';
  prompt: string;
  pathCoverage: readonly PreparedPromptPathCoverage[];
}>;
