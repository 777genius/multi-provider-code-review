import { createHash } from 'crypto';
import { ReviewActionV2Client } from '../../control-plane/review-action-v2-client';
import {
  ReviewActionV2OperationId,
  ReviewContextGatewayOpenResultStatus,
  ReviewContextGatewaySealResultStatus,
} from '../../control-plane/generated/review-action-v2/review-action-v2';
import type {
  ContextDependencyAttestationReference,
  ContextGatewaySessionLease,
  ReviewContextAttestationPort,
} from '../application/review-orchestration-ports';
import type { ContextGatewayAttestationPort } from './context-gateway-invocation-session';

export class ReviewActionV2InvestigationContextAttestationAdapter implements ContextGatewayAttestationPort {
  constructor(
    private readonly client: ReviewActionV2Client,
    private readonly authorizationToken: string
  ) {}

  async openGatewaySession(
    input: Parameters<ReviewContextAttestationPort['openGatewaySession']>[0]
  ): Promise<ContextGatewaySessionLease> {
    const result = await this.client.execute(
      ReviewActionV2OperationId.ReviewInvestigationContextGatewayOpen,
      {
        authorizationToken: this.authorizationToken,
        leaseCapability: input.invocationLease.leaseCapability,
        idempotencyKey: deterministicId('investigation-gateway-open', [
          input.invocationLease.attemptId,
          input.invocationLease.leaseId,
          input.invocationLease.fencingToken,
          input.sourceExecutionId,
          input.sourceWorkSlotId,
          input.sourceReviewRevisionHash,
          input.checkoutTreeOid,
          input.gatewayPolicyVersion,
          input.gatewayBinaryHash,
          input.confinementEvidenceHash,
        ]),
        attemptId: input.invocationLease.attemptId,
        sourceLeaseId: input.invocationLease.leaseId,
        fencingToken: input.invocationLease.fencingToken,
        sourceExecutionId: input.sourceExecutionId,
        sourceWorkSlotId: input.sourceWorkSlotId,
        sourceReviewRevisionHash: input.sourceReviewRevisionHash,
        checkoutTreeOid: input.checkoutTreeOid,
        gatewayPolicyVersion: input.gatewayPolicyVersion,
        gatewayBinaryHash: input.gatewayBinaryHash,
        confinementEvidenceHash: input.confinementEvidenceHash,
      }
    );
    if (
      result.status !== ReviewContextGatewayOpenResultStatus.Opened &&
      result.status !== ReviewContextGatewayOpenResultStatus.Idempotent
    ) {
      throw new Error(
        `review_action_v2_investigation_context_gateway_open_${result.status}`
      );
    }
    return Object.freeze({
      sessionId: requireString(result.sessionId, 'context_gateway_session_id'),
      eventChainSeedHash: requireDigest(
        result.eventChainSeedHash,
        'context_gateway_event_chain_seed_hash'
      ),
      sealCapability: requireString(
        result.sealCapability,
        'context_gateway_seal_capability'
      ),
      gatewaySessionSecret: requireString(
        result.gatewaySessionSecret,
        'context_gateway_session_secret'
      ),
      expiresAt: requireTimestamp(
        result.expiresAt,
        'context_gateway_expires_at'
      ),
    });
  }

  async sealGatewaySession(
    input: Parameters<ReviewContextAttestationPort['sealGatewaySession']>[0]
  ): Promise<ContextDependencyAttestationReference | null> {
    const result = await this.client.execute(
      ReviewActionV2OperationId.ReviewInvestigationContextGatewaySeal,
      {
        authorizationToken: this.authorizationToken,
        leaseCapability: input.invocationLease.leaseCapability,
        idempotencyKey: deterministicId('investigation-gateway-seal', [
          input.session.sessionId,
          input.transcriptHash,
          input.replayMaterialHash,
          input.terminalOutcomeHash,
        ]),
        sessionId: input.session.sessionId,
        sealCapability: input.session.sealCapability,
        attemptId: input.invocationLease.attemptId,
        sourceLeaseId: input.invocationLease.leaseId,
        fencingToken: input.invocationLease.fencingToken,
        providerSucceeded: input.providerSucceeded,
        schemaValidated: input.schemaValidated,
        fullyConsumed: input.fullyConsumed,
        actualModel: input.actualModel,
        terminalOutcomeHash: input.terminalOutcomeHash,
        transcriptCanonicalJson: input.transcriptCanonicalJson,
        transcriptHash: input.transcriptHash,
        replayMaterialCanonicalJson: input.replayMaterialCanonicalJson,
        replayMaterialHash: input.replayMaterialHash,
      }
    );
    if (
      result.status === ReviewContextGatewaySealResultStatus.Denied ||
      result.status === ReviewContextGatewaySealResultStatus.Conflict
    ) {
      return null;
    }
    if (
      result.status !== ReviewContextGatewaySealResultStatus.Accepted &&
      result.status !== ReviewContextGatewaySealResultStatus.Idempotent
    ) {
      throw new Error(
        `review_action_v2_investigation_context_gateway_seal_${result.status}`
      );
    }
    return Object.freeze({
      attestationId: requireString(
        result.attestationId,
        'context_gateway_attestation_id'
      ),
      attestationHash: requireDigest(
        result.attestationHash,
        'context_gateway_attestation_hash'
      ),
    });
  }
}

function deterministicId(namespace: string, parts: readonly string[]): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(parts), 'utf8')
    .digest('hex')
    .slice(0, 40);
  return `rr:${namespace}:${digest}`;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`review_action_v2_${field}_missing`);
  }
  return value;
}

function requireDigest(value: unknown, field: string): string {
  const parsed = requireString(value, field);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) {
    throw new Error(`review_action_v2_${field}_invalid`);
  }
  return parsed;
}

function requireTimestamp(value: unknown, field: string): string {
  const parsed = requireString(value, field);
  if (!Number.isFinite(Date.parse(parsed))) {
    throw new Error(`review_action_v2_${field}_invalid`);
  }
  return parsed;
}
