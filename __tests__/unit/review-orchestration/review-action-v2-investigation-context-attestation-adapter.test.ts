import { createHash } from 'crypto';
import type { ReviewActionV2Client } from '../../../src/control-plane/review-action-v2-client';
import {
  ReviewActionV2OperationId,
  ReviewContextGatewayOpenResultStatus,
  ReviewContextGatewaySealResultStatus,
} from '../../../src/control-plane/generated/review-action-v2/review-action-v2';
import { ReviewActionV2InvestigationContextAttestationAdapter } from '../../../src/review-orchestration/infrastructure/review-action-v2-investigation-context-attestation-adapter';

describe('ReviewActionV2InvestigationContextAttestationAdapter', () => {
  it.each([
    ReviewContextGatewayOpenResultStatus.Opened,
    ReviewContextGatewayOpenResultStatus.Idempotent,
  ])(
    'opens an investigation shadow gateway session from a %s response',
    async (status) => {
      const execute = jest.fn().mockResolvedValue({
        status,
        sessionId: gatewaySession.sessionId,
        eventChainSeedHash: gatewaySession.eventChainSeedHash,
        sealCapability: gatewaySession.sealCapability,
        gatewaySessionSecret: gatewaySession.gatewaySessionSecret,
        expiresAt: gatewaySession.expiresAt,
      });
      const adapter = createAdapter(execute);

      const result = await adapter.openGatewaySession(openInput);

      expect(execute).toHaveBeenCalledWith(
        ReviewActionV2OperationId.ReviewInvestigationContextGatewayOpen,
        {
          authorizationToken,
          leaseCapability: invocationLease.leaseCapability,
          idempotencyKey: deterministicId('investigation-gateway-open', [
            invocationLease.attemptId,
            invocationLease.leaseId,
            invocationLease.fencingToken,
            openInput.sourceExecutionId,
            openInput.sourceWorkSlotId,
            openInput.sourceReviewRevisionHash,
            openInput.checkoutTreeOid,
            openInput.gatewayPolicyVersion,
            openInput.gatewayBinaryHash,
            openInput.confinementEvidenceHash,
          ]),
          attemptId: invocationLease.attemptId,
          sourceLeaseId: invocationLease.leaseId,
          fencingToken: invocationLease.fencingToken,
          sourceExecutionId: openInput.sourceExecutionId,
          sourceWorkSlotId: openInput.sourceWorkSlotId,
          sourceReviewRevisionHash: openInput.sourceReviewRevisionHash,
          checkoutTreeOid: openInput.checkoutTreeOid,
          gatewayPolicyVersion: openInput.gatewayPolicyVersion,
          gatewayBinaryHash: openInput.gatewayBinaryHash,
          confinementEvidenceHash: openInput.confinementEvidenceHash,
        }
      );
      expect(result).toEqual(gatewaySession);
      expect(Object.isFrozen(result)).toBe(true);
    }
  );

  it.each([
    ReviewContextGatewayOpenResultStatus.Denied,
    ReviewContextGatewayOpenResultStatus.Conflict,
  ])(
    'rejects an investigation shadow gateway open %s response',
    async (status) => {
      const adapter = createAdapter(jest.fn().mockResolvedValue({ status }));

      await expect(adapter.openGatewaySession(openInput)).rejects.toThrow(
        `review_action_v2_investigation_context_gateway_open_${status}`
      );
    }
  );

  it.each([
    [
      'missing session id',
      { sessionId: null },
      'review_action_v2_context_gateway_session_id_missing',
    ],
    [
      'invalid event chain seed hash',
      { eventChainSeedHash: 'not-a-digest' },
      'review_action_v2_context_gateway_event_chain_seed_hash_invalid',
    ],
    [
      'missing seal capability',
      { sealCapability: '' },
      'review_action_v2_context_gateway_seal_capability_missing',
    ],
    [
      'missing session secret',
      { gatewaySessionSecret: undefined },
      'review_action_v2_context_gateway_session_secret_missing',
    ],
    [
      'invalid expiry',
      { expiresAt: 'not-a-timestamp' },
      'review_action_v2_context_gateway_expires_at_invalid',
    ],
  ])('rejects an opened response with %s', async (_, override, message) => {
    const adapter = createAdapter(
      jest.fn().mockResolvedValue({
        status: ReviewContextGatewayOpenResultStatus.Opened,
        ...gatewaySession,
        ...override,
      })
    );

    await expect(adapter.openGatewaySession(openInput)).rejects.toThrow(
      message
    );
  });

  it('rejects an unknown investigation shadow gateway open status', async () => {
    const adapter = createAdapter(
      jest.fn().mockResolvedValue({ status: 'future_status' })
    );

    await expect(adapter.openGatewaySession(openInput)).rejects.toThrow(
      'review_action_v2_investigation_context_gateway_open_future_status'
    );
  });

  it.each([
    ReviewContextGatewaySealResultStatus.Accepted,
    ReviewContextGatewaySealResultStatus.Idempotent,
  ])(
    'seals an investigation shadow gateway session from a %s response',
    async (status) => {
      const execute = jest.fn().mockResolvedValue({
        status,
        attestationId: attestation.attestationId,
        attestationHash: attestation.attestationHash,
      });
      const adapter = createAdapter(execute);

      const result = await adapter.sealGatewaySession(sealInput);

      expect(execute).toHaveBeenCalledWith(
        ReviewActionV2OperationId.ReviewInvestigationContextGatewaySeal,
        {
          authorizationToken,
          leaseCapability: invocationLease.leaseCapability,
          idempotencyKey: deterministicId('investigation-gateway-seal', [
            gatewaySession.sessionId,
            sealInput.transcriptHash,
            sealInput.replayMaterialHash,
            sealInput.terminalOutcomeHash,
          ]),
          sessionId: gatewaySession.sessionId,
          sealCapability: gatewaySession.sealCapability,
          attemptId: invocationLease.attemptId,
          sourceLeaseId: invocationLease.leaseId,
          fencingToken: invocationLease.fencingToken,
          providerSucceeded: sealInput.providerSucceeded,
          schemaValidated: sealInput.schemaValidated,
          fullyConsumed: sealInput.fullyConsumed,
          actualModel: sealInput.actualModel,
          terminalOutcomeHash: sealInput.terminalOutcomeHash,
          transcriptCanonicalJson: sealInput.transcriptCanonicalJson,
          transcriptHash: sealInput.transcriptHash,
          replayMaterialCanonicalJson: sealInput.replayMaterialCanonicalJson,
          replayMaterialHash: sealInput.replayMaterialHash,
        },
        { maxAttempts: 5, retryBaseDelayMs: 1_000 }
      );
      expect(result).toEqual(attestation);
      expect(Object.isFrozen(result)).toBe(true);
    }
  );

  it.each([
    ReviewContextGatewaySealResultStatus.Denied,
    ReviewContextGatewaySealResultStatus.Conflict,
  ])(
    'maps an investigation shadow gateway seal %s response to null',
    async (status) => {
      const adapter = createAdapter(jest.fn().mockResolvedValue({ status }));

      await expect(adapter.sealGatewaySession(sealInput)).resolves.toBeNull();
    }
  );

  it.each([
    [
      'missing attestation id',
      { attestationId: '' },
      'review_action_v2_context_gateway_attestation_id_missing',
    ],
    [
      'invalid attestation hash',
      { attestationHash: 'not-a-digest' },
      'review_action_v2_context_gateway_attestation_hash_invalid',
    ],
  ])('rejects an accepted response with %s', async (_, override, message) => {
    const adapter = createAdapter(
      jest.fn().mockResolvedValue({
        status: ReviewContextGatewaySealResultStatus.Accepted,
        ...attestation,
        ...override,
      })
    );

    await expect(adapter.sealGatewaySession(sealInput)).rejects.toThrow(
      message
    );
  });

  it('rejects an unknown investigation shadow gateway seal status', async () => {
    const adapter = createAdapter(
      jest.fn().mockResolvedValue({ status: 'future_status' })
    );

    await expect(adapter.sealGatewaySession(sealInput)).rejects.toThrow(
      'review_action_v2_investigation_context_gateway_seal_future_status'
    );
  });

  it.each([
    ReviewContextGatewaySealResultStatus.Accepted,
    ReviewContextGatewaySealResultStatus.Idempotent,
  ])(
    'terminalizes a failed investigation shadow gateway from %s',
    async (status) => {
      const execute = jest.fn().mockResolvedValue({ status });
      const adapter = createAdapter(execute);

      await expect(
        adapter.abandonGatewaySession({
          invocationLease,
          session: gatewaySession,
        })
      ).resolves.toBeUndefined();
      expect(execute).toHaveBeenCalledWith(
        ReviewActionV2OperationId.ReviewInvestigationContextGatewaySeal,
        expect.objectContaining({
          authorizationToken,
          leaseCapability: invocationLease.leaseCapability,
          sealCapability: gatewaySession.sealCapability,
          idempotencyKey: deterministicId('investigation-gateway-failed-seal', [
            gatewaySession.sessionId,
            invocationLease.attemptId,
            invocationLease.leaseId,
            invocationLease.fencingToken,
          ]),
          sessionId: gatewaySession.sessionId,
          attemptId: invocationLease.attemptId,
          sourceLeaseId: invocationLease.leaseId,
          fencingToken: invocationLease.fencingToken,
          providerSucceeded: false,
          schemaValidated: false,
          fullyConsumed: false,
          transcriptCanonicalJson: '{}',
          replayMaterialCanonicalJson: '{}',
        })
      );
    }
  );

  it('rejects a denied investigation shadow gateway abandon', async () => {
    const adapter = createAdapter(
      jest.fn().mockResolvedValue({
        status: ReviewContextGatewaySealResultStatus.Denied,
      })
    );

    await expect(
      adapter.abandonGatewaySession({
        invocationLease,
        session: gatewaySession,
      })
    ).rejects.toThrow(
      'review_action_v2_investigation_context_gateway_failed_seal_denied'
    );
  });

  it('propagates an investigation shadow gateway open transport failure', async () => {
    const transportFailure = new Error('transport_failure');
    const adapter = createAdapter(
      jest.fn().mockRejectedValue(transportFailure)
    );

    await expect(adapter.openGatewaySession(openInput)).rejects.toBe(
      transportFailure
    );
  });

  it('propagates an investigation shadow gateway seal transport failure', async () => {
    const transportFailure = new Error('transport_failure');
    const adapter = createAdapter(
      jest.fn().mockRejectedValue(transportFailure)
    );

    await expect(adapter.sealGatewaySession(sealInput)).rejects.toBe(
      transportFailure
    );
  });
});

const authorizationToken = 'authorization.token';

const invocationLease = Object.freeze({
  leaseId: 'investigation-lease-1',
  attemptId: 'investigation-attempt-1',
  leaseCapability: 'investigation.lease.capability',
  fencingToken: '17',
  expiresAt: '2026-08-05T10:05:00.000Z',
  resultReportUntil: '2026-08-05T10:10:00.000Z',
  renewalCeilingReached: false,
});

const openInput = Object.freeze({
  invocationLease,
  sourceExecutionId: 'investigation-execution-1',
  sourceWorkSlotId: 'investigation-work-slot-1',
  sourceReviewRevisionHash: digest('review-revision'),
  checkoutTreeOid: '7'.repeat(40),
  gatewayPolicyVersion: 'context-gateway-v4',
  gatewayBinaryHash: digest('gateway-binary'),
  confinementEvidenceHash: digest('confinement-evidence'),
});

const gatewaySession = Object.freeze({
  sessionId: 'investigation-gateway-session-1',
  eventChainSeedHash: digest('event-chain-seed'),
  sealCapability: 'investigation.seal.capability',
  gatewaySessionSecret: Buffer.alloc(32, 1).toString('base64url'),
  expiresAt: '2026-08-05T10:04:00.000Z',
});

const sealInput = Object.freeze({
  invocationLease,
  session: gatewaySession,
  providerSucceeded: true,
  schemaValidated: true,
  fullyConsumed: true,
  actualModel: 'gpt-5.6-terra',
  terminalOutcomeHash: digest('terminal-outcome'),
  transcriptCanonicalJson: '{"manifestVersion":3}',
  transcriptHash: digest('{"manifestVersion":3}'),
  replayMaterialCanonicalJson: '{"replayMaterialVersion":2}',
  replayMaterialHash: digest('{"replayMaterialVersion":2}'),
});

const attestation = Object.freeze({
  attestationId: 'investigation-attestation-1',
  attestationHash: digest('investigation-attestation'),
});

function createAdapter(execute: jest.Mock) {
  return new ReviewActionV2InvestigationContextAttestationAdapter(
    { execute } as unknown as ReviewActionV2Client,
    authorizationToken
  );
}

function deterministicId(namespace: string, parts: readonly string[]): string {
  const hash = createHash('sha256')
    .update(JSON.stringify(parts), 'utf8')
    .digest('hex')
    .slice(0, 40);
  return `rr:${namespace}:${hash}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
