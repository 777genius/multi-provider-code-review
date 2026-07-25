import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import {
  ChangedPathsWitnessStatus,
  canonicalJson,
  changedPathsWitnessStatus,
  type ContextGatewayTranscript,
  sha256,
} from '../../../src/context-gateway/context-gateway-contract';
import { ContextGatewayRecorder } from '../../../src/context-gateway/context-gateway-recorder';
import { FilesystemContextGateway } from '../../../src/context-gateway/filesystem-context-gateway';
import {
  RequiredContextWitnessCaptureStatus,
  captureRequiredContextWitness,
} from '../../../src/context-gateway/required-context-witness';

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

  it('captures a complete changed_paths witness before optional model tool calls', async () => {
    const baseSha = await gitText(root, ['rev-parse', 'HEAD']);
    await writeFile(path.join(root, 'b.ts'), 'export const gamma = 3;\n');
    await git(root, ['add', 'b.ts']);
    await git(root, ['commit', '-qm', 'add changed path']);
    const fixture = await gatewayFixture(root, 'required-witness', baseSha);

    await expect(captureRequiredContextWitness(fixture.gateway)).resolves.toBe(
      RequiredContextWitnessCaptureStatus.Captured
    );
    await fixture.gateway.gitFact({ fact: 'changed_paths' });

    const transcript = await readJson<ContextGatewayTranscript>(
      fixture.transcriptPath
    );
    const expectedOperandsHash = sha256(
      canonicalJson({
        baseSha: fixture.baseSha,
        headSha: fixture.headSha,
      })
    );
    expect(transcript.dependencies).toHaveLength(2);
    expect(transcript.dependencies[0]).toMatchObject({
      sequence: 1,
      operation: {
        kind: 'git_fact',
        fact: 'changed_paths',
        operandsHash: expectedOperandsHash,
      },
      result: {
        kind: 'git_fact',
        itemCount: 1,
        complete: true,
        truncated: false,
      },
    });
    expect(changedPathsWitnessStatus(transcript, expectedOperandsHash)).toBe(
      ChangedPathsWitnessStatus.Present
    );
  });

  it('keeps the gateway available when the required witness cannot be captured', async () => {
    const gateway = {
      gitFact: jest.fn().mockRejectedValue(new Error('git unavailable')),
    };

    await expect(captureRequiredContextWitness(gateway)).resolves.toBe(
      RequiredContextWitnessCaptureStatus.Unavailable
    );
    expect(gateway.gitFact).toHaveBeenCalledWith({ fact: 'changed_paths' });
  });

  it('fails closed instead of resetting an initialized transcript', async () => {
    const fixture = await gatewayFixture(root);
    await fixture.gateway.readFile({ path: 'a.ts' });
    const before = await readFile(fixture.transcriptPath, 'utf8');

    await expect(fixture.recorder.initialize()).rejects.toThrow(
      'context_gateway_recorder_already_initialized'
    );
    await expect(readFile(fixture.transcriptPath, 'utf8')).resolves.toBe(
      before
    );
  });

  it('resumes an authenticated transcript without resetting its chain', async () => {
    const fixture = await gatewayFixture(root, 'resume');
    await fixture.gateway.gitFact({ fact: 'changed_paths' });
    const resumedRecorder = new ContextGatewayRecorder(fixture.recorderConfig);

    await resumedRecorder.resume();
    const resumedGateway = await FilesystemContextGateway.create({
      root,
      checkoutTreeOid: fixture.recorderConfig.checkoutTreeOid,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      recorder: resumedRecorder,
    });
    await resumedGateway.readFile({ path: 'a.ts' });

    const transcript = await readJson<ContextGatewayTranscript>(
      fixture.transcriptPath
    );
    expect(transcript.dependencies).toHaveLength(2);
    expect(transcript.dependencies.map((entry) => entry.sequence)).toEqual([
      1, 2,
    ]);
    expect(transcript.dependencies[1]?.previousEventHash).toBe(
      transcript.dependencies[0]?.eventHash
    );
  });

  it('rejects a tampered transcript instead of continuing its chain', async () => {
    const fixture = await gatewayFixture(root, 'tampered-resume');
    await fixture.gateway.gitFact({ fact: 'changed_paths' });
    const transcript = await readJson<ContextGatewayTranscript>(
      fixture.transcriptPath
    );
    await writeFile(
      fixture.transcriptPath,
      canonicalJson({
        ...transcript,
        authenticatedChainHash: 'f'.repeat(64),
      })
    );
    const resumedRecorder = new ContextGatewayRecorder(fixture.recorderConfig);

    await expect(resumedRecorder.resume()).rejects.toThrow(
      'context_gateway_recorder_transcript_state_invalid'
    );
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

async function gatewayFixture(
  root: string,
  suffix = 'default',
  baseSha?: string
) {
  const headSha = await gitText(root, ['rev-parse', 'HEAD']);
  const checkoutTreeOid = await gitText(root, ['rev-parse', 'HEAD^{tree}']);
  const transcriptPath = path.join(root, '.test-output', `${suffix}.json`);
  const replayMaterialPath = path.join(
    root,
    '.test-output',
    `${suffix}.replay.json`
  );
  const recorderConfig = {
    sessionId: `session-${suffix}`,
    transcriptPath,
    replayMaterialPath,
    secret: Buffer.alloc(32, 7),
    gatewayBinaryHash: 'a'.repeat(64),
    checkoutTreeOid,
    eventChainSeedHash: 'b'.repeat(64),
  } as const;
  const recorder = new ContextGatewayRecorder(recorderConfig);
  await recorder.initialize();
  return {
    baseSha: baseSha ?? headSha,
    gateway: await FilesystemContextGateway.create({
      root,
      checkoutTreeOid,
      baseSha: baseSha ?? headSha,
      headSha,
      recorder,
    }),
    recorder,
    recorderConfig,
    transcriptPath,
    replayMaterialPath,
    headSha,
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
