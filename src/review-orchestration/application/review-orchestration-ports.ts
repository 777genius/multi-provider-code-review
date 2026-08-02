export enum ReviewEvidenceLookupKind {
  Miss = 'miss',
  Hit = 'hit',
  ReplayRequired = 'replay_required',
}

export enum ReviewExecutionProviderKind {
  Codex = 'codex',
  ClaudeCode = 'claude_code',
  OpenRouter = 'openrouter',
}

export enum ReviewTaskKind {
  FindingDiscovery = 'finding_discovery',
  LifecycleRevalidation = 'lifecycle_revalidation',
}

export enum ReviewInvocationFailureClass {
  Retryable = 'retryable',
  CapacityUnavailable = 'capacity_unavailable',
  AuthenticationUnavailable = 'authentication_unavailable',
}

export enum ReviewPublicationState {
  Pending = 'pending',
  Publishing = 'publishing',
  Reconciling = 'reconciling',
  Succeeded = 'succeeded',
  NotApplied = 'not_applied',
  StaleCompensated = 'stale_compensated',
  StaleVisible = 'stale_visible',
  TerminalUnknown = 'terminal_unknown',
}

export enum RestoredReviewExecutionState {
  Planned = 'planned',
  Running = 'running',
  Superseded = 'superseded',
  Completed = 'completed',
  Partial = 'partial',
  Failed = 'failed',
}

export enum RestoredReviewWorkSlotState {
  Pending = 'pending',
  Leased = 'leased',
  Satisfied = 'satisfied',
  Exhausted = 'exhausted',
  Cancelled = 'cancelled',
}

export type ReviewProtocolLimits = {
  readonly maxWorkSlots: number;
  readonly maxAttemptsPerSlot: number;
  readonly maxObservationBytes: number;
  readonly maxObservationFindings: number;
  readonly maxProjectionBytes: number;
  readonly maxProjectionFindings: number;
  readonly maxPublicationOperations: number;
  readonly maxPublicationChunks: number;
  readonly maxPublicationBodyBytes: number;
  readonly maxRequestBatchSize: number;
  readonly maxLeaseDurationMs: number;
  readonly maxResultReportDurationMs: number;
  readonly maxReconciliationDurationMs: number;
};

export type ReviewRunAuthorization = {
  readonly authorizationId: string;
  readonly authorizationToken: string;
  readonly producerReleaseId: string;
  readonly protocolLimitsProfileId: string;
  readonly operationalSloProfileId: string;
  readonly mutationEpoch: string;
  readonly expiresAt: string;
  readonly limits: ReviewProtocolLimits;
  readonly facts: ReviewRunAuthorizationFacts;
};

export type ReviewRunAuthorizationFacts = {
  readonly workspaceId: string;
  readonly repositoryConnectionId: string;
  readonly scmRepositoryIdentityId: string;
  readonly pullRequestNumber: number;
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly headSha: string;
  readonly reviewRevisionHash: string;
  readonly trustDomain: string;
  readonly producerReleaseId: string;
  readonly selectedProtocolVersion: string;
  readonly schemaDigest: string;
  readonly providerVoteLanes: readonly {
    readonly providerKind: ReviewExecutionProviderKind;
    readonly providerVoteIdentityHash: string;
  }[];
};

export type ReviewWorkSlotPlan = {
  readonly workSlotId: string;
  readonly taskKind: ReviewTaskKind;
  readonly providerKind: ReviewExecutionProviderKind;
  readonly providerVoteIdentityHash: string;
  readonly shardKey: string;
  readonly required: boolean;
  readonly attemptBudget: number;
  readonly retryPolicyVersion: string;
};

export type PreparedReviewInvocation = {
  readonly workSlotId: string;
  readonly attemptOrdinal: number;
  readonly provider: string;
  readonly requestedModel: string;
  /** In-memory semantic prompt before provider-specific wrapping. Never persist or log. */
  readonly reviewPrompt: string;
  readonly immutableRequest: unknown;
  readonly manifestFacts: PreparedReviewInvocationManifestFacts;
  readonly coverageManifest: import('../domain').ReviewPromptCoverageManifest;
};

export interface ReviewInvocationFailureClassifierPort {
  classify(error: unknown): ReviewInvocationFailureClass;
}

export interface ReviewInvocationDiagnosticsPort {
  recordFailure(input: {
    readonly invocation: PreparedReviewInvocation;
    readonly attemptBudget: number;
    readonly failureClass: ReviewInvocationFailureClass;
    readonly error: unknown;
  }): void;
}

export type PreparedReviewInvocationManifestFacts = {
  readonly taskKindSet: readonly ReviewTaskKind[];
  readonly providerKind: ReviewExecutionProviderKind;
  readonly providerCapabilityHash: string;
  readonly providerRequestEnvelopeHash: string;
  readonly outputSchemaHash: string;
  readonly filePatchManifestHash: string;
  readonly contextManifestHash: string;
  readonly lifecycleTargetSetHash: string | null;
  readonly liveLifecycleStateHash: string | null;
  readonly toolPolicyHash: string;
  readonly executionProfile:
    | 'prompt_only_envelope_v1'
    | 'agentic_unbounded_v1'
    | 'context_gateway_v1'
    | 'investigation_gateway_v1';
  readonly baseTreeHash: string | null;
  readonly environmentContractHash: string;
};

export type ProviderInvocationManifest = {
  readonly manifestCanonicalJson: string;
  readonly manifestKey: string;
  readonly providerInvocationKey: string;
  readonly providerVoteIdentityHash: string;
};

export type ReviewObservationPayload = {
  readonly payloadCanonicalJson: string;
  readonly payloadHash: string;
  readonly byteCount: number;
  readonly findingCount: number;
  readonly actualModel: string;
  readonly qualityFlags: readonly string[];
  readonly transportAttemptCount: number;
  readonly schemaValidated: boolean;
  readonly fullyConsumed: boolean;
  readonly contextDependencyAttestationId?: string;
  readonly contextDependencyAttestationHash?: string;
  readonly investigationCertificateId?: string;
  readonly investigationCertificateHash?: string;
};

export type ContextGatewaySessionLease = Readonly<{
  sessionId: string;
  eventChainSeedHash: string;
  sealCapability: string;
  gatewaySessionSecret: string;
  expiresAt: string;
}>;

export type ContextDependencyAttestationReference = Readonly<{
  attestationId: string;
  attestationHash: string;
}>;

export type ContextDependencyReplayCandidate = Readonly<{
  observation: AcceptedReviewObservation;
  attestationId: string;
  attestationHash: string;
  replayCapability: string;
  replayPlanCanonicalJson: string;
  replayPlanHash: string;
}>;

export type ContextDependencyReplayResult = Readonly<{
  targetCheckoutTreeOid: string;
  replayResultCanonicalJson: string;
  replayResultHash: string;
}>;

export interface ContextDependencyReplayPort {
  replay(input: {
    readonly candidate: ContextDependencyReplayCandidate;
    readonly targetRevision: ReviewRevisionFacts;
  }): Promise<ContextDependencyReplayResult | null>;
}

export interface ReviewContextAttestationPort {
  openGatewaySession(input: {
    readonly invocationLease: ReviewInvocationLease;
    readonly sourceExecutionId: string;
    readonly sourceWorkSlotId: string;
    readonly sourceReviewRevisionHash: string;
    readonly checkoutTreeOid: string;
    readonly gatewayPolicyVersion: string;
    readonly gatewayBinaryHash: string;
    readonly confinementEvidenceHash: string;
  }): Promise<ContextGatewaySessionLease>;
  sealGatewaySession(input: {
    readonly invocationLease: ReviewInvocationLease;
    readonly session: ContextGatewaySessionLease;
    readonly providerSucceeded: boolean;
    readonly schemaValidated: boolean;
    readonly fullyConsumed: boolean;
    readonly actualModel: string;
    readonly terminalOutcomeHash: string;
    readonly transcriptCanonicalJson: string;
    readonly transcriptHash: string;
    readonly replayMaterialCanonicalJson: string;
    readonly replayMaterialHash: string;
  }): Promise<ContextDependencyAttestationReference | null>;
  commitContextReplay(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly execution: ReviewExecutionAdmission;
    readonly workSlot: ReviewWorkSlotPlan;
    readonly candidate: ContextDependencyReplayCandidate;
    readonly result: ContextDependencyReplayResult;
  }): Promise<{ readonly attachmentCapability: string } | null>;
}

export type AcceptedReviewObservation = ReviewObservationPayload & {
  readonly observationId: string;
  readonly eligibilityPolicyVersion: string;
  readonly providerKind: ReviewExecutionProviderKind;
  readonly providerInvocationKey: string;
  readonly providerVoteIdentityHash: string;
};

export type AcceptedReviewWorkSlotEvidence = Readonly<{
  workSlotId: string;
  observation: AcceptedReviewObservation;
  coverageManifest: import('../domain').ReviewPromptCoverageManifest;
}>;

export type ReviewExecutionAdmission = {
  readonly executionId: string;
  readonly generation: string;
  readonly streamVersion: string;
  readonly executionVersion: string;
  readonly restoredExecution: RestoredReviewExecution;
};

export type RestoredReviewWorkSlot = Readonly<{
  workSlotId: string;
  state: RestoredReviewWorkSlotState;
  required: boolean;
  providerVoteIdentityHash: string;
  activeLeaseId: string | null;
  acceptedObservationRefId: string | null;
}>;

export type RestoredReviewExecution = Readonly<{
  executionId: string;
  version: string;
  streamVersion: string;
  generation: string;
  state: RestoredReviewExecutionState;
  authorizationId: string;
  reviewRevisionHash: string;
  planHash: string;
  workSlots: readonly RestoredReviewWorkSlot[];
}>;

export type ReviewInvocationLease = {
  readonly leaseId: string;
  readonly attemptId: string;
  readonly leaseCapability: string;
  readonly fencingToken: string;
  readonly expiresAt: string;
  readonly resultReportUntil: string;
  readonly renewalCeilingReached: boolean;
};

export type CurrentReviewProjection = {
  readonly artifactId: string;
  readonly artifactHash: string;
  readonly projectionEnvelopeVersion: number;
  readonly projectionEnvelopeCanonicalJson: string;
  readonly projectionHash: string;
  readonly lifecycleStateHash: string;
  readonly commandLedgerWatermark: string;
  readonly operationsCanonicalJson: string;
  readonly findingCount: number;
  readonly publicationOperationCount: number;
  readonly publicationChunkCount: number;
  readonly coverageComplete: boolean;
};

export type ReviewPublicationOutcome = {
  readonly state: ReviewPublicationState;
  readonly canonicalReceiptSetHash?: string;
};

export enum ReviewInvocationLeaseAcquireOutcomeStatus {
  Acquired = 'acquired',
  Busy = 'busy',
  AttemptBudgetExhausted = 'attempt_budget_exhausted',
  NotRunnable = 'not_runnable',
}

export enum ReviewPublicationRequestOutcomeStatus {
  Requested = 'requested',
  Conflict = 'conflict',
  Stale = 'stale',
}

export type ReviewInvocationLeaseAcquireOutcome =
  | {
      readonly status: ReviewInvocationLeaseAcquireOutcomeStatus.Acquired;
      readonly lease: ReviewInvocationLease;
    }
  | {
      readonly status:
        | ReviewInvocationLeaseAcquireOutcomeStatus.Busy
        | ReviewInvocationLeaseAcquireOutcomeStatus.AttemptBudgetExhausted
        | ReviewInvocationLeaseAcquireOutcomeStatus.NotRunnable;
    };

export interface ReviewActionV2ControlPlanePort {
  authorize(input: {
    readonly oidcToken: string;
  }): Promise<ReviewRunAuthorization>;
  restoreSnapshot(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly reviewRevisionHash: string;
  }): Promise<void>;
  restoreExecution(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly reviewRevisionHash: string;
  }): Promise<RestoredReviewExecution | null>;
  startExecution(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly idempotencyKey: string;
    readonly executionId: string;
    readonly reviewRevisionHash: string;
    readonly compatibilityKey: string;
    readonly planHash: string;
    readonly workSlotsCanonicalJson: string;
    readonly workSlots: readonly ReviewWorkSlotPlan[];
    readonly sourceRunId: string;
    readonly sourceRunAttempt: string;
  }): Promise<ReviewExecutionAdmission>;
  supersedeExecution(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly idempotencyKey: string;
    readonly execution: ReviewExecutionAdmission;
    readonly targetRevisionHash: string;
  }): Promise<void>;
  lookupEvidence(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly execution: ReviewExecutionAdmission;
    readonly workSlot: ReviewWorkSlotPlan;
    readonly planHash: string;
    readonly manifest: ProviderInvocationManifest;
  }): Promise<
    | { readonly kind: ReviewEvidenceLookupKind.Miss }
    | ({
        readonly kind: ReviewEvidenceLookupKind.ReplayRequired;
      } & ContextDependencyReplayCandidate)
    | {
        readonly kind: ReviewEvidenceLookupKind.Hit;
        readonly observation: AcceptedReviewObservation;
        readonly attachment:
          | {
              readonly kind: 'same_execution';
              readonly sourceLeaseId: string;
              readonly sourceFencingToken: string;
              readonly sourceOwnerIdHash: string;
            }
          | {
              readonly kind: 'exact_revision_reuse';
              readonly capability: string;
              readonly reuseSafetyDecisionHash: string;
            };
      }
  >;
  acquireInvocationLease(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly idempotencyKey: string;
    readonly execution: ReviewExecutionAdmission;
    readonly workSlot: ReviewWorkSlotPlan;
    readonly manifest: ProviderInvocationManifest;
    readonly acquireRequestId: string;
    readonly ownerIdHash: string;
  }): Promise<ReviewInvocationLeaseAcquireOutcome>;
  renewInvocationLease(input: {
    readonly idempotencyKey: string;
    readonly lease: ReviewInvocationLease;
    readonly ownerIdHash: string;
    readonly renewRequestId: string;
  }): Promise<ReviewInvocationLease>;
  releaseInvocationLease(input: {
    readonly idempotencyKey: string;
    readonly lease: ReviewInvocationLease;
    readonly ownerIdHash: string;
    readonly releaseRequestId: string;
  }): Promise<void>;
  commitEvidence(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly idempotencyKey: string;
    readonly lease: ReviewInvocationLease;
    readonly ownerIdHash: string;
    readonly observation: ReviewObservationPayload;
  }): Promise<{
    readonly observationId: string;
    readonly historicalOnly: boolean;
    readonly eligibilityPolicyVersion: string;
  }>;
  attachObservation(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly idempotencyKey: string;
    readonly execution: ReviewExecutionAdmission;
    readonly workSlot: ReviewWorkSlotPlan;
    readonly observation: AcceptedReviewObservation;
    readonly attachmentCapability: string;
  }): Promise<{ readonly streamVersion: string }>;
  adoptObservation(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly idempotencyKey: string;
    readonly execution: ReviewExecutionAdmission;
    readonly workSlot: ReviewWorkSlotPlan;
    readonly planHash: string;
    readonly manifest: ProviderInvocationManifest;
    readonly observation: AcceptedReviewObservation;
    readonly source: {
      readonly sourceLeaseId: string;
      readonly sourceFencingToken: string;
      readonly sourceOwnerIdHash: string;
    };
  }): Promise<{ readonly streamVersion: string }>;
  finalizeExecution(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly idempotencyKey: string;
    readonly execution: ReviewExecutionAdmission;
    readonly projection: CurrentReviewProjection;
    readonly allowPartial: boolean;
  }): Promise<{ readonly publicationPermit: string }>;
  requestPublication(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly idempotencyKey: string;
    readonly publicationPermit: string;
    readonly projection: CurrentReviewProjection;
  }): Promise<
    | {
        readonly status: ReviewPublicationRequestOutcomeStatus.Requested;
        readonly publicationAttemptId: string;
        readonly pollAfterMs: number;
      }
    | {
        readonly status: ReviewPublicationRequestOutcomeStatus.Conflict;
      }
    | {
        readonly status: ReviewPublicationRequestOutcomeStatus.Stale;
        readonly reason: string;
      }
  >;
  readPublicationStatus(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly publicationAttemptId: string;
  }): Promise<
    | { readonly terminal: false; readonly pollAfterMs: number }
    | { readonly terminal: true; readonly outcome: ReviewPublicationOutcome }
  >;
}

export type ReviewRevisionFacts = {
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly headSha: string;
  readonly reviewRevisionHash: string;
};

export interface ReviewRevisionGuardPort {
  loadCurrentRevision(): Promise<ReviewRevisionFacts>;
}

export interface ReviewOidcTokenPort {
  getToken(): Promise<string>;
}

export interface ProviderInvocationManifestAssemblerPort {
  assemble(
    invocation: PreparedReviewInvocation
  ): Promise<ProviderInvocationManifest>;
}

export interface PreparedReviewInvocationPort {
  prepare(input: {
    readonly workSlot: ReviewWorkSlotPlan;
    readonly attemptOrdinal: number;
  }): Promise<PreparedReviewInvocation>;
  execute(input: {
    readonly invocation: PreparedReviewInvocation;
    readonly manifest: ProviderInvocationManifest;
    readonly lease: ReviewInvocationLease;
    readonly sourceExecutionId: string;
    readonly sourceReviewRevisionHash: string;
    readonly signal: AbortSignal;
  }): Promise<ReviewObservationPayload>;
}

export enum ReviewInvestigationRecordingMode {
  RecordOnly = 'record_only',
  Authoritative = 'authoritative',
}

export interface ReviewInvestigationRecordingPort {
  readonly mode: ReviewInvestigationRecordingMode;
  supports(input: {
    readonly workSlot: ReviewWorkSlotPlan;
    readonly invocation: PreparedReviewInvocation;
  }): boolean;
  execute(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly execution: ReviewExecutionAdmission;
    readonly workSlot: ReviewWorkSlotPlan;
    readonly invocation: PreparedReviewInvocation;
    readonly manifest: ProviderInvocationManifest;
    readonly currentLease: () => ReviewInvocationLease;
    readonly ownerIdHash: string;
    readonly sourceReviewRevisionHash: string;
    readonly signal: AbortSignal;
  }): Promise<ReviewObservationPayload>;
}

export interface ReviewInvocationLeaseSupervisorPort {
  run<T>(input: {
    readonly lease: ReviewInvocationLease;
    readonly renew: () => Promise<ReviewInvocationLease>;
    readonly operation: (
      signal: AbortSignal,
      currentLease: () => ReviewInvocationLease
    ) => Promise<T>;
  }): Promise<T>;
}

export interface CurrentReviewProjectionBuilderPort {
  build(input: {
    readonly acceptedEvidence: readonly AcceptedReviewWorkSlotEvidence[];
    readonly exhaustedWorkSlotIds: readonly string[];
    readonly reviewRevisionHash: string;
  }): Promise<CurrentReviewProjection>;
}

export interface ReviewOrchestrationIdentityPort {
  deterministicId(namespace: string, parts: readonly string[]): string;
}

export interface ReviewOrchestrationDelayPort {
  sleep(delayMs: number): Promise<void>;
}
