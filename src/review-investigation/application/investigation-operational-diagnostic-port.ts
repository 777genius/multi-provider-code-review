import type { ReviewAgentFailureClass } from './review-agent-port';

export enum ReviewInvestigationOperationalFailurePhase {
  AgentPreflight = 'agent_preflight',
  AgentCancel = 'agent_cancel',
  AgentExecution = 'agent_execution',
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
  detailCode: string | null;
  retryAfterMs: number | null;
}>;

export interface ReviewInvestigationOperationalDiagnosticPort {
  record(diagnostic: ReviewInvestigationOperationalDiagnostic): Promise<void>;
}
