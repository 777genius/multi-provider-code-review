import {
  isPathInReviewShard,
  readReviewPathShard,
  reviewPathShardIndex,
} from '../../../src/review-execution/domain';

describe('review path sharding', () => {
  it('is disabled when both inputs are absent', () => {
    expect(readReviewPathShard({})).toBeNull();
  });

  it('parses a valid zero-based shard', () => {
    expect(
      readReviewPathShard({
        REVIEWROUTER_PATH_SHARD_INDEX: ' 2 ',
        REVIEWROUTER_PATH_SHARD_COUNT: '8',
      })
    ).toEqual({ index: 2, count: 8 });
  });

  it.each([
    [{ REVIEWROUTER_PATH_SHARD_INDEX: '0' }, 'configuration_incomplete'],
    [{ REVIEWROUTER_PATH_SHARD_COUNT: '8' }, 'configuration_incomplete'],
    [
      {
        REVIEWROUTER_PATH_SHARD_INDEX: '0',
        REVIEWROUTER_PATH_SHARD_COUNT: '0',
      },
      'count_invalid',
    ],
    [
      {
        REVIEWROUTER_PATH_SHARD_INDEX: '8',
        REVIEWROUTER_PATH_SHARD_COUNT: '8',
      },
      'index_invalid',
    ],
  ])('rejects invalid config %p', (env, errorSuffix) => {
    expect(() => readReviewPathShard(env)).toThrow(
      `review_path_shard_${errorSuffix}`
    );
  });

  it('assigns every path to exactly one deterministic shard', () => {
    const paths = Array.from(
      { length: 1_000 },
      (_, index) => `src/feature-${index}/index.ts`
    );
    const assignments = paths.map((path) => reviewPathShardIndex(path, 12));

    expect(assignments).toEqual(
      paths.map((path) => reviewPathShardIndex(path, 12))
    );
    for (const [pathIndex, path] of paths.entries()) {
      expect(
        Array.from({ length: 12 }, (_, index) =>
          isPathInReviewShard(path, { index, count: 12 })
        ).filter(Boolean)
      ).toHaveLength(1);
      expect(assignments[pathIndex]).toBeGreaterThanOrEqual(0);
      expect(assignments[pathIndex]).toBeLessThan(12);
    }
  });
});
