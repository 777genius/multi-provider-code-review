import { ReviewInvocationFailureClass } from '../../../src/review-orchestration/application';
import {
  classifySafeInvocationFailureReason,
  LoggingReviewInvocationDiagnostics,
} from '../../../src/review-orchestration/infrastructure/review-invocation-diagnostics';

describe('review invocation diagnostics', () => {
  it.each([
    [
      new Error('The model gpt-future does not exist'),
      ReviewInvocationFailureClass.Retryable,
      'model_unavailable',
    ],
    [
      new Error('review_action_v2_prepared_invocation_identity_mismatch'),
      ReviewInvocationFailureClass.Retryable,
      'prepared_invocation_invalid',
    ],
    [
      new Error('request timed out'),
      ReviewInvocationFailureClass.Retryable,
      'provider_timeout',
    ],
    [
      new Error('structured output schema validation failed'),
      ReviewInvocationFailureClass.Retryable,
      'provider_output_invalid',
    ],
    [
      new Error('sensitive provider detail'),
      ReviewInvocationFailureClass.CapacityUnavailable,
      'capacity_unavailable',
    ],
  ])('classifies a safe failure reason', (error, failureClass, expected) => {
    expect(classifySafeInvocationFailureReason(error, failureClass)).toBe(
      expected
    );
  });

  it('logs only bounded diagnostics and never the raw provider error', () => {
    const warn = jest.fn();
    const diagnostics = new LoggingReviewInvocationDiagnostics({ warn });

    diagnostics.recordFailure({
      invocation: {
        workSlotId: 'slot-1',
        attemptOrdinal: 2,
        provider: 'codex/gpt-5.6-sol',
        requestedModel: 'gpt-5.6-sol',
      } as never,
      attemptBudget: 3,
      failureClass: ReviewInvocationFailureClass.Retryable,
      error: new Error('secret-bearing raw detail'),
    });

    expect(warn).toHaveBeenCalledWith('Review provider attempt failed', {
      attempt: 2,
      attemptBudget: 3,
      failureClass: ReviewInvocationFailureClass.Retryable,
      model: 'gpt-5.6-sol',
      provider: 'codex/gpt-5.6-sol',
      safeReason: 'provider_invocation_failed',
      workSlotId: 'slot-1',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-bearing');
  });
});
