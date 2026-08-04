import capabilityGolden from '../review-investigation/fixtures/review-investigation-capability-v1.golden.json';
import {
  canonicalJson,
  CONTEXT_GATEWAY_POLICY_VERSION,
  sha256,
} from './context-gateway-contract';
import { CONTEXT_GATEWAY_V4_POLICY_VERSION } from './context-gateway-v4-contract';

export const CONTEXT_GATEWAY_RELEASE_METADATA_VERSION = 2 as const;
export const CONTEXT_GATEWAY_DEFAULT_POLICY_VERSION =
  CONTEXT_GATEWAY_V4_POLICY_VERSION;
export const CONTEXT_GATEWAY_OMITTED_POLICY_FALLBACK_VERSION =
  CONTEXT_GATEWAY_POLICY_VERSION;
export const REVIEW_INVESTIGATION_RELEASE_CAPABILITY =
  'review_investigation_v1' as const;
export const SUPPORTED_CONTEXT_GATEWAY_POLICY_VERSIONS = Object.freeze([
  CONTEXT_GATEWAY_POLICY_VERSION,
  CONTEXT_GATEWAY_V4_POLICY_VERSION,
] as const);

if (
  capabilityGolden.coverageProfile.value.gatewayPolicyVersion !==
  CONTEXT_GATEWAY_V4_POLICY_VERSION
) {
  throw new Error('context_gateway_release_coverage_policy_mismatch');
}

export const REVIEW_INVESTIGATION_RELEASE_COVERAGE_PROFILE_HASH =
  verifyGoldenHash(
    capabilityGolden.coverageProfile.value,
    capabilityGolden.coverageProfile.canonicalJson,
    capabilityGolden.coverageProfile.sha256,
    'coverage_profile'
  );

export const REVIEW_INVESTIGATION_RELEASE_POLICY_HASH = verifyGoldenHash(
  capabilityGolden.policy.value,
  capabilityGolden.policy.canonicalJson,
  capabilityGolden.policy.sha256,
  'policy'
);

export const CONTEXT_GATEWAY_RELEASE_DESCRIPTION = Object.freeze({
  artifactKind: 'reviewrouter-context-gateway' as const,
  contextGatewayPolicyVersion: CONTEXT_GATEWAY_DEFAULT_POLICY_VERSION,
  metadataVersion: CONTEXT_GATEWAY_RELEASE_METADATA_VERSION,
  reviewInvestigationCapability: REVIEW_INVESTIGATION_RELEASE_CAPABILITY,
  reviewInvestigationCoverageProfileHash:
    REVIEW_INVESTIGATION_RELEASE_COVERAGE_PROFILE_HASH,
  reviewInvestigationPolicyHash: REVIEW_INVESTIGATION_RELEASE_POLICY_HASH,
  supportedContextGatewayPolicyVersions:
    SUPPORTED_CONTEXT_GATEWAY_POLICY_VERSIONS,
});

function verifyGoldenHash(
  value: unknown,
  expectedCanonicalJson: string,
  expectedHash: string,
  field: string
): string {
  const actualCanonicalJson = canonicalJson(value);
  if (
    actualCanonicalJson !== expectedCanonicalJson ||
    !/^[a-f0-9]{64}$/u.test(expectedHash) ||
    sha256(actualCanonicalJson) !== expectedHash
  ) {
    throw new Error(`context_gateway_release_${field}_fixture_invalid`);
  }
  return expectedHash;
}
