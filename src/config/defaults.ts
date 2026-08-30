import { ReviewConfig, ReviewDepth, ReviewFocusProfile } from '../types';
import { PREFERRED_OPENROUTER_FREE_MODELS } from '../providers/openrouter-models';

export const DEFAULT_CONFIG: ReviewConfig = {
  reviewDepth: ReviewDepth.Balanced,
  reviewFocusProfile: ReviewFocusProfile.Standard,
  // Empty array triggers dynamic model discovery.
  // OpenRouter discovery prefers concrete free tool-capable models and can
  // discover OpenCode CLI models as fallback.
  providers: [],
  synthesisModel: 'openrouter/free',
  fallbackProviders: [],
  providerAllowlist: [],
  providerBlocklist: [],

  // COST CONTROLS:
  // - providerDiscoveryLimit: 8 = Health-check up to 8 providers for reliability
  // - providerLimit: 1 = Use one provider by default; opt in to consensus/multi-provider mode explicitly
  // - budgetMaxUsd: 0 = No budget allocated for paid APIs
  // Combined these settings ensure zero cost when using default configuration
  providerDiscoveryLimit: 8, // Health-check pool size (higher = better reliability)
  providerLimit: 1, // Actual execution pool size (lower = lower costs)
  requiredHealthyProviders: [],
  providerRetries: 3,
  providerMaxParallel: 1,
  quietModeEnabled: false,
  quietMinConfidence: 0.5,
  quietUseLearning: true,
  learningEnabled: false,
  learningMinFeedbackCount: 5,
  learningLookbackDays: 30,

  inlineMaxComments: 5,
  inlineMinSeverity: 'major',
  inlineMinAgreement: 1,

  skipLabels: [],
  skipDrafts: false,
  skipBots: true,
  minChangedLines: 0,
  maxChangedFiles: 0,

  diffMaxBytes: 240_000,
  runTimeoutSeconds: 600,
  openrouterTimeoutSeconds: 300,

  budgetMaxUsd: 0,

  enableAstAnalysis: true,
  enableSecurity: true,
  enableCaching: true,
  enableTestHints: true,
  enableAiDetection: false,

  incrementalEnabled: true, // Re-enabled with broad infrastructure exclusion
  incrementalCacheTtlDays: 7,

  batchMaxFiles: 30,
  providerBatchOverrides: {},
  enableTokenAwareBatching: true,
  targetTokensPerBatch: 50000, // ~50k tokens per batch
  smartDiffCompaction: true,
  maxFullDiffFileBytes: 60_000,
  maxFullDiffFileChanges: 1_000,

  graphEnabled: false,
  graphCacheEnabled: true,
  graphMaxDepth: 5,
  graphTimeoutSeconds: 10,

  codexAgenticContext: true,
  claudeAgenticContext: false,
  codexEventAudit: false,

  generateFixPrompts: false,
  fixPromptFormat: 'plain',

  analyticsEnabled: true,
  analyticsMaxReviews: 1000,
  analyticsDeveloperRate: 100, // USD per hour
  analyticsManualReviewTime: 30, // minutes

  pluginsEnabled: false,
  pluginDir: './plugins',
  pluginAllowlist: [],
  pluginBlocklist: [],

  skipTrivialChanges: true,
  skipDependencyUpdates: true,
  skipDocumentationOnly: true,
  skipFormattingOnly: false, // Disabled by default (may have false positives)
  skipTestFixtures: true,
  skipConfigFiles: true,
  skipBuildArtifacts: true,
  trivialPatterns: [],

  pathBasedIntensity: false, // Disabled by default, opt-in
  pathIntensityPatterns: undefined,
  pathDefaultIntensity: 'standard',

  // Provider selection strategy
  providerSelectionStrategy: 'reliability',
  providerExplorationRate: 0.3, // 70% exploit, 30% explore

  // Intensity behavior mappings
  intensityProviderCounts: {
    thorough: 8,
    standard: 5,
    light: 3,
  },
  intensityTimeouts: {
    thorough: 180000, // 3 minutes
    standard: 120000, // 2 minutes
    light: 60000, // 1 minute
  },
  intensityPromptDepth: {
    thorough: 'detailed',
    standard: 'standard',
    light: 'brief',
  },

  dryRun: false,
  updatePrDescription: true,
  failOnSeverity: 'critical',
  reviewThreadLifecycle: 'resolve',
  reviewThreadLifecycleMaxTargets: 10,
  reviewThreadLifecycleResolveConfidence: {
    critical: 0.9,
    major: 0.85,
    minor: 0.8,
    unknown: 0.9,
  },

  // Natural language for human-readable finding text. English keeps the
  // prompt byte-identical to previous behaviour (no language directive added).
  outputLanguage: 'English',
};

/**
 * Static fallback providers used only if dynamic discovery fails
 * (e.g., network issues, API unavailable, CLI not installed)
 */
export const FALLBACK_STATIC_PROVIDERS = [...PREFERRED_OPENROUTER_FREE_MODELS];
