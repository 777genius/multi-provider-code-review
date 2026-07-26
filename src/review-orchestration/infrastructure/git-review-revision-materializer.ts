import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

type GitCommand = (
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  }
) => Promise<void>;

export class GitReviewRevisionMaterializer {
  constructor(private readonly runGit: GitCommand = runGitCommand) {}

  async ensureAvailable(input: {
    readonly checkoutRoot: string;
    readonly repository: string;
    readonly scmReadToken: string;
    readonly commitShas: readonly string[];
  }): Promise<void> {
    if (
      !GITHUB_REPOSITORY.test(input.repository) ||
      input.scmReadToken.length === 0
    ) {
      throw new Error('review_revision_materialization_input_invalid');
    }
    const commitShas = [...new Set(input.commitShas.map(normalizeCommitSha))];
    const missing: string[] = [];
    for (const commitSha of commitShas) {
      try {
        await this.runGit(['cat-file', '-e', `${commitSha}^{commit}`], {
          cwd: input.checkoutRoot,
          env: hardenedGitEnvironment(),
        });
      } catch {
        missing.push(commitSha);
      }
    }
    if (missing.length === 0) return;

    const authorization = Buffer.from(
      `x-access-token:${input.scmReadToken}`,
      'utf8'
    ).toString('base64');
    await this.runGit(
      [
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        '--depth=1',
        `https://github.com/${input.repository}.git`,
        ...missing,
      ],
      {
        cwd: input.checkoutRoot,
        env: {
          ...hardenedGitEnvironment(),
          GIT_CONFIG_COUNT: '2',
          GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
          GIT_CONFIG_KEY_1: 'credential.helper',
          GIT_CONFIG_VALUE_1: '',
        },
      }
    );
    for (const commitSha of missing) {
      try {
        await this.runGit(['cat-file', '-e', `${commitSha}^{commit}`], {
          cwd: input.checkoutRoot,
          env: hardenedGitEnvironment(),
        });
      } catch (error) {
        throw new Error('review_revision_materialization_incomplete', {
          cause: error,
        });
      }
    }
  }
}

function normalizeCommitSha(value: string): string {
  const normalized = value.toLowerCase();
  if (!COMMIT_SHA.test(normalized)) {
    throw new Error('review_revision_materialization_sha_invalid');
  }
  return normalized;
}

function hardenedGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
}

async function runGitCommand(
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  }
): Promise<void> {
  await execFileAsync('git', args, {
    cwd: options.cwd,
    env: options.env,
    timeout: 60_000,
    maxBuffer: 256 * 1_024,
  });
}
