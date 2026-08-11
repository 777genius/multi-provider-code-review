import { createHash } from 'crypto';
import { PromptBuilder } from '../../analysis/llm/prompt-builder';
import {
  canonicalizeProviderInvocationManifestV1,
  providerInvocationManifestV1CanonicalizerDescriptor,
  providerInvocationIdentityPreimageV1,
  serializeProviderInvocationManifestV1CanonicalWireJson,
} from '../../control-plane/generated/review-action-v2/provider-invocation-manifest-v1';
import { CodexProvider } from '../../providers/codex';
import {
  PROVIDER_EXECUTION_CONTRACT_VERSION,
  type PreparedProviderInvocation,
} from '../../providers/prepared-invocation';
import type { LifecycleTarget, PRContext, ReviewConfig } from '../../types';
import { logger } from '../../utils/logger';
import { emitReviewInvestigationTelemetry } from './review-investigation-telemetry';
import {
  ReviewContextInspectionFailure,
  ReviewContextInspectionFailureReason,
  ReviewExecutionProviderKind,
  ReviewTaskKind,
  RetryableReviewContextInspectionFailure,
  type PreparedReviewInvocation,
  type PreparedReviewInvocationPort,
  type ProviderInvocationManifestAssemblerPort,
  type ReviewInvocationLeaseSupervisorPort,
  type ReviewInvocationLease,
  type ReviewOrchestrationDelayPort,
  type ReviewOrchestrationIdentityPort,
  type ReviewRunAuthorization,
  type ReviewWorkSlotPlan,
} from '../application';
import {
  createProviderVisibleReviewCoverage,
  createReviewPromptCoverageManifest,
  serializeProviderVisibleReviewCoverage,
} from '../domain';
import { normalizeReviewObservation } from './review-observation-normalizer';
import { ContextGatewayLeaseAuthorityKind } from '../../context-gateway/context-gateway-lease-authority';
import type { ContextGatewayInvocationSessionFactoryPort } from './context-gateway-invocation-session';
import { buildReviewAgentTurnOutputSchema } from '../../review-investigation/domain/turn-observation';
import {
  REVIEW_INVESTIGATION_PROBE_POLICY_VERSION,
  REVIEW_INVESTIGATION_SEARCH_POLICY_VERSION,
  ReviewInvestigationProbePlanStatus,
} from '../../review-investigation/domain/deterministic-context-probe-plan';
import { buildReviewInvestigationSeedEnvelope } from '../../review-investigation/domain/review-investigation-seed-envelope';
import { REVIEW_INVESTIGATION_TURN_PROMPT_CONTRACT_HASH } from '../../review-investigation/application/review-investigation-turn-prompt';

export type CodexReviewAssignment = {
  readonly workSlot: ReviewWorkSlotPlan;
  readonly reviewRevisionHash: string;
  readonly mergeBaseSha: string;
  readonly context: PRContext;
  readonly lifecycleTargets: readonly LifecycleTarget[];
  readonly liveLifecycleStateHash: string;
};

export class CodexReviewInvocationAdapter implements PreparedReviewInvocationPort {
  private readonly assignments = new Map<string, CodexReviewAssignment>();
  private readonly prepared = new WeakMap<
    object,
    Readonly<{
      prompt: string;
      assignment: CodexReviewAssignment;
    }>
  >();

  constructor(
    private readonly provider: CodexProvider,
    private readonly promptBuilder: PromptBuilder,
    assignments: readonly CodexReviewAssignment[],
    private readonly timeoutMs: number,
    private readonly agenticContext: boolean,
    private readonly contextGateway?: ContextGatewayInvocationSessionFactoryPort,
    private readonly investigationManifestBindingEnabled = false
  ) {
    for (const assignment of assignments) {
      if (this.assignments.has(assignment.workSlot.workSlotId)) {
        throw new Error('review_action_v2_assignment_duplicate');
      }
      this.assignments.set(assignment.workSlot.workSlotId, assignment);
    }
  }

  async prepare(input: {
    readonly workSlot: ReviewWorkSlotPlan;
    readonly attemptOrdinal: number;
  }): Promise<PreparedReviewInvocation> {
    const assignment = this.assignments.get(input.workSlot.workSlotId);
    if (!assignment || assignment.workSlot !== input.workSlot) {
      throw new Error('review_action_v2_assignment_missing');
    }
    const preparedPrompt = await this.promptBuilder.buildPreparedV2(
      assignment.context,
      assignment.context.number,
      [...assignment.lifecycleTargets]
    );
    const coverageManifest = createReviewPromptCoverageManifest({
      workSlotId: input.workSlot.workSlotId,
      reviewRevisionHash: assignment.reviewRevisionHash,
      assignedPaths: assignment.context.files.map((file) => file.filename),
      pathCoverage: preparedPrompt.pathCoverage,
    });
    const providerVisibleCoverage =
      createProviderVisibleReviewCoverage(coverageManifest);
    const coverageCanonicalJson = serializeProviderVisibleReviewCoverage(
      providerVisibleCoverage
    );
    const prompt = `${preparedPrompt.prompt}\n\nREVIEWROUTER_COVERAGE_MANIFEST_V3_BASE64URL:${Buffer.from(
      coverageCanonicalJson,
      'utf8'
    ).toString('base64url')}`;
    const investigationContextPrompt = `${preparedPrompt.investigationContextPrompt}\n\nREVIEWROUTER_COVERAGE_MANIFEST_V3_BASE64URL:${Buffer.from(
      coverageCanonicalJson,
      'utf8'
    ).toString('base64url')}`;
    const revision = Object.freeze({
      baseSha: assignment.context.baseSha,
      mergeBaseSha: assignment.mergeBaseSha,
      headSha: assignment.context.headSha,
    });
    const shouldPrepareInvestigationSeed =
      this.investigationManifestBindingEnabled &&
      preparedPrompt.investigationProbePlan.status ===
        ReviewInvestigationProbePlanStatus.Complete &&
      assignment.lifecycleTargets.length === 0;
    const [gatewayPlanningConfig, canonicalInventory] = this.contextGateway
      ? await Promise.all([
          this.contextGateway.planningConfig(revision),
          shouldPrepareInvestigationSeed
            ? this.contextGateway.canonicalInventory(revision)
            : Promise.resolve(undefined),
        ])
      : [undefined, undefined];
    const prepared = await this.provider.prepareInvocation(
      prompt,
      this.timeoutMs,
      undefined,
      gatewayPlanningConfig
    );
    this.prepared.set(
      prepared as object,
      Object.freeze({ prompt, assignment })
    );
    const request = prepared.request as Readonly<Record<string, unknown>>;
    const taskKindSet = Object.freeze(
      Array.from(
        new Set([
          input.workSlot.taskKind,
          ...(assignment.lifecycleTargets.length > 0
            ? [ReviewTaskKind.LifecycleRevalidation]
            : []),
        ])
      ).sort()
    ) as readonly ReviewTaskKind[];
    const probePlanComplete =
      preparedPrompt.investigationProbePlan.status ===
      ReviewInvestigationProbePlanStatus.Complete;
    const investigationEligible =
      this.investigationManifestBindingEnabled &&
      gatewayPlanningConfig !== undefined &&
      probePlanComplete &&
      !taskKindSet.includes(ReviewTaskKind.LifecycleRevalidation);
    const investigationContract = investigationEligible
      ? canonicalJson({
          adapterVersion: 'review-investigation-codex.v3',
          actualModelAttribution: 'observed',
          confinement: 'gateway_only',
          continuation: 'durable_dossier',
          gatewayBinaryHash: gatewayPlanningConfig.gatewayBinaryHash,
          gatewayPolicyVersion: gatewayPlanningConfig.gatewayPolicyVersion,
          enabledTools: [...gatewayPlanningConfig.enabledTools].sort(),
          probeLimits: preparedPrompt.investigationProbePlan.limits,
          probePolicyVersion: REVIEW_INVESTIGATION_PROBE_POLICY_VERSION,
          reasoningEffort: 'xhigh',
          requestedModel: prepared.requestedModel,
          searchPolicyVersion: REVIEW_INVESTIGATION_SEARCH_POLICY_VERSION,
          turnPromptContractHash:
            REVIEW_INVESTIGATION_TURN_PROMPT_CONTRACT_HASH,
        })
      : null;
    const investigationSeedEnvelope = investigationEligible
      ? buildReviewInvestigationSeedEnvelope({
          coverageManifest,
          canonicalInventory,
          probePlan: preparedPrompt.investigationProbePlan,
          reviewPrompt: investigationContextPrompt,
          requestedModel: prepared.requestedModel,
        })
      : null;
    return Object.freeze({
      workSlotId: input.workSlot.workSlotId,
      attemptOrdinal: input.attemptOrdinal,
      provider: prepared.providerName,
      requestedModel: prepared.requestedModel,
      reviewPrompt: prompt,
      investigationContextPrompt: investigationEligible
        ? investigationContextPrompt
        : null,
      immutableRequest: prepared,
      coverageManifest,
      investigationProbePlan: preparedPrompt.investigationProbePlan,
      investigationSeedEnvelope,
      manifestFacts: Object.freeze({
        taskKindSet,
        providerKind: ReviewExecutionProviderKind.Codex,
        providerCapabilityHash: sha256(
          investigationContract ??
            canonicalJson({
              agenticContext: this.agenticContext,
              contextGateway: gatewayPlanningConfig
                ? {
                    gatewayBinaryHash: gatewayPlanningConfig.gatewayBinaryHash,
                    gatewayPolicyVersion:
                      gatewayPlanningConfig.gatewayPolicyVersion,
                    enabledTools: [
                      ...gatewayPlanningConfig.enabledTools,
                    ].sort(),
                  }
                : null,
              preparedInvocationContract: PROVIDER_EXECUTION_CONTRACT_VERSION,
              providerKind: prepared.providerKind,
            })
        ),
        providerRequestEnvelopeHash: investigationSeedEnvelope
          ? investigationSeedEnvelope.hash
          : sha256(prepared.observableInputPreimage),
        outputSchemaHash: sha256(
          canonicalJson(
            investigationEligible
              ? buildReviewAgentTurnOutputSchema()
              : (request.outputSchema ?? null)
          )
        ),
        filePatchManifestHash: sha256(
          canonicalJson(
            assignment.context.files.map((file) => ({
              additions: file.additions,
              changes: file.changes,
              deletions: file.deletions,
              filename: file.filename,
              patch: file.patch ?? null,
              previousFilename: file.previousFilename ?? null,
              status: file.status,
            }))
          )
        ),
        contextManifestHash: sha256(
          canonicalJson({
            author: assignment.context.author,
            body: assignment.context.body,
            coverageHash: providerVisibleCoverage.coverageHash,
            lifecycleTargetIds: assignment.lifecycleTargets
              .map((target) => target.targetId)
              .sort(),
            investigationProbePlanHash:
              preparedPrompt.investigationProbePlan.planHash,
            investigationProbePlanStatus:
              preparedPrompt.investigationProbePlan.status,
            number: assignment.context.number,
            title: assignment.context.title,
          })
        ),
        lifecycleTargetSetHash:
          assignment.lifecycleTargets.length > 0
            ? sha256(
                canonicalJson(
                  assignment.lifecycleTargets
                    .map((target) => ({
                      fingerprint: target.fingerprint,
                      targetId: target.targetId,
                    }))
                    .sort((left, right) =>
                      compareCodeUnits(left.targetId, right.targetId)
                    )
                )
              )
            : null,
        liveLifecycleStateHash:
          assignment.lifecycleTargets.length > 0
            ? assignment.liveLifecycleStateHash
            : null,
        toolPolicyHash: sha256(
          canonicalJson(
            gatewayPlanningConfig
              ? {
                  sandbox: 'read-only',
                  network: false,
                  workspaceMutation: false,
                  builtinTools: false,
                  mcpTransport: 'stdio',
                  gatewayBinaryHash: gatewayPlanningConfig.gatewayBinaryHash,
                  gatewayPolicyVersion:
                    gatewayPlanningConfig.gatewayPolicyVersion,
                  textSearchMatchMode: 'fixed_string',
                  enabledTools: [...gatewayPlanningConfig.enabledTools].sort(),
                }
              : {
                  sandbox: 'read-only',
                  network: 'provider-controlled',
                  workspaceMutation: false,
                }
          )
        ),
        executionProfile: gatewayPlanningConfig
          ? investigationEligible
            ? 'investigation_gateway_v1'
            : 'context_gateway_v1'
          : this.agenticContext
            ? 'agentic_unbounded_v1'
            : 'prompt_only_envelope_v1',
        baseTreeHash: gatewayPlanningConfig
          ? sha256(
              gatewayPlanningConfig.runtimeEnvironment
                .REVIEWROUTER_CONTEXT_CHECKOUT_TREE_OID!
            )
          : null,
        environmentContractHash: sha256(
          investigationEligible
            ? canonicalJson({
                credentialKeys: [
                  'CODEX_HOME',
                  'OPENAI_API_KEY',
                  'OPENROUTER_API_KEY',
                ],
                gitConfigGlobal: '/dev/null',
                gitConfigNoSystem: '1',
                userConfig: 'ignored',
              })
            : canonicalJson(
                this.provider.describePreparedEnvironmentContract(prepared)
              )
        ),
      }),
    });
  }

  async execute(input: {
    readonly invocation: PreparedReviewInvocation;
    readonly manifest: import('../application').ProviderInvocationManifest;
    readonly lease: ReviewInvocationLease;
    readonly sourceExecutionId: string;
    readonly sourceReviewRevisionHash: string;
    readonly signal: AbortSignal;
  }) {
    const prepared = input.invocation
      .immutableRequest as PreparedProviderInvocation;
    if (
      !prepared ||
      typeof prepared !== 'object' ||
      !this.prepared.has(prepared as object) ||
      prepared.providerName !== input.invocation.provider ||
      prepared.requestedModel !== input.invocation.requestedModel
    ) {
      throw new Error('review_action_v2_prepared_invocation_identity_mismatch');
    }
    const preparedFacts = this.prepared.get(prepared as object)!;
    if (!this.contextGateway) {
      const result = await this.provider.executePreparedInvocation(
        prepared,
        undefined,
        input.signal
      );
      return normalizeReviewObservation({
        workSlotId: input.invocation.workSlotId,
        attemptOrdinal: input.invocation.attemptOrdinal,
        providerName: input.invocation.provider,
        requestedModel: input.invocation.requestedModel,
        result,
      });
    }

    const session = await this.contextGateway.open({
      invocationLease: input.lease,
      leaseAuthorityKind: ContextGatewayLeaseAuthorityKind.StandardExecution,
      sourceExecutionId: input.sourceExecutionId,
      sourceWorkSlotId: input.invocation.workSlotId,
      sourceReviewRevisionHash: input.sourceReviewRevisionHash,
      providerKind: input.invocation.manifestFacts.providerKind,
      requestedModel: input.invocation.requestedModel,
      executionProfile: input.invocation.manifestFacts.executionProfile,
      providerInvocationKey: input.manifest.providerInvocationKey,
      toolPolicyHash: input.invocation.manifestFacts.toolPolicyHash,
      revision: {
        baseSha: preparedFacts.assignment.context.baseSha,
        mergeBaseSha: preparedFacts.assignment.mergeBaseSha,
        headSha: preparedFacts.assignment.context.headSha,
      },
    });
    let observation: ReturnType<typeof normalizeReviewObservation> | undefined;
    let invocationError: unknown;
    let invocationFailed = false;
    try {
      const runtimePrepared = await this.provider.prepareInvocation(
        preparedFacts.prompt,
        prepared.timeoutMs,
        undefined,
        session.providerConfig
      );
      if (
        runtimePrepared.observableInputPreimage !==
        prepared.observableInputPreimage
      ) {
        throw new Error(
          'review_action_v2_context_gateway_materialization_drift'
        );
      }
      const result = await this.provider.executePreparedInvocation(
        runtimePrepared,
        session.credentialLease,
        input.signal
      );
      logger.info(
        `Codex execution model: requested=${input.invocation.requestedModel}, actual=${
          result.actualModel ?? 'unreported'
        }`
      );
      const initial = normalizeReviewObservation({
        workSlotId: input.invocation.workSlotId,
        attemptOrdinal: input.invocation.attemptOrdinal,
        providerName: input.invocation.provider,
        requestedModel: input.invocation.requestedModel,
        result,
        qualityFlags: result.actualModel ? [] : ['provider_warning'],
      });
      const actualModel = result.actualModel;
      if (!actualModel) {
        logger.warn(
          'Codex actual model unavailable; retrying because context attestation cannot be bound'
        );
        throw new RetryableReviewContextInspectionFailure(
          ReviewContextInspectionFailureReason.GatewayOutputUnavailable,
          normalizeReviewObservation({
            workSlotId: input.invocation.workSlotId,
            attemptOrdinal: input.invocation.attemptOrdinal,
            providerName: input.invocation.provider,
            requestedModel: input.invocation.requestedModel,
            result,
            qualityFlags: [
              'provider_warning',
              'context_attestation_unavailable',
              'cross_revision_reuse_disabled',
            ],
          })
        );
      }

      try {
        const attestation = await session.seal({
          actualModel,
          terminalOutcomeHash: initial.payloadHash,
        });
        if (!attestation) {
          throw new RetryableReviewContextInspectionFailure(
            ReviewContextInspectionFailureReason.GatewayOutputUnavailable,
            normalizeReviewObservation({
              workSlotId: input.invocation.workSlotId,
              attemptOrdinal: input.invocation.attemptOrdinal,
              providerName: input.invocation.provider,
              requestedModel: input.invocation.requestedModel,
              result,
              qualityFlags: [
                'context_attestation_unavailable',
                'cross_revision_reuse_disabled',
              ],
            })
          );
        }
        logger.info(
          'Context attestation sealed; fresh evidence is cross-revision reusable'
        );
        observation = normalizeReviewObservation({
          workSlotId: input.invocation.workSlotId,
          attemptOrdinal: input.invocation.attemptOrdinal,
          providerName: input.invocation.provider,
          requestedModel: input.invocation.requestedModel,
          result,
          qualityFlags: [],
          contextDependencyAttestation: attestation,
        });
      } catch (error) {
        if (error instanceof RetryableReviewContextInspectionFailure) {
          throw error;
        }
        if (error instanceof ReviewContextInspectionFailure) {
          const currentRevisionObservation = normalizeReviewObservation({
            workSlotId: input.invocation.workSlotId,
            attemptOrdinal: input.invocation.attemptOrdinal,
            providerName: input.invocation.provider,
            requestedModel: input.invocation.requestedModel,
            result,
            qualityFlags: [
              'context_inspection_incomplete',
              'cross_revision_reuse_disabled',
            ],
          });
          logger.warn(
            `Context inspection incomplete (${error.reason}${error.stage ? `, stage=${error.stage}` : ''}); fresh evidence is not cross-revision reusable`
          );
          throw new RetryableReviewContextInspectionFailure(
            error.reason,
            currentRevisionObservation
          );
        }
        logger.warn(
          `Context attestation sealing failed${safeFailureDiagnostic(error)}; retrying without committing unattested evidence`
        );
        throw new RetryableReviewContextInspectionFailure(
          ReviewContextInspectionFailureReason.GatewayOutputUnavailable,
          normalizeReviewObservation({
            workSlotId: input.invocation.workSlotId,
            attemptOrdinal: input.invocation.attemptOrdinal,
            providerName: input.invocation.provider,
            requestedModel: input.invocation.requestedModel,
            result,
            qualityFlags: [
              'context_attestation_unavailable',
              'cross_revision_reuse_disabled',
            ],
          })
        );
      }
    } catch (error) {
      invocationFailed = true;
      invocationError = error;
    }
    let cleanupError: unknown;
    try {
      await session.dispose();
    } catch (error) {
      cleanupError = error;
    }
    if (invocationFailed) {
      if (cleanupError !== undefined) {
        logger.warn(
          `Context gateway cleanup failed after the invocation failure${safeFailureDiagnostic(
            cleanupError
          )}`
        );
      }
      throw invocationError;
    }
    if (cleanupError !== undefined) throw cleanupError;
    if (!observation) {
      throw new Error('review_action_v2_context_gateway_observation_missing');
    }
    return observation;
  }
}

export class GeneratedProviderInvocationManifestAssembler implements ProviderInvocationManifestAssemblerPort {
  private readonly scopeHash: string;
  private readonly reviewConfigHash: string;

  constructor(
    private readonly authorization: ReviewRunAuthorization,
    reviewConfig: ReviewConfig,
    private readonly runtimeCompatibilityKey: string
  ) {
    this.scopeHash = sha256(
      canonicalJson({
        pullRequestNumber: authorization.facts.pullRequestNumber,
        repositoryConnectionId: authorization.facts.repositoryConnectionId,
        scmRepositoryIdentityId: authorization.facts.scmRepositoryIdentityId,
        workspaceId: authorization.facts.workspaceId,
      })
    );
    this.reviewConfigHash = sha256(canonicalJson(reviewConfig));
  }

  async assemble(invocation: PreparedReviewInvocation) {
    const facts = invocation.manifestFacts;
    const manifestInput = {
      manifestVersion: 1 as const,
      scopeHash: this.scopeHash,
      taskKindSet: facts.taskKindSet,
      providerKind: facts.providerKind,
      providerCapabilityHash: facts.providerCapabilityHash,
      requestedModel: invocation.requestedModel,
      providerPolicyVersion: 'codex-provider-policy.v2-t0',
      producerReleaseId: this.authorization.facts.producerReleaseId,
      selectedProtocolVersion: this.authorization.facts.selectedProtocolVersion,
      providerRequestEnvelopeHash: facts.providerRequestEnvelopeHash,
      outputSchemaHash: facts.outputSchemaHash,
      reviewConfigHash: this.reviewConfigHash,
      runtimeCompatibilityKey: this.runtimeCompatibilityKey,
      filePatchManifestHash: facts.filePatchManifestHash,
      contextManifestHash: facts.contextManifestHash,
      memoryBundleHash: null,
      codeGraphProjectionHash: null,
      lifecycleTargetSetHash: facts.lifecycleTargetSetHash,
      liveLifecycleStateHash: facts.liveLifecycleStateHash,
      toolPolicyHash: facts.toolPolicyHash,
      executionProfile: facts.executionProfile,
      baseTreeHash: facts.baseTreeHash,
      environmentContractHash: facts.environmentContractHash,
    };
    const manifestKey = sha256Bytes(
      canonicalizeProviderInvocationManifestV1(manifestInput)
    );
    const lane = this.authorization.facts.providerVoteLanes.find(
      (candidate) => candidate.providerKind === facts.providerKind
    );
    if (!lane) throw new Error('review_action_v2_provider_vote_lane_missing');
    const providerInvocationKey = sha256Bytes(
      providerInvocationIdentityPreimageV1(
        manifestKey,
        lane.providerVoteIdentityHash
      )
    );
    emitReviewInvestigationTelemetry(
      [
        'Review invocation manifest:',
        `manifestKey=${digestPrefix(manifestKey)}`,
        `providerInvocationKey=${digestPrefix(providerInvocationKey)}`,
        `providerVoteIdentityHash=${digestPrefix(
          lane.providerVoteIdentityHash
        )}`,
        ...Object.entries(manifestInput).map(
          ([component, value]) =>
            `${component}=${manifestIdentityComponentDigestPrefix(
              component,
              value
            )}`
        ),
      ].join(' ')
    );
    return Object.freeze({
      manifestCanonicalJson:
        serializeProviderInvocationManifestV1CanonicalWireJson(manifestInput),
      manifestKey,
      providerInvocationKey,
      providerVoteIdentityHash: lane.providerVoteIdentityHash,
    });
  }
}

function digestPrefix(value: string | null): string {
  return value && /^[a-f0-9]{64}$/u.test(value) ? value.slice(0, 12) : 'none';
}

const manifestIdentityComponentKind = new Map(
  providerInvocationManifestV1CanonicalizerDescriptor.fields.map((field) => [
    field.name,
    field.kind,
  ])
);

function manifestIdentityComponentDigestPrefix(
  component: string,
  value: unknown
): string {
  if (value === null) return 'none';
  const componentKind = manifestIdentityComponentKind.get(
    component as (typeof providerInvocationManifestV1CanonicalizerDescriptor.fields)[number]['name']
  );
  if (
    (componentKind === 'hash' || componentKind === 'nullable_hash') &&
    typeof value === 'string' &&
    /^[a-f0-9]{64}$/u.test(value)
  ) {
    return digestPrefix(value);
  }
  return digestPrefix(sha256(canonicalJson(value)));
}

export class DeterministicReviewOrchestrationIdentity implements ReviewOrchestrationIdentityPort {
  deterministicId(namespace: string, parts: readonly string[]): string {
    if (!/^[a-z0-9-]{1,80}$/.test(namespace)) {
      throw new Error('review_action_v2_identity_namespace_invalid');
    }
    return `rr:${namespace}:${sha256(canonicalJson(parts)).slice(0, 40)}`;
  }
}

export class CooperativeReviewLeaseSupervisor implements ReviewInvocationLeaseSupervisorPort {
  async run<T>(input: {
    readonly lease: ReviewInvocationLease;
    readonly renew: () => Promise<ReviewInvocationLease>;
    readonly operation: (
      signal: AbortSignal,
      currentLease: () => ReviewInvocationLease
    ) => Promise<T>;
  }): Promise<T> {
    let stopped = false;
    let stopWake: (() => void) | undefined;
    let currentLease = input.lease;
    const abort = new AbortController();
    let rejectLeaseFailure!: (reason: unknown) => void;
    const leaseFailure = new Promise<never>((_resolve, reject) => {
      rejectLeaseFailure = reject;
    });
    const failLease = (error: unknown) => {
      if (stopped || abort.signal.aborted) return;
      abort.abort(error);
      rejectLeaseFailure(error);
    };
    const wait = async (delayMs: number) => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        timer.unref?.();
        stopWake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    };
    const renewLoop = (async () => {
      while (!stopped) {
        const remaining = Date.parse(currentLease.expiresAt) - Date.now();
        if (!Number.isFinite(remaining) || remaining <= 0) {
          failLease(new Error('review_action_v2_lease_expired'));
          return;
        }
        await wait(
          currentLease.renewalCeilingReached
            ? remaining
            : Math.min(30_000, Math.max(1_000, Math.floor(remaining / 2)))
        );
        if (stopped) return;
        if (currentLease.renewalCeilingReached) {
          failLease(new Error('review_action_v2_lease_expired'));
          return;
        }
        try {
          currentLease = await input.renew();
        } catch (error) {
          failLease(error);
          return;
        }
      }
    })();

    try {
      return await Promise.race([
        Promise.resolve().then(() =>
          input.operation(abort.signal, () => currentLease)
        ),
        leaseFailure,
      ]);
    } finally {
      stopped = true;
      stopWake?.();
      await renewLoop;
    }
  }
}

export class SystemReviewOrchestrationDelay implements ReviewOrchestrationDelayPort {
  async sleep(delayMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
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

function safeFailureDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) return '';
  if (isSafeReviewActionV2Diagnostic(error.message)) {
    return ` (${error.message})`;
  }
  return '';
}

function isSafeReviewActionV2Diagnostic(message: string): boolean {
  if (/^review_action_v2:[a-z0-9_:-]{1,160}$/u.test(message)) {
    return true;
  }
  if (/^review_action_v2_[a-z0-9_]{1,160}$/u.test(message)) {
    return true;
  }
  if (
    /^review_action_v2_[a-z0-9_]{1,80}(?: operation=[a-z0-9_]{1,80})?(?: http_status=[1-5][0-9]{2})?(?: error_code=[a-z0-9_]{1,80})?(?: issues=[a-z0-9_,]{1,200})?$/u.test(
      message
    )
  ) {
    return true;
  }
  if (
    /^(?:context_dependency|context_gateway|context_git|text_search|file_read|directory|git_fact|gateway|checkout_tree|authenticated_event_chain|previous_event|event)_[a-z0-9_]{1,160}$/u.test(
      message
    )
  ) {
    return true;
  }
  return false;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
