import * as fs from 'fs';
import * as path from 'path';
import * as core from '../actions/core';
import { ReviewOrchestrator } from '../core/orchestrator';
import { ConfigLoader } from '../config/loader';
import { createComponents } from '../setup';
import { GitHubClient } from '../github/client';
import { CommentPoster } from '../github/comment-poster';
import { PullRequestLoader } from '../github/pr-loader';
import { formatBlockingFindingFailure } from '../output/severity-gate';
import { applyControlPlaneRuntimeConfig } from '../control-plane/runtime-config';
import { CodexOAuthControlPlaneClient, FetchLike } from './control-plane';
import { refreshCodexAuthWithOfficialCli } from './codex-bootstrap';
import { prepareCodexCliBeforeAuthRead } from './codex-cli';
import {
  applyCodexRotatingProviderSecretInputs,
  clearCodexRotatingOidcRequestEnv,
  clearCodexRotatingProviderSecretEnv,
  clearCodexRotatingProcessAuthEnv,
  hasCodexRotatingAuthInput,
  readCodexRotatingProviderSecretInputs,
  type CodexRotatingProviderSecretInputs,
} from './auth-input';
import { fetchGitHubRepositoryPublicKey } from './github-secrets';
import { GitHubActionsOidcTokenProvider } from './github-actions-oidc';
import {
  CodexOAuthReviewRuntimeMode,
  runCodexOAuthRotatingRuntime,
  type CodexOAuthReviewResult,
  type CodexOAuthV2ReviewRunnerPort,
} from './runtime';
import {
  createIsolatedCheckoutWorkspace,
  safeCheckoutRepository,
} from './safe-checkout';
import { buildReviewSummaryMetadata } from '../github/summary-metadata';
import {
  resolveReviewActionV2Activation,
  ReviewActionV2RuntimeMode,
  type ReviewActionV2Activation,
} from '../control-plane/review-action-v2-contract';
import { createProductionT0ReviewRunner } from '../review-orchestration/infrastructure/production-t0-review-runner';

export const CODEX_OAUTH_ROTATING_MODE = 'codex-oauth-rotating';
const SETUP_PULL_REQUEST_BRANCH = 'reviewrouter/setup';
const SETUP_PREVIEW_MISSING_AUTH_SKIP_REASON =
  'setup_pr_waiting_for_codex_auth';

export function shouldEnterCodexOAuthRotatingAction(input: {
  requestedMode: string | undefined;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return (
    input.requestedMode === CODEX_OAUTH_ROTATING_MODE &&
    (input.env ?? process.env).REVIEWROUTER_RUNTIME_CONFIG_MODE !== 'static'
  );
}

export async function runCodexOAuthRotatingAction(
  options: {
    fetchImpl?: FetchLike;
    reviewActionV2Activation?: ReviewActionV2Activation;
    v2ReviewRunner?: CodexOAuthV2ReviewRunnerPort;
  } = {}
): Promise<void> {
  const inputs = readCodexOAuthActionInputs();
  const reviewActionV2Activation =
    options.reviewActionV2Activation ??
    resolveReviewActionV2Activation({ env: process.env });
  clearCodexRotatingProviderSecretEnv();
  if (
    shouldSkipCodexOAuthSetupPreviewWithoutAuth({
      eventName: inputs.eventName,
      headRef: inputs.headRef,
    })
  ) {
    clearCodexRotatingProcessAuthEnv();
    core.setOutput('reviewrouter_state', 'skipped');
    core.setOutput(
      'reviewrouter_skipped_reason',
      SETUP_PREVIEW_MISSING_AUTH_SKIP_REASON
    );
    core.info(
      'Skipping ReviewRouter Codex OAuth setup PR preview until REVIEWROUTER_CODEX_AUTH_JSON is configured after merge.'
    );
    return;
  }
  const controlPlane = new CodexOAuthControlPlaneClient({
    apiUrl: inputs.apiUrl,
    fetchImpl: options.fetchImpl,
  });
  const sharedRuntimePorts = {
    oidc: new GitHubActionsOidcTokenProvider({
      fetchImpl: options.fetchImpl,
    }),
    controlPlane: {
      prelease: (input: Parameters<typeof controlPlane.prelease>[0]) =>
        controlPlane.prelease(input),
      finalize: (input: Parameters<typeof controlPlane.finalize>[0]) =>
        controlPlane.finalize(input),
      writebackPreflight: (
        input: Parameters<typeof controlPlane.writebackPreflight>[0]
      ) => controlPlane.writebackPreflight(input),
      writeback: (input: Parameters<typeof controlPlane.writeback>[0]) =>
        controlPlane.writeback(input),
      checkoutToken: (
        input: Parameters<typeof controlPlane.checkoutToken>[0]
      ) => controlPlane.checkoutToken(input),
    },
    githubSecrets: {
      fetchPublicKey: (input: { owner: string; repo: string; token: string }) =>
        fetchGitHubRepositoryPublicKey({
          ...input,
          fetchImpl: options.fetchImpl,
        }),
    },
    codex: {
      prepareCli: () =>
        prepareCodexCliBeforeAuthRead({
          logger: {
            info: core.info,
            warn: (message) => core.warning(message),
          },
        }),
      refreshAuth: (input: {
        authJsonBytes: string;
        codexBinaryPath?: string;
      }) =>
        refreshCodexAuthWithOfficialCli({
          authJsonBytes: input.authJsonBytes,
          codexBinaryPath: input.codexBinaryPath,
          logger: {
            info: core.info,
            warn: (message) => core.warning(message),
          },
        }),
    },
    checkout: {
      checkoutExactHead: safeCheckoutRepository,
    },
    lifecycle: {
      clearOidcEnv: () => clearCodexRotatingOidcRequestEnv(),
      clearProcessAuthEnv: () => clearCodexRotatingProcessAuthEnv(),
    },
  };
  const t0WorkspacePath =
    reviewActionV2Activation.mode === ReviewActionV2RuntimeMode.T0
      ? await createIsolatedCheckoutWorkspace({
          runnerTempPath: process.env.RUNNER_TEMP,
          githubWorkspacePath: inputs.workspacePath,
        })
      : null;
  try {
    const runtime =
      reviewActionV2Activation.mode === ReviewActionV2RuntimeMode.T0
        ? await runCodexOAuthRotatingRuntime(
            {
              ...inputs,
              workspacePath: t0WorkspacePath!,
              reviewMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
            },
            {
              ...sharedRuntimePorts,
              v2Review:
                options.v2ReviewRunner ??
                createProductionT0ReviewRunner({
                  fetchImpl: options.fetchImpl,
                }),
            }
          )
        : await runCodexOAuthRotatingRuntime(inputs, {
            ...sharedRuntimePorts,
            controlPlane: {
              ...sharedRuntimePorts.controlPlane,
              commentToken: (
                input: Parameters<typeof controlPlane.commentToken>[0]
              ) => controlPlane.commentToken(input),
            },
            review: {
              run: (input) =>
                runReviewComputation({
                  apiUrl: inputs.apiUrl,
                  audience: inputs.audience,
                  checkoutToken: input.checkoutToken,
                  codexHome: input.codexHome,
                  codexBinaryPath: input.codexBinaryPath,
                  fetchImpl: options.fetchImpl,
                  providerSecrets: readCodexRotatingProviderSecretInputs(),
                }),
            },
            comments: {
              post: (input) =>
                postReviewAfterAuthClear({
                  commentToken: input.commentToken,
                  review: input.review,
                }),
            },
          });

    core.setOutput('reviewrouter_state', runtime.status);
    if (runtime.status === 'skipped') {
      core.setOutput('reviewrouter_skipped_reason', runtime.reason);
      if (runtime.reason === 'max_changed_lines_exceeded') {
        core.info(
          `ReviewRouter skipped PR #${inputs.pullRequestNumber}: ${runtime.changedLines} changed lines exceed the configured maximum of ${runtime.maxChangedLines}.`
        );
        return;
      }
      const message =
        runtime.reason === 'stale_queued_secret'
          ? 'Codex OAuth rotating review did not run because this workflow restored an older queued secret generation. Re-run the latest workflow after reconnecting Codex if needed.'
          : `Codex OAuth rotating review skipped: ${runtime.reason}`;
      core.setFailed(message);
      return;
    }
    if ('v2Review' in runtime) {
      core.setOutput('reviewrouter_v2_outcome', runtime.v2Review.outcome);
      if (runtime.v2Review.blockingFailure) {
        core.setFailed(runtime.v2Review.blockingFailure);
      }
      return;
    }
    if (runtime.review.blockingFailure) {
      core.setFailed(runtime.review.blockingFailure);
    }
  } finally {
    if (t0WorkspacePath) {
      fs.rmSync(t0WorkspacePath, { recursive: true, force: true });
    }
  }
}

function readCodexOAuthActionInputs() {
  const apiUrl = resolveCodexOAuthActionApiUrl();
  const providerInstanceId = readInput('provider-instance-id');
  const workflowSchemaVersion = Number(readInput('workflow-schema-version'));
  const audience = readInput('audience') || 'reviewrouter';
  const event = readPullRequestEvent();
  if (!apiUrl) {
    throw new Error('codex_oauth_api_url_missing');
  }
  if (!providerInstanceId) {
    throw new Error('codex_oauth_provider_instance_id_missing');
  }
  if (!Number.isInteger(workflowSchemaVersion) || workflowSchemaVersion <= 0) {
    throw new Error('codex_oauth_workflow_schema_version_invalid');
  }
  return {
    apiUrl,
    audience,
    providerInstanceId,
    workflowSchemaVersion,
    repository: event.repository,
    pullRequestNumber: event.number,
    headSha: event.headSha,
    headRef: event.headRef,
    eventName: event.eventName,
    workspacePath: process.env.GITHUB_WORKSPACE || process.cwd(),
  };
}

export function resolveCodexOAuthActionApiUrl(
  env: NodeJS.ProcessEnv = process.env
): string {
  return (
    readInputFromEnv('control-plane-url', env) ||
    readInputFromEnv('api-url', env) ||
    readEnvFrom('REVIEWROUTER_CONTROL_PLANE_URL', env) ||
    readEnvFrom('REVIEWROUTER_API_URL', env)
  );
}

export function shouldSkipCodexOAuthSetupPreviewWithoutAuth(input: {
  eventName: string;
  headRef: string;
}): boolean {
  return (
    input.eventName === 'pull_request' &&
    input.headRef === SETUP_PULL_REQUEST_BRANCH &&
    !hasCodexRotatingAuthInput()
  );
}

async function runReviewComputation(input: {
  apiUrl: string;
  audience: string;
  checkoutToken: string;
  codexHome: string;
  codexBinaryPath?: string;
  fetchImpl?: FetchLike;
  providerSecrets: CodexRotatingProviderSecretInputs;
}) {
  const previousCodexHome = process.env.CODEX_HOME;
  const previousCodexBinary = process.env.REVIEWROUTER_CODEX_BINARY;
  const previousCodexHealthCheckMode = process.env.CODEX_HEALTHCHECK_MODE;
  const previousPath = process.env.PATH;
  const previousProgress = process.env.REVIEW_ROUTER_PROGRESS_COMMENTS;
  try {
    process.env.CODEX_HOME = input.codexHome;
    process.env.CODEX_HEALTHCHECK_MODE = 'binary';
    if (input.codexBinaryPath) {
      process.env.REVIEWROUTER_CODEX_BINARY = input.codexBinaryPath;
      const codexBinDir = path.dirname(input.codexBinaryPath);
      process.env.PATH = previousPath
        ? `${codexBinDir}${path.delimiter}${previousPath}`
        : codexBinDir;
    }
    process.env.REVIEW_ROUTER_PROGRESS_COMMENTS = 'never';

    await applyCodexRotatingReviewRuntimeConfig({
      apiUrl: input.apiUrl,
      audience: input.audience,
      fetchImpl: input.fetchImpl,
    });
    process.env.CODEX_HEALTHCHECK_MODE = 'binary';
    applyCodexRotatingProviderSecretInputs(input.providerSecrets);

    const config = ConfigLoader.load();
    const userDryRun = config.dryRun;
    config.dryRun = true;
    const components = await createComponents(config, input.checkoutToken);
    const prNumber = readPullRequestEvent().number;
    const review = await new ReviewOrchestrator(components).execute(prNumber);

    if (review) {
      core.setOutput('findings_count', review.findings.length);
      core.setOutput(
        'critical_count',
        review.findings.filter((finding) => finding.severity === 'critical')
          .length
      );
      core.setOutput('cost_usd', review.metrics.totalCost.toFixed(4));
      core.setOutput('total_cost', review.metrics.totalCost.toFixed(4));
      if (review.aiAnalysis) {
        core.setOutput('ai_likelihood', review.aiAnalysis.averageLikelihood);
      }
    }

    return {
      skipped: !review,
      userDryRun,
      review: review ?? undefined,
      markdown: review ? components.formatter.format(review) : '',
      blockingFailure: review
        ? formatBlockingFindingFailure(
            review,
            ConfigLoader.load().failOnSeverity
          )
        : undefined,
    };
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousProgress === undefined) {
      delete process.env.REVIEW_ROUTER_PROGRESS_COMMENTS;
    } else {
      process.env.REVIEW_ROUTER_PROGRESS_COMMENTS = previousProgress;
    }
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousCodexHealthCheckMode === undefined) {
      delete process.env.CODEX_HEALTHCHECK_MODE;
    } else {
      process.env.CODEX_HEALTHCHECK_MODE = previousCodexHealthCheckMode;
    }
    if (previousCodexBinary === undefined) {
      delete process.env.REVIEWROUTER_CODEX_BINARY;
    } else {
      process.env.REVIEWROUTER_CODEX_BINARY = previousCodexBinary;
    }
    clearCodexRotatingProviderSecretEnv();
  }
}

export async function applyCodexRotatingReviewRuntimeConfig(input: {
  apiUrl: string;
  audience: string;
  fetchImpl?: FetchLike;
}): Promise<void> {
  if (process.env.REVIEWROUTER_RUNTIME_CONFIG_MODE === 'static') {
    process.env.REVIEWROUTER_API_URL ||= input.apiUrl;
    process.env.REVIEWROUTER_STATIC_CONFIG_FALLBACK = 'false';
    return;
  }

  process.env.REVIEWROUTER_RUNTIME_CONFIG_MODE = 'oidc';
  process.env.REVIEWROUTER_API_URL = input.apiUrl;
  process.env.REVIEWROUTER_OIDC_AUDIENCE = input.audience;
  process.env.REVIEWROUTER_STATIC_CONFIG_FALLBACK = 'false';

  await applyControlPlaneRuntimeConfig({
    fetchImpl: input.fetchImpl,
    logger: {
      info: core.info,
      warn: (message) => core.warning(message),
    },
  });
}

export async function postReviewAfterAuthClear(input: {
  commentToken: string;
  review: CodexOAuthReviewResult;
}): Promise<void> {
  if (
    input.review.skipped ||
    input.review.userDryRun ||
    !input.review.markdown
  ) {
    return;
  }
  const prNumber = readPullRequestEvent().number;
  const config = ConfigLoader.load();
  const githubClient = new GitHubClient(input.commentToken);
  const poster = new CommentPoster(githubClient, false, config);
  const pr = await new PullRequestLoader(githubClient).load(prNumber);
  if (pr.headSha.toLowerCase() !== input.review.reviewedHeadSha.toLowerCase()) {
    core.warning(
      `Skipping Codex OAuth review publication because PR #${prNumber} advanced from ${input.review.reviewedHeadSha} to ${pr.headSha}`
    );
    return;
  }
  const summaryMetadata = buildReviewSummaryMetadata({
    reviewedHeadSha: input.review.reviewedHeadSha,
    lifecycleMode: config.reviewThreadLifecycle,
  });
  const summaryResult = await poster.postSummary(
    prNumber,
    input.review.markdown,
    true,
    summaryMetadata
  );
  if (summaryResult.skippedStale) {
    return;
  }
  const review = input.review.review;
  if (!review) {
    return;
  }
  await poster.postInline(
    prNumber,
    review.inlineComments,
    pr.files,
    input.review.reviewedHeadSha
  );
}

export function readPullRequestEvent(): {
  repository: string;
  number: number;
  headSha: string;
  headRef: string;
  eventName: string;
} {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error('codex_oauth_github_event_path_missing');
  }
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8')) as {
    repository?: { full_name?: unknown };
    inputs?: { pr_number?: unknown; review_head_sha?: unknown };
    pull_request?: {
      number?: unknown;
      head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } };
    };
  };
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  const workflowDispatch = eventName === 'workflow_dispatch';
  const repository =
    event.repository?.full_name || process.env.GITHUB_REPOSITORY;
  const rawPrNumber =
    event.pull_request?.number ||
    event.inputs?.pr_number ||
    readEnv('PR_NUMBER');
  const prNumber =
    typeof rawPrNumber === 'number'
      ? rawPrNumber
      : typeof rawPrNumber === 'string' && /^[1-9][0-9]*$/.test(rawPrNumber)
        ? Number(rawPrNumber)
        : null;
  const headRepository =
    event.pull_request?.head?.repo?.full_name ||
    (workflowDispatch ? repository : undefined);
  const headSha =
    event.pull_request?.head?.sha ||
    event.inputs?.review_head_sha ||
    readEnv('REVIEW_HEAD_SHA');
  const headRef = event.pull_request?.head?.ref;
  if (
    typeof repository !== 'string' ||
    typeof headRepository !== 'string' ||
    repository !== headRepository
  ) {
    throw new Error('codex_oauth_pull_request_must_be_same_repository');
  }
  if (typeof prNumber !== 'number' || !Number.isInteger(prNumber)) {
    throw new Error('codex_oauth_pr_number_invalid');
  }
  if (typeof headSha !== 'string' || !/^[a-f0-9]{40}$/i.test(headSha)) {
    throw new Error('codex_oauth_head_sha_invalid');
  }
  return {
    repository,
    number: prNumber,
    headSha,
    headRef: typeof headRef === 'string' ? headRef : '',
    eventName,
  };
}

function readInput(name: string): string {
  const direct = core.getInput(name);
  if (direct) return direct.trim();
  return readInputFromEnv(name, process.env);
}

function readEnv(name: string): string {
  return readEnvFrom(name, process.env);
}

function readInputFromEnv(name: string, env: NodeJS.ProcessEnv): string {
  return (
    env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`]?.trim() ||
    env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`]?.trim() ||
    ''
  );
}

function readEnvFrom(name: string, env: NodeJS.ProcessEnv): string {
  return env[name]?.trim() || '';
}
