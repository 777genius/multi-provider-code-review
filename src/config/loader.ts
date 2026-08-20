import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ReviewConfig, ReviewDepth } from '../types';
import { DEFAULT_CONFIG } from './defaults';
import { ReviewConfigSchema, ReviewConfigFile } from './schema';
import { validateConfig, ValidationError } from '../utils/validation';
import { logger } from '../utils/logger';

export class ConfigLoader {
  private static readonly CONFIG_PATHS = [
    '.github/multi-review.yml',
    '.github/multi-review.yaml',
    '.multi-review.yml',
    '.multi-review.yaml',
  ];

  static load(): ReviewConfig {
    const fileConfig = this.loadFromFile();
    const envConfig = this.loadFromEnv();

    const merged = this.merge(DEFAULT_CONFIG, fileConfig, envConfig);

    // Validate final configuration
    try {
      validateConfig(merged as unknown as Record<string, unknown>);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw new ValidationError(
          `Invalid configuration: ${error.message}`,
          error.field,
          error.hint
        );
      }
      throw error;
    }

    return merged;
  }

  private static loadFromFile(): Partial<ReviewConfig> {
    for (const relPath of this.CONFIG_PATHS) {
      const fullPath = path.join(process.cwd(), relPath);
      if (!fs.existsSync(fullPath)) continue;

      try {
        const raw = fs.readFileSync(fullPath, 'utf8');
        const parsed = yaml.load(raw) as Record<string, unknown>;
        const validated = ReviewConfigSchema.parse(parsed);
        return this.normalizeKeys(validated);
      } catch (error) {
        const err = error as Error;
        logger.warn(
          `⚠️  Failed to load config from ${relPath}: ${err.message}`
        );
        if (err.message.includes('YAMLException')) {
          logger.warn(
            '💡 Check for YAML syntax errors (indentation, colons, quotes)'
          );
        } else if (err.message.includes('parse')) {
          logger.warn('💡 Check that all values match expected types');
        }
      }
    }

    return {};
  }

  private static loadFromEnv(): Partial<ReviewConfig> {
    const env = process.env;
    const codexProvider = this.codexProviderFromModel(env.CODEX_MODEL);
    const claudeProvider = this.claudeProviderFromModel(env.CLAUDE_MODEL);
    const explicitProviders = this.parseArray(env.REVIEW_PROVIDERS) || [];
    const inferredProvider = this.inferredProviderFromAuthMode(
      env.REVIEW_AUTH_MODE,
      claudeProvider,
      codexProvider
    );
    const providers =
      explicitProviders.length > 0
        ? explicitProviders
        : inferredProvider
          ? [inferredProvider]
          : undefined;

    return {
      reviewDepth: this.parseReviewDepth(env.REVIEW_DEPTH),
      providers,
      synthesisModel:
        env.SYNTHESIS_MODEL ||
        (explicitProviders.length === 0 ? inferredProvider : undefined),
      fallbackProviders: this.parseArray(env.FALLBACK_PROVIDERS),
      providerAllowlist: this.parseArray(env.PROVIDER_ALLOWLIST),
      providerBlocklist: this.parseArray(env.PROVIDER_BLOCKLIST),
      providerDiscoveryLimit: this.parseNumber(env.PROVIDER_DISCOVERY_LIMIT),
      providerLimit: this.parseNumber(env.PROVIDER_LIMIT),
      requiredHealthyProviders: this.parseArray(env.REQUIRED_HEALTHY_PROVIDERS),
      providerRetries: this.parseNumber(env.PROVIDER_RETRIES),
      providerMaxParallel: this.parseNumber(env.PROVIDER_MAX_PARALLEL),
      quietModeEnabled: this.parseBoolean(env.QUIET_MODE_ENABLED),
      quietMinConfidence: this.parseFloat(env.QUIET_MIN_CONFIDENCE),
      quietUseLearning: this.parseBoolean(env.QUIET_USE_LEARNING),
      learningEnabled: this.parseBoolean(env.LEARNING_ENABLED),
      learningMinFeedbackCount: this.parseNumber(
        env.LEARNING_MIN_FEEDBACK_COUNT
      ),
      learningLookbackDays: this.parseNumber(env.LEARNING_LOOKBACK_DAYS),

      inlineMaxComments: this.parseNumber(env.INLINE_MAX_COMMENTS),
      inlineMinSeverity: this.parseSeverity(env.INLINE_MIN_SEVERITY),
      inlineMinAgreement: this.parseNumber(env.INLINE_MIN_AGREEMENT),

      skipLabels: this.parseArray(env.SKIP_LABELS),
      skipDrafts: this.parseBoolean(env.SKIP_DRAFTS),
      skipBots: this.parseBoolean(env.SKIP_BOTS),
      minChangedLines: this.parseNumber(env.MIN_CHANGED_LINES),
      maxChangedFiles: this.parseNumber(env.MAX_CHANGED_FILES),

      diffMaxBytes: this.parseNumber(env.DIFF_MAX_BYTES),
      runTimeoutSeconds: this.parseNumber(env.RUN_TIMEOUT_SECONDS),
      openrouterTimeoutSeconds: this.parseNumber(
        env.OPENROUTER_TIMEOUT_SECONDS
      ),

      budgetMaxUsd: this.parseFloat(env.BUDGET_MAX_USD),

      enableAstAnalysis: this.parseBoolean(env.ENABLE_AST_ANALYSIS),
      enableSecurity: this.parseBoolean(env.ENABLE_SECURITY),
      enableCaching: this.parseBoolean(env.ENABLE_CACHING),
      enableTestHints: this.parseBoolean(env.ENABLE_TEST_HINTS),
      enableAiDetection: this.parseBoolean(env.ENABLE_AI_DETECTION),

      incrementalEnabled: this.parseBoolean(env.INCREMENTAL_ENABLED),
      incrementalCacheTtlDays: this.parseNumber(env.INCREMENTAL_CACHE_TTL_DAYS),

      codexAgenticContext: this.parseBoolean(env.CODEX_AGENTIC_CONTEXT),
      claudeAgenticContext: this.parseBoolean(env.CLAUDE_AGENTIC_CONTEXT),
      codexEventAudit: this.parseBoolean(env.CODEX_EVENT_AUDIT),

      batchMaxFiles: this.parseNumber(env.BATCH_MAX_FILES),
      providerBatchOverrides: this.parseOverrides(env.PROVIDER_BATCH_OVERRIDES),
      enableTokenAwareBatching: this.parseBoolean(
        env.ENABLE_TOKEN_AWARE_BATCHING
      ),
      targetTokensPerBatch: this.parseNumber(env.TARGET_TOKENS_PER_BATCH),
      smartDiffCompaction: this.parseBoolean(env.SMART_DIFF_COMPACTION),
      maxFullDiffFileBytes: this.parseNumber(env.MAX_FULL_DIFF_FILE_BYTES),
      maxFullDiffFileChanges: this.parseNumber(env.MAX_FULL_DIFF_FILE_CHANGES),

      skipTrivialChanges: this.parseBoolean(env.SKIP_TRIVIAL_CHANGES),
      skipDependencyUpdates: this.parseBoolean(env.SKIP_DEPENDENCY_UPDATES),
      skipDocumentationOnly: this.parseBoolean(env.SKIP_DOCUMENTATION_ONLY),
      skipFormattingOnly: this.parseBoolean(env.SKIP_FORMATTING_ONLY),
      skipTestFixtures: this.parseBoolean(env.SKIP_TEST_FIXTURES),
      skipConfigFiles: this.parseBoolean(env.SKIP_CONFIG_FILES),
      skipBuildArtifacts: this.parseBoolean(env.SKIP_BUILD_ARTIFACTS),
      trivialPatterns: this.parseArray(env.TRIVIAL_PATTERNS),

      pathBasedIntensity: this.parseBoolean(env.PATH_BASED_INTENSITY),
      pathIntensityPatterns: env.PATH_INTENSITY_PATTERNS,
      pathDefaultIntensity: this.parseIntensity(env.PATH_DEFAULT_INTENSITY),
      minConfidence: this.parseFloat(env.MIN_CONFIDENCE),
      consensusRequiredForCritical: this.parseBoolean(
        env.CONSENSUS_REQUIRED_FOR_CRITICAL
      ),
      consensusMinAgreement: this.parseNumber(env.CONSENSUS_MIN_AGREEMENT),
      suggestionSyntaxValidation: this.parseBoolean(
        env.SUGGESTION_SYNTAX_VALIDATION
      ),
      updatePrDescription: this.parseBoolean(env.UPDATE_PR_DESCRIPTION),
      failOnSeverity: this.parseFailOnPolicy(
        env.FAIL_ON_SEVERITY,
        env.FAIL_ON_CRITICAL,
        env.FAIL_ON_MAJOR
      ),
      reviewThreadLifecycle: this.parseLifecycleMode(
        env.REVIEW_THREAD_LIFECYCLE,
        'REVIEW_THREAD_LIFECYCLE'
      ),
      reviewThreadLifecycleMaxTargets: this.parseLifecycleMaxTargets(
        env.REVIEW_THREAD_LIFECYCLE_MAX_TARGETS
      ),
      reviewThreadLifecycleResolveConfidence: this.parseLifecycleConfidence(
        env.REVIEW_THREAD_LIFECYCLE_RESOLVE_CONFIDENCE
      ),

      outputLanguage: this.parseLanguage(env.REVIEW_OUTPUT_LANGUAGE),

      dryRun: this.parseBoolean(env.DRY_RUN),
    };
  }

  private static normalizeKeys(
    config: ReviewConfigFile
  ): Partial<ReviewConfig> {
    return {
      reviewDepth: config.review_depth,
      providers: config.providers,
      synthesisModel: config.synthesis_model,
      outputLanguage: config.output_language,
      fallbackProviders: config.fallback_providers,
      providerAllowlist: config.provider_allowlist,
      providerBlocklist: config.provider_blocklist,
      providerDiscoveryLimit: config.provider_discovery_limit,
      providerLimit: config.provider_limit,
      requiredHealthyProviders: config.required_healthy_providers,
      providerRetries: config.provider_retries,
      providerMaxParallel: config.provider_max_parallel,
      quietModeEnabled: config.quiet_mode_enabled,
      quietMinConfidence: config.quiet_min_confidence,
      quietUseLearning: config.quiet_use_learning,
      learningEnabled: config.learning_enabled,
      learningMinFeedbackCount: config.learning_min_feedback_count,
      learningLookbackDays: config.learning_lookback_days,
      inlineMaxComments: config.inline_max_comments,
      inlineMinSeverity: config.inline_min_severity,
      inlineMinAgreement: config.inline_min_agreement,
      skipLabels: config.skip_labels,
      skipDrafts: config.skip_drafts,
      skipBots: config.skip_bots,
      minChangedLines: config.min_changed_lines,
      maxChangedFiles: config.max_changed_files,
      diffMaxBytes: config.diff_max_bytes,
      runTimeoutSeconds: config.run_timeout_seconds,
      openrouterTimeoutSeconds: config.openrouter_timeout_seconds,
      budgetMaxUsd: config.budget_max_usd,
      enableAstAnalysis: config.enable_ast_analysis,
      enableSecurity: config.enable_security,
      enableCaching: config.enable_caching,
      enableTestHints: config.enable_test_hints,
      enableAiDetection: config.enable_ai_detection,
      incrementalEnabled: config.incremental_enabled,
      incrementalCacheTtlDays: config.incremental_cache_ttl_days,
      batchMaxFiles: config.batch_max_files,
      providerBatchOverrides: config.provider_batch_overrides,
      enableTokenAwareBatching: config.enable_token_aware_batching,
      targetTokensPerBatch: config.target_tokens_per_batch,
      smartDiffCompaction: config.smart_diff_compaction,
      maxFullDiffFileBytes: config.max_full_diff_file_bytes,
      maxFullDiffFileChanges: config.max_full_diff_file_changes,
      graphEnabled: config.graph_enabled,
      graphCacheEnabled: config.graph_cache_enabled,
      graphMaxDepth: config.graph_max_depth,
      graphTimeoutSeconds: config.graph_timeout_seconds,
      codexAgenticContext: config.codex_agentic_context,
      claudeAgenticContext: config.claude_agentic_context,
      codexEventAudit: config.codex_event_audit,
      generateFixPrompts: config.generate_fix_prompts,
      fixPromptFormat: config.fix_prompt_format,
      analyticsEnabled: config.analytics_enabled,
      analyticsMaxReviews: config.analytics_max_reviews,
      analyticsDeveloperRate: config.analytics_developer_rate,
      analyticsManualReviewTime: config.analytics_manual_review_time,
      pluginsEnabled: config.plugins_enabled,
      pluginDir: config.plugin_dir,
      pluginAllowlist: config.plugin_allowlist,
      pluginBlocklist: config.plugin_blocklist,
      skipTrivialChanges: config.skip_trivial_changes,
      skipDependencyUpdates: config.skip_dependency_updates,
      skipDocumentationOnly: config.skip_documentation_only,
      skipFormattingOnly: config.skip_formatting_only,
      skipTestFixtures: config.skip_test_fixtures,
      skipConfigFiles: config.skip_config_files,
      skipBuildArtifacts: config.skip_build_artifacts,
      trivialPatterns: config.trivial_patterns,
      pathBasedIntensity: config.path_based_intensity,
      pathIntensityPatterns: config.path_intensity_patterns,
      pathDefaultIntensity: config.path_default_intensity,
      providerSelectionStrategy: config.provider_selection_strategy,
      providerExplorationRate: config.provider_exploration_rate,
      intensityProviderCounts: config.intensity_provider_counts,
      intensityTimeouts: config.intensity_timeouts,
      intensityPromptDepth: config.intensity_prompt_depth,
      minConfidence: config.min_confidence,
      confidenceThreshold: config.confidence_threshold,
      consensusRequiredForCritical: config.consensus_required_for_critical,
      consensusMinAgreement: config.consensus_min_agreement,
      suggestionSyntaxValidation: config.suggestion_syntax_validation,
      updatePrDescription: config.update_pr_description,
      failOnSeverity: config.fail_on_severity,
      reviewThreadLifecycle: this.parseLifecycleMode(
        config.review_thread_lifecycle,
        'review_thread_lifecycle'
      ),
      reviewThreadLifecycleMaxTargets:
        config.review_thread_lifecycle_max_targets,
      reviewThreadLifecycleResolveConfidence:
        config.review_thread_lifecycle_resolve_confidence,
      dryRun: config.dry_run,
    };
  }

  private static merge(
    defaults: ReviewConfig,
    ...overrides: Array<Partial<ReviewConfig>>
  ): ReviewConfig {
    return overrides.reduce<ReviewConfig>((acc, curr) => {
      const next: Partial<ReviewConfig> = {};
      for (const [key, value] of Object.entries(curr)) {
        if (value === undefined || value === null) continue;
        const typedKey = key as keyof ReviewConfig;
        next[typedKey] = value as never;
      }
      return { ...acc, ...next } as ReviewConfig;
    }, defaults);
  }

  private static parseArray(value?: string): string[] | undefined {
    if (!value) return undefined;
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }

  private static parseReviewDepth(value?: string): ReviewDepth | undefined {
    if (value === undefined || value.trim().length === 0) return undefined;
    switch (value.trim()) {
      case ReviewDepth.Economy:
        return ReviewDepth.Economy;
      case ReviewDepth.Balanced:
        return ReviewDepth.Balanced;
      case ReviewDepth.Thorough:
        return ReviewDepth.Thorough;
      default:
        throw new ValidationError(
          'REVIEW_DEPTH has invalid value',
          'REVIEW_DEPTH',
          `Expected one of: ${Object.values(ReviewDepth).join(', ')}`
        );
    }
  }

  /**
   * Sanitize a free-text language name before it reaches the model prompt.
   * Keeps a single line of letters/marks/spaces plus a few separators, caps
   * length, and drops everything else so the value cannot smuggle prompt
   * instructions.
   */
  private static parseLanguage(value?: string): string | undefined {
    if (!value) return undefined;
    const cleaned = value
      .split(/[\r\n]/)[0]
      .replace(/[^\p{L}\p{M}\s()\-/]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
    return cleaned.length > 0 ? cleaned : undefined;
  }

  private static codexProviderFromModel(value?: string): string | undefined {
    const model = value?.trim();
    if (!model) return undefined;
    return model.startsWith('codex/') ? model : `codex/${model}`;
  }

  private static claudeProviderFromModel(value?: string): string | undefined {
    const model = value?.trim();
    if (!model) return undefined;
    return model.startsWith('claude/') ? model : `claude/${model}`;
  }

  private static inferredProviderFromAuthMode(
    authMode: string | undefined,
    claudeProvider: string | undefined,
    codexProvider: string | undefined
  ): string | undefined {
    switch ((authMode || '').trim()) {
      case 'claude-oauth':
        return claudeProvider || 'claude/sonnet';
      case 'codex-oauth':
      case 'openai-api':
        return codexProvider;
      default:
        return claudeProvider || codexProvider;
    }
  }

  private static parseBoolean(value?: string): boolean | undefined {
    if (value === undefined) return undefined;
    return value.toLowerCase() === 'true';
  }

  private static parseNumber(value?: string): number | undefined {
    if (!value) return undefined;
    const num = parseInt(value, 10);
    return Number.isFinite(num) ? num : undefined;
  }

  private static parseFloat(value?: string): number | undefined {
    if (!value) return undefined;
    const num = Number.parseFloat(value);
    return Number.isFinite(num) ? num : undefined;
  }

  private static parseOverrides(
    value?: string
  ): Record<string, number> | undefined {
    if (!value) return undefined;
    try {
      const parsed = JSON.parse(value);
      if (
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        parsed === null
      ) {
        throw new Error('Overrides must be a JSON object');
      }
      const result: Record<string, number> = {};
      for (const [key, val] of Object.entries(parsed)) {
        const num = Number(val);
        if (!Number.isFinite(num)) continue;

        // Enforce integer batch sizes between 1 and 200 (schema constraint)
        const intVal = Math.trunc(num);
        if (intVal < 1) {
          logger.warn(
            `Ignoring PROVIDER_BATCH_OVERRIDES entry for "${key}": value ${intVal} is below minimum 1`
          );
          continue;
        }
        const clamped = Math.min(intVal, 200);
        if (clamped !== intVal) {
          logger.warn(
            `Clamping PROVIDER_BATCH_OVERRIDES entry for "${key}" from ${intVal} to maximum 200`
          );
        }
        result[key] = clamped;
      }
      return result;
    } catch (error) {
      const message = `Failed to parse PROVIDER_BATCH_OVERRIDES: ${(error as Error).message}`;
      logger.warn(message);
      return undefined;
    }
  }

  private static parseSeverity(
    value?: string
  ): 'critical' | 'major' | 'minor' | undefined {
    if (!value) return undefined;
    const normalized = value.toLowerCase();
    if (
      normalized === 'critical' ||
      normalized === 'major' ||
      normalized === 'minor'
    ) {
      return normalized as 'critical' | 'major' | 'minor';
    }
    return undefined;
  }

  private static parseIntensity(
    value?: string
  ): 'thorough' | 'standard' | 'light' | undefined {
    if (!value) return undefined;
    const normalized = value.toLowerCase();
    if (
      normalized === 'thorough' ||
      normalized === 'standard' ||
      normalized === 'light'
    ) {
      return normalized as 'thorough' | 'standard' | 'light';
    }
    return undefined;
  }

  private static parseFailOnSeverity(
    value?: string
  ): 'off' | 'critical' | 'major' | 'minor' | undefined {
    if (!value) return undefined;
    const normalized = value.toLowerCase();
    if (
      normalized === 'off' ||
      normalized === 'false' ||
      normalized === 'none'
    ) {
      return 'off';
    }
    if (
      normalized === 'critical' ||
      normalized === 'major' ||
      normalized === 'minor'
    ) {
      return normalized as 'critical' | 'major' | 'minor';
    }
    return undefined;
  }

  private static parseFailOnPolicy(
    severity?: string,
    critical?: string,
    major?: string
  ): 'off' | 'critical' | 'major' | 'minor' | undefined {
    const explicitSeverity = this.parseFailOnSeverity(severity);
    if (explicitSeverity !== undefined) {
      return explicitSeverity;
    }

    const failOnCritical = this.parseBoolean(critical);
    const failOnMajor = this.parseBoolean(major);

    if (failOnCritical === undefined && failOnMajor === undefined) {
      return undefined;
    }

    if (failOnMajor) {
      return 'major';
    }

    if (failOnCritical) {
      return 'critical';
    }

    return 'off';
  }

  private static parseLifecycleMode(
    value?: string,
    source = 'REVIEW_THREAD_LIFECYCLE'
  ): 'off' | 'report' | 'resolve' | undefined {
    if (!value) return undefined;
    const normalized = value.toLowerCase();
    if (
      normalized === 'off' ||
      normalized === 'report' ||
      normalized === 'resolve'
    ) {
      return normalized;
    }
    logger.warn(
      `Disabling review thread lifecycle because ${source}=${value} is invalid; expected off, report, or resolve`
    );
    return 'off';
  }

  private static parseLifecycleMaxTargets(value?: string): number | undefined {
    const parsed = this.parseNumber(value);
    if (parsed === undefined) return undefined;
    if (parsed < 0) {
      logger.warn(
        `Ignoring REVIEW_THREAD_LIFECYCLE_MAX_TARGETS=${value}: expected number from 0 to 25`
      );
      return undefined;
    }
    if (parsed > 25) {
      logger.warn(
        `Clamping REVIEW_THREAD_LIFECYCLE_MAX_TARGETS from ${parsed} to maximum 25`
      );
      return 25;
    }
    return parsed;
  }

  private static parseLifecycleConfidence(
    value?: string
  ):
    | { critical?: number; major?: number; minor?: number; unknown?: number }
    | undefined {
    if (!value) return undefined;
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('expected a JSON object');
      }
      const result: {
        critical?: number;
        major?: number;
        minor?: number;
        unknown?: number;
      } = {};
      for (const key of ['critical', 'major', 'minor', 'unknown'] as const) {
        if (parsed[key] === undefined) continue;
        const num = Number(parsed[key]);
        if (!Number.isFinite(num) || num < 0 || num > 1) {
          logger.warn(
            `Ignoring REVIEW_THREAD_LIFECYCLE_RESOLVE_CONFIDENCE.${key}: expected number from 0 to 1`
          );
          continue;
        }
        result[key] = num;
      }
      return result;
    } catch (error) {
      logger.warn(
        `Failed to parse REVIEW_THREAD_LIFECYCLE_RESOLVE_CONFIDENCE: ${(error as Error).message}`
      );
      return undefined;
    }
  }
}
