import * as fs from 'fs';
import { GitHubClient } from './client';
import { ReviewLedger, LedgerEntry } from './ledger';
import {
  extractFindingFingerprint,
  extractInlineFingerprint,
  extractInlineSeverity,
  extractInlineTitle,
  findingFingerprintFromInlineComment,
  isReviewRouterInlineComment,
  stripInlineFingerprintMarkers,
} from './comment-fingerprint';
import { Severity } from '../types';
import { logger } from '../utils/logger';
import {
  ReviewCommentEventPayload,
  ReviewDiscussionHandler,
} from './discussion';
import {
  ActionMemoryCandidateRequest,
  ActionMemoryCommand,
  ActionMemoryInteractionPort,
  ActionMemoryMutationResponse,
  memorySourceHash,
} from '../control-plane/memory';
import {
  memoryCommandLabel,
  memoryScopeLabel,
  parseMemoryInteraction,
  ParsedMemoryInteraction,
  ParsedMemoryInstruction,
} from './memory-interaction';
import {
  ManualReviewRequestAvailability,
  type ManualReviewRequestPort,
} from '../control-plane/review-request';

type CommandKind = 'skip' | 'unskip' | 'status' | 'review';

interface ParsedCommand {
  kind: CommandKind;
  reason: string;
}

interface ReviewCommentApiItem {
  id?: number;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  body?: string | null;
  user?: {
    login?: string | null;
  } | null;
}

interface PullRequestApiItem {
  number?: number;
  head?: {
    sha?: string | null;
    repo?: {
      fork?: boolean | null;
      full_name?: string | null;
    } | null;
  } | null;
  user?: {
    login?: string | null;
  } | null;
}

interface InteractionPullRequestContext {
  prNumber: number;
  headSha?: string;
  isFork: boolean;
  verified: boolean;
  prAuthor: string;
}

const DISMISSAL_MARKER_START = '<!-- review-router-dismissal:start -->';
const DISMISSAL_MARKER_END = '<!-- review-router-dismissal:end -->';
const MANUAL_REVIEW_REQUEST_UNAVAILABLE_NOTICE =
  'ReviewRouter could not start a manual review from this comment because this workflow is not connected to the current ReviewRouter request API. Update the ReviewRouter interaction workflow/runtime pin and retry `/rr review`.';

function followUpReviewRequestUnavailableNotice(commandKind: string): string {
  return `Recorded \`/rr ${commandKind}\`, but ReviewRouter could not start a follow-up review because this workflow is not connected to the current ReviewRouter request API. Update the ReviewRouter interaction workflow/runtime pin and retry.`;
}

type RepoRole = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';

type ReviewRerunResult =
  | { outcome: 'rerun'; runId: number }
  | { outcome: 'already-running'; runId: number }
  | { outcome: 'already-succeeded'; runId: number }
  | { outcome: 'not-started'; reason: string };

interface WorkflowRunSummary {
  id?: number;
  path?: string | null;
  head_sha?: string | null;
  status?: string | null;
  conclusion?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  run_started_at?: string | null;
  pull_requests?: Array<{ number?: number | null }> | null;
}

type MemoryNoticeResult =
  | {
      readonly status: 'result';
      readonly label: string;
      readonly response: ActionMemoryMutationResponse | undefined;
      readonly command?: ActionMemoryCommand;
      readonly candidateBody?: string;
      readonly requestedScope?: 'repository' | 'workspace';
    }
  | {
      readonly status: 'error';
      readonly label: string;
      readonly reason: string;
    };

export class ReviewInteractionHandler {
  constructor(
    private readonly client: GitHubClient,
    private readonly ledger: ReviewLedger,
    private readonly discussionHandler?: ReviewDiscussionHandler,
    private readonly actionsClient: GitHubClient = client,
    private readonly memoryClient?: ActionMemoryInteractionPort,
    private readonly reviewRequests?: ManualReviewRequestPort
  ) {}

  async execute(): Promise<void> {
    const payload = readEventPayload();
    const body = payload.comment?.body || '';
    if (isBotCommentUser(payload.comment?.user)) {
      logger.info('Ignoring review interaction from a bot user.');
      return;
    }

    const command = parseInteractionCommand(body);
    const memoryInteraction = parseMemoryInteraction(body);
    if (!command && isMemoryInteraction(memoryInteraction)) {
      await this.handleMemoryInteraction(payload, memoryInteraction);
      return;
    }

    if (!command) {
      if (this.discussionHandler) {
        await this.discussionHandler.execute(payload);
        return;
      }
      logger.info('Ignoring review comment because it is not a /rr command.');
      return;
    }

    const prContext = await this.resolvePullRequestContext(payload);
    if (!prContext) {
      throw new Error(
        'review interaction payload is missing a pull request number'
      );
    }

    if (!prContext.verified) {
      await this.postNotice(
        prContext.prNumber,
        'ReviewRouter ignored this command because it could not verify the pull request context.'
      );
      return;
    }

    if (prContext.isFork) {
      await this.postNotice(
        prContext.prNumber,
        'ReviewRouter ignored this command because fork pull requests do not receive secret-backed review automation by default.'
      );
      return;
    }

    if (command.kind === 'status') {
      await this.postStatus(prContext.prNumber, prContext.headSha);
      return;
    }
    if (command.kind === 'review') {
      await this.handleManualReviewCommand(payload, prContext);
      return;
    }

    await this.handleSkipCommand(
      payload,
      command,
      prContext.prNumber,
      prContext.headSha
    );
  }

  private async handleManualReviewCommand(
    payload: ReviewCommentEventPayload,
    prContext: InteractionPullRequestContext
  ): Promise<void> {
    const comment = payload.comment;
    const actor = comment?.user?.login || 'unknown';
    if (!comment?.id) return;
    const role = await this.getRole(actor);
    if (role !== 'write' && role !== 'maintain' && role !== 'admin') {
      await this.postNotice(
        prContext.prNumber,
        `@${actor} cannot request a ReviewRouter rerun. Required role: write, maintain, or admin.`
      );
      return;
    }
    if (!prContext.headSha) {
      await this.postNotice(
        prContext.prNumber,
        'ReviewRouter could not verify the current head SHA and did not request a review.'
      );
      return;
    }
    const availability =
      this.reviewRequests?.availability() ??
      ManualReviewRequestAvailability.ExplicitlyUnsupported;
    if (availability === ManualReviewRequestAvailability.Unavailable) {
      await this.postNotice(
        prContext.prNumber,
        MANUAL_REVIEW_REQUEST_UNAVAILABLE_NOTICE
      );
      return;
    }
    if (availability === ManualReviewRequestAvailability.Available) {
      try {
        const requested = await this.reviewRequests!.request({
          pullRequestNumber: prContext.prNumber,
          expectedHeadSha: prContext.headSha,
          sourceId: `manual-comment:${comment.id}`,
          commandKind: 'review',
        });
        if (requested.status !== 'unsupported') {
          logger.info(
            `Queued revision-aware ReviewRouter review for PR #${prContext.prNumber}`
          );
          return;
        }
      } catch (error) {
        await this.postNotice(
          prContext.prNumber,
          `ReviewRouter could not start a manual review from this comment. Reason: ${sanitizeNoticeError(error)}. Update the ReviewRouter interaction workflow/runtime pin and retry \`/rr review\`.`
        );
        return;
      }
    }
    const rerun = await this.rerunReviewAfterOverride(
      prContext.prNumber,
      prContext.headSha
    );
    if (rerun.outcome === 'rerun' || rerun.outcome === 'already-running') {
      return;
    }
    const reason =
      rerun.outcome === 'not-started' ? rerun.reason : rerun.outcome;
    await this.postNotice(
      prContext.prNumber,
      `ReviewRouter did not start a review: ${reason}.`
    );
  }

  private async handleMemoryInteraction(
    payload: ReviewCommentEventPayload,
    interaction: ParsedMemoryInteraction
  ): Promise<void> {
    const prContext = await this.resolvePullRequestContext(payload);
    const comment = payload.comment;
    if (!prContext || !comment?.id || !comment.body?.trim()) {
      return;
    }
    if (!prContext.verified) {
      await this.postNotice(
        prContext.prNumber,
        'ReviewRouter memory was ignored because the pull request context could not be verified.'
      );
      return;
    }
    if (prContext.isFork) {
      await this.postNotice(
        prContext.prNumber,
        'ReviewRouter memory was ignored because fork pull requests do not receive secret-backed memory automation by default.'
      );
      return;
    }
    if (interaction.invalidReason) {
      await this.postNotice(
        prContext.prNumber,
        `ReviewRouter memory request was ignored: ${interaction.invalidReason}.`
      );
      return;
    }
    if (!this.memoryClient?.isAvailable()) {
      await this.postNotice(
        prContext.prNumber,
        'ReviewRouter memory is not available for this run.'
      );
      return;
    }

    const results: MemoryNoticeResult[] = [];
    for (const instruction of interaction.instructions.slice(0, 5)) {
      try {
        results.push(
          await this.executeMemoryInstruction(payload, prContext, instruction)
        );
      } catch (error) {
        results.push({
          label: describeMemoryInstruction(instruction),
          status: 'error',
          reason: sanitizeNoticeError(error),
        });
      }
    }

    await this.postNotice(prContext.prNumber, renderMemoryNotice(results));
  }

  private async executeMemoryInstruction(
    payload: ReviewCommentEventPayload,
    prContext: InteractionPullRequestContext,
    instruction: ParsedMemoryInstruction
  ): Promise<MemoryNoticeResult> {
    if (instruction.type === 'command') {
      const [response] = await this.memoryClient!.submitCommands([
        instruction.command,
      ]);
      return {
        label: memoryCommandLabel(instruction.command),
        status: 'result',
        command: instruction.command,
        response,
      };
    }

    const request = buildMemoryCandidateRequest({
      payload,
      prContext,
      instruction,
      owner: this.client.owner,
      repo: this.client.repo,
    });
    const response = await this.memoryClient!.submitCandidate(request);
    return {
      label: `${memoryScopeLabel(instruction.requestedScope)} memory`,
      status: 'result',
      candidateBody: instruction.candidateBody,
      requestedScope: instruction.requestedScope,
      response,
    };
  }

  private async resolvePullRequestContext(
    payload: ReviewCommentEventPayload
  ): Promise<InteractionPullRequestContext | null> {
    const prNumber = payload.pull_request?.number ?? payload.issue?.number;
    if (!prNumber) {
      return null;
    }
    if (payload.pull_request) {
      return {
        prNumber,
        headSha: payload.pull_request.head?.sha,
        isFork: payload.pull_request.head?.repo?.fork === true,
        verified: true,
        prAuthor: payload.pull_request.user?.login || '',
      };
    }

    try {
      const response = await this.actionsClient.octokit.rest.pulls.get({
        owner: this.actionsClient.owner,
        repo: this.actionsClient.repo,
        pull_number: prNumber,
      });
      const data = response.data as PullRequestApiItem;
      return {
        prNumber,
        headSha: data.head?.sha || undefined,
        isFork: data.head?.repo?.fork === true,
        verified: true,
        prAuthor: data.user?.login || '',
      };
    } catch (error) {
      logger.warn(
        `Failed to verify pull request context for interaction PR #${prNumber}: ${sanitizeNoticeError(error)}`
      );
      return {
        prNumber,
        isFork: false,
        verified: false,
        prAuthor: '',
      };
    }
  }

  private async handleSkipCommand(
    payload: ReviewCommentEventPayload,
    command: ParsedCommand,
    prNumber: number,
    headSha?: string
  ): Promise<void> {
    const comment = payload.comment;
    const parentId = comment?.in_reply_to_id;
    if (!comment?.id || !parentId) {
      await this.postNotice(
        prNumber,
        '`/rr skip` and `/rr unskip` must be direct replies to a ReviewRouter inline finding.'
      );
      return;
    }

    const parent = await this.findReviewComment(prNumber, parentId);
    if (!parent?.body || !isReviewRouterInlineComment(parent.body)) {
      await this.postNotice(
        prNumber,
        '`/rr skip` was ignored because the parent comment is not a ReviewRouter inline finding.'
      );
      return;
    }

    const actor = comment.user?.login || 'unknown';
    const severity = normalizeSeverity(extractInlineSeverity(parent.body));
    const role = await this.getRole(actor);
    const prAuthor = payload.pull_request?.user?.login || '';
    const denialReason = getRoleDenialReason(role, severity, actor, prAuthor);
    if (denialReason) {
      await this.postNotice(prNumber, denialReason);
      return;
    }

    const fingerprint =
      extractFindingFingerprint(parent.body) ||
      findingFingerprintFromInlineComment(
        parent.path,
        parent.line ?? parent.original_line,
        parent.body
      );
    const legacyFingerprint =
      extractInlineFingerprint(parent.body) || undefined;
    const entry: LedgerEntry = {
      action: command.kind as 'skip' | 'unskip',
      fingerprint,
      legacyFingerprint,
      severity,
      path: parent.path,
      line: parent.line ?? parent.original_line ?? null,
      title: extractInlineTitle(parent.body),
      body: compactLedgerBody(parent.body),
      reason: command.reason,
      actor,
      actorRole: role,
      headSha: payload.pull_request?.head?.sha,
      parentCommentId: parentId,
      commandCommentId: comment.id,
      createdAt: new Date().toISOString(),
    };

    try {
      await this.ledger.append(prNumber, entry);
    } catch (error) {
      await this.postNotice(
        prNumber,
        `Could not record \`/rr ${command.kind}\`: ${sanitizeNoticeError(error)}. The ReviewRouter check was not rerun.`
      );
      return;
    }
    logger.info(
      `Accepted /rr ${command.kind} from ${actor} for ${entry.path}:${entry.line}`
    );

    await this.setInlineCommentDismissalState(parentId, parent.body, {
      dismissed: command.kind === 'skip',
      actor,
      reason: command.reason,
    });

    const requestAvailability =
      this.reviewRequests?.availability() ??
      ManualReviewRequestAvailability.ExplicitlyUnsupported;
    if (requestAvailability === ManualReviewRequestAvailability.Unavailable) {
      await this.postNotice(
        prNumber,
        followUpReviewRequestUnavailableNotice(command.kind)
      );
      return;
    }
    if (requestAvailability === ManualReviewRequestAvailability.Available) {
      if (!headSha) {
        await this.postNotice(
          prNumber,
          `Recorded \`/rr ${command.kind}\`, but ReviewRouter could not verify the current head SHA and did not request a rerun.`
        );
        return;
      }
      try {
        const requested = await this.reviewRequests!.request({
          pullRequestNumber: prNumber,
          expectedHeadSha: headSha,
          sourceId: `review-comment:${comment.id}`,
          commandKind: command.kind === 'skip' ? 'skip' : 'unskip',
        });
        if (requested.status !== 'unsupported') {
          logger.info(
            `Queued revision-aware ReviewRouter review after /rr ${command.kind}`
          );
          return;
        }
      } catch (error) {
        await this.postNotice(
          prNumber,
          `Recorded \`/rr ${command.kind}\`, but ReviewRouter could not start the follow-up review. Reason: ${sanitizeNoticeError(error)}. Update the ReviewRouter interaction workflow/runtime pin and retry.`
        );
        return;
      }
    }

    const rerun = await this.rerunReviewAfterOverride(prNumber, headSha);
    if (rerun.outcome === 'rerun') {
      logger.info(
        `Requested rerun of ReviewRouter workflow run ${rerun.runId}`
      );
      return;
    }
    if (rerun.outcome === 'already-running') {
      logger.info(
        `ReviewRouter workflow run ${rerun.runId} is already running; skip state was recorded for the next check result`
      );
      return;
    }
    if (rerun.outcome === 'already-succeeded') {
      logger.info(
        `ReviewRouter workflow run ${rerun.runId} already completed successfully after the override`
      );
      return;
    }

    await this.postNotice(
      prNumber,
      `Recorded \`/rr ${command.kind}\`, but could not automatically rerun the review check: ${rerun.reason}. Re-run the ReviewRouter check manually if the PR status did not update.`
    );
  }

  private async postStatus(prNumber: number, headSha?: string): Promise<void> {
    const loaded = await this.ledger.load(prNumber);
    const body = loaded.valid
      ? `ReviewRouter override status:\n\n${this.ledger.statusText(loaded.payload, headSha)}`
      : `ReviewRouter override ledger is unavailable: ${loaded.invalidReason || 'unknown reason'}.`;
    await this.postNotice(prNumber, body);
  }

  private async findReviewComment(
    prNumber: number,
    commentId: number
  ): Promise<ReviewCommentApiItem | undefined> {
    const { octokit, owner, repo } = this.client;
    const comments = (await octokit.paginate(
      octokit.rest.pulls.listReviewComments,
      {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      }
    )) as ReviewCommentApiItem[];
    return comments.find((comment) => comment.id === commentId);
  }

  private async setInlineCommentDismissalState(
    commentId: number,
    currentBody: string,
    input: { dismissed: boolean; actor: string; reason: string }
  ): Promise<void> {
    const nextBody = input.dismissed
      ? addDismissalNotice(currentBody, input.actor, input.reason)
      : removeDismissalNotice(currentBody);
    if (nextBody === currentBody) {
      return;
    }

    try {
      const { octokit, owner, repo } = this.client;
      await octokit.rest.pulls.updateReviewComment({
        owner,
        repo,
        comment_id: commentId,
        body: nextBody,
      });
      logger.info(
        `${input.dismissed ? 'Marked' : 'Unmarked'} ReviewRouter inline comment ${commentId} as dismissed`
      );
    } catch (error) {
      logger.warn(
        `Failed to update ReviewRouter inline dismissal state for comment ${commentId}: ${sanitizeNoticeError(error)}`
      );
    }
  }

  private async getRole(username: string): Promise<RepoRole> {
    const { octokit, owner, repo } = this.actionsClient;
    try {
      const response = await octokit.rest.repos.getCollaboratorPermissionLevel({
        owner,
        repo,
        username,
      });
      const data = response.data as { permission?: string; role_name?: string };
      return normalizeRole(data.role_name || data.permission);
    } catch (error) {
      logger.warn(
        `Failed to verify repository permission for ${username}`,
        error as Error
      );
      return 'none';
    }
  }

  private async rerunReviewAfterOverride(
    prNumber: number,
    headSha?: string
  ): Promise<ReviewRerunResult> {
    if (!headSha) {
      return { outcome: 'not-started', reason: 'missing PR head SHA' };
    }

    const { octokit, owner, repo } = this.actionsClient;
    const workflowFile =
      process.env.REVIEW_ROUTER_REVIEW_WORKFLOW_FILE || 'reviewrouter.yml';

    try {
      const response = await octokit.rest.actions.listWorkflowRunsForRepo({
        owner,
        repo,
        event: 'pull_request',
        per_page: 50,
      });
      const workflowRuns = response.data.workflow_runs as WorkflowRunSummary[];
      const matchingRuns = workflowRuns
        .filter((candidate) =>
          this.matchesReviewWorkflowRun(
            candidate as WorkflowRunSummary,
            workflowFile,
            prNumber,
            headSha
          )
        )
        .sort(compareWorkflowRunsNewestFirst);

      const activeRun = matchingRuns.find(
        (candidate) => candidate.status && candidate.status !== 'completed'
      );
      if (activeRun?.id) {
        const settledRun = await this.waitForWorkflowRunToSettle(activeRun.id);
        if (settledRun?.status !== 'completed') {
          return { outcome: 'already-running', runId: activeRun.id };
        }
        if (isFailedWorkflowConclusion(settledRun.conclusion)) {
          await octokit.rest.actions.reRunWorkflowFailedJobs({
            owner,
            repo,
            run_id: activeRun.id,
          });
          return { outcome: 'rerun', runId: activeRun.id };
        }
        if (settledRun.conclusion === 'success') {
          return { outcome: 'already-succeeded', runId: activeRun.id };
        }
      }

      const latestCompletedRun = matchingRuns.find(
        (candidate) => candidate.status === 'completed'
      );
      if (
        latestCompletedRun?.id &&
        latestCompletedRun.conclusion === 'success'
      ) {
        return { outcome: 'already-succeeded', runId: latestCompletedRun.id };
      }
      if (
        latestCompletedRun?.id &&
        isFailedWorkflowConclusion(latestCompletedRun.conclusion)
      ) {
        await octokit.rest.actions.reRunWorkflowFailedJobs({
          owner,
          repo,
          run_id: latestCompletedRun.id,
        });
        return { outcome: 'rerun', runId: latestCompletedRun.id };
      }

      const failedRun = matchingRuns.find((candidate) =>
        isFailedWorkflowConclusion(candidate.conclusion)
      );

      if (!failedRun?.id) {
        return {
          outcome: 'not-started',
          reason: `no failed ${workflowFile} run found for the current PR head SHA`,
        };
      }

      await octokit.rest.actions.reRunWorkflowFailedJobs({
        owner,
        repo,
        run_id: failedRun.id,
      });
      return { outcome: 'rerun', runId: failedRun.id };
    } catch (error) {
      const err = error as { status?: number; message?: string };
      if (err.status === 403) {
        return {
          outcome: 'not-started',
          reason: 'token is missing Actions: write permission',
        };
      }
      return {
        outcome: 'not-started',
        reason: err.message || 'GitHub API error',
      };
    }
  }

  private matchesReviewWorkflowRun(
    candidate: WorkflowRunSummary,
    workflowFile: string,
    prNumber: number,
    headSha: string
  ): boolean {
    const path = String(candidate.path || '');
    const knownWorkflowFiles = [
      workflowFile,
      'reviewrouter.yml',
      'ai-robot-review.yml',
    ];
    const matchesWorkflow = knownWorkflowFiles.some(
      (file) => path.endsWith(`/${file}`) || path === file
    );
    const matchesSha = candidate.head_sha === headSha;
    const matchesPr = (candidate.pull_requests || []).some(
      (pr) => pr.number === prNumber
    );
    return matchesWorkflow && matchesSha && matchesPr;
  }

  private async waitForWorkflowRunToSettle(
    runId: number
  ): Promise<WorkflowRunSummary | null> {
    const waitSeconds = Number(
      process.env.REVIEW_ROUTER_RERUN_WAIT_SECONDS || '90'
    );
    const waitMs = Number.isFinite(waitSeconds)
      ? Math.max(0, waitSeconds * 1000)
      : 90_000;
    const deadline = Date.now() + waitMs;

    let lastRun: WorkflowRunSummary | null = null;
    do {
      const response =
        await this.actionsClient.octokit.rest.actions.getWorkflowRun({
          owner: this.actionsClient.owner,
          repo: this.actionsClient.repo,
          run_id: runId,
        });
      const run = response.data as WorkflowRunSummary;
      lastRun = run;
      if (run.status === 'completed' || Date.now() >= deadline) {
        return run;
      }
      await sleep(Math.min(5000, Math.max(250, deadline - Date.now())));
    } while (Date.now() < deadline);

    return lastRun;
  }

  private async postNotice(prNumber: number, body: string): Promise<void> {
    const { octokit, owner, repo } = this.client;
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
  }
}

function isMemoryInteraction(interaction: ParsedMemoryInteraction): boolean {
  return interaction.instructions.length > 0 || !!interaction.invalidReason;
}

function isBotCommentUser(
  user:
    | {
        readonly login?: string | null;
        readonly type?: string | null;
      }
    | null
    | undefined
): boolean {
  const login =
    user && typeof user === 'object' && 'login' in user
      ? String(user.login || '')
      : '';
  const type =
    user && typeof user === 'object' && 'type' in user
      ? String(user.type || '')
      : '';
  return type === 'Bot' || login.endsWith('[bot]');
}

function buildMemoryCandidateRequest(input: {
  readonly payload: ReviewCommentEventPayload;
  readonly prContext: InteractionPullRequestContext;
  readonly instruction: Extract<ParsedMemoryInstruction, { type: 'candidate' }>;
  readonly owner: string;
  readonly repo: string;
}): ActionMemoryCandidateRequest {
  const comment = input.payload.comment;
  if (!comment?.id || !comment.body) {
    throw new Error('memory_comment_unavailable');
  }
  const sourceHash = memorySourceHash(comment.body);
  return {
    protocolVersion: 1,
    intent: input.instruction.intent,
    requestedScope: input.instruction.requestedScope,
    candidateBody: input.instruction.candidateBody,
    sourceTextHash: sourceHash,
    extractionMethod: input.instruction.extractionMethod,
    extractionVersion: 1,
    source: {
      sourceId: `github-comment:${comment.id}`,
      githubCommentId: String(comment.id),
      githubPullRequestNumber: input.prContext.prNumber,
      url: buildMemoryCommentUrl(input),
      redactedExcerpt: redactedMemoryExcerpt(input.instruction.candidateBody),
      sourceHash,
      sourceVisibility: 'private',
    },
  };
}

function buildMemoryCommentUrl(input: {
  readonly payload: ReviewCommentEventPayload;
  readonly prContext: InteractionPullRequestContext;
  readonly owner: string;
  readonly repo: string;
}): string {
  const repository =
    input.payload.repository?.full_name || `${input.owner}/${input.repo}`;
  const commentId = input.payload.comment?.id;
  const anchor = input.payload.comment?.in_reply_to_id
    ? `discussion_r${commentId}`
    : `issuecomment-${commentId}`;
  return `https://github.com/${repository}/pull/${input.prContext.prNumber}#${anchor}`;
}

function renderMemoryNotice(results: readonly MemoryNoticeResult[]): string {
  const lines = ['ReviewRouter memory update:'];
  for (const result of results) {
    lines.push(`- ${renderMemoryNoticeLine(result)}`);
  }
  return lines.join('\n');
}

function renderMemoryNoticeLine(result: MemoryNoticeResult): string {
  if (result.status === 'error') {
    return `${result.label}: failed (${result.reason}).`;
  }
  const response = result.response;
  if (!response) {
    return `${result.label}: no response from memory service.`;
  }
  if (result.command) {
    return renderMemoryCommandResult(result.command, response);
  }
  return renderMemoryCandidateResult(result, response);
}

function renderMemoryCandidateResult(
  result: Extract<MemoryNoticeResult, { status: 'result' }>,
  response: ActionMemoryMutationResponse
): string {
  const body = result.candidateBody
    ? `: ${redactedMemoryExcerpt(result.candidateBody)}`
    : '.';
  if (response.status === 'created' || response.status === 'updated') {
    if (response.id?.startsWith('mem_suggestion_')) {
      return `Created pending ${result.requestedScope} memory suggestion \`${response.id}\`${body} Confirm with \`/rr remember ${response.id}\`.`;
    }
    return `Saved ${result.requestedScope} memory \`${response.id || 'mem'}\`${body}`;
  }
  if (response.status === 'noop') {
    return `No memory change for ${result.label}${response.id ? ` \`${response.id}\`` : ''}: ${safeNoticeText(response.reason || 'noop')}.`;
  }
  return `Memory request rejected for ${result.label}: ${safeNoticeText(response.reason || 'rejected')}.`;
}

function renderMemoryCommandResult(
  command: ActionMemoryCommand,
  response: ActionMemoryMutationResponse
): string {
  if (command.kind === 'confirm_suggestion') {
    if (response.status === 'created' || response.status === 'updated') {
      return `Confirmed memory suggestion \`${command.suggestionId}\` as \`${response.id || 'memory'}\`.`;
    }
    return `Could not confirm memory suggestion \`${command.suggestionId}\`: ${safeNoticeText(response.reason || response.status)}.`;
  }
  if (command.kind === 'reject_suggestion') {
    return response.status === 'updated'
      ? `Rejected memory suggestion \`${command.suggestionId}\`.`
      : `Could not reject memory suggestion \`${command.suggestionId}\`: ${safeNoticeText(response.reason || response.status)}.`;
  }
  if (command.kind === 'disable_memory') {
    return response.status === 'updated'
      ? `Disabled memory \`${command.memoryItemId}\`.`
      : `Could not disable memory \`${command.memoryItemId}\`: ${safeNoticeText(response.reason || response.status)}.`;
  }
  if (command.kind === 'forget_memory') {
    return response.status === 'updated'
      ? `Deleted memory \`${command.memoryItemId}\`.`
      : `Could not delete memory \`${command.memoryItemId}\`: ${safeNoticeText(response.reason || response.status)}.`;
  }
  return `No memory change for ${memoryCommandLabel(command)}: ${safeNoticeText(response.reason || response.status)}.`;
}

function describeMemoryInstruction(
  instruction: ParsedMemoryInstruction
): string {
  if (instruction.type === 'command') {
    return memoryCommandLabel(instruction.command);
  }
  return `${memoryScopeLabel(instruction.requestedScope)} memory`;
}

function redactedMemoryExcerpt(value: string): string {
  return safeNoticeText(value).slice(0, 240);
}

function safeNoticeText(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{16,}/g, 'gh*-***')
    .replace(/github_pat_[A-Za-z0-9_]+/g, 'github_pat_***')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function isFailedWorkflowConclusion(conclusion?: string | null): boolean {
  return (
    conclusion === 'failure' ||
    conclusion === 'cancelled' ||
    conclusion === 'timed_out'
  );
}

function compareWorkflowRunsNewestFirst(
  a: WorkflowRunSummary,
  b: WorkflowRunSummary
): number {
  return workflowRunTime(b) - workflowRunTime(a);
}

function workflowRunTime(run: WorkflowRunSummary): number {
  const value = run.updated_at || run.run_started_at || run.created_at || '';
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseInteractionCommand(body: string): ParsedCommand | null {
  const trimmed = body.trim();
  const codexReviewMatch = trimmed.match(/^@codex\s+review\b[\s:,-]*(.*)$/is);
  if (codexReviewMatch) {
    return {
      kind: 'review',
      reason: (codexReviewMatch[1] || '').trim(),
    };
  }
  const match = trimmed.match(
    /^\/rr\s+(skip|unskip|status|review)\b[\s:,-]*(.*)$/is
  );
  if (!match) return null;
  return {
    kind: match[1].toLowerCase() as CommandKind,
    reason: (match[2] || '').trim(),
  };
}

function addDismissalNotice(
  body: string,
  actor: string,
  reason: string
): string {
  const cleanBody = removeDismissalNotice(body).trimEnd();
  const notice = [
    DISMISSAL_MARKER_START,
    `<sub>Dismissed by @${sanitizeInlineActor(actor)} via \`/rr skip\`; this finding no longer blocks ReviewRouter.${formatDismissalReason(reason)}</sub>`,
    DISMISSAL_MARKER_END,
  ].join('\n');
  const lines = cleanBody.split('\n');
  if (lines.length <= 1) {
    return `${cleanBody}\n\n${notice}`;
  }
  return [lines[0], '', notice, ...lines.slice(1)].join('\n');
}

function removeDismissalNotice(body: string): string {
  const start = escapeRegExp(DISMISSAL_MARKER_START);
  const end = escapeRegExp(DISMISSAL_MARKER_END);
  return body
    .replace(new RegExp(`\\n?${start}[\\s\\S]*?${end}\\n?`, 'g'), '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function compactLedgerBody(body: string): string {
  return stripInlineFingerprintMarkers(removeDismissalNotice(body))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
}

function sanitizeInlineActor(actor: string): string {
  return actor.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 39) || 'maintainer';
}

function formatDismissalReason(reason: string): string {
  const normalized = reason
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return normalized ? ` Reason: ${normalized}` : '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSeverity(value: string | null): Severity {
  if (value === 'critical' || value === 'major' || value === 'minor') {
    return value;
  }
  return 'major';
}

function normalizeRole(value: string | undefined): RepoRole {
  if (
    value === 'admin' ||
    value === 'maintain' ||
    value === 'write' ||
    value === 'triage' ||
    value === 'read'
  ) {
    return value;
  }
  return 'none';
}

function isRoleAllowed(
  role: RepoRole,
  severity: Severity,
  actor: string,
  prAuthor: string
): boolean {
  if (severity === 'critical' || severity === 'major') {
    if (role === 'maintain' || role === 'admin') {
      return true;
    }
    return (
      actor.toLowerCase() === prAuthor.toLowerCase() &&
      process.env.REVIEW_ROUTER_ALLOW_AUTHOR_SKIP === 'true' &&
      role === 'write'
    );
  }
  return role === 'write' || role === 'maintain' || role === 'admin';
}

function getRoleDenialReason(
  role: RepoRole,
  severity: Severity,
  actor: string,
  prAuthor: string
): string | null {
  if (isRoleAllowed(role, severity, actor, prAuthor)) {
    return null;
  }

  const isBlocking = severity === 'critical' || severity === 'major';
  if (
    isBlocking &&
    actor.toLowerCase() === prAuthor.toLowerCase() &&
    role !== 'maintain' &&
    role !== 'admin' &&
    process.env.REVIEW_ROUTER_ALLOW_AUTHOR_SKIP !== 'true'
  ) {
    return `@${actor} cannot skip this ${severity} finding because PR authors without maintain/admin permission cannot override blocking ReviewRouter findings by default. A maintainer or admin can reply \`/rr skip\`, or the repository can explicitly set \`REVIEW_ROUTER_ALLOW_AUTHOR_SKIP=true\` for trusted same-repo authors.`;
  }

  return `@${actor} cannot skip this ${severity} finding. Required role: ${severity === 'minor' ? 'write, maintain, or admin' : 'maintain or admin'}.`;
}

function readEventPayload(): ReviewCommentEventPayload {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error(
      'GITHUB_EVENT_PATH is required for REVIEW_ROUTER_MODE=interaction'
    );
  }
  return JSON.parse(
    fs.readFileSync(eventPath, 'utf8')
  ) as ReviewCommentEventPayload;
}

function sanitizeNoticeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/gh[pousr]_[A-Za-z0-9_]{16,}/g, 'gh*-***')
    .replace(/github_pat_[A-Za-z0-9_]+/g, 'github_pat_***')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-***')
    .slice(0, 300);
}
