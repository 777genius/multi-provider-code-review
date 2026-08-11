import type { ReviewObservationPayload } from './review-orchestration-ports';

export enum ReviewContextInspectionFailureReason {
  MissingChangedPathsWitness = 'missing_changed_paths_witness',
  MissingProviderInspection = 'missing_provider_inspection',
  InvalidChangedPathsWitness = 'invalid_changed_paths_witness',
  IncompleteTranscript = 'incomplete_transcript',
  GatewayOutputUnavailable = 'gateway_output_unavailable',
}

export enum ReviewContextInspectionFailureStage {
  TranscriptResume = 'transcript_resume',
  TranscriptValidation = 'transcript_validation',
  ReplayRead = 'replay_read',
  ReplayDecrypt = 'replay_decrypt',
  ControlPlaneSeal = 'control_plane_seal',
}

export class ReviewContextInspectionFailure extends Error {
  constructor(
    readonly reason: ReviewContextInspectionFailureReason,
    readonly stage?: ReviewContextInspectionFailureStage
  ) {
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
