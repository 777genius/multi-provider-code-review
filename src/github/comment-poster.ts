import { InlineComment, FileChange, Severity, ReviewConfig } from '../types';
import { GitHubClient } from './client';
import { logger } from '../utils/logger';
import {
  chooseBestAddedLineForComment,
  mapLinesToPositions,
} from '../utils/diff';
import { withRetry } from '../utils/retry';
import {
  isSuggestionLineValid,
  validateSuggestionRange,
  isDeletionOnlyFile,
} from '../utils/suggestion-validator';
import {
  validateSyntax,
  shouldPostSuggestion,
  calculateConfidence,
  ConfidenceSignals,
} from '../validation';
import { SuppressionTracker } from '../learning/suppression-tracker';
import { ProviderWeightTracker } from '../learning/provider-weights';
import { detectLanguage } from '../analysis/ast/parsers';
import {
  appendInlineFingerprintMarker,
  extractFindingFingerprint,
  extractInlineFingerprint,
  extractInlineSeverity,
  FindingFingerprint,
  fingerprintFromInlineComment,
  inlineSeverityRank,
  InlineCommentReference,
  isReviewRouterInlineComment,
  isLikelySameInlineFinding,
  parseTrustedEscalationMarker,
  sameSemanticLineage,
  signatureFromInlineComment,
  trustedEscalationMarker,
} from './comment-fingerprint';
import {
  ReviewSummaryMetadata,
  appendReviewSummaryMetadata,
  shouldSkipSummaryWriteForExisting,
} from './summary-metadata';
import {
  FindingMarkerParseKind,
  parseFindingMarker,
} from '../review-projection/domain';
import {
  PullRequestHeadVerificationStatus,
  verifyPullRequestHead,
} from './pr-head-guard';
import {
  isTrustedReviewThreadAuthor,
  trustedReviewThreadAuthorsFromEnv,
} from './review-thread-inventory';

interface ActiveInlineComments {
  coarseKeys: Set<string>;
  legacyKeys: Set<string>;
  findingFingerprints: Set<FindingFingerprint>;
  comments: InlineCommentReference[];
}

interface GitHubInlineCommentPayload {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
  /** Same-run semantic evidence; never sent to GitHub. */
  semanticAliases?: readonly InlineCommentReference[];
}

interface SemanticLineageComponent {
  parents: InlineCommentReference[];
  ambiguous: boolean;
}

interface InlineEscalationReply {
  parent: InlineCommentReference;
  severity: Severity;
  body: string;
  aliasLine: number;
}

export interface SummaryPostResult {
  posted: boolean;
  skippedStale: boolean;
  reason?: 'head_sha_changed' | 'head_unverifiable' | 'newer_summary_exists';
}

export interface InlinePublicationOptions {
  mode: 'default' | 'strict-inline-only';
}

type InlineCommentWithLegacyRange = InlineComment & {
  start_line?: unknown;
  end_line?: unknown;
};

interface IssueCommentSummaryCandidate {
  id: number;
  body?: string | null;
}

export class CommentPoster {
  private static readonly MAX_COMMENT_SIZE = 60_000;
  private static readonly BOT_COMMENT_MARKER = '<!-- review-router-bot -->';
  private static readonly INLINE_FALLBACK_MARKER =
    '<!-- review-router-inline-fallback -->';
  private static readonly INLINE_SKIP_HELP_MARKER =
    '<!-- review-router-skip-help -->';

  constructor(
    private readonly client: GitHubClient,
    private readonly dryRun: boolean = false,
    private readonly config?: Partial<ReviewConfig>,
    private readonly suppressionTracker?: SuppressionTracker,
    private readonly providerWeightTracker?: ProviderWeightTracker
  ) {}

  async postSummary(
    prNumber: number,
    body: string,
    updateExisting = true,
    summaryMetadata?: ReviewSummaryMetadata
  ): Promise<SummaryPostResult> {
    const guardedBody = appendReviewSummaryMetadata(body, summaryMetadata);
    const staleHead = await this.shouldSkipForStaleHead(
      prNumber,
      summaryMetadata
    );
    if (staleHead.skippedStale) {
      logger.warn(
        staleHead.reason === 'head_sha_changed'
          ? 'Skipping summary write because the PR head changed'
          : 'Skipping summary write because the current PR head could not be verified'
      );
      return { posted: false, skippedStale: true, reason: staleHead.reason };
    }

    const chunks = this.chunk(guardedBody);

    if (this.dryRun) {
      logger.info(
        `[DRY RUN] Would post ${chunks.length} summary comment(s) to PR #${prNumber}`
      );
      for (let i = 0; i < chunks.length; i++) {
        const header =
          chunks.length > 1
            ? `## Review Summary (Part ${i + 1}/${chunks.length})\n\n`
            : '';
        const content = header + chunks[i];
        logger.info(
          `[DRY RUN] Summary comment ${i + 1}:\n${content.substring(0, 500)}...`
        );
      }
      return { posted: false, skippedStale: false };
    }

    const { octokit, owner, repo } = this.client;

    const newerSummary = await this.findNewerSummaryComment(
      prNumber,
      summaryMetadata
    );
    if (newerSummary) {
      logger.warn(
        'Skipping summary write because a newer ReviewRouter summary already exists'
      );
      return {
        posted: false,
        skippedStale: true,
        reason: 'newer_summary_exists',
      };
    }

    const markedBodies = chunks.map((chunk, index) => {
      const header =
        chunks.length > 1
          ? `## Review Summary (Part ${index + 1}/${chunks.length})\n\n`
          : '';
      return CommentPoster.BOT_COMMENT_MARKER + '\n\n' + header + chunk;
    });

    if (updateExisting) {
      const updated = await this.updateExistingSummaryComment(
        prNumber,
        markedBodies,
        summaryMetadata
      );
      if (updated) return { posted: true, skippedStale: false };
    }

    for (let i = 0; i < chunks.length; i++) {
      const headGuard = await this.shouldSkipForStaleHead(
        prNumber,
        summaryMetadata
      );
      if (headGuard.skippedStale) {
        logger.warn(
          'Stopping summary write because the PR head is not current'
        );
        return headGuard;
      }
      await withRetry(
        () =>
          octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: prNumber,
            body: markedBodies[i],
          }),
        { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
      );
      if (i < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    return { posted: true, skippedStale: false };
  }

  async deleteSummaryComments(
    prNumber: number,
    summaryMetadata?: ReviewSummaryMetadata,
    reason = 'no current summary findings remain'
  ): Promise<void> {
    if (this.dryRun) return;

    const staleHead = await this.shouldSkipForStaleHead(
      prNumber,
      summaryMetadata
    );
    if (staleHead.skippedStale) {
      logger.warn('Skipping summary cleanup because the PR head changed');
      return;
    }

    const { octokit, owner, repo } = this.client;
    const comments = await this.listIssueComments(prNumber);
    const staleSummaries = comments.filter((comment) => {
      const body = comment.body ?? '';
      return (
        CommentPoster.isSummaryComment(body) &&
        !shouldSkipSummaryWriteForExisting(body, summaryMetadata).shouldSkip
      );
    });

    const mutationGuard = await this.shouldSkipForStaleHead(
      prNumber,
      summaryMetadata
    );
    if (mutationGuard.skippedStale) {
      logger.warn(
        'Skipping summary cleanup because the PR head is not current'
      );
      return;
    }

    for (const stale of staleSummaries) {
      await withRetry(
        () =>
          octokit.rest.issues.deleteComment({
            owner,
            repo,
            comment_id: stale.id,
          }),
        { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
      );
    }

    if (staleSummaries.length > 0) {
      logger.info(
        `Deleted ${staleSummaries.length} stale ReviewRouter summary comment(s): ${reason}`
      );
    }
  }

  private async findNewerSummaryComment(
    prNumber: number,
    summaryMetadata?: ReviewSummaryMetadata
  ): Promise<{ id: number; body: string } | null> {
    if (!summaryMetadata) return null;
    try {
      const comments = await this.listIssueComments(prNumber);
      const newer = comments.find(
        (comment) =>
          shouldSkipSummaryWriteForExisting(comment.body ?? '', summaryMetadata)
            .shouldSkip
      );
      return newer ? { id: newer.id, body: newer.body ?? '' } : null;
    } catch (error) {
      logger.warn('Failed to find newer ReviewRouter summary', error as Error);
      return null;
    }
  }

  private async updateExistingSummaryComment(
    prNumber: number,
    markedBodies: readonly string[],
    summaryMetadata?: ReviewSummaryMetadata
  ): Promise<boolean> {
    const { octokit, owner, repo } = this.client;
    const comments = await this.listIssueComments(prNumber);
    const summaries = comments.filter((comment) => {
      const body = comment.body ?? '';
      return (
        CommentPoster.isSummaryComment(body) &&
        !shouldSkipSummaryWriteForExisting(body, summaryMetadata).shouldSkip
      );
    });
    logger.info(
      `ReviewRouter summary lookup found ${summaries.length} existing summary comment(s) on PR #${prNumber}`
    );
    const target = summaries.at(-1);
    if (!target) {
      logger.info(
        'Creating a new ReviewRouter summary comment because no existing summary was found'
      );
      return false;
    }
    const mutationGuard = await this.shouldSkipForStaleHead(
      prNumber,
      summaryMetadata
    );
    if (mutationGuard.skippedStale) {
      logger.warn('Skipping summary update because the PR head is not current');
      return false;
    }
    logger.info(`Updating ReviewRouter summary comment ${target.id}`);

    await withRetry(
      () =>
        octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: target.id,
          body: markedBodies[0] ?? CommentPoster.BOT_COMMENT_MARKER,
        }),
      { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
    );

    for (let index = 1; index < markedBodies.length; index += 1) {
      await withRetry(
        () =>
          octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: prNumber,
            body: markedBodies[index],
          }),
        { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
      );
    }

    const staleSummaries = summaries.filter(
      (summary) => summary.id !== target.id
    );
    for (const stale of staleSummaries) {
      await withRetry(
        () =>
          octokit.rest.issues.deleteComment({
            owner,
            repo,
            comment_id: stale.id,
          }),
        { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
      );
    }
    if (staleSummaries.length > 0) {
      logger.info(
        `Deleted ${staleSummaries.length} duplicate ReviewRouter summary comment(s)`
      );
    }

    return true;
  }

  private async listIssueComments(
    prNumber: number
  ): Promise<IssueCommentSummaryCandidate[]> {
    const comments = await this.listIssueCommentsViaCommentsApi(prNumber);
    if (
      comments.some((comment) => CommentPoster.isSummaryComment(comment.body))
    ) {
      return comments;
    }

    const timelineComments =
      await this.listIssueCommentsViaTimelineApi(prNumber);
    if (timelineComments.length === 0) {
      return comments;
    }

    const merged = [...comments];
    const knownIds = new Set(comments.map((comment) => comment.id));
    for (const comment of timelineComments) {
      if (!knownIds.has(comment.id)) {
        merged.push(comment);
        knownIds.add(comment.id);
      }
    }
    logger.info(
      `Loaded ${timelineComments.length} issue comment(s) from timeline fallback on PR #${prNumber}`
    );
    return merged;
  }

  private async listIssueCommentsViaCommentsApi(
    prNumber: number
  ): Promise<IssueCommentSummaryCandidate[]> {
    const { octokit, owner, repo } = this.client;
    const comments: IssueCommentSummaryCandidate[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await withRetry(
        () =>
          octokit.rest.issues.listComments({
            owner,
            repo,
            issue_number: prNumber,
            per_page: 100,
            page,
          }),
        { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
      );
      comments.push(...response.data);
      hasMore = response.data.length === 100;
      page += 1;
    }

    return comments;
  }

  private async listIssueCommentsViaTimelineApi(
    prNumber: number
  ): Promise<IssueCommentSummaryCandidate[]> {
    const { octokit, owner, repo } = this.client;
    if (!octokit.rest.issues.listEventsForTimeline) {
      return [];
    }

    const comments: IssueCommentSummaryCandidate[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await withRetry(
        () =>
          octokit.rest.issues.listEventsForTimeline({
            owner,
            repo,
            issue_number: prNumber,
            per_page: 100,
            page,
          }),
        { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
      );
      for (const event of response.data) {
        const candidate = event as {
          id?: unknown;
          event?: unknown;
          body?: unknown;
        };
        if (
          candidate.event === 'commented' &&
          typeof candidate.id === 'number'
        ) {
          comments.push({
            id: candidate.id,
            body:
              typeof candidate.body === 'string' ? candidate.body : undefined,
          });
        }
      }
      hasMore = response.data.length === 100;
      page += 1;
    }

    return comments;
  }

  private async shouldSkipForStaleHead(
    prNumber: number,
    summaryMetadata?: ReviewSummaryMetadata
  ): Promise<SummaryPostResult> {
    if (!summaryMetadata?.reviewedHeadSha || this.dryRun) {
      return { posted: false, skippedStale: false };
    }
    const verification = await verifyPullRequestHead(this.client.octokit, {
      owner: this.client.owner,
      repo: this.client.repo,
      prNumber,
      expectedHeadSha: summaryMetadata.reviewedHeadSha,
    });
    if (verification.status === PullRequestHeadVerificationStatus.Current) {
      return { posted: false, skippedStale: false };
    }
    if (verification.status === PullRequestHeadVerificationStatus.Changed) {
      return {
        posted: false,
        skippedStale: true,
        reason: 'head_sha_changed',
      };
    }
    logger.warn(
      'Failed to verify the current PR head before summary mutation; failing closed',
      verification.error as Error | undefined
    );
    return {
      posted: false,
      skippedStale: true,
      reason: 'head_unverifiable',
    };
  }

  private async canMutateExpectedHead(
    prNumber: number,
    expectedHeadSha: string,
    operation: string
  ): Promise<boolean> {
    const verification = await verifyPullRequestHead(this.client.octokit, {
      owner: this.client.owner,
      repo: this.client.repo,
      prNumber,
      expectedHeadSha,
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

  private static isSummaryComment(body?: string | null): boolean {
    if (!body) return false;
    return (
      body.includes(CommentPoster.BOT_COMMENT_MARKER) &&
      body.includes('# ReviewRouter') &&
      !body.includes(CommentPoster.INLINE_FALLBACK_MARKER) &&
      !body.includes(CommentPoster.INLINE_SKIP_HELP_MARKER)
    );
  }

  private async loadActiveInlineComments(
    prNumber: number,
    inventoryHeadSha?: string
  ): Promise<ActiveInlineComments> {
    const coarseKeys = new Set<string>();
    const legacyKeys = new Set<string>();
    const findingFingerprints = new Set<FindingFingerprint>();
    const activeComments: InlineCommentReference[] = [];
    const { octokit, owner, repo } = this.client;
    const trustedAuthors = trustedReviewThreadAuthorsFromEnv();
    const trustedParentIds = new Set<number>();
    const activeParentsById = new Map<number, InlineCommentReference>();

    try {
      const comments = await octokit.paginate(
        octokit.rest.pulls.listReviewComments,
        {
          owner,
          repo,
          pull_number: prNumber,
          per_page: 100,
        }
      );

      for (const comment of comments) {
        if (!isTrustedReviewThreadAuthor(comment.user?.login, trustedAuthors)) {
          continue;
        }
        if (comment.in_reply_to_id != null) continue;
        const activeLine = comment.line;
        const body = comment.body || '';
        if (!isReviewRouterInlineComment(body)) continue;
        const findingMarker = parseFindingMarker(body);
        if (
          findingMarker.kind === FindingMarkerParseKind.Conflict ||
          findingMarker.kind === FindingMarkerParseKind.Malformed
        ) {
          throw new Error(
            'Trusted ReviewRouter inline comment has an invalid finding marker'
          );
        }

        const parentId = comment.id;
        if (
          !Number.isSafeInteger(parentId) ||
          typeof parentId !== 'number' ||
          parentId <= 0
        ) {
          throw new Error(
            'Trusted ReviewRouter inline comment is missing a valid database id'
          );
        }
        trustedParentIds.add(parentId);
        if (activeLine == null) continue;

        const parentReference: InlineCommentReference = {
          path: comment.path,
          line: activeLine,
          body,
          parentCommentDatabaseId: parentId,
          highestTrustedEscalationSeverity:
            CommentPoster.inlineSeverity(body) ?? 'minor',
          ...(inventoryHeadSha ? { inventoryHeadSha } : {}),
        };
        activeComments.push(parentReference);
        activeParentsById.set(parentId, parentReference);
        const signature = signatureFromInlineComment(
          comment.path,
          activeLine,
          body
        );
        const fingerprint = fingerprintFromInlineComment(
          comment.path,
          activeLine,
          body
        );
        coarseKeys.add(signature);
        coarseKeys.add(fingerprint);

        const marker = extractInlineFingerprint(body);
        if (marker) coarseKeys.add(marker);
        const findingFingerprint = extractFindingFingerprint(body);
        if (findingFingerprint) {
          findingFingerprints.add(findingFingerprint);
        } else {
          legacyKeys.add(signature);
          legacyKeys.add(fingerprint);
          if (marker) legacyKeys.add(marker);
        }
      }

      for (const comment of comments) {
        if (!isTrustedReviewThreadAuthor(comment.user?.login, trustedAuthors)) {
          continue;
        }
        const parentId = comment.in_reply_to_id;
        if (typeof parentId !== 'number') continue;
        const parsed = parseTrustedEscalationMarker(comment.body);
        if (parsed.kind === 'absent') continue;
        if (parsed.kind === 'malformed' || parsed.kind === 'conflict') {
          throw new Error(
            `Trusted ReviewRouter escalation reply has a ${parsed.kind} marker`
          );
        }
        if (parsed.parentCommentDatabaseId !== parentId) {
          throw new Error(
            'Trusted ReviewRouter escalation reply references a conflicting parent'
          );
        }
        if (!trustedParentIds.has(parentId)) {
          throw new Error(
            'Trusted ReviewRouter escalation reply references an unknown parent'
          );
        }
        const activeParent = activeParentsById.get(parentId);
        if (!activeParent) continue;
        const currentSeverity = CommentPoster.effectiveSeverity(activeParent);
        if (
          inlineSeverityRank(parsed.targetSeverity) >
          inlineSeverityRank(currentSeverity)
        ) {
          activeParent.highestTrustedEscalationSeverity = parsed.targetSeverity;
        }
        activeParent.semanticAliases = [
          ...(activeParent.semanticAliases ?? []),
          {
            path: activeParent.path,
            line: parsed.aliasLine ?? activeParent.line,
            body: comment.body || '',
          },
        ];
      }
    } catch (error) {
      const inventoryError = new Error(
        'Failed to load trusted inline comment inventory; refusing publication'
      ) as Error & { cause?: unknown };
      inventoryError.cause = error;
      logger.error(inventoryError.message, error as Error);
      throw inventoryError;
    }

    return {
      coarseKeys,
      legacyKeys,
      findingFingerprints,
      comments: activeComments,
    };
  }

  private hasInlineDuplicate(
    activeComments: ActiveInlineComments,
    path: string,
    line: number,
    body: string
  ): boolean {
    const parsedFindingMarker = parseFindingMarker(body);
    if (
      parsedFindingMarker.kind === FindingMarkerParseKind.Conflict ||
      parsedFindingMarker.kind === FindingMarkerParseKind.Malformed
    ) {
      return false;
    }
    const marker = extractInlineFingerprint(body);
    const findingFingerprint = extractFindingFingerprint(body);
    const keys = findingFingerprint
      ? activeComments.legacyKeys
      : activeComments.coarseKeys;
    return (
      (findingFingerprint
        ? activeComments.findingFingerprints.has(findingFingerprint)
        : false) ||
      keys.has(signatureFromInlineComment(path, line, body)) ||
      keys.has(fingerprintFromInlineComment(path, line, body)) ||
      (marker ? keys.has(marker) : false) ||
      activeComments.comments.some((comment) =>
        CommentPoster.semanticReferences(comment).some((reference) =>
          isLikelySameInlineFinding(reference, { path, line, body })
        )
      )
    );
  }

  private hasTrustedExactInlineIdentity(
    activeComments: ActiveInlineComments,
    body: string
  ): boolean {
    const parsedFindingMarker = parseFindingMarker(body);
    if (
      parsedFindingMarker.kind === FindingMarkerParseKind.Conflict ||
      parsedFindingMarker.kind === FindingMarkerParseKind.Malformed
    ) {
      return false;
    }
    const findingFingerprint = extractFindingFingerprint(body);
    if (
      findingFingerprint &&
      activeComments.findingFingerprints.has(findingFingerprint)
    ) {
      return true;
    }
    return false;
  }

  private classifyInlineCandidate(
    activeComments: ActiveInlineComments,
    candidate: GitHubInlineCommentPayload
  ):
    | { kind: 'duplicate' }
    | { kind: 'top-level' }
    | {
        kind: 'escalation';
        parent: InlineCommentReference;
        severity: Severity;
      } {
    if (this.hasTrustedExactInlineIdentity(activeComments, candidate.body)) {
      return { kind: 'duplicate' };
    }
    const candidateReferences: InlineCommentReference[] = [
      {
        path: candidate.path,
        line: candidate.line,
        body: candidate.body,
      },
      ...(candidate.semanticAliases ?? []),
    ];
    const matchingComponents = CommentPoster.semanticLineageComponents(
      activeComments.comments
    ).filter((component) =>
      component.parents.some((parent) =>
        CommentPoster.semanticReferences(parent).some((existingAlias) =>
          candidateReferences.some((candidateAlias) =>
            sameSemanticLineage(existingAlias, candidateAlias)
          )
        )
      )
    );
    if (matchingComponents.some((component) => component.ambiguous)) {
      throw new Error(
        'Cannot classify semantic lineage because the candidate intersects an ambiguous parent bridge'
      );
    }
    if (matchingComponents.length > 1) {
      throw new Error(
        'Cannot post semantic escalation because multiple active parent lineages match the finding'
      );
    }
    if (
      this.hasInlineDuplicate(
        activeComments,
        candidate.path,
        candidate.line,
        candidate.body
      )
    ) {
      return { kind: 'duplicate' };
    }

    const candidateSeverity = CommentPoster.inlineSeverity(candidate.body);
    if (!candidateSeverity) return { kind: 'top-level' };
    if (matchingComponents.length === 0) return { kind: 'top-level' };
    const component = matchingComponents[0].parents;
    const parent = CommentPoster.canonicalLineageParent(component);
    const componentSeverity = component.reduce<Severity>(
      (highest, member) =>
        inlineSeverityRank(CommentPoster.effectiveSeverity(member)) >
        inlineSeverityRank(highest)
          ? CommentPoster.effectiveSeverity(member)
          : highest,
      'minor'
    );
    if (
      inlineSeverityRank(candidateSeverity) <=
      inlineSeverityRank(componentSeverity)
    ) {
      return { kind: 'duplicate' };
    }
    return { kind: 'escalation', parent, severity: candidateSeverity };
  }

  private static semanticReferences(
    parent: InlineCommentReference
  ): InlineCommentReference[] {
    return [parent, ...(parent.semanticAliases ?? [])];
  }

  /**
   * Direct parent-to-parent matches may reconcile old duplicate roots. A
   * transitive fuzzy bridge is not durable identity, so non-clique components
   * fail closed before any GitHub mutation.
   */
  private static semanticLineageComponents(
    parents: InlineCommentReference[]
  ): SemanticLineageComponent[] {
    const remaining = new Set(parents);
    const components: SemanticLineageComponent[] = [];
    while (remaining.size > 0) {
      const seed = remaining.values().next().value as InlineCommentReference;
      const component = [seed];
      remaining.delete(seed);
      const pending = [seed];
      while (pending.length > 0) {
        const current = pending.pop()!;
        for (const candidate of [...remaining]) {
          if (!sameSemanticLineage(current, candidate)) continue;
          remaining.delete(candidate);
          component.push(candidate);
          pending.push(candidate);
        }
      }
      const clique = component.every((left, leftIndex) =>
        component
          .slice(leftIndex + 1)
          .every((right) => sameSemanticLineage(left, right))
      );
      components.push({ parents: component, ambiguous: !clique });
    }
    return components;
  }

  private static canonicalLineageParent(
    component: InlineCommentReference[]
  ): InlineCommentReference {
    return [...component].sort(
      (left, right) =>
        (left.parentCommentDatabaseId ?? Number.MAX_SAFE_INTEGER) -
        (right.parentCommentDatabaseId ?? Number.MAX_SAFE_INTEGER)
    )[0];
  }

  private static effectiveSeverity(comment: InlineCommentReference): Severity {
    return (
      comment.highestTrustedEscalationSeverity ??
      CommentPoster.inlineSeverity(comment.body) ??
      'minor'
    );
  }

  private static inlineSeverity(body: string): Severity | null {
    const severity = extractInlineSeverity(body);
    return severity === 'critical' ||
      severity === 'major' ||
      severity === 'minor'
      ? severity
      : null;
  }

  private static rememberInlineComment(
    activeComments: ActiveInlineComments,
    comment: GitHubInlineCommentPayload
  ): void {
    activeComments.coarseKeys.add(
      signatureFromInlineComment(comment.path, comment.line, comment.body)
    );
    activeComments.coarseKeys.add(
      fingerprintFromInlineComment(comment.path, comment.line, comment.body)
    );
    const marker = extractInlineFingerprint(comment.body);
    if (marker) activeComments.coarseKeys.add(marker);
    const findingFingerprint = extractFindingFingerprint(comment.body);
    if (findingFingerprint) {
      activeComments.findingFingerprints.add(findingFingerprint);
    }
    activeComments.comments.push({
      path: comment.path,
      line: comment.line,
      body: comment.body,
    });
  }

  private static coalesceSameRunInlineCandidates(
    comments: GitHubInlineCommentPayload[]
  ): GitHubInlineCommentPayload[] {
    const groups: GitHubInlineCommentPayload[][] = [];

    for (const candidate of comments) {
      const intersectingGroups = groups.filter((group) =>
        group.some((existing) => sameSemanticLineage(existing, candidate))
      );
      if (intersectingGroups.length === 0) {
        groups.push([candidate]);
        continue;
      }
      if (
        intersectingGroups.length !== 1 ||
        !intersectingGroups[0].every((existing) =>
          sameSemanticLineage(existing, candidate)
        )
      ) {
        throw new Error(
          'Cannot coalesce same-run inline findings because the semantic lineage is ambiguous'
        );
      }
      intersectingGroups[0].push(candidate);
    }

    return groups.map((group) => {
      const strongest = group.reduce((currentStrongest, candidate) => {
        const strongestSeverity = CommentPoster.inlineSeverity(
          currentStrongest.body
        );
        const candidateSeverity = CommentPoster.inlineSeverity(candidate.body);
        return inlineSeverityRank(candidateSeverity ?? '') >
          inlineSeverityRank(strongestSeverity ?? '')
          ? candidate
          : currentStrongest;
      });
      return {
        ...strongest,
        semanticAliases: group
          .filter((candidate) => candidate !== strongest)
          .map((candidate) => ({
            path: candidate.path,
            line: candidate.line,
            body: candidate.body,
          })),
      };
    });
  }

  /**
   * Validate and filter suggestions through quality pipeline.
   * Reads pre-computed hasConsensus from Finding (set during aggregation).
   */
  private async validateAndFilterSuggestion(
    comment: InlineComment & {
      suggestion?: string;
      category?: string;
      severity?: Severity;
      provider?: string;
      hasConsensus?: boolean; // Pre-computed during aggregation
      confidence?: number;
    },
    prNumber: number
  ): Promise<{ valid: boolean; reason?: string; hasConsensus?: boolean }> {
    if (!comment.suggestion) {
      return { valid: true }; // No suggestion to validate
    }

    // Check suppression first (fast path)
    if (this.suppressionTracker) {
      const suppressed = await this.suppressionTracker.shouldSuppress(
        {
          category: comment.category || 'unknown',
          file: comment.path,
          line: comment.line,
        },
        prNumber
      );
      if (suppressed) {
        logger.debug(
          `Suggestion suppressed for ${comment.path}:${comment.line} (similar suggestion dismissed)`
        );
        return { valid: false, reason: 'Similar suggestion was dismissed' };
      }
    }

    // Syntax validation (if enabled)
    let syntaxValid = true;
    if (this.config?.suggestionSyntaxValidation !== false) {
      const language = detectLanguage(comment.path);
      if (language !== 'unknown') {
        const syntaxResult = validateSyntax(comment.suggestion, language);
        if (!syntaxResult.isValid && !syntaxResult.skipped) {
          logger.debug(
            `Suggestion syntax invalid for ${comment.path}:${comment.line}: ${syntaxResult.errors.length} error(s)`
          );
          syntaxValid = false;
          // Don't return early - check consensus which might override
        }
      }
    }

    // Read consensus from Finding (set during aggregation, NOT computed here)
    // Consensus checking requires per-provider suggestions which aren't available at comment-posting time
    const hasConsensus = comment.hasConsensus ?? false;
    if (hasConsensus) {
      logger.debug(
        `Consensus detected for ${comment.path}:${comment.line} (providers agreed during aggregation)`
      );
    }

    // If syntax invalid and no consensus to override, reject
    if (!syntaxValid && !hasConsensus) {
      return {
        valid: false,
        reason: 'Syntax validation failed',
        hasConsensus: false,
      };
    }

    // Confidence threshold check
    if (comment.severity && this.config) {
      // Get provider weight for reliability signal
      let providerReliability = 1.0;
      if (this.providerWeightTracker && comment.provider) {
        providerReliability = await this.providerWeightTracker.getWeight(
          comment.provider
        );
      }

      const signals: ConfidenceSignals = {
        llmConfidence: comment.confidence,
        syntaxValid,
        hasConsensus,
        providerReliability,
      };
      const confidence = calculateConfidence(signals);

      // Create minimal Finding object for shouldPostSuggestion
      const minimalFinding = {
        file: comment.path,
        line: comment.line,
        severity: comment.severity,
        title: '',
        message: '',
        providers: comment.provider ? [comment.provider] : [],
        hasConsensus,
      };

      if (
        !shouldPostSuggestion(minimalFinding, confidence, {
          min_confidence: this.config.minConfidence,
          confidence_threshold: this.config.confidenceThreshold,
          consensus: {
            required_for_critical:
              this.config.consensusRequiredForCritical ?? true,
            min_agreement: this.config.consensusMinAgreement ?? 2,
          },
        })
      ) {
        logger.debug(
          `Suggestion below confidence threshold for ${comment.path}:${comment.line} (confidence: ${confidence.toFixed(2)})`
        );
        return {
          valid: false,
          reason: 'Below confidence threshold',
          hasConsensus,
        };
      }
    }

    return { valid: true, hasConsensus };
  }

  async postInline(
    prNumber: number,
    comments: InlineComment[],
    files: FileChange[],
    headSha?: string,
    dedupeComments?: InlineCommentReference[],
    publication: InlinePublicationOptions = { mode: 'default' }
  ): Promise<void> {
    const strictInlineOnly = publication.mode === 'strict-inline-only';
    if (
      !this.dryRun &&
      headSha &&
      !(await this.canMutateExpectedHead(
        prNumber,
        headSha,
        'inline publication'
      ))
    ) {
      return;
    }
    if (comments.length === 0) {
      if (!this.dryRun && !strictInlineOnly) {
        await this.deleteInlineFallbackComments(
          prNumber,
          'no current inline findings remain',
          headSha
        );
      }
      return;
    }
    const activeInlineComments = this.dryRun
      ? {
          coarseKeys: new Set<string>(),
          legacyKeys: new Set<string>(),
          findingFingerprints: new Set<FindingFingerprint>(),
          comments: [],
        }
      : dedupeComments
        ? CommentPoster.activeInlineCommentsFromReferences(dedupeComments)
        : await this.loadActiveInlineComments(prNumber, headSha);

    // Filter out deletion-only files (no suggestions possible)
    const filesWithAdditions = files.filter((f) => !isDeletionOnlyFile(f));
    const filesWithAdditionsSet = new Set(
      filesWithAdditions.map((f) => f.filename)
    );

    // Build a map from file path to line->position mapping
    const positionMaps = new Map<string, Map<number, number>>();
    for (const file of files) {
      positionMaps.set(file.filename, mapLinesToPositions(file.patch));
    }

    // Sort comments for optimal batch commit UX (top-to-bottom per file)
    const sortedComments = [...comments].sort((a, b) => {
      const pathCompare = a.path.localeCompare(b.path);
      if (pathCompare !== 0) return pathCompare;
      return a.line - b.line;
    });

    // Convert comments to GitHub API format, filtering out those without valid positions
    const preparedApiComments = (
      await Promise.all(
        sortedComments.map(async (c) => {
          const file = files.find((f) => f.filename === c.path);
          const rangedComment = c as InlineCommentWithLegacyRange;
          const requestedEndLine = CommentPoster.integerOrUndefined(
            c.endLine ?? rangedComment.end_line
          );
          if (requestedEndLine !== undefined && requestedEndLine !== c.line) {
            logger.debug(
              `Using inline comment end line for ${c.path}: ${c.line} -> ${requestedEndLine}`
            );
            c.line = requestedEndLine;
          }
          const correctedLine =
            c.side !== 'LEFT'
              ? chooseBestAddedLineForComment(file?.patch, c.line, c.body)
              : c.line;
          if (correctedLine !== c.line) {
            logger.debug(
              `Adjusted inline comment line for ${c.path}: ${c.line} -> ${correctedLine}`
            );
            c.line = correctedLine;
          }

          const posMap = positionMaps.get(c.path);
          const position = posMap?.get(c.line);
          if (!position) {
            logger.warn(
              `Cannot find diff position for ${c.path}:${c.line}, skipping inline comment`
            );
            return null;
          }

          let startLine = CommentPoster.integerOrUndefined(
            c.startLine ?? rangedComment.start_line
          );
          if (startLine !== undefined) {
            if (startLine === c.line) {
              startLine = undefined;
            } else {
              const validation = validateSuggestionRange(
                startLine,
                c.line,
                file?.patch
              );
              if (!validation.isValid) {
                logger.debug(
                  `Inline comment range invalid at ${c.path}:${startLine}-${c.line}: ${validation.reason}`
                );
                startLine = undefined;
              }
            }
          }

          // Validate suggestions can be applied at this line/range
          if (c.body.includes('```suggestion')) {
            // Skip suggestions for deletion-only files
            if (!filesWithAdditionsSet.has(c.path)) {
              logger.debug(
                `Skipping suggestion for deletion-only file: ${c.path}`
              );
              c.body = c.body.replace(
                /```suggestion[\s\S]*?```/g,
                '_Suggestion not available (file has no additions)_'
              );
            } else if (file?.patch) {
              // Check if this is a multi-line suggestion (has start_line)
              if (startLine !== undefined && startLine !== c.line) {
                // Multi-line suggestion - validate range
                const validation = validateSuggestionRange(
                  startLine,
                  c.line,
                  file.patch
                );
                if (!validation.isValid) {
                  logger.debug(
                    `Multi-line suggestion invalid at ${c.path}:${startLine}-${c.line}: ${validation.reason}`
                  );
                  c.body = c.body.replace(
                    /```suggestion[\s\S]*?```/g,
                    `_Suggestion not available: ${validation.reason}_`
                  );
                }
              } else {
                // Single-line suggestion - use existing validation
                if (!isSuggestionLineValid(c.line, file.patch)) {
                  logger.debug(
                    `Suggestion line ${c.path}:${c.line} not valid in diff, posting without suggestion block`
                  );
                  c.body = c.body.replace(
                    /```suggestion[\s\S]*?```/g,
                    '_Suggestion not available for this line_'
                  );
                }
              }
            }

            // Quality gate validation (syntax, suppression, confidence)
            // Extract suggestion content for validation
            const suggestionMatch = c.body.match(
              /```suggestion\n([\s\S]*?)```/
            );
            if (
              suggestionMatch &&
              !c.body.includes('_Suggestion not available')
            ) {
              const suggestionContent = suggestionMatch[1];
              const qualityValidation = await this.validateAndFilterSuggestion(
                {
                  ...c,
                  suggestion: suggestionContent,
                  category: c.category,
                  severity: c.severity,
                  provider: c.provider,
                  hasConsensus: c.hasConsensus,
                  confidence: c.confidence,
                },
                prNumber
              );
              if (!qualityValidation.valid) {
                c.body = c.body.replace(
                  /```suggestion[\s\S]*?```/g,
                  `_Suggestion not available: ${qualityValidation.reason}_`
                );
              }
            }
          }

          const apiComment: GitHubInlineCommentPayload = {
            path: c.path,
            line: c.line,
            side: c.side || 'RIGHT',
            body: CommentPoster.withSkipHelpFooter(
              appendInlineFingerprintMarker(c.body, c.path, c.line),
              c.severity
            ),
          };

          if (startLine !== undefined && startLine !== c.line) {
            // Multi-line: use line-based parameters.
            apiComment.start_line = startLine;
            apiComment.start_side = 'RIGHT';
          }
          return apiComment;
        })
      )
    ).filter((c): c is GitHubInlineCommentPayload => c !== null);

    const coalescedApiComments =
      CommentPoster.coalesceSameRunInlineCandidates(preparedApiComments);
    const apiComments: GitHubInlineCommentPayload[] = [];
    const escalationReplies = new Map<number, InlineEscalationReply>();
    for (const apiComment of coalescedApiComments) {
      const classification = this.classifyInlineCandidate(
        activeInlineComments,
        apiComment
      );
      if (classification.kind === 'duplicate') {
        logger.info(
          `Skipping duplicate active inline comment at ${apiComment.path}:${apiComment.line}`
        );
        continue;
      }
      if (classification.kind === 'escalation') {
        const parentId = classification.parent.parentCommentDatabaseId;
        if (!parentId) {
          throw new Error(
            'Cannot post semantic escalation without the parent review comment database id'
          );
        }
        if (!headSha) {
          throw new Error(
            'Cannot post semantic escalation without an expected PR head SHA'
          );
        }
        if (
          classification.parent.inventoryHeadSha &&
          classification.parent.inventoryHeadSha !== headSha
        ) {
          throw new Error(
            'Cannot reuse a semantic escalation parent from a stale review-thread inventory'
          );
        }
        const staged = escalationReplies.get(parentId);
        if (
          !staged ||
          inlineSeverityRank(classification.severity) >
            inlineSeverityRank(staged.severity)
        ) {
          escalationReplies.set(parentId, {
            parent: classification.parent,
            severity: classification.severity,
            body: apiComment.body,
            aliasLine: apiComment.line,
          });
          classification.parent.highestTrustedEscalationSeverity =
            classification.severity;
        }
        continue;
      }

      const { semanticAliases: _semanticAliases, ...publishableComment } =
        apiComment;
      apiComments.push(publishableComment);
      CommentPoster.rememberInlineComment(
        activeInlineComments,
        publishableComment
      );
    }

    if (!this.dryRun) {
      for (const escalation of escalationReplies.values()) {
        const parentId = escalation.parent.parentCommentDatabaseId!;
        if (
          !(await this.canMutateExpectedHead(
            prNumber,
            headSha!,
            'semantic escalation reply creation'
          ))
        ) {
          return;
        }
        await this.client.octokit.rest.pulls.createReplyForReviewComment({
          owner: this.client.owner,
          repo: this.client.repo,
          pull_number: prNumber,
          comment_id: parentId,
          body: `${escalation.body.trimEnd()}\n\n${trustedEscalationMarker(parentId, escalation.severity, escalation.aliasLine)}`,
        });
      }
    }

    if (apiComments.length === 0) {
      logger.info('No inline comments with valid diff positions to post');
      return;
    }

    if (this.dryRun) {
      logger.info(
        `[DRY RUN] Would post ${apiComments.length} inline comment(s) to PR #${prNumber}`
      );
      for (const comment of apiComments) {
        logger.info(
          `[DRY RUN] Inline comment at ${comment.path}:${comment.line}:\n${comment.body.substring(0, 200)}...`
        );
      }
      return;
    }

    const { octokit, owner, repo } = this.client;
    if (
      headSha &&
      !(await this.canMutateExpectedHead(
        prNumber,
        headSha,
        'inline review creation'
      ))
    ) {
      return;
    }
    try {
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        ...(headSha ? { commit_id: headSha } : {}),
        event: 'COMMENT',
        comments: apiComments,
      });
      if (!strictInlineOnly) {
        await this.deleteInlineFallbackComments(
          prNumber,
          'inline comments posted successfully',
          headSha
        );
      }
    } catch (error) {
      if (!CommentPoster.shouldFallbackInlineReviewError(error)) {
        throw error;
      }

      logger.warn(
        strictInlineOnly
          ? 'GitHub batch inline review API failed in strict inline-only mode; retrying findings individually'
          : 'GitHub inline review API failed; posting inline findings as a PR comment fallback',
        error as Error
      );
      if (
        headSha &&
        !(await this.canMutateExpectedHead(
          prNumber,
          headSha,
          strictInlineOnly
            ? 'strict individual inline retry'
            : 'inline fallback publication'
        ))
      ) {
        return;
      }
      const remainingComments = headSha
        ? await this.postIndividualInlineComments(
            prNumber,
            apiComments,
            headSha
          )
        : apiComments;
      if (remainingComments.length > 0) {
        if (strictInlineOnly) {
          const publicationError = new Error(
            `Strict inline-only publication left ${remainingComments.length}/${apiComments.length} finding(s) unpublished after GitHub rejected batch and individual inline comment APIs`
          ) as Error & { cause?: unknown };
          publicationError.cause = error;
          logger.error(publicationError.message, error as Error);
          throw publicationError;
        } else {
          logger.warn(
            `Falling back to PR comment for ${remainingComments.length}/${apiComments.length} inline finding(s) after GitHub rejected batch and individual inline comment APIs`,
            error as Error
          );
          await this.postInlineFallback(
            prNumber,
            remainingComments,
            error as Error,
            headSha
          );
        }
      } else if (!strictInlineOnly) {
        await this.deleteInlineFallbackComments(
          prNumber,
          'inline comments posted successfully',
          headSha
        );
      }
    }
  }

  private static activeInlineCommentsFromReferences(
    references: InlineCommentReference[]
  ): ActiveInlineComments {
    const coarseKeys = new Set<string>();
    const legacyKeys = new Set<string>();
    const findingFingerprints = new Set<FindingFingerprint>();
    const comments: InlineCommentReference[] = [];

    for (const comment of references) {
      const body = comment.body || '';
      const findingMarker = parseFindingMarker(body);
      if (
        findingMarker.kind === FindingMarkerParseKind.Conflict ||
        findingMarker.kind === FindingMarkerParseKind.Malformed
      ) {
        continue;
      }
      comments.push(comment);
      for (const reference of CommentPoster.semanticReferences(comment)) {
        const signature = signatureFromInlineComment(
          reference.path,
          reference.line,
          reference.body
        );
        const fingerprint = fingerprintFromInlineComment(
          reference.path,
          reference.line,
          reference.body
        );
        coarseKeys.add(signature);
        coarseKeys.add(fingerprint);
        const marker = extractInlineFingerprint(reference.body);
        if (marker) coarseKeys.add(marker);
        const findingFingerprint = extractFindingFingerprint(reference.body);
        if (findingFingerprint) {
          findingFingerprints.add(findingFingerprint);
        } else {
          legacyKeys.add(signature);
          legacyKeys.add(fingerprint);
          if (marker) legacyKeys.add(marker);
        }
      }
    }

    return { coarseKeys, legacyKeys, findingFingerprints, comments };
  }

  private async postIndividualInlineComments(
    prNumber: number,
    comments: GitHubInlineCommentPayload[],
    headSha: string
  ): Promise<GitHubInlineCommentPayload[]> {
    const { octokit, owner, repo } = this.client;
    const failedComments: GitHubInlineCommentPayload[] = [];
    let postedCount = 0;

    for (const comment of comments) {
      if (
        !(await this.canMutateExpectedHead(
          prNumber,
          headSha,
          'individual inline comment creation'
        ))
      ) {
        return [...failedComments, ...comments.slice(postedCount)];
      }
      try {
        await octokit.rest.pulls.createReviewComment({
          owner,
          repo,
          pull_number: prNumber,
          commit_id: headSha,
          path: comment.path,
          line: comment.line,
          side: comment.side,
          ...(comment.start_line !== undefined
            ? { start_line: comment.start_line }
            : {}),
          ...(comment.start_side !== undefined
            ? { start_side: comment.start_side }
            : {}),
          body: comment.body,
        });
        postedCount++;
      } catch (error) {
        if (!CommentPoster.shouldFallbackInlineReviewError(error)) {
          throw error;
        }
        const retryComment =
          CommentPoster.withoutCommittableSuggestionForInlineRetry(comment);
        if (retryComment.body !== comment.body) {
          try {
            await octokit.rest.pulls.createReviewComment({
              owner,
              repo,
              pull_number: prNumber,
              commit_id: headSha,
              path: retryComment.path,
              line: retryComment.line,
              side: retryComment.side,
              ...(retryComment.start_line !== undefined
                ? { start_line: retryComment.start_line }
                : {}),
              ...(retryComment.start_side !== undefined
                ? { start_side: retryComment.start_side }
                : {}),
              body: retryComment.body,
            });
            logger.info(
              `Posted inline comment at ${comment.path}:${comment.line} after removing committable suggestion block rejected by GitHub`
            );
            postedCount++;
            continue;
          } catch (retryError) {
            if (!CommentPoster.shouldFallbackInlineReviewError(retryError)) {
              throw retryError;
            }
          }
        }

        failedComments.push(comment);
      }
    }

    if (postedCount > 0) {
      logger.info(
        `Posted ${postedCount}/${comments.length} inline comment(s) through individual GitHub review-comment API after batch review failed`
      );
    }
    return failedComments;
  }

  private static shouldFallbackInlineReviewError(error: unknown): boolean {
    return (error as { status?: number })?.status === 422;
  }

  private static withoutCommittableSuggestionForInlineRetry(
    comment: GitHubInlineCommentPayload
  ): GitHubInlineCommentPayload {
    if (!comment.body.includes('```suggestion')) {
      return comment;
    }

    return {
      ...comment,
      body: comment.body
        .replace(
          /```suggestion[\s\S]*?```/g,
          '_Committable suggestion omitted because GitHub rejected this inline suggestion block._'
        )
        .trim(),
    };
  }

  private static integerOrUndefined(value: unknown): number | undefined {
    return Number.isInteger(value) ? (value as number) : undefined;
  }

  private async postInlineFallback(
    prNumber: number,
    comments: GitHubInlineCommentPayload[],
    error: Error,
    headSha?: string
  ): Promise<void> {
    if (
      headSha &&
      !(await this.canMutateExpectedHead(
        prNumber,
        headSha,
        'inline fallback comment write'
      ))
    ) {
      return;
    }
    const { octokit, owner, repo } = this.client;
    const body = CommentPoster.formatInlineFallbackBody(comments, error);
    const chunks = this.chunk(body);
    const existingComments = await this.findInlineFallbackComments(prNumber);

    if (
      headSha &&
      !(await this.canMutateExpectedHead(
        prNumber,
        headSha,
        'inline fallback comment write'
      ))
    ) {
      return;
    }

    const updates = Math.min(existingComments.length, chunks.length);
    for (let i = 0; i < updates; i++) {
      await withRetry(
        () =>
          octokit.rest.issues.updateComment({
            owner,
            repo,
            comment_id: existingComments[i].id,
            body: chunks[i],
          }),
        { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
      );
    }

    for (let i = existingComments.length; i < chunks.length; i++) {
      await withRetry(
        () =>
          octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: prNumber,
            body: chunks[i],
          }),
        { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
      );
    }

    for (const stale of existingComments.slice(chunks.length)) {
      await withRetry(
        () =>
          octokit.rest.issues.deleteComment({
            owner,
            repo,
            comment_id: stale.id,
          }),
        { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
      );
    }
  }

  private async findInlineFallbackComments(
    prNumber: number
  ): Promise<Array<{ id: number; body: string }>> {
    const { octokit, owner, repo } = this.client;

    try {
      const comments = await withRetry(
        () =>
          octokit.rest.issues.listComments({
            owner,
            repo,
            issue_number: prNumber,
            per_page: 100,
          }),
        { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
      );

      return comments.data
        .filter((comment) =>
          (comment.body || '').includes(CommentPoster.INLINE_FALLBACK_MARKER)
        )
        .map((comment) => ({ id: comment.id, body: comment.body ?? '' }));
    } catch (error) {
      logger.warn(
        'Failed to find existing inline fallback comment',
        error as Error
      );
      return [];
    }
  }

  private async deleteInlineFallbackComments(
    prNumber: number,
    reason: string,
    headSha?: string
  ): Promise<void> {
    if (
      headSha &&
      !(await this.canMutateExpectedHead(
        prNumber,
        headSha,
        'inline fallback cleanup'
      ))
    ) {
      return;
    }
    const { octokit, owner, repo } = this.client;
    const existingComments = await this.findInlineFallbackComments(prNumber);

    for (const comment of existingComments) {
      await withRetry(
        () =>
          octokit.rest.issues.deleteComment({
            owner,
            repo,
            comment_id: comment.id,
          }),
        { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
      );
    }

    if (existingComments.length > 0) {
      logger.info(
        `Deleted ${existingComments.length} stale inline fallback comment(s): ${reason}`
      );
    }
  }

  private static formatInlineFallbackBody(
    comments: GitHubInlineCommentPayload[],
    error: Error
  ): string {
    const errorMessage = (error.message || String(error)).slice(0, 2000);
    const items = comments
      .map((comment, index) =>
        [
          `### ${index + 1}. ${CommentPoster.formatApiCommentLocation(comment)}`,
          '',
          CommentPoster.stripUnsupportedFallbackText(comment.body),
        ].join('\n')
      )
      .join('\n\n---\n\n');

    return [
      CommentPoster.INLINE_FALLBACK_MARKER,
      '',
      '# ReviewRouter inline fallback',
      '',
      'GitHub could not create inline review comments for this run, so ReviewRouter is posting the findings as a normal PR comment. Severity gating still uses these findings.',
      '',
      '<details>',
      '<summary>GitHub API error</summary>',
      '',
      '```text',
      errorMessage,
      '```',
      '',
      '</details>',
      '',
      '## Findings',
      '',
      items,
    ].join('\n');
  }

  private static formatApiCommentLocation(
    comment: GitHubInlineCommentPayload
  ): string {
    return comment.start_line !== undefined && comment.start_line < comment.line
      ? `${comment.path}:${comment.start_line}-${comment.line}`
      : `${comment.path}:${comment.line}`;
  }

  private static stripUnsupportedFallbackText(body: string): string {
    return body
      .replace(/<sub><!-- review-router-skip-help -->[\s\S]*?<\/sub>/g, '')
      .replace(
        /```suggestion[\s\S]*?```/g,
        '_Committable suggestion is only available on inline review comments._'
      )
      .trim();
  }

  private chunk(content: string): string[] {
    const paragraphs = content.split('\n\n');
    const chunks: string[] = [];
    let current = '';

    for (const para of paragraphs) {
      if (
        Buffer.byteLength(current + para, 'utf8') >
        CommentPoster.MAX_COMMENT_SIZE
      ) {
        if (current) {
          chunks.push(current.trim());
          current = '';
        }
        if (Buffer.byteLength(para, 'utf8') > CommentPoster.MAX_COMMENT_SIZE) {
          const lines = para.split('\n');
          let lineChunk = '';
          for (const line of lines) {
            if (
              Buffer.byteLength(lineChunk + line + '\n', 'utf8') >
              CommentPoster.MAX_COMMENT_SIZE
            ) {
              chunks.push(lineChunk.trim());
              lineChunk = '';
            }
            lineChunk += line + '\n';
          }
          current = lineChunk + '\n\n';
        } else {
          current = para + '\n\n';
        }
      } else {
        current += para + '\n\n';
      }
    }

    if (current.trim()) chunks.push(current.trim());
    logger.info(`Prepared ${chunks.length} comment chunk(s)`);
    return chunks;
  }

  private static withSkipHelpFooter(body: string, severity?: Severity): string {
    if (body.includes(CommentPoster.INLINE_SKIP_HELP_MARKER)) {
      return body;
    }

    const actor =
      severity === 'minor' ? 'Someone with write access' : 'A maintainer/admin';
    const footer = `<sub>${CommentPoster.INLINE_SKIP_HELP_MARKER}${actor} can reply \`/rr skip\` if this finding is a false positive. ReviewRouter records a signed override and reruns the check.</sub>`;
    const { visibleBody, markers } = CommentPoster.splitTrailingInlineMarkers(
      body.trimEnd()
    );
    return [visibleBody, footer, ...markers].join('\n');
  }

  private static splitTrailingInlineMarkers(body: string): {
    visibleBody: string;
    markers: string[];
  } {
    const markers: string[] = [];
    let visibleBody = body;
    const markerPattern =
      /\n\n(<!--\s*(?:(?:review-router|ai-robot-review)-inline:[a-f0-9]{16}|review-router-finding:[a-f0-9]{24,64})\s*-->)$/i;

    let match = visibleBody.match(markerPattern);
    while (match?.[1]) {
      markers.unshift(match[1]);
      visibleBody = visibleBody.slice(0, match.index).trimEnd();
      match = visibleBody.match(markerPattern);
    }

    return { visibleBody, markers };
  }
}
