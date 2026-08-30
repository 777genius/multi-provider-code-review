import * as core from './actions/core';
import * as fs from 'fs';
import { ConfigLoader } from './config/loader';
import { createComponents } from './setup';
import { ReviewOrchestrator } from './core/orchestrator';
import {
  validateRequired,
  validatePositiveInteger,
  ValidationError,
  formatValidationError,
} from './utils/validation';
import {
  clearReviewFailureSummaries,
  postReviewFailureSummary,
} from './github/failure-summary';
import {
  formatActionError,
  normalizeReviewError,
} from './errors/review-router-error';
import { GitHubClient } from './github/client';
import { ReviewLedger } from './github/ledger';
import {
  parseInteractionCommand,
  ReviewInteractionHandler,
} from './github/interaction';
import {
  loadDiscussionOptionsFromEnv,
  ReviewDiscussionHandler,
} from './github/discussion';
import { CodexDiscussionResponder } from './discussion/codex-responder';
import {
  applyControlPlaneRuntimeConfig,
  RuntimeConfigResult,
} from './control-plane/runtime-config';
import { resolveGitHubCommentToken } from './control-plane/comment-token';
import { createRotatingCommentTokenProvider } from './control-plane/rotating-comment-token';
import { GitHubTokenProvider } from './github/token-provider';
import { reportControlPlaneActionHealth } from './control-plane/health-report';
import { ControlPlaneMemoryClient } from './control-plane/memory';
import { resolveProviderCliPlan } from './control-plane/provider-cli-plan';
import { parseMemoryInteraction } from './github/memory-interaction';
import { ControlPlaneManualReviewRequestClient } from './control-plane/review-request';
import { countPreviousStillValidBySeverity } from './analysis/thread-lifecycle';
import { formatBlockingFindingFailure } from './output/severity-gate';
import {
  runCodexOAuthRotatingAction,
  shouldEnterCodexOAuthRotatingAction,
} from './codex-oauth/action';
import { scrubAndAssertReviewActionV2ScmMutationEnv } from './codex-oauth/auth-input';
import {
  resolveReviewActionV2Activation,
  ReviewActionV2RuntimeMode,
} from './control-plane/review-action-v2-contract';
import { isReviewPathShardRequested } from './review-execution/domain';

function syncEnvFromInputs(): void {
  const inputKeys = [
    'REVIEW_ROUTER_MODE',
    'REVIEW_ROUTER_LEDGER_KEY',
    'REVIEW_ROUTER_ALLOW_AUTHOR_SKIP',
    'REVIEW_ROUTER_REVIEW_WORKFLOW_FILE',
    'REVIEW_ROUTER_DISCUSSION_MODE',
    'REVIEW_ROUTER_DISCUSSION_MAX_PER_PR',
    'REVIEW_ROUTER_DISCUSSION_MAX_PER_THREAD',
    'REVIEW_ROUTER_DISCUSSION_TIMEOUT_SECONDS',
    'REVIEW_ROUTER_MEMORY_ENABLED',
    'REVIEW_ROUTER_MEMORY_PROTOCOL_VERSION',
    'REVIEW_ROUTER_MEMORY_BUNDLE_ENDPOINT',
    'REVIEW_ROUTER_MEMORY_CANDIDATE_ENDPOINT',
    'REVIEW_ROUTER_MEMORY_COMMAND_ENDPOINT',
    'REVIEW_PROVIDERS',
    'FALLBACK_PROVIDERS',
    'SYNTHESIS_MODEL',
    'CODEX_MODEL',
    'CLAUDE_MODEL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'INLINE_MAX_COMMENTS',
    'INLINE_MIN_SEVERITY',
    'INLINE_MIN_AGREEMENT',
    'MIN_CHANGED_LINES',
    'MAX_CHANGED_FILES',
    'SKIP_LABELS',
    'PROVIDER_LIMIT',
    'REQUIRED_HEALTHY_PROVIDERS',
    'PROVIDER_RETRIES',
    'PROVIDER_MAX_PARALLEL',
    'CODEX_HEALTHCHECK_MODE',
    'CODEX_HEALTHCHECK_REASONING_EFFORT',
    'CODEX_REASONING_EFFORT',
    'CODEX_AGENTIC_CONTEXT',
    'CODEX_EVENT_AUDIT',
    'FAIL_ON_NO_HEALTHY_PROVIDERS',
    'QUIET_MODE_ENABLED',
    'QUIET_MIN_CONFIDENCE',
    'QUIET_USE_LEARNING',
    'LEARNING_ENABLED',
    'LEARNING_MIN_FEEDBACK_COUNT',
    'DIFF_MAX_BYTES',
    'SMART_DIFF_COMPACTION',
    'MAX_FULL_DIFF_FILE_BYTES',
    'MAX_FULL_DIFF_FILE_CHANGES',
    'ENABLE_TOKEN_AWARE_BATCHING',
    'TARGET_TOKENS_PER_BATCH',
    'RUN_TIMEOUT_SECONDS',
    'OPENROUTER_TIMEOUT_SECONDS',
    'BUDGET_MAX_USD',
    'ENABLE_AST_ANALYSIS',
    'ENABLE_SECURITY',
    'ENABLE_CACHING',
    'ENABLE_TEST_HINTS',
    'ENABLE_AI_DETECTION',
    'INCREMENTAL_ENABLED',
    'INCREMENTAL_CACHE_TTL_DAYS',
    'GRAPH_ENABLED',
    'GRAPH_CACHE_ENABLED',
    'GRAPH_MAX_DEPTH',
    'GRAPH_TIMEOUT_SECONDS',
    'SKIP_TRIVIAL_CHANGES',
    'SKIP_DEPENDENCY_UPDATES',
    'SKIP_DOCUMENTATION_ONLY',
    'SKIP_FORMATTING_ONLY',
    'SKIP_TEST_FIXTURES',
    'SKIP_CONFIG_FILES',
    'SKIP_BUILD_ARTIFACTS',
    'TRIVIAL_PATTERNS',
    'PATH_BASED_INTENSITY',
    'PATH_INTENSITY_PATTERNS',
    'PATH_DEFAULT_INTENSITY',
    'MIN_CONFIDENCE',
    'CONSENSUS_REQUIRED_FOR_CRITICAL',
    'CONSENSUS_MIN_AGREEMENT',
    'SUGGESTION_SYNTAX_VALIDATION',
    'UPDATE_PR_DESCRIPTION',
    'REVIEW_ROUTER_PROGRESS_COMMENTS',
    'FAIL_ON_CRITICAL',
    'FAIL_ON_MAJOR',
    'FAIL_ON_SEVERITY',
    'REPORT_BASENAME',
    'DRY_RUN',
    'REVIEWROUTER_COMMENT_TOKEN_MODE',
    'REVIEW_THREAD_LIFECYCLE',
    'REVIEW_THREAD_LIFECYCLE_MAX_TARGETS',
    'REVIEW_THREAD_LIFECYCLE_RESOLVE_CONFIDENCE',
    'REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN',
    'REVIEW_THREAD_LIFECYCLE_TRUSTED_AUTHORS',
    'REVIEW_ROUTER_TRUSTED_BOT_AUTHORS',
    'REVIEW_APP_SLUG',
    'REVIEW_APP_BOT_LOGIN',
    'REVIEW_ROUTER_APP_SLUG',
    'REVIEW_ROUTER_APP_BOT_LOGIN',
    'REVIEWROUTER_ACTION_V2_MODE',
  ];

  for (const key of inputKeys) {
    const value = core.getInput(key);
    if (value && !process.env[key]) {
      process.env[key] = value;
    }
  }

  const reviewFocusProfile = core.getInput('review-focus-profile');
  if (reviewFocusProfile && !process.env.REVIEW_FOCUS_PROFILE) {
    process.env.REVIEW_FOCUS_PROFILE = reviewFocusProfile;
  }
}

async function run(): Promise<void> {
  let token: string | undefined;
  let githubTokenProvider: GitHubTokenProvider | undefined;
  let prNumber: number | undefined;
  let runtimeConfig: RuntimeConfigResult | undefined;
  let pathShardRequested = false;
  const startedAt = new Date();

  try {
    syncEnvFromInputs();
    pathShardRequested = isReviewPathShardRequested();
    const reviewActionV2Activation = resolveReviewActionV2Activation({
      env: process.env,
    });
    if (reviewActionV2Activation.mode === ReviewActionV2RuntimeMode.T0) {
      scrubAndAssertReviewActionV2ScmMutationEnv(process.env);
    }
    const requestedMode =
      core.getInput('mode') ||
      process.env.REVIEW_ROUTER_MODE ||
      core.getInput('REVIEW_ROUTER_MODE');
    const lifecycleResolveTokenFromEnv =
      process.env.REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN?.trim() || undefined;
    if (lifecycleResolveTokenFromEnv) {
      core.setSecret(lifecycleResolveTokenFromEnv);
      delete process.env.REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN;
    }
    const entersCodexOAuthRotatingAction = shouldEnterCodexOAuthRotatingAction({
      requestedMode,
      env: process.env,
    });
    if (
      reviewActionV2Activation.mode === ReviewActionV2RuntimeMode.T0 &&
      !entersCodexOAuthRotatingAction
    ) {
      throw new Error('review_action_v2_requires_codex_oauth_rotating');
    }
    if (entersCodexOAuthRotatingAction) {
      await runCodexOAuthRotatingAction({ reviewActionV2Activation });
      return;
    }
    runtimeConfig = await applyControlPlaneRuntimeConfig({
      logger: {
        info: core.info,
        warn: (message) => core.warning(message),
      },
    });

    const mode = requestedMode;
    if (mode === 'runtime-preflight') {
      runRuntimePreflight(runtimeConfig);
      return;
    }

    token = core.getInput('GITHUB_TOKEN') || process.env.GITHUB_TOKEN;

    validateRequired(token, 'GITHUB_TOKEN');
    const commentToken = await resolveGitHubCommentToken({
      fallbackToken: token!,
      runtimeConfig,
      logger: {
        info: core.info,
        warn: (message) => core.warning(message),
      },
    });
    const fallbackToken = token;
    token = commentToken.token;
    githubTokenProvider = createRotatingCommentTokenProvider({
      initialToken: token,
      onToken: (refreshedToken) => core.setSecret(refreshedToken),
    });
    const lifecycleResolveToken = lifecycleResolveTokenFromEnv || fallbackToken;
    if (
      lifecycleResolveTokenFromEnv &&
      lifecycleResolveTokenFromEnv !== token &&
      lifecycleResolveTokenFromEnv !== fallbackToken
    ) {
      core.setSecret(lifecycleResolveTokenFromEnv);
    }
    process.env.REVIEW_ROUTER_COMMENT_TOKEN_STATUS = githubTokenProvider
      ? 'rotating'
      : commentToken.status;

    if (mode === 'interaction') {
      await runInteraction(token!, fallbackToken, runtimeConfig);
      return;
    }
    if (mode === 'interaction-preflight') {
      await runInteractionPreflight(token!);
      return;
    }

    const config = ConfigLoader.load();
    const components = await createComponents(config, token!, {
      fallbackGithubToken: lifecycleResolveToken,
      runtimeConfig,
      githubTokenProvider,
    });
    const orchestrator = new ReviewOrchestrator(components);

    const prInput = core.getInput('PR_NUMBER') || process.env.PR_NUMBER;
    validateRequired(prInput, 'PR_NUMBER');

    prNumber = validatePositiveInteger(prInput, 'PR_NUMBER');

    if (config.dryRun) {
      core.info(
        '🔍 DRY RUN MODE - Review will run but no comments will be posted'
      );
    }

    core.info(`Starting review for PR #${prNumber}`);
    const review = await orchestrator.execute(prNumber);

    if (!review) {
      core.info('Review skipped');
      if (pathShardRequested) {
        core.info(
          'Skipping shared failure-summary cleanup for isolated review path shard'
        );
      } else {
        await clearReviewFailureSummaries(
          await currentGitHubToken(token, githubTokenProvider),
          prNumber
        );
      }
      await reportControlPlaneActionHealth({
        runtimeConfig,
        review,
        startedAt,
        logger: {
          info: core.info,
          warn: (message) => core.warning(message),
        },
      });
      return;
    }

    if (pathShardRequested) {
      core.info(
        'Skipping shared failure-summary cleanup for isolated review path shard'
      );
    } else {
      await clearReviewFailureSummaries(
        await currentGitHubToken(token, githubTokenProvider),
        prNumber
      );
    }

    const previousStillValidCounts = countPreviousStillValidBySeverity(
      review.threadLifecycle
    );
    const previousStillValidTotal =
      previousStillValidCounts.critical +
      previousStillValidCounts.major +
      previousStillValidCounts.minor;
    core.setOutput(
      'findings_count',
      review.findings.length + previousStillValidTotal
    );
    core.setOutput(
      'critical_count',
      review.findings.filter((f) => f.severity === 'critical').length +
        previousStillValidCounts.critical
    );
    core.setOutput('cost_usd', review.metrics.totalCost.toFixed(4));
    core.setOutput('total_cost', review.metrics.totalCost.toFixed(4));
    if (review.aiAnalysis) {
      core.setOutput('ai_likelihood', review.aiAnalysis.averageLikelihood);
    }

    const blockingFailure = formatBlockingFindingFailure(
      review,
      config.failOnSeverity
    );
    if (blockingFailure) {
      await reportControlPlaneActionHealth({
        runtimeConfig,
        review,
        startedAt,
        logger: {
          info: core.info,
          warn: (message) => core.warning(message),
        },
      });
      core.setFailed(blockingFailure);
      return;
    }

    await reportControlPlaneActionHealth({
      runtimeConfig,
      review,
      startedAt,
      logger: {
        info: core.info,
        warn: (message) => core.warning(message),
      },
    });
    core.info('Review completed successfully');
  } catch (error) {
    const presentableError =
      error instanceof ValidationError
        ? new Error(`Configuration error:\n${formatValidationError(error)}`)
        : error;
    const normalizedError = normalizeReviewError(presentableError);

    core.setFailed(formatActionError(normalizedError));

    if (pathShardRequested) {
      core.info(
        'Skipping shared failure-summary publication for isolated review path shard'
      );
    } else {
      await postReviewFailureSummary(
        normalizedError,
        await currentGitHubToken(token, githubTokenProvider),
        prNumber
      );
    }
    await reportControlPlaneActionHealth({
      runtimeConfig,
      error: normalizedError,
      startedAt,
      logger: {
        info: core.info,
        warn: (message) => core.warning(message),
      },
    });

    // core.setFailed() sets process.exitCode, so explicit process.exit() is unnecessary
    // Removed process.exit(1) to allow proper cleanup and resource disposal
  }
}

async function currentGitHubToken(
  fallbackToken: string | undefined,
  tokenProvider: GitHubTokenProvider | undefined
): Promise<string | undefined> {
  if (!tokenProvider) return fallbackToken;
  try {
    return await tokenProvider.getToken();
  } catch {
    return fallbackToken;
  }
}

function runRuntimePreflight(
  runtimeConfig: RuntimeConfigResult | undefined
): void {
  const plan = resolveProviderCliPlan(process.env);
  core.setOutput('runtime_config_status', runtimeConfig?.status || 'unknown');
  core.setOutput('codex_cli_needed', plan.codexCliNeeded ? 'true' : 'false');
  core.setOutput(
    'codex_oauth_needed',
    plan.codexOauthNeeded ? 'true' : 'false'
  );
  core.setOutput('claude_cli_needed', plan.claudeCliNeeded ? 'true' : 'false');
  core.info(
    `ReviewRouter runtime preflight: status=${runtimeConfig?.status || 'unknown'}, codex_cli_needed=${plan.codexCliNeeded}, codex_oauth_needed=${plan.codexOauthNeeded}, claude_cli_needed=${plan.claudeCliNeeded}.`
  );
}

async function runInteraction(
  token: string,
  actionsToken?: string,
  runtimeConfig?: RuntimeConfigResult
): Promise<void> {
  const githubClient = new GitHubClient(token);
  const actionsClient =
    actionsToken && actionsToken !== token
      ? new GitHubClient(actionsToken)
      : githubClient;
  const ledger = new ReviewLedger(
    githubClient,
    process.env.REVIEW_ROUTER_LEDGER_KEY,
    /^true$/i.test(process.env.DRY_RUN || '')
  );
  const discussionHandler = createDiscussionHandler(githubClient);
  const memoryClient = new ControlPlaneMemoryClient(runtimeConfig);
  const reviewRequests = new ControlPlaneManualReviewRequestClient(
    runtimeConfig
  );
  const handler = new ReviewInteractionHandler(
    githubClient,
    ledger,
    discussionHandler,
    actionsClient,
    memoryClient,
    reviewRequests
  );
  await handler.execute();
}

async function runInteractionPreflight(token: string): Promise<void> {
  const githubClient = new GitHubClient(token);
  const discussionHandler = createDiscussionHandler(githubClient);
  const payload = JSON.parse(
    fs.readFileSync(process.env.GITHUB_EVENT_PATH || '', 'utf8')
  );
  const body = String(payload?.comment?.body || '');
  const botComment =
    payload?.comment?.user?.type === 'Bot' ||
    String(payload?.comment?.user?.login || '').endsWith('[bot]');
  const command = parseInteractionCommand(body);
  const memoryInteraction = parseMemoryInteraction(body);
  const memoryRequest =
    memoryInteraction.instructions.length > 0 ||
    Boolean(memoryInteraction.invalidReason);
  const result = botComment
    ? {
        shouldRun: false,
        needsDiscussion: false,
        reason: 'bot comment',
      }
    : command
      ? {
          shouldRun: true,
          needsDiscussion: false,
          reason: 'ReviewRouter command',
        }
      : memoryRequest
        ? {
            shouldRun: true,
            needsDiscussion: false,
            reason: 'ReviewRouter memory request',
          }
        : await discussionHandler.preflight(payload);

  core.setOutput('should_run', result.shouldRun ? 'true' : 'false');
  core.setOutput('needs_discussion', result.needsDiscussion ? 'true' : 'false');
  core.setOutput('reason', result.reason);
  core.info(
    `Interaction preflight: should_run=${result.shouldRun}, needs_discussion=${result.needsDiscussion}, reason=${result.reason}`
  );
}

function createDiscussionHandler(
  githubClient: GitHubClient
): ReviewDiscussionHandler {
  const options = loadDiscussionOptionsFromEnv();
  const model = process.env.CODEX_MODEL || 'gpt-5.6-sol';
  const timeoutSeconds = parsePositiveInteger(
    process.env.REVIEW_ROUTER_DISCUSSION_TIMEOUT_SECONDS,
    60
  );
  const responder =
    options.mode === 'off'
      ? undefined
      : new CodexDiscussionResponder(model, timeoutSeconds * 1000);

  return new ReviewDiscussionHandler(githubClient, responder, options);
}

function parsePositiveInteger(
  value: string | undefined,
  defaultValue: number
): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

// core.setFailed() in run() sets process.exitCode, so we don't need explicit process.exit()
// This allows proper cleanup and is the recommended pattern for GitHub Actions
run().catch((error) => {
  core.setFailed(`Unhandled error: ${error.message}`);
});
