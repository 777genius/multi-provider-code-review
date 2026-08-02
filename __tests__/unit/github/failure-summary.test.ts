import {
  clearReviewFailureSummariesForClient,
  formatReviewFailureSummary,
} from '../../../src/github/failure-summary';

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

describe('formatReviewFailureSummary', () => {
  const originalRepository = process.env.GITHUB_REPOSITORY;

  afterEach(() => {
    if (originalRepository === undefined) {
      delete process.env.GITHUB_REPOSITORY;
    } else {
      process.env.GITHUB_REPOSITORY = originalRepository;
    }
  });

  it('formats Codex OAuth failures with actionable checks', () => {
    process.env.GITHUB_REPOSITORY = '777genius/agent-teams-ai';
    const body = formatReviewFailureSummary(
      new Error('CODEX_AUTH_JSON auth.json refresh_token is missing'),
      123
    );

    expect(body).toContain('# ReviewRouter');
    expect(body).toContain('Codex OAuth secret is missing or invalid');
    expect(body).toContain('`CODEX_AUTH_JSON`');
    expect(body).toContain('Reseed with the ReviewRouter Codex auth command');
    expect(body).toContain('PR: #123');
    expect(body).toContain('## What failed');
    expect(body).toContain('## Why it matters');
    expect(body).toContain('## How to fix');
    expect(body).toContain(
      'Run this from a trusted machine after `codex login`'
    );
    expect(body).toContain(
      'curl -fsSL https://reviewrouter.site/install/codex | REVIEW_ROUTER_CONFIRM_WRITE=1 REVIEW_ROUTER_SECRET_SCOPE=repo REVIEW_ROUTER_REPO=777genius/agent-teams-ai bash'
    );
    expect(body).toContain('<summary>Technical details</summary>');
    expect(body).toContain('Code: codex_oauth_invalid_secret');
  });

  it('classifies Codex 401 refresh failures as OAuth reseed failures', () => {
    process.env.GITHUB_REPOSITORY = '777genius/agent-teams-ai';
    const body = formatReviewFailureSummary(
      new Error(
        'All LLM providers failed during review. codex/gpt-5.5: 401 Unauthorized access token could not be refreshed'
      ),
      123
    );

    expect(body).toContain('Codex OAuth is stale or expired');
    expect(body).toContain('Run `codex login`');
    expect(body).toContain('REVIEW_ROUTER_REPO=777genius/agent-teams-ai');
    expect(body).toContain('self-hosted runner with persistent `CODEX_HOME`');
    expect(body).toContain('Code: codex_oauth_stale');
  });

  it('formats provider usage exhaustion without an OAuth reseed prompt', () => {
    const body = formatReviewFailureSummary(
      new Error(
        "All LLM providers failed during review; failing because FAIL_ON_NO_HEALTHY_PROVIDERS=true. codex/gpt-5.6-sol: Codex CLI failed with exit code 1: You've hit your usage limit. Visit [redacted-url] to purchase more credits or try again at Aug 8th, 2026 1:18 PM."
      ),
      123
    );

    expect(body).toContain(
      'A review provider reached its quota or capacity limit'
    );
    expect(body).toContain('Wait for the provider limit to reset');
    expect(body).toContain('Switch to another configured provider');
    expect(body).toContain('Code: provider_capacity_limited');
    expect(body.toLowerCase()).not.toContain('reseed');
    expect(body).not.toContain('reviewrouter.site/install/codex');
  });

  it('redacts obvious secrets from failure comments', () => {
    const body = formatReviewFailureSummary(
      new Error(
        'failed with OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz and refresh_token: secret-refresh and access_token: access-secret'
      ),
      123
    );

    expect(body).toContain('OPENAI_API_KEY=***');
    expect(body).toContain('refresh_token: ***');
    expect(body).toContain('access_token: ***');
    expect(body).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(body).not.toContain('secret-refresh');
    expect(body).not.toContain('access-secret');
  });

  it('formats no-provider failures', () => {
    const body = formatReviewFailureSummary(
      new Error(
        'No healthy providers available; failing because FAIL_ON_NO_HEALTHY_PROVIDERS=true'
      )
    );

    expect(body).toContain(
      'No configured review provider passed health checks'
    );
    expect(body).toContain('Check provider credentials and model names');
    expect(body).not.toContain('reviewrouter.site/install/codex');
    expect(body).toContain('Code: no_healthy_providers');
  });

  it('formats GitHub permission failures with permission next steps', () => {
    const body = formatReviewFailureSummary(
      new Error('Resource not accessible by integration')
    );

    expect(body).toContain('GitHub denied the token permission');
    expect(body).toContain('`pull-requests: write`');
    expect(body).toContain('Code: github_permission_denied');
  });

  it('deletes stale ReviewRouter failure summaries and failed progress comments', async () => {
    const listComments = jest.fn();
    const deleteComment = jest.fn().mockResolvedValue({});
    const mockClient = {
      owner: 'owner',
      repo: 'repo',
      octokit: {
        rest: {
          issues: {
            listComments,
            deleteComment,
          },
        },
        paginate: jest.fn().mockResolvedValue([
          {
            id: 1,
            body: '<!-- review-router-bot -->\n\n🔴 **Review failed before comments could be completed.**',
          },
          {
            id: 2,
            body: '<!-- review-router-bot -->\n\n# ReviewRouter\n\n0 findings',
          },
          {
            id: 3,
            body: 'Human comment mentioning Review failed before comments could be completed.',
          },
          {
            id: 4,
            body: '## 🤖 ReviewRouter Progress\n\n| Step | Status |\n| --- | --- |\n| LLM review | ❌ Failed |\n\n### Review needs attention',
          },
          {
            id: 5,
            body: '## 🤖 ReviewRouter Progress\n\n| Step | Status |\n| --- | --- |\n| LLM review | ✅ Completed |',
          },
        ]),
      },
    } as any;

    await clearReviewFailureSummariesForClient(mockClient, 123);

    expect(mockClient.octokit.paginate).toHaveBeenCalledWith(listComments, {
      owner: 'owner',
      repo: 'repo',
      issue_number: 123,
      per_page: 100,
    });
    expect(deleteComment).toHaveBeenCalledTimes(2);
    expect(deleteComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      comment_id: 1,
    });
    expect(deleteComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      comment_id: 4,
    });
  });
});
