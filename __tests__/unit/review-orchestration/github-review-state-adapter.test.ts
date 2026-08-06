import type { GitHubClient } from '../../../src/github/client';
import type { ReviewLedger } from '../../../src/github/ledger';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  FreshGitHubLifecycleInventory,
  GitHubReviewRevisionGuard,
} from '../../../src/review-orchestration/infrastructure/github-review-state-adapter';

describe('GitHubReviewRevisionGuard', () => {
  const scope = {
    workspaceId: 'workspace-1',
    repositoryConnectionId: 'connection-1',
    scmRepositoryIdentityId: 'repository-1',
    pullRequestNumber: 420,
  };

  function clientWith(options: { pullsGet: jest.Mock; compare?: jest.Mock }) {
    return {
      owner: 'owner',
      repo: 'repo',
      octokit: {
        rest: {
          pulls: { get: options.pullsGet },
          repos: {
            compareCommitsWithBasehead: options.compare ?? jest.fn(),
          },
        },
      },
    };
  }

  it('normalizes exhausted transient failures without exposing provider text', async () => {
    const error = new Error('request failed', {
      cause: Object.assign(new Error('unsafe socket detail'), {
        code: 'ECONNRESET',
      }),
    });
    const pullsGet = jest.fn().mockRejectedValue(error);
    const client = clientWith({ pullsGet });
    const guard = new GitHubReviewRevisionGuard(client as never, scope);

    await expect(guard.loadCurrentRevision()).rejects.toThrow(
      'review_action_v2_revision_guard_unavailable'
    );
    expect(pullsGet).toHaveBeenCalledTimes(1);
  });

  it('normalizes invalid revision facts as a permanent guard failure', async () => {
    const client = clientWith({
      pullsGet: jest.fn().mockResolvedValue({
        data: {
          base: { sha: 'invalid' },
          head: { sha: 'a'.repeat(40) },
        },
      }),
    });
    const guard = new GitHubReviewRevisionGuard(client as never, scope);

    await expect(guard.loadCurrentRevision()).rejects.toThrow(
      'review_action_v2_revision_guard_failed'
    );
  });

  it('normalizes non-retryable GitHub failures without reading deprecated code', async () => {
    const error = Object.assign(new Error('not found'), { status: 404 });
    const deprecatedCodeGetter = jest.fn(() => 404);
    Object.defineProperty(error, 'code', { get: deprecatedCodeGetter });
    const client = clientWith({
      pullsGet: jest.fn().mockRejectedValue(error),
    });
    const guard = new GitHubReviewRevisionGuard(client as never, scope);

    await expect(guard.loadCurrentRevision()).rejects.toThrow(
      'review_action_v2_revision_guard_failed'
    );
    expect(deprecatedCodeGetter).not.toHaveBeenCalled();
  });
});

describe('FreshGitHubLifecycleInventory', () => {
  it('maps the complete SCM thread state into the portable projection witness', async () => {
    const fixture = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          'src/review-projection/fixtures/review-lifecycle-thread-state.v1.golden.json'
        ),
        'utf8'
      )
    ) as {
      readonly expectedProjectionTarget: Readonly<Record<string, string>>;
    };
    const headSha = 'a'.repeat(40);
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: headSha,
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'PRRT_reviewrouter_golden_1',
                isResolved: false,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: 12,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'PRRC_1',
                      author: { login: 'Review-Router-AI[bot]' },
                      body: [
                        '<!-- review-router-finding:aaaaaaaaaaaaaaaaaaaaaaaa -->',
                        'Finding',
                      ].join('\n'),
                      createdAt: '2026-08-05T09:00:00.000Z',
                      updatedAt: '2026-08-05T09:05:00.000Z',
                      path: 'src/app.ts',
                      line: 12,
                    },
                    {
                      id: 'PRRC_2',
                      author: { login: 'Human.User' },
                      body: 'Looks fixed.\n',
                      createdAt: '2026-08-05T10:00:00.000Z',
                      updatedAt: '2026-08-05T10:00:00.000Z',
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const client = {
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient;
    const ledger = {
      load: jest.fn().mockResolvedValue({
        valid: true,
        payload: { version: 1, repo: 'owner/repo', pr: 420, entries: [] },
      }),
    } as unknown as ReviewLedger;
    const adapter = new FreshGitHubLifecycleInventory(client, ledger);

    const inventory = await adapter.loadCurrent({
      scope: {
        scmRepositoryIdentityId: 'repository-1',
        pullRequestNumber: 420,
        baseSha: 'b'.repeat(40),
        reviewedHeadSha: headSha,
        reviewRevisionHash: 'c'.repeat(64),
      },
    });

    expect(inventory.targets).toHaveLength(1);
    expect(inventory.targets[0]).toMatchObject({
      targetId: fixture.expectedProjectionTarget.targetId,
      threadId: fixture.expectedProjectionTarget.threadId,
      trustedMarker: fixture.expectedProjectionTarget.markerFingerprint,
      threadStateHash: fixture.expectedProjectionTarget.threadStateHash,
    });
    expect(inventory.targets[0]).not.toHaveProperty('parentOwnedByIntegration');
    expect(inventory.targets[0]).not.toHaveProperty('hasHumanReply');
  });
});
