import { PullRequestLoader } from '../../../src/github/pr-loader';
import { GitHubClient } from '../../../src/github/client';
import {
  PullRequestLoadOmissionReason,
  PullRequestLoadStatus,
} from '../../../src/types';
import { isPathInReviewShard } from '../../../src/review-execution/domain';
import {
  createMockOctokit,
  createErrorOctokit,
} from '../../helpers/github-mock';

function createMockClient(
  octokit: ReturnType<typeof createMockOctokit>
): GitHubClient {
  return {
    octokit,
    owner: 'test-owner',
    repo: 'test-repo',
  } as unknown as GitHubClient;
}

function setReportedChangedFiles(
  octokit: ReturnType<typeof createMockOctokit>,
  changedFiles: number
): void {
  octokit.rest.pulls.get.mockResolvedValue({
    data: {
      number: 1,
      title: 'Test PR',
      body: 'Test description',
      draft: false,
      labels: [],
      additions: changedFiles,
      deletions: 0,
      changed_files: changedFiles,
      base: { sha: 'base-sha' },
      head: { sha: 'head-sha' },
      user: { login: 'test-user', type: 'User' },
    },
  });
}

function restoreEnvironmentVariable(
  name: 'REVIEWROUTER_BASE_SHA' | 'REVIEWROUTER_HEAD_SHA',
  value: string | undefined
): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('PullRequestLoader', () => {
  const originalBaseSha = process.env.REVIEWROUTER_BASE_SHA;
  const originalHeadSha = process.env.REVIEWROUTER_HEAD_SHA;

  beforeEach(() => {
    delete process.env.REVIEWROUTER_BASE_SHA;
    delete process.env.REVIEWROUTER_HEAD_SHA;
  });

  afterAll(() => {
    restoreEnvironmentVariable('REVIEWROUTER_BASE_SHA', originalBaseSha);
    restoreEnvironmentVariable('REVIEWROUTER_HEAD_SHA', originalHeadSha);
  });

  describe('load', () => {
    it('loads PR context successfully', async () => {
      const mockClient = createMockClient(createMockOctokit());
      const loader = new PullRequestLoader(mockClient);

      const context = await loader.load(1);

      expect(context).toBeDefined();
      expect(context.number).toBe(1);
      expect(context.title).toBe('Test PR');
      expect(context.author).toBe('test-user');
      expect(context.files).toHaveLength(1);
      expect(context.baseSha).toBe('base-sha');
      expect(context.headSha).toBe('head-sha');
      expect(context.loadCompleteness).toEqual({
        status: PullRequestLoadStatus.Complete,
        omissions: [],
      });
    });

    it('loads PR files', async () => {
      const mockClient = createMockClient(createMockOctokit());
      const loader = new PullRequestLoader(mockClient);

      const context = await loader.load(1);

      expect(context.files).toBeDefined();
      expect(context.files[0].filename).toBe('src/test.ts');
      expect(context.files[0].status).toBe('modified');
      expect(context.files[0].additions).toBe(5);
      expect(context.files[0].deletions).toBe(2);
    });

    it('handles PR with labels', async () => {
      const mockOctokit = createMockOctokit({
        pr: {
          labels: ['bug', 'enhancement'],
        },
      });
      const mockClient = createMockClient(mockOctokit);

      const loader = new PullRequestLoader(mockClient);
      const context = await loader.load(1);

      expect(context.labels).toEqual(['bug', 'enhancement']);
    });

    it('handles draft PR', async () => {
      const mockOctokit = createMockOctokit({
        pr: {
          draft: true,
        },
      });
      const mockClient = createMockClient(mockOctokit);

      const loader = new PullRequestLoader(mockClient);
      const context = await loader.load(1);

      expect(context.draft).toBe(true);
    });

    it('handles bot author', async () => {
      const mockOctokit = createMockOctokit({
        pr: {
          author: 'dependabot[bot]',
        },
      });
      const mockClient = createMockClient(mockOctokit);

      const loader = new PullRequestLoader(mockClient);
      const context = await loader.load(1);

      expect(context.author).toBe('dependabot[bot]');
    });

    it('rejects a mismatched head SHA before loading files', async () => {
      process.env.REVIEWROUTER_HEAD_SHA = 'event-head-sha';
      const mockOctokit = createMockOctokit();
      const loader = new PullRequestLoader(createMockClient(mockOctokit));

      await expect(loader.load(1)).rejects.toThrow(
        'PR #1 head SHA mismatch: expected event-head-sha from REVIEWROUTER_HEAD_SHA'
      );
      expect(mockOctokit.rest.pulls.listFiles).not.toHaveBeenCalled();
      expect(mockOctokit.request).not.toHaveBeenCalled();
    });

    it('loads the current GitHub base when the queued event base advanced', async () => {
      process.env.REVIEWROUTER_BASE_SHA = 'event-base-sha';
      const mockOctokit = createMockOctokit();
      const loader = new PullRequestLoader(createMockClient(mockOctokit));

      const context = await loader.load(1);

      expect(context.baseSha).toBe('base-sha');
      expect(context.headSha).toBe('head-sha');
      expect(mockOctokit.rest.pulls.listFiles).toHaveBeenCalled();
      expect(mockOctokit.request).toHaveBeenCalled();
      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(2);
    });

    it('accepts nonempty expected SHAs when both match', async () => {
      process.env.REVIEWROUTER_HEAD_SHA = ' head-sha ';
      process.env.REVIEWROUTER_BASE_SHA = 'base-sha';
      const mockOctokit = createMockOctokit();
      const mockClient = createMockClient(mockOctokit);

      const context = await new PullRequestLoader(mockClient).load(1);

      expect(context.headSha).toBe('head-sha');
      expect(context.baseSha).toBe('base-sha');
      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(2);
    });

    it('rejects content loaded across a force-pushed head revision', async () => {
      const mockOctokit = createMockOctokit();
      mockOctokit.rest.pulls.get
        .mockResolvedValueOnce({
          data: {
            number: 1,
            title: 'Test PR',
            body: 'Test description',
            draft: false,
            labels: [],
            additions: 5,
            deletions: 2,
            changed_files: 1,
            base: { sha: 'base-sha' },
            head: { sha: 'head-before-load' },
            user: { login: 'test-user', type: 'User' },
          },
        })
        .mockResolvedValueOnce({
          data: {
            base: { sha: 'base-sha' },
            head: { sha: 'head-after-force-push' },
          },
        });
      const loader = new PullRequestLoader(createMockClient(mockOctokit));

      await expect(loader.load(1)).rejects.toThrow(
        'PR #1 revision changed while loading content: head changed from head-before-load to head-after-force-push; refusing to return a potentially mixed revision.'
      );
      expect(mockOctokit.rest.pulls.listFiles).toHaveBeenCalled();
      expect(mockOctokit.request).toHaveBeenCalled();
      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(2);
    });

    it('rejects content when the base changes during loading', async () => {
      const mockOctokit = createMockOctokit();
      mockOctokit.rest.pulls.get
        .mockResolvedValueOnce({
          data: {
            number: 1,
            title: 'Test PR',
            body: 'Test description',
            draft: false,
            labels: [],
            additions: 5,
            deletions: 2,
            changed_files: 1,
            base: { sha: 'base-before-load' },
            head: { sha: 'stable-head' },
            user: { login: 'test-user', type: 'User' },
          },
        })
        .mockResolvedValueOnce({
          data: {
            base: { sha: 'base-after-load' },
            head: { sha: 'stable-head' },
          },
        });
      const loader = new PullRequestLoader(createMockClient(mockOctokit));

      await expect(loader.load(1)).rejects.toThrow(
        'PR #1 revision changed while loading content: base changed from base-before-load to base-after-load; refusing to return a potentially mixed revision.'
      );
      expect(mockOctokit.rest.pulls.listFiles).toHaveBeenCalled();
      expect(mockOctokit.request).toHaveBeenCalled();
      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(2);
    });

    it('returns the initial revision when the post-load verification is stable', async () => {
      const mockOctokit = createMockOctokit();
      const loader = new PullRequestLoader(createMockClient(mockOctokit));

      const context = await loader.load(1);

      expect(context).toMatchObject({
        baseSha: 'base-sha',
        headSha: 'head-sha',
      });
      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('Error Handling', () => {
    it('throws error when PR not found', async () => {
      const errorOctokit = createErrorOctokit(404, 'Not Found');
      const mockClient = createMockClient(errorOctokit);

      const loader = new PullRequestLoader(mockClient);

      await expect(loader.load(999)).rejects.toThrow('Not Found');
    });

    it('throws error on API failure', async () => {
      const errorOctokit = createErrorOctokit(500, 'Internal Server Error');
      const mockClient = createMockClient(errorOctokit);

      const loader = new PullRequestLoader(mockClient);

      await expect(loader.load(1)).rejects.toThrow('Internal Server Error');
    });
  });

  describe('Diff Generation', () => {
    it('includes diff in PR context', async () => {
      const mockClient = createMockClient(createMockOctokit());
      const loader = new PullRequestLoader(mockClient);

      const context = await loader.load(1);

      expect(context.diff).toBeDefined();
      expect(typeof context.diff).toBe('string');
    });

    it('handles files without patches', async () => {
      const mockOctokit = createMockOctokit({
        files: [
          {
            filename: 'binary-file.png',
            status: 'added',
            additions: 0,
            deletions: 0,
            changes: 0,
            // No patch for binary files
          },
        ],
      });
      const mockClient = createMockClient(mockOctokit);

      const loader = new PullRequestLoader(mockClient);
      const context = await loader.load(1);

      expect(context.files).toHaveLength(1);
      expect(context.files[0].patch).toBeUndefined();
    });

    it('paginates large PRs and synthesizes their diff without requesting raw diff', async () => {
      const files = Array.from({ length: 350 }, (_, index) => ({
        filename: `src/file-${index}.ts`,
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: `@@ -0,0 +1 @@\n+export const value${index} = ${index};`,
      }));
      const mockOctokit = createMockOctokit();
      mockOctokit.rest.pulls.listFiles = jest.fn(({ page, per_page }) =>
        Promise.resolve({
          data: files.slice((page - 1) * per_page, page * per_page),
        })
      );
      const mockClient = createMockClient(mockOctokit);

      const context = await new PullRequestLoader(mockClient).load(1);

      expect(context.files).toHaveLength(350);
      expect(mockOctokit.rest.pulls.listFiles).toHaveBeenCalledTimes(4);
      expect(mockOctokit.request).not.toHaveBeenCalled();
      expect(context.diff).toContain(
        'diff --git a/src/file-0.ts b/src/file-0.ts'
      );
      expect(context.diff).toContain(
        'diff --git a/src/file-349.ts b/src/file-349.ts'
      );
    });

    it('loads only the deterministic file shard and synthesizes only its patches', async () => {
      const files = Array.from({ length: 48 }, (_, index) => ({
        filename: `src/file-${index}.ts`,
        status: 'modified' as const,
        additions: index + 1,
        deletions: 1,
        changes: index + 2,
        patch: `@@ -0,0 +1 @@\n+export const value${index} = ${index};`,
      }));
      const shard = { index: 2, count: 8 };
      const selected = files.filter((file) =>
        isPathInReviewShard(file.filename, shard)
      );
      const excluded = files.filter(
        (file) => !isPathInReviewShard(file.filename, shard)
      );
      const mockOctokit = createMockOctokit({ files });

      const context = await new PullRequestLoader(
        createMockClient(mockOctokit),
        async () => null,
        shard
      ).load(1);

      expect(context.files.map((file) => file.filename)).toEqual(
        selected.map((file) => file.filename)
      );
      expect(context.pathShard).toEqual({ ...shard, totalFiles: files.length });
      expect(context.additions).toBe(
        selected.reduce((total, file) => total + file.additions, 0)
      );
      expect(context.deletions).toBe(selected.length);
      for (const file of selected)
        expect(context.diff).toContain(file.filename);
      for (const file of excluded) {
        expect(context.diff).not.toContain(
          `a/${file.filename} b/${file.filename}`
        );
      }
      expect(mockOctokit.request).not.toHaveBeenCalled();
    });

    it('does not request the full raw diff for an empty shard', async () => {
      const files = [
        {
          filename: 'src/only.ts',
          status: 'modified' as const,
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: '@@ -0,0 +1 @@\n+export const only = true;',
        },
      ];
      const owningIndex = Array.from({ length: 2 }, (_, index) => index).find(
        (index) => isPathInReviewShard(files[0].filename, { index, count: 2 })
      );
      const emptyShard = { index: owningIndex === 0 ? 1 : 0, count: 2 };
      const mockOctokit = createMockOctokit({ files });

      const context = await new PullRequestLoader(
        createMockClient(mockOctokit),
        async () => null,
        emptyShard
      ).load(1);

      expect(context.files).toEqual([]);
      expect(context.diff).toBe('');
      expect(mockOctokit.request).not.toHaveBeenCalled();
    });

    it('falls back to file patches when GitHub rejects a raw diff as too large', async () => {
      const mockOctokit = createMockOctokit();
      mockOctokit.request = jest.fn().mockRejectedValue({
        status: 422,
        message: 'Validation Failed',
        response: {
          data: {
            message:
              'Sorry, the diff exceeded the maximum number of files (300).',
            errors: [{ code: 'too_large' }],
          },
        },
      });
      const mockClient = createMockClient(mockOctokit);

      const context = await new PullRequestLoader(mockClient).load(1);

      expect(context.diff).toContain('diff --git a/src/test.ts b/src/test.ts');
      expect(context.diff).toContain('@@ -8,3 +8,4 @@');
    });

    it('falls back to file patches when the raw diff endpoint returns a GitHub HttpError', async () => {
      const mockOctokit = createMockOctokit();
      mockOctokit.request = jest.fn().mockRejectedValue(
        Object.assign(new Error('Not Found'), {
          name: 'HttpError',
          status: 404,
          response: { data: { message: 'Not Found' } },
        })
      );
      const mockClient = createMockClient(mockOctokit);

      const context = await new PullRequestLoader(mockClient).load(1);

      expect(context.loadCompleteness).toEqual({
        status: PullRequestLoadStatus.Complete,
        omissions: [],
      });
      expect(context.diff).toContain('diff --git a/src/test.ts b/src/test.ts');
      expect(context.diff).toContain('@@ -8,3 +8,4 @@');
    });

    it('does not hide non-HTTP raw diff failures', async () => {
      const mockOctokit = createMockOctokit();
      mockOctokit.request = jest
        .fn()
        .mockRejectedValue(new Error('Unexpected client failure'));
      const mockClient = createMockClient(mockOctokit);

      await expect(new PullRequestLoader(mockClient).load(1)).rejects.toThrow(
        'Unexpected client failure'
      );
    });

    it('represents binary files in a synthesized diff', async () => {
      const files = Array.from({ length: 301 }, (_, index) => ({
        filename: `assets/image-${index}.png`,
        status: 'added',
        additions: 0,
        deletions: 0,
        changes: 0,
      }));
      const mockOctokit = createMockOctokit();
      mockOctokit.rest.pulls.listFiles = jest.fn(({ page, per_page }) =>
        Promise.resolve({
          data: files.slice((page - 1) * per_page, page * per_page),
        })
      );
      const mockClient = createMockClient(mockOctokit);

      const context = await new PullRequestLoader(mockClient).load(1);

      expect(context.diff).toContain('--- /dev/null');
      expect(context.diff).toContain(
        'Binary file or patch unavailable from GitHub API'
      );
    });

    it('reports files omitted by the synthesized diff byte cap', async () => {
      const files = [
        {
          filename: 'src/included.ts',
          status: 'modified' as const,
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: '@@ -0,0 +1 @@\n+export const included = true;',
        },
        {
          filename: 'src/oversized.ts',
          status: 'modified' as const,
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: `@@ -0,0 +1 @@\n+${'x'.repeat(8 * 1024 * 1024)}`,
        },
        {
          filename: 'src/after-oversized.ts',
          status: 'modified' as const,
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: '@@ -0,0 +1 @@\n+export const after = true;',
        },
      ];
      const mockOctokit = createMockOctokit({ files });
      mockOctokit.request = jest.fn().mockRejectedValue({
        status: 422,
        response: {
          data: {
            message: 'The diff is too large.',
            errors: [{ code: 'too_large' }],
          },
        },
      });

      const context = await new PullRequestLoader(
        createMockClient(mockOctokit)
      ).load(1);

      expect(context.diff).toContain('src/included.ts');
      expect(context.diff).not.toContain('src/oversized.ts');
      expect(context.loadCompleteness).toEqual({
        status: PullRequestLoadStatus.Truncated,
        omissions: [
          {
            reason: PullRequestLoadOmissionReason.SynthesizedDiffSizeLimit,
            omittedFileCount: 2,
            omittedFiles: ['src/oversized.ts', 'src/after-oversized.ts'],
          },
        ],
      });
    });

    it('reports GitHub file-cap omissions using the API changed-file count', async () => {
      const files = Array.from({ length: 3000 }, (_, index) => ({
        filename: `src/file-${index}.ts`,
        status: 'modified' as const,
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: `@@ -0,0 +1 @@\n+export const value${index} = ${index};`,
      }));
      const mockOctokit = createMockOctokit();
      setReportedChangedFiles(mockOctokit, 3007);
      mockOctokit.rest.pulls.listFiles = jest.fn(({ page, per_page }) =>
        Promise.resolve({
          data: files.slice((page - 1) * per_page, page * per_page),
        })
      );

      const context = await new PullRequestLoader(
        createMockClient(mockOctokit),
        async () => null
      ).load(1);

      expect(context.files).toHaveLength(3000);
      expect(mockOctokit.rest.pulls.listFiles).toHaveBeenCalledTimes(30);
      expect(context.loadCompleteness).toEqual({
        status: PullRequestLoadStatus.Truncated,
        omissions: [
          {
            reason: PullRequestLoadOmissionReason.GitHubFileLimit,
            omittedFileCount: 7,
          },
        ],
      });
    });

    it('recovers files beyond the GitHub API cap from local git', async () => {
      const apiFiles = Array.from({ length: 3000 }, (_, index) => ({
        filename: `src/file-${index}.ts`,
        status: 'modified' as const,
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: '@@ -0,0 +1 @@\n+export const value = true;',
      }));
      const localFiles = Array.from({ length: 3001 }, (_, index) => ({
        filename: `src/file-${index}.ts`,
        status: 'modified' as const,
        additions: 1,
        deletions: 0,
        changes: 1,
      }));
      const mockOctokit = createMockOctokit();
      setReportedChangedFiles(mockOctokit, 3001);
      mockOctokit.rest.pulls.listFiles = jest.fn(({ page, per_page }) =>
        Promise.resolve({
          data: apiFiles.slice((page - 1) * per_page, page * per_page),
        })
      );
      const localDiffLoader = jest.fn().mockResolvedValue(localFiles);

      const context = await new PullRequestLoader(
        createMockClient(mockOctokit),
        localDiffLoader
      ).load(1);

      expect(localDiffLoader).toHaveBeenCalledWith('base-sha', 'head-sha');
      expect(context.files).toHaveLength(3001);
      expect(context.files.at(-1)?.filename).toBe('src/file-3000.ts');
      expect(context.files[0].patch).toBe(apiFiles[0].patch);
      expect(context.files.at(-1)?.patch).toBeUndefined();
      expect(context.diff).toContain('+export const value = true;');
      expect(context.loadCompleteness).toEqual({
        status: PullRequestLoadStatus.Complete,
        omissions: [],
      });
    });

    it('reports an exact 3000-file PR as complete when GitHub confirms the count', async () => {
      const files = Array.from({ length: 3000 }, (_, index) => ({
        filename: `src/file-${index}.ts`,
        status: 'modified' as const,
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: '@@ -0,0 +1 @@\n+export const value = true;',
      }));
      const mockOctokit = createMockOctokit();
      setReportedChangedFiles(mockOctokit, 3000);
      mockOctokit.rest.pulls.listFiles = jest.fn(({ page, per_page }) =>
        Promise.resolve({
          data: files.slice((page - 1) * per_page, page * per_page),
        })
      );

      const context = await new PullRequestLoader(
        createMockClient(mockOctokit),
        async () => null
      ).load(1);

      expect(context.loadCompleteness).toEqual({
        status: PullRequestLoadStatus.Complete,
        omissions: [],
      });
    });

    it('reports an unknown omission count when the cap is reached without GitHub total metadata', async () => {
      const files = Array.from({ length: 3000 }, (_, index) => ({
        filename: `src/file-${index}.ts`,
        status: 'modified' as const,
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: '@@ -0,0 +1 @@\n+export const value = true;',
      }));
      const mockOctokit = createMockOctokit();
      mockOctokit.rest.pulls.listFiles = jest.fn(({ page, per_page }) =>
        Promise.resolve({
          data: files.slice((page - 1) * per_page, page * per_page),
        })
      );

      const context = await new PullRequestLoader(
        createMockClient(mockOctokit)
      ).load(1);

      expect(context.loadCompleteness).toEqual({
        status: PullRequestLoadStatus.Truncated,
        omissions: [
          {
            reason: PullRequestLoadOmissionReason.GitHubFileLimit,
          },
        ],
      });
    });
  });
});
