import { GitHubReviewRevisionGuard } from '../../../src/review-orchestration/infrastructure/github-review-state-adapter';

describe('GitHubReviewRevisionGuard', () => {
  const scope = {
    workspaceId: 'workspace-1',
    repositoryConnectionId: 'connection-1',
    scmRepositoryIdentityId: 'repository-1',
    pullRequestNumber: 420,
  };

  it('normalizes GitHub read failures without exposing provider text', async () => {
    const client = {
      owner: 'owner',
      repo: 'repo',
      octokit: {
        rest: {
          pulls: {
            get: jest
              .fn()
              .mockRejectedValue(
                new Error('secondary rate limit with unsafe provider detail')
              ),
          },
          repos: {
            compareCommitsWithBasehead: jest.fn(),
          },
        },
      },
    };
    const guard = new GitHubReviewRevisionGuard(client as never, scope);

    await expect(guard.loadCurrentRevision()).rejects.toThrow(
      'review_action_v2_revision_guard_unavailable'
    );
  });
});
