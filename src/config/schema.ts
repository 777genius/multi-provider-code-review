import { z } from 'zod';
import { isValidRegexPattern } from '../utils/regex-validator';
import { ReviewDepth } from '../types';

export const ReviewConfigSchema = z.object({
  review_depth: z.nativeEnum(ReviewDepth).optional(),
  providers: z.array(z.string()).optional(),
  synthesis_model: z.string().optional(),
  output_language: z.string().max(60).optional(),
  fallback_providers: z.array(z.string()).optional(),
  provider_allowlist: z.array(z.string()).optional(),
  provider_blocklist: z.array(z.string()).optional(),
  provider_discovery_limit: z.number().int().min(1).optional(),
  provider_limit: z.number().int().min(0).optional(),
  required_healthy_providers: z.array(z.string()).optional(),
  provider_retries: z.number().int().min(1).optional(),
  provider_max_parallel: z.number().int().min(1).optional(),
  quiet_mode_enabled: z.boolean().optional(),
  quiet_min_confidence: z.number().min(0).max(1).optional(),
  quiet_use_learning: z.boolean().optional(),
  learning_enabled: z.boolean().optional(),
  learning_min_feedback_count: z.number().int().min(1).optional(),
  learning_lookback_days: z.number().int().min(1).optional(),

  inline_max_comments: z.number().int().min(0).optional(),
  inline_min_severity: z.enum(['critical', 'major', 'minor']).optional(),
  inline_min_agreement: z.number().int().min(1).optional(),

  skip_labels: z.array(z.string()).optional(),
  skip_drafts: z.boolean().optional(),
  skip_bots: z.boolean().optional(),
  min_changed_lines: z.number().int().min(0).optional(),
  max_changed_files: z.number().int().min(0).optional(),

  diff_max_bytes: z.number().int().min(0).optional(),
  run_timeout_seconds: z.number().int().min(1).optional(),
  openrouter_timeout_seconds: z.number().int().min(1).optional(),

  budget_max_usd: z.number().min(0).optional(),

  enable_ast_analysis: z.boolean().optional(),
  enable_security: z.boolean().optional(),
  enable_caching: z.boolean().optional(),
  enable_test_hints: z.boolean().optional(),
  enable_ai_detection: z.boolean().optional(),

  incremental_enabled: z.boolean().optional(),
  incremental_cache_ttl_days: z.number().int().min(1).max(30).optional(),

  batch_max_files: z.number().int().min(1).max(200).optional(),
  provider_batch_overrides: z
    .record(z.coerce.number().int().min(1).max(200))
    .optional(),
  enable_token_aware_batching: z.boolean().optional(),
  target_tokens_per_batch: z.number().int().min(1000).optional(),
  smart_diff_compaction: z.boolean().optional(),
  max_full_diff_file_bytes: z.number().int().min(1000).optional(),
  max_full_diff_file_changes: z.number().int().min(1).optional(),

  graph_enabled: z.boolean().optional(),
  graph_cache_enabled: z.boolean().optional(),
  graph_max_depth: z.number().int().min(1).max(10).optional(),
  graph_timeout_seconds: z.number().int().min(1).max(60).optional(),

  codex_agentic_context: z.boolean().optional(),
  claude_agentic_context: z.boolean().optional(),
  codex_event_audit: z.boolean().optional(),

  generate_fix_prompts: z.boolean().optional(),
  fix_prompt_format: z.enum(['cursor', 'copilot', 'plain']).optional(),

  analytics_enabled: z.boolean().optional(),
  analytics_max_reviews: z.number().int().min(100).max(10000).optional(),
  analytics_developer_rate: z.number().min(0).optional(),
  analytics_manual_review_time: z.number().min(0).optional(),

  plugins_enabled: z.boolean().optional(),
  plugin_dir: z.string().optional(),
  plugin_allowlist: z.array(z.string()).optional(),
  plugin_blocklist: z.array(z.string()).optional(),

  skip_trivial_changes: z.boolean().optional(),
  skip_dependency_updates: z.boolean().optional(),
  skip_documentation_only: z.boolean().optional(),
  skip_formatting_only: z.boolean().optional(),
  skip_test_fixtures: z.boolean().optional(),
  skip_config_files: z.boolean().optional(),
  skip_build_artifacts: z.boolean().optional(),
  trivial_patterns: z
    .array(
      z.string().refine((pattern) => isValidRegexPattern(pattern), {
        message:
          'Invalid or unsafe regex pattern (check for ReDoS vulnerabilities)',
      })
    )
    .optional(),

  path_based_intensity: z.boolean().optional(),
  path_intensity_patterns: z.string().optional(),
  path_default_intensity: z.enum(['thorough', 'standard', 'light']).optional(),

  provider_selection_strategy: z
    .enum(['reliability', 'random', 'round-robin'])
    .optional(),
  provider_exploration_rate: z.number().min(0).max(1).optional(),

  intensity_provider_counts: z
    .object({
      thorough: z.number().int().min(1),
      standard: z.number().int().min(1),
      light: z.number().int().min(1),
    })
    .optional(),
  intensity_timeouts: z
    .object({
      thorough: z.number().int().min(1000),
      standard: z.number().int().min(1000),
      light: z.number().int().min(1000),
    })
    .optional(),
  intensity_prompt_depth: z
    .object({
      thorough: z.enum(['detailed', 'standard', 'brief']),
      standard: z.enum(['detailed', 'standard', 'brief']),
      light: z.enum(['detailed', 'standard', 'brief']),
    })
    .optional(),

  min_confidence: z.number().min(0).max(1).optional(),
  confidence_threshold: z
    .object({
      critical: z.number().min(0).max(1).optional(),
      major: z.number().min(0).max(1).optional(),
      minor: z.number().min(0).max(1).optional(),
    })
    .optional(),
  consensus_required_for_critical: z.boolean().optional(),
  consensus_min_agreement: z.number().int().min(2).optional(),
  suggestion_syntax_validation: z.boolean().optional(),
  update_pr_description: z.boolean().optional(),
  fail_on_severity: z.enum(['off', 'critical', 'major', 'minor']).optional(),
  review_thread_lifecycle: z.string().optional(),
  review_thread_lifecycle_max_targets: z
    .number()
    .int()
    .min(0)
    .max(25)
    .optional(),
  review_thread_lifecycle_resolve_confidence: z
    .object({
      critical: z.number().min(0).max(1).optional(),
      major: z.number().min(0).max(1).optional(),
      minor: z.number().min(0).max(1).optional(),
      unknown: z.number().min(0).max(1).optional(),
    })
    .optional(),

  dry_run: z.boolean().optional(),
});

export type ReviewConfigFile = z.infer<typeof ReviewConfigSchema>;
