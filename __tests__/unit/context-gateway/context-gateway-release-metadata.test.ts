import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

describe('context gateway release metadata', () => {
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

    expect(described).toEqual({
      artifactKind: 'reviewrouter-context-gateway',
      contextGatewayPolicyVersion: 'context-gateway-v3',
      supportedContextGatewayPolicyVersions: [
        'context-gateway-v3',
        'context-gateway-v4',
      ],
      metadataVersion: 1,
    });
    expect(metadata).toEqual({
      artifactKind: 'reviewrouter-context-gateway',
      contextGatewayEntrypointDigest: createHash('sha256')
        .update(readFileSync(bundlePath))
        .digest('hex'),
      contextGatewayEntrypointPath: 'dist/context-gateway.js',
      contextGatewayPolicyVersion: described.contextGatewayPolicyVersion,
      supportedContextGatewayPolicyVersions:
        described.supportedContextGatewayPolicyVersions,
      metadataVersion: 1,
    });
  });

  it('is deterministic and rejects a stale bundle digest', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'reviewrouter-gateway-release-')
    );
    try {
      cpSync(path.join(repositoryRoot, 'dist'), path.join(directory, 'dist'), {
        recursive: true,
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
