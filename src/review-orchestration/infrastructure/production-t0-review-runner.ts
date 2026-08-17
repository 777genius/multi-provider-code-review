import { createHash } from 'crypto';
import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import * as core from '../../actions/core';
import { PromptBuilder } from '../../analysis/llm/prompt-builder';
import { getProviderReviewTotalAttempts } from '../../analysis/llm/retry-policy';
import { hashIncrementalCompatibility } from '../../cache/key-builder';
import { ConfigLoader } from '../../config/loader';
import { applyControlPlaneRuntimeConfig } from '../../control-plane/runtime-config';
import { ReviewActionV2Client } from '../../control-plane/review-action-v2-client';
import { REVIEW_INVESTIGATION_TURN_MAX_OBLIGATIONS } from '../../review-investigation/domain/investigation-state';
import { CONTEXT_GATEWAY_DEFAULT_POLICY_VERSION } from '../../context-gateway/context-gateway-release-contract';
import { BatchOrchestrator } from '../../core/batch-orchestrator';
import { prioritizeFilesByRisk } from '../../review-execution/domain/file-risk-priority';
import {
  createExecutionDeadlineFromEnvironment,
  REVIEW_EXECUTION_DEADLINE_ENV_KEY,
} from '../../review-execution/infrastructure/execution-deadline-from-environment';
import { GitHubClient } from '../../github/client';
import type { GitHubTokenProvider } from '../../github/token-provider';
import { ReviewLedger } from '../../github/ledger';
import { PullRequestLoader } from '../../github/pr-loader';
import { CodexProvider } from '../../providers/codex';
import { recoverDiffForFiles } from '../../utils/diff';
import { logger } from '../../utils/logger';
import { emitReviewInvestigationTelemetry } from './review-investigation-telemetry';
import type {
  FileChange,
  LifecycleTarget,
  PRContext,
  ReviewConfig,
} from '../../types';
import { GitHubActionsOidcTokenProvider } from '../../codex-oauth/github-actions-oidc';
import {
  CodexOAuthV2ReviewOutcome,
  CodexOAuthV2TerminalReason,
  type CodexOAuthV2ReviewResult,
  type CodexOAuthV2ReviewRunnerPort,
} from '../../codex-oauth/runtime';
import {
  ReviewExecutionProviderKind,
  ReviewOrchestrationResultStatus,
  ReviewTaskKind,
  RunT0ReviewOrchestration,
  type ReviewPublicationUnavailableFact,
  type ReviewRunAuthorization,
} from '../application';
import {
  createStableReviewBatchId,
  createStableReviewWorkPlan,
} from '../domain';
import type { MergeGateConclusion } from '../../review-projection/domain';
import {
  CodexReviewInvocationAdapter,
  CooperativeReviewLeaseSupervisor,
  DeterministicReviewOrchestrationIdentity,
  GeneratedProviderInvocationManifestAssembler,
  SystemReviewOrchestrationDelay,
  type CodexReviewAssignment,
} from './codex-review-invocation-adapter';
import {
  ContextGatewayInvocationSessionFactory,
  SubprocessRequiredContextWitnessRunner,
} from './context-gateway-invocation-session';
import { ContextAttestationReplayRunner } from './context-attestation-replay-runner';
import { ProviderInvocationFailureClassifier } from './provider-invocation-failure-classifier';
import {
  LoggingReviewInvestigationDiagnostics,
  LoggingReviewInvocationDiagnostics,
} from './review-invocation-diagnostics';
import { GitReviewRevisionMaterializer } from './git-review-revision-materializer';
import {
  FreshGitHubLifecycleInventory,
  GitHubReviewRevisionGuard,
} from './github-review-state-adapter';
import { createProductionReviewProjectionBuilder } from './production-review-projection';
import { ReviewActionV2ControlPlaneAdapter } from './review-action-v2-control-plane-adapter';
import { SystemReviewOrchestrationClock } from './system-review-orchestration-clock';
import {
  CodexReviewAgentAdapter,
  ContextGatewayV4InvestigationAdapter,
  LoggingInvestigationOperationalDiagnostics,
  NodeReviewAgentProcessRunner,
  ReviewInvestigationControlPlaneError,
  ReviewInvestigationControlPlaneFailureClass,
  ReviewInvestigationLegacyFallbackSignal,
  ReviewAgentProviderKind,
  ReviewActionV2InvestigationAdapter,
  ReviewActionV2InvestigationLeaseAdapter,
  ReplayInvestigationOnRevision,
  RunInvestigationTurn,
  RunInvestigationWorkSlot,
  type ReviewAgentExecutionSessionResolverPort,
  type ReviewInvestigationControlPlanePort,
  type ReviewInvestigationReplayControlPlanePort,
} from '../../review-investigation';
import {
  REVIEW_INVESTIGATION_PRODUCTION_POLICY,
  ReviewInvestigationRecordingAdapter,
  RevisionGuardInvestigationCurrencyAdapter,
} from './review-investigation-recording-adapter';
import {
  createProductionReviewInvestigationAgentSelector,
  createProductionReviewInvestigationGatewayFactory,
  createProductionReviewInvestigationInvocation,
  formatProductionReviewInvestigationRolloutTelemetry,
  productionReviewInvestigationRecordingMode,
  readProductionReviewInvestigationRolloutFlags,
  resolveProductionReviewInvestigationRolloutResolution,
  type ConfiguredProductionReviewAgent,
} from './production-review-investigation-composition';
import { ReviewActionV2InvestigationContextAttestationAdapter } from './review-action-v2-investigation-context-attestation-adapter';

const execFileAsync = promisify(execFile);
const CODEX_RETRY_POLICY_VERSION = 'codex-semantic-retry.v1';
const SCM_READ_TOKEN_EXPIRY_MARGIN_MS = 30_000;

export class ProductionT0ReviewRunner implements CodexOAuthV2ReviewRunnerPort {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly progress?: import('../application/run-t0-review-orchestration').ReviewOrchestrationProgressPort
  ) {}

  async run(
    input: Parameters<CodexOAuthV2ReviewRunnerPort['run']>[0]
  ): Promise<CodexOAuthV2ReviewResult> {
    return withRunnerEnvironment(input, async () => {
      try {
        return await this.runInWorkspace(input);
      } catch (error) {
        const revisionFailure = mapRevisionGuardErrorToCodexOutcome(error);
        if (revisionFailure) return revisionFailure;
        throw error;
      }
    });
  }

  private async runInWorkspace(
    input: Parameters<CodexOAuthV2ReviewRunnerPort['run']>[0]
  ): Promise<CodexOAuthV2ReviewResult> {
    validateInput(input);
    const authoritativeDeadlineEpochMs =
      process.env[REVIEW_EXECUTION_DEADLINE_ENV_KEY];
    const oidc = new GitHubActionsOidcTokenProvider({
      fetchImpl: this.fetchImpl,
    });
    await applyReviewRuntimeConfig(input, this.fetchImpl, oidc);
    if (authoritativeDeadlineEpochMs === undefined) {
      delete process.env[REVIEW_EXECUTION_DEADLINE_ENV_KEY];
    } else {
      process.env[REVIEW_EXECUTION_DEADLINE_ENV_KEY] =
        authoritativeDeadlineEpochMs;
    }
    const config = ConfigLoader.load();
    const executionDeadline = createExecutionDeadlineFromEnvironment();
    const reviewActionClient = new ReviewActionV2Client({
      apiUrl: input.apiUrl,
      fetchImpl: this.fetchImpl,
    });
    const controlPlane = new ReviewActionV2ControlPlaneAdapter(
      reviewActionClient
    );
    const authorization = await controlPlane.authorize({
      oidcToken: await oidc.requestToken(input.audience),
    });
    validateAuthorizationInput(input, authorization);

    const scmReadTokenProvider = createScmReadTokenProvider({
      token: input.scmReadToken,
      expiresAt: input.scmReadTokenExpiresAt,
      refresh: input.refreshScmReadToken,
    });
    const github = new GitHubClient(input.scmReadToken, {
      tokenProvider: scmReadTokenProvider,
    });
    const revisionGuard = new GitHubReviewRevisionGuard(github, {
      workspaceId: authorization.facts.workspaceId,
      repositoryConnectionId: authorization.facts.repositoryConnectionId,
      scmRepositoryIdentityId: authorization.facts.scmRepositoryIdentityId,
      pullRequestNumber: authorization.facts.pullRequestNumber,
    });
    const checkedOutHead = await readCheckedOutHead(input.workspacePath);
    if (checkedOutHead !== authorization.facts.headSha) {
      throw new Error('review_action_v2_checked_out_revision_mismatch');
    }
    const currentRevision = await revisionGuard.loadCurrentRevision();
    if (currentRevision.pullRequestState === 'closed') {
      return { outcome: CodexOAuthV2ReviewOutcome.Cancelled };
    }
    if (!sameAuthorizedRevision(currentRevision, authorization)) {
      return { outcome: CodexOAuthV2ReviewOutcome.Superseded };
    }

    const pr = await new PullRequestLoader(github).load(
      authorization.facts.pullRequestNumber
    );
    if (
      pr.baseSha.toLowerCase() !== authorization.facts.baseSha ||
      pr.headSha.toLowerCase() !== authorization.facts.headSha
    ) {
      return { outcome: CodexOAuthV2ReviewOutcome.Superseded };
    }
    await new GitReviewRevisionMaterializer().ensureAvailable({
      checkoutRoot: path.resolve(input.workspacePath),
      repository: input.repository,
      scmReadToken: await scmReadTokenProvider.getToken(),
      commitShas: [
        authorization.facts.baseSha,
        authorization.facts.mergeBaseSha,
        authorization.facts.headSha,
      ],
    });
    const lifecycleInventory = new FreshGitHubLifecycleInventory(
      github,
      new ReviewLedger(github, process.env.REVIEW_ROUTER_LEDGER_KEY)
    );
    const initialLifecycle = await lifecycleInventory.loadForPrompt(
      pr.number,
      authorization.facts.headSha
    );
    const codexProviderName = selectCodexProvider(config);
    const model = codexProviderName.slice('codex/'.length);
    const agenticContext = config.codexAgenticContext ?? true;
    const investigationRolloutResolution =
      resolveProductionReviewInvestigationRolloutResolution({
        flags: readProductionReviewInvestigationRolloutFlags(),
        agenticContext,
        authorization,
        primaryProviderKind: ReviewExecutionProviderKind.Codex,
      });
    const investigationRollout = investigationRolloutResolution.rollout;
    emitReviewInvestigationTelemetry(
      formatProductionReviewInvestigationRolloutTelemetry(
        investigationRolloutResolution
      )
    );
    const investigationRecordingEnabled = investigationRollout.recordingEnabled;
    const provider = new CodexProvider(model, {
      agenticContext,
      eventAudit: config.codexEventAudit,
    });
    const compatibilityKey = hashIncrementalCompatibility(
      config,
      process.env.REVIEWROUTER_RUNTIME_CONFIG_VERSION
    );
    const gatewayBundlePath = resolveContextGatewayBundlePath();
    const requiredContextWitness = new SubprocessRequiredContextWitnessRunner();
    const contextGatewayOptions =
      resolveProductionContextGatewaySessionFactoryOptions({
        agenticContext,
        investigationRecordingEnabled,
        checkoutRoot: path.resolve(input.workspacePath),
        gatewayBundlePath,
      });
    const contextGateway = contextGatewayOptions
      ? new ContextGatewayInvocationSessionFactory(
          controlPlane,
          contextGatewayOptions,
          requiredContextWitness
        )
      : undefined;
    const contextReplayRunner = contextGateway
      ? new ContextAttestationReplayRunner({
          checkoutRoot: path.resolve(input.workspacePath),
          gatewayBundlePath,
        })
      : undefined;
    const planned = planAssignments({
      authorization,
      pr,
      config,
      providerName: provider.name,
      compatibilityKey,
      lifecycleTargets: initialLifecycle.promptTargets,
      liveLifecycleStateHash: initialLifecycle.inventory.lifecycleStateHash,
    });
    const invocationAdapter = new CodexReviewInvocationAdapter(
      provider,
      new PromptBuilder(config),
      planned.assignments,
      Math.max(1_000, config.runTimeoutSeconds * 1_000),
      agenticContext,
      contextGateway,
      false
    );
    const investigationInvocationAdapter =
      createProductionReviewInvestigationInvocation({
        rollout: investigationRollout,
        create: () =>
          new CodexReviewInvocationAdapter(
            provider,
            new PromptBuilder(config),
            planned.assignments,
            Math.max(1_000, config.runTimeoutSeconds * 1_000),
            agenticContext,
            contextGateway,
            true
          ),
      });
    const identities = new DeterministicReviewOrchestrationIdentity();
    const investigationProtocol = investigationRecordingEnabled
      ? new ReviewActionV2InvestigationAdapter(reviewActionClient)
      : undefined;
    const investigationControlPlane = investigationProtocol
      ? new LegacyFallbackBeforeInvestigationAuthorityControlPlane(
          investigationProtocol
        )
      : undefined;
    const investigationRecording =
      investigationControlPlane && contextGatewayOptions
        ? new ReviewInvestigationRecordingAdapter(
            (recordingInput) => {
              const currency = new RevisionGuardInvestigationCurrencyAdapter(
                revisionGuard
              );
              const investigationGatewayFactory =
                createProductionReviewInvestigationGatewayFactory(
                  new ContextGatewayInvocationSessionFactory(
                    new ReviewActionV2InvestigationContextAttestationAdapter(
                      reviewActionClient,
                      recordingInput.authorization.authorizationToken
                    ),
                    contextGatewayOptions,
                    requiredContextWitness
                  )
                );
              const gateway = new ContextGatewayV4InvestigationAdapter(
                investigationGatewayFactory,
                {
                  revision: {
                    baseSha: authorization.facts.baseSha,
                    mergeBaseSha: authorization.facts.mergeBaseSha,
                    headSha: authorization.facts.headSha,
                  },
                  preparedManifestKey: recordingInput.manifest.manifestKey,
                  providerKind:
                    recordingInput.invocation.manifestFacts.providerKind,
                  requestedModel: recordingInput.invocation.requestedModel,
                  executionProfile:
                    recordingInput.invocation.manifestFacts.executionProfile,
                  providerInvocationKey:
                    recordingInput.manifest.providerInvocationKey,
                  toolPolicyHash:
                    recordingInput.invocation.manifestFacts.toolPolicyHash,
                }
              );
              const agents = createProductionReviewInvestigationAgentSelector({
                authorization,
                primaryProviderKind: ReviewAgentProviderKind.Codex,
                contextCriticEnabled: investigationRollout.contextCriticEnabled,
                agents: createConfiguredProductionInvestigationAgents({
                  codexModel: model,
                  codexBinaryPath: input.codexBinaryPath,
                  executionSessions: gateway,
                }),
              });
              return new RunInvestigationWorkSlot({
                controlPlane: investigationControlPlane,
                delay: new SystemReviewOrchestrationDelay(),
                leases: new ReviewActionV2InvestigationLeaseAdapter(
                  reviewActionClient
                ),
                ...(investigationRollout.crossRevisionReplayEnabled &&
                contextReplayRunner
                  ? {
                      replay: new ReplayInvestigationOnRevision({
                        controlPlane: investigationControlPlane,
                        receipts: contextReplayRunner,
                        currency,
                      }),
                    }
                  : {}),
                turnRunner: new RunInvestigationTurn({
                  controlPlane: investigationControlPlane,
                  currency,
                  gateway,
                  agents,
                  diagnostics: new LoggingInvestigationOperationalDiagnostics(
                    logger
                  ),
                  now: () => new Date(),
                }),
              });
            },
            {
              workingDirectory: path.resolve(input.workspacePath),
              leaseDurationMs:
                Math.max(1_000, config.runTimeoutSeconds * 1_000) + 5 * 60_000,
              providerTimeoutMs: Math.max(
                1_000,
                config.runTimeoutSeconds * 1_000
              ),
              certificateTtlMs: 24 * 60 * 60_000,
              minimumCapacityParkMs: 60_000,
              maxObligationsForTurn: REVIEW_INVESTIGATION_TURN_MAX_OBLIGATIONS,
              maxStateTransitions: 128,
              policy: REVIEW_INVESTIGATION_PRODUCTION_POLICY,
            },
            productionReviewInvestigationRecordingMode(investigationRollout),
            investigationRollout.verifiedCleanEnabled
          )
        : undefined;
    const useCase = new RunT0ReviewOrchestration({
      controlPlane,
      revisionGuard,
      oidc: {
        getToken: () => oidc.requestToken(input.audience),
      },
      invocationManifestAssembler:
        new GeneratedProviderInvocationManifestAssembler(
          authorization,
          config,
          compatibilityKey
        ),
      invocations: invocationAdapter,
      ...(investigationInvocationAdapter
        ? { investigationInvocations: investigationInvocationAdapter }
        : {}),
      invocationFailureClassifier: new ProviderInvocationFailureClassifier(),
      invocationDiagnostics: new LoggingReviewInvocationDiagnostics(logger),
      investigationDiagnostics: new LoggingReviewInvestigationDiagnostics(
        logger
      ),
      leaseSupervisor: new CooperativeReviewLeaseSupervisor(),
      ...(investigationRecording ? { investigationRecording } : {}),
      projectionBuilder: createProductionReviewProjectionBuilder({
        authorizationFacts: authorization.facts,
        pr,
        config,
        protocolLimits: authorization.limits,
        assignments: planned.assignments.map((assignment) => ({
          workSlotId: assignment.workSlot.workSlotId,
          taskKind: assignment.workSlot.taskKind,
          providerKind: assignment.workSlot.providerKind,
          required: assignment.workSlot.required,
          filePaths: assignment.context.files.map((file) => file.filename),
        })),
        uncoveredPaths: planned.uncoveredPaths,
        uncoveredLifecycleTargetIds: planned.uncoveredLifecycleTargetIds,
        lifecycleInventory,
      }),
      ...(contextGateway
        ? {
            contextReplay: contextReplayRunner,
            contextAttestations: controlPlane,
          }
        : {}),
      identities,
      clock: new SystemReviewOrchestrationClock(),
      delay: new SystemReviewOrchestrationDelay(),
      executionDeadline,
      ...(this.progress ? { progress: this.progress } : {}),
    });
    const result = await useCase.executeAuthorized(
      {
        executionId: identities.deterministicId('execution', [
          authorization.authorizationId,
          authorization.facts.reviewRevisionHash,
          planned.plan.planHash,
        ]),
        baseSha: authorization.facts.baseSha,
        mergeBaseSha: authorization.facts.mergeBaseSha,
        headSha: authorization.facts.headSha,
        reviewRevisionHash: authorization.facts.reviewRevisionHash,
        compatibilityKey,
        planHash: planned.plan.planHash,
        workSlotsCanonicalJson: planned.plan.workSlotsCanonicalJson,
        assignmentManifestCanonicalJson:
          planned.plan.assignmentManifestCanonicalJson,
        assignmentManifestHash: planned.plan.assignmentManifestHash,
        workSlots: planned.plan.assignments.map(
          (assignment) => assignment.workSlot
        ),
        sourceRunId: authorization.facts.sourceRunId,
        sourceRunAttempt: authorization.facts.sourceRunAttempt,
        ownerIdHash: sha256(
          canonicalJson({
            authorizationId: authorization.authorizationId,
            providerInstanceId: input.providerInstanceId,
            sourceRunAttempt: authorization.facts.sourceRunAttempt,
            sourceRunId: authorization.facts.sourceRunId,
          })
        ),
        allowPartial: true,
      },
      authorization
    );
    return mapOrchestrationResultToCodexOutcome(result);
  }
}

export function resolveProductionContextGatewayPolicyVersion(input: {
  readonly agenticContext: boolean;
}): typeof CONTEXT_GATEWAY_DEFAULT_POLICY_VERSION | null {
  return input.agenticContext ? CONTEXT_GATEWAY_DEFAULT_POLICY_VERSION : null;
}

export function resolveProductionContextGatewaySessionFactoryOptions(input: {
  readonly agenticContext: boolean;
  readonly investigationRecordingEnabled: boolean;
  readonly checkoutRoot: string;
  readonly gatewayBundlePath: string;
}): Readonly<{
  checkoutRoot: string;
  gatewayBundlePath: string;
  policyVersion: typeof CONTEXT_GATEWAY_DEFAULT_POLICY_VERSION;
}> | null {
  const policyVersion = resolveProductionContextGatewayPolicyVersion(input);
  if (policyVersion === null) return null;
  return Object.freeze({
    checkoutRoot: input.checkoutRoot,
    gatewayBundlePath: input.gatewayBundlePath,
    policyVersion,
  });
}

type ProductionInvestigationControlPlanePort =
  ReviewInvestigationControlPlanePort &
    ReviewInvestigationReplayControlPlanePort;

export class LegacyFallbackBeforeInvestigationAuthorityControlPlane implements ProductionInvestigationControlPlanePort {
  constructor(
    private readonly delegate: ProductionInvestigationControlPlanePort
  ) {}

  open(input: Parameters<ReviewInvestigationControlPlanePort['open']>[0]) {
    return this.openWithLegacyFallback(() => this.delegate.open(input));
  }

  restore(
    input: Parameters<ReviewInvestigationControlPlanePort['restore']>[0]
  ) {
    return this.delegate.restore(input);
  }

  planTurn(
    input: Parameters<ReviewInvestigationControlPlanePort['planTurn']>[0]
  ) {
    return this.delegate.planTurn(input);
  }

  commitTurn(
    input: Parameters<ReviewInvestigationControlPlanePort['commitTurn']>[0]
  ) {
    return this.delegate.commitTurn(input);
  }

  abortTurn(
    input: Parameters<ReviewInvestigationControlPlanePort['abortTurn']>[0]
  ) {
    return this.delegate.abortTurn(input);
  }

  conclude(
    input: Parameters<ReviewInvestigationControlPlanePort['conclude']>[0]
  ) {
    return this.delegate.conclude(input);
  }

  prepareReplay(
    input: Parameters<
      ReviewInvestigationReplayControlPlanePort['prepareReplay']
    >[0]
  ) {
    return this.delegate.prepareReplay(input);
  }

  commitReceiptReplay(
    input: Parameters<
      ReviewInvestigationReplayControlPlanePort['commitReceiptReplay']
    >[0]
  ) {
    return this.delegate.commitReceiptReplay(input);
  }

  replay(
    input: Parameters<ReviewInvestigationReplayControlPlanePort['replay']>[0]
  ) {
    return this.delegate.replay(input);
  }

  private async openWithLegacyFallback<T>(
    execute: () => Promise<T>
  ): Promise<T> {
    try {
      return await execute();
    } catch (error) {
      if (
        error instanceof ReviewInvestigationControlPlaneError &&
        error.failureClass ===
          ReviewInvestigationControlPlaneFailureClass.CapabilityDisabled
      ) {
        throw new ReviewInvestigationLegacyFallbackSignal();
      }
      throw error;
    }
  }
}

function codexCredentialEnvironment(): Readonly<NodeJS.ProcessEnv> {
  return Object.freeze(
    Object.fromEntries(
      ['CODEX_HOME', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY']
        .map((key) => [key, process.env[key]] as const)
        .filter(
          (entry): entry is readonly [string, string] => entry[1] !== undefined
        )
    )
  );
}

function createConfiguredProductionInvestigationAgents(input: {
  readonly codexModel: string;
  readonly codexBinaryPath: string | undefined;
  readonly executionSessions: ReviewAgentExecutionSessionResolverPort;
}): readonly ConfiguredProductionReviewAgent[] {
  const processRunner = new NodeReviewAgentProcessRunner();
  return Object.freeze([
    {
      providerKind: ReviewAgentProviderKind.Codex,
      requestedModel: input.codexModel,
      agent: new CodexReviewAgentAdapter(processRunner, {
        executionSessions: input.executionSessions,
        providerCredentialEnvironment: codexCredentialEnvironment,
        ...(input.codexBinaryPath ? { binary: input.codexBinaryPath } : {}),
        reasoningEffort: 'xhigh',
      }),
    },
  ] satisfies readonly ConfiguredProductionReviewAgent[]);
}

export function mapOrchestrationResultToCodexOutcome(result: {
  readonly status: ReviewOrchestrationResultStatus;
  readonly failureCode?: string;
  readonly mergeGateConclusion?: MergeGateConclusion;
  readonly unavailablePublicationFacts?: readonly ReviewPublicationUnavailableFact[];
}): CodexOAuthV2ReviewResult {
  switch (result.status) {
    case ReviewOrchestrationResultStatus.Completed:
      return {
        outcome: CodexOAuthV2ReviewOutcome.Completed,
        mergeGateConclusion: requireMergeGateConclusion(
          result.mergeGateConclusion
        ),
      };
    case ReviewOrchestrationResultStatus.PartialCompleted:
      return {
        outcome: CodexOAuthV2ReviewOutcome.PartialCompleted,
        reason: mapPartialFailureReason(result.failureCode),
        ...(result.failureCode ? { blockingFailure: result.failureCode } : {}),
      };
    case ReviewOrchestrationResultStatus.PublicationNotApplied:
      return {
        outcome: CodexOAuthV2ReviewOutcome.PublicationNotApplied,
        reason: CodexOAuthV2TerminalReason.PublicationConflict,
        blockingFailure:
          result.failureCode ?? 'review_action_v2_publication_not_applied',
      };
    case ReviewOrchestrationResultStatus.PublicationStale:
      return {
        outcome: CodexOAuthV2ReviewOutcome.PublicationStale,
        reason: CodexOAuthV2TerminalReason.PublicationStale,
        blockingFailure:
          result.failureCode ?? 'review_action_v2_publication_stale',
      };
    case ReviewOrchestrationResultStatus.PublicationUnavailable:
      return {
        outcome: CodexOAuthV2ReviewOutcome.PublicationUnavailable,
        reason: CodexOAuthV2TerminalReason.PublicationFactsUnavailable,
        unavailableFacts: requireUnavailablePublicationFacts(
          result.unavailablePublicationFacts
        ),
        blockingFailure:
          result.failureCode ?? 'review_action_v2_publication_unavailable',
      };
    case ReviewOrchestrationResultStatus.Superseded:
      return { outcome: CodexOAuthV2ReviewOutcome.Superseded };
    case ReviewOrchestrationResultStatus.Cancelled:
      return { outcome: CodexOAuthV2ReviewOutcome.Cancelled };
    case ReviewOrchestrationResultStatus.Failed:
      return {
        outcome: CodexOAuthV2ReviewOutcome.Failed,
        reason: mapExecutionFailureReason(result.failureCode),
        blockingFailure:
          result.failureCode ?? `review_action_v2_${result.status}`,
      };
  }
}

function requireUnavailablePublicationFacts<T>(
  facts: readonly T[] | undefined
): readonly T[] {
  if (!facts || facts.length === 0) {
    throw new Error('review_orchestration_publication_facts_missing');
  }
  return facts;
}

function requireMergeGateConclusion(
  conclusion: MergeGateConclusion | undefined
): MergeGateConclusion {
  if (conclusion === undefined) {
    throw new Error('review_orchestration_merge_gate_conclusion_missing');
  }
  return conclusion;
}

export function mapRevisionGuardErrorToCodexOutcome(error: unknown):
  | {
      readonly outcome: CodexOAuthV2ReviewOutcome.Failed;
      readonly reason:
        | CodexOAuthV2TerminalReason.RevisionGuardUnavailable
        | CodexOAuthV2TerminalReason.RevisionGuardFailed;
      readonly blockingFailure: string;
    }
  | undefined {
  const code = error instanceof Error ? error.message : undefined;
  if (
    code !== 'review_action_v2_revision_guard_unavailable' &&
    code !== 'review_action_v2_revision_guard_failed'
  ) {
    return undefined;
  }
  return {
    outcome: CodexOAuthV2ReviewOutcome.Failed,
    reason:
      code === 'review_action_v2_revision_guard_unavailable'
        ? CodexOAuthV2TerminalReason.RevisionGuardUnavailable
        : CodexOAuthV2TerminalReason.RevisionGuardFailed,
    blockingFailure: code,
  };
}

function mapPartialFailureReason(
  failureCode: string | undefined
):
  | CodexOAuthV2TerminalReason.RequiredReviewCoverageIncomplete
  | CodexOAuthV2TerminalReason.RequiredProviderLaneBusy
  | CodexOAuthV2TerminalReason.RequiredWorkExhausted
  | CodexOAuthV2TerminalReason.RequiredInvestigationDeferred
  | CodexOAuthV2TerminalReason.Unknown {
  switch (failureCode) {
    case undefined:
    case 'required_review_coverage_incomplete':
      return CodexOAuthV2TerminalReason.RequiredReviewCoverageIncomplete;
    case 'required_provider_lane_busy':
      return CodexOAuthV2TerminalReason.RequiredProviderLaneBusy;
    case 'required_work_exhausted':
      return CodexOAuthV2TerminalReason.RequiredWorkExhausted;
    case 'required_investigation_deferred':
      return CodexOAuthV2TerminalReason.RequiredInvestigationDeferred;
    case 'required_execution_deadline_reached':
      return CodexOAuthV2TerminalReason.RequiredWorkExhausted;
    default:
      return CodexOAuthV2TerminalReason.Unknown;
  }
}

function mapExecutionFailureReason(
  failureCode: string | undefined
):
  | CodexOAuthV2TerminalReason.ProviderCapacityUnavailable
  | CodexOAuthV2TerminalReason.ExecutionFailed
  | CodexOAuthV2TerminalReason.Unknown {
  if (failureCode === 'provider_capacity_unavailable') {
    return CodexOAuthV2TerminalReason.ProviderCapacityUnavailable;
  }
  return failureCode
    ? CodexOAuthV2TerminalReason.ExecutionFailed
    : CodexOAuthV2TerminalReason.Unknown;
}

export function createScmReadTokenProvider(input: {
  readonly token: string;
  readonly expiresAt: string;
  readonly refresh: () => Promise<{
    readonly token: string;
    readonly expiresAt: string;
  }>;
}): GitHubTokenProvider {
  let capability = validateScmReadCapability({
    token: input.token,
    expiresAt: input.expiresAt,
  });

  let refreshInFlight: Promise<string> | undefined;
  const refresh = async (): Promise<string> => {
    if (refreshInFlight) return await refreshInFlight;
    refreshInFlight = (async () => {
      let refreshed: { readonly token: string; readonly expiresAt: string };
      try {
        refreshed = await input.refresh();
      } catch (error) {
        if (isScmReadCapabilityFailure(error)) {
          throw new Error('review_action_v2_revision_guard_failed', {
            cause: error,
          });
        }
        throw new Error('review_action_v2_revision_guard_unavailable', {
          cause: error,
        });
      }
      let validated: { readonly token: string; readonly expiresAt: string };
      try {
        validated = validateScmReadCapability(refreshed);
      } catch (error) {
        throw new Error('review_action_v2_revision_guard_failed', {
          cause: error,
        });
      }
      if (
        Date.parse(validated.expiresAt) <=
        Date.now() + SCM_READ_TOKEN_EXPIRY_MARGIN_MS
      ) {
        throw new Error('review_action_v2_revision_guard_unavailable');
      }
      capability = validated;
      return capability.token;
    })();
    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = undefined;
    }
  };
  return {
    async getToken() {
      return Date.parse(capability.expiresAt) <=
        Date.now() + SCM_READ_TOKEN_EXPIRY_MARGIN_MS
        ? await refresh()
        : capability.token;
    },
    refreshToken: refresh,
  };
}

function isScmReadCapabilityFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (
    error.message === 'review_action_v2_scm_read_token_scope_invalid' ||
    error.message === 'review_action_v2_scm_read_token_invalid' ||
    error.message === 'codex_oauth_control_plane_invalid_response'
  ) {
    return true;
  }
  const statusMatch = error.message.match(
    /^codex_oauth_control_plane_error:(\d{3}):/
  );
  if (!statusMatch) return false;
  const status = Number(statusMatch[1]);
  return status >= 400 && status <= 499 && status !== 408 && status !== 429;
}

function validateScmReadCapability(input: {
  readonly token: string;
  readonly expiresAt: string;
}): { readonly token: string; readonly expiresAt: string } {
  if (
    input.token.length === 0 ||
    !Number.isFinite(Date.parse(input.expiresAt))
  ) {
    throw new Error('review_action_v2_scm_read_token_invalid');
  }
  return Object.freeze({ ...input });
}

function resolveContextGatewayBundlePath(): string {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    throw new Error('review_action_v2_runtime_entrypoint_missing');
  }
  return path.join(
    path.dirname(path.resolve(entrypoint)),
    'context-gateway.js'
  );
}

export function createProductionT0ReviewRunner(
  input: {
    readonly fetchImpl?: typeof fetch;
    readonly progress?: import('../application/run-t0-review-orchestration').ReviewOrchestrationProgressPort;
  } = {}
): CodexOAuthV2ReviewRunnerPort {
  return new ProductionT0ReviewRunner(input.fetchImpl, input.progress);
}

export function planAssignments(input: {
  readonly authorization: ReviewRunAuthorization;
  readonly pr: PRContext;
  readonly config: ReviewConfig;
  readonly providerName: string;
  readonly compatibilityKey: string;
  readonly lifecycleTargets: readonly LifecycleTarget[];
  readonly liveLifecycleStateHash: string;
}): {
  readonly plan: ReturnType<typeof createStableReviewWorkPlan>;
  readonly assignments: readonly CodexReviewAssignment[];
  readonly uncoveredPaths: readonly string[];
  readonly uncoveredLifecycleTargetIds: readonly string[];
} {
  const codexLanes = input.authorization.facts.providerVoteLanes.filter(
    (lane) => lane.providerKind === ReviewExecutionProviderKind.Codex
  );
  if (codexLanes.length !== 1) {
    throw new Error('review_action_v2_codex_vote_lane_ambiguous');
  }
  const maxSlots = input.authorization.limits.maxWorkSlots;
  const batcher = new BatchOrchestrator({
    defaultBatchSize: input.config.batchMaxFiles ?? 20,
    providerOverrides: input.config.providerBatchOverrides,
    maxBatchSize: input.config.batchMaxFiles ?? 200,
    enableTokenAwareBatching: input.config.enableTokenAwareBatching,
    targetTokensPerBatch: input.config.targetTokensPerBatch,
    maxFullFileBytes: input.config.maxFullDiffFileBytes,
    maxFullFileChanges: input.config.maxFullDiffFileChanges,
  });
  const files = prioritizeFilesByRisk(input.pr.files);
  const tokenSafeBatches = batcher.createTokenAwareBatches(files, [
    input.providerName,
  ]);
  const allBatches = tokenSafeBatches.length === 0 ? [[]] : tokenSafeBatches;
  const batches = allBatches.slice(0, maxSlots);
  const uncoveredPaths = Object.freeze(
    allBatches
      .slice(maxSlots)
      .flatMap((batch) => batch.map((file) => file.filename))
      .sort()
  );

  const plannedBatches: Array<{
    readonly batchId: string;
    readonly taskKind: ReviewTaskKind;
    readonly required: boolean;
    readonly files: readonly FileChange[];
    readonly lifecycleTargets: readonly LifecycleTarget[];
  }> = batches.map((batch) => {
    const lifecycleTargets = input.lifecycleTargets.filter((target) =>
      batch.some(
        (file) =>
          target.currentPath === file.filename ||
          target.originalPath === file.filename
      )
    );
    return {
      batchId: createStableReviewBatchId({
        taskKind: ReviewTaskKind.FindingDiscovery,
        members: batch,
      }),
      taskKind: ReviewTaskKind.FindingDiscovery,
      required: true,
      files: batch,
      lifecycleTargets,
    };
  });
  const assignedLifecycleTargetIds = new Set(
    plannedBatches.flatMap((batch) =>
      batch.lifecycleTargets.map((target) => target.targetId)
    )
  );
  const uncoveredLifecycleTargetIds = Object.freeze(
    input.lifecycleTargets
      .filter((target) => !assignedLifecycleTargetIds.has(target.targetId))
      .map((target) => target.targetId)
      .sort()
  );

  const attemptBudget = resolveT0AttemptBudget(
    input.config.providerRetries,
    input.authorization.limits.maxAttemptsPerSlot
  );
  const plan = createStableReviewWorkPlan({
    reviewRevisionHash: input.authorization.facts.reviewRevisionHash,
    compatibilityKey: input.compatibilityKey,
    providers: [
      {
        providerName: input.providerName,
        providerKind: ReviewExecutionProviderKind.Codex,
        providerVoteIdentityHash: codexLanes[0].providerVoteIdentityHash,
        required: true,
        attemptBudget,
        retryPolicyVersion: CODEX_RETRY_POLICY_VERSION,
      },
    ],
    batches: plannedBatches.map((batch, schedulingOrdinal) => ({
      batchId: batch.batchId,
      taskKind: batch.taskKind,
      required: batch.required,
      paths: batch.files.map((file) => file.filename),
      schedulingOrdinal,
    })),
    eligiblePaths: files.map((file) => file.filename),
    uncoveredPaths,
    excludedPaths: [],
    maxWorkSlots: maxSlots,
    maxAttemptsPerSlot: input.authorization.limits.maxAttemptsPerSlot,
  });
  const byBatchId = new Map(
    plannedBatches.map((batch) => [batch.batchId, batch])
  );
  const assignments = plan.assignments.map((assignment) => {
    const batch = byBatchId.get(assignment.batchId);
    if (!batch) throw new Error('review_action_v2_planned_batch_missing');
    return Object.freeze({
      workSlot: assignment.workSlot,
      reviewRevisionHash: input.authorization.facts.reviewRevisionHash,
      mergeBaseSha: input.authorization.facts.mergeBaseSha,
      context: batchContext(input.pr, batch.files),
      lifecycleTargets: Object.freeze([...batch.lifecycleTargets]),
      liveLifecycleStateHash: input.liveLifecycleStateHash,
    });
  });
  return Object.freeze({
    plan,
    assignments: Object.freeze(assignments),
    uncoveredPaths,
    uncoveredLifecycleTargetIds,
  });
}

export function resolveT0AttemptBudget(
  configuredTotalAttempts: number | undefined,
  protocolMaximum: number
): number {
  if (!Number.isSafeInteger(protocolMaximum) || protocolMaximum < 1) {
    throw new Error('review_action_v2_attempt_budget_limit_invalid');
  }
  return Math.min(
    protocolMaximum,
    getProviderReviewTotalAttempts(configuredTotalAttempts)
  );
}

function batchContext(pr: PRContext, files: readonly FileChange[]): PRContext {
  const recovered = recoverDiffForFiles(pr.diff, files);
  return {
    ...pr,
    files: [...files],
    diff: recovered.diff,
  };
}

function selectCodexProvider(config: ReviewConfig): string {
  const providers = [
    ...config.providers,
    ...(config.synthesisModel ? [config.synthesisModel] : []),
  ];
  const selected = providers.find((provider) => provider.startsWith('codex/'));
  if (!selected || selected.length <= 'codex/'.length) {
    throw new Error('review_action_v2_codex_provider_missing');
  }
  return selected;
}

async function applyReviewRuntimeConfig(
  input: Parameters<CodexOAuthV2ReviewRunnerPort['run']>[0],
  fetchImpl: typeof fetch,
  oidc: GitHubActionsOidcTokenProvider
): Promise<void> {
  process.env.REVIEWROUTER_RUNTIME_CONFIG_MODE = 'oidc';
  process.env.REVIEWROUTER_API_URL = input.apiUrl;
  process.env.REVIEWROUTER_OIDC_AUDIENCE = input.audience;
  process.env.REVIEWROUTER_STATIC_CONFIG_FALLBACK = 'false';
  await applyControlPlaneRuntimeConfig({
    fetchImpl,
    oidc,
    logger: {
      info: core.info,
      warn: (message) => core.warning(message),
    },
  });
}

async function withRunnerEnvironment<T>(
  input: Parameters<CodexOAuthV2ReviewRunnerPort['run']>[0],
  operation: () => Promise<T>
): Promise<T> {
  const previousCwd = process.cwd();
  const previous = new Map<string, string | undefined>();
  const set = (key: string, value: string) => {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  };
  set('CODEX_HOME', input.codexHome);
  set('CODEX_HEALTHCHECK_MODE', 'binary');
  set('REVIEW_ROUTER_PROGRESS_COMMENTS', 'never');
  set('GITHUB_REPOSITORY', input.repository);
  set('REVIEWROUTER_HEAD_SHA', input.headSha.toLowerCase());
  if (input.codexBinaryPath) {
    set('REVIEWROUTER_CODEX_BINARY', input.codexBinaryPath);
    set(
      'PATH',
      `${path.dirname(input.codexBinaryPath)}${path.delimiter}${process.env.PATH ?? ''}`
    );
  }
  try {
    process.chdir(input.workspacePath);
    return await operation();
  } finally {
    if (process.cwd() !== previousCwd) process.chdir(previousCwd);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function validateInput(
  input: Parameters<CodexOAuthV2ReviewRunnerPort['run']>[0]
): void {
  validateScmReadCapability({
    token: input.scmReadToken,
    expiresAt: input.scmReadTokenExpiresAt,
  });
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) {
    throw new Error('review_action_v2_repository_invalid');
  }
}

function validateAuthorizationInput(
  input: Parameters<CodexOAuthV2ReviewRunnerPort['run']>[0],
  authorization: ReviewRunAuthorization
): void {
  if (
    authorization.facts.pullRequestNumber !== input.pullRequestNumber ||
    authorization.facts.headSha !== input.headSha.toLowerCase() ||
    authorization.facts.producerReleaseId !== authorization.producerReleaseId
  ) {
    throw new Error('review_action_v2_authorization_input_mismatch');
  }
}

function sameAuthorizedRevision(
  revision: {
    readonly baseSha: string;
    readonly mergeBaseSha: string;
    readonly headSha: string;
    readonly reviewRevisionHash: string;
  },
  authorization: ReviewRunAuthorization
): boolean {
  return (
    revision.baseSha === authorization.facts.baseSha &&
    revision.mergeBaseSha === authorization.facts.mergeBaseSha &&
    revision.headSha === authorization.facts.headSha &&
    revision.reviewRevisionHash === authorization.facts.reviewRevisionHash
  );
}

async function readCheckedOutHead(workspacePath: string): Promise<string> {
  const result = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: workspacePath,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
  const head = result.stdout.trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(head)) {
    throw new Error('review_action_v2_checked_out_head_invalid');
  }
  return head;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
