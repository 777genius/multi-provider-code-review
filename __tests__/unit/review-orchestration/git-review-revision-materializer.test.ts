import { GitReviewRevisionMaterializer } from '../../../src/review-orchestration/infrastructure/git-review-revision-materializer';

describe('GitReviewRevisionMaterializer', () => {
  const head = 'a'.repeat(40);
  const base = 'b'.repeat(40);
  const mergeBase = 'c'.repeat(40);

  it('fetches only missing revisions without exposing the token in argv', async () => {
    const available = new Set([head]);
    const calls: Array<{
      args: readonly string[];
      env: NodeJS.ProcessEnv;
    }> = [];
    const materializer = new GitReviewRevisionMaterializer(
      async (args, options) => {
        calls.push({ args, env: options.env });
        if (args[0] === 'cat-file') {
          const sha = args[2]?.slice(0, 40) ?? '';
          if (!available.has(sha)) throw new Error('missing');
          return;
        }
        for (const sha of args.slice(5)) available.add(sha);
      }
    );

    await materializer.ensureAvailable({
      checkoutRoot: '/tmp/review',
      repository: '777genius/agent-teams-ai',
      scmReadToken: 'secret-read-token',
      commitShas: [head, base, mergeBase, base],
    });

    const fetch = calls.find((call) => call.args[0] === 'fetch');
    expect(fetch?.args).toEqual([
      'fetch',
      '--no-tags',
      '--no-recurse-submodules',
      '--depth=1',
      'https://github.com/777genius/agent-teams-ai.git',
      base,
      mergeBase,
    ]);
    expect(JSON.stringify(fetch?.args)).not.toContain('secret-read-token');
    expect(fetch?.env.GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: basic ${Buffer.from(
        'x-access-token:secret-read-token'
      ).toString('base64')}`
    );
    expect(fetch?.env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('does not fetch when every revision is already available', async () => {
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const materializer = new GitReviewRevisionMaterializer(async (args) => {
      mutableCalls.push([...args]);
    });

    await materializer.ensureAvailable({
      checkoutRoot: '/tmp/review',
      repository: '777genius/agent-teams-ai',
      scmReadToken: 'secret-read-token',
      commitShas: [head, head],
    });

    expect(calls).toEqual([['cat-file', '-e', `${head}^{commit}`]]);
  });

  it('fails closed when fetched revisions remain unavailable', async () => {
    const materializer = new GitReviewRevisionMaterializer(async (args) => {
      if (args[0] === 'cat-file') throw new Error('missing');
    });

    await expect(
      materializer.ensureAvailable({
        checkoutRoot: '/tmp/review',
        repository: '777genius/agent-teams-ai',
        scmReadToken: 'secret-read-token',
        commitShas: [base],
      })
    ).rejects.toThrow('review_revision_materialization_incomplete');
  });
});
