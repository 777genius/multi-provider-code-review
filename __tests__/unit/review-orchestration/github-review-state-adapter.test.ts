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

  it('normalizes transient GitHub read failures without exposing provider text', async () => {
    const error = Object.assign(
      new Error('secondary rate limit with unsafe provider detail'),
      { status: 403 }
    );
    const client = clientWith({
      pullsGet: jest.fn().mockRejectedValue(error),
    });
    const guard = new GitHubReviewRevisionGuard(client as never, scope);

    await expect(guard.loadCurrentRevision()).rejects.toThrow(
      'review_action_v2_revision_guard_unavailable'
    );
  });

  it('does not hide invalid revision facts as transient GitHub failures', async () => {
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
      'review_action_v2_base_sha_invalid'
    );
  });

  it('preserves non-retryable GitHub failures', async () => {
    const error = Object.assign(new Error('not found'), { status: 404 });
    const client = clientWith({
      pullsGet: jest.fn().mockRejectedValue(error),
    });
    const guard = new GitHubReviewRevisionGuard(client as never, scope);

    await expect(guard.loadCurrentRevision()).rejects.toBe(error);
  });
});
