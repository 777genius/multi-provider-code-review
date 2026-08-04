import { execFile } from 'child_process';
import { FileChange } from '../types';
import { logger } from '../utils/logger';

const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/i;
const MAX_LOCAL_DIFF_FILES = 20_000;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const GIT_DIFF_TIMEOUT_MS = 30_000;

interface FileStatus {
  status: FileChange['status'];
  previousFilename?: string;
}

interface FileStats {
  additions: number;
  deletions: number;
}

export type LocalPullRequestDiffLoader = (
  baseSha: string,
  headSha: string
) => Promise<FileChange[] | null>;

export async function loadPullRequestFilesFromGit(
  baseSha: string,
  headSha: string
): Promise<FileChange[] | null> {
  if (!GIT_OBJECT_ID.test(baseSha) || !GIT_OBJECT_ID.test(headSha)) {
    return null;
  }

  const cwd = process.env.REVIEW_ROUTER_PR_WORKSPACE || process.cwd();
  try {
    const range = `${baseSha}..${headSha}`;
    const [nameStatus, numstat] = await Promise.all([
      runGit(
        [
          'diff',
          '--name-status',
          '-z',
          '--find-renames',
          '--no-ext-diff',
          range,
        ],
        cwd
      ),
      runGit(
        ['diff', '--numstat', '-z', '--find-renames', '--no-ext-diff', range],
        cwd
      ),
    ]);

    const files = mergeGitDiffMetadata(nameStatus, numstat);
    if (files.length > MAX_LOCAL_DIFF_FILES) {
      logger.warn(
        `Local git diff contains ${files.length} files, exceeding the ${MAX_LOCAL_DIFF_FILES}-file safety limit.`
      );
      return null;
    }
    return files;
  } catch (error) {
    logger.warn(
      `Unable to recover the complete PR file list from local git: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

export function mergeGitDiffMetadata(
  nameStatusOutput: string,
  numstatOutput: string
): FileChange[] {
  const statuses = parseNameStatus(nameStatusOutput);
  const stats = parseNumstat(numstatOutput);

  return [...statuses.entries()].map(([filename, status]) => {
    const fileStats = stats.get(filename) || { additions: 0, deletions: 0 };
    return {
      filename,
      status: status.status,
      additions: fileStats.additions,
      deletions: fileStats.deletions,
      changes: fileStats.additions + fileStats.deletions,
      ...(status.previousFilename
        ? { previousFilename: status.previousFilename }
        : {}),
    };
  });
}

function parseNameStatus(output: string): Map<string, FileStatus> {
  const fields = splitNullDelimited(output);
  const statuses = new Map<string, FileStatus>();

  for (let index = 0; index < fields.length;) {
    const statusCode = fields[index++];
    if (!statusCode) {
      continue;
    }

    const kind = statusCode[0];
    if (kind === 'R' || kind === 'C') {
      const previousFilename = fields[index++];
      const filename = fields[index++];
      if (!previousFilename || !filename) {
        throw new Error('Malformed rename entry in git name-status output.');
      }
      statuses.set(filename, {
        status: kind === 'R' ? 'renamed' : 'added',
        ...(kind === 'R' ? { previousFilename } : {}),
      });
      continue;
    }

    const filename = fields[index++];
    if (!filename) {
      throw new Error('Malformed entry in git name-status output.');
    }
    statuses.set(filename, { status: mapGitStatus(kind) });
  }

  return statuses;
}

function parseNumstat(output: string): Map<string, FileStats> {
  const fields = splitNullDelimited(output);
  const stats = new Map<string, FileStats>();

  for (let index = 0; index < fields.length;) {
    const entry = fields[index++];
    if (!entry) {
      continue;
    }

    const [rawAdditions, rawDeletions, ...pathParts] = entry.split('\t');
    let filename = pathParts.join('\t');
    if (!filename) {
      const previousFilename = fields[index++];
      filename = fields[index++];
      if (!previousFilename || !filename) {
        throw new Error('Malformed rename entry in git numstat output.');
      }
    }

    stats.set(filename, {
      additions: parseLineCount(rawAdditions),
      deletions: parseLineCount(rawDeletions),
    });
  }

  return stats;
}

function splitNullDelimited(output: string): string[] {
  const fields = output.split('\0');
  if (fields.at(-1) === '') {
    fields.pop();
  }
  return fields;
}

function parseLineCount(value: string | undefined): number {
  if (!value || value === '-') {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function mapGitStatus(status: string): FileChange['status'] {
  switch (status) {
    case 'A':
      return 'added';
    case 'D':
      return 'removed';
    default:
      return 'modified';
  }
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: GIT_DIFF_TIMEOUT_MS,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      }
    );
  });
}
