import {
  ReviewExecutionProviderKind,
  ReviewInvestigationRecordingMode,
  ReviewTaskKind,
  type PreparedReviewInvocation,
  type ReviewInvestigationRecordingPort,
  type ReviewInvocationLease,
  type ReviewRevisionGuardPort,
  type ReviewWorkSlotPlan,
} from '../application';
import {
  ReviewInvestigationCurrency,
  type ReviewInvestigationCurrencyPort,
  type ReviewInvestigationLease,
  type ReviewInvestigationLeasePort,
} from '../../review-investigation/application/investigation-control-plane-port';
import { RunInvestigationWorkSlot } from '../../review-investigation/application/run-investigation-work-slot';
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
import { ReviewTurnObligationKind } from '../../review-investigation/domain/turn-observation';
import {
  canonicalJson,
  sha256,
} from '../../review-investigation/domain/canonical-json';

export type ReviewInvestigationRunnerFactory = (
  input: Parameters<ReviewInvestigationRecordingPort['execute']>[0]
) => RunInvestigationWorkSlot;

export type ReviewInvestigationRecordingOptions = Readonly<{
  workingDirectory: string;
  providerCredentialEnvironment: () => Readonly<NodeJS.ProcessEnv>;
  leaseDurationMs: number;
  providerTimeoutMs: number;
  certificateTtlMs: number;
  minimumCapacityParkMs: number;
  maxObligationsForTurn: number;
  maxStateTransitions: number;
  maxSemanticTurns: number;
  maxOperationalAttempts: number;
  maxCriticCycles: number;
  maxObligations: number;
  maxFindings: number;
  maxProposalsPerTurn: number;
  maxReceiptsPerTurn: number;
  maxExpansionDepth: number;
}>;

export class ReviewInvestigationRecordingAdapter implements ReviewInvestigationRecordingPort {
  constructor(
    private readonly createRunner: ReviewInvestigationRunnerFactory,
    private readonly options: ReviewInvestigationRecordingOptions,
    readonly mode: ReviewInvestigationRecordingMode = ReviewInvestigationRecordingMode.RecordOnly
  ) {}

  supports(input: {
    readonly workSlot: ReviewWorkSlotPlan;
    readonly invocation: PreparedReviewInvocation;
  }): boolean {
    return (
      input.workSlot.providerKind === ReviewExecutionProviderKind.Codex &&
      input.invocation.workSlotId === input.workSlot.workSlotId &&
      input.invocation.manifestFacts.executionProfile ===
        (this.mode === ReviewInvestigationRecordingMode.Authoritative
          ? 'investigation_gateway_v1'
          : 'context_gateway_v1') &&
      input.invocation.manifestFacts.taskKindSet.length === 1 &&
      input.invocation.manifestFacts.taskKindSet[0] ===
        ReviewTaskKind.FindingDiscovery &&
      input.invocation.coverageManifest.workSlotId === input.workSlot.workSlotId
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
    const result = await this.createRunner(input).execute({
      authorizationToken: input.authorization.authorizationToken,
      authorizationId: input.authorization.authorizationId,
      executionId: input.execution.executionId,
      workSlotId: input.workSlot.workSlotId,
      reviewRevisionHash: input.sourceReviewRevisionHash,
      stableReviewUnitKey: input.workSlot.shardKey,
      providerVoteLaneId: input.workSlot.providerVoteIdentityHash,
      providerStrategyId: input.manifest.providerInvocationKey,
      runtimeProfile: ReviewAgentExecutionProfile.GatewayAttestedAgentV1,
      coverageContract: coverageContract(
        input.authorization.facts.producerReleaseId
      ),
      investigationPolicy: investigationPolicy(this.options),
      seedObligations: seedObligations(input.invocation),
      initialReceipts: [],
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
      providerManifestCanonicalJson: input.manifest.manifestCanonicalJson,
      providerManifestHash: sha256(input.manifest.manifestCanonicalJson),
      requestedModel: input.invocation.requestedModel,
      providerKind: ReviewAgentProviderKind.Codex,
      promptFor: (snapshot) =>
        investigationPrompt(input.invocation.reviewPrompt, snapshot),
      workingDirectory: this.options.workingDirectory,
      providerCredentialEnvironment:
        this.options.providerCredentialEnvironment(),
      turnBudget: {
        maxGatewayOperations: this.options.maxReceiptsPerTurn,
        maxOutputFindings: this.options.maxFindings,
        maxOutputProposals: this.options.maxProposalsPerTurn,
      },
      leaseDurationMs: this.options.leaseDurationMs,
      maxObligationsForTurn: this.options.maxObligationsForTurn,
      providerTimeoutMs: this.options.providerTimeoutMs,
      providerMaxTurns: this.options.maxSemanticTurns,
      certificateTtlMs: this.options.certificateTtlMs,
      minimumCapacityParkMs: this.options.minimumCapacityParkMs,
      maxStateTransitions: this.options.maxStateTransitions,
      managedLease: () => investigationLease(input.currentLease()),
      signal: input.signal,
    });
    return terminalObservation(result.status, result.snapshot);
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

export class ManagedOnlyInvestigationLeaseAdapter implements ReviewInvestigationLeasePort {
  async acquire(): Promise<never> {
    throw new Error('review_investigation_managed_lease_required');
  }

  async release(): Promise<never> {
    throw new Error('review_investigation_managed_lease_release_forbidden');
  }
}

function coverageContract(producerReleaseId: string) {
  return Object.freeze({
    coverageContractVersion: 'review-investigation-coverage.v1',
    expansionRulesVersion: 'review-investigation-expansion.v1',
    criticPolicyVersion: 'review-investigation-critic.v1',
    gatewayPolicyVersion: 'context-gateway-v4',
    producerReleaseId,
    runtimeProfileVersion: 'gateway-attested-agent.v1',
  });
}

function investigationPolicy(options: ReviewInvestigationRecordingOptions) {
  return Object.freeze({
    policyId: 'review-investigation-shadow.v1',
    maxObligations: options.maxObligations,
    maxExpansionDepth: options.maxExpansionDepth,
    maxSemanticTurns: options.maxSemanticTurns,
    maxOperationalAttempts: options.maxOperationalAttempts,
    maxCriticCycles: options.maxCriticCycles,
    maxFindings: options.maxFindings,
    maxProposalsPerTurn: options.maxProposalsPerTurn,
    maxReceiptsPerTurn: options.maxReceiptsPerTurn,
  });
}

function seedObligations(invocation: PreparedReviewInvocation) {
  const paths = [...invocation.coverageManifest.paths]
    .map((item) => item.path)
    .sort(compareCodeUnits);
  if (new Set(paths).size !== paths.length) {
    throw new Error('review_investigation_seed_path_duplicate');
  }
  return Object.freeze([
    Object.freeze({
      kind: ReviewTurnObligationKind.InventoryWitness,
      canonicalSubject: `inventory:${invocation.coverageManifest.reviewRevisionHash}`,
      canonicalRequirement:
        'authenticate the complete canonical changed-path inventory',
      riskPriority: 1_000_000,
    }),
    ...paths.map((path) =>
      Object.freeze({
        kind: ReviewTurnObligationKind.ChangedContent,
        canonicalSubject: `${path}@head`,
        canonicalRequirement:
          'inspect the complete changed content and its directly relevant context',
        riskPriority: 900_000,
      })
    ),
  ]);
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
    'Do not close an obligation without complete operation receipt evidence. Propose newly discovered obligations instead of silently broadening scope.',
    `REVIEWROUTER_INVESTIGATION_TURN_BRIEF_V1_BASE64URL:${encodedBrief}`,
  ].join('\n');
}

function investigationLease(
  lease: ReviewInvocationLease
): ReviewInvestigationLease {
  return Object.freeze({
    leaseId: lease.leaseId,
    attemptId: lease.attemptId,
    leaseCapability: lease.leaseCapability,
    fencingToken: lease.fencingToken,
    expiresAt: lease.expiresAt,
    resultReportUntil: lease.resultReportUntil,
  });
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

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
