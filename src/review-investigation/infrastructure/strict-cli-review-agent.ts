import { buildCliSafeEnv } from '../../providers/cli-env';
import {
  REVIEW_INVESTIGATION_GATEWAY_TOOLS,
  ReviewAgentExecutionError,
  ReviewAgentFailureClass,
  type ReviewAgentPort,
  type ReviewTurnRequest,
} from '../application/review-agent-port';
import {
  assertRuntimeProfileSatisfies,
  ReviewAgentProviderKind,
  type ReviewAgentProtocolRequirements,
  type ReviewAgentRuntimeProfile,
} from '../domain/runtime-profile';
import {
  REVIEW_TURN_OBSERVATION_VERSION,
  ReviewTurnPurpose,
  type ReviewAgentTurnOutput,
  type ReviewTurnObservation,
  type ReviewTurnUsage,
} from '../domain/turn-observation';
import {
  ReviewAgentProcessTermination,
  type ReviewAgentProcessResult,
  type ReviewAgentProcessRunnerPort,
} from './review-agent-process-runner';
import type {
  ReviewAgentExecutionSessionResolverPort,
  ReviewAgentGatewayLaunchBinding,
} from './review-agent-execution-session';

export type ParsedProviderTurn = Readonly<{
  output: ReviewAgentTurnOutput;
  actualModel: string;
  usage: ReviewTurnUsage;
}>;

export type ReviewAgentAdapterExecution = Readonly<{
  gateway: ReviewAgentGatewayLaunchBinding;
  providerCredentialEnvironment: Readonly<NodeJS.ProcessEnv>;
}>;

const GATEWAY_RUNTIME_ENV_KEYS = new Set([
  'REVIEWROUTER_CONTEXT_GATEWAY_POLICY_VERSION',
  'REVIEWROUTER_CONTEXT_SESSION_ID',
  'REVIEWROUTER_CONTEXT_ROOT',
  'REVIEWROUTER_CONTEXT_TRANSCRIPT_PATH',
  'REVIEWROUTER_CONTEXT_REPLAY_MATERIAL_PATH',
  'REVIEWROUTER_CONTEXT_GATEWAY_BINARY_HASH',
  'REVIEWROUTER_CONTEXT_GATEWAY_MAX_OPERATIONS',
  'REVIEWROUTER_CONTEXT_CHECKOUT_TREE_OID',
  'REVIEWROUTER_CONTEXT_MERGE_BASE_TREE_OID',
  'REVIEWROUTER_CONTEXT_EVENT_CHAIN_SEED_HASH',
  'REVIEWROUTER_CONTEXT_BASE_SHA',
  'REVIEWROUTER_CONTEXT_MERGE_BASE_SHA',
  'REVIEWROUTER_CONTEXT_HEAD_SHA',
]);
const GATEWAY_CREDENTIAL_ENV_KEYS = new Set([
  'REVIEWROUTER_CONTEXT_GATEWAY_SECRET',
]);
const PROVIDER_ENV_KEYS: Readonly<
  Record<ReviewAgentProviderKind, ReadonlySet<string>>
> = Object.freeze({
  [ReviewAgentProviderKind.Codex]: new Set([
    'CODEX_HOME',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
  ]),
  [ReviewAgentProviderKind.ClaudeCode]: new Set([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CONFIG_DIR',
  ]),
});
const MAX_SAFE_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;
const SAFE_AGENT_ERROR_CODES = new Set([
  'review_agent_actual_model_invalid',
  'review_agent_actual_model_unavailable',
  'review_agent_authentication_unavailable',
  'review_agent_cached_input_tokens_invalid',
  'review_agent_cached_usage_invalid',
  'review_agent_cancel_failure',
  'review_agent_capability_requirements_unsatisfied',
  'review_agent_capacity_unavailable',
  'review_agent_claude_stream_incomplete',
  'review_agent_claude_usage_missing',
  'review_agent_codex_event_json_invalid',
  'review_agent_codex_event_stream_empty',
  'review_agent_codex_stream_incomplete',
  'review_agent_codex_usage_missing',
  'review_agent_critic_decision_invalid_for_turn',
  'review_agent_execution_session_invalid',
  'review_agent_gateway_credential_environment_invalid',
  'review_agent_input_tokens_invalid',
  'review_agent_output_invalid',
  'review_agent_output_invalid_claims',
  'review_agent_output_invalid_critic',
  'review_agent_output_invalid_finding',
  'review_agent_output_invalid_obligation_proposal',
  'review_agent_output_invalid_shape',
  'review_agent_output_tokens_invalid',
  'review_agent_process_cancelled',
  'review_agent_process_failure',
  'review_agent_process_timeout',
  'review_agent_provider_credential_environment_invalid',
  'review_agent_quota_unavailable',
  'review_agent_reasoning_output_tokens_invalid',
  'review_agent_runtime_environment_invalid',
  'review_agent_startup_failure',
  'review_agent_turn_request_invalid',
  'review_agent_turn_obligation_claim_invalid',
  'review_agent_usage_attribution_missing',
  'review_agent_workspace_authority_mismatch',
]);
const SAFE_DEFAULT_ERROR_CODE: Readonly<
  Record<ReviewAgentFailureClass, string>
> = Object.freeze({
  [ReviewAgentFailureClass.CapabilityUnavailable]:
    'review_agent_capability_unavailable',
  [ReviewAgentFailureClass.AuthenticationUnavailable]:
    'review_agent_authentication_unavailable',
  [ReviewAgentFailureClass.QuotaUnavailable]: 'review_agent_quota_unavailable',
  [ReviewAgentFailureClass.CapacityUnavailable]:
    'review_agent_capacity_unavailable',
  [ReviewAgentFailureClass.StartupFailure]: 'review_agent_startup_failure',
  [ReviewAgentFailureClass.ProcessFailure]: 'review_agent_process_failure',
  [ReviewAgentFailureClass.Timeout]: 'review_agent_process_timeout',
  [ReviewAgentFailureClass.Cancelled]: 'review_agent_process_cancelled',
  [ReviewAgentFailureClass.SchemaInvalidOutput]: 'review_agent_output_invalid',
  [ReviewAgentFailureClass.StreamIncomplete]: 'review_agent_stream_incomplete',
  [ReviewAgentFailureClass.ModelAttributionMissing]:
    'review_agent_actual_model_unavailable',
  [ReviewAgentFailureClass.UsageAttributionMissing]:
    'review_agent_usage_attribution_missing',
  [ReviewAgentFailureClass.ConfinementViolation]:
    'review_agent_confinement_violation',
});

export abstract class StrictCliReviewAgent implements ReviewAgentPort {
  protected constructor(
    protected readonly profile: ReviewAgentRuntimeProfile,
    protected readonly runner: ReviewAgentProcessRunnerPort,
    private readonly executionSessions: ReviewAgentExecutionSessionResolverPort,
    private readonly providerCredentials: () => Readonly<NodeJS.ProcessEnv>
  ) {}

  async negotiate(
    requirements: ReviewAgentProtocolRequirements
  ): Promise<ReviewAgentRuntimeProfile> {
    try {
      assertRuntimeProfileSatisfies(this.profile, requirements);
      return this.profile;
    } catch {
      throw new ReviewAgentExecutionError(
        ReviewAgentFailureClass.CapabilityUnavailable,
        null,
        'review_agent_capability_requirements_unsatisfied'
      );
    }
  }

  abstract executeTurn(
    request: ReviewTurnRequest
  ): Promise<ReviewTurnObservation>;

  async cancel(invocationId: string, fencingToken: string): Promise<void> {
    try {
      await this.runner.cancel(invocationId, fencingToken);
    } catch (error) {
      throw safeAgentError(
        error,
        ReviewAgentFailureClass.ProcessFailure,
        'review_agent_cancel_failure'
      );
    }
  }

  protected validateRequest(request: ReviewTurnRequest): void {
    if (
      !request.invocationId ||
      !request.fencingToken ||
      !request.turnId ||
      !Number.isSafeInteger(request.dossierVersion) ||
      request.dossierVersion < 0 ||
      !/^[a-f0-9]{64}$/u.test(request.dossierDigest) ||
      !request.prompt ||
      Buffer.byteLength(request.prompt, 'utf8') > this.profile.maxPromptBytes ||
      !request.workspaceRoot ||
      request.requestedModel.length < 1 ||
      request.requestedModel.length > 200 ||
      !Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs < 1 ||
      !Number.isSafeInteger(request.maxTurns) ||
      request.maxTurns < 1 ||
      request.maxTurns > this.profile.maxTurns ||
      !validAllowedObligationIds(request.allowedObligationIds)
    ) {
      throw new ReviewAgentExecutionError(
        ReviewAgentFailureClass.CapabilityUnavailable,
        null,
        'review_agent_turn_request_invalid'
      );
    }
  }

  protected prepareExecution(
    request: ReviewTurnRequest
  ): ReviewAgentAdapterExecution {
    this.validateRequest(request);
    const gateway = this.executionSessions.resolve(
      request.executionSession,
      this.profile.providerKind
    );
    const providerCredentialEnvironment = Object.freeze({
      ...this.providerCredentials(),
    });
    assertGatewayBinding(gateway);
    if (gateway.cwd !== request.workspaceRoot) {
      throw new ReviewAgentExecutionError(
        ReviewAgentFailureClass.ConfinementViolation,
        null,
        'review_agent_workspace_authority_mismatch'
      );
    }
    assertEnvironmentPartition(
      gateway.runtimeEnvironment,
      gateway.credentialEnvironment,
      providerCredentialEnvironment,
      this.profile.providerKind
    );
    return Object.freeze({ gateway, providerCredentialEnvironment });
  }

  protected executionEnvironment(
    execution: ReviewAgentAdapterExecution
  ): NodeJS.ProcessEnv {
    return {
      ...this.providerOnlyExecutionEnvironment(execution),
      ...execution.gateway.runtimeEnvironment,
      REVIEWROUTER_CONTEXT_GATEWAY_POLICY_VERSION: 'context-gateway-v4',
      ...execution.gateway.credentialEnvironment,
    };
  }

  protected providerOnlyExecutionEnvironment(
    execution: ReviewAgentAdapterExecution
  ): NodeJS.ProcessEnv {
    return {
      ...buildCliSafeEnv({ includeWorkspaceEnv: false }),
      ...execution.providerCredentialEnvironment,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1',
    };
  }

  protected async runProcess(
    request: ReviewTurnRequest,
    execution: ReviewAgentAdapterExecution,
    input: Readonly<{
      binary: string;
      args: readonly string[];
      environment?: Readonly<NodeJS.ProcessEnv>;
    }>
  ): Promise<ReviewAgentProcessResult> {
    const result = await this.runner.run({
      invocationId: request.invocationId,
      fencingToken: request.fencingToken,
      cwd: execution.gateway.cwd,
      environment: input.environment ?? this.executionEnvironment(execution),
      stdin: request.prompt,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: this.profile.maxOutputBytes,
      signal: request.signal,
      binary: input.binary,
      args: input.args,
    });
    assertSuccessfulProcess(result);
    return result;
  }

  protected observation(
    request: ReviewTurnRequest,
    parsed: ParsedProviderTurn,
    durationMs: number
  ): ReviewTurnObservation {
    assertTurnObligationClaimsAllowed(request, parsed.output);
    if (
      (request.purpose === ReviewTurnPurpose.Discovery &&
        parsed.output.criticDecision !== null) ||
      (request.purpose === ReviewTurnPurpose.Critic &&
        parsed.output.criticDecision === null)
    ) {
      throw new ReviewAgentExecutionError(
        ReviewAgentFailureClass.SchemaInvalidOutput,
        null,
        'review_agent_critic_decision_invalid_for_turn'
      );
    }
    return Object.freeze({
      observationVersion: REVIEW_TURN_OBSERVATION_VERSION,
      invocationId: request.invocationId,
      turnId: request.turnId,
      dossierVersion: request.dossierVersion,
      purpose: request.purpose,
      actualProviderKind: this.profile.providerKind,
      actualModel: parsed.actualModel,
      runtimeProfile: this.profile.executionProfile,
      usage: parsed.usage,
      durationMs,
      schemaComplete: true,
      streamComplete: true,
      contextAttestationReference: null,
      ...parsed.output,
    });
  }
}

function validAllowedObligationIds(ids: readonly string[]): boolean {
  return (
    Array.isArray(ids) &&
    ids.length <= 256 &&
    new Set(ids).size === ids.length &&
    ids.every((id) => /^[a-f0-9]{64}$/u.test(id))
  );
}

function assertTurnObligationClaimsAllowed(
  request: ReviewTurnRequest,
  output: ReviewAgentTurnOutput
): void {
  const allowed = new Set(request.allowedObligationIds);
  const closureIds = output.closureClaims.map((claim) => claim.obligationId);
  const unresolvableIds = output.unresolvableClaims.map(
    (claim) => claim.obligationId
  );
  const invalid =
    closureIds.some((id) => !allowed.has(id)) ||
    unresolvableIds.some((id) => !allowed.has(id)) ||
    new Set(closureIds).size !== closureIds.length ||
    new Set(unresolvableIds).size !== unresolvableIds.length ||
    closureIds.some((id) => unresolvableIds.includes(id));
  if (invalid) {
    throw new ReviewAgentExecutionError(
      ReviewAgentFailureClass.SchemaInvalidOutput,
      null,
      'review_agent_turn_obligation_claim_invalid'
    );
  }
}

export function parseUsage(input: {
  readonly inputTokens: unknown;
  readonly cachedInputTokens?: unknown;
  readonly outputTokens: unknown;
  readonly reasoningOutputTokens?: unknown;
}): ReviewTurnUsage {
  const inputTokens = requireTokenCount(input.inputTokens, 'input');
  const cachedInputTokens = requireTokenCount(
    input.cachedInputTokens ?? 0,
    'cached_input'
  );
  const outputTokens = requireTokenCount(input.outputTokens, 'output');
  const reasoningOutputTokens = requireTokenCount(
    input.reasoningOutputTokens ?? 0,
    'reasoning_output'
  );
  if (cachedInputTokens > inputTokens) {
    throw new ReviewAgentExecutionError(
      ReviewAgentFailureClass.UsageAttributionMissing,
      null,
      'review_agent_cached_usage_invalid'
    );
  }
  return Object.freeze({
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens + reasoningOutputTokens,
  });
}

export function requireObservedModel(models: ReadonlySet<string>): string {
  if (models.size !== 1) {
    throw new ReviewAgentExecutionError(
      ReviewAgentFailureClass.ModelAttributionMissing,
      null,
      'review_agent_actual_model_unavailable'
    );
  }
  const model = [...models][0];
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+#-]{0,199}$/u.test(model)) {
    throw new ReviewAgentExecutionError(
      ReviewAgentFailureClass.ModelAttributionMissing,
      null,
      'review_agent_actual_model_invalid'
    );
  }
  return model;
}

export function schemaFailure(error: unknown): ReviewAgentExecutionError {
  if (error instanceof ReviewAgentExecutionError) {
    return safeAgentError(
      error,
      ReviewAgentFailureClass.SchemaInvalidOutput,
      'review_agent_output_invalid'
    );
  }
  return new ReviewAgentExecutionError(
    ReviewAgentFailureClass.SchemaInvalidOutput,
    null,
    safeErrorCode(
      error instanceof Error ? error.message : 'review_agent_output_invalid',
      ReviewAgentFailureClass.SchemaInvalidOutput
    )
  );
}

export function streamFailure(message: string): ReviewAgentExecutionError {
  return new ReviewAgentExecutionError(
    ReviewAgentFailureClass.StreamIncomplete,
    null,
    safeErrorCode(message, ReviewAgentFailureClass.StreamIncomplete)
  );
}

export function usageFailure(message: string): ReviewAgentExecutionError {
  return new ReviewAgentExecutionError(
    ReviewAgentFailureClass.UsageAttributionMissing,
    null,
    safeErrorCode(message, ReviewAgentFailureClass.UsageAttributionMissing)
  );
}

function assertSuccessfulProcess(result: ReviewAgentProcessResult): void {
  if (
    result.termination === ReviewAgentProcessTermination.Exited &&
    result.exitCode === 0
  ) {
    return;
  }
  if (result.termination === ReviewAgentProcessTermination.TimedOut) {
    throw new ReviewAgentExecutionError(
      ReviewAgentFailureClass.Timeout,
      null,
      'review_agent_process_timeout'
    );
  }
  if (result.termination === ReviewAgentProcessTermination.Cancelled) {
    throw new ReviewAgentExecutionError(
      ReviewAgentFailureClass.Cancelled,
      null,
      'review_agent_process_cancelled'
    );
  }
  const failureSignals = boundedProviderFailureSignals(result);
  throw classifyProviderFailure(failureSignals, result.termination);
}

function classifyProviderFailure(
  diagnostic: string,
  termination: ReviewAgentProcessTermination
): ReviewAgentExecutionError {
  if (
    /(?:401|403|unauthorized|not logged in|refresh token|oauth|authentication)/iu.test(
      diagnostic
    )
  ) {
    return new ReviewAgentExecutionError(
      ReviewAgentFailureClass.AuthenticationUnavailable,
      null,
      'review_agent_authentication_unavailable'
    );
  }
  if (
    /(?:invalid_json_schema|invalid schema for response_format|(?:invalid|rejected|unsupported) structured output schema|structured output schema (?:is )?(?:invalid|rejected|unsupported))/iu.test(
      diagnostic
    )
  ) {
    return new ReviewAgentExecutionError(
      ReviewAgentFailureClass.SchemaInvalidOutput,
      null,
      'review_agent_output_invalid'
    );
  }
  if (
    /(?:usage limit|quota|insufficient_quota|billing limit)/iu.test(diagnostic)
  ) {
    return new ReviewAgentExecutionError(
      ReviewAgentFailureClass.QuotaUnavailable,
      null,
      'review_agent_quota_unavailable'
    );
  }
  if (
    /(?:capacity[_ -]unavailable|overloaded|too many requests|\b429\b|rate limit)/iu.test(
      diagnostic
    )
  ) {
    return new ReviewAgentExecutionError(
      ReviewAgentFailureClass.CapacityUnavailable,
      null,
      'review_agent_capacity_unavailable'
    );
  }
  if (
    /(?:model cache|startup|failed to start|enoent|spawn)/iu.test(diagnostic) ||
    termination === ReviewAgentProcessTermination.StartupFailed
  ) {
    return new ReviewAgentExecutionError(
      ReviewAgentFailureClass.StartupFailure,
      null,
      'review_agent_startup_failure'
    );
  }
  return new ReviewAgentExecutionError(
    ReviewAgentFailureClass.ProcessFailure,
    null,
    'review_agent_process_failure'
  );
}

function assertGatewayBinding(binding: ReviewAgentGatewayLaunchBinding): void {
  const expectedTools = [...REVIEW_INVESTIGATION_GATEWAY_TOOLS].sort();
  const actualTools = [...binding.enabledTools].sort();
  if (
    binding.policyVersion !== 'context-gateway-v4' ||
    !/^[a-f0-9]{64}$/u.test(binding.binaryHash) ||
    !binding.command ||
    !binding.cwd ||
    actualTools.length !== expectedTools.length ||
    actualTools.some((tool, index) => tool !== expectedTools[index])
  ) {
    throw new ReviewAgentExecutionError(
      ReviewAgentFailureClass.CapabilityUnavailable,
      null,
      'review_agent_execution_session_invalid'
    );
  }
}

function assertEnvironmentPartition(
  runtime: Readonly<NodeJS.ProcessEnv>,
  gatewayCredentials: Readonly<NodeJS.ProcessEnv>,
  providerCredentials: Readonly<NodeJS.ProcessEnv>,
  providerKind: ReviewAgentProviderKind
): void {
  assertAllowlistedEnvironment(
    runtime,
    GATEWAY_RUNTIME_ENV_KEYS,
    'review_agent_runtime_environment_invalid'
  );
  assertAllowlistedEnvironment(
    gatewayCredentials,
    GATEWAY_CREDENTIAL_ENV_KEYS,
    'review_agent_gateway_credential_environment_invalid'
  );
  assertAllowlistedEnvironment(
    providerCredentials,
    PROVIDER_ENV_KEYS[providerKind],
    'review_agent_provider_credential_environment_invalid'
  );
}

function assertAllowlistedEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  allowedKeys: ReadonlySet<string>,
  errorCode: string
): void {
  for (const key of Object.keys(environment)) {
    if (!allowedKeys.has(key)) throw new Error(errorCode);
  }
}

function requireTokenCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ReviewAgentExecutionError(
      ReviewAgentFailureClass.UsageAttributionMissing,
      null,
      `review_agent_${field}_tokens_invalid`
    );
  }
  return value as number;
}

function boundedProviderFailureSignals(
  result: ReviewAgentProcessResult
): string {
  return `${result.stderr.slice(0, 8_192)}\n${result.stdout.slice(0, 8_192)}`
    .replace(/(?:sk|sess|eyJ)[A-Za-z0-9._-]{12,}/gu, '<redacted>')
    .replace(/[\r\n]+/gu, ' ')
    .trim()
    .slice(0, 16_384);
}

function safeAgentError(
  error: unknown,
  fallbackClass: ReviewAgentFailureClass,
  fallbackCode: string
): ReviewAgentExecutionError {
  if (!(error instanceof ReviewAgentExecutionError)) {
    return new ReviewAgentExecutionError(fallbackClass, null, fallbackCode);
  }
  return new ReviewAgentExecutionError(
    error.failureClass,
    safeRetryAfterMs(error.retryAfterMs),
    safeErrorCode(error.message, error.failureClass)
  );
}

function safeErrorCode(
  value: string,
  failureClass: ReviewAgentFailureClass
): string {
  return SAFE_AGENT_ERROR_CODES.has(value)
    ? value
    : SAFE_DEFAULT_ERROR_CODE[failureClass];
}

function safeRetryAfterMs(value: number | null): number | null {
  if (
    value === null ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_SAFE_RETRY_AFTER_MS
  ) {
    return null;
  }
  return value;
}
