import type { ReviewAgentFailureClass } from './review-agent-port';

export enum ReviewInvestigationOperationalFailurePhase {
  AgentCancel = 'agent_cancel',
  GatewayCleanup = 'gateway_cleanup',
  GatewayOpen = 'gateway_open',
  GatewaySeal = 'gateway_seal',
}

export type ReviewInvestigationOperationalDiagnostic = Readonly<{
  investigationId: string;
  turnId: string;
  phase: ReviewInvestigationOperationalFailurePhase;
  failureClass: ReviewAgentFailureClass;
  code: string;
  retryAfterMs: number | null;
}>;

export interface ReviewInvestigationOperationalDiagnosticPort {
  record(diagnostic: ReviewInvestigationOperationalDiagnostic): Promise<void>;
}
