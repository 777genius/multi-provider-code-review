import { createHash } from 'crypto';
import { GitHubClient } from './client';
import { LifecycleReasonCode, LifecycleTarget } from '../types';
import {
  extractInlineSeverity,
  extractInlineTitle,
  inlineSeverityRank,
  InlineCommentReference,
  parseTrustedEscalationMarker,
  stripInlineFingerprintMarkers,
} from './comment-fingerprint';
import { logger } from '../utils/logger';
import {
  FindingMarkerParseKind,
  hashReviewLifecycleThreadState,
  isReviewLifecycleMarkerFingerprint,
  parseFindingMarker,
} from '../review-projection/domain';

export const DEFAULT_TRUSTED_REVIEW_THREAD_AUTHORS = ['review-router-ai[bot]'];
const GITHUB_ACTIONS_BOT_AUTHOR = 'github-actions[bot]';
const RESOLUTION_REPLY_MARKER = 'reviewrouter-lifecycle-resolution:v1';

const TRUSTED_AUTHOR_ENV_KEYS = [
  'REVIEW_THREAD_LIFECYCLE_TRUSTED_AUTHORS',
  'REVIEW_ROUTER_TRUSTED_BOT_AUTHORS',
];

const APP_BOT_LOGIN_ENV_KEYS = [
  'REVIEW_APP_BOT_LOGIN',
  'REVIEW_ROUTER_APP_BOT_LOGIN',
  'REVIEWROUTER_APP_BOT_LOGIN',
];

const APP_SLUG_ENV_KEYS = [
  'REVIEW_APP_SLUG',
  'REVIEW_ROUTER_APP_SLUG',
  'REVIEWROUTER_APP_SLUG',
  'AI_ROBOT_REVIEW_APP_SLUG',
];

const MAX_REVIEW_THREAD_PAGES = 100;
const MAX_REVIEW_THREAD_COMMENT_PAGES = 100;

export interface ReviewThreadInventory {
  headRefOid?: string;
  candidates: ReviewThreadLifecycleTarget[];
  manualAttention: ReviewThreadLifecycleRecord[];
  manualAttentionIssues: ReviewThreadMarkerIssue[];
  dedupeComments: InlineCommentReference[];
  /** Trusted immutable top-level findings; replies are never projected here. */
  topLevelParents: InlineCommentReference[];
  warnings: string[];
  failed: boolean;
}

export interface ReviewThreadMarkerIssue {
  readonly threadId: string;
  readonly parentCommentId: string;
  readonly threadUrl?: string;
  readonly reason: 'conflicting_finding_marker' | 'malformed_finding_marker';
}

export interface ReviewThreadLifecycleTarget extends LifecycleTarget {
  readonly threadStateHash: string;
}

export interface ReviewThreadLifecycleRecord {
  readonly target: ReviewThreadLifecycleTarget;
  readonly reasonCodes: LifecycleReasonCode[];
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
  path?: string | null;
  line?: number | null;
  originalLine?: number | null;
  diffHunk?: string | null;
  url?: string | null;
}

interface GraphQLThread {
  id: string;
  isResolved: boolean;
  isOutdated?: boolean;
  viewerCanResolve?: boolean;
  path?: string | null;
  line?: number | null;
  originalLine?: number | null;
  comments?: {
    pageInfo: GraphQLPageInfo;
    nodes: GraphQLComment[];
  };
}

interface GraphQLThreadCommentsResponse {
  node?: {
    comments?: {
      pageInfo: GraphQLPageInfo;
      nodes: GraphQLComment[];
    } | null;
  } | null;
}

const INVENTORY_QUERY = `
query ReviewRouterThreadInventory(
  $owner: String!
  $repo: String!
  $prNumber: Int!
  $threadsAfter: String
) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      headRefOid
      reviewThreads(first: 50, after: $threadsAfter) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          viewerCanResolve
          path
          line
          originalLine
          comments(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              databaseId
              author { login }
              body
              createdAt
              updatedAt
              path
              line
              originalLine
              diffHunk
              url
            }
          }
        }
      }
    }
  }
}`;

const THREAD_COMMENTS_QUERY = `
query ReviewRouterThreadComments($threadId: ID!, $commentsAfter: String) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $commentsAfter) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          databaseId
          author { login }
          body
          createdAt
          updatedAt
          path
          line
          originalLine
          diffHunk
          url
        }
      }
    }
  }
}`;

export class ReviewThreadInventoryLoader {
  constructor(
    private readonly client: GitHubClient,
    private readonly trustedAuthors = DEFAULT_TRUSTED_REVIEW_THREAD_AUTHORS
  ) {}

  async load(prNumber: number): Promise<ReviewThreadInventory> {
    const inventory: ReviewThreadInventory = {
      candidates: [],
      manualAttention: [],
      manualAttentionIssues: [],
      dedupeComments: [],
      topLevelParents: [],
      warnings: [],
      failed: false,
    };

    try {
      let cursor: string | null | undefined;
      let pageCount = 0;
      const seenCursors = new Set<string>();
      do {
        if (pageCount >= MAX_REVIEW_THREAD_PAGES) {
          throw new Error('review thread pagination page limit exceeded');
        }
        pageCount += 1;
        const response = await this.graphql<{
          repository?: {
            pullRequest?: {
              headRefOid?: string;
              reviewThreads?: {
                pageInfo: GraphQLPageInfo;
                nodes: GraphQLThread[];
              };
            } | null;
          } | null;
        }>(INVENTORY_QUERY, {
          owner: this.client.owner,
          repo: this.client.repo,
          prNumber,
          threadsAfter: cursor ?? null,
        });
        const pr = response.repository?.pullRequest;
        if (!pr?.headRefOid || !pr.reviewThreads) {
          throw new Error('pull request review thread connection was missing');
        }
        inventory.headRefOid = pr.headRefOid;
        const threads = pr.reviewThreads;
        if (!Array.isArray(threads.nodes)) {
          throw new Error('pull request review thread nodes were missing');
        }
        for (const thread of threads.nodes || []) {
          await this.classifyThread(thread, inventory);
        }
        if (threads.pageInfo.hasNextPage) {
          if (!threads.pageInfo.endCursor) {
            throw new Error('review thread pagination cursor was missing');
          }
          if (seenCursors.has(threads.pageInfo.endCursor)) {
            throw new Error('review thread pagination cursor repeated');
          }
          seenCursors.add(threads.pageInfo.endCursor);
          cursor = threads.pageInfo.endCursor;
        } else {
          cursor = null;
        }
      } while (cursor);
      if (inventory.failed) {
        inventory.candidates = [];
        inventory.dedupeComments = [];
        inventory.topLevelParents = [];
      }
    } catch (error) {
      logger.warn(
        'Failed to load ReviewRouter review thread lifecycle inventory',
        error as Error
      );
      inventory.candidates = [];
      inventory.manualAttention = [];
      inventory.manualAttentionIssues = [];
      inventory.dedupeComments = [];
      inventory.topLevelParents = [];
      inventory.failed = true;
      inventory.warnings.push('review thread lifecycle inventory failed');
    }

    return inventory;
  }

  private async classifyThread(
    thread: GraphQLThread,
    inventory: ReviewThreadInventory
  ): Promise<void> {
    if (thread.isResolved) {
      return;
    }

    if (!thread.comments || !Array.isArray(thread.comments.nodes)) {
      throw new Error(`thread ${thread.id} comments connection was missing`);
    }

    let comments = thread.comments.nodes;
    if (thread.comments.pageInfo.hasNextPage) {
      comments = await this.loadRemainingThreadComments(
        thread.id,
        comments,
        thread.comments.pageInfo.endCursor ?? null
      );
    }

    const parent = comments[0];
    if (!parent) {
      throw new Error(`thread ${thread.id} parent comment was missing`);
    }
    const trustedAuthor = this.isTrustedAuthor(parent.author?.login);
    const marker = parseFindingMarker(parent.body ?? '');
    if (
      marker.kind === FindingMarkerParseKind.Conflict ||
      marker.kind === FindingMarkerParseKind.Malformed
    ) {
      if (trustedAuthor) {
        const reason =
          marker.kind === FindingMarkerParseKind.Conflict
            ? 'conflicting_finding_marker'
            : 'malformed_finding_marker';
        inventory.failed = true;
        inventory.manualAttentionIssues.push({
          threadId: thread.id,
          parentCommentId: parent.id,
          ...(parent.url ? { threadUrl: parent.url } : {}),
          reason,
        });
        inventory.warnings.push(
          `trusted ReviewRouter thread ${thread.id} has a ${reason.replaceAll('_', ' ')}`
        );
      }
      return;
    }
    if (marker.kind === FindingMarkerParseKind.Absent) {
      return;
    }

    const threadStateHash = hashReviewLifecycleThreadState({
      threadId: thread.id,
      comments: comments.map((comment) => ({
        id: comment.id,
        authorLogin: comment.author?.login,
        body: comment.body,
        createdAt: requireCommentTimestamp(comment.createdAt),
        updatedAt: comment.updatedAt,
      })),
    });

    const body = parent.body || '';
    const fingerprint = marker.fingerprint;

    const humanReply = comments.some(
      (comment, index) =>
        index > 0 &&
        comment.id !== parent.id &&
        !this.isTrustedAuthor(comment.author?.login)
    );
    const cleanBody = stripLifecycleCommentBody(body);
    const parsedTitle = extractInlineTitle(cleanBody);
    const hasOldFindingDetails = Boolean(
      cleanBody.trim() || parsedTitle.trim()
    );
    const title = parsedTitle || 'Previous ReviewRouter finding';
    const severity = normalizeLifecycleSeverity(extractInlineSeverity(body));
    const trustedEscalation = this.trustedEscalationFacts(
      comments,
      parent,
      severity
    );
    const message = cleanBody || parsedTitle || title;
    const reasonCodes: LifecycleReasonCode[] = [];

    if (!trustedAuthor) reasonCodes.push('untrusted_author');
    if (humanReply) reasonCodes.push('human_reply');
    if (!hasOldFindingDetails) reasonCodes.push('missing_old_finding_details');
    const targetId = targetIdFor(thread.id, parent.id, fingerprint);
    const trustedResolutionMarker = findTrustedResolutionMarker({
      comments,
      targetId,
      fingerprint,
      expectedAuthorLogin: parent.author?.login,
      isTrustedAuthor: (login) => this.isTrustedAuthor(login),
    });
    const target: ReviewThreadLifecycleTarget = {
      targetId,
      threadId: thread.id,
      threadUrl: parent.url ?? undefined,
      fingerprint,
      severity,
      title,
      message,
      originalPath: parent.path || thread.path || 'unknown',
      currentPath: thread.path || parent.path || undefined,
      originalLine: parent.originalLine ?? thread.originalLine ?? undefined,
      currentLine: parent.line ?? thread.line ?? undefined,
      diffHunk: parent.diffHunk ?? undefined,
      parentCommentId: parent.id,
      parentCommentDatabaseId: parent.databaseId ?? undefined,
      parentCommentUpdatedAt: normalizeCommentTimestamp(
        parent.updatedAt ?? requireCommentTimestamp(parent.createdAt)
      ),
      threadCommentCount: comments.length,
      threadStateHash,
      viewerCanResolve: Boolean(thread.viewerCanResolve),
      hasHumanReply: humanReply,
      trustedAuthor,
      ...(trustedResolutionMarker ? { trustedResolutionMarker } : {}),
      reasonCodes,
    };

    if (
      trustedAuthor &&
      !thread.isOutdated &&
      target.currentPath &&
      target.currentLine != null
    ) {
      const parentReference: InlineCommentReference = {
        path: target.currentPath,
        line: target.currentLine,
        body,
        ...(parent.databaseId != null
          ? { parentCommentDatabaseId: parent.databaseId }
          : {}),
        highestTrustedEscalationSeverity: trustedEscalation.highestSeverity,
        ...(trustedEscalation.aliases.length > 0
          ? {
              semanticAliases: trustedEscalation.aliases.map((alias) => ({
                path: target.currentPath,
                line: alias.line ?? target.currentLine,
                body: alias.body,
              })),
            }
          : {}),
        ...(inventory.headRefOid
          ? { inventoryHeadSha: inventory.headRefOid }
          : {}),
      };
      inventory.topLevelParents.push(parentReference);
      inventory.dedupeComments.push(parentReference);
    }

    if (reasonCodes.length > 0) {
      inventory.manualAttention.push({
        target,
        reasonCodes,
      });
      return;
    }

    inventory.candidates.push(target);
  }

  private trustedEscalationFacts(
    comments: GraphQLComment[],
    parent: GraphQLComment,
    parentSeverity: LifecycleTarget['severity']
  ): {
    highestSeverity: 'minor' | 'major' | 'critical';
    aliases: Array<{ body: string; line?: number }>;
  } {
    let highest: 'minor' | 'major' | 'critical' =
      parentSeverity === 'unknown' ? 'minor' : parentSeverity;
    const aliases: Array<{ body: string; line?: number }> = [];
    for (const reply of comments.slice(1)) {
      if (!this.isTrustedAuthor(reply.author?.login)) continue;
      const parsed = parseTrustedEscalationMarker(reply.body);
      if (parsed.kind === 'absent') continue;
      if (parsed.kind === 'malformed' || parsed.kind === 'conflict') {
        throw new Error(
          `trusted escalation marker in ${reply.id} was ${parsed.kind}`
        );
      }
      if (
        parent.databaseId == null ||
        parsed.parentCommentDatabaseId !== parent.databaseId
      ) {
        throw new Error(
          `trusted escalation marker in ${reply.id} referenced a conflicting parent`
        );
      }
      if (
        inlineSeverityRank(parsed.targetSeverity) > inlineSeverityRank(highest)
      ) {
        highest = parsed.targetSeverity;
      }
      aliases.push({
        body: reply.body ?? '',
        ...(parsed.aliasLine !== undefined ? { line: parsed.aliasLine } : {}),
      });
    }
    return { highestSeverity: highest, aliases };
  }

  private isTrustedAuthor(login?: string | null): boolean {
    return isTrustedReviewThreadAuthor(login, this.trustedAuthors);
  }

  private async loadRemainingThreadComments(
    threadId: string,
    initialComments: GraphQLComment[],
    initialCursor: string | null
  ): Promise<GraphQLComment[]> {
    if (!initialCursor) {
      throw new Error('thread comments pagination cursor was missing');
    }
    const comments = [...initialComments];
    let cursor: string | null = initialCursor;
    let pageCount = 0;
    const seenCursors = new Set([initialCursor]);

    while (cursor) {
      if (pageCount >= MAX_REVIEW_THREAD_COMMENT_PAGES) {
        throw new Error('thread comments pagination page limit exceeded');
      }
      pageCount += 1;
      const response: GraphQLThreadCommentsResponse =
        await this.graphql<GraphQLThreadCommentsResponse>(
          THREAD_COMMENTS_QUERY,
          {
            threadId,
            commentsAfter: cursor,
          }
        );
      const connection = response.node?.comments ?? null;
      if (!connection) {
        throw new Error('thread comments connection was missing');
      }
      if (!Array.isArray(connection.nodes)) {
        throw new Error('thread comments nodes were missing');
      }
      comments.push(...connection.nodes);
      if (!connection.pageInfo.hasNextPage) {
        cursor = null;
        break;
      }
      if (!connection.pageInfo.endCursor) {
        throw new Error('thread comments pagination cursor was missing');
      }
      if (seenCursors.has(connection.pageInfo.endCursor)) {
        throw new Error('thread comments pagination cursor repeated');
      }
      seenCursors.add(connection.pageInfo.endCursor);
      cursor = connection.pageInfo.endCursor;
    }

    return comments;
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>
  ): Promise<T> {
    const graphql = (
      this.client.octokit as unknown as {
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

export function isTrustedReviewThreadAuthor(
  login?: string | null,
  trustedAuthors: readonly string[] = DEFAULT_TRUSTED_REVIEW_THREAD_AUTHORS
): boolean {
  const normalizedLogin = canonicalBotLogin(login);
  return Boolean(
    normalizedLogin &&
    trustedAuthors.some(
      (author) => canonicalBotLogin(author) === normalizedLogin
    )
  );
}

export function trustedReviewThreadAuthorsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const authors = new Set(
    DEFAULT_TRUSTED_REVIEW_THREAD_AUTHORS.map((author) => author.toLowerCase())
  );
  if (shouldTrustGitHubActionsBot(env)) {
    authors.add(GITHUB_ACTIONS_BOT_AUTHOR);
  }

  for (const key of TRUSTED_AUTHOR_ENV_KEYS) {
    for (const raw of splitList(env[key])) {
      const normalized = normalizeBotLogin(raw);
      if (normalized) authors.add(normalized);
    }
  }

  for (const key of APP_BOT_LOGIN_ENV_KEYS) {
    const normalized = normalizeBotLogin(env[key]);
    if (normalized) authors.add(normalized);
  }

  for (const key of APP_SLUG_ENV_KEYS) {
    const normalized = normalizeAppSlugBotLogin(env[key]);
    if (normalized) authors.add(normalized);
  }

  return Array.from(authors);
}

function shouldTrustGitHubActionsBot(env: NodeJS.ProcessEnv): boolean {
  if (env.REVIEWROUTER_COMMENT_TOKEN_MODE !== 'app-oidc') {
    return true;
  }
  return env.REVIEW_ROUTER_COMMENT_TOKEN_STATUS === 'fallback';
}

function targetIdFor(
  threadId: string,
  parentCommentId: string,
  fingerprint: string
): string {
  return `rrt_${createHash('sha256')
    .update(`${threadId}\n${parentCommentId}\n${fingerprint}`)
    .digest('hex')
    .slice(0, 16)}`;
}

function findTrustedResolutionMarker(input: {
  comments: readonly GraphQLComment[];
  targetId: string;
  fingerprint: string;
  expectedAuthorLogin?: string | null;
  isTrustedAuthor(login?: string | null): boolean;
}): LifecycleTarget['trustedResolutionMarker'] | undefined {
  const expectedAuthor = canonicalBotLogin(input.expectedAuthorLogin);
  if (!expectedAuthor || expectedAuthor === GITHUB_ACTIONS_BOT_AUTHOR) {
    return undefined;
  }
  for (const comment of input.comments.slice(1)) {
    const markerAuthor = canonicalBotLogin(comment.author?.login);
    if (
      markerAuthor !== expectedAuthor ||
      !input.isTrustedAuthor(comment.author?.login)
    ) {
      continue;
    }
    const marker = parseResolutionMarker(comment.body ?? '');
    if (
      marker?.targetId !== input.targetId ||
      marker.fingerprint !== input.fingerprint
    ) {
      continue;
    }
    return {
      schemaVersion: 'reviewrouter-lifecycle-resolution.v1',
      targetId: marker.targetId,
      fingerprint: marker.fingerprint,
      commentId: comment.id,
      commentUpdatedAt: normalizeCommentTimestamp(
        comment.updatedAt ?? requireCommentTimestamp(comment.createdAt)
      ),
    };
  }
  return undefined;
}

function parseResolutionMarker(
  body: string
): { targetId: string; fingerprint: string } | undefined {
  const match = new RegExp(
    `<!--\\s*${RESOLUTION_REPLY_MARKER}\\s+target_id=([A-Za-z0-9._:-]{1,160})\\s+fingerprint=([A-Za-z0-9_]{1,80})\\s*-->`,
    'i'
  ).exec(body);
  if (!match?.[1] || !match[2]) return undefined;
  const fingerprint = match[2].toLowerCase();
  if (!isReviewLifecycleMarkerFingerprint(fingerprint)) return undefined;
  return { targetId: match[1], fingerprint };
}

function normalizeLifecycleSeverity(
  value: string | null
): LifecycleTarget['severity'] {
  if (value === 'critical' || value === 'major' || value === 'minor') {
    return value;
  }
  return 'unknown';
}

function requireCommentTimestamp(value?: string | null): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('review thread comment timestamp was missing');
  }
  return value;
}

function normalizeCommentTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('review thread comment timestamp was invalid');
  }
  return parsed.toISOString();
}

function stripLifecycleCommentBody(body: string): string {
  return stripInlineFingerprintMarkers(body)
    .replace(/<sub><!--\s*review-router-skip-help\s*-->[\s\S]*?<\/sub>/gi, '')
    .replace(/<sub>\s*Models?:[\s\S]*?<\/sub>/gi, '')
    .replace(/\*\*Provider:\*\*[\s\S]*?(?:\n\n|$)/gi, '')
    .trim();
}

function splitList(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeAppSlugBotLogin(value?: string | null): string | undefined {
  const slug = (value ?? '').trim();
  if (!slug) return undefined;
  return normalizeBotLogin(slug.endsWith('[bot]') ? slug : `${slug}[bot]`);
}

function normalizeBotLogin(value?: string | null): string | undefined {
  const login = (value ?? '').trim().toLowerCase();
  if (!login) return undefined;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?(?:\[bot\])?$/.test(login)) {
    return undefined;
  }
  return login;
}

function canonicalBotLogin(value?: string | null): string | undefined {
  const login = normalizeBotLogin(value);
  return login?.endsWith('[bot]') ? login.slice(0, -5) : login;
}
