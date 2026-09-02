import * as fs from 'fs';
import * as core from '../actions/core';
import { GitHubClient } from '../github/client';
import type { ReviewOrchestrationProgressPort } from '../review-orchestration/application/run-t0-review-orchestration';
import type { ReviewWorkSlotPlan } from '../review-orchestration/application';

export const CI_PROGRESS_MARKER = '<!-- review-router-live-progress -->';

export type ProgressSnapshot = Readonly<{
  schemaVersion: 1;
  generation: number;
  phase: 'preparing' | 'reviewing' | 'assembling' | 'publishing' | 'terminal';
  terminal:
    | 'none'
    | 'complete'
    | 'complete_with_gaps'
    | 'failed'
    | 'cancelled'
    | 'superseded';
  updatedAt: string;
  counts: Readonly<{
    total: number;
    completed: number;
    exhausted: number;
    retrying: number;
    recovered: number;
  }>;
  fileCoverage:
    | Readonly<{ valid: false }>
    | Readonly<{ valid: true; total: number; covered: number }>;
}>;

export function formatCiReviewProgress(snapshot: ProgressSnapshot): string {
  const percent =
    snapshot.counts.total === 0 &&
    !(snapshot.phase === 'terminal' && snapshot.terminal === 'complete')
      ? 0
      : percentage(snapshot.counts.completed, snapshot.counts.total);
  const lines = [
    CI_PROGRESS_MARKER,
    '## ReviewRouter',
    '',
    `**Phase:** ${phaseLabel(snapshot)}`,
    '',
    `Review units: ${snapshot.counts.completed} of ${snapshot.counts.total} complete (${percent}%)`,
    progressBar(percent),
  ];
  if (snapshot.fileCoverage.valid) {
    lines.push(
      `Files in completed units: ${snapshot.fileCoverage.covered} of ${snapshot.fileCoverage.total}`
    );
  }
  lines.push(
    `Units currently retrying: ${snapshot.counts.retrying}`,
    `Units recovered by retry: ${snapshot.counts.recovered}`,
    `Units not completed after retries: ${snapshot.counts.exhausted}`,
    '',
    `Last update: ${snapshot.updatedAt.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')}`
  );
  return lines.join('\n');
}

export interface CiProgressGitHubPort {
  listComments(input: {
    repository: string;
    pullRequestNumber: number;
  }): Promise<readonly { id: number; body?: string | null }[]>;
  createComment(input: {
    repository: string;
    pullRequestNumber: number;
    body: string;
  }): Promise<void>;
  updateComment(input: {
    repository: string;
    commentId: number;
    body: string;
  }): Promise<void>;
}

export type CiProgressOutput = 'comment' | 'summary';

export class CiReviewProgressPublisher {
  constructor(
    private readonly input: Readonly<{
      repository: string;
      pullRequestNumber: number;
      commentEligible: boolean;
      github?: CiProgressGitHubPort;
      summaryPath?: string;
      info?: (message: string) => void;
      warning?: (message: string) => void;
    }>
  ) {}

  async publish(snapshot: ProgressSnapshot): Promise<CiProgressOutput> {
    const body = formatCiReviewProgress(snapshot);
    if (this.input.commentEligible && this.input.github) {
      try {
        const comments = await this.input.github.listComments({
          repository: this.input.repository,
          pullRequestNumber: this.input.pullRequestNumber,
        });
        const existing = comments.find((comment) =>
          (comment.body ?? '').includes(CI_PROGRESS_MARKER)
        );
        if (existing) {
          await this.input.github.updateComment({
            repository: this.input.repository,
            commentId: existing.id,
            body,
          });
        } else {
          await this.input.github.createComment({
            repository: this.input.repository,
            pullRequestNumber: this.input.pullRequestNumber,
            body,
          });
        }
        return 'comment';
      } catch (error) {
        this.warning(
          `ReviewRouter CI progress comment is unavailable; using job summary: ${safeError(error)}`
        );
      }
    } else {
      this.info(
        'ReviewRouter CI progress comment is unavailable; using job summary/log.'
      );
    }
    this.appendSummary(
      `${body}\n\n> CI progress comment is unavailable in this run. Progress is shown in the job summary and log instead.`
    );
    return 'summary';
  }

  private appendSummary(body: string): void {
    if (this.input.summaryPath) {
      try {
        fs.appendFileSync(this.input.summaryPath, `\n${body}\n`, 'utf8');
      } catch (error) {
        this.warning(
          `ReviewRouter could not write job summary: ${safeError(error)}`
        );
      }
    }
    this.info(body);
  }

  private info(message: string): void {
    (this.input.info ?? core.info)(message);
  }

  private warning(message: string): void {
    (this.input.warning ?? core.warning)(message);
  }
}

export class CiOrchestrationProgressReporter implements ReviewOrchestrationProgressPort {
  private readonly slots = new Map<
    string,
    {
      required: boolean;
      state: 'pending' | 'running' | 'accepted' | 'exhausted';
      attemptOrdinal: number;
    }
  >();
  private phase: ProgressSnapshot['phase'] = 'preparing';
  private terminal: ProgressSnapshot['terminal'] = 'none';
  private lastPublishedAt = 0;
  private publishChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly publisher: CiReviewProgressPublisher,
    private readonly now: () => number = Date.now,
    private readonly minimumIntervalMs = 60_000
  ) {}

  report(
    event: Parameters<ReviewOrchestrationProgressPort['report']>[0]
  ): void {
    let force = false;
    switch (event.type) {
      case 'initialized':
        this.initialize(event.workSlots);
        this.phase = 'reviewing';
        force = true;
        break;
      case 'running': {
        const slot = this.requireSlot(event.workSlotId);
        slot.state = 'running';
        slot.attemptOrdinal = event.attemptOrdinal;
        break;
      }
      case 'accepted': {
        const slot = this.requireSlot(event.workSlotId);
        slot.state = 'accepted';
        slot.attemptOrdinal = event.attemptOrdinal;
        break;
      }
      case 'exhausted':
        this.requireSlot(event.workSlotId).state = 'exhausted';
        break;
      case 'assembling':
        this.phase = 'assembling';
        break;
      case 'publishing':
        this.phase = 'publishing';
        break;
    }
    this.queuePublish(force);
  }

  async finish(
    terminal: Exclude<ProgressSnapshot['terminal'], 'none'>
  ): Promise<void> {
    if (this.terminal !== 'none') {
      await this.publishChain;
      return;
    }
    this.phase = 'terminal';
    this.terminal = terminal;
    this.queuePublish(true);
    await this.publishChain;
  }

  private queuePublish(force: boolean): void {
    const now = this.now();
    if (!force && now - this.lastPublishedAt < this.minimumIntervalMs) return;
    this.lastPublishedAt = now;
    const snapshot = this.snapshot(now);
    this.publishChain = this.publishChain
      .then(() => this.publisher.publish(snapshot))
      .catch(() => undefined);
  }

  private initialize(workSlots: readonly ReviewWorkSlotPlan[]): void {
    this.slots.clear();
    for (const slot of workSlots) {
      this.slots.set(slot.workSlotId, {
        required: slot.required,
        state: 'pending',
        attemptOrdinal: 1,
      });
    }
  }

  private requireSlot(workSlotId: string) {
    const slot = this.slots.get(workSlotId);
    if (!slot) throw new Error('ci_progress_work_slot_unknown');
    return slot;
  }

  private snapshot(now: number): ProgressSnapshot {
    const slots = [...this.slots.values()].filter((slot) => slot.required);
    const accepted = slots.filter((slot) => slot.state === 'accepted');
    return {
      schemaVersion: 1,
      generation: 0,
      phase: this.phase,
      terminal: this.terminal,
      updatedAt: new Date(now).toISOString(),
      counts: {
        total: slots.length,
        completed: accepted.length,
        exhausted: slots.filter((slot) => slot.state === 'exhausted').length,
        retrying: slots.filter(
          (slot) => slot.state === 'running' && slot.attemptOrdinal > 1
        ).length,
        recovered: accepted.filter((slot) => slot.attemptOrdinal > 1).length,
      },
      fileCoverage: { valid: false },
    };
  }
}

export function createCiReviewProgressPublisher(input: {
  repository: string;
  pullRequestNumber: number;
  eventPath?: string;
  env?: NodeJS.ProcessEnv;
}): CiReviewProgressPublisher | null {
  const env = input.env ?? process.env;
  if (!enabled(env.REVIEW_ROUTER_CI_PROGRESS_WRITES)) return null;
  const token = env.GITHUB_TOKEN?.trim();
  const fork = isForkPullRequest(input.eventPath ?? env.GITHUB_EVENT_PATH);
  return new CiReviewProgressPublisher({
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    commentEligible: Boolean(token) && !fork,
    ...(token && !fork ? { github: new GitHubCiProgressAdapter(token) } : {}),
    summaryPath: env.GITHUB_STEP_SUMMARY,
  });
}

class GitHubCiProgressAdapter implements CiProgressGitHubPort {
  private readonly client: GitHubClient;

  constructor(token: string) {
    this.client = new GitHubClient(token);
  }

  async listComments(input: {
    repository: string;
    pullRequestNumber: number;
  }): Promise<readonly { id: number; body?: string | null }[]> {
    const [owner, repo] = splitRepository(input.repository);
    return this.client.octokit.paginate(
      this.client.octokit.rest.issues.listComments,
      { owner, repo, issue_number: input.pullRequestNumber, per_page: 100 }
    );
  }

  async createComment(input: {
    repository: string;
    pullRequestNumber: number;
    body: string;
  }): Promise<void> {
    const [owner, repo] = splitRepository(input.repository);
    await this.client.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: input.pullRequestNumber,
      body: input.body,
    });
  }

  async updateComment(input: {
    repository: string;
    commentId: number;
    body: string;
  }): Promise<void> {
    const [owner, repo] = splitRepository(input.repository);
    await this.client.octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: input.commentId,
      body: input.body,
    });
  }
}

function isForkPullRequest(eventPath: string | undefined): boolean {
  if (!eventPath) return false;
  try {
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf8')) as {
      repository?: { full_name?: unknown };
      pull_request?: {
        head?: { repo?: { full_name?: unknown; fork?: unknown } };
      };
    };
    return (
      event.pull_request?.head?.repo?.fork === true ||
      (typeof event.repository?.full_name === 'string' &&
        typeof event.pull_request?.head?.repo?.full_name === 'string' &&
        event.repository.full_name !== event.pull_request.head.repo.full_name)
    );
  } catch {
    return true;
  }
}

function splitRepository(repository: string): readonly [string, string] {
  const parts = repository.split('/');
  if (parts.length !== 2 || parts.some((part) => !part)) {
    throw new Error('ci_progress_repository_invalid');
  }
  return [parts[0], parts[1]];
}

function enabled(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/i.test(value?.trim() ?? '');
}

function percentage(completed: number, total: number): number {
  return total === 0 ? 100 : Math.floor((completed / total) * 100);
}

function progressBar(percent: number): string {
  const filled = Math.floor(percent / 10);
  return `[${'■'.repeat(filled)}${'□'.repeat(10 - filled)}] ${percent}%`;
}

function phaseLabel(snapshot: ProgressSnapshot): string {
  if (snapshot.phase !== 'terminal') {
    return {
      preparing: 'Preparing review',
      reviewing: 'Reviewing changed files',
      assembling: 'Assembling findings',
      publishing: 'Publishing results',
    }[snapshot.phase];
  }
  return {
    none: 'Review complete',
    complete: 'Review complete',
    complete_with_gaps: 'Review complete with gaps',
    failed: 'Review failed',
    cancelled: 'Review cancelled',
    superseded: 'Review superseded',
  }[snapshot.terminal];
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
