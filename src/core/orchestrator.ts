import { Deduplicator } from '../analysis/deduplicator';
import { ConsensusEngine } from '../analysis/consensus';
import { LLMExecutor } from '../analysis/llm/executor';
import { shouldRetryProviderReviewError } from '../analysis/llm/retry-policy';
import { AcceptanceDetector } from '../learning/acceptance-detector';
import { ProviderWeightTracker } from '../learning/provider-weights';
import { extractFindings } from '../analysis/llm/parser';
import { summarizeAIDetection } from '../analysis/ai-detector';
import { PromptBuilder } from '../analysis/llm/prompt-builder';
import { ASTAnalyzer } from '../analysis/ast/analyzer';
import { TestCoverageAnalyzer } from '../analysis/test-coverage';
import { SynthesisEngine } from '../analysis/synthesis';
import { ProviderRegistry } from '../providers/registry';
import { PullRequestLoader } from '../github/pr-loader';
import { CommentPoster } from '../github/comment-poster';
import { MarkdownFormatter } from '../output/formatter';
import { MarkdownFormatterV2 } from '../output/formatter-v2';
import { MermaidGenerator } from '../output/mermaid';
import { FeedbackFilter, ReviewCommentState } from '../github/feedback';
import {
  extractFindingFingerprint,
  extractInlineFingerprint,
  findingFingerprintFromFinding,
  fingerprintFromInlineComment,
  InlineCommentReference,
  signatureFromInlineComment,
} from '../github/comment-fingerprint';
import { FindingFilter } from '../analysis/finding-filter';
import {
  isLinkedCurrentFinding,
  reconcileCarriedFindingsWithLifecycle,
  ThreadLifecycleAggregator,
} from '../analysis/thread-lifecycle';
import { buildJson } from '../output/json';
import { buildSarif } from '../output/sarif';
import { CacheManager } from '../cache/manager';
import {
  IncrementalReviewer,
  IncrementalReviewPlanMode,
  type IncrementalCacheData,
  type IncrementalReviewPlan,
} from '../cache/incremental';
import { GraphCache } from '../cache/graph-cache';
import { CostTracker } from '../cost/tracker';
import { SecurityScanner } from '../security/scanner';
import { RulesEngine } from '../rules/engine';
import { ContextRetriever } from '../analysis/context';
import { EvidenceScorer } from '../analysis/evidence';
import { ImpactAnalyzer } from '../analysis/impact';
import { FeedbackTracker } from '../learning/feedback-tracker';
import { QuietModeFilter } from '../learning/quiet-mode';
import { CodeGraphBuilder, CodeGraph } from '../analysis/context/graph-builder';
import { PromptGenerator } from '../autofix/prompt-generator';
import { ReliabilityTracker } from '../providers/reliability-tracker';
import { MetricsCollector } from '../analytics/metrics-collector';
import { TrivialDetector } from '../analysis/trivial-detector';
import {
  PathMatcher,
  createDefaultPathMatcherConfig,
  PathPattern,
} from '../analysis/path-matcher';
import { buildReviewCoverage } from '../analysis/review-coverage';
import { z } from 'zod';
import { Provider } from '../providers/base';
import {
  ReviewConfig,
  Review,
  PRContext,
  RunDetails,
  Finding,
  FileChange,
  UnchangedContext,
  ProviderResult,
  ReviewIntensity,
  LifecycleAssignmentRecord,
  LifecycleReasonCode,
  LifecycleTarget,
  LifecycleThreadRecord,
  InlineComment,
  ReviewThreadLifecycleMode,
  ReviewThreadLifecycleResult,
  PullRequestLoadOmissionReason,
  PullRequestLoadStatus,
  ProviderLifecycleRevalidation,
  ReviewFindingProvenance,
  Severity,
} from '../types';
import { logger } from '../utils/logger';
import {
  chooseBestAddedLineForComment,
  mapAddedLines,
  filterDiffByFiles,
  recoverDiffForFiles,
} from '../utils/diff';
import { BatchOrchestrator } from './batch-orchestrator';
import { ProgressTracker } from '../github/progress-tracker';
import { GitHubClient } from '../github/client';
import {
  PullRequestHeadVerificationStatus,
  verifyPullRequestHead,
} from '../github/pr-head-guard';
import { PullRequestDescriptionUpdater } from '../github/pr-description';
import { ReviewThreadInventoryLoader } from '../github/review-thread-inventory';
import {
  ReviewThreadResolveResult,
  ReviewThreadResolver,
} from '../github/review-thread-resolver';
import {
  ReviewSummaryMetadata,
  buildReviewSummaryMetadata,
} from '../github/summary-metadata';
import {
  normalizeReviewError,
  sanitizeErrorMessage,
} from '../errors/review-router-error';
import {
  countProviderVotePool,
  getProviderVoteCount,
} from '../utils/provider-votes';
import * as fs from 'fs/promises';
import path from 'path';
import {
  ActionMemoryBundleProvider,
  formatActionMemoryBundleForPrompt,
} from '../control-plane/memory';
import { ExecutionDeadline } from '../review-execution/domain/execution-deadline';
import {
  classifyProviderCapacitySignal,
  createReviewBatchPlan,
  prioritizeFilesByRisk,
} from '../review-execution/domain';
import {
  AdaptiveBatchScheduler,
  BatchExecutionStatus,
} from '../review-execution/application';
import {
  ReviewCheckpointProviderStatus,
  type ReviewCheckpointBatchPayload,
  type ReviewCheckpointPlanIdentity,
} from '../review-execution/domain/review-checkpoint';
import type { ReviewCheckpointSession } from '../review-execution/application/review-checkpoint-session';

// Configuration constants
const HEALTH_CHECK_TIMEOUT_MS = 30_000; // 30 seconds

export interface ReviewComponents {
  config: ReviewConfig;
  providerRegistry: ProviderRegistry;
  promptBuilder: PromptBuilder;
  llmExecutor: LLMExecutor;
  deduplicator: Deduplicator;
  consensus: ConsensusEngine;
  synthesis: SynthesisEngine;
  testCoverage: TestCoverageAnalyzer;
  astAnalyzer: ASTAnalyzer;
  cache: CacheManager;
  incrementalReviewer: IncrementalReviewer;
  costTracker: CostTracker;
  security: SecurityScanner;
  rules: RulesEngine;
  prLoader: PullRequestLoader;
  commentPoster: CommentPoster;
  formatter: MarkdownFormatter | MarkdownFormatterV2;
  contextRetriever: ContextRetriever;
  impactAnalyzer: ImpactAnalyzer;
  evidenceScorer: EvidenceScorer;
  mermaidGenerator: MermaidGenerator;
  feedbackFilter: FeedbackFilter;
  feedbackTracker?: FeedbackTracker;
  quietModeFilter?: QuietModeFilter;
  graphBuilder?: CodeGraphBuilder;
  promptGenerator?: PromptGenerator;
  reliabilityTracker?: ReliabilityTracker;
  metricsCollector?: MetricsCollector;
  batchOrchestrator?: BatchOrchestrator;
  githubClient?: GitHubClient;
  reviewThreadInventory?: ReviewThreadInventoryLoader;
  reviewThreadResolver?: ReviewThreadResolver;
  prDescriptionUpdater?: PullRequestDescriptionUpdater;
  acceptanceDetector?: AcceptanceDetector;
  providerWeightTracker?: ProviderWeightTracker;
  memoryBundleProvider?: ActionMemoryBundleProvider;
  executionDeadline?: ExecutionDeadline;
  reviewCompatibilityKey?: string;
  incrementalSnapshotAdvancementEnabled?: boolean;
  openReviewCheckpointSession?: (
    plan: ReviewCheckpointPlanIdentity
  ) => Promise<ReviewCheckpointSession | null>;
}

export class ReviewOrchestrator {
  private graphCache?: GraphCache;
  private tokenTelemetryTotals = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    providersWithUsage: 0,
    totalProviderResults: 0,
  };

  constructor(private readonly components: ReviewComponents) {
    // Initialize graph cache if enabled
    if (
      components.config?.graphEnabled &&
      components.config?.graphCacheEnabled
    ) {
      this.graphCache = new GraphCache();
    }
  }

  async execute(prNumber: number): Promise<Review | null> {
    const pr = await this.components.prLoader.load(prNumber);
    const skipReason = this.shouldSkip(pr);
    if (skipReason) {
      logger.info(`Skipping review: ${skipReason}`);
      return null;
    }

    return this.executeReview(pr);
  }

  /**
   * Execute review on a given PR context
   * Can be called directly with a PRContext from CLI or GitHub
   *
   * IMMUTABILITY GUARANTEE: This function does not mutate the input `pr` parameter.
   * When filtering or transforming the PR context, a new object is created with spread syntax.
   * Tests verify that pr.files array is not modified by this function.
   */
  async executeReview(pr: PRContext): Promise<Review> {
    const { config } = this.components;
    this.tokenTelemetryTotals = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      providersWithUsage: 0,
      totalProviderResults: 0,
    };
    const start = Date.now();
    let progressTracker: ProgressTracker | undefined;
    let review: Review | null = null;
    let success = false;
    const configuredLifecycleMode =
      config.reviewThreadLifecycle ?? ('off' as ReviewThreadLifecycleMode);
    const summaryMetadata = buildReviewSummaryMetadata({
      reviewedHeadSha: pr.headSha,
      lifecycleMode: configuredLifecycleMode,
    });
    try {
      progressTracker = await this.initProgressTracker(pr, summaryMetadata);
      progressTracker?.addItem('graph', 'Build code graph');
      progressTracker?.addItem('llm', 'LLM review (batched)');
      progressTracker?.addItem('static', 'Static analysis & rules');
      progressTracker?.addItem('synthesis', 'Synthesize & report');

      // Check for trivial changes (dependency locks, docs, config files, test fixtures)
      let reviewContext = pr;
      let skippedTrivialFiles: FileChange[] = [];
      if (config.skipTrivialChanges) {
        const trivialDetector = new TrivialDetector({
          enabled: true,
          skipDependencyUpdates: config.skipDependencyUpdates ?? true,
          skipDocumentationOnly: config.skipDocumentationOnly ?? true,
          skipFormattingOnly: config.skipFormattingOnly ?? false,
          skipTestFixtures: config.skipTestFixtures ?? true,
          skipConfigFiles: config.skipConfigFiles ?? true,
          skipBuildArtifacts: config.skipBuildArtifacts ?? true,
          customTrivialPatterns: config.trivialPatterns ?? [],
        });

        const trivialResult = trivialDetector.detect(pr.files);

        if (trivialResult.isTrivial) {
          // Entire PR is trivial - post simple comment and skip review
          logger.info(`Skipping review: ${trivialResult.reason}`);
          await progressTracker?.updateProgress(
            'graph',
            'completed',
            'Skipped for trivial review'
          );
          await progressTracker?.updateProgress(
            'llm',
            'completed',
            'Skipped for trivial review'
          );
          const trivialReview = this.createTrivialReview(
            trivialResult.reason!,
            pr.files.length,
            start
          );
          trivialReview.threadLifecycle =
            await this.buildUnreviewedLifecycleForSkippedReview(
              pr,
              configuredLifecycleMode,
              `trivial review skipped: ${trivialResult.reason}`
            );
          trivialReview.coverage = buildReviewCoverage(
            { ...pr, files: [], diff: '' },
            config,
            {
              totalFiles: pr.files.length,
              skippedFiles: pr.files,
              mode: 'full',
            }
          );
          if (this.shouldPostReviewOutput(trivialReview, [])) {
            const markdown = this.components.formatter.format(trivialReview);
            await this.components.commentPoster.postSummary(
              pr.number,
              markdown,
              true,
              summaryMetadata
            );
          } else {
            logger.info(
              'Skipping ReviewRouter summary comment because no reportable findings were found'
            );
          }

          // Record metrics for trivial review (shows cost/time saved)
          if (config.analyticsEnabled && this.components.metricsCollector) {
            try {
              await this.components.metricsCollector.recordReview(
                trivialReview,
                pr.number
              );
              logger.debug(
                `Recorded trivial review metrics for PR #${pr.number}`
              );
            } catch (error) {
              logger.warn(
                'Failed to record trivial review metrics',
                error as Error
              );
            }
          }

          review = trivialReview;
          success = true;
          return trivialReview;
        }

        // Some files are trivial - filter them out before review (create new context, don't mutate)
        if (trivialResult.trivialFiles.length > 0) {
          logger.info(
            `Filtering ${trivialResult.trivialFiles.length} trivial files from review: ${trivialResult.trivialFiles.join(', ')}`
          );
          skippedTrivialFiles = pr.files.filter((f) =>
            trivialResult.trivialFiles.includes(f.filename)
          );
          const nonTrivialFiles = pr.files.filter((f) =>
            trivialResult.nonTrivialFiles.includes(f.filename)
          );
          reviewContext = {
            ...pr,
            files: nonTrivialFiles,
            diff: filterDiffByFiles(pr.diff, nonTrivialFiles),
          };
        }
      }

      // Determine review intensity based on file paths (after trivial filtering)
      let reviewIntensity: ReviewIntensity =
        config.pathDefaultIntensity ?? 'standard';

      if (config.pathBasedIntensity) {
        let patterns: PathPattern[] = [];
        if (config.pathIntensityPatterns) {
          try {
            const parsed = JSON.parse(config.pathIntensityPatterns);

            // Validate that parsed result is an array
            if (!Array.isArray(parsed)) {
              logger.warn(
                'pathIntensityPatterns is not an array, using defaults'
              );
              patterns = createDefaultPathMatcherConfig().patterns;
            } else {
              // Validate each pattern object against schema
              const PathPatternSchema = z.object({
                pattern: z.string(),
                intensity: z.enum(['thorough', 'standard', 'light'] as const),
                description: z.string().optional(),
              });

              const validPatterns: PathPattern[] = [];
              for (const item of parsed) {
                const result = PathPatternSchema.safeParse(item);
                if (result.success) {
                  validPatterns.push(result.data);
                } else {
                  logger.warn(
                    `Invalid path pattern object, skipping: ${JSON.stringify(item)}`
                  );
                }
              }

              if (validPatterns.length === 0) {
                logger.warn('No valid path patterns found, using defaults');
                patterns = createDefaultPathMatcherConfig().patterns;
              } else {
                patterns = validPatterns;
              }
            }
          } catch (error) {
            logger.warn(
              'Failed to parse pathIntensityPatterns, using defaults',
              error as Error
            );
            // Fallback to default patterns on parse failure
            patterns = createDefaultPathMatcherConfig().patterns;
          }
        } else {
          // No patterns configured, use defaults
          patterns = createDefaultPathMatcherConfig().patterns;
        }

        const pathMatcher = new PathMatcher({
          enabled: true,
          defaultIntensity: config.pathDefaultIntensity ?? 'standard',
          patterns,
        });

        const intensityResult = pathMatcher.determineIntensity(
          reviewContext.files
        );
        reviewIntensity = intensityResult.intensity;

        logger.info(
          `Review intensity: ${reviewIntensity} - ${intensityResult.reason}`
        );

        if (intensityResult.matchedPaths.length > 0) {
          logger.debug(
            `Matched paths: ${intensityResult.matchedPaths.join(', ')}`
          );
        }
      }

      // Apply intensity to provider selection and timeouts
      const configuredIntensityProviderLimit =
        config.intensityProviderCounts?.[reviewIntensity] ??
        config.providerLimit;
      const intensityProviderLimit =
        config.providerLimit > 0
          ? Math.min(config.providerLimit, configuredIntensityProviderLimit)
          : configuredIntensityProviderLimit;
      const baseTimeout = config.runTimeoutSeconds * 1000;
      const configuredIntensityTimeout =
        config.intensityTimeouts?.[reviewIntensity] ?? baseTimeout;
      const intensityTimeout = Math.max(
        configuredIntensityTimeout,
        baseTimeout
      );
      const openrouterTimeout = Math.min(
        intensityTimeout,
        config.openrouterTimeoutSeconds * 1000
      );

      logger.info(
        `Intensity settings: ${intensityProviderLimit} providers, ` +
          `${intensityTimeout}ms timeout, ` +
          `${openrouterTimeout}ms OpenRouter timeout (${reviewIntensity} mode)`
      );

      const incrementalPlan = await this.planIncrementalReview(reviewContext);
      const useIncremental =
        incrementalPlan.mode !== IncrementalReviewPlanMode.Full;
      const filesToReview = [...incrementalPlan.files];
      const incrementalInvalidatedPaths = [...incrementalPlan.invalidatedPaths];
      const lastReviewData = incrementalPlan.lastReview;
      if (incrementalPlan.mode === IncrementalReviewPlanMode.ReuseCompleted) {
        logger.info(
          'Completed snapshot matches the current revision; re-projecting live lifecycle state without provider execution or snapshot advancement'
        );
        const reusedReview = this.createReusedReview(
          incrementalPlan.lastReview,
          start
        );
        await this.projectCurrentStateOntoReusedReview(
          pr,
          reusedReview,
          configuredLifecycleMode
        );
        const reusedMarkdown = this.components.formatter.format(reusedReview);
        if (progressTracker) {
          await progressTracker.replaceWith(
            this.markReviewRouterSummary(reusedMarkdown)
          );
        } else if (this.shouldPostReviewOutput(reusedReview, [])) {
          await this.components.commentPoster.postSummary(
            pr.number,
            reusedMarkdown,
            true,
            summaryMetadata
          );
          logger.info(
            'Republished the completed snapshot summary without provider execution'
          );
        }
        review = reusedReview;
        success = true;
        return reusedReview;
      }
      let currentReviewFindingFingerprints: ReadonlySet<string> | undefined;
      if (incrementalPlan.mode === IncrementalReviewPlanMode.Delta) {
        logger.info(
          `Incremental review: reviewing ${filesToReview.length} changed files`
        );
      }

      const { codeGraph, contextRetriever } = await this.prepareCodeGraph({
        prNumber: pr.number,
        headSha: pr.headSha,
        reviewFiles: reviewContext.files,
        filesToReview,
        previousHeadSha: lastReviewData?.lastReviewedCommit,
        useIncremental,
        progressTracker,
      });
      const cachedFindings = config.enableCaching
        ? await this.components.cache.load(reviewContext)
        : null;

      // Create a PR context for the files to review with filtered diff
      const reviewPR: PRContext = useIncremental
        ? {
            ...reviewContext,
            files: filesToReview,
            diff: filterDiffByFiles(reviewContext.diff, filesToReview),
          }
        : reviewContext;
      let memoryPromptContext: string | undefined;
      if (filesToReview.length > 0 && this.components.memoryBundleProvider) {
        try {
          memoryPromptContext = formatActionMemoryBundleForPrompt(
            await this.components.memoryBundleProvider.fetchBundleForPullRequest(
              reviewPR
            )
          );
        } catch (error) {
          logger.warn(
            'ReviewRouter memory bundle retrieval failed; continuing without memory context',
            error as Error
          );
        }
      }

      const lifecycleMode: ReviewThreadLifecycleMode =
        this.components.reviewThreadInventory && this.components.githubClient
          ? configuredLifecycleMode
          : 'off';
      let lifecycleTargets: LifecycleTarget[] = [];
      let lifecycleManualAttention: LifecycleThreadRecord[] = [];
      let lifecycleSkipped: LifecycleThreadRecord[] = [];
      let lifecycleWarnings: string[] = [];
      let lifecycleInventoryFailed = false;
      let lifecycleDedupeComments: InlineCommentReference[] | undefined;
      let lifecycleAssignmentRecords: LifecycleAssignmentRecord[] = [];
      let lifecycleProviderResults: ProviderResult[] = [];
      let lifecyclePlannedProviders: string[] = [];
      let reviewCommentState: ReviewCommentState | undefined;

      if (lifecycleMode !== 'off' && this.components.reviewThreadInventory) {
        reviewCommentState =
          await this.components.feedbackFilter.loadReviewCommentState(
            pr.number,
            pr.headSha
          );
        const inventory = await this.components.reviewThreadInventory.load(
          pr.number
        );
        lifecycleManualAttention = inventory.manualAttention;
        lifecycleWarnings = inventory.warnings;
        lifecycleInventoryFailed = inventory.failed;
        lifecycleDedupeComments = inventory.failed
          ? undefined
          : inventory.dedupeComments;
        if (inventory.failed) {
          lifecycleTargets = [];
          lifecycleSkipped = [];
          lifecycleWarnings.push(
            'review thread lifecycle inventory was incomplete; no old thread was revalidated or auto-resolved'
          );
        } else {
          const prepared = this.prepareLifecycleTargets(
            inventory.candidates,
            reviewCommentState,
            config.reviewThreadLifecycleMaxTargets ?? 10
          );
          lifecycleTargets = prepared.targets;
          lifecycleSkipped = prepared.skipped;
        }
        if (inventory.headRefOid && inventory.headRefOid !== pr.headSha) {
          lifecycleWarnings.push(
            'review thread lifecycle inventory head SHA did not match loaded PR head SHA'
          );
          lifecycleSkipped.push(
            ...lifecycleTargets.map((target) => ({
              target,
              reasonCodes: ['head_sha_changed' as LifecycleReasonCode],
            }))
          );
          lifecycleTargets = [];
        }
      }

      // Skip LLM execution if no files to review (incremental with no changes)
      const llmFindings: Finding[] = [];
      let providerResults: ProviderResult[] = [];
      let aiAnalysis: ReturnType<typeof summarizeAIDetection> | undefined;
      const unreviewedFiles = new Map<string, string>();
      const successfulReviewContexts: PRContext[] = [];
      const loadLimitations: string[] = [];
      let additionalUnreviewedFiles = 0;
      let hasProviderCoverageGap = false;
      if (
        reviewContext.loadCompleteness?.status ===
        PullRequestLoadStatus.Truncated
      ) {
        for (const omission of reviewContext.loadCompleteness.omissions) {
          if (
            omission.reason ===
            PullRequestLoadOmissionReason.SynthesizedDiffSizeLimit
          ) {
            logger.info(
              `${omission.omittedFileCount} file patch(es) were omitted from the aggregate synthesized diff and will be recovered per batch`
            );
          } else {
            additionalUnreviewedFiles += omission.omittedFileCount ?? 0;
            loadLimitations.push(
              omission.omittedFileCount === undefined
                ? 'GitHub omitted an unknown number of files beyond its API limit'
                : `GitHub omitted ${omission.omittedFileCount} file(s) beyond its API limit`
            );
          }
        }
      }
      let llmCoverageComplete =
        filesToReview.length === 0 &&
        unreviewedFiles.size === 0 &&
        loadLimitations.length === 0;
      const requiredHealthyProviders =
        this.requiredHealthyProviderNames(config);
      let providers: Provider[] = [];
      if (filesToReview.length > 0) {
        providers =
          await this.components.providerRegistry.createProviders(config);
        providers = await this.applyReliabilityFilters(providers);
        this.assertRequiredProvidersAvailable(
          requiredHealthyProviders,
          providers,
          'provider selection'
        );
        if (providers.length === 0) {
          logger.warn(
            'All providers filtered out by circuit breakers/reliability; skipping LLM execution'
          );
          await progressTracker?.updateProgress(
            'llm',
            'failed',
            'No available providers after reliability filtering'
          );
        }
      }

      if (filesToReview.length === 0) {
        logger.info(
          'No files to review in incremental update, using cached findings only'
        );
      } else {
        await this.ensureBudget(config);
        const batchOrchestrator =
          this.components.batchOrchestrator ||
          new BatchOrchestrator({
            defaultBatchSize: config.batchMaxFiles || 30,
            providerOverrides: config.providerBatchOverrides,
            enableTokenAwareBatching: config.enableTokenAwareBatching,
            targetTokensPerBatch: config.targetTokensPerBatch,
            maxBatchSize: config.batchMaxFiles,
          });

        // Health check providers, retrying discovery if we don't hit minimum healthy targets
        let allHealthResults: ProviderResult[] = [];
        let healthy: Provider[] = [];
        const triedProviders = new Set<string>(providers.map((p) => p.name));

        const runHealthCheck = async (candidateProviders: Provider[]) => {
          const { healthy: h, healthCheckResults } =
            await this.components.llmExecutor.filterHealthyProviders(
              candidateProviders,
              HEALTH_CHECK_TIMEOUT_MS
            );
          healthy = healthy.concat(h);
          allHealthResults = allHealthResults.concat(healthCheckResults);
        };

        await runHealthCheck(providers);
        this.assertRequiredProvidersHealthy(
          requiredHealthyProviders,
          healthy,
          allHealthResults
        );

        // Dynamic minima: prefer 4 OpenRouter + 2 OpenCode when limit allows
        const selectionLimit = Math.max(1, intensityProviderLimit || 8);
        const desiredOpenRouter = Math.min(
          4,
          providers.filter((p) => p.name.startsWith('openrouter/')).length
        );
        const desiredOpenCode = Math.min(
          2,
          providers.filter((p) => p.name.startsWith('opencode/')).length
        );
        const MIN_OPENROUTER_HEALTHY = desiredOpenRouter;
        const MIN_OPENCODE_HEALTHY = desiredOpenCode;
        const singleProviderMode =
          providers.length === 1 && config.providers.length === 1;
        const defaultMinimumHealthy = singleProviderMode ? 1 : 2;
        const MIN_TOTAL_HEALTHY = Math.min(
          selectionLimit,
          Math.max(
            defaultMinimumHealthy,
            desiredOpenRouter + desiredOpenCode || defaultMinimumHealthy
          )
        );
        const MIN_FALLBACK_HEALTHY = Math.min(
          defaultMinimumHealthy,
          selectionLimit
        );

        const countOpenCode = (list: Provider[]) =>
          list.filter((p) => p.name.startsWith('opencode/')).length;
        const countOpenRouter = (list: Provider[]) =>
          list.filter((p) => p.name.startsWith('openrouter/')).length;

        let attempts = 0;
        type RegistryWithDiscovery = ProviderRegistry & {
          discoverAdditionalFreeProviders?: (
            existing: string[],
            max?: number,
            cfg?: ReviewConfig
          ) => Promise<Provider[]>;
        };
        const registry = this.components
          .providerRegistry as RegistryWithDiscovery;
        const discoverExtras =
          typeof registry.discoverAdditionalFreeProviders === 'function'
            ? (names: string[]) =>
                registry.discoverAdditionalFreeProviders!(
                  names,
                  selectionLimit * 2,
                  config
                )
            : null;

        while (
          attempts < 6 &&
          discoverExtras &&
          (healthy.length < MIN_TOTAL_HEALTHY ||
            countOpenCode(healthy) < MIN_OPENCODE_HEALTHY ||
            countOpenRouter(healthy) < MIN_OPENROUTER_HEALTHY)
        ) {
          const additional = await discoverExtras(Array.from(triedProviders));
          if (additional.length === 0) break;

          additional.forEach((p) => triedProviders.add(p.name));
          await runHealthCheck(additional);
          attempts += 1;
        }

        const meetsPrimaryTargets =
          healthy.length >= MIN_TOTAL_HEALTHY &&
          countOpenCode(healthy) >= MIN_OPENCODE_HEALTHY &&
          countOpenRouter(healthy) >= MIN_OPENROUTER_HEALTHY;
        const requiredHealthySatisfied =
          requiredHealthyProviders.size > 0 &&
          Array.from(requiredHealthyProviders).every((name) =>
            healthy.some((provider) => provider.name === name)
          );

        if (
          !meetsPrimaryTargets &&
          !requiredHealthySatisfied &&
          healthy.length < MIN_FALLBACK_HEALTHY
        ) {
          logger.warn(
            'Insufficient healthy providers after retries; skipping LLM execution'
          );
          if (
            process.env.FAIL_ON_NO_HEALTHY_PROVIDERS === 'true' &&
            healthy.length === 0
          ) {
            throw new Error(
              'No healthy providers available; failing because FAIL_ON_NO_HEALTHY_PROVIDERS=true'
            );
          }
          providerResults = allHealthResults;
          hasProviderCoverageGap = true;
          for (const file of filesToReview) {
            unreviewedFiles.set(
              file.filename,
              'no healthy provider was available for this batch'
            );
          }
          await this.recordReliability(providerResults);
          await progressTracker?.updateProgress(
            'llm',
            'failed',
            `Healthy providers insufficient (total=${healthy.length}, openrouter=${countOpenRouter(
              healthy
            )}, opencode=${countOpenCode(healthy)})`
          );
        } else {
          // Limit healthy providers to providerLimit for actual execution
          // (we may have checked more providers for reliability)
          const executionLimit = Math.max(
            intensityProviderLimit || config.providerLimit,
            requiredHealthyProviders.size
          );
          if (healthy.length > executionLimit) {
            logger.info(
              `Limiting execution to ${executionLimit} providers (checked ${healthy.length} for health). ` +
                `Using top providers by reliability.`
            );
            healthy = this.selectExecutionProviders(
              healthy,
              requiredHealthyProviders,
              executionLimit
            );
          }
          this.assertRequiredProvidersAvailable(
            requiredHealthyProviders,
            healthy,
            'provider execution'
          );

          // Use token-aware batching if enabled
          let batches: FileChange[][];
          const providerNames = healthy.map((p) => p.name);
          const prioritizedFiles = prioritizeFilesByRisk(filesToReview);
          lifecyclePlannedProviders = providerNames;

          if (config.enableTokenAwareBatching) {
            try {
              batches = batchOrchestrator.createTokenAwareBatches(
                prioritizedFiles,
                providerNames
              );
            } catch (error) {
              logger.warn(
                `Token-aware batching failed, falling back to fixed-size batching`,
                error as Error
              );
              const batchSize = batchOrchestrator.getBatchSize(providerNames);
              batches = batchOrchestrator.createBatches(
                prioritizedFiles,
                batchSize
              );
            }
          } else {
            const batchSize = batchOrchestrator.getBatchSize(providerNames);
            try {
              batches = batchOrchestrator.createBatches(
                prioritizedFiles,
                batchSize
              );
            } catch (error) {
              logger.warn(
                `Invalid batch size computed from providers - falling back to size 1`,
                error as Error
              );
              batches = batchOrchestrator.createBatches(prioritizedFiles, 1);
            }
          }

          const batchPlan = createReviewBatchPlan({
            batches,
            baseSha: pr.baseSha,
            headSha: pr.headSha,
            compatibilityKey:
              this.components.reviewCompatibilityKey ?? '0'.repeat(64),
            providerNames,
          });
          const createBatchContext = (batch: readonly FileChange[]) => {
            const recovered = recoverDiffForFiles(reviewContext.diff, batch);
            for (const filename of recovered.unavailableFiles) {
              unreviewedFiles.set(
                filename,
                'unified diff patch was unavailable from GitHub and local git'
              );
            }
            return {
              ...reviewContext,
              files: [...batch],
              diff: recovered.diff,
            } satisfies PRContext;
          };
          let checkpointSession: ReviewCheckpointSession | null = null;
          if (
            this.components.openReviewCheckpointSession &&
            batchPlan.batches.length > 1
          ) {
            try {
              checkpointSession =
                await this.components.openReviewCheckpointSession({
                  pullRequestNumber: pr.number,
                  baseSha: batchPlan.baseSha,
                  headSha: batchPlan.headSha,
                  compatibilityKey: batchPlan.compatibilityKey,
                  planHash: batchPlan.planHash,
                  workKeys: batchPlan.batches.map((batch) => batch.id),
                });
            } catch (error) {
              logger.warn(
                'Hosted review checkpoint could not be opened; continuing without resume',
                error as Error
              );
            }
          } else if (this.components.openReviewCheckpointSession) {
            logger.debug(
              'Skipping durable batch checkpoint for a single-batch review'
            );
          }

          const lifecycleTargetsByBatch =
            lifecycleMode === 'off'
              ? []
              : batches.map((batch) =>
                  this.lifecycleTargetsForBatch(lifecycleTargets, batch)
                );
          const lifecycleFailedProvidersByTarget = new Map<
            string,
            Set<string>
          >();
          lifecycleAssignmentRecords =
            lifecycleMode === 'off'
              ? []
              : this.buildLifecycleAssignmentRecords(
                  lifecycleTargets,
                  lifecycleTargetsByBatch,
                  providerNames
                );

          logger.info(`Processing ${batches.length} batch(es)`);

          const batchResults: ProviderResult[] = [];
          const restoredCheckpointResults =
            checkpointSession?.acceptedBatchResults ?? new Map();
          if (
            Array.from(restoredCheckpointResults.values()).some(
              (payload) =>
                !this.hasCompleteProviderCheckpointCoverage(
                  healthy,
                  this.restoreCheckpointProviderResults(payload)
                )
            )
          ) {
            logger.warn(
              'Ignoring the v1 checkpoint session because a restored batch contains partial provider results'
            );
            checkpointSession = null;
          }
          const acceptedCheckpointResults =
            checkpointSession?.acceptedBatchResults ?? new Map();
          for (const plannedBatch of batchPlan.batches) {
            const accepted = acceptedCheckpointResults.get(plannedBatch.id);
            if (!accepted) continue;
            successfulReviewContexts.push(
              createBatchContext(plannedBatch.files)
            );
            const restoredResults =
              this.restoreCheckpointProviderResults(accepted);
            await this.recordProviderUsage(
              restoredResults,
              config.budgetMaxUsd
            );
            this.logProviderTokenTelemetry(
              `checkpoint:${plannedBatch.id}`,
              restoredResults
            );
            batchResults.push(...restoredResults);
            this.recordLifecycleBatchProviderFailures(
              lifecycleTargetsByBatch[plannedBatch.index] ?? [],
              restoredResults,
              lifecycleFailedProvidersByTarget
            );
          }
          const pendingBatches = batchPlan.batches.filter(
            (batch) => !acceptedCheckpointResults.has(batch.id)
          );
          if (acceptedCheckpointResults.size > 0) {
            logger.info(
              `Resuming review with ${acceptedCheckpointResults.size}/${batchPlan.batches.length} durable batch(es)`
            );
          }

          const scheduler = new AdaptiveBatchScheduler(
            this.components.executionDeadline ?? { canStartBatch: () => true }
          );
          const scheduled = await scheduler.schedule(
            pendingBatches,
            async (plannedBatch) => {
              const batch = [...plannedBatch.files];
              const batchIndex = plannedBatch.index;
              const batchContext = createBatchContext(batch);
              const lifecycleTargetsForBatch =
                lifecycleTargetsByBatch[batchIndex] ?? [];
              const lifecycleAssignedTargetIds = lifecycleTargetsForBatch.map(
                (target) => target.targetId
              );
              const promptBuilder = new PromptBuilder(
                config,
                reviewIntensity,
                undefined,
                codeGraph,
                memoryPromptContext
              );
              const prompt = await promptBuilder.build(
                batchContext,
                undefined,
                lifecycleTargetsForBatch
              );

              try {
                const results = await this.components.llmExecutor.execute(
                  healthy,
                  prompt,
                  intensityTimeout
                );
                const scopedResults = results
                  .map((result) => ({
                    ...result,
                    lifecycleAssignedTargetIds,
                  }))
                  .sort((left, right) => left.name.localeCompare(right.name));
                this.recordLifecycleBatchProviderFailures(
                  lifecycleTargetsForBatch,
                  scopedResults,
                  lifecycleFailedProvidersByTarget
                );

                const requiredFailure =
                  this.findRequiredProviderExecutionFailure(
                    requiredHealthyProviders,
                    scopedResults
                  );
                if (
                  checkpointSession &&
                  !requiredFailure &&
                  this.hasCompleteProviderCheckpointCoverage(
                    healthy,
                    scopedResults
                  )
                ) {
                  await checkpointSession.commitSuccessfulBatch({
                    workKey: plannedBatch.id,
                    files: batch,
                    findings: extractFindings(scopedResults),
                    providerResults: scopedResults,
                  });
                }

                if (
                  scopedResults.some((result) => result.status === 'success')
                ) {
                  successfulReviewContexts.push(batchContext);
                }

                await this.recordProviderUsage(
                  scopedResults,
                  config.budgetMaxUsd
                );
                this.logProviderTokenTelemetry(
                  `batch:${plannedBatch.id}`,
                  scopedResults
                );

                return scopedResults;
              } catch (error) {
                logger.error('Batch execution failed', error as Error);
                const failedResults = healthy.map((provider) => ({
                  name: provider.name,
                  status: 'error' as const,
                  error: error as Error,
                  durationSeconds: 0,
                  lifecycleAssignedTargetIds,
                }));
                this.recordLifecycleBatchProviderFailures(
                  lifecycleTargetsForBatch,
                  failedResults,
                  lifecycleFailedProvidersByTarget
                );
                return failedResults;
              }
            },
            classifyProviderCapacitySignal
          );

          // Use completed work in deterministic plan order and surface anything
          // not started before the deadline as explicit coverage gaps.
          let batchFailures = 0;
          let batchSuccesses = acceptedCheckpointResults.size;
          const requiredProviderFailures: Error[] = [];
          for (const result of scheduled.completed) {
            const batchIndex = result.item.index;
            if (result.status === BatchExecutionStatus.Fulfilled) {
              batchResults.push(...result.result);
              const requiredFailure = this.findRequiredProviderExecutionFailure(
                requiredHealthyProviders,
                result.result
              );
              if (requiredFailure) {
                requiredProviderFailures.push(requiredFailure);
              }
              const successfulProviders = result.result.filter(
                (r) => r.status === 'success'
              );
              const degradedProviders = result.result.filter(
                (r) => r.status !== 'success'
              );
              if (
                !this.hasCompleteProviderCheckpointCoverage(
                  healthy,
                  result.result
                )
              ) {
                hasProviderCoverageGap = true;
              }

              if (successfulProviders.length > 0) {
                batchSuccesses += 1;
                for (const degraded of degradedProviders) {
                  const structuredOutputFailure =
                    degraded.error &&
                    shouldRetryProviderReviewError(degraded.error);
                  const reason = this.redactProviderFailureReason(
                    degraded.error?.message || degraded.status
                  );
                  if (requiredHealthyProviders.has(degraded.name)) {
                    logger.warn(
                      structuredOutputFailure
                        ? `Required provider ${degraded.name} failed structured output after ${config.providerRetries} attempt(s); review will fail after batch completion. ${reason}`
                        : `Required provider ${degraded.name} failed; review will fail after batch completion. ${reason}`
                    );
                    continue;
                  }
                  logger.warn(
                    structuredOutputFailure
                      ? `Provider ${degraded.name} failed structured output after ${config.providerRetries} attempt(s); continuing with successful providers. ${reason}`
                      : `Provider ${degraded.name} degraded; continuing with successful providers. ${reason}`
                  );
                }
              } else {
                batchFailures += 1;
                for (const file of batches[batchIndex] ?? []) {
                  unreviewedFiles.set(
                    file.filename,
                    'all providers failed for this batch'
                  );
                }
              }
            } else {
              hasProviderCoverageGap = true;
              batchFailures += 1;
              for (const file of batches[batchIndex] ?? []) {
                unreviewedFiles.set(
                  file.filename,
                  'batch execution did not complete'
                );
              }
              logger.error('Batch promise rejected', result.error);
              // Add error results for all providers in this batch
              const lifecycleAssignedTargetIds = (
                lifecycleTargetsByBatch[batchIndex] ?? []
              ).map((target) => target.targetId);
              const failedBatchResults = healthy.map((provider) => ({
                name: provider.name,
                status: 'error' as const,
                error: result.error as Error,
                durationSeconds: 0,
                lifecycleAssignedTargetIds,
              }));
              batchResults.push(...failedBatchResults);
              const requiredFailure = this.findRequiredProviderExecutionFailure(
                requiredHealthyProviders,
                failedBatchResults
              );
              if (requiredFailure) {
                requiredProviderFailures.push(requiredFailure);
              }
            }
          }

          for (const deferred of scheduled.deferred) {
            hasProviderCoverageGap = true;
            batchFailures += 1;
            for (const file of deferred.item.files) {
              unreviewedFiles.set(
                file.filename,
                'batch was not started because the review deadline was near'
              );
            }
          }
          if (batchFailures > 0) {
            logger.warn(
              'Review batch coverage is partial; no completed incremental snapshot will be persisted'
            );
          }
          if (hasProviderCoverageGap) {
            loadLimitations.push(
              'One or more selected providers did not complete every review batch'
            );
          }

          this.applyLifecycleBatchProviderFailures(
            lifecycleAssignmentRecords,
            lifecycleFailedProvidersByTarget
          );
          lifecycleProviderResults = batchResults;

          // Merge results deterministically: prefer batch results over health checks, unique per provider
          const mergedMap = new Map<string, ProviderResult>();
          for (const result of allHealthResults) {
            mergedMap.set(result.name, result);
          }
          for (const result of batchResults) {
            mergedMap.set(result.name, result);
          }
          const mergedResults = Array.from(mergedMap.values()).sort((a, b) =>
            a.name.localeCompare(b.name)
          );

          // Record reliability for all results (both successes and failures)
          await this.recordReliability(mergedResults);

          if (requiredProviderFailures.length > 0) {
            throw requiredProviderFailures[0];
          }
          // Use partial success: proceed if at least some batches succeeded
          // Even if ALL batches failed, continue with AST/security analysis
          if (batchFailures > 0) {
            if (batchSuccesses === 0) {
              const failedNames = mergedResults
                .filter((r) => r.status !== 'success')
                .map((r) => r.name)
                .join(', ');
              const providerFailureSummary =
                this.formatProviderFailureSummary(mergedResults);
              const failOnProviderFailure =
                process.env.FAIL_ON_NO_HEALTHY_PROVIDERS === 'true';
              logger.error(
                `All LLM batches failed (${batchFailures}/${batches.length}): ${failedNames}. ` +
                  (failOnProviderFailure
                    ? 'Failing because FAIL_ON_NO_HEALTHY_PROVIDERS=true.'
                    : 'Continuing with static analysis only.')
              );
              await progressTracker?.updateProgress(
                'llm',
                'failed',
                `All batches failed: ${failedNames}`
              );
              if (failOnProviderFailure) {
                throw new Error(
                  `All LLM providers failed during review; failing because FAIL_ON_NO_HEALTHY_PROVIDERS=true. ${providerFailureSummary}`
                );
              }
            } else {
              logger.warn(
                `Partial batch failure: ${batchFailures} failed, ${batchSuccesses} succeeded. Using successful results.`
              );
              await progressTracker?.updateProgress(
                'llm',
                'completed',
                `Batches: ${batchSuccesses}/${batches.length} succeeded`
              );
            }
          } else {
            await progressTracker?.updateProgress(
              'llm',
              'completed',
              `Processed ${batches.length} batch(es)`
            );
          }

          llmCoverageComplete =
            batchFailures === 0 &&
            unreviewedFiles.size === 0 &&
            loadLimitations.length === 0;
          if (checkpointSession && batchFailures === 0) {
            await checkpointSession.finalize({
              snapshotAdvancementRequired:
                (this.components.incrementalSnapshotAdvancementEnabled ??
                  config.incrementalEnabled) &&
                llmCoverageComplete,
            });
          }

          llmFindings.push(...extractFindings(batchResults));
          providerResults = mergedResults;
          aiAnalysis = config.enableAiDetection
            ? summarizeAIDetection(providerResults)
            : undefined;
        }
      }

      // Run static analysis in parallel for better performance
      const staticAnalysis = await this.runStaticAnalysis(
        filesToReview,
        contextRetriever
      );

      const combinedFindings = [
        ...staticAnalysis.astFindings,
        ...staticAnalysis.ruleFindings,
        ...staticAnalysis.securityFindings,
        ...llmFindings,
        ...(cachedFindings || []),
      ];

      const deduped = this.components.deduplicator.dedupe(combinedFindings);
      const consensus = this.components.consensus.filter(deduped);
      const providerCount = countProviderVotePool(providers) || 1;
      const enriched = consensus.map((f) =>
        this.enrichFinding(
          f,
          pr.files,
          staticAnalysis.context,
          providerCount,
          codeGraph
        )
      );
      const quietFiltered = await this.applyQuietMode(enriched, config);

      // Apply post-processing filter to reduce false positives
      const findingFilter = new FindingFilter();
      const { findings: finalFiltered, stats: filterStats } =
        findingFilter.filter(quietFiltered, pr.diff);

      if (filterStats.filtered > 0 || filterStats.downgraded > 0) {
        logger.info(
          `Post-processing filter (new current findings only): ${filterStats.filtered} filtered, ${filterStats.downgraded} downgraded, ${filterStats.kept} kept (from ${filterStats.total} total)`
        );
        if (Object.keys(filterStats.reasons).length > 0) {
          logger.debug('Filter breakdown:', filterStats.reasons);
        }
      }

      await progressTracker?.updateProgress(
        'static',
        'completed',
        'AST, security, and rules processed'
      );

      const testHints = config.enableTestHints
        ? this.components.testCoverage.analyze(pr.files)
        : undefined;
      const impactAnalysis = this.components.impactAnalyzer.analyze(
        pr.files,
        staticAnalysis.context,
        finalFiltered.length > 0
      );
      const mermaidDiagram =
        this.components.mermaidGenerator.generateImpactDiagram(
          pr.files,
          staticAnalysis.context
        );
      const costSummary = this.components.costTracker.summary();
      this.logTotalTokenTelemetry();
      const runDetails: RunDetails = {
        providers: providerResults.map((r) => ({
          name: r.name,
          status: r.status,
          durationSeconds: r.durationSeconds,
          requiredHealthy: requiredHealthyProviders.has(r.name),
          tokens: r.result?.usage?.totalTokens,
          cost: costSummary.breakdown[r.name],
          errorMessage: r.error?.message,
        })),
        totalCost: costSummary.totalCost,
        totalTokens: costSummary.totalTokens,
        durationSeconds: 0,
        cacheHit: Boolean(cachedFindings),
        synthesisModel: config.synthesisModel,
        providerPoolSize: providerCount,
      };

      review = this.components.synthesis.synthesize(
        finalFiltered,
        reviewPR,
        testHints,
        aiAnalysis,
        providerResults,
        runDetails,
        impactAnalysis,
        mermaidDiagram
      );
      review.coverage = buildReviewCoverage(reviewPR, config, {
        totalFiles: pr.files.length + additionalUnreviewedFiles,
        skippedFiles: skippedTrivialFiles,
        unreviewedFiles: filesToReview
          .filter((file) => unreviewedFiles.has(file.filename))
          .map((file) => ({
            file,
            reason:
              unreviewedFiles.get(file.filename) ??
              'LLM review did not complete',
          })),
        mode: useIncremental && lastReviewData ? 'incremental' : 'full',
        additionalUnreviewedFiles,
        limitations: loadLimitations,
        reviewedContexts: successfulReviewContexts,
      });

      // Merge with previous review if incremental
      if (useIncremental && lastReviewData) {
        const currentReviewFindings = review.findings;
        currentReviewFindingFingerprints = new Set(
          currentReviewFindings.map(findingFingerprintFromFinding)
        );
        // Merge findings: keep findings from unchanged files, add new findings
        review.findings = this.components.incrementalReviewer.mergeFindings(
          lastReviewData.findings,
          currentReviewFindings,
          filesToReview,
          incrementalInvalidatedPaths
        );

        // Update summary with incremental note
        review.summary =
          this.components.incrementalReviewer.generateIncrementalSummary(
            lastReviewData.reviewSummary,
            review.summary,
            filesToReview,
            lastReviewData.lastReviewedCommit,
            pr.headSha
          );

        // Update metrics to reflect total findings
        review.metrics.totalFindings = review.findings.length;
        review.metrics.critical = review.findings.filter(
          (f) => f.severity === 'critical'
        ).length;
        review.metrics.major = review.findings.filter(
          (f) => f.severity === 'major'
        ).length;
        review.metrics.minor = review.findings.filter(
          (f) => f.severity === 'minor'
        ).length;

        logger.info(
          `Incremental review completed: ${review.findings.length} total findings after merge`
        );
      }

      review.metrics.totalCost = costSummary.totalCost;
      review.metrics.totalTokens = costSummary.totalTokens;
      review.metrics.providersUsed = providers.length;
      review.metrics.providersSuccess = providerResults.filter(
        (r) => r.status === 'success'
      ).length;
      review.metrics.providersFailed =
        providerResults.length - review.metrics.providersSuccess;
      review.metrics.durationSeconds = (Date.now() - start) / 1000;
      if (review.runDetails) {
        review.runDetails.durationSeconds = review.metrics.durationSeconds;
      }
      review.metrics.cached = Boolean(cachedFindings);

      // Generate fix prompts if enabled
      if (config.generateFixPrompts && this.components.promptGenerator) {
        const fixPrompts = this.components.promptGenerator.generateFixPrompts(
          review.findings
        );
        if (fixPrompts.length > 0) {
          // Sanitize REPORT_BASENAME to prevent path traversal
          const basename = this.sanitizeFilename(
            process.env.REPORT_BASENAME || 'review-router'
          );
          const fixPromptsPath = path.join(
            process.cwd(),
            `${basename}-fix-prompts.md`
          );
          const format =
            (config.fixPromptFormat as 'cursor' | 'copilot' | 'plain') ||
            'plain';
          await this.components.promptGenerator.saveToFile(
            fixPrompts,
            fixPromptsPath,
            format
          );
          logger.info(
            `Generated ${fixPrompts.length} fix prompts: ${fixPromptsPath}`
          );
        }
      }

      if (config.enableCaching) {
        await this.components.cache.save(pr, review);
      }

      // Record review metrics for analytics
      if (config.analyticsEnabled && this.components.metricsCollector) {
        try {
          await this.components.metricsCollector.recordReview(
            review,
            pr.number
          );
          logger.debug(`Recorded review metrics for PR #${pr.number}`);
        } catch (error) {
          logger.warn('Failed to record review metrics', error as Error);
        }
      }

      reviewCommentState =
        await this.components.feedbackFilter.loadReviewCommentState(
          pr.number,
          pr.headSha
        );
      if (lifecycleMode !== 'off') {
        if (lifecycleDedupeComments !== undefined) {
          this.applyGraphQLDedupeState(
            reviewCommentState,
            lifecycleDedupeComments
          );
        }
      }
      const dismissedCount = this.applyCommandDismissals(
        review,
        reviewCommentState
      );
      if (dismissedCount > 0) {
        logger.info(
          `Applied ${dismissedCount} /rr skip dismissal(s) before publishing review`
        );
      }
      if (currentReviewFindingFingerprints) {
        const currentFingerprints = currentReviewFindingFingerprints;
        review.findingProvenance = buildIncrementalFindingProvenance(
          review.findings.filter((finding) =>
            currentFingerprints.has(findingFingerprintFromFinding(finding))
          ),
          review.findings
        );
      }

      const freshCurrentFindings = currentReviewFindingFingerprints
        ? review.findings.filter((finding) =>
            currentReviewFindingFingerprints.has(
              findingFingerprintFromFinding(finding)
            )
          )
        : review.findings;
      const carriedFindings = currentReviewFindingFingerprints
        ? review.findings.filter(
            (finding) =>
              !currentReviewFindingFingerprints.has(
                findingFingerprintFromFinding(finding)
              )
          )
        : [];

      if (lifecycleMode !== 'off') {
        lifecycleManualAttention = this.filterCommandDismissedLifecycleRecords(
          lifecycleManualAttention,
          reviewCommentState,
          lifecycleSkipped
        );
        const activeLifecycleTargets =
          this.filterCommandDismissedLifecycleTargets(
            lifecycleTargets,
            reviewCommentState,
            lifecycleSkipped
          );
        const lifecycle = new ThreadLifecycleAggregator().aggregate({
          mode: lifecycleMode,
          targets: activeLifecycleTargets,
          plannedProviders: lifecyclePlannedProviders,
          providerResults: lifecycleProviderResults,
          currentFindings: freshCurrentFindings,
          assignmentRecords: lifecycleAssignmentRecords,
          initialManualAttention: lifecycleManualAttention,
          skipped: lifecycleSkipped,
          warnings: lifecycleWarnings,
          inventoryFailed: lifecycleInventoryFailed,
          config,
        });

        if (
          lifecycleMode === 'resolve' &&
          lifecycle.resolvedCandidates.length > 0
        ) {
          if (this.components.reviewThreadResolver) {
            const mutationResult =
              await this.components.reviewThreadResolver.resolveGuarded(
                pr.number,
                pr.headSha,
                lifecycle.resolvedCandidates
              );
            this.applyLifecycleMutationResult(lifecycle, mutationResult);
            lifecycleDedupeComments = this.removeResolvedLifecycleDedupeRefs(
              lifecycleDedupeComments ?? [],
              lifecycle.resolvedByLifecycle
            );
            this.applyGraphQLDedupeState(
              reviewCommentState,
              lifecycleDedupeComments
            );

            if (this.components.reviewThreadInventory) {
              const refreshedInventory =
                await this.components.reviewThreadInventory.load(pr.number);
              if (!refreshedInventory.failed) {
                lifecycleDedupeComments = refreshedInventory.dedupeComments;
                this.applyGraphQLDedupeState(
                  reviewCommentState,
                  lifecycleDedupeComments
                );
              } else {
                lifecycle.warnings.push(
                  'post-mutation review thread lifecycle inventory refresh failed'
                );
              }
            }
          } else {
            lifecycle.mutationSkipped.push(
              ...lifecycle.resolvedCandidates.map((record) => ({
                ...record,
                reasonCodes: [
                  ...record.reasonCodes,
                  'mutation_failed' as LifecycleReasonCode,
                ],
              }))
            );
            lifecycle.resolvedCandidates = [];
            lifecycle.warnings.push(
              'review thread lifecycle resolver unavailable; no thread was auto-resolved'
            );
          }
        }
        this.failUnconfirmedLifecycleCandidates(lifecycle);

        if (currentReviewFindingFingerprints) {
          const reconciled = reconcileCarriedFindingsWithLifecycle({
            mergedFindings: review.findings,
            carriedFindings,
            lifecycle,
          });
          if (reconciled.removed.length > 0) {
            review.findings = reconciled.findings;
            this.refreshFindingDerivedState(review);
            logger.info(
              `Removed ${reconciled.removed.length} carried-forward finding(s) after confirmed live lifecycle deactivation`
            );
          }
          review.findingProvenance = buildIncrementalFindingProvenance(
            review.findings.filter((finding) =>
              currentReviewFindingFingerprints.has(
                findingFingerprintFromFinding(finding)
              )
            ),
            review.findings
          );
        }

        review.threadLifecycle = lifecycle;
      }

      const markdown = this.components.formatter.format(review);
      await this.updatePullRequestDescription(pr);

      // Detect and record suggestion acceptances (positive feedback)
      if (
        config.learningEnabled &&
        this.components.acceptanceDetector &&
        this.components.providerWeightTracker &&
        this.components.githubClient
      ) {
        try {
          await this.detectAndRecordAcceptances(pr.number);
        } catch (error) {
          // Don't fail review if acceptance detection fails - it's supplementary
          logger.debug('Failed to detect acceptances', error as Error);
        }
      }

      const inlineFiltered = review.inlineComments.filter((c) =>
        this.components.feedbackFilter.shouldPost(c, reviewCommentState)
      );

      let shouldReplaceProgressWithCleanSummary = false;
      if (this.shouldPostReviewOutput(review, inlineFiltered)) {
        let summaryPostedViaProgress = false;
        if (progressTracker) {
          summaryPostedViaProgress = await progressTracker.replaceWith(
            this.markReviewRouterSummary(markdown)
          );
          if (summaryPostedViaProgress) {
            logger.info(
              'Replaced ReviewRouter progress comment with final review summary'
            );
          }
        }
        if (!summaryPostedViaProgress) {
          await this.components.commentPoster.postSummary(
            pr.number,
            markdown,
            true,
            summaryMetadata
          );
        }
        await this.components.commentPoster.postInline(
          pr.number,
          inlineFiltered,
          pr.files,
          pr.headSha,
          lifecycleMode !== 'off' ? lifecycleDedupeComments : undefined
        );
      } else {
        logger.info(
          'Skipping ReviewRouter GitHub comments because no reportable findings were found'
        );
        await this.components.commentPoster.deleteSummaryComments(
          pr.number,
          summaryMetadata,
          'no reportable findings were found'
        );
        await this.components.commentPoster.postInline(
          pr.number,
          [],
          pr.files,
          pr.headSha
        );
        shouldReplaceProgressWithCleanSummary = true;
      }

      await this.writeReports(review);
      await progressTracker?.updateProgress('synthesis', 'completed');
      if (shouldReplaceProgressWithCleanSummary && progressTracker) {
        const replaced = await progressTracker.replaceWith(
          this.markReviewRouterSummary(markdown)
        );
        if (replaced) {
          logger.info(
            'Replaced ReviewRouter progress comment with final no-findings summary'
          );
        }
      }
      if (config.incrementalEnabled) {
        if (llmCoverageComplete) {
          if (await this.canAdvanceIncrementalSnapshot(pr)) {
            try {
              await this.components.incrementalReviewer.saveReview(pr, review);
            } catch (error) {
              logger.warn(
                'Failed to save incremental review snapshot; review output remains valid',
                error as Error
              );
            }
          }
        } else {
          logger.warn(
            'Incremental snapshot was not advanced because LLM batch coverage is incomplete'
          );
        }
      }
      success = true;
      return review;
    } catch (error) {
      const normalizedError = normalizeReviewError(error);
      progressTracker?.setFailure(normalizedError);
      if (progressTracker && !progressTracker.hasFailedItems()) {
        await progressTracker.updateProgress(
          'synthesis',
          'failed',
          normalizedError.summary
        );
      }
      throw error;
    } finally {
      if (progressTracker) {
        try {
          progressTracker.setTotalCost(
            this.components.costTracker.summary().totalCost
          );
          await progressTracker.finalize(success);
        } catch (err) {
          logger.warn('Failed to finalize progress tracker', err as Error);
        }
      }
    }
  }

  private async canAdvanceIncrementalSnapshot(pr: PRContext): Promise<boolean> {
    const githubClient = this.components.githubClient;
    if (!githubClient) {
      return true;
    }
    const verification = await verifyPullRequestHead(githubClient.octokit, {
      owner: githubClient.owner,
      repo: githubClient.repo,
      prNumber: pr.number,
      expectedHeadSha: pr.headSha,
    });
    if (verification.status === PullRequestHeadVerificationStatus.Current) {
      return true;
    }
    logger.warn(
      verification.status === PullRequestHeadVerificationStatus.Changed
        ? 'Incremental snapshot was not advanced because the PR head changed'
        : 'Incremental snapshot was not advanced because the current PR head could not be verified',
      verification.error as Error | undefined
    );
    return false;
  }

  /**
   * Cleanup resources after review to prevent memory leaks in long-running processes
   */
  async dispose(): Promise<void> {
    // Clear cost tracker accumulated data
    this.components.costTracker.reset();

    // Clear any cached data that might hold large objects
    // Note: Cache storage is file-based, so no in-memory cleanup needed
    // For in-memory caches, would call cache.clear() here

    logger.debug('Orchestrator resources disposed');
  }

  private async planIncrementalReview(
    pr: PRContext
  ): Promise<IncrementalReviewPlan> {
    const reviewer = this.components
      .incrementalReviewer as IncrementalReviewer & {
      planReview?: (context: PRContext) => Promise<IncrementalReviewPlan>;
    };
    if (typeof reviewer.planReview === 'function') {
      return reviewer.planReview(pr);
    }

    const useIncremental = await reviewer.shouldUseIncremental(pr);
    if (!useIncremental) {
      return {
        mode: IncrementalReviewPlanMode.Full,
        files: [...pr.files],
        invalidatedPaths: [],
        lastReview: null,
      };
    }
    const lastReview = await reviewer.getLastReview(pr.number);
    if (!lastReview) {
      return {
        mode: IncrementalReviewPlanMode.Full,
        files: [...pr.files],
        invalidatedPaths: [],
        lastReview: null,
      };
    }
    const changeSet = await reviewer.getIncrementalChangeSet(
      pr,
      lastReview.lastReviewedCommit
    );
    if (!changeSet.canReusePreviousFindings) {
      return {
        mode: IncrementalReviewPlanMode.Full,
        files: [...changeSet.files],
        invalidatedPaths: [],
        lastReview: null,
      };
    }
    return {
      mode: IncrementalReviewPlanMode.Delta,
      files: [...changeSet.files],
      invalidatedPaths: [...changeSet.invalidatedPaths],
      lastReview,
    };
  }

  private async prepareCodeGraph(input: {
    readonly prNumber: number;
    readonly headSha: string;
    readonly reviewFiles: FileChange[];
    readonly filesToReview: FileChange[];
    readonly previousHeadSha?: string;
    readonly useIncremental: boolean;
    readonly progressTracker?: ProgressTracker;
  }): Promise<{
    readonly codeGraph?: CodeGraph;
    readonly contextRetriever: ContextRetriever;
  }> {
    const { config, graphBuilder, contextRetriever } = this.components;
    if (!config.graphEnabled || !graphBuilder) {
      return { contextRetriever };
    }
    if (input.filesToReview.length === 0) {
      await input.progressTracker?.updateProgress(
        'graph',
        'completed',
        'No changed files require graph analysis'
      );
      return { contextRetriever };
    }

    try {
      const startedAt = Date.now();
      let codeGraph = this.graphCache
        ? await this.graphCache.get(input.prNumber, input.headSha)
        : null;
      let cacheCurrentGraph = false;
      let source = 'current cache';

      if (
        !codeGraph &&
        input.useIncremental &&
        input.previousHeadSha &&
        this.graphCache
      ) {
        const previousGraph = await this.graphCache.get(
          input.prNumber,
          input.previousHeadSha
        );
        if (previousGraph) {
          codeGraph = await graphBuilder.updateGraph(
            previousGraph,
            input.filesToReview
          );
          cacheCurrentGraph = true;
          source = 'incremental cache update';
        }
      }

      if (!codeGraph) {
        codeGraph = await graphBuilder.buildGraph(input.reviewFiles);
        cacheCurrentGraph = true;
        source = 'full build';
      }
      if (cacheCurrentGraph && this.graphCache) {
        await this.graphCache.set(input.prNumber, input.headSha, codeGraph);
      }

      const durationMs = Date.now() - startedAt;
      logger.info(`Prepared code graph from ${source} (${durationMs}ms)`);
      await input.progressTracker?.updateProgress(
        'graph',
        'completed',
        `${source} in ${durationMs}ms`
      );
      return {
        codeGraph,
        contextRetriever: new ContextRetriever(codeGraph),
      };
    } catch (error) {
      logger.warn(
        'Failed to prepare code graph, falling back to regex-based context',
        error as Error
      );
      await input.progressTracker?.updateProgress(
        'graph',
        'failed',
        'Graph preparation failed, using regex context'
      );
      return { contextRetriever };
    }
  }

  private prepareLifecycleTargets(
    candidates: LifecycleTarget[],
    reviewCommentState: ReviewCommentState,
    maxTargets: number
  ): {
    targets: LifecycleTarget[];
    skipped: LifecycleThreadRecord[];
  } {
    const active: LifecycleTarget[] = [];
    const skipped: LifecycleThreadRecord[] = [];
    const cap = Math.min(25, Math.max(0, maxTargets));

    for (const target of candidates) {
      if (this.isLifecycleTargetCommandDismissed(target, reviewCommentState)) {
        skipped.push(this.lifecycleRecord(target, ['command_dismissed']));
        continue;
      }
      active.push(target);
    }

    const prioritized = [...active].sort((left, right) => {
      const severityDelta =
        this.lifecycleSeverityPriority(right.severity) -
        this.lifecycleSeverityPriority(left.severity);
      if (severityDelta !== 0) return severityDelta;
      return (
        (Date.parse(left.parentCommentUpdatedAt || '') || 0) -
        (Date.parse(right.parentCommentUpdatedAt || '') || 0)
      );
    });

    const targets = prioritized.slice(0, cap);
    for (const target of prioritized.slice(cap)) {
      skipped.push(this.lifecycleRecord(target, ['target_cap_exceeded']));
    }

    return { targets, skipped };
  }

  private filterCommandDismissedLifecycleTargets(
    targets: LifecycleTarget[],
    reviewCommentState: ReviewCommentState,
    skipped: LifecycleThreadRecord[]
  ): LifecycleTarget[] {
    const active: LifecycleTarget[] = [];
    const alreadySkipped = new Set(
      skipped.map((record) => record.target.targetId)
    );

    for (const target of targets) {
      if (this.isLifecycleTargetCommandDismissed(target, reviewCommentState)) {
        if (!alreadySkipped.has(target.targetId)) {
          skipped.push(this.lifecycleRecord(target, ['command_dismissed']));
          alreadySkipped.add(target.targetId);
        }
        continue;
      }
      active.push(target);
    }

    return active;
  }

  private filterCommandDismissedLifecycleRecords(
    records: LifecycleThreadRecord[],
    reviewCommentState: ReviewCommentState,
    skipped: LifecycleThreadRecord[]
  ): LifecycleThreadRecord[] {
    const active: LifecycleThreadRecord[] = [];
    const alreadySkipped = new Set(
      skipped.map((record) => record.target.targetId)
    );

    for (const record of records) {
      if (
        this.isLifecycleTargetCommandDismissed(
          record.target,
          reviewCommentState
        )
      ) {
        if (!alreadySkipped.has(record.target.targetId)) {
          skipped.push(
            this.lifecycleRecord(record.target, [
              ...record.reasonCodes,
              'command_dismissed',
            ] as LifecycleReasonCode[])
          );
          alreadySkipped.add(record.target.targetId);
        }
        continue;
      }
      active.push(record);
    }

    return active;
  }

  private isLifecycleTargetCommandDismissed(
    target: LifecycleTarget,
    reviewCommentState: ReviewCommentState
  ): boolean {
    if (reviewCommentState.commandDismissed?.has(target.fingerprint)) {
      return true;
    }
    const path = target.currentPath || target.originalPath;
    const line = target.currentLine ?? target.originalLine;
    if (
      path &&
      line != null &&
      reviewCommentState.commandDismissedLocations?.has(
        `${path.toLowerCase()}:${line}`
      )
    ) {
      return true;
    }
    const severity =
      target.severity === 'critical' ||
      target.severity === 'major' ||
      target.severity === 'minor'
        ? target.severity
        : 'minor';
    return this.components.feedbackFilter.isInlineCommandDismissed(
      {
        path,
        line: line ?? 0,
        side: 'RIGHT',
        body: target.message,
        severity,
        title: target.title,
      },
      reviewCommentState
    );
  }

  private applyGraphQLDedupeState(
    reviewCommentState: ReviewCommentState,
    dedupeComments: InlineCommentReference[]
  ): void {
    reviewCommentState.alreadyPosted = new Set<string>();
    reviewCommentState.alreadyPostedComments = [...dedupeComments];

    for (const comment of dedupeComments) {
      const body = comment.body || '';
      reviewCommentState.alreadyPosted.add(
        signatureFromInlineComment(comment.path, comment.line, body)
      );
      reviewCommentState.alreadyPosted.add(
        fingerprintFromInlineComment(comment.path, comment.line, body)
      );
      const marker = extractInlineFingerprint(body);
      if (marker) reviewCommentState.alreadyPosted.add(marker);
    }
  }

  private removeResolvedLifecycleDedupeRefs(
    dedupeComments: InlineCommentReference[],
    resolvedRecords: LifecycleThreadRecord[]
  ): InlineCommentReference[] {
    const resolvedFingerprints = new Set(
      resolvedRecords.map((record) => record.target.fingerprint)
    );
    if (resolvedFingerprints.size === 0) return dedupeComments;

    return dedupeComments.filter((comment) => {
      const marker = extractFindingFingerprint(comment.body || '');
      return !marker || !resolvedFingerprints.has(marker);
    });
  }

  private lifecycleTargetsForBatch(
    targets: LifecycleTarget[],
    batch: FileChange[]
  ): LifecycleTarget[] {
    return targets.filter((target) =>
      batch.some((file) => this.lifecycleTargetMatchesFile(target, file))
    );
  }

  private buildLifecycleAssignmentRecords(
    targets: LifecycleTarget[],
    targetsByBatch: LifecycleTarget[][],
    providerIds: string[]
  ): LifecycleAssignmentRecord[] {
    return targets.map((target) => {
      const assignedBatchIds = targetsByBatch
        .map((batchTargets, index) =>
          batchTargets.some((item) => item.targetId === target.targetId)
            ? `batch-${index + 1}`
            : ''
        )
        .filter(Boolean);
      const inScope = assignedBatchIds.length > 0;

      return {
        targetId: target.targetId,
        fingerprint: target.fingerprint,
        assignedProviderIds: inScope ? providerIds : [],
        assignedBatchIds,
        failedProviderIds: [],
        unassignedProviderIds: inScope
          ? []
          : providerIds.map((providerId) => ({
              providerId,
              reason: 'outside_review_scope' as LifecycleReasonCode,
            })),
        scopeStatus: inScope ? 'in_scope' : 'out_of_scope',
      };
    });
  }

  private recordLifecycleBatchProviderFailures(
    targets: LifecycleTarget[],
    results: ProviderResult[],
    failuresByTarget: Map<string, Set<string>>
  ): void {
    if (targets.length === 0) return;
    const failedProviderIds = results
      .filter((result) => result.status !== 'success')
      .map((result) => result.name);
    if (failedProviderIds.length === 0) return;

    for (const target of targets) {
      let failures = failuresByTarget.get(target.targetId);
      if (!failures) {
        failures = new Set<string>();
        failuresByTarget.set(target.targetId, failures);
      }
      failedProviderIds.forEach((providerId) => failures!.add(providerId));
    }
  }

  private applyLifecycleBatchProviderFailures(
    records: LifecycleAssignmentRecord[],
    failuresByTarget: Map<string, Set<string>>
  ): void {
    for (const record of records) {
      const failures = failuresByTarget.get(record.targetId);
      if (failures && failures.size > 0) {
        record.failedProviderIds = Array.from(failures);
      }
    }
  }

  private applyLifecycleMutationResult(
    lifecycle: ReviewThreadLifecycleResult,
    mutationResult: ReviewThreadResolveResult
  ): void {
    const handled = new Set<string>();
    const mark = (records: LifecycleThreadRecord[]) => {
      records.forEach((record) => handled.add(record.target.targetId));
    };

    lifecycle.resolvedByLifecycle.push(...mutationResult.resolved);
    lifecycle.manualAttention.push(...mutationResult.manualAttention);
    lifecycle.mutationSkipped.push(...mutationResult.skipped);
    lifecycle.mutationFailed.push(...mutationResult.failed);
    lifecycle.warnings.push(...mutationResult.warnings);

    mark(mutationResult.resolved);
    mark(mutationResult.manualAttention);
    mark(mutationResult.skipped);
    mark(mutationResult.failed);
    lifecycle.resolvedCandidates = lifecycle.resolvedCandidates.filter(
      (record) => !handled.has(record.target.targetId)
    );
  }

  private async buildUnreviewedLifecycleForSkippedReview(
    pr: PRContext,
    configuredLifecycleMode: ReviewThreadLifecycleMode,
    reason: string,
    currentFindings: Finding[] = [],
    loadedReviewCommentState?: ReviewCommentState
  ): Promise<ReviewThreadLifecycleResult | undefined> {
    const lifecycleMode: ReviewThreadLifecycleMode =
      this.components.reviewThreadInventory && this.components.githubClient
        ? configuredLifecycleMode
        : 'off';
    if (lifecycleMode === 'off' || !this.components.reviewThreadInventory) {
      return undefined;
    }

    let reviewCommentState = loadedReviewCommentState;
    if (!reviewCommentState) {
      try {
        reviewCommentState =
          await this.components.feedbackFilter.loadReviewCommentState(
            pr.number,
            pr.headSha
          );
      } catch (error) {
        logger.warn(
          'Failed to load review comment state for skipped review lifecycle',
          error as Error
        );
        reviewCommentState = {
          suppressed: new Set(),
          alreadyPosted: new Set(),
          suppressedComments: [],
          alreadyPostedComments: [],
        };
      }
    }

    const inventory = await this.components.reviewThreadInventory.load(
      pr.number
    );
    const warnings = [
      ...inventory.warnings,
      `${reason}; old unresolved ReviewRouter threads were not revalidated`,
    ];

    if (inventory.failed) {
      warnings.push(
        'review thread lifecycle inventory was incomplete; no old thread was revalidated or auto-resolved'
      );
      return new ThreadLifecycleAggregator().aggregate({
        mode: lifecycleMode,
        targets: [],
        plannedProviders: [],
        providerResults: [],
        currentFindings,
        initialManualAttention: [],
        skipped: [],
        warnings,
        inventoryFailed: true,
        config: this.components.config,
      });
    }

    const prepared = this.prepareLifecycleTargets(
      inventory.candidates,
      reviewCommentState,
      this.components.config.reviewThreadLifecycleMaxTargets ?? 10
    );
    let targets = prepared.targets;
    const skipped = prepared.skipped;

    if (inventory.headRefOid && inventory.headRefOid !== pr.headSha) {
      warnings.push(
        'review thread lifecycle inventory head SHA did not match loaded PR head SHA'
      );
      skipped.push(
        ...targets.map((target) => ({
          target,
          reasonCodes: ['head_sha_changed' as LifecycleReasonCode],
        }))
      );
      targets = [];
    }

    const manualAttention = this.filterCommandDismissedLifecycleRecords(
      inventory.manualAttention,
      reviewCommentState,
      skipped
    );
    targets = this.filterCommandDismissedLifecycleTargets(
      targets,
      reviewCommentState,
      skipped
    );

    return new ThreadLifecycleAggregator().aggregate({
      mode: lifecycleMode,
      targets,
      plannedProviders: [],
      providerResults: [],
      currentFindings,
      initialManualAttention: manualAttention,
      skipped,
      warnings,
      config: this.components.config,
    });
  }

  private async projectCurrentStateOntoReusedReview(
    pr: PRContext,
    review: Review,
    configuredLifecycleMode: ReviewThreadLifecycleMode
  ): Promise<void> {
    const reviewCommentState =
      await this.components.feedbackFilter.loadReviewCommentState(
        pr.number,
        pr.headSha
      );
    const dismissedCount = this.applyCommandDismissals(
      review,
      reviewCommentState
    );
    if (dismissedCount > 0) {
      logger.info(
        `Applied ${dismissedCount} current /rr skip dismissal(s) to the completed snapshot projection`
      );
    }
    review.findingProvenance = {
      fromCurrentReview: emptyFindingCounts(),
      carriedForward: countFindingsBySeverity(review.findings),
    };
    review.threadLifecycle =
      await this.buildUnreviewedLifecycleForSkippedReview(
        pr,
        configuredLifecycleMode,
        'completed snapshot replayed without provider lifecycle revalidation',
        review.findings,
        reviewCommentState
      );
    if (review.threadLifecycle) {
      const reconciled = reconcileCarriedFindingsWithLifecycle({
        mergedFindings: review.findings,
        carriedFindings: review.findings,
        lifecycle: review.threadLifecycle,
      });
      if (reconciled.removed.length > 0) {
        review.findings = reconciled.findings;
        this.refreshFindingDerivedState(review);
        review.findingProvenance = {
          fromCurrentReview: emptyFindingCounts(),
          carriedForward: countFindingsBySeverity(review.findings),
        };
        logger.info(
          `Removed ${reconciled.removed.length} carried-forward finding(s) from the completed snapshot after trusted lifecycle resolution`
        );
      }
    }
  }

  private failUnconfirmedLifecycleCandidates(
    lifecycle: ReviewThreadLifecycleResult
  ): void {
    if (lifecycle.resolvedCandidates.length === 0) return;

    lifecycle.mutationFailed.push(
      ...lifecycle.resolvedCandidates.map((record) => ({
        ...record,
        reasonCodes: Array.from(
          new Set([
            ...record.reasonCodes,
            'mutation_failed' as LifecycleReasonCode,
          ])
        ) as LifecycleReasonCode[],
        errorMessage:
          'Lifecycle resolver did not confirm a terminal GitHub thread result.',
      }))
    );
    lifecycle.resolvedCandidates = [];
    lifecycle.warnings.push(
      'review thread lifecycle had unconfirmed resolved candidates; no unconfirmed thread was reported as resolved'
    );
  }

  private lifecycleTargetMatchesFile(
    target: LifecycleTarget,
    file: FileChange
  ): boolean {
    const targetPaths = new Set(
      [target.currentPath, target.originalPath]
        .filter(Boolean)
        .map((value) => value!.toLowerCase())
    );
    return (
      targetPaths.has(file.filename.toLowerCase()) ||
      (file.previousFilename
        ? targetPaths.has(file.previousFilename.toLowerCase())
        : false)
    );
  }

  private lifecycleSeverityPriority(
    severity: LifecycleTarget['severity']
  ): number {
    switch (severity) {
      case 'critical':
        return 3;
      case 'major':
        return 2;
      case 'minor':
        return 1;
      default:
        return 0;
    }
  }

  private lifecycleRecord(
    target: LifecycleTarget,
    reasonCodes: LifecycleReasonCode[]
  ): LifecycleThreadRecord {
    return {
      target,
      reasonCodes: Array.from(
        new Set([...(target.reasonCodes ?? []), ...reasonCodes])
      ) as LifecycleReasonCode[],
    };
  }

  /**
   * Detect and record suggestion acceptances from PR activity.
   *
   * Checks for:
   * 1. Committed suggestions (via GitHub's "Commit suggestion" button)
   * 2. Thumbs-up reactions on suggestion comments
   *
   * Records acceptances as positive feedback to improve provider weights.
   */
  private async detectAndRecordAcceptances(prNumber: number): Promise<void> {
    const { githubClient, acceptanceDetector, providerWeightTracker } =
      this.components;
    if (!githubClient || !acceptanceDetector || !providerWeightTracker) return;

    const { octokit, owner, repo } = githubClient;

    // 1. Fetch PR commits
    const commitsResponse = await octokit.rest.pulls.listCommits({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });

    const commits = commitsResponse.data.map((commit) => ({
      sha: commit.sha,
      message: commit.commit.message,
      files: (commit.files || []).map((f) => f.filename),
      timestamp: new Date(commit.commit.author?.date || Date.now()).getTime(),
    }));

    // 2. Fetch review comments
    const comments = await octokit.paginate(
      octokit.rest.pulls.listReviewComments,
      {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      }
    );

    // 3. Build file/line/provider map and fetch reactions
    const commentedFiles = new Map<
      string,
      Array<{ line: number; provider?: string }>
    >();
    const commentReactions: Array<{
      commentId: number;
      file: string;
      line: number;
      provider?: string;
      reactions: Array<{ user: string; content: string }>;
    }> = [];

    for (const comment of comments) {
      const file = comment.path;
      const line = comment.line || comment.original_line || 0;

      // Extract provider from comment body (embedded by CommentPoster)
      const providerMatch = comment.body?.match(/\*\*Provider:\*\* `([^`]+)`/);
      const provider = providerMatch?.[1];

      // Build file map for commit detection
      if (!commentedFiles.has(file)) {
        commentedFiles.set(file, []);
      }
      commentedFiles.get(file)!.push({ line, provider });

      // Fetch reactions for this comment
      const reactions =
        await octokit.rest.reactions.listForPullRequestReviewComment({
          owner,
          repo,
          comment_id: comment.id,
        });

      commentReactions.push({
        commentId: comment.id,
        file,
        line,
        provider,
        reactions: reactions.data.map((r) => ({
          user: r.user?.login || 'unknown',
          content: r.content,
        })),
      });
    }

    // 4. Detect acceptances from both sources
    const commitAcceptances = acceptanceDetector.detectFromCommits(
      commits,
      commentedFiles
    );
    const reactionAcceptances =
      acceptanceDetector.detectFromReactions(commentReactions);

    // 5. Record all acceptances to weight tracker
    const allAcceptances = [...commitAcceptances, ...reactionAcceptances];
    await acceptanceDetector.recordAcceptances(
      allAcceptances,
      providerWeightTracker
    );

    if (allAcceptances.length > 0) {
      logger.info(
        `Acceptance detection: ${commitAcceptances.length} from commits, ` +
          `${reactionAcceptances.length} from reactions, ${allAcceptances.length} total`
      );
    } else {
      logger.debug('No suggestion acceptances detected');
    }
  }

  private async updatePullRequestDescription(pr: PRContext): Promise<void> {
    if (
      !this.components.config.updatePrDescription ||
      !this.components.prDescriptionUpdater
    ) {
      return;
    }

    try {
      await this.components.prDescriptionUpdater.update(pr);
    } catch (error) {
      logger.warn('Failed to update PR description summary', error as Error);
    }
  }

  private formatProviderFailureSummary(results: ProviderResult[]): string {
    const failures = results
      .filter((result) => result.status !== 'success')
      .map((result) => {
        const reason = result.error?.message || result.status;
        return `${result.name}: ${this.redactProviderFailureReason(reason)}`;
      });

    if (failures.length === 0) {
      return 'No provider error details were reported.';
    }

    const summary = failures.join('; ');
    return summary.length > 1000 ? `${summary.slice(0, 1000)}...` : summary;
  }

  private requiredHealthyProviderNames(config: ReviewConfig): Set<string> {
    return new Set(
      (config.requiredHealthyProviders || [])
        .map((name) => name.trim())
        .filter(Boolean)
    );
  }

  private assertRequiredProvidersAvailable(
    requiredProviders: Set<string>,
    providers: Provider[],
    stage: string
  ): void {
    if (requiredProviders.size === 0) return;

    const available = new Set(providers.map((provider) => provider.name));
    for (const required of requiredProviders) {
      if (!available.has(required)) {
        throw new Error(
          `Required healthy provider ${required} was not available during ${stage}.`
        );
      }
    }
  }

  private assertRequiredProvidersHealthy(
    requiredProviders: Set<string>,
    healthy: Provider[],
    healthResults: ProviderResult[]
  ): void {
    if (requiredProviders.size === 0) return;

    const healthyNames = new Set(healthy.map((provider) => provider.name));
    const healthByName = new Map(
      healthResults.map((result) => [result.name, result])
    );

    for (const required of requiredProviders) {
      if (healthyNames.has(required)) continue;

      const result = healthByName.get(required);
      const reason = this.redactProviderFailureReason(
        result?.error?.message ||
          result?.status ||
          'provider did not pass health check'
      );
      throw new Error(
        `Required healthy provider ${required} failed health check: ${reason}`
      );
    }
  }

  private findRequiredProviderExecutionFailure(
    requiredProviders: Set<string>,
    results: ProviderResult[]
  ): Error | undefined {
    if (requiredProviders.size === 0) return undefined;

    const resultByName = new Map(
      results.map((result) => [result.name, result])
    );
    for (const required of requiredProviders) {
      const result = resultByName.get(required);
      if (!result) {
        return new Error(
          `Required healthy provider ${required} did not return a result.`
        );
      }
      if (result.status !== 'success') {
        const reason = this.redactProviderFailureReason(
          result.error?.message || result.status
        );
        return new Error(
          `Required healthy provider ${required} failed during review: ${reason}`
        );
      }
      if (!result.result) {
        return new Error(
          `Required healthy provider ${required} did not return a review result.`
        );
      }
    }

    return undefined;
  }

  private hasCompleteProviderCheckpointCoverage(
    plannedProviders: readonly Provider[],
    results: readonly ProviderResult[]
  ): boolean {
    if (results.length !== plannedProviders.length) return false;
    const resultByName = new Map(
      results.map((result) => [result.name, result] as const)
    );
    if (resultByName.size !== results.length) return false;

    return plannedProviders.every((provider) => {
      const result = resultByName.get(provider.name);
      return result?.status === 'success' && result.result !== undefined;
    });
  }

  private selectExecutionProviders(
    providers: Provider[],
    requiredProviders: Set<string>,
    limit: number
  ): Provider[] {
    if (requiredProviders.size === 0 || providers.length <= limit) {
      return providers.slice(0, limit);
    }

    const required = providers.filter((provider) =>
      requiredProviders.has(provider.name)
    );
    const requiredNames = new Set(required.map((provider) => provider.name));
    const optional = providers.filter(
      (provider) => !requiredNames.has(provider.name)
    );
    const effectiveLimit = Math.max(limit, required.length);
    return [...required, ...optional].slice(0, effectiveLimit);
  }

  private redactProviderFailureReason(reason: string): string {
    return sanitizeErrorMessage(reason);
  }

  /**
   * Run all static analysis operations in parallel
   */
  private async runStaticAnalysis(
    files: FileChange[],
    contextRetriever: ContextRetriever
  ): Promise<{
    astFindings: Finding[];
    ruleFindings: Finding[];
    securityFindings: Finding[];
    context: UnchangedContext[];
  }> {
    const { config } = this.components;

    // Run all static analysis operations in parallel
    const [astFindings, ruleFindings, securityFindings, context] =
      await Promise.all([
        config.enableAstAnalysis
          ? this.components.astAnalyzer.analyze(files)
          : Promise.resolve([]),

        this.components.rules.run(files),

        config.enableSecurity
          ? this.components.security.scan(files)
          : Promise.resolve([]),

        contextRetriever.findRelatedContext(files),
      ]);

    logger.info(
      `Static analysis complete: ${astFindings.length} AST, ` +
        `${ruleFindings.length} rules, ${securityFindings.length} security, ` +
        `${context.length} context items`
    );

    return {
      astFindings,
      ruleFindings,
      securityFindings,
      context,
    };
  }

  private shouldSkip(pr: PRContext): string | null {
    const { config } = this.components;

    if (config.skipDrafts && pr.draft) return 'PR is a draft';
    if (config.skipBots && this.isBot(pr.author))
      return `Author ${pr.author} is a bot`;

    if (config.skipLabels.length > 0) {
      for (const label of pr.labels) {
        if (config.skipLabels.includes(label)) {
          return `Label ${label} triggers skip`;
        }
      }
    }

    const totalLines = pr.additions + pr.deletions;
    if (config.minChangedLines > 0 && totalLines < config.minChangedLines) {
      return `Change size ${totalLines} below minimum ${config.minChangedLines}`;
    }
    if (
      config.maxChangedFiles > 0 &&
      pr.files.length > config.maxChangedFiles
    ) {
      return `File count ${pr.files.length} exceeds max ${config.maxChangedFiles}`;
    }
    return null;
  }

  private isBot(author: string): boolean {
    const lower = author.toLowerCase();
    return ['bot', 'dependabot', 'renovate', 'github-actions', '[bot]'].some(
      (p) => lower.includes(p)
    );
  }

  private async applyReliabilityFilters(
    providers: Provider[]
  ): Promise<Provider[]> {
    const tracker = this.components.reliabilityTracker;
    if (!tracker || providers.length === 0) return providers;

    const available: Provider[] = [];
    for (const provider of providers) {
      const open = await tracker.isCircuitOpen(provider.name);
      if (open) {
        logger.warn(`Skipping provider ${provider.name} (circuit open)`);
        continue;
      }
      available.push(provider);
    }

    if (available.length === 0) {
      logger.warn(
        'All providers are currently tripped by circuit breakers; skipping review run'
      );
      return [];
    }

    const rankings = await tracker.rankProviders(available.map((p) => p.name));
    const scoreMap = new Map(rankings.map((r) => [r.providerId, r.score]));
    return [...available].sort(
      (a, b) => (scoreMap.get(b.name) ?? 0.5) - (scoreMap.get(a.name) ?? 0.5)
    );
  }

  private async recordReliability(results: ProviderResult[]): Promise<void> {
    if (!this.components.reliabilityTracker) return;
    for (const result of results) {
      await this.components.reliabilityTracker.recordResult(
        result.name,
        result.status === 'success',
        Number.isFinite(result.durationSeconds)
          ? Math.max(0, result.durationSeconds * 1000)
          : undefined,
        result.error?.message
      );
    }
  }

  private async initProgressTracker(
    pr: PRContext,
    summaryMetadata: ReviewSummaryMetadata
  ): Promise<ProgressTracker | undefined> {
    if (!this.components.githubClient || this.components.config.dryRun)
      return undefined;

    try {
      const mode = this.progressCommentMode();
      if (mode === 'never') return undefined;
      if (
        mode === 'first' &&
        (await this.hasExistingReviewRouterActivity(pr.number))
      ) {
        logger.info(
          'Skipping ReviewRouter progress comment because this PR already has ReviewRouter activity'
        );
        return undefined;
      }

      const tracker = new ProgressTracker(
        this.components.githubClient.octokit,
        {
          owner: this.components.githubClient.owner,
          repo: this.components.githubClient.repo,
          prNumber: pr.number,
          updateStrategy: 'milestone',
          summaryMetadata,
        }
      );
      await tracker.initialize();
      return tracker;
    } catch (error) {
      logger.warn('Failed to initialize progress tracker', error as Error);
      return undefined;
    }
  }

  private progressCommentMode(): 'always' | 'first' | 'never' {
    const raw =
      process.env.REVIEW_ROUTER_PROGRESS_COMMENTS?.trim().toLowerCase();
    if (!raw) return 'first';
    if (['1', 'true', 'yes', 'on', 'always'].includes(raw)) return 'always';
    if (['0', 'false', 'no', 'off', 'never'].includes(raw)) return 'never';
    if (
      [
        'first',
        'first-review',
        'first_review',
        'auto',
        'auto-first',
        'auto_first',
      ].includes(raw)
    ) {
      return 'first';
    }

    logger.warn(
      `Ignoring REVIEW_ROUTER_PROGRESS_COMMENTS=${raw}; expected true, false, or first`
    );
    return 'first';
  }

  private markReviewRouterSummary(markdown: string): string {
    return markdown.includes('<!-- review-router-bot -->')
      ? markdown
      : `<!-- review-router-bot -->\n\n${markdown}`;
  }

  private async hasExistingReviewRouterActivity(
    prNumber: number
  ): Promise<boolean> {
    const client = this.components.githubClient;
    if (!client) return true;

    try {
      const { octokit, owner, repo } = client;
      const issueComments = await this.paginateGitHub<{
        body?: string | null;
      }>(octokit, octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: prNumber,
        per_page: 100,
      });
      if (
        issueComments.some(
          (comment) =>
            this.isReviewRouterIssueComment(comment.body) &&
            !this.isReviewRouterProgressIssueComment(comment.body)
        )
      ) {
        return true;
      }

      const reviewComments = await this.paginateGitHub<{
        body?: string | null;
      }>(octokit, octokit.rest.pulls.listReviewComments, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });
      return reviewComments.some((comment) =>
        this.isReviewRouterReviewComment(comment.body)
      );
    } catch (error) {
      logger.warn(
        'Failed to detect existing ReviewRouter activity; skipping first-review progress comment',
        error as Error
      );
      return true;
    }
  }

  private async paginateGitHub<T>(
    octokit: {
      paginate?: (
        method: unknown,
        params: Record<string, unknown>
      ) => Promise<T[]>;
    },
    method: unknown,
    params: Record<string, unknown>
  ): Promise<T[]> {
    if (typeof octokit.paginate === 'function') {
      return octokit.paginate(method, params);
    }

    const response = await (
      method as (input: Record<string, unknown>) => Promise<{ data: T[] }>
    )(params);
    return response.data;
  }

  private isReviewRouterIssueComment(body?: string | null): boolean {
    if (!body) return false;
    return (
      body.includes('<!-- review-router-bot -->') ||
      body.includes('<!-- review-router-progress-tracker -->') ||
      body.includes('<!-- review-router-inline-fallback -->') ||
      body.includes('<!-- ai-robot-review-bot -->') ||
      body.includes('<!-- ai-robot-review-progress-tracker -->') ||
      body.includes('<!-- multi-provider-code-review-bot -->') ||
      body.startsWith('## 🤖 ReviewRouter Progress') ||
      body.startsWith('## 🤖 AI Robot Review Progress') ||
      body.startsWith('# ReviewRouter') ||
      body.startsWith('# AI Robot Review')
    );
  }

  private isReviewRouterProgressIssueComment(body?: string | null): boolean {
    if (!body) return false;
    return (
      body.includes('<!-- review-router-progress-tracker -->') ||
      body.includes('<!-- ai-robot-review-progress-tracker -->') ||
      body.startsWith('## 🤖 ReviewRouter Progress') ||
      body.startsWith('## 🤖 AI Robot Review Progress')
    );
  }

  private isReviewRouterReviewComment(body?: string | null): boolean {
    if (!body) return false;
    return (
      body.includes('<!-- review-router-inline:') ||
      body.includes('<!-- review-router-skip-help -->') ||
      body.includes('<!-- ai-robot-review-inline:')
    );
  }

  private shouldPostReviewOutput(
    review: Review,
    inlineComments: InlineComment[]
  ): boolean {
    if (
      review.findings.length > 0 ||
      inlineComments.length > 0 ||
      review.actionItems.length > 0 ||
      review.coverage?.complete === false ||
      (review.coverage?.limitations?.length ?? 0) > 0
    ) {
      return true;
    }

    const lifecycle = review.threadLifecycle;
    if (!lifecycle) return false;

    return (
      lifecycle.inventoryFailed === true ||
      lifecycle.previousStillValid.some(
        (record) => !isLinkedCurrentFinding(record)
      ) ||
      lifecycle.previousUncertain.length > 0 ||
      lifecycle.manualAttention.length > 0 ||
      lifecycle.mutationSkipped.length > 0 ||
      lifecycle.mutationFailed.length > 0 ||
      lifecycle.skipped.length > 0 ||
      lifecycle.warnings.length > 0
    );
  }

  private async ensureBudget(config: ReviewConfig): Promise<void> {
    if (config.budgetMaxUsd <= 0) return;

    // Pre-flight guardrail: refuse to run when no budget remains based on cached totals
    const projected = this.components.costTracker.summary().totalCost;
    if (projected >= config.budgetMaxUsd) {
      throw new Error(
        `Budget exhausted: current recorded cost $${projected.toFixed(4)} exceeds or equals cap $${config.budgetMaxUsd.toFixed(2)}`
      );
    }
  }

  private estimateTokens(text: string): number {
    return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
  }

  /**
   * Sanitize filename to prevent path traversal attacks
   * Removes directory separators, path traversal sequences, and absolute paths
   */
  private restoreCheckpointProviderResults(
    payload: ReviewCheckpointBatchPayload
  ): ProviderResult[] {
    const providerNames = new Set(
      payload.providerResults.map((result) => result.name)
    );
    const unattributedFindings = payload.findings.filter(
      (finding) =>
        !(
          (finding.provider && providerNames.has(finding.provider)) ||
          finding.providers?.some((provider) => providerNames.has(provider))
        )
    );
    let unattributedAssigned = false;

    return payload.providerResults.map((providerResult) => {
      const status = this.restoreCheckpointProviderStatus(
        providerResult.status
      );
      const attributedFindings = payload.findings.filter(
        (finding) =>
          finding.provider === providerResult.name ||
          finding.providers?.includes(providerResult.name)
      );
      const includeUnattributed = status === 'success' && !unattributedAssigned;
      if (includeUnattributed) unattributedAssigned = true;
      const findings = [
        ...attributedFindings,
        ...(includeUnattributed ? unattributedFindings : []),
      ].map((finding) => ({ ...finding }) as Finding);
      const revalidations = (providerResult.lifecycleRevalidations ?? []).map(
        (revalidation) => ({ ...revalidation }) as ProviderLifecycleRevalidation
      );

      return {
        name: providerResult.name,
        status,
        durationSeconds: providerResult.durationMs / 1000,
        lifecycleAssignedTargetIds: [
          ...(providerResult.lifecycleAssignedTargetIds ?? []),
        ],
        ...(status === 'success'
          ? {
              result: {
                content: '',
                findings,
                revalidations,
                durationSeconds: providerResult.durationMs / 1000,
                actualModel: providerResult.actualModel,
                aiLikelihood: providerResult.aiLikelihood,
                usage: providerResult.usage,
              },
            }
          : {
              error: new Error(
                providerResult.errorMessage ??
                  'Provider did not complete the checkpointed batch'
              ),
            }),
      };
    });
  }

  private restoreCheckpointProviderStatus(
    status: ReviewCheckpointProviderStatus
  ): ProviderResult['status'] {
    switch (status) {
      case ReviewCheckpointProviderStatus.Success:
        return 'success';
      case ReviewCheckpointProviderStatus.Timeout:
        return 'timeout';
      case ReviewCheckpointProviderStatus.RateLimited:
        return 'rate-limited';
      case ReviewCheckpointProviderStatus.Error:
        return 'error';
    }
  }

  private async recordProviderUsage(
    results: readonly ProviderResult[],
    budgetMaxUsd?: number
  ): Promise<void> {
    for (const result of results) {
      await this.components.costTracker.record(
        result.name,
        result.result?.usage,
        budgetMaxUsd
      );
    }
  }

  private logProviderTokenTelemetry(
    scope: string,
    results: readonly ProviderResult[]
  ): void {
    const providers = results
      .map((result) => ({
        name: result.name,
        status: result.status,
        usage: result.result?.usage,
      }))
      .filter((result) => result.usage);
    this.tokenTelemetryTotals.totalProviderResults += results.length;
    if (providers.length === 0) {
      logger.info('ReviewRouter token telemetry', {
        scope,
        providersWithUsage: 0,
        totalProviders: results.length,
      });
      return;
    }

    const totals = providers.reduce(
      (sum, provider) => ({
        promptTokens: sum.promptTokens + (provider.usage?.promptTokens ?? 0),
        completionTokens:
          sum.completionTokens + (provider.usage?.completionTokens ?? 0),
        totalTokens: sum.totalTokens + (provider.usage?.totalTokens ?? 0),
      }),
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    );
    this.tokenTelemetryTotals.promptTokens += totals.promptTokens;
    this.tokenTelemetryTotals.completionTokens += totals.completionTokens;
    this.tokenTelemetryTotals.totalTokens += totals.totalTokens;
    this.tokenTelemetryTotals.providersWithUsage += providers.length;
    logger.info('ReviewRouter token telemetry', {
      scope,
      ...totals,
      providers: providers.map((provider) => ({
        name: provider.name,
        status: provider.status,
        promptTokens: provider.usage?.promptTokens,
        completionTokens: provider.usage?.completionTokens,
        totalTokens: provider.usage?.totalTokens,
      })),
    });
  }

  private logTotalTokenTelemetry(): void {
    if (this.tokenTelemetryTotals.providersWithUsage === 0) {
      logger.info('ReviewRouter token telemetry total', {
        providersWithUsage: 0,
        totalProviderResults: this.tokenTelemetryTotals.totalProviderResults,
      });
      return;
    }
    logger.info('ReviewRouter token telemetry total', {
      promptTokens: this.tokenTelemetryTotals.promptTokens,
      completionTokens: this.tokenTelemetryTotals.completionTokens,
      totalTokens: this.tokenTelemetryTotals.totalTokens,
      providersWithUsage: this.tokenTelemetryTotals.providersWithUsage,
      totalProviderResults: this.tokenTelemetryTotals.totalProviderResults,
    });
  }

  private sanitizeFilename(filename: string): string {
    // Check for path traversal patterns
    if (
      filename.includes('..') ||
      filename.includes('/') ||
      filename.includes('\\')
    ) {
      logger.warn(`Detected path traversal attempt in filename: ${filename}`);
      // Use only the basename (last component)
      filename = path.basename(filename);
    }

    // Check for absolute paths
    if (path.isAbsolute(filename)) {
      logger.warn(`Detected absolute path in filename: ${filename}`);
      filename = path.basename(filename);
    }

    // Remove all non-alphanumeric characters except dash and underscore
    const sanitized = filename.replace(/[^a-zA-Z0-9_-]/g, '-').substring(0, 50);

    // Ensure we don't end up with an empty string
    return sanitized || 'review-router';
  }

  /**
   * Filter diff to only include files that changed
   * Used for incremental reviews to send only relevant diffs to LLMs
   * Uses indexOf instead of regex to avoid ReDoS and improve memory efficiency
   */
  private enrichFinding(
    finding: Finding,
    files: FileChange[],
    context: UnchangedContext[],
    providerCount: number,
    codeGraph?: CodeGraph
  ): Finding {
    const file = files.find((f) => f.filename === finding.file);
    const correctedLine = chooseBestAddedLineForComment(
      file?.patch,
      finding.line,
      `${finding.title}\n${finding.message}`
    );
    const normalizedFinding =
      correctedLine !== finding.line
        ? { ...finding, line: correctedLine }
        : finding;

    if (correctedLine !== finding.line) {
      logger.debug(
        `Adjusted finding line for ${finding.file}: ${finding.line} -> ${correctedLine}`
      );
    }

    const changedLines = mapAddedLines(file?.patch);
    const hasDirectEvidence = changedLines.some(
      (l) => l.line === normalizedFinding.line
    );
    const astConfirmed = Boolean(
      normalizedFinding.providers?.includes('ast') ||
      normalizedFinding.provider === 'ast'
    );

    // Only claim graph confirmation when an actual code graph was built.
    let graphConfirmed = false;
    if (codeGraph) {
      // Check if the file has dependents (is used elsewhere)
      const dependents = codeGraph.getDependents(finding.file);
      graphConfirmed = dependents.length > 0;
    }

    const relatedSnippets = context
      .filter((ctx) => ctx.file === finding.file)
      .flatMap((ctx) => ctx.affectedCode);

    const evidence = this.components.evidenceScorer.score(
      normalizedFinding,
      providerCount,
      astConfirmed,
      graphConfirmed,
      hasDirectEvidence
    );

    return {
      ...normalizedFinding,
      providerPoolSize: providerCount,
      evidence,
      evidenceDetail: {
        changedLines: changedLines.map((c) => c.line),
        relatedSnippets,
        providerAgreement:
          providerCount > 0 ? getProviderVoteCount(finding) / providerCount : 0,
        astConfirmed,
        graphConfirmed,
      },
    };
  }

  private async applyQuietMode(
    findings: Finding[],
    config: ReviewConfig
  ): Promise<Finding[]> {
    if (!config.quietModeEnabled) return findings;

    // Use quiet mode filter with learning if available
    if (this.components.quietModeFilter) {
      const filtered =
        await this.components.quietModeFilter.filterByConfidence(findings);
      const filterStats =
        await this.components.quietModeFilter.getFilterStats(findings);
      logger.info(
        `Quiet mode: filtered ${filterStats.filtered}/${filterStats.total} findings (${filterStats.filterRate.toFixed(1)}% reduction)`
      );
      return filtered;
    }

    // Fallback to simple threshold filtering
    const threshold = config.quietMinConfidence ?? 0.5;
    return findings.filter((f) => (f.evidence?.confidence ?? 1) >= threshold);
  }

  private applyCommandDismissals(
    review: Review,
    state: ReviewCommentState
  ): number {
    const hasDismissals =
      (state.commandDismissed?.size ?? 0) > 0 ||
      (state.commandDismissedComments?.length ?? 0) > 0;
    if (!hasDismissals) return 0;

    const before = review.findings.length;
    review.findings = review.findings.filter(
      (finding) =>
        !this.components.feedbackFilter.isFindingCommandDismissed(
          finding,
          state
        )
    );
    review.inlineComments = review.inlineComments.filter(
      (comment) =>
        !this.components.feedbackFilter.isInlineCommandDismissed(comment, state)
    );
    this.refreshFindingDerivedState(review);
    review.metrics.dismissedFindings =
      (review.metrics.dismissedFindings ?? 0) +
      (before - review.findings.length);

    return before - review.findings.length;
  }

  private refreshFindingDerivedState(review: Review): void {
    review.actionItems = Array.from(
      new Set(
        review.findings
          .filter((finding) => finding.severity !== 'minor')
          .slice(0, 5)
          .map(
            (finding) => `${finding.file}:${finding.line} - ${finding.title}`
          )
      )
    );
    review.metrics.totalFindings = review.findings.length;
    review.metrics.critical = review.findings.filter(
      (finding) => finding.severity === 'critical'
    ).length;
    review.metrics.major = review.findings.filter(
      (finding) => finding.severity === 'major'
    ).length;
    review.metrics.minor = review.findings.filter(
      (finding) => finding.severity === 'minor'
    ).length;
  }

  /**
   * Create a simple review result for trivial PRs that don't need full analysis
   * Tracks time saved and cost avoided
   */
  private createTrivialReview(
    reason: string,
    fileCount: number,
    startTime: number
  ): Review {
    const durationSeconds = Math.max(0.001, (Date.now() - startTime) / 1000);

    return {
      summary: `This PR contains only trivial changes that don't require detailed review.\n\n**Reason:** ${reason}\n\n**Files changed:** ${fileCount}\n\n**Cost savings:** Skipped LLM analysis, saving estimated $0.01-0.05 in API costs.\n\nThese types of changes are automatically filtered to save review time and API costs. If you believe this should have been reviewed, you can disable trivial change detection in the configuration.`,
      findings: [],
      inlineComments: [],
      actionItems: [],
      metrics: {
        totalFindings: 0,
        critical: 0,
        major: 0,
        minor: 0,
        providersUsed: 0,
        providersSuccess: 0,
        providersFailed: 0,
        totalTokens: 0,
        totalCost: 0,
        durationSeconds,
      },
      runDetails: {
        providers: [],
        totalCost: 0,
        totalTokens: 0,
        durationSeconds,
        cacheHit: false,
        synthesisModel: '',
        providerPoolSize: 0,
      },
    };
  }

  private createReusedReview(
    snapshot: IncrementalCacheData,
    startTime: number
  ): Review {
    const findings = snapshot.findings.map((finding) => ({ ...finding }));
    const durationSeconds = Math.max(0.001, (Date.now() - startTime) / 1000);

    return {
      summary: snapshot.reviewSummary,
      findings,
      inlineComments: [],
      actionItems: [],
      metrics: {
        totalFindings: findings.length,
        critical: findings.filter((finding) => finding.severity === 'critical')
          .length,
        major: findings.filter((finding) => finding.severity === 'major')
          .length,
        minor: findings.filter((finding) => finding.severity === 'minor')
          .length,
        providersUsed: 0,
        providersSuccess: 0,
        providersFailed: 0,
        totalTokens: 0,
        totalCost: 0,
        durationSeconds,
        cached: true,
      },
      runDetails: {
        providers: [],
        totalCost: 0,
        totalTokens: 0,
        durationSeconds,
        cacheHit: true,
        synthesisModel: '',
        providerPoolSize: 0,
      },
      findingProvenance: {
        fromCurrentReview: emptyFindingCounts(),
        carriedForward: countFindingsBySeverity(findings),
      },
    };
  }

  private async writeReports(review: Review): Promise<void> {
    // Sanitize REPORT_BASENAME to prevent path traversal
    const base = this.sanitizeFilename(
      process.env.REPORT_BASENAME || 'review-router'
    );
    const sarifPath = path.join(process.cwd(), `${base}.sarif`);
    const jsonPath = path.join(process.cwd(), `${base}.json`);

    await fs.writeFile(
      sarifPath,
      JSON.stringify(buildSarif(review.findings), null, 2),
      'utf8'
    );
    await fs.writeFile(jsonPath, buildJson(review), 'utf8');
    logger.info(`Wrote reports: ${sarifPath}, ${jsonPath}`);
  }
}

function buildIncrementalFindingProvenance(
  fromCurrentReview: readonly Finding[],
  mergedFindings: readonly Finding[]
): ReviewFindingProvenance {
  const currentCounts = countFindingsBySeverity(fromCurrentReview);
  const mergedCounts = countFindingsBySeverity(mergedFindings);

  return {
    fromCurrentReview: currentCounts,
    carriedForward: {
      critical: Math.max(0, mergedCounts.critical - currentCounts.critical),
      major: Math.max(0, mergedCounts.major - currentCounts.major),
      minor: Math.max(0, mergedCounts.minor - currentCounts.minor),
    },
  };
}

function countFindingsBySeverity(
  findings: readonly Finding[]
): Record<Severity, number> {
  const counts = emptyFindingCounts();
  for (const finding of findings) {
    if (Object.prototype.hasOwnProperty.call(counts, finding.severity)) {
      counts[finding.severity] += 1;
    }
  }
  return counts;
}

function emptyFindingCounts(): Record<Severity, number> {
  return { critical: 0, major: 0, minor: 0 };
}
