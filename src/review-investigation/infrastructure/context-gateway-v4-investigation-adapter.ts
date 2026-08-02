import { CONTEXT_GATEWAY_V4_POLICY_VERSION } from '../../context-gateway/context-gateway-v4-contract';
import type { ReviewInvocationLease } from '../../review-orchestration/application';
import type {
  ContextGatewayInvocationSessionFactoryPort,
  ContextGatewayRevision,
} from '../../review-orchestration/infrastructure/context-gateway-invocation-session';
import type {
  AcceptedInvestigationAttestation,
  ReviewInvestigationGatewaySessionFactoryPort,
  ReviewInvestigationGatewaySessionPort,
} from '../application/investigation-gateway-port';

export class ContextGatewayV4InvestigationAdapter implements ReviewInvestigationGatewaySessionFactoryPort {
  constructor(
    private readonly factory: ContextGatewayInvocationSessionFactoryPort,
    private readonly context: Readonly<{
      revision: ContextGatewayRevision;
      providerKind: string;
      executionProfile: string;
      providerInvocationKey: string;
      toolPolicyHash: string;
    }>
  ) {}

  async open(
    input: Parameters<ReviewInvestigationGatewaySessionFactoryPort['open']>[0]
  ): Promise<ReviewInvestigationGatewaySessionPort> {
    const session = await this.factory.open({
      invocationLease: orchestrationLease(input.lease),
      sourceExecutionId: input.executionId,
      sourceWorkSlotId: input.workSlotId,
      sourceReviewRevisionHash: input.reviewRevisionHash,
      providerKind: this.context.providerKind,
      requestedModel: input.requestedModel,
      executionProfile: this.context.executionProfile,
      providerInvocationKey: this.context.providerInvocationKey,
      toolPolicyHash: this.context.toolPolicyHash,
      revision: this.context.revision,
    });
    if (
      session.providerConfig.gatewayPolicyVersion !==
      CONTEXT_GATEWAY_V4_POLICY_VERSION
    ) {
      await session.dispose();
      throw new Error('investigation_context_gateway_v4_required');
    }
    return Object.freeze({
      providerConfig: Object.freeze({
        policyVersion: CONTEXT_GATEWAY_V4_POLICY_VERSION,
        binaryHash: session.providerConfig.gatewayBinaryHash,
        command: session.providerConfig.command,
        args: session.providerConfig.args,
        cwd: session.providerConfig.cwd,
        enabledTools: session.providerConfig.enabledTools,
        runtimeEnvironment: session.providerConfig.runtimeEnvironment,
        credentialEnvironment: session.credentialLease.environment ?? {},
      }),
      seal: async (
        sealInput: Parameters<ReviewInvestigationGatewaySessionPort['seal']>[0]
      ): Promise<AcceptedInvestigationAttestation> => {
        const accepted = await session.seal(sealInput);
        if (!accepted) {
          throw new Error('investigation_context_attestation_rejected');
        }
        return accepted;
      },
      dispose: () => session.dispose(),
    });
  }
}

function orchestrationLease(
  lease: Parameters<
    ReviewInvestigationGatewaySessionFactoryPort['open']
  >[0]['lease']
): ReviewInvocationLease {
  return Object.freeze({ ...lease, renewalCeilingReached: false });
}
