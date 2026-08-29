import { createHash } from 'crypto';

const MAX_REVIEW_PATH_SHARDS = 64;

export interface ReviewPathShard {
  readonly index: number;
  readonly count: number;
}

export function readReviewPathShard(
  env: NodeJS.ProcessEnv = process.env
): ReviewPathShard | null {
  const rawIndex = env.REVIEWROUTER_PATH_SHARD_INDEX?.trim() ?? '';
  const rawCount = env.REVIEWROUTER_PATH_SHARD_COUNT?.trim() ?? '';

  if (rawIndex === '' && rawCount === '') return null;
  if (rawIndex === '' || rawCount === '') {
    throw new Error('review_path_shard_configuration_incomplete');
  }

  const index = Number(rawIndex);
  const count = Number(rawCount);
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > MAX_REVIEW_PATH_SHARDS
  ) {
    throw new Error('review_path_shard_count_invalid');
  }
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) {
    throw new Error('review_path_shard_index_invalid');
  }

  return Object.freeze({ index, count });
}

export function reviewPathShardIndex(path: string, shardCount: number): number {
  if (
    !Number.isSafeInteger(shardCount) ||
    shardCount < 1 ||
    shardCount > MAX_REVIEW_PATH_SHARDS
  ) {
    throw new Error('review_path_shard_count_invalid');
  }
  const digest = createHash('sha256').update(path).digest();
  return digest.readUInt32BE(0) % shardCount;
}

export function isPathInReviewShard(
  path: string,
  shard: ReviewPathShard
): boolean {
  return reviewPathShardIndex(path, shard.count) === shard.index;
}
