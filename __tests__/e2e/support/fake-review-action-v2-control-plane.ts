import { createServer, type Server } from 'http';
import {
  ReviewActionV2OperationId,
  ReviewContextGatewayOpenResultStatus,
  ReviewContextGatewaySealResultStatus,
  ReviewContextReceiptReplayCommitResultStatus,
  ReviewInvestigationMutationResultStatus,
  ReviewInvestigationNextAction as PublishedNextAction,
  ReviewInvestigationOpenResultStatus,
  ReviewInvestigationPublishedConclusion,
  ReviewInvestigationPublishedState,
  ReviewInvestigationReplayPrepareResultStatus,
  ReviewInvestigationRestoreResultStatus,
  ReviewRunAuthorizationResultStatus,
  parseReviewActionV2Request,
  reviewActionV2Operations,
  reviewActionV2PublishedProtocolVersion,
  reviewActionV2PublishedSchemaDigest,
} from '../../../src/control-plane/generated/review-action-v2/review-action-v2';
import {
  canonicalJson,
  sha256,
} from '../../../src/review-investigation/domain/canonical-json';
import {
  ReviewInvestigationConclusion,
  ReviewInvestigationNextAction,
  ReviewInvestigationObligationOrigin,
  ReviewInvestigationState,
} from '../../../src/review-investigation/domain/investigation-state';
import { ReviewAgentProviderKind } from '../../../src/review-investigation/domain/runtime-profile';
import {
  parseReviewTurnObligationProposals,
  ReviewTurnCriticDecision,
  ReviewTurnObligationKind,
  ReviewTurnPurpose,
} from '../../../src/review-investigation/domain/turn-observation';

type JsonRecord = Record<string, unknown>;

const PROVIDER_PROPOSAL_RISK_FLOOR = 800_000;

export type FakeObligation = {
  obligationId: string;
  kind: ReviewTurnObligationKind;
  canonicalSubject: string;
  canonicalRequirement: string;
  riskPriority: number;
  origin: ReviewInvestigationObligationOrigin;
  status: 'open' | 'satisfied' | 'unresolvable';
};

type FakeTurn = {
  turnId: string;
  purpose: ReviewTurnPurpose;
  leasedAtVersion: number;
  dossierDigest: string;
  obligationIds: string[];
  semanticTurnOrdinal: number;
  criticCycleOrdinal: number;
  leasedAt: string;
  expiresAt: string;
};

type FakeInvestigation = {
  investigationId: string;
  naturalKey: string;
  authorizationId: string;
  reviewRevisionHash: string;
  version: number;
  state: ReviewInvestigationState;
  nextAction: ReviewInvestigationNextAction;
  nextEligibleAt: string | null;
  obligations: FakeObligation[];
  turn: FakeTurn | null;
  semanticTurns: number;
  operationalAttempts: number;
  criticCycles: number;
  criticAccepted: boolean;
  findingCount: number;
  findings: JsonRecord[];
  lastProviderKind: ReviewAgentProviderKind | null;
  lastActualModel: string | null;
  terminalProviderKind: ReviewAgentProviderKind | null;
  terminalActualModel: string | null;
  terminalObservationCanonicalJson: string | null;
  terminalOutcomeHash: string | null;
  certificateId: string | null;
  certificateHash: string | null;
  conclusion: ReviewInvestigationConclusion | null;
  expansionKeys: string[];
};

type FakeGatewaySession = {
  sessionId: string;
  secret: string;
  eventChainSeedHash: string;
  sealCapability: string;
  transcript: JsonRecord | null;
  attestationId: string | null;
  attestationHash: string | null;
};

export type FakeControlPlaneStore = {
  investigations: Map<string, FakeInvestigation>;
  sessions: Map<string, FakeGatewaySession>;
  attestations: Map<string, FakeGatewaySession>;
  idempotentResults: Map<string, unknown>;
  operationCounts: Map<ReviewActionV2OperationId, number>;
  sealedTranscripts: JsonRecord[];
  replayPreparation: JsonRecord | null;
  replayProofAccepted: boolean;
  abortReasons: string[];
  dropResponseOnce: Set<ReviewActionV2OperationId>;
};

export function createFakeControlPlaneStore(): FakeControlPlaneStore {
  return {
    investigations: new Map(),
    sessions: new Map(),
    attestations: new Map(),
    idempotentResults: new Map(),
    operationCounts: new Map(),
    sealedTranscripts: [],
    replayPreparation: null,
    replayProofAccepted: false,
    abortReasons: [],
    dropResponseOnce: new Set(),
  };
}

export class FakeReviewActionV2ControlPlane {
  private server: Server | null = null;
  private origin: string | null = null;

  constructor(
    readonly store: FakeControlPlaneStore,
    private readonly revision: Readonly<{
      baseSha: string;
      mergeBaseSha: string;
      headSha: string;
      reviewRevisionHash: string;
    }>
  ) {}

  get apiUrl(): string {
    if (!this.origin) throw new Error('fake_control_plane_not_started');
    return this.origin;
  }

  async start(): Promise<void> {
    if (this.server) throw new Error('fake_control_plane_already_started');
    this.server = createServer((request, response) => {
      void this.handle(request.url ?? '', request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('fake_control_plane_address_invalid');
    }
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.origin = null;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  private async handle(
    url: string,
    request: import('http').IncomingMessage,
    response: import('http').ServerResponse
  ): Promise<void> {
    try {
      const descriptor = reviewActionV2Operations.find(
        (item) => item.path === url && item.method === request.method
      );
      if (!descriptor) throw new Error('fake_control_plane_route_unknown');
      const operation = descriptor.operationId as ReviewActionV2OperationId;
      this.store.operationCounts.set(
        operation,
        (this.store.operationCounts.get(operation) ?? 0) + 1
      );
      const body = JSON.parse(await readBody(request)) as unknown;
      const parsed = parseReviewActionV2Request(operation, body);
      if (!parsed.ok) throw new Error('fake_control_plane_request_invalid');
      const requestBody = parsed.value as unknown as JsonRecord;
      const result = this.dispatch(operation, requestBody);
      if (this.store.dropResponseOnce.delete(operation)) {
        response.destroy();
        return;
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          protocolVersion: reviewActionV2PublishedProtocolVersion,
          schemaDigest: reviewActionV2PublishedSchemaDigest,
          requestId: requestBody.requestId,
          serverTime: now(),
          result,
        })
      );
    } catch (error) {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }

  private dispatch(
    operation: ReviewActionV2OperationId,
    request: JsonRecord
  ): unknown {
    const idempotencyKey = optionalString(request.idempotencyKey);
    const cacheIdempotentResult =
      operation !== ReviewActionV2OperationId.ReviewInvestigationOpen;
    if (idempotencyKey && cacheIdempotentResult) {
      const existing = this.store.idempotentResults.get(idempotencyKey);
      if (existing !== undefined) return existing;
    }
    let result: unknown;
    switch (operation) {
      case ReviewActionV2OperationId.ReviewRunAuthorize:
        result = this.authorize();
        break;
      case ReviewActionV2OperationId.ReviewInvestigationOpen:
        result = this.openInvestigation(request);
        break;
      case ReviewActionV2OperationId.ReviewInvestigationRestore:
        result = this.restoreInvestigation(request);
        break;
      case ReviewActionV2OperationId.ReviewInvestigationTurnPlan:
        result = this.planTurn(request);
        break;
      case ReviewActionV2OperationId.ReviewContextGatewayOpen:
        result = this.openGateway(request);
        break;
      case ReviewActionV2OperationId.ReviewContextGatewaySeal:
        result = this.sealGateway(request);
        break;
      case ReviewActionV2OperationId.ReviewInvestigationTurnCommit:
        result = this.commitTurn(request);
        break;
      case ReviewActionV2OperationId.ReviewInvestigationTurnAbort:
        result = this.abortTurn(request);
        break;
      case ReviewActionV2OperationId.ReviewInvestigationConclude:
        result = this.conclude(request);
        break;
      case ReviewActionV2OperationId.ReviewInvestigationReplayPrepare:
        result = this.prepareReplay();
        break;
      case ReviewActionV2OperationId.ReviewContextReceiptReplayCommit:
        result = this.commitReceiptReplay(request);
        break;
      case ReviewActionV2OperationId.ReviewInvestigationReplay:
        result = this.replayInvestigation(request);
        break;
      default:
        throw new Error(
          `fake_control_plane_operation_unsupported:${operation}`
        );
    }
    if (idempotencyKey && cacheIdempotentResult) {
      this.store.idempotentResults.set(idempotencyKey, result);
    }
    return result;
  }

  private authorize() {
    const limits = Object.fromEntries(
      [
        'maxAttemptsPerSlot',
        'maxLeaseDurationMs',
        'maxObservationBytes',
        'maxObservationFindings',
        'maxProjectionBytes',
        'maxProjectionFindings',
        'maxPublicationBodyBytes',
        'maxPublicationChunks',
        'maxPublicationOperations',
        'maxReconciliationDurationMs',
        'maxRequestBatchSize',
        'maxResultReportDurationMs',
        'maxWorkSlots',
      ].map((key) => [key, 10_000])
    );
    const facts = {
      workspaceId: 'workspace-e2e',
      repositoryConnectionId: 'connection-e2e',
      scmRepositoryIdentityId: 'repository-e2e',
      pullRequestNumber: 1,
      sourceRunId: 'run-e2e',
      sourceRunAttempt: '1',
      ...this.revision,
      trustDomain: 'test',
      producerReleaseId: 'producer-release-e2e',
      selectedProtocolVersion: reviewActionV2PublishedProtocolVersion,
      schemaDigest: reviewActionV2PublishedSchemaDigest,
      providerVoteLanes: [
        {
          providerKind: 'codex',
          providerVoteIdentityHash: sha256('provider-vote-e2e'),
        },
      ],
    };
    return {
      status: ReviewRunAuthorizationResultStatus.Authorized,
      authorizationId: 'authorization-e2e',
      authorizationToken: 'authorization.token.e2e',
      producerReleaseId: 'producer-release-e2e',
      protocolLimitsProfileId: 'limits-e2e',
      operationalSloProfileId: 'slo-e2e',
      mutationEpoch: '1',
      expiresAt: '2026-08-04T00:00:00.000Z',
      authorizationFactsCanonicalJson: canonicalJson(facts),
      protocolLimitsCanonicalJson: canonicalJson(limits),
    };
  }

  private openInvestigation(request: JsonRecord) {
    const naturalKey = [
      string(request.executionId),
      string(request.workSlotId),
      string(request.reviewRevisionHash),
      string(request.stableReviewUnitKey),
      string(request.providerVoteLaneId),
    ].join(':');
    let investigation = this.store.investigations.get(naturalKey);
    let status = ReviewInvestigationOpenResultStatus.Restored;
    if (!investigation) {
      const seedEnvelope = object(
        JSON.parse(string(request.seedObligationsCanonicalJson))
      );
      const seeds = array(seedEnvelope.obligations).map((seed) =>
        parseSeedObligation(seed)
      );
      investigation = {
        investigationId: `investigation-${sha256(naturalKey).slice(0, 16)}`,
        naturalKey,
        authorizationId: string(request.authorizationId),
        reviewRevisionHash: string(request.reviewRevisionHash),
        version: 1,
        state: ReviewInvestigationState.AwaitingTurn,
        nextAction: ReviewInvestigationNextAction.RunTurn,
        nextEligibleAt: null,
        obligations: seeds,
        turn: null,
        semanticTurns: 0,
        operationalAttempts: 0,
        criticCycles: 0,
        criticAccepted: false,
        findingCount: 0,
        findings: [],
        lastProviderKind: null,
        lastActualModel: null,
        terminalProviderKind: null,
        terminalActualModel: null,
        terminalObservationCanonicalJson: null,
        terminalOutcomeHash: null,
        certificateId: null,
        certificateHash: null,
        conclusion: null,
        expansionKeys: [],
      };
      this.store.investigations.set(naturalKey, investigation);
      status = ReviewInvestigationOpenResultStatus.Opened;
    }
    return mutationResult(investigation, status);
  }

  private restoreInvestigation(request: JsonRecord) {
    const investigation = [...this.store.investigations.values()].find(
      (item) =>
        item.investigationId === request.investigationId &&
        item.reviewRevisionHash === request.reviewRevisionHash
    );
    if (!investigation) {
      return { status: ReviewInvestigationRestoreResultStatus.Missing };
    }
    return mutationResult(
      investigation,
      ReviewInvestigationRestoreResultStatus.Found
    );
  }

  private planTurn(request: JsonRecord) {
    const investigation = requireInvestigation(this.store, request);
    if (investigation.turn === null) {
      const open = investigation.obligations
        .filter((item) => item.status === 'open')
        .sort((left, right) =>
          left.obligationId.localeCompare(right.obligationId)
        );
      const purpose =
        open.length > 0
          ? ReviewTurnPurpose.Discovery
          : ReviewTurnPurpose.Critic;
      const selected = open.slice(0, number(request.maxObligationsForTurn));
      investigation.version += 1;
      investigation.operationalAttempts += 1;
      if (purpose === ReviewTurnPurpose.Critic) investigation.criticCycles += 1;
      const dossierDigest = dossier(investigation);
      investigation.turn = {
        turnId: `turn-${investigation.version}`,
        purpose,
        leasedAtVersion: investigation.version,
        dossierDigest,
        obligationIds: selected.map((item) => item.obligationId),
        semanticTurnOrdinal:
          purpose === ReviewTurnPurpose.Discovery
            ? investigation.semanticTurns + 1
            : investigation.semanticTurns,
        criticCycleOrdinal: investigation.criticCycles,
        leasedAt: now(),
        expiresAt: '2026-08-03T23:00:00.000Z',
      };
      investigation.state = ReviewInvestigationState.TurnLeased;
      investigation.nextAction =
        purpose === ReviewTurnPurpose.Critic
          ? ReviewInvestigationNextAction.RunCritic
          : ReviewInvestigationNextAction.RunTurn;
    }
    const result = mutationResult(
      investigation,
      ReviewInvestigationMutationResultStatus.Applied
    ) as JsonRecord;
    const brief = turnBrief(investigation);
    return {
      ...result,
      turnId: investigation.turn!.turnId,
      turnCapability: `turn.capability.${investigation.turn!.turnId}`,
      turnExpiresAt: investigation.turn!.expiresAt,
      turnBriefCanonicalJson: canonicalJson(brief),
      turnBriefHash: sha256(canonicalJson(brief)),
    };
  }

  private openGateway(_request: JsonRecord) {
    const sessionId = `gateway-session-${this.store.sessions.size + 1}`;
    const session: FakeGatewaySession = {
      sessionId,
      secret: Buffer.alloc(32, (this.store.sessions.size % 200) + 1).toString(
        'base64url'
      ),
      eventChainSeedHash: sha256(`event-chain:${sessionId}`),
      sealCapability: `seal.capability.${sessionId}`,
      transcript: null,
      attestationId: null,
      attestationHash: null,
    };
    this.store.sessions.set(sessionId, session);
    return {
      status: ReviewContextGatewayOpenResultStatus.Opened,
      sessionId,
      eventChainSeedHash: session.eventChainSeedHash,
      gatewaySessionSecret: session.secret,
      sealCapability: session.sealCapability,
      expiresAt: '2026-08-03T23:00:00.000Z',
    };
  }

  private sealGateway(request: JsonRecord) {
    const session = this.store.sessions.get(string(request.sessionId));
    if (!session) throw new Error('fake_gateway_session_missing');
    const transcriptCanonicalJson = string(request.transcriptCanonicalJson);
    if (sha256(transcriptCanonicalJson) !== request.transcriptHash) {
      throw new Error('fake_gateway_transcript_hash_mismatch');
    }
    const transcript = JSON.parse(transcriptCanonicalJson) as JsonRecord;
    if (
      transcript.complete !== true ||
      transcript.confinementTainted !== false ||
      !Array.isArray(transcript.events)
    ) {
      throw new Error('fake_gateway_transcript_incomplete');
    }
    session.transcript = transcript;
    session.attestationId = `attestation-${session.sessionId}`;
    session.attestationHash = sha256(transcriptCanonicalJson);
    this.store.attestations.set(session.attestationId, session);
    this.store.sealedTranscripts.push(transcript);
    return {
      status: ReviewContextGatewaySealResultStatus.Accepted,
      attestationId: session.attestationId,
      attestationHash: session.attestationHash,
    };
  }

  private commitTurn(request: JsonRecord) {
    const investigation = requireInvestigation(this.store, request);
    const turn = investigation.turn;
    if (!turn || turn.turnId !== request.turnId) {
      throw new Error('fake_investigation_turn_missing');
    }
    const session = this.store.attestations.get(
      string(request.acceptedAttestationId)
    );
    if (
      !session ||
      session.attestationHash !== request.acceptedAttestationHash
    ) {
      throw new Error('fake_investigation_attestation_missing');
    }
    const observation = JSON.parse(
      string(request.turnObservationCanonicalJson)
    ) as JsonRecord;
    const events = successfulEvents(session.transcript!);
    for (const claim of array(observation.closureClaims)) {
      const record = object(claim);
      const obligation = investigation.obligations.find(
        (item) => item.obligationId === record.obligationId
      );
      if (!obligation || obligation.status !== 'open') continue;
      const receipts = new Set(array(record.operationReceiptIds).map(String));
      const evidence = events.filter((event) =>
        receipts.has(String(event.operationReceiptId))
      );
      if (strictlyCovers(obligation, evidence)) obligation.status = 'satisfied';
    }
    for (const claim of array(observation.unresolvableClaims)) {
      const obligationId = String(object(claim).obligationId);
      const obligation = investigation.obligations.find(
        (item) => item.obligationId === obligationId
      );
      if (obligation?.status === 'open') obligation.status = 'unresolvable';
    }
    const proposedObligations = array(observation.obligationProposals);
    const findings = array(observation.findings).map(object);
    if (
      observation.criticDecision === ReviewTurnCriticDecision.Veto &&
      proposedObligations.length === 0 &&
      findings.length === 0
    ) {
      throw new Error('critic_veto_evidence_required');
    }
    recordFakeProviderObligationProposals(
      investigation.obligations,
      proposedObligations
    );
    expandRelations(investigation, events);
    investigation.findings.push(...findings);
    investigation.findingCount = investigation.findings.length;
    investigation.lastProviderKind = enumProvider(
      observation.actualProviderKind
    );
    investigation.lastActualModel = string(observation.actualModel);
    if (turn.purpose === ReviewTurnPurpose.Discovery) {
      investigation.semanticTurns += 1;
    } else if (observation.criticDecision === ReviewTurnCriticDecision.Accept) {
      investigation.criticAccepted = true;
    }
    investigation.turn = null;
    investigation.version += 1;
    const open = investigation.obligations.some(
      (item) => item.status === 'open'
    );
    const unresolvable = investigation.obligations.some(
      (item) => item.status === 'unresolvable'
    );
    if (open) {
      investigation.state = ReviewInvestigationState.AwaitingTurn;
      investigation.nextAction = ReviewInvestigationNextAction.RunTurn;
    } else if (!investigation.criticAccepted && !unresolvable) {
      investigation.state = ReviewInvestigationState.AwaitingCritic;
      investigation.nextAction = ReviewInvestigationNextAction.RunCritic;
    } else {
      investigation.state = unresolvable
        ? ReviewInvestigationState.Inconclusive
        : ReviewInvestigationState.ReadyToConclude;
      investigation.conclusion = unresolvable
        ? ReviewInvestigationConclusion.Inconclusive
        : null;
      investigation.nextAction = ReviewInvestigationNextAction.Conclude;
    }
    return mutationResult(
      investigation,
      ReviewInvestigationMutationResultStatus.Applied
    );
  }

  private abortTurn(request: JsonRecord) {
    const investigation = requireInvestigation(this.store, request);
    const reason = string(request.abortReason);
    this.store.abortReasons.push(reason);
    investigation.turn = null;
    investigation.version += 1;
    if (reason === 'superseded_execution' || reason === 'stale_execution') {
      investigation.state = ReviewInvestigationState.Superseded;
      investigation.nextAction = ReviewInvestigationNextAction.Terminal;
      investigation.nextEligibleAt = null;
    } else if (reason === 'confinement_violation') {
      investigation.state = ReviewInvestigationState.Inconclusive;
      investigation.nextAction = ReviewInvestigationNextAction.Conclude;
      investigation.nextEligibleAt = null;
      investigation.conclusion = ReviewInvestigationConclusion.Inconclusive;
    } else if (request.nextEligibleAt !== null) {
      investigation.state = ReviewInvestigationState.AwaitingTurn;
      investigation.nextAction = ReviewInvestigationNextAction.AwaitCapacity;
      investigation.nextEligibleAt = string(request.nextEligibleAt);
    } else {
      investigation.state = ReviewInvestigationState.AwaitingTurn;
      investigation.nextAction = ReviewInvestigationNextAction.RunTurn;
      investigation.nextEligibleAt = null;
    }
    return mutationResult(
      investigation,
      request.nextEligibleAt === null
        ? ReviewInvestigationMutationResultStatus.Applied
        : ReviewInvestigationMutationResultStatus.Parked
    );
  }

  private conclude(request: JsonRecord) {
    const investigation = requireInvestigation(this.store, request);
    const hasUnresolvable = investigation.obligations.some(
      (item) => item.status === 'unresolvable' || item.status === 'open'
    );
    const isAlreadyInconclusive =
      investigation.state === ReviewInvestigationState.Inconclusive ||
      investigation.conclusion === ReviewInvestigationConclusion.Inconclusive;
    investigation.conclusion =
      isAlreadyInconclusive || hasUnresolvable
        ? ReviewInvestigationConclusion.Inconclusive
        : investigation.findingCount > 0
          ? ReviewInvestigationConclusion.Findings
          : ReviewInvestigationConclusion.VerifiedClean;
    const terminal = canonicalJson({
      payloadVersion: 2,
      normalizedFindings: investigation.findings.map(normalizedFinding),
      normalizedLifecycleRevalidations: [],
      safeUsage: {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      },
    });
    investigation.terminalObservationCanonicalJson = terminal;
    investigation.terminalOutcomeHash = sha256(terminal);
    investigation.terminalProviderKind =
      investigation.lastProviderKind ?? ReviewAgentProviderKind.Codex;
    investigation.terminalActualModel =
      investigation.lastActualModel ?? 'gpt-e2e';
    investigation.certificateId = `certificate-${investigation.investigationId}`;
    investigation.certificateHash = sha256(
      canonicalJson({
        investigationId: investigation.investigationId,
        terminalOutcomeHash: investigation.terminalOutcomeHash,
      })
    );
    investigation.version += 1;
    investigation.state =
      investigation.conclusion === ReviewInvestigationConclusion.Inconclusive
        ? ReviewInvestigationState.Inconclusive
        : ReviewInvestigationState.Concluded;
    investigation.nextAction = ReviewInvestigationNextAction.Terminal;
    return mutationResult(
      investigation,
      ReviewInvestigationMutationResultStatus.Applied
    );
  }

  private prepareReplay() {
    if (!this.store.replayPreparation) {
      return { status: ReviewInvestigationReplayPrepareResultStatus.Missing };
    }
    return this.store.replayPreparation;
  }

  private commitReceiptReplay(request: JsonRecord) {
    const replayCanonicalJson = string(request.replayResultCanonicalJson);
    const replay = object(JSON.parse(replayCanonicalJson));
    this.store.replayProofAccepted = validateReceiptReplay({
      request,
      replay,
      replayCanonicalJson,
      preparation: this.store.replayPreparation,
      attestations: this.store.attestations,
      targetReviewRevisionHash: this.revision.reviewRevisionHash,
    });
    return {
      status: this.store.replayProofAccepted
        ? ReviewContextReceiptReplayCommitResultStatus.Accepted
        : ReviewContextReceiptReplayCommitResultStatus.Denied,
      replayProofId: this.store.replayProofAccepted ? 'replay-proof-e2e' : null,
      replayProofHash: this.store.replayProofAccepted
        ? sha256('replay-proof-e2e')
        : null,
    };
  }

  private replayInvestigation(request: JsonRecord) {
    const proofs = array(
      JSON.parse(string(request.replayProofsCanonicalJson))
    ).map(object);
    if (
      !this.store.replayProofAccepted ||
      proofs.length === 0 ||
      proofs.some((proof) => proof.replayProofId !== 'replay-proof-e2e')
    ) {
      throw new Error('fake_replay_proof_missing');
    }
    const investigation = [...this.store.investigations.values()][0];
    if (!investigation) throw new Error('fake_replay_source_missing');
    return mutationResult(
      investigation,
      ReviewInvestigationMutationResultStatus.Applied
    );
  }
}

function validateReceiptReplay(input: {
  readonly request: JsonRecord;
  readonly replay: JsonRecord;
  readonly replayCanonicalJson: string;
  readonly preparation: JsonRecord | null;
  readonly attestations: ReadonlyMap<string, FakeGatewaySession>;
  readonly targetReviewRevisionHash: string;
}): boolean {
  if (
    input.preparation === null ||
    sha256(input.replayCanonicalJson) !== input.request.replayResultHash ||
    input.request.targetReviewRevisionHash !== input.targetReviewRevisionHash ||
    input.replay.manifestVersion !== 3 ||
    input.replay.complete !== true ||
    input.replay.confinementTainted !== false ||
    input.replay.terminalFailureClass !== null ||
    input.replay.checkoutTreeOid !== input.request.targetCheckoutTreeOid
  ) {
    return false;
  }
  const preparationCanonicalJson =
    input.preparation.replayPreparationCanonicalJson;
  if (typeof preparationCanonicalJson !== 'string') return false;
  const preparation = object(JSON.parse(preparationCanonicalJson));
  const obligation = array(preparation.obligations)
    .map(object)
    .find(
      (candidate) =>
        candidate.replayCapability === input.request.replayCapability
    );
  if (!obligation) return false;
  const sourceAttestationId = string(obligation.contextAttestationId);
  const source = input.attestations.get(sourceAttestationId);
  if (
    !source?.transcript ||
    input.request.attestationId !== sourceAttestationId ||
    input.request.attestationHash !== source.attestationHash
  ) {
    return false;
  }
  const planCanonicalJson = string(obligation.replayPlanCanonicalJson);
  if (sha256(planCanonicalJson) !== obligation.replayPlanHash) return false;
  const plan = object(JSON.parse(planCanonicalJson));
  const selectedReceiptIds = array(plan.sourceOperationReceiptIds).map(String);
  if (
    selectedReceiptIds.length === 0 ||
    sha256(canonicalJson({ operationReceiptIds: selectedReceiptIds })) !==
      obligation.sourceOperationReceiptIdsHash ||
    input.replay.gatewayPolicyVersion !== plan.gatewayPolicyVersion ||
    input.replay.gatewayBinaryHash !== plan.gatewayBinaryHash
  ) {
    return false;
  }
  const selected = new Set(selectedReceiptIds);
  const sourceEvents = successfulEvents(source.transcript).filter((event) =>
    selected.has(String(event.operationReceiptId))
  );
  const targetEvents = array(input.replay.events)
    .map(object)
    .filter(
      (event) =>
        event.outcome === 'succeeded' &&
        typeof event.operationReceiptId === 'string' &&
        event.result !== null
    );
  if (
    sourceEvents.length !== selected.size ||
    targetEvents.length !== sourceEvents.length
  ) {
    return false;
  }
  return sourceEvents.every((sourceEvent, index) => {
    const targetEvent = targetEvents[index];
    return (
      targetEvent !== undefined &&
      sourceEvent.operationKind === targetEvent.operationKind &&
      canonicalJson(
        comparableReplayResult(sourceEvent) as Parameters<
          typeof canonicalJson
        >[0]
      ) ===
        canonicalJson(
          comparableReplayResult(targetEvent) as Parameters<
            typeof canonicalJson
          >[0]
        )
    );
  });
}

function comparableReplayResult(event: JsonRecord): JsonRecord {
  const result = { ...object(event.result) };
  delete result.treeOid;
  if (
    event.operationKind === 'directory_list' ||
    event.operationKind === 'text_search' ||
    event.operationKind === 'canonical_inventory'
  ) {
    delete result.queryDigest;
    delete result.cursorInputHash;
    delete result.nextCursorHash;
  }
  return result;
}

function mutationResult(
  investigation: FakeInvestigation,
  status:
    | ReviewInvestigationOpenResultStatus
    | ReviewInvestigationRestoreResultStatus
    | ReviewInvestigationMutationResultStatus
) {
  const readModel = investigationReadModel(investigation);
  return {
    status,
    investigationId: investigation.investigationId,
    investigationVersion: String(investigation.version),
    investigationState: publishedState(investigation.state),
    dossierDigest: readModel.dossierDigest,
    nextAction: publishedNextAction(investigation.nextAction),
    investigationCanonicalJson: canonicalJson(readModel),
    certificateId: investigation.certificateId,
    certificateHash: investigation.certificateHash,
    terminalProviderKind: investigation.terminalProviderKind,
    terminalActualModel: investigation.terminalActualModel,
    terminalObservationCanonicalJson:
      investigation.terminalObservationCanonicalJson,
    terminalOutcomeHash: investigation.terminalOutcomeHash,
    investigationConclusion: publishedConclusion(investigation.conclusion),
  };
}

function investigationReadModel(investigation: FakeInvestigation) {
  return {
    investigationId: investigation.investigationId,
    version: investigation.version,
    state: investigation.state,
    dossierDigest: dossier(investigation),
    openObligationCount: investigation.obligations.filter(
      (item) => item.status === 'open'
    ).length,
    satisfiedObligationCount: investigation.obligations.filter(
      (item) => item.status === 'satisfied'
    ).length,
    unresolvableObligationCount: investigation.obligations.filter(
      (item) => item.status === 'unresolvable'
    ).length,
    findingCount: investigation.findingCount,
    semanticTurns: investigation.semanticTurns,
    operationalAttempts: investigation.operationalAttempts,
    criticCycles: investigation.criticCycles,
    nextEligibleAt: investigation.nextEligibleAt,
    nextAction: investigation.nextAction,
    turn: investigation.turn,
    certificateId: investigation.certificateId,
    certificateHash: investigation.certificateHash,
    terminalProviderKind: investigation.terminalProviderKind,
    terminalActualModel: investigation.terminalActualModel,
    terminalObservationCanonicalJson:
      investigation.terminalObservationCanonicalJson,
    terminalOutcomeHash: investigation.terminalOutcomeHash,
    conclusion: investigation.conclusion,
  };
}

function turnBrief(investigation: FakeInvestigation) {
  const turn = investigation.turn!;
  const obligations = turn.obligationIds.map((id) => {
    const obligation = investigation.obligations.find(
      (item) => item.obligationId === id
    );
    if (!obligation) throw new Error('fake_turn_obligation_missing');
    return {
      obligationId: obligation.obligationId,
      kind: obligation.kind,
      canonicalSubject: obligation.canonicalSubject,
      canonicalRequirement: obligation.canonicalRequirement,
      riskPriority: obligation.riskPriority,
      origin: obligation.origin,
    };
  });
  return {
    briefVersion: 1,
    investigationId: investigation.investigationId,
    investigationVersion: investigation.version,
    dossierDigest: dossier(investigation),
    turnId: turn.turnId,
    purpose: turn.purpose,
    maximumSemanticRiskPriority: Math.max(
      0,
      ...investigation.obligations.map((item) => item.riskPriority)
    ),
    obligations,
  };
}

function dossier(investigation: FakeInvestigation): string {
  return sha256(
    canonicalJson({
      investigationId: investigation.investigationId,
      version: investigation.version,
      obligations: investigation.obligations.map((item) => ({
        obligationId: item.obligationId,
        status: item.status,
      })),
      criticAccepted: investigation.criticAccepted,
      findingCount: investigation.findingCount,
    })
  );
}

function parseSeedObligation(
  value: unknown,
  origin = ReviewInvestigationObligationOrigin.CoverageContract
): FakeObligation {
  const seed = object(value);
  const kind = enumObligationKind(seed.kind);
  const canonicalSubject = string(seed.canonicalSubject);
  const canonicalRequirement = string(seed.canonicalRequirement);
  const riskPriority = number(seed.riskPriority);
  return {
    obligationId: sha256(
      canonicalJson({ kind, canonicalSubject, canonicalRequirement })
    ),
    kind,
    canonicalSubject,
    canonicalRequirement,
    riskPriority,
    origin,
    status: 'open',
  };
}

function addObligation(
  investigation: FakeInvestigation,
  obligation: FakeObligation
): void {
  addUniqueObligation(investigation.obligations, obligation);
}

export function recordFakeProviderObligationProposals(
  obligations: FakeObligation[],
  value: unknown
): void {
  for (const proposal of parseReviewTurnObligationProposals(value)) {
    addUniqueObligation(
      obligations,
      parseSeedObligation(
        {
          ...proposal,
          riskPriority: Math.max(
            proposal.riskPriority,
            PROVIDER_PROPOSAL_RISK_FLOOR
          ),
        },
        ReviewInvestigationObligationOrigin.AgentProposal
      )
    );
  }
}

function addUniqueObligation(
  obligations: FakeObligation[],
  obligation: FakeObligation
): void {
  if (
    !obligations.some(
      (candidate) => candidate.obligationId === obligation.obligationId
    )
  ) {
    obligations.push(obligation);
  }
}

function expandRelations(
  investigation: FakeInvestigation,
  events: readonly JsonRecord[]
): void {
  for (const obligation of investigation.obligations) {
    if (obligation.status !== 'satisfied') continue;
    const requirement = parseRequirement(obligation.canonicalRequirement);
    if (requirement.kind !== 'complete_page_chain') continue;
    const pages = pageChain(
      events,
      string(requirement.initialOperationInputHash)
    );
    const terminal = pages.at(-1);
    if (!terminal || number(terminal.result.aggregatePathCount) === 0) continue;
    const expansionKey = [
      obligation.kind,
      requirement.initialOperationInputHash,
      terminal.result.aggregateHash,
      terminal.result.aggregatePathSetHash,
    ].join(':');
    if (investigation.expansionKeys.includes(expansionKey)) continue;
    investigation.expansionKeys.push(expansionKey);
    const kind = relationKind(obligation.kind);
    if (!kind) continue;
    const relationRequirement = canonicalJson({
      requirementVersion: 1,
      kind: 'complete_relation_context',
      initialOperationInputHash: string(requirement.initialOperationInputHash),
      aggregateHash: string(terminal.result.aggregateHash),
      requiredPathCount: number(terminal.result.aggregatePathCount),
      requiredPathSetHash: string(terminal.result.aggregatePathSetHash),
      query: string(requirement.query),
      sourcePath: string(requirement.sourcePath),
      revision: 'head',
    });
    addObligation(
      investigation,
      parseSeedObligation(
        {
          kind,
          canonicalSubject: canonicalJson({
            aggregateHash: string(terminal.result.aggregateHash),
            aggregatePathSetHash: string(terminal.result.aggregatePathSetHash),
            initialOperationInputHash: string(
              requirement.initialOperationInputHash
            ),
            kind: 'relation_context',
            obligationKind: kind,
            subjectVersion: 1,
          }),
          canonicalRequirement: relationRequirement,
          riskPriority: obligation.riskPriority,
        },
        ReviewInvestigationObligationOrigin.DeterministicExpansion
      )
    );
  }
}

function strictlyCovers(
  obligation: FakeObligation,
  events: readonly JsonRecord[]
): boolean {
  try {
    const requirement = parseRequirement(obligation.canonicalRequirement);
    switch (requirement.kind) {
      case 'complete_inventory':
        return completePageChain(events, 'canonical_inventory', null);
      case 'complete_changed_file':
      case 'complete_file':
        return completeFile(
          events,
          string(requirement.pathHash),
          string(requirement.revision)
        );
      case 'complete_page_chain':
        return completePageChain(
          events,
          string(requirement.operationKind),
          string(requirement.initialOperationInputHash)
        );
      case 'complete_relation_context': {
        const pages = pageChain(
          events,
          string(requirement.initialOperationInputHash)
        );
        if (!verifyPageChain(pages, 'text_search')) return false;
        const terminal = pages.at(-1)!.result;
        if (
          terminal.aggregateHash !== requirement.aggregateHash ||
          terminal.aggregatePathCount !== requirement.requiredPathCount ||
          terminal.aggregatePathSetHash !== requirement.requiredPathSetHash
        ) {
          return false;
        }
        const required = new Set(
          pages.flatMap((page) => strings(page.result.pagePathHashes))
        );
        const read = new Set(
          successfulFileGroups(events)
            .filter((group) => completeFileGroup(group, 'head'))
            .map((group) => String(object(group[0]!.result).pathHash))
        );
        return (
          required.size === number(requirement.requiredPathCount) &&
          [...required].every((pathHash) => read.has(pathHash))
        );
      }
      case 'complete_git_fact':
        return events.some(
          (event) =>
            event.operationKind === 'git_fact' &&
            object(event.result).fact === requirement.fact &&
            object(event.result).complete === true
        );
      default:
        return false;
    }
  } catch {
    return false;
  }
}

function completePageChain(
  events: readonly JsonRecord[],
  kind: string,
  initialOperationInputHash: string | null
): boolean {
  const pages =
    initialOperationInputHash === null
      ? events.filter((event) => event.operationKind === kind).map(page)
      : pageChain(events, initialOperationInputHash);
  return verifyPageChain(pages, kind);
}

function pageChain(
  events: readonly JsonRecord[],
  initialOperationInputHash: string
): ReturnType<typeof page>[] {
  const first = events.find(
    (event) =>
      event.operationKind === 'text_search' &&
      object(event.operation).inputHash === initialOperationInputHash
  );
  if (!first) return [];
  const queryDigest = object(first.result).queryDigest;
  return events
    .filter(
      (event) =>
        event.operationKind === first.operationKind &&
        object(event.result).queryDigest === queryDigest
    )
    .map(page)
    .sort((left, right) => left.pageOrdinal - right.pageOrdinal);
}

function page(event: JsonRecord) {
  const result = object(event.result);
  return {
    operation: object(event.operation),
    operationKind: string(event.operationKind),
    pageOrdinal: number(result.pageOrdinal),
    result,
  };
}

function verifyPageChain(
  pages: readonly ReturnType<typeof page>[],
  kind: string
): boolean {
  if (pages.length === 0 || pages[0]!.pageOrdinal !== 0) return false;
  let expectedCursor: string | null = null;
  let aggregateItems = 0;
  const pathHashes = new Set<string>();
  for (const [index, current] of pages.entries()) {
    const result = current.result;
    aggregateItems += number(result.pageItemCount);
    if (
      current.operationKind !== kind ||
      current.pageOrdinal !== index ||
      result.cursorInputHash !== expectedCursor ||
      result.aggregateItemCount !== aggregateItems
    ) {
      return false;
    }
    for (const pathHash of strings(result.pagePathHashes)) {
      if (pathHashes.has(pathHash)) return false;
      pathHashes.add(pathHash);
    }
    if (result.aggregatePathCount !== pathHashes.size) return false;
    const terminal = index === pages.length - 1;
    if (
      terminal
        ? result.complete !== true || result.nextCursorHash !== null
        : result.complete !== false || typeof result.nextCursorHash !== 'string'
    ) {
      return false;
    }
    expectedCursor = result.nextCursorHash as string | null;
  }
  return true;
}

function completeFile(
  events: readonly JsonRecord[],
  pathHash: string,
  revision: string
): boolean {
  const group = events.filter(
    (event) =>
      event.operationKind === 'file_read' &&
      object(event.result).pathHash === pathHash
  );
  return completeFileGroup(group, revision);
}

function completeFileGroup(
  events: readonly JsonRecord[],
  revision: string
): boolean {
  if (events.length === 0) return false;
  const sorted = [...events].sort(
    (left, right) =>
      number(object(left.result).startByte) -
      number(object(right.result).startByte)
  );
  let covered = 0;
  let eof = false;
  for (const event of sorted) {
    const result = object(event.result);
    if (
      result.revision !== revision ||
      number(result.startByte) > covered ||
      eof
    ) {
      return false;
    }
    covered = Math.max(
      covered,
      number(result.startByte) + number(result.byteCount)
    );
    eof = result.eof === true && result.complete === true;
  }
  return eof;
}

function successfulFileGroups(
  events: readonly JsonRecord[]
): readonly JsonRecord[][] {
  const groups = new Map<string, JsonRecord[]>();
  for (const event of events.filter(
    (candidate) => candidate.operationKind === 'file_read'
  )) {
    const result = object(event.result);
    const key = [result.pathHash, result.revision, result.blobOid].join(':');
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function successfulEvents(transcript: JsonRecord): JsonRecord[] {
  return array(transcript.events)
    .map(object)
    .filter(
      (event) =>
        event.outcome === 'succeeded' &&
        typeof event.operationReceiptId === 'string' &&
        event.result !== null
    );
}

function parseRequirement(value: string): JsonRecord {
  return object(JSON.parse(value));
}

function relationKind(
  kind: ReviewTurnObligationKind
): ReviewTurnObligationKind | null {
  switch (kind) {
    case ReviewTurnObligationKind.DirectReferenceSearch:
      return ReviewTurnObligationKind.DirectCaller;
    case ReviewTurnObligationKind.SchemaContract:
      return ReviewTurnObligationKind.DependencyContract;
    case ReviewTurnObligationKind.ConfigurationContract:
      return ReviewTurnObligationKind.ExternalContract;
    case ReviewTurnObligationKind.MigrationContract:
      return ReviewTurnObligationKind.SchemaContract;
    case ReviewTurnObligationKind.SideEffectParity:
      return ReviewTurnObligationKind.TestEvidence;
    default:
      return null;
  }
}

function requireInvestigation(
  store: FakeControlPlaneStore,
  request: JsonRecord
): FakeInvestigation {
  const result = [...store.investigations.values()].find(
    (item) => item.investigationId === request.investigationId
  );
  if (!result) throw new Error('fake_investigation_missing');
  return result;
}

function publishedState(value: ReviewInvestigationState) {
  return value as unknown as ReviewInvestigationPublishedState;
}

function publishedNextAction(value: ReviewInvestigationNextAction) {
  return value as unknown as PublishedNextAction;
}

function publishedConclusion(value: ReviewInvestigationConclusion | null) {
  return value as unknown as ReviewInvestigationPublishedConclusion | null;
}

function normalizedFinding(finding: JsonRecord) {
  const category = optionalString(finding.category) ?? 'correctness';
  const title = optionalString(finding.title) ?? '';
  const message =
    optionalString(finding.message) ?? optionalString(finding.body) ?? '';
  const line = nullablePositiveInteger(
    finding.startLine ?? finding.line ?? null
  );
  const endLine = nullablePositiveInteger(finding.endLine ?? line);
  const severity =
    finding.severity === 'critical' ||
    finding.severity === 'major' ||
    finding.severity === 'minor'
      ? finding.severity
      : 'minor';
  return {
    category,
    endLine,
    evidence: [],
    message,
    normalizedFailureModeHash: sha256(
      canonicalJson({
        category: normalizeText(category),
        message: normalizeText(message),
        title: normalizeText(title),
      })
    ),
    path: optionalString(finding.path) ?? '',
    placementConfidence: null,
    severity,
    startLine: line,
    suggestion: optionalString(finding.suggestion),
    title,
  } as const;
}

function nullablePositiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : null;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function enumProvider(value: unknown): ReviewAgentProviderKind {
  if (!Object.values(ReviewAgentProviderKind).includes(value as never)) {
    throw new Error('fake_provider_kind_invalid');
  }
  return value as ReviewAgentProviderKind;
}

function enumObligationKind(value: unknown): ReviewTurnObligationKind {
  if (!Object.values(ReviewTurnObligationKind).includes(value as never)) {
    throw new Error('fake_obligation_kind_invalid');
  }
  return value as ReviewTurnObligationKind;
}

function object(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('fake_object_invalid');
  }
  return value as JsonRecord;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('fake_array_invalid');
  return value;
}

function strings(value: unknown): string[] {
  return array(value).map(String);
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('fake_string_invalid');
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function number(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new Error('fake_number_invalid');
  return value as number;
}

function now(): string {
  return '2026-08-03T22:00:00.000Z';
}

async function readBody(
  request: import('http').IncomingMessage
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
