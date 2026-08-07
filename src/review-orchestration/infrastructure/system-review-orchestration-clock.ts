import type { ReviewOrchestrationClockPort } from '../application';

export class SystemReviewOrchestrationClock implements ReviewOrchestrationClockPort {
  monotonicNowMs(): number {
    return Math.floor(performance.now());
  }
}
