export enum ReviewEvidenceCommitRejectionReason {
  AttemptNotFound = 'attempt_not_found',
  AttemptAuthorityMismatch = 'attempt_authority_mismatch',
  AttemptManifestMismatch = 'attempt_manifest_mismatch',
  AttemptNotReportable = 'attempt_not_reportable',
  ResultReportWindowExpired = 'result_report_window_expired',
  ResultNotReusableSuccess = 'result_not_reusable_success',
  EvidenceWritesDisabled = 'evidence_writes_disabled',
  ContextAttestationNotAccepted = 'context_attestation_not_accepted',
  InvestigationCertificatePathDisabled = 'investigation_certificate_path_disabled',
  InvestigationCertificateReferenceInvalid = 'investigation_certificate_reference_invalid',
  InvestigationCertificateNotAccepted = 'investigation_certificate_not_accepted',
  Unknown = 'unknown',
}

export class ReviewEvidenceCommitRejectedError extends Error {
  constructor(readonly reason: ReviewEvidenceCommitRejectionReason) {
    super(`review_evidence_commit_rejected:${reason}`);
    this.name = 'ReviewEvidenceCommitRejectedError';
  }
}
