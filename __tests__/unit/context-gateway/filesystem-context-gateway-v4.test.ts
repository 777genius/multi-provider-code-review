import { execFile } from 'child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { sha256 } from '../../../src/context-gateway/context-gateway-contract';
import { ContextGatewayV4Revision } from '../../../src/context-gateway/context-gateway-v4-contract';
import { ContextGatewayV4Recorder } from '../../../src/context-gateway/context-gateway-v4-recorder';
import { FilesystemContextGatewayV4 } from '../../../src/context-gateway/filesystem-context-gateway-v4';

const execFileAsync = promisify(execFile);
const secret = Buffer.alloc(32, 9);

describe('FilesystemContextGatewayV4', () => {
  it('paginates authenticated directory, search, and inventory results completely', async () => {
    const fixture = await createFixture();
    try {
      const { gateway, transcriptPath } = await createGateway(fixture);
      const listed = await collectPages((cursor) =>
        gateway.listDirectory({ path: '.', maxDepth: 4, pageSize: 2, cursor })
      );
      expect(listed.items).toEqual([
        'docs/a.md',
        'docs/b.md',
        'docs/c.md',
        'src/current.ts',
        'src/search.ts',
      ]);
      expect(listed.receipts).toHaveLength(3);

      const searched = await collectPages(
        (cursor) =>
          gateway.searchText({
            query: 'SENSITIVE_QUERY_CANARY',
            paths: ['.'],
            pageSize: 1,
            cursor,
          }),
        'matches'
      );
      expect(searched.items).toHaveLength(2);
      expect(searched.receipts).toHaveLength(2);

      const inventory = await collectPages(
        (cursor) => gateway.canonicalInventory({ pageSize: 2, cursor }),
        'entries'
      );
      expect(inventory.items.length).toBeGreaterThanOrEqual(3);
      expect(inventory.receipts.length).toBeGreaterThan(1);

      const transcript = await readFile(transcriptPath, 'utf8');
      expect(transcript).not.toContain('SENSITIVE_QUERY_CANARY');
      expect(transcript).not.toContain('export const current');
      const parsed = JSON.parse(transcript);
      expect(
        parsed.events.every(
          (event: { outcome: string }) => event.outcome === 'succeeded'
        )
      ).toBe(true);
      expect(
        parsed.events.every((event: { operationReceiptId: string }) =>
          /^[a-f0-9]{64}$/.test(event.operationReceiptId)
        )
      ).toBe(true);
    } finally {
      await rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('reads exact base/head objects and bounded byte ranges without using the worktree', async () => {
    const fixture = await createFixture();
    try {
      const { gateway } = await createGateway(fixture);
      await writeFile(
        path.join(fixture.root, 'src', 'current.ts'),
        'MUTABLE WORKTREE\n'
      );
      const head = await gateway.readFile({
        path: 'src/current.ts',
        revision: ContextGatewayV4Revision.Head,
        startByte: 0,
        maxBytes: 7,
      });
      expect(head.content).toBe('export ');
      expect(head.eof).toBe(false);
      const tail = await gateway.readFile({
        path: 'src/current.ts',
        revision: ContextGatewayV4Revision.Head,
        startByte: 7,
        maxBytes: 1024,
      });
      expect(tail.content).toContain('const current');
      expect(tail.eof).toBe(true);

      const deleted = await gateway.readFile({
        path: 'src/deleted.ts',
        revision: ContextGatewayV4Revision.MergeBase,
      });
      expect(deleted.content).toContain('deleted = true');
      await expect(
        gateway.readFile({
          path: 'src/deleted.ts',
          revision: ContextGatewayV4Revision.Head,
        })
      ).rejects.toThrow('context_gateway_file_not_in_revision_tree');
      expect(gateway['recorder'].snapshot().confinementTainted).toBe(false);
    } finally {
      await rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('rejects a tampered cursor, taints the session, and cannot resume evidence collection', async () => {
    const fixture = await createFixture();
    try {
      const { gateway, recorder } = await createGateway(fixture);
      const first = await gateway.listDirectory({ path: '.', pageSize: 2 });
      const cursor = requireCursor(first.nextCursor);
      const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('0') ? '1' : '0'}`;
      await expect(
        gateway.listDirectory({ path: '.', pageSize: 2, cursor: tampered })
      ).rejects.toThrow('context_gateway_cursor_tampered');
      expect(recorder.snapshot().confinementTainted).toBe(true);
      await expect(gateway.gitFact({ fact: 'merge_base' })).rejects.toThrow(
        'context_gateway_v4_session_tainted'
      );
    } finally {
      await rm(fixture.parent, { recursive: true, force: true });
    }
  });
});

async function collectPages(
  load: (cursor?: string) => Promise<Record<string, unknown>>,
  field: 'entries' | 'matches' = 'entries'
) {
  const items: unknown[] = [];
  const receipts: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await load(cursor);
    items.push(...((page[field] as unknown[]) ?? []));
    receipts.push(page.operationReceiptId as string);
    cursor = (page.nextCursor as string | null) ?? undefined;
  } while (cursor);
  return { items, receipts };
}

async function createGateway(
  fixture: Awaited<ReturnType<typeof createFixture>>
) {
  const transcriptPath = path.join(
    fixture.parent,
    `transcript-${Math.random()}.json`
  );
  const recorder = new ContextGatewayV4Recorder({
    sessionId: 'gateway-v4-session',
    transcriptPath,
    secret,
    gatewayBinaryHash: sha256('binary'),
    checkoutTreeOid: fixture.headTreeOid,
    eventChainSeedHash: sha256('seed'),
    now: () => 10_000,
  });
  await recorder.initialize();
  const gateway = await FilesystemContextGatewayV4.create({
    root: fixture.root,
    sessionId: 'gateway-v4-session',
    checkoutTreeOid: fixture.headTreeOid,
    mergeBaseSha: fixture.mergeBaseSha,
    headSha: fixture.headSha,
    secret,
    recorder,
    now: () => 10_000,
  });
  return { gateway, recorder, transcriptPath };
}

async function createFixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'rr-gateway-v4-'));
  const root = path.join(parent, 'root');
  await mkdir(root);
  await initializeRepo(root);
  await Promise.all([
    mkdir(path.join(root, 'src')),
    mkdir(path.join(root, 'docs')),
  ]);
  await writeFile(
    path.join(root, 'src', 'current.ts'),
    'export const current = 1;\n'
  );
  await writeFile(
    path.join(root, 'src', 'deleted.ts'),
    'export const deleted = true;\n'
  );
  await writeFile(
    path.join(root, 'src', 'search.ts'),
    '// SENSITIVE_QUERY_CANARY\n// SENSITIVE_QUERY_CANARY\n'
  );
  await writeFile(path.join(root, 'docs', 'a.md'), 'a\n');
  await writeFile(path.join(root, 'docs', 'b.md'), 'b\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-qm', 'base']);
  const mergeBaseSha = await gitText(root, ['rev-parse', 'HEAD']);
  await rm(path.join(root, 'src', 'deleted.ts'));
  await writeFile(
    path.join(root, 'src', 'current.ts'),
    'export const current = 2;\n'
  );
  await writeFile(path.join(root, 'docs', 'c.md'), 'c\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-qm', 'head']);
  const headSha = await gitText(root, ['rev-parse', 'HEAD']);
  const headTreeOid = await gitText(root, ['rev-parse', `${headSha}^{tree}`]);
  return { parent, root, mergeBaseSha, headSha, headTreeOid };
}

async function initializeRepo(root: string) {
  await git(root, ['init', '-q']);
  await git(root, ['config', 'user.name', 'ReviewRouter Test']);
  await git(root, ['config', 'user.email', 'test@example.invalid']);
}

async function git(root: string, args: readonly string[]) {
  await execFileAsync('git', args, { cwd: root });
}

async function gitText(root: string, args: readonly string[]) {
  return (await execFileAsync('git', args, { cwd: root })).stdout.trim();
}

function requireCursor(value: string | null): string {
  if (!value) throw new Error('test_cursor_missing');
  return value;
}
