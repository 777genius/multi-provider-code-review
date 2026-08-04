import { execFile } from 'child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { sha256 } from '../../../src/review-investigation/domain/canonical-json';

const execFileAsync = promisify(execFile);

export class DisposableInvestigationRepository {
  private constructor(
    readonly parent: string,
    readonly root: string,
    readonly baseSha: string,
    readonly mergeBaseSha: string,
    readonly headSha: string,
    readonly reviewRevisionHash: string
  ) {}

  static async create(
    files: Readonly<Record<string, string | Buffer>>,
    mutate: (fixture: MutableRepositoryFixture) => Promise<void>
  ): Promise<DisposableInvestigationRepository> {
    const parent = await mkdtemp(
      path.join(os.tmpdir(), 'reviewrouter-investigation-corpus-')
    );
    const root = path.join(parent, 'repo');
    await mkdir(root);
    await git(root, ['init', '-q', '--initial-branch=main']);
    await git(root, ['config', 'user.name', 'ReviewRouter E2E']);
    await git(root, ['config', 'user.email', 'e2e@example.invalid']);
    await writeFiles(root, files);
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'test: base']);
    const baseSha = await gitText(root, ['rev-parse', 'HEAD']);
    await mutate(new MutableRepositoryFixture(root));
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'test: head']);
    const headSha = await gitText(root, ['rev-parse', 'HEAD']);
    return new DisposableInvestigationRepository(
      parent,
      root,
      baseSha,
      baseSha,
      headSha,
      sha256(`revision:${baseSha}:${headSha}`)
    );
  }

  async dispose(): Promise<void> {
    await rm(this.parent, { recursive: true, force: true });
  }

  async headTreeOid(): Promise<string> {
    return gitText(this.root, ['rev-parse', `${this.headSha}^{tree}`]);
  }

  async commit(
    message: string,
    mutate: (fixture: MutableRepositoryFixture) => Promise<void>
  ): Promise<string> {
    await mutate(new MutableRepositoryFixture(this.root));
    await git(this.root, ['add', '-A']);
    await git(this.root, ['commit', '-qm', message]);
    return gitText(this.root, ['rev-parse', 'HEAD']);
  }
}

export class MutableRepositoryFixture {
  constructor(readonly root: string) {}

  async write(relativePath: string, content: string | Buffer): Promise<void> {
    const target = path.join(this.root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  async remove(relativePath: string): Promise<void> {
    await rm(path.join(this.root, relativePath), {
      recursive: true,
      force: true,
    });
  }

  async rename(from: string, to: string): Promise<void> {
    await mkdir(path.dirname(path.join(this.root, to)), { recursive: true });
    await git(this.root, ['mv', from, to]);
  }
}

async function writeFiles(
  root: string,
  files: Readonly<Record<string, string | Buffer>>
): Promise<void> {
  const fixture = new MutableRepositoryFixture(root);
  for (const [relativePath, content] of Object.entries(files)) {
    await fixture.write(relativePath, content);
  }
}

async function git(root: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd: root,
    env: gitEnvironment(),
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function gitText(root: string, args: readonly string[]): Promise<string> {
  return (
    await execFileAsync('git', args, {
      cwd: root,
      env: gitEnvironment(),
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout
    .trim()
    .toLowerCase();
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}
