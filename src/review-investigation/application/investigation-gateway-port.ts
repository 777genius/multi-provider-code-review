import type { ReviewAgentGatewayConfig } from './review-agent-port';
import type { ReviewInvestigationLease } from './investigation-control-plane-port';

export type AcceptedInvestigationAttestation = Readonly<{
  attestationId: string;
  attestationHash: string;
}>;

export interface ReviewInvestigationGatewaySessionPort {
  readonly providerConfig: ReviewAgentGatewayConfig;
  seal(input: {
    readonly actualModel: string;
    readonly terminalOutcomeHash: string;
  }): Promise<AcceptedInvestigationAttestation>;
  dispose(): Promise<void>;
}

export interface ReviewInvestigationGatewaySessionFactoryPort {
  open(input: {
    readonly executionId: string;
    readonly workSlotId: string;
    readonly reviewRevisionHash: string;
    readonly investigationId: string;
    readonly turnId: string;
    readonly lease: ReviewInvestigationLease;
    readonly requestedModel: string;
    readonly providerStrategyId: string;
  }): Promise<ReviewInvestigationGatewaySessionPort>;
}
