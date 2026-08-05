import {
  ReviewExecutionProviderKind,
  ReviewInvocationConfigurationMismatchError,
  ReviewInvocationConfigurationMismatchReason,
  ReviewInvestigationRecordingMode,
  ReviewTaskKind,
  type PreparedReviewInvocation,
  type ReviewInvestigationRecordingPort,
  type ReviewRevisionGuardPort,
  type ReviewWorkSlotPlan,
} from '../application';
import {
  ReviewInvestigationGatewayConfigurationError,
  ReviewInvestigationGatewayConfigurationFailureReason,
} from '../../review-investigation/application/investigation-gateway-port';
import {
  ReviewInvestigationCurrency,
  type ReviewInvestigationCurrencyPort,
} from '../../review-investigation/application/investigation-control-plane-port';
import {
  ReviewInvestigationLegacyFallbackSignal,
  RunInvestigationWorkSlot,
} from '../../review-investigation/application/run-investigation-work-slot';
import {
  ReviewInvestigationConclusion,
  ReviewInvestigationNextAction,
  ReviewInvestigationRunStatus,
  type ReviewInvestigationSnapshot,
} from '../../review-investigation/domain/investigation-state';
import {
  ReviewAgentExecutionProfile,
  ReviewAgentProviderKind,
} from '../../review-investigation/domain/runtime-profile';
import { REVIEW_INVESTIGATION_CRITIC_POLICY_V1 } from '../../review-investigation/domain/semantic-risk-policy';
import {
  canonicalJson,
  sha256,
} from '../../review-investigation/domain/canonical-json';
import {
  REVIEW_INVESTIGATION_PROBE_LIMITS,
  REVIEW_INVESTIGATION_PROBE_POLICY_VERSION,
  REVIEW_INVESTIGATION_SEARCH_POLICY_VERSION,
  ReviewInvestigationProbePlanStatus,
} from '../../review-investigation/domain/deterministic-context-probe-plan';

export type ReviewInvestigationRunnerFactory = (
  input: Parameters<ReviewInvestigationRecordingPort['execute']>[0]
) => RunInvestigationWorkSlot;

export type ReviewInvestigationRecordingOptions = Readonly<{
  workingDirectory: string;
  leaseDurationMs: number;
  providerTimeoutMs: number;
  certificateTtlMs: number;
  minimumCapacityParkMs: number;
  maxObligationsForTurn: number;
  maxStateTransitions: number;
  policy: ReviewInvestigationPolicy;
}>;

export type ReviewInvestigationPolicy = Readonly<{
  policyId: 'review-investigation-shadow.v1';
  maxObligations: number;
  maxSeedProbesPerFile: number;
  maxSeedProbesOverall: number;
  maxExpansionDepth: number;
  maxSemanticTurns: number;
  maxOperationalAttempts: number;
  maxCriticCycles: number;
  maxFindings: number;
  maxProposalsPerTurn: number;
  maxReceiptsPerTurn: number;
}>;

export const REVIEW_INVESTIGATION_PRODUCTION_POLICY: ReviewInvestigationPolicy =
  Object.freeze({
    policyId: 'review-investigation-shadow.v1',
    maxObligations: 1_024,
    maxSeedProbesPerFile: REVIEW_INVESTIGATION_PROBE_LIMITS.maxProbesPerFile,
    maxSeedProbesOverall: REVIEW_INVESTIGATION_PROBE_LIMITS.maxProbesOverall,
    maxExpansionDepth: 8,
    maxSemanticTurns: 12,
    maxOperationalAttempts: 24,
    maxCriticCycles: 3,
    maxFindings: 256,
    maxProposalsPerTurn: 128,
    maxReceiptsPerTurn: 256,
  });

export const REVIEW_INVESTIGATION_COVERAGE_PROFILE = Object.freeze({
  coverageContractVersion: 'review-investigation-coverage.v1',
  criticPolicyVersion: REVIEW_INVESTIGATION_CRITIC_POLICY_V1,
  expansionRulesVersion: 'review-investigation-expansion.v2',
  gatewayPolicyVersion: 'context-gateway-v4',
  probePolicyVersion: REVIEW_INVESTIGATION_PROBE_POLICY_VERSION,
  runtimeProfileVersion: 'gateway-attested-agent.v1',
  searchPolicyVersion: REVIEW_INVESTIGATION_SEARCH_POLICY_VERSION,
});

export class ReviewInvestigationRecordingAdapter implements ReviewInvestigationRecordingPort {
  constructor(
    private readonly createRunner: ReviewInvestigationRunnerFactory,
    private readonly options: ReviewInvestigationRecordingOptions,
    readonly mode: ReviewInvestigationRecordingMode = ReviewInvestigationRecordingMode.RecordOnly,
    readonly verifiedCleanEffectsEnabled = false
  ) {}

  supports(input: {
    readonly workSlot: ReviewWorkSlotPlan;
    readonly invocation: PreparedReviewInvocation;
  }): boolean {
    return (
      reviewAgentProviderKind(input.workSlot.providerKind) !== null &&
      input.invocation.manifestFacts.providerKind ===
        input.workSlot.providerKind &&
      input.invocation.workSlotId === input.workSlot.workSlotId &&
      input.invocation.manifestFacts.executionProfile ===
        'investigation_gateway_v1' &&
      input.invocation.manifestFacts.taskKindSet.length === 1 &&
      input.invocation.manifestFacts.taskKindSet[0] ===
        ReviewTaskKind.FindingDiscovery &&
      input.invocation.coverageManifest.workSlotId ===
        input.workSlot.workSlotId &&
      input.invocation.investigationSeedEnvelope !== undefined &&
      input.invocation.investigationSeedEnvelope !== null &&
      input.invocation.investigationSeedEnvelope.hash ===
        input.invocation.manifestFacts.providerRequestEnvelopeHash &&
      supportsProbePlan(input.invocation, this.options.policy)
    );
  }

  async execute(
    input: Parameters<ReviewInvestigationRecordingPort['execute']>[0]
  ) {
    if (!this.supports(input)) {
      throw new Error('review_investigation_recording_unsupported');
    }
    if (
      input.sourceReviewRevisionHash !==
        input.authorization.facts.reviewRevisionHash ||
      input.invocation.coverageManifest.reviewRevisionHash !==
        input.sourceReviewRevisionHash
    ) {
      throw new Error('review_investigation_recording_revision_mismatch');
    }
    let result;
    try {
      result = await this.createRunner(input).execute({
        authorizationToken: input.authorization.authorizationToken,
        authorizationId: input.authorization.authorizationId,
        executionId: input.execution.executionId,
        workSlotId: input.workSlot.workSlotId,
        reviewRevisionHash: input.sourceReviewRevisionHash,
        stableReviewUnitKey: input.workSlot.shardKey,
        providerVoteLaneId: input.workSlot.providerVoteIdentityHash,
        providerStrategyId: input.manifest.providerInvocationKey,
        runtimeProfile: ReviewAgentExecutionProfile.GatewayAttestedAgentV1,
        coverageContract: reviewInvestigationCoverageContract(
          input.authorization.facts.producerReleaseId
        ),
        investigationPolicy: this.options.policy,
        seedEnvelope: requireSeedEnvelope(input.invocation),
        initialReceipts: [],
        providerManifestCanonicalJson: input.manifest.manifestCanonicalJson,
        providerManifestHash: sha256(input.manifest.manifestCanonicalJson),
        ownerIdHash: input.ownerIdHash,
        targetScope: {
          workspaceId: input.authorization.facts.workspaceId,
          repositoryConnectionId:
            input.authorization.facts.repositoryConnectionId,
          scmRepositoryIdentityId:
            input.authorization.facts.scmRepositoryIdentityId,
          pullRequestNumber: input.authorization.facts.pullRequestNumber,
          trustDomain: input.authorization.facts.trustDomain,
          authorizationScopeHash: sha256(
            canonicalJson({
              workspaceId: input.authorization.facts.workspaceId,
              repositoryConnectionId:
                input.authorization.facts.repositoryConnectionId,
              scmRepositoryIdentityId:
                input.authorization.facts.scmRepositoryIdentityId,
              pullRequestNumber: input.authorization.facts.pullRequestNumber,
            })
          ),
        },
        targetRevision: {
          baseSha: input.authorization.facts.baseSha,
          mergeBaseSha: input.authorization.facts.mergeBaseSha,
          headSha: input.authorization.facts.headSha,
          reviewRevisionHash: input.authorization.facts.reviewRevisionHash,
        },
        requestedModel: input.invocation.requestedModel,
        providerKind: requireReviewAgentProviderKind(
          input.workSlot.providerKind
        ),
        promptFor: (snapshot) =>
          investigationPrompt(input.invocation.reviewPrompt, snapshot),
        workingDirectory: this.options.workingDirectory,
        turnBudget: {
          maxGatewayOperations: this.options.policy.maxReceiptsPerTurn,
          maxOutputFindings: this.options.policy.maxFindings,
          maxOutputProposals: this.options.policy.maxProposalsPerTurn,
        },
        leaseDurationMs: this.options.leaseDurationMs,
        maxObligationsForTurn: this.options.maxObligationsForTurn,
        providerTimeoutMs: this.options.providerTimeoutMs,
        providerMaxTurns: this.options.policy.maxSemanticTurns,
        certificateTtlMs: this.options.certificateTtlMs,
        minimumCapacityParkMs: this.options.minimumCapacityParkMs,
        maxStateTransitions: this.options.maxStateTransitions,
        signal: input.signal,
      });
    } catch (error) {
      throw mapInvestigationGatewayConfigurationFailure(error) ?? error;
    }
    if (
      this.mode === ReviewInvestigationRecordingMode.RecordOnly &&
      (result.status === ReviewInvestigationRunStatus.Parked ||
        result.status === ReviewInvestigationRunStatus.RecoveryRequired ||
        result.status ===
          ReviewInvestigationRunStatus.TransitionBudgetExhausted)
    ) {
      throw new ReviewInvestigationLegacyFallbackSignal();
    }
    return terminalObservation(result.status, result.snapshot);
  }
}

function mapInvestigationGatewayConfigurationFailure(
  error: unknown
): ReviewInvocationConfigurationMismatchError | null {
  if (!(error instanceof ReviewInvestigationGatewayConfigurationError)) {
    return null;
  }
  switch (error.reason) {
    case ReviewInvestigationGatewayConfigurationFailureReason.ContextGatewayPolicyMismatch:
      return new ReviewInvocationConfigurationMismatchError(
        ReviewInvocationConfigurationMismatchReason.ContextGatewayPolicyMismatch,
        { cause: error }
      );
  }
}

export class RevisionGuardInvestigationCurrencyAdapter implements ReviewInvestigationCurrencyPort {
  constructor(private readonly revisions: ReviewRevisionGuardPort) {}

  async check(input: {
    readonly reviewRevisionHash: string;
  }): Promise<ReviewInvestigationCurrency> {
    const current = await this.revisions.loadCurrentRevision();
    return current.reviewRevisionHash === input.reviewRevisionHash
      ? ReviewInvestigationCurrency.Current
      : ReviewInvestigationCurrency.Superseded;
  }
}

export function reviewInvestigationCoverageContract(producerReleaseId: string) {
  if (producerReleaseId.length === 0) {
    throw new Error('review_investigation_producer_release_id_missing');
  }
  return Object.freeze({
    ...REVIEW_INVESTIGATION_COVERAGE_PROFILE,
    producerReleaseId,
  });
}

export function reviewInvestigationCoverageProfileHash(): string {
  return sha256(canonicalJson(REVIEW_INVESTIGATION_COVERAGE_PROFILE));
}

export function reviewInvestigationPolicyHash(
  policy: ReviewInvestigationPolicy = REVIEW_INVESTIGATION_PRODUCTION_POLICY
): string {
  return sha256(canonicalJson(policy));
}

function reviewAgentProviderKind(
  providerKind: ReviewExecutionProviderKind
): ReviewAgentProviderKind | null {
  switch (providerKind) {
    case ReviewExecutionProviderKind.Codex:
      return ReviewAgentProviderKind.Codex;
    case ReviewExecutionProviderKind.ClaudeCode:
      return ReviewAgentProviderKind.ClaudeCode;
    case ReviewExecutionProviderKind.OpenRouter:
      return null;
  }
}

function requireReviewAgentProviderKind(
  providerKind: ReviewExecutionProviderKind
): ReviewAgentProviderKind {
  const mapped = reviewAgentProviderKind(providerKind);
  if (mapped === null) {
    throw new Error('review_investigation_provider_unsupported');
  }
  return mapped;
}

function supportsProbePlan(
  invocation: PreparedReviewInvocation,
  policy: ReviewInvestigationPolicy
): boolean {
  const plan = invocation.investigationProbePlan;
  return (
    plan.status === ReviewInvestigationProbePlanStatus.Complete &&
    plan.limits.maxProbesPerFile === policy.maxSeedProbesPerFile &&
    plan.limits.maxProbesOverall === policy.maxSeedProbesOverall &&
    1 + invocation.coverageManifest.paths.length + plan.probes.length <=
      policy.maxObligations
  );
}

function requireSeedEnvelope(
  invocation: PreparedReviewInvocation
): NonNullable<PreparedReviewInvocation['investigationSeedEnvelope']> {
  const envelope = invocation.investigationSeedEnvelope;
  if (
    !envelope ||
    envelope.hash !== invocation.manifestFacts.providerRequestEnvelopeHash
  ) {
    throw new Error('review_investigation_seed_envelope_unbound');
  }
  return envelope;
}

function investigationPrompt(
  reviewPrompt: string,
  snapshot: ReviewInvestigationSnapshot
): string {
  if (snapshot.turn?.brief === null || snapshot.turn?.brief === undefined) {
    throw new Error('review_investigation_turn_brief_missing');
  }
  const encodedBrief = Buffer.from(
    canonicalJson(snapshot.turn.brief),
    'utf8'
  ).toString('base64url');
  return [
    reviewPrompt,
    '',
    'REVIEW INVESTIGATION TURN CONTRACT:',
    'Use only the reviewrouter Context Gateway tools. Investigate every obligation in the authenticated turn brief.',
    'For typed search requirements, execute the exact literal query with paths=["."], revision="head", caseSensitive=true, and pageSize=500, then follow every cursor to completion.',
    'During discovery turns, attach every complete typed search chain, plus every additional complete exploratory text-search chain, to operationBackedDiscoveryClaims with its sourceObligationId, exact query, and every operationReceiptId from the chain.',
    'When inspected evidence reveals additional review scope, add a provider-neutral obligationProposals entry instead of silently broadening an existing obligation.',
    'Each obligation proposal must contain exactly kind, canonicalSubject, canonicalRequirement, and riskPriority. Use only schema-listed kinds; never provide an obligation ID, state, authority decision, or receipt claim.',
    'Obligation proposals are non-authoritative and remain open until the control plane validates and independently closes them with accepted evidence.',
    'Do not close an obligation without complete operation receipt evidence.',
    `REVIEWROUTER_INVESTIGATION_TURN_BRIEF_V1_BASE64URL:${encodedBrief}`,
  ].join('\n');
}

function terminalObservation(
  status: ReviewInvestigationRunStatus,
  snapshot: ReviewInvestigationSnapshot
) {
  if (
    status !== ReviewInvestigationRunStatus.Completed ||
    snapshot.nextAction !== ReviewInvestigationNextAction.Terminal ||
    snapshot.certificateId === null ||
    snapshot.certificateHash === null ||
    snapshot.terminalActualModel === null ||
    snapshot.terminalObservationCanonicalJson === null ||
    snapshot.terminalOutcomeHash === null ||
    snapshot.conclusion === null
  ) {
    throw new Error(`review_investigation_not_publishable:${status}`);
  }
  const qualityFlags = [
    ...(snapshot.findingCount > 0 ? ['investigation_findings'] : []),
    ...(snapshot.conclusion === ReviewInvestigationConclusion.VerifiedClean
      ? ['investigation_verified_clean']
      : []),
    ...(snapshot.conclusion === ReviewInvestigationConclusion.Inconclusive
      ? ['investigation_inconclusive']
      : []),
  ];
  return Object.freeze({
    payloadCanonicalJson: snapshot.terminalObservationCanonicalJson,
    payloadHash: snapshot.terminalOutcomeHash,
    byteCount: Buffer.byteLength(
      snapshot.terminalObservationCanonicalJson,
      'utf8'
    ),
    findingCount: snapshot.findingCount,
    actualModel: snapshot.terminalActualModel,
    qualityFlags: Object.freeze(qualityFlags),
    transportAttemptCount: Math.max(1, snapshot.operationalAttempts),
    schemaValidated: true as const,
    fullyConsumed: true as const,
    investigationCertificateId: snapshot.certificateId,
    investigationCertificateHash: snapshot.certificateHash,
  });
}
