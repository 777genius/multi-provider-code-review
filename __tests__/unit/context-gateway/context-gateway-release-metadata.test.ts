import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import capabilityGolden from '../../../src/review-investigation/fixtures/review-investigation-capability-v1.golden.json';
import {
  CONTEXT_GATEWAY_OMITTED_POLICY_FALLBACK_VERSION,
  CONTEXT_GATEWAY_RELEASE_DESCRIPTION,
  REVIEW_INVESTIGATION_RELEASE_COVERAGE_PROFILE_HASH,
  REVIEW_INVESTIGATION_RELEASE_POLICY_HASH,
} from '../../../src/context-gateway/context-gateway-release-contract';

const repositoryRoot = path.resolve(__dirname, '../../..');
const bundlePath = path.join(repositoryRoot, 'dist/context-gateway.js');
const metadataPath = path.join(
  repositoryRoot,
  'dist/context-gateway.release.json'
);
const generatorPath = path.join(
  repositoryRoot,
  'scripts/generate-context-gateway-release-metadata.mjs'
);
const capabilityFixturePath = path.join(
  repositoryRoot,
  'src/review-investigation/fixtures/review-investigation-capability-v1.golden.json'
);

describe('context gateway release metadata', () => {
  it('defines the investigation release as v4 with explicit legacy v3 support', () => {
    expect(CONTEXT_GATEWAY_OMITTED_POLICY_FALLBACK_VERSION).toBe(
      'context-gateway-v3'
    );
    expect(CONTEXT_GATEWAY_RELEASE_DESCRIPTION).toEqual({
      artifactKind: 'reviewrouter-context-gateway',
      contextGatewayPolicyVersion: 'context-gateway-v4',
      metadataVersion: 2,
      reviewInvestigationCapability: 'review_investigation_v1',
      reviewInvestigationCoverageProfileHash:
        capabilityGolden.coverageProfile.sha256,
      reviewInvestigationPolicyHash: capabilityGolden.policy.sha256,
      supportedContextGatewayPolicyVersions: [
        'context-gateway-v3',
        'context-gateway-v4',
      ],
    });
    expect(REVIEW_INVESTIGATION_RELEASE_COVERAGE_PROFILE_HASH).toBe(
      capabilityGolden.coverageProfile.sha256
    );
    expect(REVIEW_INVESTIGATION_RELEASE_POLICY_HASH).toBe(
      capabilityGolden.policy.sha256
    );
  });

  it('binds policy identity and digest to the committed gateway bundle', () => {
    const description = spawnSync(
      process.execPath,
      [bundlePath, '--describe'],
      {
        encoding: 'utf8',
        env: {},
        timeout: 10_000,
      }
    );
    expect(description).toMatchObject({ status: 0, stderr: '' });
    const described = JSON.parse(description.stdout) as Record<string, unknown>;
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as Record<
      string,
      unknown
    >;

    expect(described).toEqual(CONTEXT_GATEWAY_RELEASE_DESCRIPTION);
    expect(metadata).toEqual({
      ...CONTEXT_GATEWAY_RELEASE_DESCRIPTION,
      contextGatewayEntrypointDigest: createHash('sha256')
        .update(readFileSync(bundlePath))
        .digest('hex'),
      contextGatewayEntrypointPath: 'dist/context-gateway.js',
    });
  });

  it('generates v2 investigation metadata only from the authoritative fixture', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'reviewrouter-gateway-investigation-release-')
    );
    try {
      const temporaryBundle = path.join(directory, 'dist/context-gateway.js');
      const temporaryFixture = path.join(
        directory,
        'src/review-investigation/fixtures/review-investigation-capability-v1.golden.json'
      );
      mkdirSync(path.dirname(temporaryBundle), { recursive: true });
      mkdirSync(path.dirname(temporaryFixture), { recursive: true });
      cpSync(capabilityFixturePath, temporaryFixture);
      writeGatewayDescription(
        temporaryBundle,
        CONTEXT_GATEWAY_RELEASE_DESCRIPTION
      );

      const generate = () =>
        spawnSync(process.execPath, [generatorPath], {
          cwd: directory,
          encoding: 'utf8',
          timeout: 10_000,
        });
      expect(generate()).toMatchObject({ status: 0, stderr: '' });
      expect(
        JSON.parse(
          readFileSync(
            path.join(directory, 'dist/context-gateway.release.json'),
            'utf8'
          )
        )
      ).toMatchObject({
        contextGatewayPolicyVersion: 'context-gateway-v4',
        metadataVersion: 2,
        reviewInvestigationCapability: 'review_investigation_v1',
        reviewInvestigationCoverageProfileHash:
          capabilityGolden.coverageProfile.sha256,
        reviewInvestigationPolicyHash: capabilityGolden.policy.sha256,
        supportedContextGatewayPolicyVersions: [
          'context-gateway-v3',
          'context-gateway-v4',
        ],
      });

      writeGatewayDescription(temporaryBundle, {
        ...CONTEXT_GATEWAY_RELEASE_DESCRIPTION,
        supportedContextGatewayPolicyVersions: ['context-gateway-v4'],
      });
      expect(generate()).toMatchObject({ status: 1 });

      writeGatewayDescription(temporaryBundle, {
        ...CONTEXT_GATEWAY_RELEASE_DESCRIPTION,
        reviewInvestigationPolicyHash: 'f'.repeat(64),
      });
      const mismatch = generate();
      expect(mismatch.status).toBe(1);
      expect(mismatch.stderr).toContain(
        'context_gateway_release_capability_fixture_mismatch'
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('keeps legacy v3 metadata deterministic and rejects a stale digest', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'reviewrouter-gateway-release-')
    );
    try {
      const temporaryBundle = path.join(directory, 'dist/context-gateway.js');
      mkdirSync(path.dirname(temporaryBundle), { recursive: true });
      writeGatewayDescription(temporaryBundle, {
        artifactKind: 'reviewrouter-context-gateway',
        contextGatewayPolicyVersion: 'context-gateway-v3',
        metadataVersion: 1,
        supportedContextGatewayPolicyVersions: [
          'context-gateway-v3',
          'context-gateway-v4',
        ],
      });
      const generate = () =>
        spawnSync(process.execPath, [generatorPath], {
          cwd: directory,
          encoding: 'utf8',
          timeout: 10_000,
        });

      expect(generate().status).toBe(0);
      const first = readFileSync(
        path.join(directory, 'dist/context-gateway.release.json'),
        'utf8'
      );
      expect(generate().status).toBe(0);
      expect(
        readFileSync(
          path.join(directory, 'dist/context-gateway.release.json'),
          'utf8'
        )
      ).toBe(first);

      appendFileSync(
        path.join(directory, 'dist/context-gateway.js'),
        '\n// stale release fixture\n'
      );
      const check = spawnSync(process.execPath, [generatorPath, '--check'], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(check.status).toBe(1);
      expect(check.stderr).toContain('context_gateway_release_metadata_stale');
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

function writeGatewayDescription(file: string, description: unknown): void {
  const stdout = `${JSON.stringify(description)}\n`;
  writeFileSync(
    file,
    `process.stdout.write(${JSON.stringify(stdout)});\n`,
    'utf8'
  );
}
