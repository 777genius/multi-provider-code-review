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
  type ReviewAgentProtocolRequirements,
  type ReviewAgentRuntimeProfile,
} from '../domain/runtime-profile';
import {
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

export type ParsedProviderTurn = Readonly<{
  output: ReviewAgentTurnOutput;
  actualModel: string;
  usage: ReviewTurnUsage;
}>;

export abstract class StrictCliReviewAgent implements ReviewAgentPort {
  protected constructor(
    protected readonly profile: ReviewAgentRuntimeProfile,
    protected readonly runner: ReviewAgentProcessRunnerPort
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

  cancel(invocationId: string, fencingToken: string): Promise<void> {
    return this.runner.cancel(invocationId, fencingToken);
  }

  protected validateRequest(request: ReviewTurnRequest): void {
    const expectedTools = [...REVIEW_INVESTIGATION_GATEWAY_TOOLS].sort();
    const actualTools = [...request.gateway.enabledTools].sort();
    if (
      !request.invocationId ||
      !request.fencingToken ||
      !request.turnId ||
      !Number.isSafeInteger(request.dossierVersion) ||
      request.dossierVersion < 0 ||
      !/^[a-f0-9]{64}$/u.test(request.dossierDigest) ||
      !request.prompt ||
      Buffer.byteLength(request.prompt, 'utf8') > this.profile.maxPromptBytes ||
      request.requestedModel.length < 1 ||
      request.requestedModel.length > 200 ||
      !Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs < 1 ||
      !Number.isSafeInteger(request.maxTurns) ||
      request.maxTurns < 1 ||
      request.maxTurns > this.profile.maxTurns ||
      request.gateway.policyVersion !== 'context-gateway-v4' ||
      !/^[a-f0-9]{64}$/u.test(request.gateway.binaryHash) ||
      actualTools.length !== expectedTools.length ||
      actualTools.some((tool, index) => tool !== expectedTools[index])
    ) {
      throw new ReviewAgentExecutionError(
        ReviewAgentFailureClass.CapabilityUnavailable,
        null,
        'review_agent_turn_request_invalid'
      );
    }
    assertEnvironmentPartition(
      request.gateway.runtimeEnvironment,
      request.gateway.credentialEnvironment,
      request.providerCredentialEnvironment
    );
  }

  protected executionEnvironment(
    request: ReviewTurnRequest
  ): NodeJS.ProcessEnv {
    return {
      ...this.providerOnlyExecutionEnvironment(request),
      ...request.gateway.runtimeEnvironment,
      REVIEWROUTER_CONTEXT_GATEWAY_POLICY_VERSION: 'context-gateway-v4',
      ...request.gateway.credentialEnvironment,
    };
  }

  protected providerOnlyExecutionEnvironment(
    request: ReviewTurnRequest
  ): NodeJS.ProcessEnv {
    return {
      ...buildCliSafeEnv({ includeWorkspaceEnv: false }),
      ...request.providerCredentialEnvironment,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1',
    };
  }

  protected async runProcess(
    request: ReviewTurnRequest,
    input: Readonly<{
      binary: string;
      args: readonly string[];
      environment?: Readonly<NodeJS.ProcessEnv>;
    }>
  ): Promise<ReviewAgentProcessResult> {
    const result = await this.runner.run({
      invocationId: request.invocationId,
      fencingToken: request.fencingToken,
      cwd: request.workingDirectory,
      environment: input.environment ?? this.executionEnvironment(request),
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
      observationVersion: 1,
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
    totalTokens: inputTokens + outputTokens,
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
  if (error instanceof ReviewAgentExecutionError) return error;
  return new ReviewAgentExecutionError(
    ReviewAgentFailureClass.SchemaInvalidOutput,
    null,
    error instanceof Error ? error.message : 'review_agent_output_invalid'
  );
}

export function streamFailure(message: string): ReviewAgentExecutionError {
  return new ReviewAgentExecutionError(
    ReviewAgentFailureClass.StreamIncomplete,
    null,
    message
  );
}

export function usageFailure(message: string): ReviewAgentExecutionError {
  return new ReviewAgentExecutionError(
    ReviewAgentFailureClass.UsageAttributionMissing,
    null,
    message
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
  const diagnostic = sanitizeDiagnostic(`${result.stderr}\n${result.stdout}`);
  throw classifyProviderFailure(diagnostic, result.termination);
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
    `review_agent_process_failure:${diagnostic || 'unknown'}`
  );
}

function assertEnvironmentPartition(
  runtime: Readonly<NodeJS.ProcessEnv>,
  gatewayCredentials: Readonly<NodeJS.ProcessEnv>,
  providerCredentials: Readonly<NodeJS.ProcessEnv>
): void {
  for (const [key, value] of Object.entries(runtime)) {
    if (value !== undefined && isCredentialKey(key)) {
      throw new Error('review_agent_runtime_environment_contains_credential');
    }
  }
  for (const [key, value] of Object.entries(gatewayCredentials)) {
    if (value !== undefined && !isCredentialKey(key)) {
      throw new Error('review_agent_gateway_credential_environment_invalid');
    }
  }
  for (const [key, value] of Object.entries(providerCredentials)) {
    if (
      value !== undefined &&
      !isCredentialKey(key) &&
      key !== 'CODEX_HOME' &&
      key !== 'CLAUDE_CONFIG_DIR'
    ) {
      throw new Error('review_agent_provider_credential_environment_invalid');
    }
  }
}

function isCredentialKey(key: string): boolean {
  return /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE)/iu.test(key);
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

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/(?:sk|sess|eyJ)[A-Za-z0-9._-]{12,}/gu, '<redacted>')
    .replace(/[\r\n]+/gu, ' ')
    .trim()
    .slice(0, 400);
}
