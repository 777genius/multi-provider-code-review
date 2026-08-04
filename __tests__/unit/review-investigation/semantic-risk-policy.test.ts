import {
  changedPathSemanticRiskPriority,
  REVIEW_INVESTIGATION_INDEPENDENT_CRITIC_RISK_PRIORITY_V1,
  REVIEW_INVESTIGATION_RISK_PRIORITY,
} from '../../../src/review-investigation/domain/semantic-risk-policy';

describe('review investigation semantic risk policy v1', () => {
  it.each([
    'src/auth/session.ts',
    'src/billing/InvoiceService.ts',
    'prisma/migrations/20260803_add_index/migration.sql',
    'src/queues/realtime-events.ts',
    'src/cache/redis-lock.ts',
    'src/api/public-route.ts',
    '.github/workflows/review.yml',
    'scripts/destructive-data-loss.ts',
  ])(
    'classifies explicit high-risk path %s above the critic threshold',
    (path) => {
      expect(changedPathSemanticRiskPriority(path)).toBe(
        REVIEW_INVESTIGATION_RISK_PRIORITY.HighRiskChangedPath
      );
      expect(changedPathSemanticRiskPriority(path)).toBeGreaterThanOrEqual(
        REVIEW_INVESTIGATION_INDEPENDENT_CRITIC_RISK_PRIORITY_V1
      );
    }
  );

  it.each([
    'src/components/Button.tsx',
    'src/domain/author-profile.ts',
    'docs/review-guide.md',
    'src/utils/format-date.ts',
  ])('keeps standard changed path %s below the critic threshold', (path) => {
    expect(changedPathSemanticRiskPriority(path)).toBe(
      REVIEW_INVESTIGATION_RISK_PRIORITY.StandardChangedPath
    );
    expect(changedPathSemanticRiskPriority(path)).toBeLessThan(
      REVIEW_INVESTIGATION_INDEPENDENT_CRITIC_RISK_PRIORITY_V1
    );
  });
});
