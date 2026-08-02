export enum ReviewAgentProviderKind {
  Codex = 'codex',
  ClaudeCode = 'claude_code',
}

export enum ReviewAgentExecutionProfile {
  GatewayAttestedAgentV1 = 'gateway_attested_agent_v1',
  OrchestratedToolLoopV1 = 'orchestrated_tool_loop_v1',
  PreassembledContextV1 = 'preassembled_context_v1',
  PromptOnlyV1 = 'prompt_only_v1',
  AgenticUnboundedV1 = 'agentic_unbounded_v1',
}

export enum ReviewAgentToolTransport {
  McpStdio = 'mcp_stdio',
  OrchestratedFunctions = 'orchestrated_functions',
  Preassembled = 'preassembled',
  Native = 'native',
  None = 'none',
}

export enum ReviewAgentStructuredOutputSupport {
  JsonSchema = 'json_schema',
  ProviderValidatedJson = 'provider_validated_json',
  None = 'none',
}

export enum ReviewAgentEventStreamSupport {
  JsonLines = 'json_lines',
  SingleEnvelope = 'single_envelope',
  None = 'none',
}

export enum ReviewAgentContinuationMechanism {
  DurableDossier = 'durable_dossier',
  ProviderSessionOptional = 'provider_session_optional',
  ProviderSessionRequired = 'provider_session_required',
}

export enum ReviewAgentConfinementStrength {
  GatewayOnly = 'gateway_only',
  OrchestratorOnly = 'orchestrator_only',
  PreassembledOnly = 'preassembled_only',
  Unbounded = 'unbounded',
}

export enum ReviewAgentAttributionStrength {
  Observed = 'observed',
  RequestedOnly = 'requested_only',
  Unavailable = 'unavailable',
}

export enum ReviewAgentCancellationSupport {
  ProcessGroupFenced = 'process_group_fenced',
  ProcessFenced = 'process_fenced',
  Unsupported = 'unsupported',
}

export type ReviewAgentRuntimeProfile = Readonly<{
  profileVersion: 1;
  providerKind: ReviewAgentProviderKind;
  executionProfile: ReviewAgentExecutionProfile;
  toolTransport: ReviewAgentToolTransport;
  structuredOutput: ReviewAgentStructuredOutputSupport;
  eventStream: ReviewAgentEventStreamSupport;
  continuation: ReviewAgentContinuationMechanism;
  confinement: ReviewAgentConfinementStrength;
  actualModelAttribution: ReviewAgentAttributionStrength;
  usageAttribution: ReviewAgentAttributionStrength;
  cancellation: ReviewAgentCancellationSupport;
  maxPromptBytes: number;
  maxOutputBytes: number;
  maxToolCalls: number;
  maxTurns: number;
}>;

export type ReviewAgentProtocolRequirements = Readonly<{
  providerKind: ReviewAgentProviderKind;
  executionProfile: ReviewAgentExecutionProfile;
  minimumConfinement: ReviewAgentConfinementStrength;
  requireActualModelAttribution: boolean;
  requireUsageAttribution: boolean;
  requireFencedCancellation: boolean;
  minimumMaxTurns: number;
}>;

export function createGatewayAttestedRuntimeProfile(input: {
  readonly providerKind: ReviewAgentProviderKind;
  readonly eventStream: ReviewAgentEventStreamSupport;
  readonly maxPromptBytes: number;
  readonly maxOutputBytes?: number;
  readonly maxToolCalls?: number;
  readonly maxTurns?: number;
}): ReviewAgentRuntimeProfile {
  assertPositive(input.maxPromptBytes, 'max_prompt_bytes');
  assertPositive(input.maxOutputBytes ?? 4 * 1024 * 1024, 'max_output_bytes');
  assertPositive(input.maxToolCalls ?? 256, 'max_tool_calls');
  assertPositive(input.maxTurns ?? 12, 'max_turns');
  return Object.freeze({
    profileVersion: 1,
    providerKind: input.providerKind,
    executionProfile: ReviewAgentExecutionProfile.GatewayAttestedAgentV1,
    toolTransport: ReviewAgentToolTransport.McpStdio,
    structuredOutput: ReviewAgentStructuredOutputSupport.JsonSchema,
    eventStream: input.eventStream,
    continuation: ReviewAgentContinuationMechanism.DurableDossier,
    confinement: ReviewAgentConfinementStrength.GatewayOnly,
    actualModelAttribution: ReviewAgentAttributionStrength.Observed,
    usageAttribution: ReviewAgentAttributionStrength.Observed,
    cancellation: ReviewAgentCancellationSupport.ProcessGroupFenced,
    maxPromptBytes: input.maxPromptBytes,
    maxOutputBytes: input.maxOutputBytes ?? 4 * 1024 * 1024,
    maxToolCalls: input.maxToolCalls ?? 256,
    maxTurns: input.maxTurns ?? 12,
  });
}

export function assertRuntimeProfileSatisfies(
  profile: ReviewAgentRuntimeProfile,
  requirements: ReviewAgentProtocolRequirements
): void {
  if (
    profile.providerKind !== requirements.providerKind ||
    profile.executionProfile !== requirements.executionProfile ||
    profile.confinement !== requirements.minimumConfinement ||
    (requirements.requireActualModelAttribution &&
      profile.actualModelAttribution !==
        ReviewAgentAttributionStrength.Observed) ||
    (requirements.requireUsageAttribution &&
      profile.usageAttribution !== ReviewAgentAttributionStrength.Observed) ||
    (requirements.requireFencedCancellation &&
      profile.cancellation !==
        ReviewAgentCancellationSupport.ProcessGroupFenced) ||
    profile.maxTurns < requirements.minimumMaxTurns
  ) {
    throw new Error('review_agent_capability_requirements_unsatisfied');
  }
}

function assertPositive(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`review_agent_${field}_invalid`);
  }
}
