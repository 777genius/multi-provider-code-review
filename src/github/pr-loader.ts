import { GitHubClient } from './client';
import {
  FileChange,
  GitHubFileLimitOmission,
  PRContext,
  PullRequestLoadCompleteness,
  PullRequestLoadOmission,
  PullRequestLoadOmissionReason,
  PullRequestLoadStatus,
} from '../types';
import { logger } from '../utils/logger';
import {
  loadPullRequestFilesFromGit,
  LocalPullRequestDiffLoader,
} from './local-git-diff';
import {
  isPathInReviewShard,
  readReviewPathShard,
  type ReviewPathShard,
} from '../review-execution/domain';

const FILES_PER_PAGE = 100;
const MAX_GITHUB_FILES = 3000;
const MAX_RAW_DIFF_FILES = 300;
const MAX_SYNTHESIZED_DIFF_BYTES = 8 * 1024 * 1024;

interface DiffLoadResult {
  diff: string;
  omittedFiles: string[];
}

export class PullRequestLoader {
  constructor(
    private readonly client: GitHubClient,
    private readonly localDiffLoader: LocalPullRequestDiffLoader = loadPullRequestFilesFromGit,
    private readonly pathShard: ReviewPathShard | null = readReviewPathShard()
  ) {}

  async load(prNumber: number): Promise<PRContext> {
    const { octokit, owner, repo } = this.client;

    const prResponse = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    const pr = prResponse.data;
    const baseSha = pr.base?.sha || '';
    const headSha = pr.head?.sha || '';

    this.warnIfExpectedBaseShaChanged(prNumber, baseSha);
    this.assertExpectedHeadSha(prNumber, headSha);

    const files: FileChange[] = [];
    for (let page = 1; files.length < MAX_GITHUB_FILES; page += 1) {
      const res = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: prNumber,
        page,
        per_page: FILES_PER_PAGE,
      });

      const remaining = MAX_GITHUB_FILES - files.length;
      files.push(
        ...res.data.slice(0, remaining).map((file) => ({
          filename: file.filename,
          status: (file.status as FileChange['status']) || 'modified',
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          patch: file.patch || undefined,
          previousFilename: file.previous_filename || undefined,
        }))
      );

      if (res.data.length < FILES_PER_PAGE) {
        break;
      }
    }

    const omissions: PullRequestLoadOmission[] = [];
    let fileLimitOmission = this.getFileLimitOmission(
      files.length,
      pr.changed_files
    );
    if (fileLimitOmission) {
      const localFiles = await this.localDiffLoader(baseSha, headSha);
      const localDiffIsComplete =
        localFiles !== null &&
        (pr.changed_files === undefined
          ? localFiles.length >= files.length
          : localFiles.length === pr.changed_files);

      if (localFiles && localDiffIsComplete) {
        const githubFilesByPath = new Map(
          files.map((file) => [file.filename, file] as const)
        );
        const recoveredFiles = localFiles.map((file) => {
          const githubFile = githubFilesByPath.get(file.filename);
          return githubFile?.patch
            ? { ...file, patch: githubFile.patch }
            : file;
        });
        files.splice(0, files.length, ...recoveredFiles);
        fileLimitOmission = null;
        logger.info(
          `Recovered the complete ${files.length}-file list for PR #${prNumber} from local git after reaching GitHub's API limit.`
        );
      } else {
        omissions.push(fileLimitOmission);
        const omittedCount = fileLimitOmission.omittedFileCount;
        logger.warn(
          `PR #${prNumber} reached GitHub's ${MAX_GITHUB_FILES}-file API limit; ${omittedCount === undefined ? 'an unknown number of additional files were' : `${omittedCount} additional file(s) were`} omitted.`
        );
      }
    }

    const totalFiles = files.length;
    const pathShard = this.pathShard;
    const reviewFiles = pathShard
      ? files.filter((file) => isPathInReviewShard(file.filename, pathShard))
      : files;
    if (pathShard) {
      logger.info(
        `Review path shard ${pathShard.index + 1}/${pathShard.count} selected ${reviewFiles.length} of ${totalFiles} file(s) for PR #${prNumber}.`
      );
    }

    const diffResult = await this.fetchDiff(owner, repo, prNumber, reviewFiles);
    if (diffResult.omittedFiles.length > 0) {
      omissions.push({
        reason: PullRequestLoadOmissionReason.SynthesizedDiffSizeLimit,
        omittedFileCount: diffResult.omittedFiles.length,
        omittedFiles: diffResult.omittedFiles,
      });
    }

    const verifiedPrResponse = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    this.assertRevisionUnchanged(
      prNumber,
      { baseSha, headSha },
      {
        baseSha: verifiedPrResponse.data.base?.sha || '',
        headSha: verifiedPrResponse.data.head?.sha || '',
      }
    );

    return {
      number: pr.number,
      title: pr.title || '',
      body: pr.body || '',
      author: pr.user?.login || 'unknown',
      draft: Boolean(pr.draft),
      labels: (pr.labels || []).map((label) =>
        typeof label === 'string' ? label : label.name || ''
      ),
      files: reviewFiles,
      diff: diffResult.diff,
      additions: this.pathShard
        ? reviewFiles.reduce((total, file) => total + file.additions, 0)
        : pr.additions || 0,
      deletions: this.pathShard
        ? reviewFiles.reduce((total, file) => total + file.deletions, 0)
        : pr.deletions || 0,
      baseSha,
      headSha,
      ...(this.pathShard
        ? {
            pathShard: {
              ...this.pathShard,
              totalFiles,
            },
          }
        : {}),
      loadCompleteness: this.describeCompleteness(omissions),
    };
  }

  private async fetchDiff(
    owner: string,
    repo: string,
    prNumber: number,
    files: FileChange[]
  ): Promise<DiffLoadResult> {
    if (files.length === 0) {
      return { diff: '', omittedFiles: [] };
    }
    if (this.pathShard) {
      return this.synthesizeDiff(prNumber, files);
    }
    if (files.length > MAX_RAW_DIFF_FILES) {
      logger.warn(
        `PR #${prNumber} exceeds GitHub's ${MAX_RAW_DIFF_FILES}-file raw diff limit; using paginated file patches.`
      );
      return this.synthesizeDiff(prNumber, files);
    }

    const { octokit } = this.client;
    try {
      const res = await octokit.request(
        'GET /repos/{owner}/{repo}/pulls/{pull_number}',
        {
          owner,
          repo,
          pull_number: prNumber,
          headers: { accept: 'application/vnd.github.v3.diff' },
        }
      );
      return {
        diff: typeof res.data === 'string' ? res.data : '',
        omittedFiles: [],
      };
    } catch (error) {
      if (!this.isRawDiffFallbackError(error)) {
        throw error;
      }
      if (!this.isDiffTooLargeError(error)) {
        logger.warn(
          `GitHub raw diff request for PR #${prNumber} failed with HTTP ${this.getGitHubHttpStatus(error)}; using paginated file patches.`
        );
        return this.synthesizeDiff(prNumber, files);
      }
      logger.warn(
        `GitHub rejected the raw diff for PR #${prNumber} as too large; using paginated file patches.`
      );
      return this.synthesizeDiff(prNumber, files);
    }
  }

  private synthesizeDiff(
    prNumber: number,
    files: FileChange[]
  ): DiffLoadResult {
    const blocks: string[] = [];
    let byteCount = 0;

    for (const [index, file] of files.entries()) {
      const oldPath = file.previousFilename || file.filename;
      const fromPath = file.status === 'added' ? '/dev/null' : `a/${oldPath}`;
      const toPath =
        file.status === 'removed' ? '/dev/null' : `b/${file.filename}`;
      const patch =
        file.patch || 'Binary file or patch unavailable from GitHub API';
      const block = [
        `diff --git a/${oldPath} b/${file.filename}`,
        `--- ${fromPath}`,
        `+++ ${toPath}`,
        patch,
        '',
      ].join('\n');
      const blockBytes = Buffer.byteLength(block, 'utf8');

      if (byteCount + blockBytes > MAX_SYNTHESIZED_DIFF_BYTES) {
        const omittedFiles = files.slice(index).map(({ filename }) => filename);
        logger.warn(
          `Synthesized diff for PR #${prNumber} reached the ${MAX_SYNTHESIZED_DIFF_BYTES}-byte safety limit; ${omittedFiles.length} remaining file(s) were omitted.`
        );
        return { diff: blocks.join('\n'), omittedFiles };
      }

      blocks.push(block);
      byteCount += blockBytes;
    }

    return { diff: blocks.join('\n'), omittedFiles: [] };
  }

  private getFileLimitOmission(
    loadedFileCount: number,
    reportedChangedFileCount: number | undefined
  ): GitHubFileLimitOmission | null {
    if (
      loadedFileCount < MAX_GITHUB_FILES ||
      reportedChangedFileCount === loadedFileCount
    ) {
      return null;
    }

    const omittedFileCount =
      reportedChangedFileCount !== undefined &&
      reportedChangedFileCount > loadedFileCount
        ? reportedChangedFileCount - loadedFileCount
        : undefined;

    return {
      reason: PullRequestLoadOmissionReason.GitHubFileLimit,
      ...(omittedFileCount === undefined ? {} : { omittedFileCount }),
    };
  }

  private describeCompleteness(
    omissions: PullRequestLoadOmission[]
  ): PullRequestLoadCompleteness {
    const [firstOmission, ...remainingOmissions] = omissions;
    if (!firstOmission) {
      return {
        status: PullRequestLoadStatus.Complete,
        omissions: [],
      };
    }

    return {
      status: PullRequestLoadStatus.Truncated,
      omissions: [firstOmission, ...remainingOmissions],
    };
  }

  private warnIfExpectedBaseShaChanged(
    prNumber: number,
    actualSha: string
  ): void {
    const expectedSha = process.env.REVIEWROUTER_BASE_SHA?.trim();
    if (!expectedSha || expectedSha === actualSha) {
      return;
    }

    logger.warn(
      `PR #${prNumber} base SHA changed from ${expectedSha} in the workflow event to ${actualSha || '(missing)'} on GitHub; loading the current base revision.`
    );
  }

  private assertExpectedHeadSha(prNumber: number, actualSha: string): void {
    const expectedSha = process.env.REVIEWROUTER_HEAD_SHA?.trim();
    if (!expectedSha || expectedSha === actualSha) {
      return;
    }

    throw new Error(
      `PR #${prNumber} head SHA mismatch: expected ${expectedSha} from REVIEWROUTER_HEAD_SHA, received ${actualSha || '(missing)'} from GitHub; refusing to load a potentially mixed revision.`
    );
  }

  private assertRevisionUnchanged(
    prNumber: number,
    initial: { baseSha: string; headSha: string },
    verified: { baseSha: string; headSha: string }
  ): void {
    const changes = [
      initial.headSha === verified.headSha
        ? null
        : `head changed from ${initial.headSha || '(missing)'} to ${verified.headSha || '(missing)'}`,
      initial.baseSha === verified.baseSha
        ? null
        : `base changed from ${initial.baseSha || '(missing)'} to ${verified.baseSha || '(missing)'}`,
    ].filter((change): change is string => change !== null);

    if (changes.length === 0) {
      return;
    }

    throw new Error(
      `PR #${prNumber} revision changed while loading content: ${changes.join(', ')}; refusing to return a potentially mixed revision.`
    );
  }

  private isDiffTooLargeError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const candidate = error as {
      status?: number;
      message?: string;
      response?: {
        data?: { message?: string; errors?: Array<{ code?: string }> };
      };
    };
    const message = `${candidate.message || ''} ${candidate.response?.data?.message || ''}`;
    const hasTooLargeCode = candidate.response?.data?.errors?.some(
      ({ code }) => code === 'too_large'
    );

    return (
      candidate.status === 422 &&
      (Boolean(hasTooLargeCode) ||
        /diff exceeded|maximum number of files|too large/i.test(message))
    );
  }

  private isRawDiffFallbackError(error: unknown): boolean {
    return this.isDiffTooLargeError(error) || this.isGitHubHttpError(error);
  }

  private isGitHubHttpError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const candidate = error as { name?: string; status?: unknown };
    return (
      typeof candidate.status === 'number' &&
      (candidate.name === 'HttpError' || candidate.status >= 400)
    );
  }

  private getGitHubHttpStatus(error: unknown): number | string {
    if (!error || typeof error !== 'object') {
      return 'unknown';
    }

    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : 'unknown';
  }
}
