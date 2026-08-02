#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ARTIFACT_KIND = 'reviewrouter-context-gateway';
const METADATA_VERSION = 1;
const DEFAULT_ENTRYPOINT = 'dist/context-gateway.js';
const DEFAULT_OUTPUT = 'dist/context-gateway.release.json';
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
  const metadata = Object.freeze({
    artifactKind: ARTIFACT_KIND,
    contextGatewayEntrypointDigest: sha256(readFileSync(entrypoint)),
    contextGatewayEntrypointPath: entrypointPath,
    contextGatewayPolicyVersion: description.contextGatewayPolicyVersion,
    supportedContextGatewayPolicyVersions:
      description.supportedContextGatewayPolicyVersions,
    metadataVersion: METADATA_VERSION,
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
  const expectedKeys = [
    'artifactKind',
    'contextGatewayPolicyVersion',
    'metadataVersion',
    'supportedContextGatewayPolicyVersions',
  ];
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(expectedKeys) ||
    value.artifactKind !== ARTIFACT_KIND ||
    value.metadataVersion !== METADATA_VERSION ||
    typeof value.contextGatewayPolicyVersion !== 'string' ||
    !POLICY_PATTERN.test(value.contextGatewayPolicyVersion) ||
    !Array.isArray(value.supportedContextGatewayPolicyVersions) ||
    value.supportedContextGatewayPolicyVersions.length < 1 ||
    value.supportedContextGatewayPolicyVersions.length > 16 ||
    !value.supportedContextGatewayPolicyVersions.every(
      (policy) => typeof policy === 'string' && POLICY_PATTERN.test(policy)
    ) ||
    new Set(value.supportedContextGatewayPolicyVersions).size !==
      value.supportedContextGatewayPolicyVersions.length ||
    !value.supportedContextGatewayPolicyVersions.includes(
      value.contextGatewayPolicyVersion
    ) ||
    result.stdout !== `${JSON.stringify(value)}\n`
  ) {
    throw new Error('context_gateway_description_invalid');
  }
  return value;
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
