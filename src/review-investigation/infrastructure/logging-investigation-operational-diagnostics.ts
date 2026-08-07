import type { LogMetadata } from '../../utils/logger';
import type {
  ReviewInvestigationOperationalDiagnostic,
  ReviewInvestigationOperationalDiagnosticPort,
} from '../application/investigation-operational-diagnostic-port';

type DiagnosticLogger = Readonly<{
  warn(message: string, metadata?: LogMetadata): void;
}>;

export class LoggingInvestigationOperationalDiagnostics implements ReviewInvestigationOperationalDiagnosticPort {
  constructor(private readonly logger: DiagnosticLogger) {}

  async record(
    diagnostic: ReviewInvestigationOperationalDiagnostic
  ): Promise<void> {
    this.logger.warn('Review investigation operation failed', {
      code: diagnostic.code,
      detailCode: diagnostic.detailCode,
      failureClass: diagnostic.failureClass,
      investigationId: diagnostic.investigationId,
      phase: diagnostic.phase,
      retryAfterMs: diagnostic.retryAfterMs,
      turnId: diagnostic.turnId,
    });
  }
}
