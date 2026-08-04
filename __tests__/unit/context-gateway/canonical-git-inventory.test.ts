import { execFile, spawn } from 'child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import {
  buildCanonicalGitInventory,
  CanonicalInventoryContentKind,
  CanonicalInventoryStatus,
} from '../../../src/context-gateway/canonical-git-inventory';

const execFileAsync = promisify(execFile);

describe('canonical Git inventory', () => {
  it('is config-independent and preserves exact object semantics', async () => {
    const fixture = await createFixture();
    try {
      const first = await buildCanonicalGitInventory(fixture);
      await git(fixture.root, ['config', 'diff.renames', 'copies']);
      await git(fixture.root, ['config', 'diff.external', '/usr/bin/false']);
      const second = await buildCanonicalGitInventory(fixture);
      expect(second).toEqual(first);
      expect(first.inventoryVersion).toBe(2);
      expect(first.inventoryHash).toMatch(/^[a-f0-9]{64}$/);
      expect(first.mergeBaseTreeOid).toMatch(/^[a-f0-9]{40,64}$/);
      expect(first.headTreeOid).toMatch(/^[a-f0-9]{40,64}$/);

      const renamed = first.entries.find(
        (entry) => entry.status === CanonicalInventoryStatus.ExactRename
      );
      expect(renamed).toMatchObject({
        beforePath: 'src/old-name.ts',
        afterPath: 'src/new-name.ts',
        beforeContentKind: CanonicalInventoryContentKind.Text,
        afterContentKind: CanonicalInventoryContentKind.Text,
        contentKind: CanonicalInventoryContentKind.Text,
      });
      expect(find(first, 'src/deleted.py')).toMatchObject({
        status: CanonicalInventoryStatus.Deleted,
        afterPath: null,
        beforeContentKind: CanonicalInventoryContentKind.Text,
        afterContentKind: CanonicalInventoryContentKind.Absent,
        contentKind: CanonicalInventoryContentKind.Text,
      });
      expect(find(first, 'links/service-link').contentKind).toBe(
        CanonicalInventoryContentKind.Symlink
      );
      expect(find(first, 'assets/payload.bin').contentKind).toBe(
        CanonicalInventoryContentKind.Binary
      );
      expect(find(first, 'assets/payload.bin')).toMatchObject({
        beforeContentKind: CanonicalInventoryContentKind.Absent,
        afterContentKind: CanonicalInventoryContentKind.Binary,
      });
      expect(find(first, 'assets/model.dat').contentKind).toBe(
        CanonicalInventoryContentKind.LfsPointer
      );
      expect(find(first, 'generated/client.generated.ts')).toMatchObject({
        generated: true,
        generatedPolicySource: 'path_heuristic_v1',
      });
    } finally {
      await rm(fixture.parent, { recursive: true, force: true });
    }
  });

  it('keeps edited rename candidates as delete plus add', async () => {
    const parent = await mkdtemp(
      path.join(os.tmpdir(), 'rr-inventory-edited-')
    );
    const root = path.join(parent, 'root');
    await mkdir(root);
    try {
      await initializeRepo(root);
      await writeFile(
        path.join(root, 'before.ts'),
        'export const value = 1;\n'
      );
      await git(root, ['add', '.']);
      await git(root, ['commit', '-qm', 'base']);
      const mergeBaseSha = await gitText(root, ['rev-parse', 'HEAD']);
      await git(root, ['mv', 'before.ts', 'after.ts']);
      await writeFile(path.join(root, 'after.ts'), 'export const value = 2;\n');
      await git(root, ['add', '-A']);
      await git(root, ['commit', '-qm', 'head']);
      const headSha = await gitText(root, ['rev-parse', 'HEAD']);

      const inventory = await buildCanonicalGitInventory({
        root,
        mergeBaseSha,
        headSha,
      });
      expect(inventory.entries.map((entry) => entry.status).sort()).toEqual([
        CanonicalInventoryStatus.Added,
        CanonicalInventoryStatus.Deleted,
      ]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('classifies both revisions independently across non-text to text transitions', async () => {
    const parent = await mkdtemp(
      path.join(os.tmpdir(), 'rr-inventory-transitions-')
    );
    const root = path.join(parent, 'root');
    await mkdir(root);
    try {
      await initializeRepo(root);
      await writeFile(path.join(root, 'anchor.txt'), 'anchor\n');
      await git(root, ['add', '.']);
      await git(root, ['commit', '-qm', 'anchor']);
      const anchorOid = await gitText(root, ['rev-parse', 'HEAD']);

      await mkdir(path.join(root, 'assets'));
      await writeFile(
        path.join(root, 'assets', 'binary.dat'),
        Buffer.from([0, 1, 2, 255])
      );
      await writeFile(
        path.join(root, 'assets', 'pointer.dat'),
        `version https://git-lfs.github.com/spec/v1\noid sha256:${'b'.repeat(64)}\nsize 42\n`
      );
      await writeFile(
        path.join(root, 'assets', 'oversized.dat'),
        Buffer.alloc(2 * 1024 * 1024 + 1, 97)
      );
      await writeFile(path.join(root, 'assets', 'to-binary.dat'), 'was text\n');
      await writeFile(
        path.join(root, 'assets', 'invalid-utf8.dat'),
        'was text\n'
      );
      await git(root, ['add', '.']);
      await git(root, [
        'update-index',
        '--add',
        '--cacheinfo',
        `160000,${anchorOid},vendor/dependency`,
      ]);
      await git(root, ['commit', '-qm', 'base non-text revisions']);
      const mergeBaseSha = await gitText(root, ['rev-parse', 'HEAD']);

      await Promise.all([
        writeFile(path.join(root, 'assets', 'binary.dat'), 'now text\n'),
        writeFile(path.join(root, 'assets', 'pointer.dat'), 'now text\n'),
        writeFile(path.join(root, 'assets', 'oversized.dat'), 'now text\n'),
        writeFile(
          path.join(root, 'assets', 'to-binary.dat'),
          Buffer.from([0, 4, 5, 6])
        ),
        writeFile(
          path.join(root, 'assets', 'invalid-utf8.dat'),
          Buffer.from([0xff, 0xfe, 0xfd])
        ),
      ]);
      await git(root, ['rm', '--cached', 'vendor/dependency']);
      await mkdir(path.join(root, 'vendor'));
      await writeFile(path.join(root, 'vendor', 'dependency'), 'now text\n');
      await git(root, ['add', '-A']);
      await git(root, ['commit', '-qm', 'head text revisions']);
      const headSha = await gitText(root, ['rev-parse', 'HEAD']);

      const inventory = await buildCanonicalGitInventory({
        root,
        mergeBaseSha,
        headSha,
      });
      expectTransition(
        inventory,
        'assets/binary.dat',
        CanonicalInventoryContentKind.Binary
      );
      expectTransition(
        inventory,
        'assets/pointer.dat',
        CanonicalInventoryContentKind.LfsPointer
      );
      expectTransition(
        inventory,
        'assets/oversized.dat',
        CanonicalInventoryContentKind.Oversized
      );
      expectTransition(
        inventory,
        'vendor/dependency',
        CanonicalInventoryContentKind.Gitlink
      );
      expect(find(inventory, 'assets/to-binary.dat')).toMatchObject({
        status: CanonicalInventoryStatus.Modified,
        beforeContentKind: CanonicalInventoryContentKind.Text,
        afterContentKind: CanonicalInventoryContentKind.Binary,
        contentKind: CanonicalInventoryContentKind.Binary,
      });
      expect(find(inventory, 'assets/invalid-utf8.dat')).toMatchObject({
        status: CanonicalInventoryStatus.Modified,
        beforeContentKind: CanonicalInventoryContentKind.Text,
        afterContentKind: CanonicalInventoryContentKind.Binary,
        contentKind: CanonicalInventoryContentKind.Binary,
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('fails closed when Git returns a path that is not valid UTF-8', async () => {
    const parent = await mkdtemp(
      path.join(os.tmpdir(), 'rr-inventory-invalid-path-')
    );
    const root = path.join(parent, 'root');
    await mkdir(root);
    try {
      await initializeRepo(root);
      await writeFile(path.join(root, 'anchor.txt'), 'anchor\n');
      await git(root, ['add', '.']);
      await git(root, ['commit', '-qm', 'base']);
      const mergeBaseSha = await gitText(root, ['rev-parse', 'HEAD']);
      const blobOid = (
        await gitWithInput(root, ['hash-object', '-w', '--stdin'], 'content\n')
      )
        .toString('ascii')
        .trim();
      await gitWithInput(
        root,
        ['update-index', '-z', '--index-info'],
        Buffer.concat([
          Buffer.from(`100644 ${blobOid}\tinvalid-`, 'ascii'),
          Buffer.from([0x80]),
          Buffer.from('.txt\0', 'ascii'),
        ])
      );
      await git(root, ['commit', '-qm', 'invalid path']);
      const headSha = await gitText(root, ['rev-parse', 'HEAD']);

      await expect(
        buildCanonicalGitInventory({ root, mergeBaseSha, headSha })
      ).rejects.toThrow('canonical_inventory_path_encoding_invalid');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('pairs duplicate-OID renames using deterministic code-unit ordering', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'rr-inventory-order-'));
    const root = path.join(parent, 'root');
    await mkdir(root);
    try {
      await initializeRepo(root);
      await writeFile(path.join(root, 'Z-old.ts'), 'same\n');
      await writeFile(path.join(root, 'a-old.ts'), 'same\n');
      await git(root, ['add', '.']);
      await git(root, ['commit', '-qm', 'base']);
      const mergeBaseSha = await gitText(root, ['rev-parse', 'HEAD']);
      await rm(path.join(root, 'Z-old.ts'));
      await rm(path.join(root, 'a-old.ts'));
      await writeFile(path.join(root, 'A-new.ts'), 'same\n');
      await writeFile(path.join(root, 'z-new.ts'), 'same\n');
      await git(root, ['add', '-A']);
      await git(root, ['commit', '-qm', 'head']);
      const headSha = await gitText(root, ['rev-parse', 'HEAD']);

      const inventory = await buildCanonicalGitInventory({
        root,
        mergeBaseSha,
        headSha,
      });
      expect(
        inventory.entries.map(({ beforePath, afterPath }) => ({
          beforePath,
          afterPath,
        }))
      ).toEqual([
        { beforePath: 'Z-old.ts', afterPath: 'A-new.ts' },
        { beforePath: 'a-old.ts', afterPath: 'z-new.ts' },
      ]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

function expectTransition(
  inventory: Awaited<ReturnType<typeof buildCanonicalGitInventory>>,
  target: string,
  beforeContentKind: CanonicalInventoryContentKind
) {
  expect(find(inventory, target)).toMatchObject({
    status:
      beforeContentKind === CanonicalInventoryContentKind.Gitlink
        ? CanonicalInventoryStatus.TypeChanged
        : CanonicalInventoryStatus.Modified,
    beforeContentKind,
    afterContentKind: CanonicalInventoryContentKind.Text,
    contentKind: CanonicalInventoryContentKind.Text,
  });
}

function find(
  inventory: Awaited<ReturnType<typeof buildCanonicalGitInventory>>,
  target: string
) {
  const entry = inventory.entries.find(
    (candidate) => (candidate.afterPath ?? candidate.beforePath) === target
  );
  if (!entry) throw new Error(`inventory entry missing: ${target}`);
  return entry;
}

async function createFixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'rr-inventory-v4-'));
  const root = path.join(parent, 'root');
  await mkdir(root);
  await initializeRepo(root);
  await Promise.all([
    mkdir(path.join(root, 'src')),
    mkdir(path.join(root, 'assets')),
    mkdir(path.join(root, 'generated')),
    mkdir(path.join(root, 'links')),
  ]);
  await writeFile(
    path.join(root, 'src', 'old-name.ts'),
    'export const service = true;\n'
  );
  await writeFile(path.join(root, 'src', 'deleted.py'), 'ACTIVE = True\n');
  await writeFile(
    path.join(root, 'generated', 'client.generated.ts'),
    '// generated v1\n'
  );
  await git(root, ['add', '.']);
  await git(root, ['commit', '-qm', 'base inventory']);
  const mergeBaseSha = await gitText(root, ['rev-parse', 'HEAD']);

  await git(root, ['mv', 'src/old-name.ts', 'src/new-name.ts']);
  await rm(path.join(root, 'src', 'deleted.py'));
  await symlink('../src/new-name.ts', path.join(root, 'links', 'service-link'));
  await writeFile(
    path.join(root, 'assets', 'payload.bin'),
    Buffer.from([0, 1, 2, 255])
  );
  await writeFile(
    path.join(root, 'assets', 'model.dat'),
    `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 42\n`
  );
  await writeFile(
    path.join(root, 'generated', 'client.generated.ts'),
    '// generated v2\n'
  );
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-qm', 'head inventory']);
  const headSha = await gitText(root, ['rev-parse', 'HEAD']);
  return { parent, root, mergeBaseSha, headSha };
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

async function gitWithInput(
  root: string,
  args: readonly string[],
  input: string | Buffer
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: root, stdio: 'pipe' });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }
      reject(
        new Error(
          `git ${args.join(' ')} failed (${code}): ${Buffer.concat(stderr).toString('utf8')}`
        )
      );
    });
    child.stdin.end(input);
  });
}
