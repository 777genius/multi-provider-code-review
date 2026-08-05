import type { ReviewAgentExecutionSession } from './review-agent-port';
import type { ReviewInvestigationLease } from './investigation-control-plane-port';
import type {
  ReviewAgentExecutionProfile,
  ReviewAgentProviderKind,
} from '../domain/runtime-profile';

export type ReviewInvestigationTurnExecutionAuthority = Readonly<{
  preparedManifestKey: string;
  providerInvocationKey: string;
  providerKind: ReviewAgentProviderKind;
  requestedModel: string;
  executionProfile: ReviewAgentExecutionProfile;
  toolPolicyHash: string;
}>;

export type AcceptedInvestigationAttestation = Readonly<{
  attestationId: string;
  attestationHash: string;
}>;

export type ReviewInvestigationGatewayRevision = Readonly<{
  baseSha: string;
  mergeBaseSha: string;
  headSha: string;
}>;

export type ReviewInvestigationGatewayOpenInput = Readonly<{
  executionId: string;
  workSlotId: string;
  reviewRevisionHash: string;
  investigationId: string;
  turnId: string;
  lease: ReviewInvestigationLease;
}>;

export enum ReviewInvestigationGatewayConfigurationFailureReason {
  ContextGatewayPolicyMismatch = 'context_gateway_policy_mismatch',
}

export class ReviewInvestigationGatewayConfigurationError extends Error {
  constructor(
    readonly reason: ReviewInvestigationGatewayConfigurationFailureReason,
    options: ErrorOptions = {}
  ) {
    super(
      `review_investigation_gateway_configuration_mismatch:${reason}`,
      options
    );
    this.name = 'ReviewInvestigationGatewayConfigurationError';
  }
}

export interface ReviewInvestigationGatewaySessionPort {
  readonly agentSession: ReviewAgentExecutionSession;
  seal(input: {
    readonly actualModel: string;
    readonly terminalOutcomeHash: string;
  }): Promise<AcceptedInvestigationAttestation>;
  dispose(): Promise<void>;
}

export interface ReviewInvestigationGatewaySessionFactoryPort {
  readonly executionAuthority: ReviewInvestigationTurnExecutionAuthority;
  open(
    input: ReviewInvestigationGatewayOpenInput
  ): Promise<ReviewInvestigationGatewaySessionPort>;
}
