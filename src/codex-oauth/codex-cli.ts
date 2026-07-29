import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export const CODEX_OAUTH_PINNED_CODEX_PACKAGE = '@openai/codex@0.145.0';

const CODEX_OAUTH_CLI_INSTALL_TIMEOUT_MS = 300_000;

export type PreparedCodexCli = {
  binaryPath: string;
  clear?(): Promise<void>;
};

type CodexCliLogger = {
  info(message: string): void;
  warn(message: string): void;
};

export async function prepareCodexCliBeforeAuthRead(
  input: {
    logger?: CodexCliLogger;
    timeoutMs?: number;
  } = {}
): Promise<PreparedCodexCli> {
  const explicit = process.env.REVIEWROUTER_CODEX_BINARY?.trim();
  if (explicit) {
    await assertCodexBinaryWorks(explicit, input.timeoutMs ?? 10_000);
    return { binaryPath: explicit };
  }

  if (await canRunCodexBinary('codex', input.timeoutMs ?? 10_000)) {
    return { binaryPath: 'codex' };
  }

  input.logger?.info(
    `Codex CLI not found on PATH; installing ${CODEX_OAUTH_PINNED_CODEX_PACKAGE} before auth materialization.`
  );
  const installRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'reviewrouter-codex-cli-')
  );
  await runNpmInstall({
    installRoot,
    timeoutMs: input.timeoutMs ?? CODEX_OAUTH_CLI_INSTALL_TIMEOUT_MS,
  });
  const binaryPath = path.join(installRoot, 'node_modules', '.bin', 'codex');
  await assertCodexBinaryWorks(binaryPath, input.timeoutMs ?? 10_000);
  return {
    binaryPath,
    async clear() {
      await fs.rm(installRoot, { recursive: true, force: true });
    },
  };
}

async function assertCodexBinaryWorks(
  binaryPath: string,
  timeoutMs: number
): Promise<void> {
  if (!(await canRunCodexBinary(binaryPath, timeoutMs))) {
    throw new Error('codex_oauth_codex_cli_unavailable');
  }
}

async function canRunCodexBinary(
  binaryPath: string,
  timeoutMs: number
): Promise<boolean> {
  try {
    await runCommand(binaryPath, ['--version'], {
      timeoutMs,
      cwd: os.tmpdir(),
      env: safePreAuthEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

async function runNpmInstall(input: {
  installRoot: string;
  timeoutMs: number;
}): Promise<void> {
  await runCommand(
    'npm',
    [
      'install',
      '--prefix',
      input.installRoot,
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      CODEX_OAUTH_PINNED_CODEX_PACKAGE,
    ],
    {
      timeoutMs: input.timeoutMs,
      cwd: input.installRoot,
      env: safePreAuthEnv(),
    }
  );
}

function runCommand(
  command: string,
  args: readonly string[],
  options: {
    timeoutMs: number;
    cwd: string;
    env: NodeJS.ProcessEnv;
  }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      reject(new Error('codex_oauth_codex_cli_prepare_timeout'));
    }, options.timeoutMs);
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      if (timedOut) return;
      clearTimeout(timer);
      reject(
        new Error(
          `codex_oauth_codex_cli_prepare_failed:${safeOutput(String(error))}`
        )
      );
    });
    child.on('close', (code) => {
      if (timedOut) return;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `codex_oauth_codex_cli_prepare_failed:${code ?? 'signal'}:${safeOutput(
            stderr
          )}`
        )
      );
    });
  });
}

function safePreAuthEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || os.tmpdir(),
    npm_config_loglevel: 'error',
  };
}

function safeOutput(value: string): string {
  return value
    .replace(/ghs_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .slice(0, 200);
}
