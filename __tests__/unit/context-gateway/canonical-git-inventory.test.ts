import { execFile } from 'child_process';
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
      expect(first.inventoryHash).toMatch(/^[a-f0-9]{64}$/);
      expect(first.mergeBaseTreeOid).toMatch(/^[a-f0-9]{40,64}$/);
      expect(first.headTreeOid).toMatch(/^[a-f0-9]{40,64}$/);

      const renamed = first.entries.find(
        (entry) => entry.status === CanonicalInventoryStatus.ExactRename
      );
      expect(renamed).toMatchObject({
        beforePath: 'src/old-name.ts',
        afterPath: 'src/new-name.ts',
        contentKind: CanonicalInventoryContentKind.Text,
      });
      expect(find(first, 'src/deleted.py')).toMatchObject({
        status: CanonicalInventoryStatus.Deleted,
        afterPath: null,
        contentKind: CanonicalInventoryContentKind.Text,
      });
      expect(find(first, 'links/service-link').contentKind).toBe(
        CanonicalInventoryContentKind.Symlink
      );
      expect(find(first, 'assets/payload.bin').contentKind).toBe(
        CanonicalInventoryContentKind.Binary
      );
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
});

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
