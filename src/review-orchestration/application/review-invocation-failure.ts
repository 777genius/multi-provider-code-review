export enum ReviewInvocationConfigurationMismatchReason {
  ContextGatewayPolicyMismatch = 'context_gateway_policy_mismatch',
}

export class ReviewInvocationConfigurationMismatchError extends Error {
  constructor(
    readonly reason: ReviewInvocationConfigurationMismatchReason,
    options: ErrorOptions = {}
  ) {
    super(`review_invocation_configuration_mismatch:${reason}`, options);
    this.name = 'ReviewInvocationConfigurationMismatchError';
  }
}
