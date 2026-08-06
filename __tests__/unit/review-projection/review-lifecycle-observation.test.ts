import { hashReviewLifecycleThreadState } from '../../../src/review-projection/domain/review-lifecycle-observation';
import golden from '../../../src/review-projection/fixtures/review-lifecycle-thread-state.v1.golden.json';

describe('hashReviewLifecycleThreadState', () => {
  it('matches the cross-repository review lifecycle wire golden vector', () => {
    expect(golden.schemaVersion).toBe('review_lifecycle_thread_state.v1');
    expect(golden.expectedThreadStateHash).toBe(
      '9bab955ad13af6be85a71a3ad9e3d43db8e485f6dcab798ce91e8111a0495245'
    );
    const threadStateHash = hashReviewLifecycleThreadState({
      threadId: golden.threadId,
      comments: golden.comments,
    });

    expect(threadStateHash).toBe(
      '9bab955ad13af6be85a71a3ad9e3d43db8e485f6dcab798ce91e8111a0495245'
    );
  });

  it.each(['2026-02-31T12:00:00Z', '2025-02-29T12:00:00Z'])(
    'rejects impossible calendar timestamp %s',
    (createdAt) => {
      expect(() =>
        hashReviewLifecycleThreadState({
          threadId: 'thread-1',
          comments: [{ id: 'comment-1', createdAt }],
        })
      ).toThrow('review_lifecycle_thread_state_timestamp_invalid');
    }
  );

  it('accepts a valid leap-day timestamp with an offset', () => {
    expect(() =>
      hashReviewLifecycleThreadState({
        threadId: 'thread-1',
        comments: [{ id: 'comment-1', createdAt: '2024-02-29T23:30:00+02:00' }],
      })
    ).not.toThrow();
  });
});
