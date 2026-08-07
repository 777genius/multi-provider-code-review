import { logger } from '../../utils/logger';

export function emitReviewInvestigationTelemetry(message: string): void {
  try {
    logger.info(message);
  } catch {
    // Diagnostics must never change review execution semantics.
  }
}
