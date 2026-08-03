import { GitHubReviewRevisionGuard } from '../../../src/review-orchestration/infrastructure/github-review-state-adapter';

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
