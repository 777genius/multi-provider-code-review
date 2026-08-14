import { execFile } from 'child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import {
  canonicalJson,
  sha256,
} from '../../../src/context-gateway/context-gateway-contract';
import { ContextGatewayV4Revision } from '../../../src/context-gateway/context-gateway-v4-contract';
import { ContextGatewayV4Recorder } from '../../../src/context-gateway/context-gateway-v4-recorder';
import { ContextGatewayV4ReplayMaterialRecorder } from '../../../src/context-gateway/context-gateway-v4-replay-material';
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
        'docs/rename-after.md',
        'src/current.ts',
        'src/invalid-utf8.dat',
        'src/search.ts',
      ]);
      expect(listed.receipts).toHaveLength(4);

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
      const searchEvents = parsed.events.filter(
        (event: { operationKind: string }) =>
          event.operationKind === 'text_search'
      );
      expect(searchEvents).toHaveLength(2);
      expect(searchEvents[0].result).toMatchObject({
        cursorInputHash: null,
        pagePathHashes: [sha256('src/search.ts')],
        aggregatePathCount: 1,
      });
      expect(searchEvents[1].result).toMatchObject({
        cursorInputHash: searchEvents[0].result.nextCursorHash,
        pagePathHashes: [],
        aggregatePathCount: 1,
      });
      const inventoryEvents = parsed.events.filter(
        (event: { operationKind: string }) =>
          event.operationKind === 'canonical_inventory'
      );
      expect(
        inventoryEvents
          .flatMap(
            (event: { result: { pagePathHashes: string[] } }) =>
              event.result.pagePathHashes
          )
          .sort()
      ).toEqual(inventoryPathHashes(inventory.items));
      const terminalInventory = inventoryEvents.at(-1)?.result;
      expect(terminalInventory).toMatchObject({
        aggregatePathCount: inventoryPathHashes(inventory.items).length,
        aggregatePathSetHash: sha256(
          canonicalJson(inventoryPathHashes(inventory.items))
        ),
      });
      expect(inventory.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'modified',
            beforePath: 'src/current.ts',
            afterPath: 'src/current.ts',
          }),
          expect.objectContaining({
            status: 'exact_rename',
            beforePath: 'docs/rename-before.md',
            afterPath: 'docs/rename-after.md',
          }),
        ])
      );
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
        startByte: head.startByte + head.byteCount,
        maxBytes: 1024,
      });
      expect(tail.startByte).toBe(head.startByte + head.byteCount);
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

  it('returns non-NUL invalid UTF-8 as base64 and records binary evidence', async () => {
    const fixture = await createFixture();
    try {
      const { gateway, recorder } = await createGateway(fixture);
      const result = await gateway.readFile({ path: 'src/invalid-utf8.dat' });

      expect(result).toMatchObject({
        content: Buffer.from([0xff, 0xfe, 0xfd]).toString('base64'),
        encoding: 'base64',
      });
      expect(recorder.snapshot().events[0]?.result).toMatchObject({
        contentKind: 'binary',
        lineCount: null,
      });
    } finally {
      await rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('searches query text as a fixed string', async () => {
    const fixture = await createFixture();
    try {
      const { gateway } = await createGateway(fixture);
      const searched = await gateway.searchText({
        query: 'users[0].*',
        paths: ['src'],
      });

      expect(searched.matches).toEqual(['src/search.ts:3:// users[0].*']);
      expect(searched.complete).toBe(true);
    } finally {
      await rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('canonicalizes safe virtual-root aliases without duplicating evidence', async () => {
    const fixture = await createFixture();
    try {
      const { gateway, recorder } = await createGateway(fixture);
      const first = await gateway.listDirectory({
        path: '.',
        maxDepth: 4,
        pageSize: 2,
      });
      const retried = await gateway.listDirectory({
        path: '.',
        maxDepth: 4,
        pageSize: 2,
      });
      const omitted = await gateway.listDirectory({
        maxDepth: 4,
        pageSize: 2,
      });
      const empty = await gateway.listDirectory({
        path: '',
        maxDepth: 4,
        pageSize: 2,
      });
      const virtualRoot = await gateway.listDirectory({
        path: '/',
        maxDepth: 4,
        pageSize: 2,
      });

      expect(retried).toEqual(first);
      expect(omitted).toEqual(first);
      expect(empty).toEqual(first);
      expect(virtualRoot).toEqual(first);
      expect(recorder.snapshot().events).toHaveLength(1);
      expect(recorder.snapshot().events[0]?.sequence).toBe(1);
    } finally {
      await rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('still rejects absolute directory paths and traversal outside the virtual root', async () => {
    const fixture = await createFixture();
    try {
      const { gateway, recorder } = await createGateway(fixture);

      await expect(gateway.listDirectory({ path: '/src' })).rejects.toThrow(
        'context_gateway_path_invalid'
      );
      expect(recorder.snapshot().confinementTainted).toBe(true);
    } finally {
      await rm(fixture.parent, { recursive: true, force: true });
    }

    const traversalFixture = await createFixture();
    try {
      const { gateway, recorder } = await createGateway(traversalFixture);

      await expect(gateway.listDirectory({ path: '../src' })).rejects.toThrow(
        'context_gateway_path_invalid'
      );
      expect(recorder.snapshot().confinementTainted).toBe(true);
    } finally {
      await rm(traversalFixture.parent, { recursive: true, force: true });
    }
  });

  it('deduplicates retries with omitted versus explicit operation defaults', async () => {
    const fixture = await createFixture();
    try {
      const { gateway, recorder, replayMaterial } =
        await createGateway(fixture);

      expect(await gateway.readFile({ path: 'src/current.ts' })).toEqual(
        await gateway.readFile({
          path: 'src/current.ts',
          revision: ContextGatewayV4Revision.Head,
          startByte: 0,
          maxBytes: 256 * 1024,
        })
      );
      expect(await gateway.listDirectory({ path: '.' })).toEqual(
        await gateway.listDirectory({
          path: '.',
          revision: ContextGatewayV4Revision.Head,
          maxDepth: 4,
          includeHidden: false,
          pageSize: 500,
        })
      );
      expect(
        await gateway.searchText({ query: 'SENSITIVE_QUERY_CANARY' })
      ).toEqual(
        await gateway.searchText({
          query: 'SENSITIVE_QUERY_CANARY',
          paths: ['.'],
          revision: ContextGatewayV4Revision.Head,
          caseSensitive: true,
          pageSize: 500,
        })
      );
      expect(await gateway.canonicalInventory({})).toEqual(
        await gateway.canonicalInventory({ pageSize: 500 })
      );

      expect(recorder.snapshot().events).toHaveLength(4);
      expect(replayMaterial.snapshot().entries).toHaveLength(4);
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
  const replayMaterialPath = path.join(
    fixture.parent,
    `replay-${Math.random()}.json`
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
  const replayMaterial = new ContextGatewayV4ReplayMaterialRecorder({
    sessionId: 'gateway-v4-session',
    replayMaterialPath,
    secret,
  });
  await replayMaterial.initialize();
  const gateway = await FilesystemContextGatewayV4.create({
    root: fixture.root,
    sessionId: 'gateway-v4-session',
    checkoutTreeOid: fixture.headTreeOid,
    mergeBaseSha: fixture.mergeBaseSha,
    headSha: fixture.headSha,
    secret,
    recorder,
    replayMaterial,
    now: () => 10_000,
  });
  return { gateway, recorder, replayMaterial, transcriptPath };
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
    '// SENSITIVE_QUERY_CANARY\n// SENSITIVE_QUERY_CANARY\n// users[0].*\n// users0xxxx\n'
  );
  await writeFile(path.join(root, 'docs', 'a.md'), 'a\n');
  await writeFile(path.join(root, 'docs', 'b.md'), 'b\n');
  await writeFile(path.join(root, 'docs', 'rename-before.md'), 'rename\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-qm', 'base']);
  const mergeBaseSha = await gitText(root, ['rev-parse', 'HEAD']);
  await rm(path.join(root, 'src', 'deleted.ts'));
  await writeFile(
    path.join(root, 'src', 'current.ts'),
    'export const current = 2;\n'
  );
  await writeFile(
    path.join(root, 'src', 'invalid-utf8.dat'),
    Buffer.from([0xff, 0xfe, 0xfd])
  );
  await writeFile(path.join(root, 'docs', 'c.md'), 'c\n');
  await git(root, ['mv', 'docs/rename-before.md', 'docs/rename-after.md']);
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

function inventoryPathHashes(items: readonly unknown[]): string[] {
  const paths = new Set<string>();
  for (const entry of items) {
    const item = entry as {
      afterPath: string | null;
      beforePath: string | null;
    };
    if (item.beforePath !== null) paths.add(item.beforePath);
    if (item.afterPath !== null) paths.add(item.afterPath);
  }
  return [...paths].map(sha256).sort();
}
