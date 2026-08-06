import { createHash } from 'crypto';

export enum ReviewLifecycleObservationVersion {
  V1 = 'review_lifecycle_observation.v1',
}

const REVIEW_LIFECYCLE_THREAD_STATE_VERSION =
  'review_lifecycle_thread_state.v1';
const REVIEW_LIFECYCLE_MARKER_FINGERPRINT = /^[a-f0-9]{24,64}$/;

export interface ReviewLifecycleThreadStateComment {
  readonly id: string;
  readonly authorLogin?: string | null;
  readonly body?: string | null;
  readonly createdAt: string;
  readonly updatedAt?: string | null;
}

export function isReviewLifecycleMarkerFingerprint(
  value: unknown
): value is string {
  return (
    typeof value === 'string' && REVIEW_LIFECYCLE_MARKER_FINGERPRINT.test(value)
  );
}

export function hashReviewLifecycleThreadState(input: {
  readonly threadId: string;
  readonly comments: readonly ReviewLifecycleThreadStateComment[];
}): string {
  requireIdentifier(input.threadId, 'thread_id');
  if (input.comments.length === 0) {
    throw new Error('review_lifecycle_thread_state_comments_missing');
  }

  const seenCommentIds = new Set<string>();
  const comments = [...input.comments]
    .sort((left, right) => compareCodeUnits(left.id, right.id))
    .map((comment) => {
      const commentId = requireIdentifier(comment.id, 'comment_id');
      if (seenCommentIds.has(commentId)) {
        throw new Error('review_lifecycle_thread_state_comment_id_duplicate');
      }
      seenCommentIds.add(commentId);
      return [
        commentId,
        normalizeAuthorLogin(comment.authorLogin),
        sha256(comment.body ?? ''),
        normalizeTimestamp(comment.createdAt),
        normalizeTimestamp(comment.updatedAt ?? comment.createdAt),
      ] as const;
    });
  const preimage = JSON.stringify([
    REVIEW_LIFECYCLE_THREAD_STATE_VERSION,
    input.threadId,
    comments,
  ]);
  return sha256(preimage);
}

function requireIdentifier(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`review_lifecycle_thread_state_${field}_invalid`);
  }
  return value;
}

function normalizeAuthorLogin(value?: string | null): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('review_lifecycle_thread_state_author_login_invalid');
  }
  return value.toLowerCase();
}

function normalizeTimestamp(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('review_lifecycle_thread_state_timestamp_invalid');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('review_lifecycle_thread_state_timestamp_invalid');
  }
  return parsed.toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
