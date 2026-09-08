import { execFile } from 'child_process';
import { access, mkdir, mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import { constants } from 'fs';
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
    await requireFixtureRm();
    const parent = await mkdtemp(
      path.join(os.tmpdir(), 'reviewrouter-investigation-corpus-')
    );
    const root = path.join(parent, 'repo');
    try {
      await mkdir(root);
      await git(root, ['init', '-q', '--initial-branch=main']);
      await git(root, [
        'config',
        'user.name',
        process.env.GIT_AUTHOR_NAME ??
          (await configuredIdentity(root, 'user.name')),
      ]);
      await git(root, [
        'config',
        'user.email',
        process.env.GIT_AUTHOR_EMAIL ??
          (await configuredIdentity(root, 'user.email')),
      ]);
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
    } catch (error) {
      await cleanupFixture([() => removeFixturePath(parent)], [error]);
      throw error;
    }
  }

  async dispose(): Promise<void> {
    await cleanupFixture([() => removeFixturePath(this.parent)]);
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
    await removeFixturePath(path.join(this.root, relativePath));
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
    env: await fixtureGitEnvironment(root),
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function gitText(root: string, args: readonly string[]): Promise<string> {
  return (
    await execFileAsync('git', args, {
      cwd: root,
      env: await fixtureGitEnvironment(root),
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout
    .trim()
    .toLowerCase();
}

// Strip inherited repository/author overrides while retaining host policy and hooks.
// Nested repositories must use this same environment as their parent fixture.
export async function fixtureGitEnvironment(
  root = os.tmpdir()
): Promise<NodeJS.ProcessEnv> {
  const env = selectFixtureGitEnvironment(process.env, []);
  const { stdout } = await execFileAsync(
    'git',
    ['config', '--null', '--name-only', '--list'],
    { cwd: root, env }
  );
  return selectFixtureGitEnvironment(process.env, stdout.split('\0'));
}

// Preserve host config sources (including hooks/identity), override only content.
export function selectFixtureGitEnvironment(
  ambient: NodeJS.ProcessEnv,
  configKeys: readonly string[]
): NodeJS.ProcessEnv {
  const settings: [string, string][] = [
    ['core.autocrlf', 'false'],
    ['core.eol', 'lf'],
    ['core.excludesFile', '/dev/null'],
    ['core.attributesFile', '/dev/null'],
  ];
  for (const key of new Set(configKeys)) {
    if (/^filter\..+\.(clean|smudge|process|required)$/i.test(key)) {
      settings.push([
        key,
        key.toLowerCase().endsWith('.required') ? 'false' : '',
      ]);
    }
  }
  const env: NodeJS.ProcessEnv = {
    PATH: ambient.PATH,
    HOME: ambient.HOME,
    XDG_CONFIG_HOME: ambient.XDG_CONFIG_HOME,
    GIT_CONFIG_SYSTEM: ambient.GIT_CONFIG_SYSTEM,
    GIT_CONFIG_GLOBAL: ambient.GIT_CONFIG_GLOBAL,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(settings.length),
  };
  settings.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

// Requires Unix-compatible rm accepting -rf -- on PATH. Check availability
// before allocation; no probe deletes anything or bypasses the host guard.
export async function requireFixtureRm(): Promise<void> {
  if (process.platform === 'win32') throw new Error('fixture_requires_unix_rm');
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    try {
      await access(path.resolve(directory, 'rm'), constants.X_OK);
      return;
    } catch {
      // Try the next PATH entry without executing cleanup.
    }
  }
  throw new Error('fixture_requires_unix_rm_on_PATH');
}

export async function cleanupFixture(
  cleanups: readonly (() => unknown)[],
  originalErrors: readonly unknown[] = []
): Promise<void> {
  const errors = [...originalErrors];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > originalErrors.length) {
    throw new AggregateError(errors, 'fixture_operation_or_cleanup_failed');
  }
  if (errors.length) throw errors[0];
}

// Honor host cleanup guards; a denied cleanup is a test failure, never a skip.
export async function removeFixturePath(target: string): Promise<void> {
  await execFileAsync('rm', ['-rf', '--', target]);
}

async function configuredIdentity(
  root: string,
  key: 'user.name' | 'user.email'
): Promise<string> {
  const result = await execFileAsync('git', ['config', '--get', key], {
    cwd: root,
    env: await fixtureGitEnvironment(root),
  }).catch((error: unknown) => {
    // Only an absent setting permits a fallback; host hooks remain authoritative.
    if (error instanceof Error && 'code' in error && error.code === 1) {
      return {
        stdout:
          key === 'user.name' ? 'ReviewRouter E2E' : 'e2e@example.invalid',
      };
    }
    throw error;
  });
  const value = result.stdout.trim();
  if (!value) throw new Error(`fixture_git_identity_missing:${key}`);
  return value;
}
