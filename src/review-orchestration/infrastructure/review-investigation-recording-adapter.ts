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
  ReviewInvestigationDeferredSignal,
  ReviewInvestigationLegacyFallbackReason,
  ReviewInvestigationLegacyFallbackSignal,
  RunInvestigationWorkSlot,
} from '../../review-investigation/application/run-investigation-work-slot';
import {
  REVIEW_INVESTIGATION_TURN_PROMPT_CONTRACT_HASH,
  buildReviewInvestigationTurnPrompt,
} from '../../review-investigation/application/review-investigation-turn-prompt';
import {
  REVIEW_INVESTIGATION_TURN_MAX_OBLIGATIONS,
  ReviewInvestigationConclusion,
  ReviewInvestigationNextAction,
  ReviewInvestigationRunStatus,
  type ReviewInvestigationSnapshot,
} from '../../review-investigation/domain/investigation-state';
import {
  ReviewAgentExecutionProfile,
  ReviewAgentProviderKind,
} from '../../review-investigation/domain/runtime-profile';
import { REVIEW_INVESTIGATION_CRITIC_POLICY_V2 } from '../../review-investigation/domain/semantic-risk-policy';
import { ReviewDepth } from '../../types';
import {
  canonicalJson,
  sha256,
} from '../../review-investigation/domain/canonical-json';
import { emitReviewInvestigationTelemetry } from './review-investigation-telemetry';
import {
  REVIEW_INVESTIGATION_PROBE_LIMITS,
  REVIEW_INVESTIGATION_PROBE_POLICY_VERSION,
  REVIEW_INVESTIGATION_SEARCH_POLICY_VERSION,
  ReviewInvestigationProbePlanStatus,
} from '../../review-investigation/domain/deterministic-context-probe-plan';

export type ReviewInvestigationRunnerFactory = (
  input: Parameters<ReviewInvestigationRecordingPort['execute']>[0]
) => RunInvestigationWorkSlot;

type ReviewInvestigationRecordingBaseOptions = Readonly<{
  workingDirectory: string;
  leaseDurationMs: number;
  providerTimeoutMs: number;
  investigationTimeoutMs?: number;
  certificateTtlMs: number;
  minimumCapacityParkMs: number;
  policy: ReviewInvestigationPolicy;
}>;

export type ReviewInvestigationRecordingOptions =
  ReviewInvestigationRecordingBaseOptions &
    Readonly<
      | {
          actionBudget: ReviewInvestigationActionBudget;
        }
      | {
          maxObligationsForTurn: number;
          maxStateTransitions: number;
        }
    >;

type NormalizedReviewInvestigationRecordingOptions =
  ReviewInvestigationRecordingBaseOptions &
    Readonly<{
      actionBudget: ReviewInvestigationActionBudget;
    }>;

export type ReviewInvestigationActionBudget = Readonly<{
  maxGatewayOperations: number;
  maxOutputFindings: number;
  maxOutputProposals: number;
  maxObligationsForTurn: number;
  providerMaxTurns: number;
  maxStateTransitions: number;
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

export enum ReviewInvestigationRecordingSupportReason {
  Supported = 'supported',
  ProviderUnsupported = 'provider_unsupported',
  ProviderMismatch = 'provider_mismatch',
  WorkSlotMismatch = 'work_slot_mismatch',
  ExecutionProfileMismatch = 'execution_profile_mismatch',
  TaskKindSetUnsupported = 'task_kind_set_unsupported',
  CoverageWorkSlotMismatch = 'coverage_work_slot_mismatch',
  SeedEnvelopeMissing = 'seed_envelope_missing',
  SeedEnvelopeUnbound = 'seed_envelope_unbound',
  InvestigationContextPromptMissing = 'investigation_context_prompt_missing',
  InvestigationContextPromptUnbound = 'investigation_context_prompt_unbound',
  ProbePlanIncomplete = 'probe_plan_incomplete',
  ProbeLimitsMismatch = 'probe_limits_mismatch',
  ObligationLimitExceeded = 'obligation_limit_exceeded',
}

export type ReviewInvestigationRecordingSupportDecision = Readonly<{
  supported: boolean;
  reason: ReviewInvestigationRecordingSupportReason;
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
  criticPolicyVersion: REVIEW_INVESTIGATION_CRITIC_POLICY_V2,
  expansionRulesVersion: 'review-investigation-expansion.v3',
  gatewayPolicyVersion: 'context-gateway-v4',
  probePolicyVersion: REVIEW_INVESTIGATION_PROBE_POLICY_VERSION,
  runtimeProfileVersion: 'gateway-attested-agent.v1',
  searchPolicyVersion: REVIEW_INVESTIGATION_SEARCH_POLICY_VERSION,
  turnPromptContractHash: REVIEW_INVESTIGATION_TURN_PROMPT_CONTRACT_HASH,
});

export class ReviewInvestigationRecordingAdapter implements ReviewInvestigationRecordingPort {
  private readonly options: NormalizedReviewInvestigationRecordingOptions;

  constructor(
    private readonly createRunner: ReviewInvestigationRunnerFactory,
    options: ReviewInvestigationRecordingOptions,
    readonly mode: ReviewInvestigationRecordingMode = ReviewInvestigationRecordingMode.RecordOnly,
    readonly verifiedCleanEffectsEnabled = false
  ) {
    this.options = normalizeReviewInvestigationRecordingOptions(options);
  }

  supports(input: {
    readonly workSlot: ReviewWorkSlotPlan;
    readonly invocation: PreparedReviewInvocation;
  }): boolean {
    const decision = reviewInvestigationRecordingSupportDecision(
      input,
      this.options.policy
    );
    emitReviewInvestigationTelemetry(
      `Review investigation candidate: supported=${decision.supported} reason=${decision.reason}`
    );
    return decision.supported;
  }

  async execute(
    input: Parameters<ReviewInvestigationRecordingPort['execute']>[0]
  ) {
    if (
      !reviewInvestigationRecordingSupportDecision(input, this.options.policy)
        .supported
    ) {
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
    const investigationTimeoutMs = requirePositiveTimeout(
      this.options.investigationTimeoutMs ?? this.options.providerTimeoutMs
    );
    const deadline = linkedDeadline(input.signal, investigationTimeoutMs);
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
        providerManifestHash: input.manifest.manifestKey,
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
          buildReviewInvestigationTurnPrompt({
            reviewContextPrompt: requireInvestigationContextPrompt(
              input.invocation
            ),
            turnBrief: requireTurnBrief(snapshot),
            maxGatewayOperations:
              this.options.actionBudget.maxGatewayOperations,
          }),
        workingDirectory: this.options.workingDirectory,
        turnBudget: {
          maxGatewayOperations: this.options.actionBudget.maxGatewayOperations,
          maxOutputFindings: this.options.actionBudget.maxOutputFindings,
          maxOutputProposals: this.options.actionBudget.maxOutputProposals,
        },
        leaseDurationMs: this.options.leaseDurationMs,
        maxObligationsForTurn: this.options.actionBudget.maxObligationsForTurn,
        providerTimeoutMs: this.options.providerTimeoutMs,
        providerMaxTurns: this.options.actionBudget.providerMaxTurns,
        maxGatewayOperations: this.options.actionBudget.maxGatewayOperations,
        certificateTtlMs: this.options.certificateTtlMs,
        minimumCapacityParkMs: this.options.minimumCapacityParkMs,
        maxStateTransitions: this.options.actionBudget.maxStateTransitions,
        signal: deadline.signal,
      });
    } catch (error) {
      if (deadline.expired()) {
        if (this.mode === ReviewInvestigationRecordingMode.RecordOnly) {
          throw new ReviewInvestigationLegacyFallbackSignal(
            ReviewInvestigationLegacyFallbackReason.RecordOnlyBudgetExhausted
          );
        }
        throw new ReviewInvestigationDeferredSignal(
          ReviewInvestigationRunStatus.RecoveryRequired
        );
      }
      throw mapInvestigationGatewayConfigurationFailure(error) ?? error;
    } finally {
      deadline.dispose();
    }
    if (isDeferred(result.status)) {
      if (this.mode === ReviewInvestigationRecordingMode.RecordOnly) {
        throw new ReviewInvestigationLegacyFallbackSignal(
          ReviewInvestigationLegacyFallbackReason.RecordOnlyDeferred,
          result.status
        );
      }
      throw new ReviewInvestigationDeferredSignal(result.status);
    }
    return terminalObservation(result.status, result.snapshot);
  }
}

const ACTION_BUDGET_BY_REVIEW_DEPTH = Object.freeze({
  [ReviewDepth.Economy]: Object.freeze({
    maxGatewayOperations: 0,
    maxOutputFindings: 0,
    maxOutputProposals: 0,
    maxObligationsForTurn: 0,
    providerMaxTurns: 0,
    maxStateTransitions: 0,
  }),
  [ReviewDepth.Balanced]: Object.freeze({
    maxGatewayOperations: 128,
    maxOutputFindings: 128,
    maxOutputProposals: 64,
    maxObligationsForTurn: REVIEW_INVESTIGATION_TURN_MAX_OBLIGATIONS,
    providerMaxTurns: 8,
    maxStateTransitions: 16,
  }),
  [ReviewDepth.Thorough]: Object.freeze({
    maxGatewayOperations: 256,
    maxOutputFindings: 256,
    maxOutputProposals: 128,
    maxObligationsForTurn: REVIEW_INVESTIGATION_TURN_MAX_OBLIGATIONS,
    providerMaxTurns: 12,
    maxStateTransitions: 24,
  }),
} satisfies Readonly<Record<ReviewDepth, ReviewInvestigationActionBudget>>);

export function reviewInvestigationActionBudgetForDepth(
  reviewDepth: ReviewDepth | undefined,
  policy: ReviewInvestigationPolicy = REVIEW_INVESTIGATION_PRODUCTION_POLICY
): ReviewInvestigationActionBudget {
  const requested =
    ACTION_BUDGET_BY_REVIEW_DEPTH[reviewDepth ?? ReviewDepth.Balanced];
  return Object.freeze({
    maxGatewayOperations: Math.min(
      requested.maxGatewayOperations,
      policy.maxReceiptsPerTurn
    ),
    maxOutputFindings: Math.min(
      requested.maxOutputFindings,
      policy.maxFindings
    ),
    maxOutputProposals: Math.min(
      requested.maxOutputProposals,
      policy.maxProposalsPerTurn
    ),
    maxObligationsForTurn: Math.min(
      requested.maxObligationsForTurn,
      policy.maxObligations,
      REVIEW_INVESTIGATION_TURN_MAX_OBLIGATIONS
    ),
    providerMaxTurns: Math.min(
      requested.providerMaxTurns,
      policy.maxSemanticTurns
    ),
    maxStateTransitions: Math.min(
      requested.maxStateTransitions,
      policy.maxOperationalAttempts
    ),
  });
}

function normalizeReviewInvestigationRecordingOptions(
  options: ReviewInvestigationRecordingOptions
): NormalizedReviewInvestigationRecordingOptions {
  if ('actionBudget' in options) {
    return options;
  }
  return Object.freeze({
    workingDirectory: options.workingDirectory,
    leaseDurationMs: options.leaseDurationMs,
    providerTimeoutMs: options.providerTimeoutMs,
    ...(options.investigationTimeoutMs === undefined
      ? {}
      : { investigationTimeoutMs: options.investigationTimeoutMs }),
    certificateTtlMs: options.certificateTtlMs,
    minimumCapacityParkMs: options.minimumCapacityParkMs,
    policy: options.policy,
    actionBudget: Object.freeze({
      maxGatewayOperations: options.policy.maxReceiptsPerTurn,
      maxOutputFindings: options.policy.maxFindings,
      maxOutputProposals: options.policy.maxProposalsPerTurn,
      maxObligationsForTurn: options.maxObligationsForTurn,
      providerMaxTurns: options.policy.maxSemanticTurns,
      maxStateTransitions: options.maxStateTransitions,
    }),
  });
}

function requirePositiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('review_investigation_timeout_invalid');
  }
  return value;
}

function linkedDeadline(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let deadlineExpired = false;
  const abortFromParent = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', abortFromParent, { once: true });
  if (parent?.aborted) abortFromParent();
  const timer = setTimeout(() => {
    deadlineExpired = true;
    controller.abort(new Error('review_investigation_deadline_exceeded'));
  }, timeoutMs);
  timer.unref();
  return Object.freeze({
    signal: controller.signal,
    expired: () => deadlineExpired,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    },
  });
}

function isDeferred(
  status: ReviewInvestigationRunStatus
): status is
  | ReviewInvestigationRunStatus.Parked
  | ReviewInvestigationRunStatus.RecoveryRequired
  | ReviewInvestigationRunStatus.TransitionBudgetExhausted {
  return (
    status === ReviewInvestigationRunStatus.Parked ||
    status === ReviewInvestigationRunStatus.RecoveryRequired ||
    status === ReviewInvestigationRunStatus.TransitionBudgetExhausted
  );
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

export function reviewInvestigationRecordingSupportDecision(
  input: {
    readonly workSlot: ReviewWorkSlotPlan;
    readonly invocation: PreparedReviewInvocation;
  },
  policy: ReviewInvestigationPolicy
): ReviewInvestigationRecordingSupportDecision {
  const unsupported = (reason: ReviewInvestigationRecordingSupportReason) =>
    Object.freeze({ supported: false, reason });
  if (reviewAgentProviderKind(input.workSlot.providerKind) === null) {
    return unsupported(
      ReviewInvestigationRecordingSupportReason.ProviderUnsupported
    );
  }
  if (
    input.invocation.manifestFacts.providerKind !== input.workSlot.providerKind
  ) {
    return unsupported(
      ReviewInvestigationRecordingSupportReason.ProviderMismatch
    );
  }
  if (input.invocation.workSlotId !== input.workSlot.workSlotId) {
    return unsupported(
      ReviewInvestigationRecordingSupportReason.WorkSlotMismatch
    );
  }
  if (
    input.invocation.manifestFacts.executionProfile !==
    'investigation_gateway_v1'
  ) {
    return unsupported(
      ReviewInvestigationRecordingSupportReason.ExecutionProfileMismatch
    );
  }
  if (
    input.invocation.manifestFacts.taskKindSet.length !== 1 ||
    input.invocation.manifestFacts.taskKindSet[0] !==
      ReviewTaskKind.FindingDiscovery
  ) {
    return unsupported(
      ReviewInvestigationRecordingSupportReason.TaskKindSetUnsupported
    );
  }
  if (
    input.invocation.coverageManifest.workSlotId !== input.workSlot.workSlotId
  ) {
    return unsupported(
      ReviewInvestigationRecordingSupportReason.CoverageWorkSlotMismatch
    );
  }
  const bindingFailure = investigationPromptBindingFailure(input.invocation);
  if (bindingFailure !== null) return unsupported(bindingFailure);
  const plan = input.invocation.investigationProbePlan;
  if (plan.status !== ReviewInvestigationProbePlanStatus.Complete) {
    return unsupported(
      ReviewInvestigationRecordingSupportReason.ProbePlanIncomplete
    );
  }
  if (
    plan.limits.maxProbesPerFile !== policy.maxSeedProbesPerFile ||
    plan.limits.maxProbesOverall !== policy.maxSeedProbesOverall
  ) {
    return unsupported(
      ReviewInvestigationRecordingSupportReason.ProbeLimitsMismatch
    );
  }
  if (
    1 + input.invocation.coverageManifest.paths.length + plan.probes.length >
    policy.maxObligations
  ) {
    return unsupported(
      ReviewInvestigationRecordingSupportReason.ObligationLimitExceeded
    );
  }
  return Object.freeze({
    supported: true,
    reason: ReviewInvestigationRecordingSupportReason.Supported,
  });
}

function requireSeedEnvelope(
  invocation: PreparedReviewInvocation
): NonNullable<PreparedReviewInvocation['investigationSeedEnvelope']> {
  const envelope = invocation.investigationSeedEnvelope;
  const failure = investigationPromptBindingFailure(invocation);
  if (!envelope || failure !== null) {
    throw new Error(
      `review_investigation_seed_envelope_unbound:${failure ?? 'missing'}`
    );
  }
  return envelope;
}

function requireInvestigationContextPrompt(
  invocation: PreparedReviewInvocation
): string {
  const prompt = invocation.investigationContextPrompt;
  if (!prompt || !invocation.investigationSeedEnvelope) {
    throw new Error('review_investigation_context_prompt_missing');
  }
  return prompt;
}

function requireTurnBrief(snapshot: ReviewInvestigationSnapshot) {
  const brief = snapshot.turn?.brief;
  if (brief === null || brief === undefined) {
    throw new Error('review_investigation_turn_brief_missing');
  }
  return brief;
}

function investigationPromptBindingFailure(
  invocation: PreparedReviewInvocation
): ReviewInvestigationRecordingSupportReason | null {
  const envelope = invocation.investigationSeedEnvelope;
  if (!envelope) {
    return ReviewInvestigationRecordingSupportReason.SeedEnvelopeMissing;
  }
  const prompt = invocation.investigationContextPrompt;
  if (!prompt?.trim()) {
    return ReviewInvestigationRecordingSupportReason.InvestigationContextPromptMissing;
  }
  if (
    envelope.canonicalJson !== canonicalJson(envelope.envelope) ||
    envelope.hash !== sha256(envelope.canonicalJson) ||
    envelope.hash !== invocation.manifestFacts.providerRequestEnvelopeHash
  ) {
    return ReviewInvestigationRecordingSupportReason.SeedEnvelopeUnbound;
  }
  if (envelope.envelope.reviewPromptHash !== sha256(prompt)) {
    return ReviewInvestigationRecordingSupportReason.InvestigationContextPromptUnbound;
  }
  return null;
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
