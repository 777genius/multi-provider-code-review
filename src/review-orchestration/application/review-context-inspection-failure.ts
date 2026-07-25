import type { ReviewObservationPayload } from './review-orchestration-ports';

export enum ReviewContextInspectionFailureReason {
  MissingChangedPathsWitness = 'missing_changed_paths_witness',
  InvalidChangedPathsWitness = 'invalid_changed_paths_witness',
  IncompleteTranscript = 'incomplete_transcript',
  GatewayOutputUnavailable = 'gateway_output_unavailable',
}

export class ReviewContextInspectionFailure extends Error {
  constructor(readonly reason: ReviewContextInspectionFailureReason) {
    super(`review_context_inspection_failed:${reason}`);
    this.name = 'ReviewContextInspectionFailure';
  }
}

export class RetryableReviewContextInspectionFailure extends ReviewContextInspectionFailure {
  constructor(
    reason: ReviewContextInspectionFailureReason,
    readonly currentRevisionObservation: ReviewObservationPayload
  ) {
    super(reason);
    this.name = 'RetryableReviewContextInspectionFailure';
  }
}
