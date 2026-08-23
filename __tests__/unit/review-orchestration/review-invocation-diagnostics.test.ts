import {
  ReviewInvocationConfigurationMismatchError,
  ReviewInvocationConfigurationMismatchReason,
  ReviewInvocationFailureClass,
  ReviewInvestigationDiagnosticOutcome,
  ReviewExecutionProviderKind,
} from '../../../src/review-orchestration/application';
import {
  ReviewInvestigationDeferredSignal,
  ReviewInvestigationLegacyFallbackReason,
  ReviewInvestigationLegacyFallbackSignal,
} from '../../../src/review-investigation/application/run-investigation-work-slot';
import { ReviewInvestigationRunStatus } from '../../../src/review-investigation/domain/investigation-state';
import {
  classifySafeInvestigationFailureReason,
  classifySafeInvocationFailureReason,
  LoggingReviewInvestigationDiagnostics,
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
    [
      new ReviewInvocationConfigurationMismatchError(
        ReviewInvocationConfigurationMismatchReason.ContextGatewayPolicyMismatch
      ),
      ReviewInvocationFailureClass.ConfigurationMismatch,
      'context_gateway_policy_mismatch',
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

  it('labels configuration mismatches without exposing transport details', () => {
    const warn = jest.fn();
    const diagnostics = new LoggingReviewInvocationDiagnostics({ warn });

    diagnostics.recordFailure({
      invocation: {
        workSlotId: 'slot-1',
        attemptOrdinal: 1,
        provider: 'codex/gpt-5.6-sol',
        requestedModel: 'gpt-5.6-sol',
      } as never,
      attemptBudget: 3,
      failureClass: ReviewInvocationFailureClass.ConfigurationMismatch,
      error: new ReviewInvocationConfigurationMismatchError(
        ReviewInvocationConfigurationMismatchReason.ContextGatewayPolicyMismatch,
        { cause: new Error('secret transport detail') }
      ),
    });

    expect(warn).toHaveBeenCalledWith(
      'Review invocation configuration mismatch',
      expect.objectContaining({
        failureClass: ReviewInvocationFailureClass.ConfigurationMismatch,
        safeReason: 'context_gateway_policy_mismatch',
      })
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret transport');
  });

  it('logs bounded investigation degradation without the raw failure', () => {
    const warn = jest.fn();
    const diagnostics = new LoggingReviewInvestigationDiagnostics({ warn });

    diagnostics.record({
      outcome: ReviewInvestigationDiagnosticOutcome.LegacyFallback,
      workSlotId: 'slot-1',
      attemptOrdinal: 1,
      providerKind: ReviewExecutionProviderKind.Codex,
      error: new Error('secret investigation detail'),
    });

    expect(warn).toHaveBeenCalledWith('Review investigation degraded safely', {
      attempt: 1,
      outcome: ReviewInvestigationDiagnosticOutcome.LegacyFallback,
      provider: ReviewExecutionProviderKind.Codex,
      safeReason: 'investigation_failed',
      workSlotId: 'slot-1',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      'secret investigation'
    );
  });

  it('classifies authoritative deferral without exposing provider data', () => {
    expect(
      classifySafeInvestigationFailureReason(
        new ReviewInvestigationDeferredSignal(
          ReviewInvestigationRunStatus.Parked
        )
      )
    ).toBe('investigation_parked');
  });

  it('distinguishes capability fallback from record-only deferred work', () => {
    expect(
      classifySafeInvestigationFailureReason(
        new ReviewInvestigationLegacyFallbackSignal()
      )
    ).toBe('capability_disabled_before_open');
    expect(
      classifySafeInvestigationFailureReason(
        new ReviewInvestigationLegacyFallbackSignal(
          ReviewInvestigationLegacyFallbackReason.RecordOnlyDeferred,
          ReviewInvestigationRunStatus.RecoveryRequired
        )
      )
    ).toBe('investigation_recovery_required');
    expect(
      classifySafeInvestigationFailureReason(
        new ReviewInvestigationLegacyFallbackSignal(
          ReviewInvestigationLegacyFallbackReason.RecordOnlyBudgetExhausted
        )
      )
    ).toBe('investigation_budget_exhausted');
  });
});
