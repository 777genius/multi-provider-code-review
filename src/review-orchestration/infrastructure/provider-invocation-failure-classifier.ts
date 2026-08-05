import { normalizeReviewError } from '../../errors/review-router-error';
import {
  CapacitySignal,
  classifyProviderCapacitySignal,
} from '../../review-execution/domain';
import {
  ReviewInvocationConfigurationMismatchError,
  ReviewInvocationFailureClass,
  type ReviewInvocationFailureClassifierPort,
} from '../application';

export class ProviderInvocationFailureClassifier implements ReviewInvocationFailureClassifierPort {
  classify(error: unknown): ReviewInvocationFailureClass {
    if (
      classifyProviderCapacitySignal({ error }) ===
      CapacitySignal.CapacityPressure
    ) {
      return ReviewInvocationFailureClass.CapacityUnavailable;
    }

    const normalized = normalizeReviewError(error);
    if (normalized.category === 'provider_auth') {
      return ReviewInvocationFailureClass.AuthenticationUnavailable;
    }

    if (error instanceof ReviewInvocationConfigurationMismatchError) {
      return ReviewInvocationFailureClass.ConfigurationMismatch;
    }

    return ReviewInvocationFailureClass.Retryable;
  }
}
