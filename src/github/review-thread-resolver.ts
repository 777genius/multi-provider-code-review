import { GitHubClient } from './client';
import {
  LifecycleMutationFailure,
  LifecycleReasonCode,
  LifecycleResolvedThread,
  LifecycleThreadRecord,
} from '../types';
import {
  FindingMarkerParseKind,
  parseFindingMarker,
} from '../review-projection/domain';
import {
  DEFAULT_TRUSTED_REVIEW_THREAD_AUTHORS,
  isTrustedReviewThreadAuthor,
} from './review-thread-inventory';
import {
  BackendReviewThreadLifecycleResolveResponse,
  ReviewThreadLifecycleBackendResolver,
} from '../control-plane/review-thread-lifecycle';
import { logger } from '../utils/logger';
import {
  PullRequestHeadVerificationStatus,
  verifyPullRequestHead,
} from './pr-head-guard';

export interface ReviewThreadResolveResult {
  resolved: LifecycleResolvedThread[];
  skipped: LifecycleThreadRecord[];
  manualAttention: LifecycleThreadRecord[];
  failed: LifecycleMutationFailure[];
  warnings: string[];
}

interface GraphQLPageInfo {
  hasNextPage: boolean;
  endCursor?: string | null;
}

interface GraphQLComment {
  id: string;
  databaseId?: number | null;
  author?: { login?: string | null } | null;
  body?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface GraphQLThread {
  id: string;
  isResolved: boolean;
  viewerCanResolve?: boolean | null;
  comments?: {
    pageInfo: GraphQLPageInfo;
    nodes: GraphQLComment[];
  } | null;
}

const HEAD_QUERY = `
query ReviewRouterResolveHeadGuard($owner: String!, $repo: String!, $prNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      headRefOid
    }
  }
}`;

const THREAD_QUERY = `
query ReviewRouterResolveThreadGuard($threadId: ID!) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      id
      isResolved
      viewerCanResolve
      comments(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          databaseId
          author { login }
          body
          createdAt
          updatedAt
        }
      }
    }
  }
}`;

const RESOLVE_MUTATION = `
mutation ReviewRouterResolveReviewThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread {
      id
      isResolved
    }
  }
}`;

const RESOLUTION_REPLY_MARKER = 'reviewrouter-lifecycle-resolution:v1';

export class ReviewThreadResolver {
  constructor(
    private readonly client: GitHubClient,
    private readonly dryRun = false,
    private readonly trustedAuthors = DEFAULT_TRUSTED_REVIEW_THREAD_AUTHORS,
    private readonly mutationFallbackClient?: GitHubClient,
    private readonly backendResolver?: ReviewThreadLifecycleBackendResolver
  ) {}

  async resolveGuarded(
    prNumber: number,
    reviewedHeadSha: string,
    candidates: LifecycleThreadRecord[]
  ): Promise<ReviewThreadResolveResult> {
    const result: ReviewThreadResolveResult = {
      resolved: [],
      skipped: [],
      manualAttention: [],
      failed: [],
      warnings: [],
    };

    if (candidates.length === 0) {
      return result;
    }

    if (this.dryRun) {
      result.skipped.push(
        ...candidates.map((candidate) =>
          this.withReason(candidate, ['dry_run'])
        )
      );
      return result;
    }

    let freshHeadSha: string | undefined;
    try {
      freshHeadSha = await this.loadHeadSha(prNumber);
    } catch (error) {
      logger.warn(
        'Failed to refresh PR head before review thread lifecycle mutations',
        error as Error
      );
      if (isRateLimitedError(error)) {
        result.skipped.push(
          ...candidates.map((candidate) =>
            this.withReason(candidate, ['mutation_rate_limited'])
          )
        );
        result.warnings.push(
          'review thread lifecycle mutations stopped because GitHub rate limited the request'
        );
        return result;
      }
      result.skipped.push(
        ...candidates.map((candidate) =>
          this.withReason(candidate, ['thread_changed_before_mutation'])
        )
      );
      return result;
    }

    if (!freshHeadSha || freshHeadSha !== reviewedHeadSha) {
      result.skipped.push(
        ...candidates.map((candidate) =>
          this.withReason(candidate, ['head_sha_changed'])
        )
      );
      return result;
    }

    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      let thread: GraphQLThread | null;
      try {
        thread = await this.loadThread(candidate.target.threadId);
      } catch (error) {
        if (isRateLimitedError(error)) {
          result.skipped.push(
            ...candidates
              .slice(index)
              .map((remaining) =>
                this.withReason(remaining, ['mutation_rate_limited'])
              )
          );
          result.warnings.push(
            'review thread lifecycle mutations stopped because GitHub rate limited the request'
          );
          return result;
        }
        result.skipped.push(
          this.withReason(candidate, ['thread_changed_before_mutation'])
        );
        continue;
      }

      const guard = this.guardCandidate(candidate, thread);
      if (guard.kind === 'resolved') {
        result.resolved.push({
          ...this.withReason(candidate, guard.reasonCodes),
          resolvedBy: guard.resolvedBy,
        });
        continue;
      }
      if (guard.kind === 'manual') {
        result.manualAttention.push(
          this.withReason(candidate, guard.reasonCodes)
        );
        continue;
      }
      if (guard.kind === 'skipped') {
        result.skipped.push(this.withReason(candidate, guard.reasonCodes));
        continue;
      }

      const mutationHeadFailure = await this.headMutationFailureReason(
        prNumber,
        reviewedHeadSha
      );
      if (mutationHeadFailure) {
        result.skipped.push(
          ...candidates
            .slice(index)
            .map((remaining) =>
              this.withReason(remaining, [mutationHeadFailure])
            )
        );
        result.warnings.push(
          'review thread lifecycle mutations stopped because the analyzed PR head is no longer verifiably current'
        );
        return result;
      }

      try {
        await this.resolveThread(candidate.target.threadId);
        result.resolved.push({
          ...this.withReason(candidate, []),
          resolvedBy: 'review-router',
        });
      } catch (error) {
        if (isRateLimitedError(error)) {
          result.skipped.push(
            ...candidates
              .slice(index)
              .map((remaining) =>
                this.withReason(remaining, ['mutation_rate_limited'])
              )
          );
          result.warnings.push(
            'review thread lifecycle mutations stopped because GitHub rate limited the request'
          );
          return result;
        }
        if (permissionDenied(error) && this.backendResolver) {
          const backendHeadFailure = await this.headMutationFailureReason(
            prNumber,
            reviewedHeadSha
          );
          if (backendHeadFailure) {
            result.skipped.push(
              ...candidates
                .slice(index)
                .map((remaining) =>
                  this.withReason(remaining, [backendHeadFailure])
                )
            );
            return result;
          }
          const backendResult = await this.tryBackendResolve(
            prNumber,
            reviewedHeadSha,
            candidate
          );
          if (backendResult?.status === 'resolved') {
            result.resolved.push({
              ...this.withReason(
                candidate,
                mapBackendReasonCodes(backendResult.reasonCodes)
              ),
              resolvedBy: 'review-router',
            });
            continue;
          }
          if (backendResult?.status === 'already_resolved') {
            result.resolved.push({
              ...this.withReason(
                candidate,
                mapBackendReasonCodes(backendResult.reasonCodes, [
                  'already_resolved',
                ])
              ),
              resolvedBy: 'external',
            });
            continue;
          }
          if (backendResult?.status === 'manual_attention') {
            result.manualAttention.push(
              this.withReason(
                candidate,
                mapBackendReasonCodes(backendResult.reasonCodes, [
                  'human_reply',
                ])
              )
            );
            continue;
          }
          if (backendResult?.status === 'skipped') {
            result.skipped.push(
              this.withReason(
                candidate,
                mapBackendReasonCodes(backendResult.reasonCodes, [
                  'thread_changed_before_mutation',
                ])
              )
            );
            continue;
          }
        }

        const fallbackHeadFailure = permissionDenied(error)
          ? await this.headMutationFailureReason(prNumber, reviewedHeadSha)
          : null;
        if (fallbackHeadFailure) {
          result.skipped.push(
            ...candidates
              .slice(index)
              .map((remaining) =>
                this.withReason(remaining, [fallbackHeadFailure])
              )
          );
          return result;
        }
        const fallbackCommentPosted = permissionDenied(error)
          ? await this.tryPostResolutionFallbackComment(
              prNumber,
              candidate,
              thread
            )
          : false;
        const fallbackCommentFailed =
          permissionDenied(error) && !fallbackCommentPosted;
        result.failed.push({
          ...this.withReason(candidate, [
            permissionDenied(error)
              ? 'mutation_permission_denied'
              : 'mutation_failed',
            ...(fallbackCommentPosted
              ? (['resolution_comment_posted'] as LifecycleReasonCode[])
              : []),
            ...(fallbackCommentFailed
              ? (['resolution_comment_failed'] as LifecycleReasonCode[])
              : []),
          ]),
          errorMessage: errorMessage(error),
        });
      }
    }

    return result;
  }

  private guardCandidate(
    candidate: LifecycleThreadRecord,
    thread: GraphQLThread | null
  ):
    | {
        kind: 'ready';
      }
    | {
        kind: 'resolved';
        resolvedBy: 'external';
        reasonCodes: LifecycleReasonCode[];
      }
    | {
        kind: 'manual' | 'skipped';
        reasonCodes: LifecycleReasonCode[];
      } {
    if (!thread) {
      return { kind: 'skipped', reasonCodes: ['thread_not_found'] };
    }
    if (thread.isResolved) {
      return {
        kind: 'resolved',
        resolvedBy: 'external',
        reasonCodes: ['already_resolved'],
      };
    }
    const comments = thread.comments?.nodes ?? [];
    if (thread.comments?.pageInfo.hasNextPage) {
      return { kind: 'skipped', reasonCodes: ['pagination_incomplete'] };
    }

    const parent = comments.find(
      (comment) => comment.id === candidate.target.parentCommentId
    );
    const parentIndex = comments.findIndex(
      (comment) => comment.id === candidate.target.parentCommentId
    );
    if (!parent) {
      return {
        kind: 'skipped',
        reasonCodes: ['thread_changed_before_mutation'],
      };
    }
    if (!this.isTrustedAuthor(parent.author?.login)) {
      return {
        kind: 'manual',
        reasonCodes: ['untrusted_author'],
      };
    }
    const marker = parseFindingMarker(parent.body || '');
    if (
      marker.kind !== FindingMarkerParseKind.Valid ||
      marker.fingerprint !== candidate.target.fingerprint
    ) {
      return {
        kind: 'skipped',
        reasonCodes: ['thread_changed_before_mutation'],
      };
    }
    const parentUpdatedAt =
      parent.updatedAt || parent.createdAt || new Date(0).toISOString();
    if (parentUpdatedAt !== candidate.target.parentCommentUpdatedAt) {
      return {
        kind: 'skipped',
        reasonCodes: ['thread_changed_before_mutation'],
      };
    }
    if (comments.length !== candidate.target.threadCommentCount) {
      const hasHumanReply = comments.some(
        (comment, index) =>
          index > parentIndex &&
          comment.id !== candidate.target.parentCommentId &&
          !this.isTrustedAuthor(comment.author?.login)
      );
      return {
        kind: hasHumanReply ? 'manual' : 'skipped',
        reasonCodes: hasHumanReply
          ? ['human_reply']
          : ['thread_changed_before_mutation'],
      };
    }

    const hasHumanReply = comments.some(
      (comment, index) =>
        index > parentIndex &&
        comment.id !== candidate.target.parentCommentId &&
        !this.isTrustedAuthor(comment.author?.login)
    );
    if (hasHumanReply) {
      return { kind: 'manual', reasonCodes: ['human_reply'] };
    }

    return { kind: 'ready' };
  }

  private withReason(
    record: LifecycleThreadRecord,
    reasonCodes: LifecycleReasonCode[]
  ): LifecycleThreadRecord {
    return {
      ...record,
      reasonCodes: unique([
        ...record.reasonCodes,
        ...reasonCodes,
      ]) as LifecycleReasonCode[],
    };
  }

  private isTrustedAuthor(login?: string | null): boolean {
    return isTrustedReviewThreadAuthor(login, this.trustedAuthors);
  }

  private async loadHeadSha(prNumber: number): Promise<string | undefined> {
    const response = await this.graphql<{
      repository?: {
        pullRequest?: {
          headRefOid?: string | null;
        } | null;
      } | null;
    }>(HEAD_QUERY, {
      owner: this.client.owner,
      repo: this.client.repo,
      prNumber,
    });
    return response.repository?.pullRequest?.headRefOid ?? undefined;
  }

  private async headMutationFailureReason(
    prNumber: number,
    reviewedHeadSha: string
  ): Promise<LifecycleReasonCode | null> {
    const verification = await verifyPullRequestHead(this.client.octokit, {
      owner: this.client.owner,
      repo: this.client.repo,
      prNumber,
      expectedHeadSha: reviewedHeadSha,
    });
    if (verification.status === PullRequestHeadVerificationStatus.Current) {
      return null;
    }
    if (verification.status === PullRequestHeadVerificationStatus.Changed) {
      return 'head_sha_changed';
    }
    logger.warn(
      'Failed to verify PR head immediately before review thread lifecycle mutation; failing closed',
      verification.error as Error | undefined
    );
    return 'thread_changed_before_mutation';
  }

  private async loadThread(threadId: string): Promise<GraphQLThread | null> {
    const response = await this.graphql<{ node?: GraphQLThread | null }>(
      THREAD_QUERY,
      { threadId }
    );
    return response.node ?? null;
  }

  private async resolveThread(threadId: string): Promise<void> {
    try {
      await this.resolveThreadWithClient(this.client, threadId);
    } catch (error) {
      if (!permissionDenied(error) || !this.mutationFallbackClient) {
        throw error;
      }
      logger.warn(
        'Primary review thread lifecycle token cannot resolve thread; retrying with lifecycle fallback token',
        error as Error
      );
      await this.resolveThreadWithClient(this.mutationFallbackClient, threadId);
    }
  }

  private async resolveThreadWithClient(
    client: GitHubClient,
    threadId: string
  ): Promise<void> {
    const response = await this.graphql<{
      resolveReviewThread?: {
        thread?: {
          id: string;
          isResolved: boolean;
        } | null;
      } | null;
    }>(RESOLVE_MUTATION, { threadId }, client);
    if (!response.resolveReviewThread?.thread?.isResolved) {
      throw new Error('GitHub did not mark review thread resolved');
    }
  }

  private async tryBackendResolve(
    prNumber: number,
    reviewedHeadSha: string,
    candidate: LifecycleThreadRecord
  ): Promise<BackendReviewThreadLifecycleResolveResponse | undefined> {
    if (!this.backendResolver) return undefined;
    try {
      return await this.backendResolver.resolveReviewThread({
        prNumber,
        reviewedHeadSha,
        candidate,
      });
    } catch (error) {
      logger.warn(
        'Backend review thread lifecycle resolver could not resolve thread',
        error as Error
      );
      return undefined;
    }
  }

  private async tryPostResolutionFallbackComment(
    prNumber: number,
    candidate: LifecycleThreadRecord,
    thread: GraphQLThread | null
  ): Promise<boolean> {
    const parentCommentDatabaseId = candidate.target.parentCommentDatabaseId;
    if (!parentCommentDatabaseId) {
      return false;
    }
    const comments = thread?.comments?.nodes ?? [];
    if (
      comments.some((comment) =>
        comment.body?.includes(
          `${RESOLUTION_REPLY_MARKER} target_id=${candidate.target.targetId}`
        )
      )
    ) {
      return true;
    }

    try {
      await this.client.octokit.rest.pulls.createReplyForReviewComment({
        owner: this.client.owner,
        repo: this.client.repo,
        pull_number: prNumber,
        comment_id: parentCommentDatabaseId,
        body: renderResolutionFallbackComment(candidate),
      });
      return true;
    } catch (error) {
      logger.warn(
        'Failed to post review thread lifecycle resolution fallback reply',
        error as Error
      );
      return false;
    }
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    client: GitHubClient = this.client
  ): Promise<T> {
    const graphql = (
      client.octokit as unknown as {
        graphql?: (
          query: string,
          variables: Record<string, unknown>
        ) => Promise<T>;
      }
    ).graphql;
    if (typeof graphql !== 'function') {
      throw new Error('GitHub GraphQL client is unavailable');
    }
    return graphql(query, variables);
  }
}

function isRateLimitedError(error: unknown): boolean {
  const maybe = error as { status?: number; message?: string };
  const message = maybe?.message || String(error);
  return (
    maybe?.status === 429 ||
    (maybe?.status === 403 &&
      /rate limit|secondary rate limit|abuse detection/i.test(message))
  );
}

function permissionDenied(error: unknown): boolean {
  const maybe = error as { status?: number; message?: string };
  const message = maybe?.message || String(error);
  return (
    maybe?.status === 401 ||
    maybe?.status === 403 ||
    /permission|forbidden|resource not accessible/i.test(message)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderResolutionFallbackComment(
  candidate: LifecycleThreadRecord
): string {
  return [
    `<!-- ${RESOLUTION_REPLY_MARKER} target_id=${candidate.target.targetId} fingerprint=${candidate.target.fingerprint} -->`,
    '',
    '**Resolved ✅ ✅ ✅**',
    '',
    '<sub>ReviewRouter rechecked this finding and the provider quorum marked it resolved. GitHub did not allow the app token to close this review thread automatically, so a maintainer can click Resolve conversation.</sub>',
  ].join('\n');
}

function mapBackendReasonCodes(
  reasonCodes: readonly string[],
  fallback: LifecycleReasonCode[] = []
): LifecycleReasonCode[] {
  const allowed = new Set<LifecycleReasonCode>([
    'already_resolved',
    'head_sha_changed',
    'human_reply',
    'mutation_failed',
    'mutation_permission_denied',
    'pagination_incomplete',
    'thread_changed_before_mutation',
    'thread_not_found',
    'untrusted_author',
    'viewer_cannot_resolve',
  ]);
  const mapped = reasonCodes.filter((reason): reason is LifecycleReasonCode =>
    allowed.has(reason as LifecycleReasonCode)
  );
  return mapped.length > 0 ? mapped : fallback;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
