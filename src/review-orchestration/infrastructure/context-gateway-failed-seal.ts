import { createHash } from 'crypto';
import type {
  ContextGatewaySessionLease,
  ReviewInvocationLease,
} from '../application/review-orchestration-ports';

const emptyCanonicalJson = '{}';
const emptyCanonicalJsonHash = digest(emptyCanonicalJson);
const failedTerminalOutcomeHash = digest(
  'reviewrouter:context-gateway-provider-failed:v1'
);

export function createFailedContextGatewaySealPayload(input: {
  readonly invocationLease: ReviewInvocationLease;
  readonly session: ContextGatewaySessionLease;
}) {
  return Object.freeze({
    sessionId: input.session.sessionId,
    sealCapability: input.session.sealCapability,
    attemptId: input.invocationLease.attemptId,
    sourceLeaseId: input.invocationLease.leaseId,
    fencingToken: input.invocationLease.fencingToken,
    providerSucceeded: false,
    schemaValidated: false,
    fullyConsumed: false,
    actualModel: 'provider-invocation-failed',
    terminalOutcomeHash: failedTerminalOutcomeHash,
    transcriptCanonicalJson: emptyCanonicalJson,
    transcriptHash: emptyCanonicalJsonHash,
    replayMaterialCanonicalJson: emptyCanonicalJson,
    replayMaterialHash: emptyCanonicalJsonHash,
  });
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
