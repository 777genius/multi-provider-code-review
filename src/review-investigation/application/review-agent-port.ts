import type {
  ReviewAgentProtocolRequirements,
  ReviewAgentRuntimeProfile,
} from '../domain/runtime-profile';
import type {
  ReviewTurnObservation,
  ReviewTurnPurpose,
} from '../domain/turn-observation';

export const REVIEW_INVESTIGATION_GATEWAY_TOOLS = Object.freeze([
  'review_read_file',
  'review_list_directory',
  'review_search_text',
  'review_canonical_inventory',
  'review_git_fact',
]);

export type ReviewAgentGatewayConfig = Readonly<{
  policyVersion: 'context-gateway-v4';
  binaryHash: string;
  command: string;
  args: readonly string[];
  cwd: string;
  enabledTools: readonly string[];
  runtimeEnvironment: Readonly<NodeJS.ProcessEnv>;
  credentialEnvironment: Readonly<NodeJS.ProcessEnv>;
}>;

export type ReviewTurnRequest = Readonly<{
  invocationId: string;
  fencingToken: string;
  turnId: string;
  dossierVersion: number;
  dossierDigest: string;
  purpose: ReviewTurnPurpose;
  prompt: string;
  workingDirectory: string;
  requestedModel: string;
  timeoutMs: number;
  maxTurns: number;
  gateway: ReviewAgentGatewayConfig;
  providerCredentialEnvironment: Readonly<NodeJS.ProcessEnv>;
  signal?: AbortSignal;
}>;

export interface ReviewAgentPort {
  negotiate(
    requirements: ReviewAgentProtocolRequirements
  ): Promise<ReviewAgentRuntimeProfile>;
  executeTurn(request: ReviewTurnRequest): Promise<ReviewTurnObservation>;
  cancel(invocationId: string, fencingToken: string): Promise<void>;
}

export enum ReviewAgentFailureClass {
  CapabilityUnavailable = 'capability_unavailable',
  AuthenticationUnavailable = 'authentication_unavailable',
  QuotaUnavailable = 'quota_unavailable',
  CapacityUnavailable = 'capacity_unavailable',
  StartupFailure = 'startup_failure',
  ProcessFailure = 'process_failure',
  Timeout = 'timeout',
  Cancelled = 'cancelled',
  SchemaInvalidOutput = 'schema_invalid_output',
  StreamIncomplete = 'stream_incomplete',
  ModelAttributionMissing = 'model_attribution_missing',
  UsageAttributionMissing = 'usage_attribution_missing',
  ConfinementViolation = 'confinement_violation',
}

export class ReviewAgentExecutionError extends Error {
  constructor(
    readonly failureClass: ReviewAgentFailureClass,
    readonly retryAfterMs: number | null,
    message: string
  ) {
    super(message);
    this.name = 'ReviewAgentExecutionError';
  }
}
