import { GitHubClient } from '../../../src/github/client';
import nock from 'nock';

describe('GitHubClient', () => {
  const mockToken = 'TEST_TOKEN';
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      GITHUB_REPOSITORY: 'owner/repo',
    };
  });

  afterEach(() => {
    nock.cleanAll();
    process.env = originalEnv;
  });

  describe('Initialization', () => {
    it('creates client with token', () => {
      const client = new GitHubClient(mockToken);

      expect(client).toBeDefined();
      expect(client.owner).toBe('owner');
      expect(client.repo).toBe('repo');
    });

    it('parses owner and repo from environment', () => {
      process.env.GITHUB_REPOSITORY = 'test-owner/test-repo';

      const client = new GitHubClient(mockToken);

      expect(client.owner).toBe('test-owner');
      expect(client.repo).toBe('test-repo');
    });

    it('handles GITHUB_REPOSITORY without slash', () => {
      process.env.GITHUB_REPOSITORY = 'invalid-format';

      const client = new GitHubClient(mockToken);

      // When there's no '/', split returns the whole string as first element, repo is empty string
      expect(client.owner).toBe('invalid-format');
      expect(client.repo).toBe('');
    });

    it('handles GITHUB_REPOSITORY not set', () => {
      delete process.env.GITHUB_REPOSITORY;
      delete process.env.GITHUB_EVENT_PATH;

      const client = new GitHubClient(mockToken);

      // When GITHUB_REPOSITORY is undefined, should handle gracefully
      expect(client.owner).toBe('');
      expect(client.repo).toBe('');
    });
  });

  describe('Octokit Integration', () => {
    it('provides access to octokit instance', () => {
      const client = new GitHubClient(mockToken);

      expect(client.octokit).toBeDefined();
      expect(client.octokit.rest).toBeDefined();
    });

    it('configures octokit with correct auth', () => {
      const client = new GitHubClient(mockToken);

      // Octokit should be configured with the token
      expect(client.octokit).toBeDefined();
    });

    it('refreshes once and retries a request rejected with 401', async () => {
      const tokenProvider = {
        getToken: jest.fn().mockResolvedValue('ghs_initial'),
        refreshToken: jest.fn().mockResolvedValue('ghs_refreshed'),
      };
      const initialRequest = nock('https://api.github.com', {
        reqheaders: { authorization: 'Bearer ghs_initial' },
      })
        .get('/repos/owner/repo')
        .reply(401, { message: 'Bad credentials' });
      const retriedRequest = nock('https://api.github.com', {
        reqheaders: { authorization: 'Bearer ghs_refreshed' },
      })
        .get('/repos/owner/repo')
        .reply(200, { id: 1, name: 'repo' });
      const client = new GitHubClient(mockToken, { tokenProvider });

      await expect(
        client.octokit.rest.repos.get({ owner: 'owner', repo: 'repo' })
      ).resolves.toMatchObject({ status: 200 });
      expect(tokenProvider.getToken).toHaveBeenCalledTimes(1);
      expect(tokenProvider.refreshToken).toHaveBeenCalledTimes(1);
      expect(initialRequest.isDone()).toBe(true);
      expect(retriedRequest.isDone()).toBe(true);
    });

    it('retries transient GitHub failures without refreshing the token', async () => {
      const tokenProvider = {
        getToken: jest.fn().mockResolvedValue('ghs_initial'),
        refreshToken: jest.fn(),
      };
      const requests = nock('https://api.github.com', {
        reqheaders: { authorization: 'Bearer ghs_initial' },
      })
        .get('/repos/owner/repo')
        .reply(503, { message: 'Service unavailable' })
        .get('/repos/owner/repo')
        .reply(502, { message: 'Bad gateway' })
        .get('/repos/owner/repo')
        .reply(200, { id: 1, name: 'repo' });
      const sleep = jest.fn(async () => undefined);
      const client = new GitHubClient(mockToken, { tokenProvider, sleep });

      await expect(
        client.octokit.rest.repos.get({ owner: 'owner', repo: 'repo' })
      ).resolves.toMatchObject({ status: 200 });
      expect(tokenProvider.getToken).toHaveBeenCalledTimes(1);
      expect(tokenProvider.refreshToken).not.toHaveBeenCalled();
      expect(sleep).toHaveBeenNthCalledWith(1, 250);
      expect(sleep).toHaveBeenNthCalledWith(2, 1_000);
      expect(requests.isDone()).toBe(true);
    });

    it('retries transient GitHub failures for a static token', async () => {
      const requests = nock('https://api.github.com', {
        reqheaders: { authorization: 'token TEST_TOKEN' },
      })
        .get('/repos/owner/repo')
        .reply(503, { message: 'Service unavailable' })
        .get('/repos/owner/repo')
        .reply(200, { id: 1, name: 'repo' });
      const sleep = jest.fn(async () => undefined);
      const client = new GitHubClient(mockToken, { sleep });

      await expect(
        client.octokit.rest.repos.get({ owner: 'owner', repo: 'repo' })
      ).resolves.toMatchObject({ status: 200 });
      expect(sleep).toHaveBeenCalledWith(250);
      expect(requests.isDone()).toBe(true);
    });

    it('ignores rate-limit window headers on ordinary server failures', async () => {
      const resetAt = Math.floor(Date.now() / 1_000) + 3_600;
      const requests = nock('https://api.github.com', {
        reqheaders: { authorization: 'token TEST_TOKEN' },
      })
        .get('/repos/owner/repo')
        .reply(
          503,
          { message: 'Service unavailable' },
          {
            'X-RateLimit-Remaining': '4000',
            'X-RateLimit-Reset': String(resetAt),
          }
        )
        .get('/repos/owner/repo')
        .reply(200, { id: 1, name: 'repo' });
      const sleep = jest.fn(async () => undefined);
      const client = new GitHubClient(mockToken, { sleep });

      await expect(
        client.octokit.rest.repos.get({ owner: 'owner', repo: 'repo' })
      ).resolves.toMatchObject({ status: 200 });
      expect(sleep).toHaveBeenCalledWith(250);
      expect(requests.isDone()).toBe(true);
    });

    it('honors a bounded Retry-After before retrying a rate limit', async () => {
      const requests = nock('https://api.github.com', {
        reqheaders: { authorization: 'token TEST_TOKEN' },
      })
        .get('/repos/owner/repo')
        .reply(429, { message: 'rate limit exceeded' }, { 'Retry-After': '2' })
        .get('/repos/owner/repo')
        .reply(200, { id: 1, name: 'repo' });
      const sleep = jest.fn(async () => undefined);
      const client = new GitHubClient(mockToken, { sleep });

      await expect(
        client.octokit.rest.repos.get({ owner: 'owner', repo: 'repo' })
      ).resolves.toMatchObject({ status: 200 });
      expect(sleep).toHaveBeenCalledWith(2_000);
      expect(requests.isDone()).toBe(true);
    });

    it('does not wait or retry beyond the bounded server delay', async () => {
      const request = nock('https://api.github.com', {
        reqheaders: { authorization: 'token TEST_TOKEN' },
      })
        .get('/repos/owner/repo')
        .reply(
          429,
          { message: 'rate limit exceeded' },
          { 'Retry-After': '60' }
        );
      const sleep = jest.fn(async () => undefined);
      const client = new GitHubClient(mockToken, { sleep });

      await expect(
        client.octokit.rest.repos.get({ owner: 'owner', repo: 'repo' })
      ).rejects.toMatchObject({ status: 429 });
      expect(sleep).not.toHaveBeenCalled();
      expect(request.isDone()).toBe(true);
    });

    it('does not retry non-idempotent GitHub writes', async () => {
      const request = nock('https://api.github.com', {
        reqheaders: { authorization: 'token TEST_TOKEN' },
      })
        .post('/repos/owner/repo/issues/1/comments', { body: 'hello' })
        .reply(503, { message: 'Service unavailable' });
      const sleep = jest.fn(async () => undefined);
      const client = new GitHubClient(mockToken, { sleep });

      await expect(
        client.octokit.rest.issues.createComment({
          owner: 'owner',
          repo: 'repo',
          issue_number: 1,
          body: 'hello',
        })
      ).rejects.toMatchObject({ status: 503 });
      expect(sleep).not.toHaveBeenCalled();
      expect(request.isDone()).toBe(true);
    });
  });
});
