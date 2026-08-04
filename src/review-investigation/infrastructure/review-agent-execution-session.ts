import type { ReviewAgentExecutionSession } from '../application/review-agent-port';
import type { ReviewAgentProviderKind } from '../domain/runtime-profile';

export type ReviewAgentGatewayLaunchBinding = Readonly<{
  policyVersion: 'context-gateway-v4';
  binaryHash: string;
  command: string;
  args: readonly string[];
  cwd: string;
  enabledTools: readonly string[];
  runtimeEnvironment: Readonly<NodeJS.ProcessEnv>;
  credentialEnvironment: Readonly<NodeJS.ProcessEnv>;
}>;

export interface ReviewAgentExecutionSessionResolverPort {
  resolve(
    session: ReviewAgentExecutionSession,
    providerKind: ReviewAgentProviderKind
  ): ReviewAgentGatewayLaunchBinding;
}
