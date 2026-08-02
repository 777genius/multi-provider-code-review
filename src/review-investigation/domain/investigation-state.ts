import type {
  ReviewTurnObligationKind,
  ReviewTurnPurpose,
} from './turn-observation';

export enum ReviewInvestigationState {
  Provisional = 'provisional',
  AwaitingTurn = 'awaiting_turn',
  TurnLeased = 'turn_leased',
  AwaitingCritic = 'awaiting_critic',
  ReadyToConclude = 'ready_to_conclude',
  Concluded = 'concluded',
  Inconclusive = 'inconclusive',
  Superseded = 'superseded',
  Expired = 'expired',
}

export enum ReviewInvestigationNextAction {
  RunTurn = 'run_turn',
  RunCritic = 'run_critic',
  AwaitCapacity = 'await_capacity',
  Conclude = 'conclude',
  Terminal = 'terminal',
}

export enum ReviewInvestigationAbortReason {
  CapacityUnavailable = 'capacity_unavailable',
  AuthenticationUnavailable = 'authentication_unavailable',
  RetryableInfrastructureFailure = 'retryable_infrastructure_failure',
  Timeout = 'timeout',
  Cancelled = 'cancelled',
  ConfinementViolation = 'confinement_violation',
  SchemaInvalidOutput = 'schema_invalid_output',
  StaleExecution = 'stale_execution',
  SupersededExecution = 'superseded_execution',
}

export enum ReviewInvestigationObligationOrigin {
  CoverageContract = 'coverage_contract',
  DeterministicExpansion = 'deterministic_expansion',
  AgentProposal = 'agent_proposal',
  CriticProposal = 'critic_proposal',
}

export type ReviewInvestigationTurnBrief = Readonly<{
  briefVersion: 1;
  investigationId: string;
  investigationVersion: number;
  dossierDigest: string;
  turnId: string;
  purpose: ReviewTurnPurpose;
  obligations: readonly Readonly<{
    obligationId: string;
    kind: ReviewTurnObligationKind;
    canonicalSubject: string;
    canonicalRequirement: string;
    riskPriority: number;
    origin: ReviewInvestigationObligationOrigin;
  }>[];
}>;

export type ReviewInvestigationTurn = Readonly<{
  turnId: string;
  purpose: ReviewTurnPurpose;
  leasedAtVersion: number;
  dossierDigest: string;
  obligationIds: readonly string[];
  semanticTurnOrdinal: number;
  criticCycleOrdinal: number;
  leasedAt: string;
  expiresAt: string;
  turnCapability: string;
  brief: ReviewInvestigationTurnBrief | null;
}>;

export type ReviewInvestigationSnapshot = Readonly<{
  investigationId: string;
  version: number;
  state: ReviewInvestigationState;
  dossierDigest: string;
  openObligationCount: number;
  satisfiedObligationCount: number;
  unresolvableObligationCount: number;
  findingCount: number;
  semanticTurns: number;
  operationalAttempts: number;
  criticCycles: number;
  nextEligibleAt: string | null;
  nextAction: ReviewInvestigationNextAction;
  turn: ReviewInvestigationTurn | null;
}>;

export enum ReviewInvestigationRunStatus {
  Completed = 'completed',
  Parked = 'parked',
  Superseded = 'superseded',
  RecoveryRequired = 'recovery_required',
  TransitionBudgetExhausted = 'transition_budget_exhausted',
}

export type ReviewInvestigationRunResult = Readonly<{
  status: ReviewInvestigationRunStatus;
  snapshot: ReviewInvestigationSnapshot;
}>;
