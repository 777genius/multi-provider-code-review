#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ARTIFACT_KIND = 'reviewrouter-context-gateway';
const LEGACY_METADATA_VERSION = 1;
const INVESTIGATION_METADATA_VERSION = 2;
const DEFAULT_ENTRYPOINT = 'dist/context-gateway.js';
const DEFAULT_OUTPUT = 'dist/context-gateway.release.json';
const DEFAULT_CAPABILITY_FIXTURE =
  'src/review-investigation/fixtures/review-investigation-capability-v1.golden.json';
const LEGACY_POLICY_VERSION = 'context-gateway-v3';
const INVESTIGATION_POLICY_VERSION = 'context-gateway-v4';
const REVIEW_INVESTIGATION_CAPABILITY = 'review_investigation_v1';
const POLICY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export function generateContextGatewayReleaseMetadata(input = {}) {
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const entrypointPath = normalizeRelativePath(
    input.entrypointPath ?? DEFAULT_ENTRYPOINT,
    'entrypointPath'
  );
  const outputPath = normalizeRelativePath(
    input.outputPath ?? DEFAULT_OUTPUT,
    'outputPath'
  );
  const entrypoint = path.join(cwd, entrypointPath);
  const description = describeGateway(entrypoint);
  if (description.metadataVersion === INVESTIGATION_METADATA_VERSION) {
    const capabilityFixturePath = normalizeRelativePath(
      input.capabilityFixturePath ?? DEFAULT_CAPABILITY_FIXTURE,
      'capabilityFixturePath'
    );
    assertInvestigationDescriptionMatchesFixture(
      description,
      readCapabilityFixture(path.join(cwd, capabilityFixturePath))
    );
  }
  const metadata = Object.freeze({
    ...description,
    contextGatewayEntrypointDigest: sha256(readFileSync(entrypoint)),
    contextGatewayEntrypointPath: entrypointPath,
  });
  const bytes = canonicalJson(metadata);
  const output = path.join(cwd, outputPath);
  if (input.check === true) {
    if (readFileSync(output, 'utf8') !== bytes) {
      throw new Error('context_gateway_release_metadata_stale');
    }
    return metadata;
  }
  const temporary = `${output}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, bytes, { encoding: 'utf8', mode: 0o644 });
    renameSync(temporary, output);
  } finally {
    rmSync(temporary, { force: true });
  }
  return metadata;
}

function describeGateway(entrypoint) {
  const result = spawnSync(process.execPath, [entrypoint, '--describe'], {
    encoding: 'utf8',
    env: {},
    timeout: 10_000,
  });
  if (result.error || result.status !== 0 || result.stderr !== '') {
    throw new Error('context_gateway_description_failed', {
      cause: result.error,
    });
  }
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error('context_gateway_description_invalid', { cause: error });
  }
  if (
    !isRecord(value) ||
    value.artifactKind !== ARTIFACT_KIND ||
    typeof value.contextGatewayPolicyVersion !== 'string' ||
    !POLICY_PATTERN.test(value.contextGatewayPolicyVersion) ||
    !isSupportedPolicyList(
      value.supportedContextGatewayPolicyVersions,
      value.contextGatewayPolicyVersion
    ) ||
    result.stdout !== `${JSON.stringify(value)}\n`
  ) {
    throw new Error('context_gateway_description_invalid');
  }
  if (value.metadataVersion === LEGACY_METADATA_VERSION) {
    if (
      !hasExactKeys(value, [
        'artifactKind',
        'contextGatewayPolicyVersion',
        'metadataVersion',
        'supportedContextGatewayPolicyVersions',
      ]) ||
      value.contextGatewayPolicyVersion !== LEGACY_POLICY_VERSION
    ) {
      throw new Error('context_gateway_description_invalid');
    }
    return value;
  }
  if (
    value.metadataVersion !== INVESTIGATION_METADATA_VERSION ||
    !hasExactKeys(value, [
      'artifactKind',
      'contextGatewayPolicyVersion',
      'metadataVersion',
      'reviewInvestigationCapability',
      'reviewInvestigationCoverageProfileHash',
      'reviewInvestigationPolicyHash',
      'supportedContextGatewayPolicyVersions',
    ]) ||
    value.contextGatewayPolicyVersion !== INVESTIGATION_POLICY_VERSION ||
    JSON.stringify(value.supportedContextGatewayPolicyVersions) !==
      JSON.stringify([LEGACY_POLICY_VERSION, INVESTIGATION_POLICY_VERSION]) ||
    value.reviewInvestigationCapability !== REVIEW_INVESTIGATION_CAPABILITY ||
    !DIGEST_PATTERN.test(value.reviewInvestigationCoverageProfileHash) ||
    !DIGEST_PATTERN.test(value.reviewInvestigationPolicyHash)
  ) {
    throw new Error('context_gateway_description_invalid');
  }
  return value;
}

function isSupportedPolicyList(value, primaryPolicy) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 16 ||
    !value.every(
      (policy) =>
        typeof policy === 'string' &&
        POLICY_PATTERN.test(policy) &&
        [LEGACY_POLICY_VERSION, INVESTIGATION_POLICY_VERSION].includes(policy)
    ) ||
    new Set(value).size !== value.length ||
    !value.includes(primaryPolicy)
  ) {
    return false;
  }
  const canonicalOrder = [
    LEGACY_POLICY_VERSION,
    INVESTIGATION_POLICY_VERSION,
  ].filter((policy) => value.includes(policy));
  return JSON.stringify(value) === JSON.stringify(canonicalOrder);
}

function readCapabilityFixture(fixturePath) {
  const bytes = readFileSync(fixturePath);
  if (bytes.byteLength > 16 * 1_024) {
    throw new Error('context_gateway_release_capability_fixture_invalid');
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error('context_gateway_release_capability_fixture_invalid', {
      cause: error,
    });
  }
  if (
    !hasExactKeys(value, ['coverageProfile', 'policy']) ||
    !isRecord(value.coverageProfile) ||
    !isRecord(value.policy) ||
    value.coverageProfile.value?.gatewayPolicyVersion !==
      INVESTIGATION_POLICY_VERSION
  ) {
    throw new Error('context_gateway_release_capability_fixture_invalid');
  }
  return Object.freeze({
    coverageProfileHash: readGoldenHash(
      value.coverageProfile,
      'coverage_profile'
    ),
    policyHash: readGoldenHash(value.policy, 'policy'),
  });
}

function readGoldenHash(value, field) {
  if (
    !hasExactKeys(value, ['canonicalJson', 'sha256', 'value']) ||
    typeof value.canonicalJson !== 'string' ||
    typeof value.sha256 !== 'string' ||
    !DIGEST_PATTERN.test(value.sha256)
  ) {
    throw new Error(`context_gateway_release_${field}_fixture_invalid`);
  }
  const canonical = compactCanonicalJson(value.value);
  if (canonical !== value.canonicalJson || sha256(canonical) !== value.sha256) {
    throw new Error(`context_gateway_release_${field}_fixture_invalid`);
  }
  return value.sha256;
}

function assertInvestigationDescriptionMatchesFixture(description, fixture) {
  if (
    description.reviewInvestigationCoverageProfileHash !==
      fixture.coverageProfileHash ||
    description.reviewInvestigationPolicyHash !== fixture.policyHash
  ) {
    throw new Error('context_gateway_release_capability_fixture_mismatch');
  }
}

function normalizeRelativePath(value, field) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === '..' ||
    value.startsWith('../')
  ) {
    throw new Error(`context_gateway_release_${field}_invalid`);
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
      )
    ),
    null,
    2
  )}\n`;
}

function compactCanonicalJson(value) {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('context_gateway_release_capability_fixture_invalid');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(compactCanonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${compactCanonicalJson(value[key])}`
      )
      .join(',')}}`;
  }
  throw new Error('context_gateway_release_capability_fixture_invalid');
}

function sha256(value) {
  const digest = createHash('sha256').update(value).digest('hex');
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error('context_gateway_release_digest_invalid');
  }
  return digest;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    throw new Error(
      'usage: generate-context-gateway-release-metadata [--check]'
    );
  }
  const metadata = generateContextGatewayReleaseMetadata({
    check: args[0] === '--check',
  });
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'unknown_error'}\n`
    );
    process.exitCode = 1;
  }
}
