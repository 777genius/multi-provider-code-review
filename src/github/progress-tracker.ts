import { Octokit } from '@octokit/rest';
import {
  normalizeReviewError,
  ReviewRouterError,
} from '../errors/review-router-error';
import { logger } from '../utils/logger';
import {
  ReviewSummaryMetadata,
  appendReviewSummaryMetadata,
  shouldSkipSummaryWriteForExisting,
} from './summary-metadata';
import {
  PullRequestHeadVerificationStatus,
  verifyPullRequestHead,
} from './pr-head-guard';

export type ProgressStatus =
  'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

export interface ProgressItem {
  id: string;
  label: string;
  status: ProgressStatus;
  details?: string;
  startTime?: number;
  endTime?: number;
}

export interface ProgressTrackerConfig {
  owner: string;
  repo: string;
  prNumber: number;
  updateStrategy: 'milestone' | 'debounced' | 'realtime';
  summaryMetadata?: ReviewSummaryMetadata;
}

/**
 * Tracks and displays review progress in a live-updating PR comment
 *
 * Inspired by Claude Code Action's progress tracking approach:
 * - Single comment that updates throughout review
 * - Checkboxes show completion status
 *
 * Update strategy: milestone-based (only major events to minimize API calls)
 */
export class ProgressTracker {
  private commentId: number | null = null;
  private items: Map<string, ProgressItem> = new Map();
  private startTime: number = Date.now();
  private totalCost: number = 0;
  private overrideBody?: string;
  private failure?: ReviewRouterError;
  private summaryWriteSuppressed = false;
  private static readonly MARKER = '<!-- review-router-progress-tracker -->';
  private static readonly LEGACY_MARKERS = [
    '<!-- ai-robot-review-progress-tracker -->',
  ];
  private static readonly LEGACY_HEADERS = [
    '# ReviewRouter',
    '## 🤖 ReviewRouter Progress',
    '# AI Robot Review',
    '## 🤖 AI Robot Review Progress',
  ];

  constructor(
    private octokit: Octokit,
    private config: ProgressTrackerConfig
  ) {}

  /**
   * Initialize progress tracking by creating the initial comment
   */
  async initialize(): Promise<void> {
    if (!this.octokit?.rest?.issues?.createComment) {
      logger.warn(
        'Progress tracker unavailable: octokit.rest.issues.createComment is missing'
      );
      return;
    }
    try {
      if (!(await this.canMutateCurrentHead('progress initialization'))) {
        return;
      }
      const body = this.formatProgressComment();
      const existing = await this.findReusableComment();
      if (existing.blockedByNewerSummary) {
        this.summaryWriteSuppressed = true;
        logger.warn(
          'Skipping progress tracker initialization because a newer ReviewRouter summary already exists'
        );
        return;
      }
      if (existing.commentId) {
        this.commentId = existing.commentId;
        await this.updateComment();
        logger.info('Progress tracker initialized from existing comment', {
          commentId: this.commentId,
        });
        return;
      }

      const comment = await this.octokit.rest.issues.createComment({
        owner: this.config.owner,
        repo: this.config.repo,
        issue_number: this.config.prNumber,
        body,
      });

      this.commentId = comment.data.id;
      logger.info('Progress tracker initialized', {
        commentId: this.commentId,
      });
    } catch (error) {
      logger.warn('Failed to initialize progress tracker', error as Error);
      // Continue without progress tracking rather than failing the review
    }
  }

  /**
   * Add a new progress item to track
   */
  addItem(id: string, label: string): void {
    this.items.set(id, {
      id,
      label,
      status: 'pending',
      startTime: Date.now(),
    });

    logger.debug(`Progress item added: ${id}`, { label });
  }

  /**
   * Update progress for a specific item
   * Only updates comment on milestone events (completed/failed)
   */
  async updateProgress(
    itemId: string,
    status: ProgressStatus,
    details?: string
  ): Promise<void> {
    const item = this.items.get(itemId);
    if (!item) {
      logger.warn(`Progress item not found: ${itemId}`);
      return;
    }

    item.status = status;
    item.details = details;

    if (status === 'completed' || status === 'failed') {
      item.endTime = Date.now();

      // Milestone-based update: only update comment on completion/failure
      await this.updateComment();
    }

    logger.debug(`Progress updated: ${itemId}`, { status, details });
  }

  setFailure(error: unknown): void {
    this.failure = normalizeReviewError(error);
  }

  hasFailedItems(): boolean {
    return Array.from(this.items.values()).some(
      (item) => item.status === 'failed'
    );
  }

  /**
   * Set total cost for metadata display
   */
  setTotalCost(cost: number): void {
    this.totalCost = cost;
  }

  /**
   * Finalize progress tracking with summary
   */
  async finalize(success: boolean): Promise<void> {
    const duration = Date.now() - this.startTime;

    // Update all pending items to final status
    const hasFailure = this.hasFailedItems();
    this.items.forEach((item) => {
      if (item.status === 'pending' || item.status === 'in_progress') {
        item.status = success ? 'completed' : 'skipped';
        if (!success && !item.details && hasFailure) {
          item.details = 'Skipped after an earlier failure.';
        }
        item.endTime = Date.now();
      }
    });

    if (!this.overrideBody) {
      await this.updateComment();
    }

    logger.info('Progress tracker finalized', {
      success,
      duration,
      totalCost: this.totalCost,
    });
  }

  /**
   * Format progress comment as a compact status table.
   */
  private formatProgressComment(): string {
    const lines: string[] = [];

    lines.push('## 🤖 ReviewRouter Progress');

    const sortedItems = Array.from(this.items.values()).sort(
      (a, b) => (a.startTime || 0) - (b.startTime || 0)
    );

    if (sortedItems.length > 0) {
      lines.push('');
      lines.push('| Step | Status | Details |');
      lines.push('| --- | --- | --- |');

      for (const item of sortedItems) {
        lines.push(
          [
            this.escapeTableCell(item.label),
            this.escapeTableCell(this.getStatusLabel(item.status)),
            this.escapeTableCell(item.details || ''),
          ]
            .join(' | ')
            .replace(/^/, '| ')
            .replace(/$/, ' |')
        );
      }
    }

    if (this.failure) {
      lines.push('');
      lines.push('### Review needs attention');
      lines.push('');
      lines.push(`**What failed:** ${this.failure.summary}`);
      lines.push('');
      lines.push('**How to fix**');
      for (const step of this.failure.nextSteps) {
        lines.push(`- ${step}`);
      }
      lines.push('');
      lines.push('<details>');
      lines.push('<summary>Technical details</summary>');
      lines.push('');
      lines.push(`Error code: \`${this.failure.code}\``);
      if (
        this.failure.safeMessage &&
        this.failure.safeMessage !== this.failure.summary
      ) {
        lines.push('');
        lines.push(this.failure.safeMessage);
      }
      lines.push('');
      lines.push('</details>');
    }

    lines.push(ProgressTracker.MARKER);

    return lines.join('\n');
  }

  /**
   * Update the progress comment (GitHub API call)
   */
  private async updateComment(): Promise<void> {
    if (!this.commentId) {
      logger.warn('Cannot update progress: comment not initialized');
      return;
    }
    if (!this.octokit?.rest?.issues?.updateComment) {
      logger.warn(
        'Cannot update progress: octokit.rest.issues.updateComment is missing'
      );
      return;
    }

    try {
      if (!(await this.canMutateCurrentHead('progress update'))) {
        return;
      }
      const body = this.overrideBody ?? this.formatProgressComment();

      await this.octokit.rest.issues.updateComment({
        owner: this.config.owner,
        repo: this.config.repo,
        comment_id: this.commentId,
        body,
      });

      logger.debug('Progress comment updated', { commentId: this.commentId });
    } catch (error) {
      logger.warn('Failed to update progress comment', error as Error);
      // Don't throw - progress tracking failure shouldn't stop the review
    }
  }

  /**
   * Replace the progress comment with a final body (e.g., combined progress + review)
   */
  async replaceWith(body: string): Promise<boolean> {
    if (this.summaryWriteSuppressed) {
      logger.warn(
        'Skipping progress replacement because a newer summary already exists'
      );
      return false;
    }
    if (!this.commentId) {
      logger.warn('Cannot replace progress: comment not initialized');
      return false;
    }
    if (!this.octokit?.rest?.issues?.updateComment) {
      logger.warn(
        'Cannot replace progress: octokit.rest.issues.updateComment is missing'
      );
      return false;
    }

    try {
      if (!(await this.canMutateCurrentHead('progress replacement'))) {
        return false;
      }
      if (await this.hasNewerReviewSummary()) {
        logger.warn(
          'Skipping progress replacement because a newer ReviewRouter summary already exists'
        );
        return false;
      }
      this.overrideBody = appendReviewSummaryMetadata(
        body,
        this.config.summaryMetadata
      );
      await this.octokit.rest.issues.updateComment({
        owner: this.config.owner,
        repo: this.config.repo,
        comment_id: this.commentId,
        body: this.overrideBody,
      });
      return true;
    } catch (error) {
      logger.warn(
        'Failed to replace progress comment with final summary',
        error as Error
      );
      return false;
    }
  }

  private async findReusableComment(): Promise<{
    commentId: number | null;
    blockedByNewerSummary: boolean;
  }> {
    if (!this.octokit?.rest?.issues?.listComments) {
      return { commentId: null, blockedByNewerSummary: false };
    }

    try {
      const comments = await this.listIssueComments();

      const hasNewerSummary = comments.some(
        (comment) =>
          shouldSkipSummaryWriteForExisting(
            comment.body ?? '',
            this.config.summaryMetadata
          ).shouldSkip
      );
      if (hasNewerSummary) {
        return { commentId: null, blockedByNewerSummary: true };
      }
      const progressComments = comments.filter((comment) =>
        this.isProgressComment(comment.body)
      );
      return {
        commentId:
          progressComments.length > 0
            ? progressComments[progressComments.length - 1].id
            : null,
        blockedByNewerSummary: false,
      };
    } catch (error) {
      logger.warn('Failed to find existing progress comment', error as Error);
      return { commentId: null, blockedByNewerSummary: false };
    }
  }

  private isProgressComment(body?: string | null): boolean {
    if (!body) return false;
    return (
      body.startsWith('## 🤖 ReviewRouter Progress') ||
      ProgressTracker.LEGACY_MARKERS.some((marker) => body.includes(marker)) ||
      ProgressTracker.LEGACY_HEADERS.filter((header) =>
        header.includes('Progress')
      ).some((header) => body.startsWith(header))
    );
  }

  private async hasNewerReviewSummary(): Promise<boolean> {
    if (
      !this.config.summaryMetadata ||
      !this.octokit?.rest?.issues?.listComments
    ) {
      return false;
    }
    try {
      const comments = await this.listIssueComments();
      return comments.some(
        (comment) =>
          shouldSkipSummaryWriteForExisting(
            comment.body ?? '',
            this.config.summaryMetadata
          ).shouldSkip
      );
    } catch (error) {
      logger.warn(
        'Failed to check existing summaries before progress replacement',
        error as Error
      );
      return false;
    }
  }

  private async canMutateCurrentHead(operation: string): Promise<boolean> {
    const reviewedHeadSha = this.config.summaryMetadata?.reviewedHeadSha;
    if (!reviewedHeadSha || !this.octokit?.rest?.pulls?.get) {
      return true;
    }
    const verification = await verifyPullRequestHead(this.octokit, {
      owner: this.config.owner,
      repo: this.config.repo,
      prNumber: this.config.prNumber,
      expectedHeadSha: reviewedHeadSha,
    });
    if (verification.status === PullRequestHeadVerificationStatus.Current) {
      return true;
    }
    logger.warn(
      verification.status === PullRequestHeadVerificationStatus.Changed
        ? `Skipping ${operation} because the PR head changed`
        : `Skipping ${operation} because the current PR head could not be verified`,
      verification.error as Error | undefined
    );
    return false;
  }

  private async listIssueComments(): Promise<
    Array<{ id: number; body?: string | null }>
  > {
    const comments: Array<{ id: number; body?: string | null }> = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await this.octokit.rest.issues.listComments({
        owner: this.config.owner,
        repo: this.config.repo,
        issue_number: this.config.prNumber,
        per_page: 100,
        page,
      });
      comments.push(...response.data);
      hasMore = response.data.length === 100;
      page += 1;
    }

    return comments;
  }

  private getStatusLabel(status: ProgressStatus): string {
    switch (status) {
      case 'completed':
        return '✅ Done';
      case 'failed':
        return '❌ Failed';
      case 'in_progress':
        return '🔄 Running';
      case 'pending':
        return '⏳ Waiting';
      case 'skipped':
        return '⏭️ Not run';
      default:
        return 'Pending';
    }
  }

  private escapeTableCell(value: string): string {
    return value.replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|').trim();
  }
}
