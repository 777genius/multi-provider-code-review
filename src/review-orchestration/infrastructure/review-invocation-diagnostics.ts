import type { LogMetadata } from '../../utils/logger';
import {
  ReviewInvocationConfigurationMismatchError,
  ReviewInvocationFailureClass,
  type ReviewInvocationDiagnosticsPort,
} from '../application';

type DiagnosticsLogger = {
  warn(message: string, metadata?: LogMetadata): void;
};

export class LoggingReviewInvocationDiagnostics implements ReviewInvocationDiagnosticsPort {
  constructor(private readonly logger: DiagnosticsLogger) {}

  recordFailure(
    input: Parameters<ReviewInvocationDiagnosticsPort['recordFailure']>[0]
  ): void {
    this.logger.warn(
      input.failureClass === ReviewInvocationFailureClass.ConfigurationMismatch
        ? 'Review invocation configuration mismatch'
        : 'Review provider attempt failed',
      {
        attempt: input.invocation.attemptOrdinal,
        attemptBudget: input.attemptBudget,
        failureClass: input.failureClass,
        model: input.invocation.requestedModel,
        provider: input.invocation.provider,
        safeReason: classifySafeInvocationFailureReason(
          input.error,
          input.failureClass
        ),
        workSlotId: input.invocation.workSlotId,
      }
    );
  }
}

export function classifySafeInvocationFailureReason(
  error: unknown,
  failureClass: ReviewInvocationFailureClass
): string {
  if (failureClass === 'capacity_unavailable') return 'capacity_unavailable';
  if (failureClass === 'authentication_unavailable') {
    return 'authentication_unavailable';
  }

  const text = diagnosticText(error);
  if (error instanceof ReviewInvocationConfigurationMismatchError) {
    return error.reason;
  }
  if (failureClass === ReviewInvocationFailureClass.ConfigurationMismatch) {
    return 'configuration_mismatch';
  }
  if (
    /\b(?:unknown|unsupported|invalid|unavailable)\s+model\b|\bmodel\b.{0,80}\b(?:not found|not supported|does not exist|unavailable)\b/i.test(
      text
    )
  ) {
    return 'model_unavailable';
  }
  if (/prepared_invocation_(?:identity_mismatch|invalid|missing)/i.test(text)) {
    return 'prepared_invocation_invalid';
  }
  if (/\b(?:timed out|timeout)\b/i.test(text)) return 'provider_timeout';
  if (/\b(?:schema|structured output|valid review JSON)\b/i.test(text)) {
    return 'provider_output_invalid';
  }
  if (/\b(?:aborted|aborterror)\b/i.test(text)) return 'provider_aborted';
  return 'provider_invocation_failed';
}

function diagnosticText(error: unknown): string {
  if (error instanceof Error) return `${error.name} ${error.message}`;
  if (typeof error === 'string') return error;
  if (typeof error !== 'object' || error === null || Array.isArray(error)) {
    return '';
  }
  const record = error as Readonly<Record<string, unknown>>;
  return [record.name, record.code, record.message]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
}
