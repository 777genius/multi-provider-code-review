import { ReviewConfig } from './types';
import { ProviderRegistry } from './providers/registry';
import { PromptBuilder } from './analysis/llm/prompt-builder';
import { LLMExecutor } from './analysis/llm/executor';
import { Deduplicator } from './analysis/deduplicator';
import { ConsensusEngine } from './analysis/consensus';
import { SynthesisEngine } from './analysis/synthesis';
import { TestCoverageAnalyzer } from './analysis/test-coverage';
import { ASTAnalyzer } from './analysis/ast/analyzer';
import { CacheManager } from './cache/manager';
import { IncrementalReviewer } from './cache/incremental';
import { CacheStorage } from './cache/storage';
import { selectIncrementalSnapshotStorage } from './cache/review-snapshot-bridge';
import { hashIncrementalCompatibility } from './cache/key-builder';
import { PricingService } from './cost/pricing';
import { CostTracker } from './cost/tracker';
import { SecurityScanner } from './security/scanner';
import { RuleLoader } from './rules/loader';
import { PullRequestLoader } from './github/pr-loader';
import { CommentPoster } from './github/comment-poster';
import { PullRequestDescriptionUpdater } from './github/pr-description';
import { GitHubClient } from './github/client';
import { GitHubTokenProvider } from './github/token-provider';
import { MarkdownFormatterV2 } from './output/formatter-v2';
import { ReviewComponents } from './core/orchestrator';
import { ContextRetriever } from './analysis/context';
import { ImpactAnalyzer } from './analysis/impact';
import { EvidenceScorer } from './analysis/evidence';
import { MermaidGenerator } from './output/mermaid';
import { FeedbackFilter } from './github/feedback';
import { ReviewLedger } from './github/ledger';
import { ConfigLoader } from './config/loader';
import { FeedbackTracker } from './learning/feedback-tracker';
import { QuietModeFilter } from './learning/quiet-mode';
import { CodeGraphBuilder } from './analysis/context/graph-builder';
import { PromptGenerator } from './autofix/prompt-generator';
import { ReliabilityTracker } from './providers/reliability-tracker';
import { MetricsCollector } from './analytics/metrics-collector';
import { PluginLoader } from './plugins';
import { BatchOrchestrator } from './core/batch-orchestrator';
import { SuppressionTracker } from './learning/suppression-tracker';
import { ProviderWeightTracker } from './learning/provider-weights';
import { PromptEnricher } from './learning/prompt-enrichment';
import { AcceptanceDetector } from './learning/acceptance-detector';
import {
  ReviewThreadInventoryLoader,
  trustedReviewThreadAuthorsFromEnv,
} from './github/review-thread-inventory';
import { ReviewThreadResolver } from './github/review-thread-resolver';
import { ControlPlaneReviewThreadLifecycleResolver } from './control-plane/review-thread-lifecycle';
import { RuntimeConfigResult } from './control-plane/runtime-config';
import { ControlPlaneMemoryClient } from './control-plane/memory';
import { logger } from './utils/logger';
import { createExecutionDeadlineFromEnvironment } from './review-execution/infrastructure/execution-deadline-from-environment';
import { createReviewCheckpointSessionFromEnvironment } from './review-execution/infrastructure/http-review-checkpoint-client';

const DEFAULT_PROVIDER_DISCOVERY_WAVE_TIMEOUT_MS = 15_000;

function parseBoundedParallelism(
  value: string | undefined
): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3) {
    throw new Error(
      'REVIEWROUTER_LARGE_PR_MAX_PARALLEL must be an integer from 1 to 3'
    );
  }
  return parsed;
}

function bindDeadlineAwareProviderDiscovery(
  providerRegistry: ProviderRegistry,
  llmExecutor: LLMExecutor
): void {
  const discover =
    providerRegistry.discoverAdditionalFreeProviders.bind(providerRegistry);
  providerRegistry.discoverAdditionalFreeProviders = async (
    existing,
    max,
    config
  ) =>
    (await llmExecutor.runProviderDiscoveryWave(
      () => discover(existing, max, config),
      DEFAULT_PROVIDER_DISCOVERY_WAVE_TIMEOUT_MS
    )) ?? [];
}

export interface SetupOptions {
  cliMode?: boolean;
  dryRun?: boolean;
  githubToken?: string;
  config?: ReviewConfig;
}

/**
 * Setup components for CLI mode (no GitHub dependencies)
 */
export async function setupComponents(
  options: SetupOptions = {}
): Promise<ReviewComponents> {
  const config = options.config || ConfigLoader.load();

  // Override dry run if specified
  if (options.dryRun !== undefined) {
    config.dryRun = options.dryRun;
  }

  // In CLI mode, we don't need GitHub components
  if (options.cliMode) {
    return await createComponentsForCLI(config);
  }

  // GitHub Action mode requires token
  if (!options.githubToken) {
    throw new Error('GitHub token required for Action mode');
  }

  return await createComponents(config, options.githubToken);
}

/**
 * Create components for CLI mode (no GitHub API)
 */
async function createComponentsForCLI(
  config: ReviewConfig
): Promise<ReviewComponents> {
  // Initialize plugins if enabled
  const pluginLoader = config.pluginsEnabled
    ? new PluginLoader({
        pluginDir: config.pluginDir || './plugins',
        enabled: config.pluginsEnabled,
        allowlist: config.pluginAllowlist,
        blocklist: config.pluginBlocklist,
      })
    : undefined;

  if (pluginLoader) {
    await pluginLoader.loadPlugins();
  }

  const executionDeadline = createExecutionDeadlineFromEnvironment();
  const llmExecutor = new LLMExecutor(config, {
    deadline: executionDeadline,
    maxParallelCalls: parseBoundedParallelism(
      process.env.REVIEWROUTER_LARGE_PR_MAX_PARALLEL
    ),
  });
  const deduplicator = new Deduplicator();
  const consensus = new ConsensusEngine({
    minAgreement: config.inlineMinAgreement,
    minSeverity: config.inlineMinSeverity,
    maxComments: config.inlineMaxComments,
  });
  const synthesis = new SynthesisEngine(config);
  const testCoverage = new TestCoverageAnalyzer();
  const astAnalyzer = new ASTAnalyzer();
  const cache = new CacheManager(undefined, config);
  const reviewCompatibilityKey = hashIncrementalCompatibility(
    config,
    process.env.REVIEWROUTER_CONFIG_VERSION
  );
  const incrementalReviewer = new IncrementalReviewer(new CacheStorage(), {
    enabled: config.incrementalEnabled,
    cacheTtlDays: config.incrementalCacheTtlDays,
    compatibilityKey: reviewCompatibilityKey,
  });
  const pricing = new PricingService(process.env.OPENROUTER_API_KEY);
  const costTracker = new CostTracker(pricing);
  const security = new SecurityScanner();
  const rules = RuleLoader.load();
  const contextRetriever = new ContextRetriever();
  const impactAnalyzer = new ImpactAnalyzer();
  const evidenceScorer = new EvidenceScorer();
  const mermaidGenerator = new MermaidGenerator();

  // Learning and auto-fix components
  const cacheStorage = new CacheStorage();
  const suppressionTracker = new SuppressionTracker(cacheStorage, 'cli-mode');
  const providerWeightTracker = new ProviderWeightTracker(cacheStorage);
  const acceptanceDetector = new AcceptanceDetector();
  const feedbackTracker = config.learningEnabled
    ? new FeedbackTracker(cacheStorage, config.learningMinFeedbackCount)
    : undefined;
  const promptEnricher = new PromptEnricher(
    suppressionTracker,
    feedbackTracker
  );
  const promptBuilder = new PromptBuilder(
    config,
    'standard',
    promptEnricher,
    undefined
  );
  const quietModeFilter = config.quietModeEnabled
    ? new QuietModeFilter(
        {
          enabled: config.quietModeEnabled,
          minConfidence: config.quietMinConfidence || 0.5,
          useLearning: config.quietUseLearning || false,
        },
        feedbackTracker
      )
    : undefined;
  const graphBuilder = config.graphEnabled
    ? new CodeGraphBuilder(
        config.graphMaxDepth || 5,
        (config.graphTimeoutSeconds || 10) * 1000
      )
    : undefined;
  const promptGenerator = new PromptGenerator('plain');
  const reliabilityTracker = new ReliabilityTracker(cacheStorage);
  const providerRegistry = new ProviderRegistry(
    pluginLoader,
    reliabilityTracker
  );
  bindDeadlineAwareProviderDiscovery(providerRegistry, llmExecutor);
  const metricsCollector = config.analyticsEnabled
    ? new MetricsCollector(cacheStorage, config)
    : undefined;
  const batchOrchestrator = new BatchOrchestrator({
    defaultBatchSize: config.batchMaxFiles || 30,
    providerOverrides: config.providerBatchOverrides,
    enableTokenAwareBatching: config.enableTokenAwareBatching,
    targetTokensPerBatch: config.targetTokensPerBatch,
    maxBatchSize: config.batchMaxFiles,
    maxFullFileBytes: config.maxFullDiffFileBytes,
    maxFullFileChanges: config.maxFullDiffFileChanges,
  });

  // Mock GitHub components for CLI mode
  const mockGitHubClient = {} as GitHubClient;
  const prLoader = new PullRequestLoader(mockGitHubClient);
  const commentPoster = new CommentPoster(
    mockGitHubClient,
    true,
    config,
    suppressionTracker,
    providerWeightTracker
  ); // Always dry-run in CLI
  const prDescriptionUpdater = new PullRequestDescriptionUpdater(
    mockGitHubClient,
    true
  );
  const formatter = new MarkdownFormatterV2();
  // Create a mock FeedbackFilter that always allows posts (no suppression in CLI mode)
  const feedbackFilter = {
    client: mockGitHubClient,
    loadSuppressed: async (): Promise<Set<string>> => new Set(),
    loadReviewCommentState: async () => ({
      suppressed: new Set<string>(),
      alreadyPosted: new Set<string>(),
    }),
    shouldPost: (): boolean => true,
    signatureFromComment: (): string => '',
  } as unknown as FeedbackFilter;

  return {
    config,
    providerRegistry,
    promptBuilder,
    llmExecutor,
    deduplicator,
    consensus,
    synthesis,
    testCoverage,
    astAnalyzer,
    cache,
    incrementalReviewer,
    costTracker,
    security,
    rules,
    prLoader,
    commentPoster,
    prDescriptionUpdater,
    formatter,
    contextRetriever,
    impactAnalyzer,
    evidenceScorer,
    mermaidGenerator,
    feedbackFilter,
    feedbackTracker,
    quietModeFilter,
    graphBuilder,
    promptGenerator,
    reliabilityTracker,
    metricsCollector,
    batchOrchestrator,
    acceptanceDetector,
    providerWeightTracker,
    executionDeadline,
    reviewCompatibilityKey,
  };
}

export async function createComponents(
  config: ReviewConfig,
  githubToken: string,
  options: {
    fallbackGithubToken?: string;
    runtimeConfig?: RuntimeConfigResult;
    githubTokenProvider?: GitHubTokenProvider;
  } = {}
): Promise<ReviewComponents> {
  // Initialize plugins if enabled
  const pluginLoader = config.pluginsEnabled
    ? new PluginLoader({
        pluginDir: config.pluginDir || './plugins',
        enabled: config.pluginsEnabled,
        allowlist: config.pluginAllowlist,
        blocklist: config.pluginBlocklist,
      })
    : undefined;

  if (pluginLoader) {
    await pluginLoader.loadPlugins();
  }

  const executionDeadline = createExecutionDeadlineFromEnvironment();
  const llmExecutor = new LLMExecutor(config, {
    deadline: executionDeadline,
    maxParallelCalls: parseBoundedParallelism(
      process.env.REVIEWROUTER_LARGE_PR_MAX_PARALLEL
    ),
  });
  const deduplicator = new Deduplicator();
  const consensus = new ConsensusEngine({
    minAgreement: config.inlineMinAgreement,
    minSeverity: config.inlineMinSeverity,
    maxComments: config.inlineMaxComments,
  });
  const synthesis = new SynthesisEngine(config);
  const testCoverage = new TestCoverageAnalyzer();
  const astAnalyzer = new ASTAnalyzer();
  const cache = new CacheManager(undefined, config);
  const reviewCompatibilityKey = hashIncrementalCompatibility(
    config,
    process.env.REVIEWROUTER_CONFIG_VERSION
  );
  const incrementalSnapshotStorage = selectIncrementalSnapshotStorage({
    localStorage: new CacheStorage(),
    incrementalEnabled: config.incrementalEnabled,
  });
  if (incrementalSnapshotStorage.hostedSnapshotUnavailable) {
    logger.warn(
      'Hosted incremental snapshot bridge is unavailable; incremental review is disabled for this run'
    );
  }
  const incrementalReviewer = new IncrementalReviewer(
    incrementalSnapshotStorage.storage,
    {
      enabled: incrementalSnapshotStorage.enabled,
      cacheTtlDays: config.incrementalCacheTtlDays,
      compatibilityKey: reviewCompatibilityKey,
      requireCompatibleSnapshot:
        incrementalSnapshotStorage.requireCompatibleSnapshot,
    }
  );
  const pricing = new PricingService(process.env.OPENROUTER_API_KEY);
  const costTracker = new CostTracker(pricing);
  const security = new SecurityScanner();
  const rules = RuleLoader.load();
  const githubClient = new GitHubClient(githubToken, {
    tokenProvider: options.githubTokenProvider,
  });
  const fallbackGithubClient =
    options.fallbackGithubToken && options.fallbackGithubToken !== githubToken
      ? new GitHubClient(options.fallbackGithubToken)
      : githubClient;
  const prLoader = new PullRequestLoader(githubClient);
  const contextRetriever = new ContextRetriever();
  const impactAnalyzer = new ImpactAnalyzer();
  const evidenceScorer = new EvidenceScorer();
  const mermaidGenerator = new MermaidGenerator();

  // Learning and auto-fix components
  const cacheStorage = new CacheStorage();
  const repoKey = `${githubClient.owner}/${githubClient.repo}`;
  const suppressionTracker = new SuppressionTracker(cacheStorage, repoKey);
  const providerWeightTracker = new ProviderWeightTracker(cacheStorage);
  const reviewLedger = new ReviewLedger(
    githubClient,
    process.env.REVIEW_ROUTER_LEDGER_KEY,
    config.dryRun
  );
  const feedbackFilter = new FeedbackFilter(
    githubClient,
    providerWeightTracker,
    reviewLedger
  );
  const acceptanceDetector = new AcceptanceDetector();
  const feedbackTracker = config.learningEnabled
    ? new FeedbackTracker(cacheStorage, config.learningMinFeedbackCount)
    : undefined;
  const promptEnricher = new PromptEnricher(
    suppressionTracker,
    feedbackTracker
  );
  const promptBuilder = new PromptBuilder(
    config,
    'standard',
    promptEnricher,
    undefined
  );
  const commentPoster = new CommentPoster(
    githubClient,
    config.dryRun,
    config,
    suppressionTracker,
    providerWeightTracker
  );
  const prDescriptionUpdater = new PullRequestDescriptionUpdater(
    githubClient,
    config.dryRun
  );
  const formatter = new MarkdownFormatterV2();
  const trustedReviewThreadAuthors = trustedReviewThreadAuthorsFromEnv();
  const reviewThreadInventory = new ReviewThreadInventoryLoader(
    githubClient,
    trustedReviewThreadAuthors
  );
  const reviewThreadResolver = new ReviewThreadResolver(
    githubClient,
    config.dryRun,
    trustedReviewThreadAuthors,
    fallbackGithubClient,
    new ControlPlaneReviewThreadLifecycleResolver(options.runtimeConfig)
  );
  const memoryBundleProvider = new ControlPlaneMemoryClient(
    options.runtimeConfig
  );
  const quietModeFilter = config.quietModeEnabled
    ? new QuietModeFilter(
        {
          enabled: config.quietModeEnabled,
          minConfidence: config.quietMinConfidence || 0.5,
          useLearning: config.quietUseLearning || false,
        },
        feedbackTracker
      )
    : undefined;
  const graphBuilder = config.graphEnabled
    ? new CodeGraphBuilder(
        config.graphMaxDepth || 5,
        (config.graphTimeoutSeconds || 10) * 1000
      )
    : undefined;
  const promptGenerator = new PromptGenerator('plain');
  const reliabilityTracker = new ReliabilityTracker(cacheStorage);
  const providerRegistry = new ProviderRegistry(
    pluginLoader,
    reliabilityTracker
  );
  bindDeadlineAwareProviderDiscovery(providerRegistry, llmExecutor);
  const metricsCollector = config.analyticsEnabled
    ? new MetricsCollector(cacheStorage, config)
    : undefined;
  const batchOrchestrator = new BatchOrchestrator({
    defaultBatchSize: config.batchMaxFiles || 30,
    providerOverrides: config.providerBatchOverrides,
    enableTokenAwareBatching: config.enableTokenAwareBatching,
    targetTokensPerBatch: config.targetTokensPerBatch,
    maxBatchSize: config.batchMaxFiles,
    maxFullFileBytes: config.maxFullDiffFileBytes,
    maxFullFileChanges: config.maxFullDiffFileChanges,
  });

  return {
    config,
    providerRegistry,
    promptBuilder,
    llmExecutor,
    deduplicator,
    consensus,
    synthesis,
    testCoverage,
    astAnalyzer,
    cache,
    incrementalReviewer,
    costTracker,
    security,
    rules,
    prLoader,
    commentPoster,
    prDescriptionUpdater,
    formatter,
    contextRetriever,
    impactAnalyzer,
    evidenceScorer,
    mermaidGenerator,
    feedbackFilter,
    feedbackTracker,
    quietModeFilter,
    graphBuilder,
    promptGenerator,
    reliabilityTracker,
    metricsCollector,
    batchOrchestrator,
    githubClient,
    reviewThreadInventory,
    reviewThreadResolver,
    acceptanceDetector,
    providerWeightTracker,
    memoryBundleProvider,
    executionDeadline,
    reviewCompatibilityKey,
    incrementalSnapshotAdvancementEnabled: incrementalSnapshotStorage.enabled,
    openReviewCheckpointSession: (plan) =>
      createReviewCheckpointSessionFromEnvironment({
        plan,
        logger: { warn: (message) => logger.warn(message) },
      }),
  };
}
