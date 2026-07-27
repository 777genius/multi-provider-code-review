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
  CodexOAuthV2ReviewOutcome,
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

export interface CodexOAuthTerminalOutcomeReporterPort {
  post(input: CodexOAuthTerminalOutcomeReport): Promise<void>;
}

export type CodexOAuthTerminalOutcomeReport = {
  readonly marker: string;
  readonly body: string;
  readonly stepSummary: string;
  readonly logLabel: string;
  readonly commitStatus: {
    readonly state: 'error' | 'failure' | 'pending' | 'success';
    readonly description: string;
    readonly context: 'ReviewRouter';
    readonly targetUrl?: string;
  };
};

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
    terminalOutcomeReporter?: CodexOAuthTerminalOutcomeReporterPort;
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
  const terminalOutcomeOidcEnv = snapshotCodexOAuthTerminalOutcomeOidcEnv();
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
  const terminalOutcomeReporter =
    options.terminalOutcomeReporter ??
    createDefaultCodexOAuthTerminalOutcomeReporter({
      inputs,
      controlPlane,
      oidc: new GitHubActionsOidcTokenProvider({
        env: terminalOutcomeOidcEnv,
        fetchImpl: options.fetchImpl,
      }),
    });
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
      const report = buildSkippedTerminalOutcomeReport(inputs, runtime);
      appendTerminalOutcomeStepSummary(report);
      await publishTerminalOutcomeReportSafely(terminalOutcomeReporter, report);
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
      const report = buildV2TerminalOutcomeReport(inputs, runtime.v2Review);
      if (report) {
        appendTerminalOutcomeStepSummary(report);
        await publishTerminalOutcomeReportSafely(
          terminalOutcomeReporter,
          report
        );
      }
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

function buildSkippedTerminalOutcomeReport(
  inputs: ReturnType<typeof readCodexOAuthActionInputs>,
  runtime: Extract<CodexOAuthReviewResultLike, { status: 'skipped' }>
): CodexOAuthTerminalOutcomeReport {
  if (runtime.reason === 'max_changed_lines_exceeded') {
    return terminalOutcomeReport({
      inputs,
      kind: 'skipped',
      title: 'Review skipped ⚠️',
      summary:
        'ReviewRouter did not start a model review for this revision because the PR is larger than the configured safety limit.',
      rows: [
        ['Changed lines', runtime.changedLines.toLocaleString()],
        ['Configured limit', runtime.maxChangedLines.toLocaleString()],
        ['Model calls', '0'],
      ],
      note: 'No Codex tokens were consumed for review. Split the PR or raise REVIEW_ROUTER_MAX_CHANGED_LINES if this repository should review larger changes.',
      statusState: 'failure',
      statusDescription: 'Review skipped: PR exceeds configured safety limit.',
    });
  }

  const statusState =
    runtime.reason === 'github_put_failed' ||
    runtime.reason === 'permission_required'
      ? 'error'
      : 'failure';
  return terminalOutcomeReport({
    inputs,
    kind: 'skipped',
    title: 'Review skipped ⚠️',
    summary: skippedReasonSummary(runtime.reason),
    rows: [
      ['Reason', skippedReasonLabel(runtime.reason)],
      [
        'Model calls',
        runtime.reason === 'stale_queued_secret' ? '0' : 'not started',
      ],
    ],
    note:
      runtime.reason === 'stale_queued_secret'
        ? 'This run restored an older queued Codex auth generation. Re-run the newest workflow after reconnecting Codex if needed.'
        : 'ReviewRouter stopped before publishing review output.',
    statusState,
    statusDescription: `Review skipped: ${skippedReasonLabel(runtime.reason)}.`,
  });
}

type CodexOAuthReviewResultLike = Awaited<
  ReturnType<typeof runCodexOAuthRotatingRuntime>
>;

function buildV2TerminalOutcomeReport(
  inputs: ReturnType<typeof readCodexOAuthActionInputs>,
  review: {
    readonly outcome: CodexOAuthV2ReviewOutcome;
    readonly blockingFailure?: string;
  }
): CodexOAuthTerminalOutcomeReport | null {
  if (review.outcome === CodexOAuthV2ReviewOutcome.Completed) return null;
  if (review.outcome === CodexOAuthV2ReviewOutcome.Superseded) {
    return terminalOutcomeReport({
      inputs,
      kind: 'stale',
      title: 'Review superseded ⚠️',
      summary:
        'ReviewRouter stopped publishing this result because a newer PR revision exists.',
      rows: [
        ['Reviewed commit', shortSha(inputs.headSha)],
        ['Published findings', '0'],
      ],
      note: 'The newer workflow run should review the current head. This stale result was intentionally not used as approval evidence.',
      statusState: 'failure',
      statusDescription: 'Review superseded by a newer PR revision.',
    });
  }

  const laneBusy = review.blockingFailure === 'required_provider_lane_busy';
  return terminalOutcomeReport({
    inputs,
    kind: laneBusy ? 'lane-busy' : 'partial',
    title: laneBusy ? 'Review delayed ⚠️' : 'Review incomplete ⚠️',
    summary: laneBusy
      ? 'ReviewRouter could not complete required coverage because all required provider lanes were busy.'
      : 'ReviewRouter completed only partial coverage for this revision.',
    rows: [
      ['Outcome', 'partial'],
      [
        'Reason',
        laneBusy ? 'provider lanes busy' : 'required coverage incomplete',
      ],
    ],
    note: laneBusy
      ? 'Partial evidence is preserved for retry. This result is not an all-clear.'
      : 'Partial findings are withheld or marked incomplete so the result cannot be mistaken for approval.',
    statusState: laneBusy ? 'pending' : 'failure',
    statusDescription: laneBusy
      ? 'Review delayed: provider lanes are busy.'
      : 'Review incomplete: required coverage did not finish.',
  });
}

function terminalOutcomeReport(input: {
  readonly inputs: ReturnType<typeof readCodexOAuthActionInputs>;
  readonly kind: string;
  readonly title: string;
  readonly summary: string;
  readonly rows: readonly (readonly [string, string])[];
  readonly note: string;
  readonly statusState: 'error' | 'failure' | 'pending' | 'success';
  readonly statusDescription: string;
}): CodexOAuthTerminalOutcomeReport {
  const marker = `<!-- reviewrouter:codex-oauth:terminal:${input.inputs.headSha}:${input.kind} -->`;
  const targetUrl = githubRunUrl(input.inputs);
  const table = [
    '| Field | Value |',
    '|---|---|',
    ...input.rows.map(([field, value]) => `| ${field} | ${value} |`),
  ].join('\n');
  const visible = [
    `## ${input.title}`,
    '',
    input.summary,
    '',
    table,
    '',
    `<sub>${input.note}</sub>`,
  ].join('\n');
  return {
    marker,
    body: `${marker}\n\n${visible}`,
    stepSummary: visible,
    logLabel: input.kind,
    commitStatus: {
      state: input.statusState,
      description: truncateCommitStatusDescription(input.statusDescription),
      context: 'ReviewRouter',
      ...(targetUrl ? { targetUrl } : {}),
    },
  };
}

function appendTerminalOutcomeStepSummary(
  report: CodexOAuthTerminalOutcomeReport
): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    fs.appendFileSync(summaryPath, `\n${report.stepSummary}\n`, 'utf8');
  } catch (error) {
    core.warning(
      `ReviewRouter could not append ${report.logLabel} step summary: ${safeTerminalOutcomeError(error)}`
    );
  }
}

async function publishTerminalOutcomeReportSafely(
  reporter: CodexOAuthTerminalOutcomeReporterPort,
  report: CodexOAuthTerminalOutcomeReport
): Promise<void> {
  try {
    await reporter.post(report);
    core.info(`ReviewRouter published ${report.logLabel} PR status comment.`);
  } catch (error) {
    core.warning(
      `ReviewRouter could not publish ${report.logLabel} PR status comment: ${safeTerminalOutcomeError(error)}`
    );
  }
}

function createDefaultCodexOAuthTerminalOutcomeReporter(input: {
  readonly inputs: ReturnType<typeof readCodexOAuthActionInputs>;
  readonly controlPlane: CodexOAuthControlPlaneClient;
  readonly oidc: { requestToken(audience: string): Promise<string> };
}): CodexOAuthTerminalOutcomeReporterPort {
  return {
    async post(report) {
      const oidcToken = await input.oidc.requestToken(input.inputs.audience);
      const session = await input.controlPlane.actionSession({
        oidcToken,
        audience: input.inputs.audience,
      });
      const commentToken = await input.controlPlane.actionCommentToken({
        sessionToken: session.sessionToken,
      });
      await upsertTerminalOutcomePullRequestComment({
        repository: input.inputs.repository,
        pullRequestNumber: input.inputs.pullRequestNumber,
        token: commentToken.token,
        marker: report.marker,
        body: report.body,
      });
      await createTerminalOutcomeCommitStatusSafely({
        repository: input.inputs.repository,
        headSha: input.inputs.headSha,
        token: commentToken.token,
        status: report.commitStatus,
      });
    },
  };
}

function snapshotCodexOAuthTerminalOutcomeOidcEnv(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const snapshot: NodeJS.ProcessEnv = {};
  if (env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    snapshot.ACTIONS_ID_TOKEN_REQUEST_TOKEN =
      env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  }
  if (env.ACTIONS_ID_TOKEN_REQUEST_URL) {
    snapshot.ACTIONS_ID_TOKEN_REQUEST_URL = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  }
  return snapshot;
}

async function upsertTerminalOutcomePullRequestComment(input: {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly token: string;
  readonly marker: string;
  readonly body: string;
}): Promise<void> {
  const client = new GitHubClient(input.token);
  const [repositoryOwner, repositoryName] = input.repository.split('/');
  const owner = repositoryOwner || client.owner;
  const repo = repositoryName || client.repo;
  const comments = await client.octokit.paginate(
    client.octokit.rest.issues.listComments,
    {
      owner,
      repo,
      issue_number: input.pullRequestNumber,
      per_page: 100,
    }
  );
  const existing = comments.find((comment) =>
    (comment.body ?? '').includes(input.marker)
  );
  if (existing) {
    await client.octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body: input.body,
    });
    return;
  }
  await client.octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: input.pullRequestNumber,
    body: input.body,
  });
}

async function createTerminalOutcomeCommitStatusSafely(input: {
  readonly repository: string;
  readonly headSha: string;
  readonly token: string;
  readonly status: CodexOAuthTerminalOutcomeReport['commitStatus'];
}): Promise<void> {
  try {
    const client = new GitHubClient(input.token);
    const [repositoryOwner, repositoryName] = input.repository.split('/');
    const owner = repositoryOwner || client.owner;
    const repo = repositoryName || client.repo;
    await client.octokit.rest.repos.createCommitStatus({
      owner,
      repo,
      sha: input.headSha,
      state: input.status.state,
      context: input.status.context,
      description: input.status.description,
      ...(input.status.targetUrl ? { target_url: input.status.targetUrl } : {}),
    });
    core.info(`ReviewRouter published ${input.status.context} commit status.`);
  } catch (error) {
    core.warning(
      `ReviewRouter could not publish terminal commit status: ${safeTerminalOutcomeError(error)}`
    );
  }
}

function skippedReasonSummary(reason: string): string {
  switch (reason) {
    case 'stale_queued_secret':
      return 'ReviewRouter did not run because this workflow restored an older queued Codex auth generation.';
    case 'permission_required':
      return 'ReviewRouter did not run because the GitHub App needs repository permissions for this action.';
    case 'lease_not_active':
      return 'ReviewRouter did not run because the review lease was no longer active.';
    case 'github_put_failed':
      return 'ReviewRouter refreshed Codex auth but GitHub rejected the encrypted secret writeback.';
    case 'writeback_idempotency_conflict':
      return 'ReviewRouter stopped because another run already wrote a different Codex auth generation for this lease.';
    default:
      return 'ReviewRouter skipped this review before publishing output.';
  }
}

function skippedReasonLabel(reason: string): string {
  return reason.replace(/_/g, ' ');
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function githubRunUrl(
  inputs: ReturnType<typeof readCodexOAuthActionInputs>
): string | undefined {
  const runId = process.env.GITHUB_RUN_ID;
  if (!runId) return undefined;
  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
  return `${serverUrl.replace(/\/+$/, '')}/${inputs.repository}/actions/runs/${runId}`;
}

function truncateCommitStatusDescription(value: string): string {
  return value.length <= 140 ? value : `${value.slice(0, 137)}...`;
}

function safeTerminalOutcomeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown_error';
  return message
    .replace(/ghs_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .slice(0, 160);
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
      core.setOutput('total_tokens', review.metrics.totalTokens);
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
