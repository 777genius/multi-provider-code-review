/**
 * Core type definitions for the multi-provider code review action.
 */

export type Severity = 'critical' | 'major' | 'minor';
export type FailOnSeverity = Severity | 'off';
export type ReviewThreadLifecycleMode = 'off' | 'report' | 'resolve';
export type LifecycleSeverity = Severity | 'unknown';
export type LifecycleQuorumMode = 'single-provider' | 'multi-provider';
export type LifecycleVerdict = 'resolved' | 'still_valid' | 'uncertain';
export type LifecycleReasonCode =
  | 'not_reviewrouter_thread'
  | 'resolved_thread_ignored'
  | 'untrusted_author'
  | 'missing_finding_marker'
  | 'missing_old_finding_details'
  | 'human_reply'
  | 'viewer_cannot_resolve'
  | 'outside_review_scope'
  | 'target_cap_exceeded'
  | 'provider_missing_revalidation'
  | 'provider_uncertain'
  | 'provider_parse_error'
  | 'provider_failed'
  | 'invalid_resolved_evidence'
  | 'still_valid_vote'
  | 'insufficient_resolved_quorum'
  | 'head_sha_changed'
  | 'thread_changed_before_mutation'
  | 'mutation_permission_denied'
  | 'mutation_rate_limited'
  | 'mutation_failed'
  | 'resolution_comment_posted'
  | 'resolution_comment_failed'
  | 'dry_run'
  | 'already_resolved'
  | 'thread_not_found'
  | 'inventory_failed'
  | 'pagination_incomplete'
  | 'report_mode'
  | 'stale_summary_write'
  | 'unknown_severity'
  | 'unsafe_prompt_data'
  | 'line_mapping_insufficient'
  | 'unknown_target_id'
  | 'missing_target_id'
  | 'duplicate_fingerprint_targets'
  | 'current_finding_present'
  | 'provider_current_finding_present'
  | 'command_dismissed';

/**
 * Configuration for multi-provider code review
 *
 * New fields added in recent versions:
 * - providerDiscoveryLimit: Controls health check breadth (default: 8)
 * - providerBatchOverrides: Provider-specific batch sizes
 * - enableTokenAwareBatching: Dynamic batching based on token estimation
 * - targetTokensPerBatch: Target tokens per batch (default: 50000)
 * - providerSelectionStrategy: How to select providers (default: 'reliability')
 * - providerExplorationRate: Exploration vs exploitation (default: 0.3)
 * - intensityProviderCounts: Provider counts per intensity level
 * - intensityTimeouts: Timeout mappings per intensity level
 * - intensityPromptDepth: Prompt detail level per intensity
 *
 * All new fields are optional and have sensible defaults defined in src/config/defaults.ts
 */
export interface ReviewConfig {
  providers: string[];
  synthesisModel: string;
  fallbackProviders: string[];
  providerAllowlist: string[];
  providerBlocklist: string[];
  providerDiscoveryLimit?: number; // Max providers to discover/health-check (default: 8)
  providerLimit: number; // Max providers to use for actual review (default: 1)
  requiredHealthyProviders?: string[];
  providerRetries: number;
  providerMaxParallel: number;
  quietModeEnabled?: boolean;
  quietMinConfidence?: number;
  quietUseLearning?: boolean;
  learningEnabled?: boolean;
  learningMinFeedbackCount?: number;
  learningLookbackDays?: number;

  /**
   * Natural language for the human-readable finding text (title/message).
   * Defaults to English; any other value asks providers to write findings in
   * that language while keeping JSON structure, code, and identifiers intact.
   */
  outputLanguage?: string;

  inlineMaxComments: number;
  inlineMinSeverity: Severity;
  inlineMinAgreement: number;

  skipLabels: string[];
  skipDrafts: boolean;
  skipBots: boolean;
  minChangedLines: number;
  maxChangedFiles: number;

  diffMaxBytes: number;
  runTimeoutSeconds: number;
  openrouterTimeoutSeconds: number;

  budgetMaxUsd: number;

  enableAstAnalysis: boolean;
  enableSecurity: boolean;
  enableCaching: boolean;
  enableTestHints: boolean;
  enableAiDetection: boolean;

  incrementalEnabled: boolean;
  incrementalCacheTtlDays: number;

  batchMaxFiles?: number;
  providerBatchOverrides?: Record<string, number>;
  enableTokenAwareBatching?: boolean;
  targetTokensPerBatch?: number;
  smartDiffCompaction?: boolean;
  maxFullDiffFileBytes?: number;
  maxFullDiffFileChanges?: number;

  graphEnabled?: boolean;
  graphCacheEnabled?: boolean;
  graphMaxDepth?: number;
  graphTimeoutSeconds?: number;

  codexAgenticContext?: boolean;
  claudeAgenticContext?: boolean;
  codexEventAudit?: boolean;

  generateFixPrompts?: boolean;
  fixPromptFormat?: string;

  analyticsEnabled?: boolean;
  analyticsMaxReviews?: number;
  analyticsDeveloperRate?: number;
  analyticsManualReviewTime?: number;

  pluginsEnabled?: boolean;
  pluginDir?: string;
  pluginAllowlist?: string[];
  pluginBlocklist?: string[];

  skipTrivialChanges?: boolean;
  skipDependencyUpdates?: boolean;
  skipDocumentationOnly?: boolean;
  skipFormattingOnly?: boolean;
  skipTestFixtures?: boolean;
  skipConfigFiles?: boolean;
  skipBuildArtifacts?: boolean;
  trivialPatterns?: string[];

  pathBasedIntensity?: boolean;
  pathIntensityPatterns?: string; // JSON string of PathPattern[]
  pathDefaultIntensity?: 'thorough' | 'standard' | 'light';

  // Provider selection strategy
  providerSelectionStrategy?: 'reliability' | 'random' | 'round-robin';
  providerExplorationRate?: number; // 0.0-1.0, default 0.3 (30% exploration)

  // Intensity behavior mappings
  intensityProviderCounts?: {
    thorough: number;
    standard: number;
    light: number;
  };
  intensityTimeouts?: {
    thorough: number;
    standard: number;
    light: number;
  };
  intensityPromptDepth?: {
    thorough: 'detailed' | 'standard' | 'brief';
    standard: 'detailed' | 'standard' | 'brief';
    light: 'detailed' | 'standard' | 'brief';
  };

  // Quality configuration
  minConfidence?: number;
  confidenceThreshold?: {
    critical?: number;
    major?: number;
    minor?: number;
  };
  consensusRequiredForCritical?: boolean;
  consensusMinAgreement?: number;
  suggestionSyntaxValidation?: boolean;
  updatePrDescription?: boolean;
  failOnSeverity?: FailOnSeverity;
  reviewThreadLifecycle?: ReviewThreadLifecycleMode;
  reviewThreadLifecycleMaxTargets?: number;
  reviewThreadLifecycleResolveConfidence?: {
    critical?: number;
    major?: number;
    minor?: number;
    unknown?: number;
  };

  dryRun: boolean;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ReviewResult {
  content: string;
  /** Number of network/process transport invocations consumed by this result. */
  transportAttemptCount?: number;
  usage?: TokenUsage;
  durationSeconds?: number;
  findings?: Finding[];
  revalidations?: ProviderLifecycleRevalidation[];
  aiLikelihood?: number;
  aiReasoning?: string;
  actualModel?: string; // Actual model used (for routed providers like openrouter/free)
}

export interface ProviderResult {
  name: string;
  status: 'success' | 'error' | 'timeout' | 'rate-limited';
  result?: ReviewResult;
  error?: Error;
  durationSeconds: number;
  lifecycleAssignedTargetIds?: string[];
}

export interface ProviderModelAttribution {
  provider: string;
  actualModel?: string;
}

export interface Finding {
  file: string;
  startLine?: number;
  line: number;
  endLine?: number;
  severity: Severity;
  title: string;
  message: string;
  suggestion?: string;
  provider?: string;
  providers?: string[];
  actualModel?: string;
  providerModels?: ProviderModelAttribution[];
  providerVoteKeys?: string[];
  providerPoolSize?: number;
  confidence?: number;
  category?: string;
  evidence?: EvidenceScore;
  evidenceDetail?: EvidenceDetail;
  hasConsensus?: boolean; // Set during aggregation when multiple providers agree
}

export enum PullRequestLoadStatus {
  Complete = 'complete',
  Truncated = 'truncated',
}

export enum PullRequestLoadOmissionReason {
  GitHubFileLimit = 'github_file_limit',
  SynthesizedDiffSizeLimit = 'synthesized_diff_size_limit',
}

export interface GitHubFileLimitOmission {
  readonly reason: PullRequestLoadOmissionReason.GitHubFileLimit;
  readonly omittedFileCount?: number;
}

export interface SynthesizedDiffSizeLimitOmission {
  readonly reason: PullRequestLoadOmissionReason.SynthesizedDiffSizeLimit;
  readonly omittedFileCount: number;
  readonly omittedFiles: readonly string[];
}

export type PullRequestLoadOmission =
  GitHubFileLimitOmission | SynthesizedDiffSizeLimitOmission;

export type PullRequestLoadCompleteness =
  | {
      readonly status: PullRequestLoadStatus.Complete;
      readonly omissions: readonly [];
    }
  | {
      readonly status: PullRequestLoadStatus.Truncated;
      readonly omissions: readonly [
        PullRequestLoadOmission,
        ...PullRequestLoadOmission[],
      ];
    };

export interface PRContext {
  number: number;
  title: string;
  body: string;
  author: string;
  draft: boolean;
  labels: string[];
  files: FileChange[];
  diff: string;
  additions: number;
  deletions: number;
  baseSha: string;
  headSha: string;
  loadCompleteness?: PullRequestLoadCompleteness;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previousFilename?: string;
  language?: string;
}

export interface InlineComment {
  path: string;
  startLine?: number;
  line: number;
  endLine?: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
  severity?: Severity;
  title?: string;
  category?: string;
  provider?: string;
  providers?: string[];
  confidence?: number;
  hasConsensus?: boolean;
  suggestion?: string;
}

export interface ReviewMetrics {
  totalFindings: number;
  critical: number;
  major: number;
  minor: number;
  providersUsed: number;
  providersSuccess: number;
  providersFailed: number;
  totalTokens: number;
  totalCost: number;
  durationSeconds: number;
  dismissedFindings?: number;
  cached?: boolean;
}

export interface TestCoverageHint {
  file: string;
  suggestedTestFile: string;
  testPattern: string;
}

export interface AIAnalysis {
  averageLikelihood: number;
  providerEstimates: Record<string, number>;
  consensus: string;
}

export type ReviewCoverageFileStatus =
  'full' | 'compacted' | 'metadata-only' | 'skipped' | 'unreviewed';

export interface ReviewCoverageFile {
  path: string;
  status: ReviewCoverageFileStatus;
  reason?: string;
  additions?: number;
  deletions?: number;
}

export interface ReviewCoverage {
  mode: 'full' | 'incremental';
  totalFiles: number;
  filesConsidered: number;
  fullDiffFiles: number;
  compactedFiles: number;
  metadataOnlyFiles: number;
  skippedFiles: number;
  unreviewedFiles: number;
  complete: boolean;
  limitations?: string[];
  agenticContext: boolean;
  files: ReviewCoverageFile[];
}

export interface ReviewFindingProvenance {
  fromCurrentReview: Record<Severity, number>;
  carriedForward: Record<Severity, number>;
}

export interface Review {
  summary: string;
  findings: Finding[];
  inlineComments: InlineComment[];
  actionItems: string[];
  metrics: ReviewMetrics;
  testHints?: TestCoverageHint[];
  aiAnalysis?: AIAnalysis;
  providerResults?: ProviderResult[];
  runDetails?: RunDetails;
  coverage?: ReviewCoverage;
  findingProvenance?: ReviewFindingProvenance;
  impactAnalysis?: ImpactAnalysis;
  mermaidDiagram?: string;
  threadLifecycle?: ReviewThreadLifecycleResult;
}

export interface LifecycleEvidence {
  path: string;
  startLine?: number;
  endLine?: number;
  reason: string;
}

export interface ProviderLifecycleRevalidation {
  targetId: string;
  fingerprint?: string;
  verdict: LifecycleVerdict;
  confidence?: number;
  evidence?: LifecycleEvidence[];
  rationale?: string;
}

export interface LifecycleTarget {
  targetId: string;
  threadId: string;
  threadUrl?: string;
  fingerprint: string;
  severity: LifecycleSeverity;
  title: string;
  message: string;
  originalPath: string;
  currentPath?: string;
  originalLine?: number;
  currentLine?: number;
  diffHunk?: string;
  parentCommentId: string;
  parentCommentDatabaseId?: number;
  parentCommentUpdatedAt: string;
  threadCommentCount: number;
  viewerCanResolve: boolean;
  hasHumanReply: boolean;
  trustedAuthor: boolean;
  trustedResolutionMarker?: {
    schemaVersion: 'reviewrouter-lifecycle-resolution.v1';
    targetId: string;
    fingerprint: string;
    commentId: string;
    commentUpdatedAt: string;
  };
  reasonCodes?: LifecycleReasonCode[];
}

export interface LifecycleAssignmentRecord {
  targetId: string;
  fingerprint: string;
  assignedProviderIds: string[];
  assignedBatchIds: string[];
  failedProviderIds?: string[];
  unassignedProviderIds: Array<{
    providerId: string;
    reason: LifecycleReasonCode;
  }>;
  scopeStatus: 'in_scope' | 'out_of_scope' | 'capped' | 'unsupported';
}

export interface ProviderLifecycleVote extends ProviderLifecycleRevalidation {
  providerId: string;
  valid: boolean;
  reasonCodes: LifecycleReasonCode[];
}

export interface LifecycleThreadRecord {
  target: LifecycleTarget;
  reasonCodes: LifecycleReasonCode[];
  providerVotes?: ProviderLifecycleVote[];
}

export interface LifecycleResolvedThread extends LifecycleThreadRecord {
  resolvedBy?: 'review-router' | 'external';
}

export interface LifecycleMutationFailure extends LifecycleThreadRecord {
  errorMessage?: string;
}

export interface ReviewThreadLifecycleResult {
  mode: ReviewThreadLifecycleMode;
  quorumMode: LifecycleQuorumMode;
  plannedProviders: string[];
  resolvedCandidates: LifecycleThreadRecord[];
  resolvedByLifecycle: LifecycleResolvedThread[];
  previousStillValid: LifecycleThreadRecord[];
  previousUncertain: LifecycleThreadRecord[];
  manualAttention: LifecycleThreadRecord[];
  mutationSkipped: LifecycleThreadRecord[];
  mutationFailed: LifecycleMutationFailure[];
  skipped: LifecycleThreadRecord[];
  warnings: string[];
  inventoryFailed?: boolean;
}

export interface CostEstimate {
  totalCost: number;
  breakdown: Record<string, number>;
  estimatedTokens: number;
}

export interface CostSummary {
  totalCost: number;
  breakdown: Record<string, number>;
  totalTokens: number;
}

export interface ProviderRunInfo {
  name: string;
  status: ProviderResult['status'];
  durationSeconds: number;
  requiredHealthy?: boolean;
  cost?: number;
  tokens?: number;
  errorMessage?: string;
}

export interface RunDetails {
  providers: ProviderRunInfo[];
  totalCost: number;
  totalTokens: number;
  durationSeconds: number;
  cacheHit: boolean;
  synthesisModel: string;
  providerPoolSize: number;
}

export interface ImpactAnalysis {
  file: string;
  totalAffected: number;
  callers: CodeSnippet[];
  consumers: CodeSnippet[];
  derived: CodeSnippet[];
  dependencies?: CodeSnippet[];
  impactLevel: 'critical' | 'high' | 'medium' | 'low';
  summary: string;
}

export interface EvidenceScore {
  confidence: number; // 0-1
  reasoning: string;
  badge: string;
}

export interface SARIFReport {
  version: '2.1.0';
  $schema: string;
  runs: SARIFRun[];
}

export interface SARIFRun {
  tool: {
    driver: {
      name: string;
      version: string;
      informationUri: string;
      rules: SARIFRule[];
    };
  };
  results: SARIFResult[];
}

export interface SARIFRule {
  id: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  defaultConfiguration: {
    level: 'error' | 'warning' | 'note';
  };
}

export interface SARIFResult {
  ruleId: string;
  level: 'error' | 'warning' | 'note';
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region: {
        startLine: number;
        endLine?: number;
        startColumn?: number;
        endColumn?: number;
      };
    };
  }>;
}

export interface CodeSnippet {
  filename: string;
  startLine: number;
  endLine: number;
  code: string;
}

export interface EvidenceDetail {
  changedLines: number[];
  relatedSnippets: CodeSnippet[];
  providerAgreement: number;
  astConfirmed: boolean;
  graphConfirmed: boolean;
}

export interface UnchangedContext {
  file: string;
  relationship: 'caller' | 'consumer' | 'derived' | 'dependency';
  affectedCode: CodeSnippet[];
  impactLevel: ImpactAnalysis['impactLevel'];
  downstreamConsumers: string[];
}

export interface Definition {
  name: string;
  type: 'function' | 'class' | 'variable' | 'interface';
  file: string;
  line: number;
}

export interface CodeGraph {
  definitions: Map<string, Definition>;
  calls: Map<string, string[]>;
  imports: Map<string, string[]>;
  inherits: Map<string, string[]>;
  findCallers(symbol: string): CodeSnippet[];
  findCallees(symbol: string): CodeSnippet[];
  findConsumers(module: string): CodeSnippet[];
  findDerivedClasses(className: string): CodeSnippet[];
  findDependencies(file: string): CodeSnippet[];
  findImpactRadius(file: string): ImpactAnalysis;
}

export type ReviewIntensity = 'thorough' | 'standard' | 'light';
