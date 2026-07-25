import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import {
  type ContextGatewayTranscript,
  sha256,
} from '../../../src/context-gateway/context-gateway-contract';
import { ContextGatewayRecorder } from '../../../src/context-gateway/context-gateway-recorder';
import { FilesystemContextGateway } from '../../../src/context-gateway/filesystem-context-gateway';

const execFileAsync = promisify(execFile);

describe('FilesystemContextGateway', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'reviewrouter-gateway-test-'));
    await git(root, ['init', '-q']);
    await git(root, ['config', 'user.email', 'test@example.com']);
    await git(root, ['config', 'user.name', 'ReviewRouter Test']);
    await writeFile(
      path.join(root, 'a.ts'),
      'export const alpha = 1;\nexport const beta = alpha + 1;\n'
    );
    await symlink('a.ts', path.join(root, 'a-link.ts'));
    await git(root, ['add', 'a.ts', 'a-link.ts']);
    await git(root, ['commit', '-qm', 'initial']);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('initializes an authenticated empty transcript before any tool call', async () => {
    const fixture = await gatewayFixture(root);

    const transcript = await readJson<ContextGatewayTranscript>(
      fixture.transcriptPath
    );
    const replayMaterial = await readJson<{
      readonly entries: readonly unknown[];
    }>(fixture.replayMaterialPath);

    expect(transcript).toMatchObject({
      authenticatedChainHash: 'b'.repeat(64),
      dependencies: [],
      eventChainSeedHash: 'b'.repeat(64),
      hadFailure: false,
    });
    expect(replayMaterial.entries).toEqual([]);
  });

  it('records bounded file, list and search dependencies without raw queries', async () => {
    const fixture = await gatewayFixture(root);

    await expect(
      fixture.gateway.readFile({ path: 'a.ts' })
    ).resolves.toMatchObject({
      fileKind: 'regular',
      eof: true,
    });
    await expect(
      fixture.gateway.readFile({ path: 'a-link.ts' })
    ).resolves.toMatchObject({
      fileKind: 'symlink',
      content: 'a.ts',
    });
    await expect(
      fixture.gateway.listDirectory({ path: '.', maxDepth: 2 })
    ).resolves.toMatchObject({
      entries: ['a-link.ts', 'a.ts'],
      truncated: false,
    });
    await expect(
      fixture.gateway.searchText({
        query: 'alpha',
        paths: ['.'],
        maxResults: 10,
      })
    ).resolves.toMatchObject({ truncated: false });

    const transcript = await readJson<ContextGatewayTranscript>(
      fixture.transcriptPath
    );
    const replayMaterial = await readFile(fixture.replayMaterialPath, 'utf8');
    expect(transcript.dependencies).toHaveLength(4);
    expect(transcript.hadFailure).toBe(false);
    expect(JSON.stringify(transcript)).not.toContain('alpha');
    expect(replayMaterial).toContain('alpha');
    expect(transcript.dependencies[1]?.result).toMatchObject({
      fileKind: 'symlink',
      symlinkTargetHash: sha256('a.ts'),
    });
  });

  it('fails closed for traversal and truncated search results', async () => {
    const fixture = await gatewayFixture(root);

    await expect(
      fixture.gateway.readFile({ path: '../outside' })
    ).rejects.toThrow('context_gateway_path_invalid');
    await fixture.gateway.searchText({
      query: 'export',
      paths: ['.'],
      maxResults: 1,
    });

    const transcript = await readJson<ContextGatewayTranscript>(
      fixture.transcriptPath
    );
    expect(transcript.hadFailure).toBe(true);
    expect(transcript.dependencies.at(-1)?.result).toMatchObject({
      complete: false,
      truncated: true,
    });
  });

  it('changes the replay result when searched repository context changes', async () => {
    const first = await gatewayFixture(root, 'first');
    await first.gateway.searchText({ query: 'alpha', paths: ['.'] });
    const firstTranscript = await readJson<ContextGatewayTranscript>(
      first.transcriptPath
    );

    await writeFile(path.join(root, 'b.ts'), 'export const gamma = alpha;\n');
    await git(root, ['add', 'b.ts']);
    await git(root, ['commit', '-qm', 'add search match']);
    const second = await gatewayFixture(root, 'second');
    await second.gateway.searchText({ query: 'alpha', paths: ['.'] });
    const secondTranscript = await readJson<ContextGatewayTranscript>(
      second.transcriptPath
    );

    expect(
      secondTranscript.dependencies[0]?.result.orderedMatchesHash
    ).not.toBe(firstTranscript.dependencies[0]?.result.orderedMatchesHash);
  });

  it('reads immutable Git objects instead of mutable worktree content', async () => {
    const fixture = await gatewayFixture(root);
    await writeFile(path.join(root, 'a.ts'), 'tampered worktree content\n');

    await expect(
      fixture.gateway.readFile({ path: 'a.ts' })
    ).resolves.toMatchObject({
      content: 'export const alpha = 1;\nexport const beta = alpha + 1;\n',
      encoding: 'utf8',
    });
    await expect(
      fixture.gateway.searchText({ query: 'tampered', paths: ['.'] })
    ).resolves.toMatchObject({ matches: [] });
  });

  it('reads the HEAD tree even when the mutable Git index is replaced', async () => {
    const fixture = await gatewayFixture(root);
    const replacement = path.join(root, 'replacement.txt');
    await writeFile(replacement, 'tampered index content\n');
    const replacementOid = await gitText(root, [
      'hash-object',
      '-w',
      'replacement.txt',
    ]);
    await git(root, [
      'update-index',
      '--cacheinfo',
      '100644',
      replacementOid,
      'a.ts',
    ]);

    await expect(
      fixture.gateway.readFile({ path: 'a.ts' })
    ).resolves.toMatchObject({
      content: 'export const alpha = 1;\nexport const beta = alpha + 1;\n',
      encoding: 'utf8',
    });
  });

  it('returns committed binary blobs as base64', async () => {
    const bytes = Buffer.from([0, 1, 2, 3, 255]);
    await writeFile(path.join(root, 'asset.bin'), bytes);
    await git(root, ['add', 'asset.bin']);
    await git(root, ['commit', '-qm', 'add binary']);
    const fixture = await gatewayFixture(root);

    await expect(
      fixture.gateway.readFile({ path: 'asset.bin' })
    ).resolves.toMatchObject({
      content: bytes.toString('base64'),
      encoding: 'base64',
      byteCount: bytes.byteLength,
    });
  });
});

async function gatewayFixture(root: string, suffix = 'default') {
  const headSha = await gitText(root, ['rev-parse', 'HEAD']);
  const checkoutTreeOid = await gitText(root, ['rev-parse', 'HEAD^{tree}']);
  const transcriptPath = path.join(root, '.test-output', `${suffix}.json`);
  const replayMaterialPath = path.join(
    root,
    '.test-output',
    `${suffix}.replay.json`
  );
  const recorder = new ContextGatewayRecorder({
    sessionId: `session-${suffix}`,
    transcriptPath,
    replayMaterialPath,
    secret: Buffer.alloc(32, 7),
    gatewayBinaryHash: 'a'.repeat(64),
    checkoutTreeOid,
    eventChainSeedHash: 'b'.repeat(64),
  });
  await recorder.initialize();
  return {
    gateway: await FilesystemContextGateway.create({
      root,
      checkoutTreeOid,
      baseSha: headSha,
      headSha,
      recorder,
    }),
    transcriptPath,
    replayMaterialPath,
  };
}

async function git(root: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: root });
}

async function gitText(root: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd: root })).stdout.trim();
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}
