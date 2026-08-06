import {
  ReviewThreadInventoryLoader,
  isTrustedReviewThreadAuthor,
  trustedReviewThreadAuthorsFromEnv,
} from '../../../src/github/review-thread-inventory';
import { extractFindingFingerprint } from '../../../src/github/comment-fingerprint';
import { GitHubClient } from '../../../src/github/client';
import { createHash } from 'crypto';

const parentBody = [
  '**🟡 Major - Previous Bug**',
  '',
  'Old issue body.',
  '',
  '<!-- review-router-finding:aaaaaaaaaaaaaaaaaaaaaaaa -->',
].join('\n');

describe('ReviewThreadInventoryLoader', () => {
  it.each([
    ['legacy HTML', '<!-- review-router-finding:aaaaaaaaaaaaaaaaaaaaaaaa -->'],
    ['plain v2', 'reviewrouter:finding:v2:aaaaaaaaaaaaaaaaaaaaaaaa'],
  ])('extracts the %s finding marker dialect', (_label, marker) => {
    expect(extractFindingFingerprint(`Finding\n${marker}`)).toBe(
      'aaaaaaaaaaaaaaaaaaaaaaaa'
    );
  });

  it('accepts duplicate markers when every dialect names the same fingerprint', () => {
    expect(
      extractFindingFingerprint(
        [
          '<!-- review-router-finding:aaaaaaaaaaaaaaaaaaaaaaaa -->',
          '<!-- review-router-finding:aaaaaaaaaaaaaaaaaaaaaaaa -->',
          '<!-- reviewrouter:finding:v2:aaaaaaaaaaaaaaaaaaaaaaaa -->',
          'reviewrouter:finding:v2:aaaaaaaaaaaaaaaaaaaaaaaa',
        ].join('\n')
      )
    ).toBe('aaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it.each([
    [
      'conflicting legacy markers',
      [
        '<!-- review-router-finding:aaaaaaaaaaaaaaaaaaaaaaaa -->',
        '<!-- review-router-finding:bbbbbbbbbbbbbbbbbbbbbbbb -->',
      ],
    ],
    [
      'conflicting v2 markers',
      [
        'reviewrouter:finding:v2:aaaaaaaaaaaaaaaaaaaaaaaa',
        'reviewrouter:finding:v2:bbbbbbbbbbbbbbbbbbbbbbbb',
      ],
    ],
    [
      'mixed conflicting markers',
      [
        '<!-- review-router-finding:aaaaaaaaaaaaaaaaaaaaaaaa -->',
        'reviewrouter:finding:v2:bbbbbbbbbbbbbbbbbbbbbbbb',
      ],
    ],
  ])('rejects %s', (_label, markers) => {
    expect(extractFindingFingerprint(markers.join('\n'))).toBeNull();
  });

  it.each(['g', 'Z', '_suffix', '-suffix'])(
    'rejects a v2 marker followed by identifier junk %s',
    (suffix) => {
      expect(
        extractFindingFingerprint(
          `<!-- reviewrouter:finding:v2:aaaaaaaaaaaaaaaaaaaaaaaa${suffix} -->`
        )
      ).toBeNull();
    }
  );

  it('builds a strict trusted author allowlist from configured GitHub App identity', () => {
    const authors = trustedReviewThreadAuthorsFromEnv({
      REVIEW_APP_SLUG: 'review-router-owner',
      REVIEW_THREAD_LIFECYCLE_TRUSTED_AUTHORS:
        'extra-review-bot[bot], invalid login!',
    } as NodeJS.ProcessEnv);

    expect(authors).toEqual(
      expect.arrayContaining([
        'github-actions[bot]',
        'review-router-ai[bot]',
        'review-router-owner[bot]',
        'extra-review-bot[bot]',
      ])
    );
    expect(authors).not.toContain('invalid login!');
    expect(
      isTrustedReviewThreadAuthor('Review-Router-Owner[bot]', authors)
    ).toBe(true);
    expect(isTrustedReviewThreadAuthor('Review-Router-Owner', authors)).toBe(
      true
    );
    expect(isTrustedReviewThreadAuthor('review-router-ai')).toBe(true);
  });

  it('trusts github-actions only when it is the expected or fallback comment identity', () => {
    const appAuthors = trustedReviewThreadAuthorsFromEnv({
      REVIEWROUTER_COMMENT_TOKEN_MODE: 'app-oidc',
      REVIEW_ROUTER_COMMENT_TOKEN_STATUS: 'app',
      REVIEW_APP_SLUG: 'review-router-owner',
    } as NodeJS.ProcessEnv);
    expect(appAuthors).toEqual(
      expect.arrayContaining([
        'review-router-ai[bot]',
        'review-router-owner[bot]',
      ])
    );
    expect(appAuthors).not.toContain('github-actions[bot]');

    const fallbackAuthors = trustedReviewThreadAuthorsFromEnv({
      REVIEWROUTER_COMMENT_TOKEN_MODE: 'app-oidc',
      REVIEW_ROUTER_COMMENT_TOKEN_STATUS: 'fallback',
      REVIEW_APP_SLUG: 'review-router-owner',
    } as NodeJS.ProcessEnv);
    expect(fallbackAuthors).toContain('github-actions[bot]');
  });

  it('loads only unresolved trusted ReviewRouter threads as lifecycle candidates', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head-sha',
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'resolved-thread',
                isResolved: true,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: 10,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'resolved-comment',
                      author: { login: 'review-router-ai[bot]' },
                      body: parentBody,
                      createdAt: '2026-05-14T00:00:00Z',
                      updatedAt: '2026-05-14T00:00:00Z',
                      path: 'src/app.ts',
                      line: 10,
                      originalLine: 10,
                      diffHunk: '@@',
                      url: 'https://github.test/resolved',
                    },
                  ],
                },
              },
              {
                id: 'active-thread',
                isResolved: false,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: 12,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'active-comment',
                      author: { login: 'review-router-ai[bot]' },
                      body: parentBody,
                      createdAt: '2026-05-14T00:00:00Z',
                      updatedAt: '2026-05-14T00:00:00Z',
                      path: 'src/app.ts',
                      line: 12,
                      originalLine: 10,
                      diffHunk: '@@',
                      url: 'https://github.test/active',
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.failed).toBe(false);
    expect(inventory.headRefOid).toBe('head-sha');
    expect(inventory.candidates).toHaveLength(1);
    expect(inventory.candidates[0]).toMatchObject({
      threadId: 'active-thread',
      fingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      severity: 'major',
      trustedAuthor: true,
      hasHumanReply: false,
    });
    expect(inventory.dedupeComments).toHaveLength(1);
    expectGraphqlBracesBalanced(graphql.mock.calls[0]?.[0] as string);
  });

  it('recognizes only a trusted resolution marker bound to the exact target and fingerprint', async () => {
    const fingerprint = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const targetId = `rrt_${createHash('sha256')
      .update(`active-thread\nactive-comment\n${fingerprint}`)
      .digest('hex')
      .slice(0, 16)}`;
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head-sha',
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'active-thread',
                isResolved: false,
                viewerCanResolve: false,
                path: 'src/app.ts',
                line: 12,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'active-comment',
                      author: { login: 'review-router-ai[bot]' },
                      body: parentBody,
                      createdAt: '2026-05-14T00:00:00Z',
                      updatedAt: '2026-05-14T00:00:00Z',
                      path: 'src/app.ts',
                      line: 12,
                      originalLine: 10,
                    },
                    {
                      id: 'untrusted-copy',
                      author: { login: 'contributor' },
                      body: `<!-- reviewrouter-lifecycle-resolution:v1 target_id=${targetId} fingerprint=${fingerprint} -->`,
                      createdAt: '2026-05-14T00:01:00Z',
                      updatedAt: '2026-05-14T00:01:00Z',
                    },
                    {
                      id: 'trusted-mismatch',
                      author: { login: 'review-router-ai[bot]' },
                      body: `<!-- reviewrouter-lifecycle-resolution:v1 target_id=${targetId} fingerprint=bbbbbbbbbbbbbbbbbbbbbbbb -->`,
                      createdAt: '2026-05-14T00:02:00Z',
                      updatedAt: '2026-05-14T00:02:00Z',
                    },
                    {
                      id: 'generic-actions-copy',
                      author: { login: 'github-actions[bot]' },
                      body: `<!-- reviewrouter-lifecycle-resolution:v1 target_id=${targetId} fingerprint=${fingerprint} -->`,
                      createdAt: '2026-05-14T00:02:30Z',
                      updatedAt: '2026-05-14T00:02:30Z',
                    },
                    {
                      id: 'trusted-resolution',
                      author: { login: 'review-router-ai[bot]' },
                      body: `<!-- reviewrouter-lifecycle-resolution:v1 target_id=${targetId} fingerprint=${fingerprint} -->`,
                      createdAt: '2026-05-14T00:03:00Z',
                      updatedAt: '2026-05-14T00:03:00Z',
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const loader = new ReviewThreadInventoryLoader(
      {
        owner: 'owner',
        repo: 'repo',
        octokit: { graphql },
      } as unknown as GitHubClient,
      ['review-router-ai[bot]', 'github-actions[bot]']
    );

    const inventory = await loader.load(123);

    expect(inventory.candidates).toHaveLength(0);
    expect(inventory.manualAttention[0]?.target).toMatchObject({
      targetId,
      hasHumanReply: true,
      trustedResolutionMarker: {
        schemaVersion: 'reviewrouter-lifecycle-resolution.v1',
        targetId,
        fingerprint,
        commentId: 'trusted-resolution',
      },
    });
  });

  it('keeps outdated unresolved threads as lifecycle targets but not dedupe refs', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head-sha',
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'outdated-thread',
                isResolved: false,
                isOutdated: true,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: null,
                originalLine: 10,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'outdated-comment',
                      author: { login: 'review-router-ai[bot]' },
                      body: parentBody,
                      createdAt: '2026-05-14T00:00:00Z',
                      updatedAt: '2026-05-14T00:00:00Z',
                      path: 'src/app.ts',
                      line: null,
                      originalLine: 10,
                      diffHunk: '@@',
                      url: 'https://github.test/outdated',
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.candidates).toHaveLength(1);
    expect(inventory.candidates[0]).toMatchObject({
      threadId: 'outdated-thread',
      originalLine: 10,
    });
    expect(inventory.dedupeComments).toHaveLength(0);
  });

  it('fails closed and clears partial candidates when review thread pagination fails', async () => {
    const graphql = jest
      .fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            headRefOid: 'head-sha',
            reviewThreads: {
              pageInfo: { hasNextPage: true, endCursor: 'threads-page-2' },
              nodes: [
                {
                  id: 'active-thread',
                  isResolved: false,
                  viewerCanResolve: true,
                  path: 'src/app.ts',
                  line: 12,
                  comments: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: 'active-comment',
                        author: { login: 'review-router-ai[bot]' },
                        body: parentBody,
                        createdAt: '2026-05-14T00:00:00Z',
                        updatedAt: '2026-05-14T00:00:00Z',
                        path: 'src/app.ts',
                        line: 12,
                        originalLine: 10,
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      })
      .mockRejectedValueOnce(new Error('thread pagination failed'));
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.failed).toBe(true);
    expect(inventory.candidates).toHaveLength(0);
    expect(inventory.manualAttention).toHaveLength(0);
    expect(inventory.dedupeComments).toHaveLength(0);
    expect(inventory.warnings).toContain(
      'review thread lifecycle inventory failed'
    );
  });

  it('fails closed when the review thread connection is missing', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head-sha',
          reviewThreads: null,
        },
      },
    });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.failed).toBe(true);
    expect(inventory.candidates).toHaveLength(0);
    expect(inventory.dedupeComments).toHaveLength(0);
  });

  it('fails closed and clears partial candidates when thread pagination cursor is missing', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head-sha',
          reviewThreads: {
            pageInfo: { hasNextPage: true, endCursor: null },
            nodes: [
              {
                id: 'active-thread',
                isResolved: false,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: 12,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'active-comment',
                      author: { login: 'review-router-ai[bot]' },
                      body: parentBody,
                      createdAt: '2026-05-14T00:00:00Z',
                      updatedAt: '2026-05-14T00:00:00Z',
                      path: 'src/app.ts',
                      line: 12,
                      originalLine: 10,
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.failed).toBe(true);
    expect(inventory.candidates).toHaveLength(0);
    expect(inventory.manualAttention).toHaveLength(0);
    expect(inventory.dedupeComments).toHaveLength(0);
  });

  it('fails closed when review thread pagination repeats a cursor', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head-sha',
          reviewThreads: {
            pageInfo: { hasNextPage: true, endCursor: 'repeated-cursor' },
            nodes: [],
          },
        },
      },
    });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.failed).toBe(true);
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it('fails closed when review thread pagination exceeds its page bound', async () => {
    let page = 0;
    const graphql = jest.fn(async () => {
      page += 1;
      return {
        repository: {
          pullRequest: {
            headRefOid: 'head-sha',
            reviewThreads: {
              pageInfo: {
                hasNextPage: true,
                endCursor: `threads-page-${page}`,
              },
              nodes: [],
            },
          },
        },
      };
    });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.failed).toBe(true);
    expect(graphql).toHaveBeenCalledTimes(100);
  });

  it('fails closed when an unresolved thread has no comment connection', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head-sha',
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'malformed-thread',
                isResolved: false,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: 12,
                comments: null,
              },
            ],
          },
        },
      },
    });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.failed).toBe(true);
    expect(inventory.candidates).toHaveLength(0);
    expect(inventory.dedupeComments).toHaveLength(0);
  });

  it('does not create an auto-resolve candidate from a marker-only old finding', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head-sha',
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'marker-only-thread',
                isResolved: false,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: 12,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'marker-only-comment',
                      author: { login: 'review-router-ai[bot]' },
                      body: '<!-- review-router-finding:aaaaaaaaaaaaaaaaaaaaaaaa -->',
                      createdAt: '2026-05-14T00:00:00Z',
                      updatedAt: '2026-05-14T00:00:00Z',
                      path: 'src/app.ts',
                      line: 12,
                      originalLine: 10,
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.candidates).toHaveLength(0);
    expect(inventory.manualAttention[0].reasonCodes).toContain(
      'missing_old_finding_details'
    );
    expect(inventory.dedupeComments).toHaveLength(1);
  });

  it('does not treat ReviewRouter boilerplate footer as old finding details', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head-sha',
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'marker-footer-thread',
                isResolved: false,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: 12,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'marker-footer-comment',
                      author: { login: 'review-router-ai[bot]' },
                      body: [
                        '<!-- review-router-finding:aaaaaaaaaaaaaaaaaaaaaaaa -->',
                        '',
                        '<sub><!-- review-router-skip-help -->A maintainer/admin can reply `/rr skip` if this finding is a false positive.</sub>',
                        '<sub>Model: codex/gpt-5.5</sub>',
                      ].join('\n'),
                      createdAt: '2026-05-14T00:00:00Z',
                      updatedAt: '2026-05-14T00:00:00Z',
                      path: 'src/app.ts',
                      line: 12,
                      originalLine: 10,
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.candidates).toHaveLength(0);
    expect(inventory.manualAttention[0].reasonCodes).toContain(
      'missing_old_finding_details'
    );
    expect(inventory.dedupeComments).toHaveLength(1);
  });

  it('paginates review threads before building the lifecycle inventory', async () => {
    const graphql = jest
      .fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            headRefOid: 'head-sha',
            reviewThreads: {
              pageInfo: { hasNextPage: true, endCursor: 'threads-page-1' },
              nodes: [],
            },
          },
        },
      })
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            headRefOid: 'head-sha',
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: 'thread-2',
                  isResolved: false,
                  viewerCanResolve: true,
                  path: 'src/app.ts',
                  line: 12,
                  comments: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: 'comment-2',
                        author: { login: 'review-router-ai[bot]' },
                        body: parentBody,
                        createdAt: '2026-05-14T00:00:00Z',
                        updatedAt: '2026-05-14T00:00:00Z',
                        path: 'src/app.ts',
                        line: 12,
                        originalLine: 10,
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql.mock.calls[1][1]).toMatchObject({
      threadsAfter: 'threads-page-1',
    });
    expect(inventory.candidates).toHaveLength(1);
    expect(inventory.candidates[0].threadId).toBe('thread-2');
  });

  it('moves trusted threads with human replies to manual attention', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head-sha',
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'thread-1',
                isResolved: false,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: 12,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'comment-1',
                      author: { login: 'review-router-ai[bot]' },
                      body: parentBody,
                      createdAt: '2026-05-14T00:00:00Z',
                      updatedAt: '2026-05-14T00:00:00Z',
                      path: 'src/app.ts',
                      line: 12,
                    },
                    {
                      id: 'comment-2',
                      author: { login: 'maintainer' },
                      body: 'I am looking at this.',
                      createdAt: '2026-05-14T00:01:00Z',
                      updatedAt: '2026-05-14T00:01:00Z',
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.candidates).toHaveLength(0);
    expect(inventory.manualAttention[0].reasonCodes).toContain('human_reply');
    expect(inventory.dedupeComments).toHaveLength(1);
  });

  it('paginates thread comments before deciding human-reply safety', async () => {
    const graphql = jest
      .fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            headRefOid: 'head-sha',
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: 'thread-1',
                  isResolved: false,
                  viewerCanResolve: true,
                  path: 'src/app.ts',
                  line: 12,
                  comments: {
                    pageInfo: {
                      hasNextPage: true,
                      endCursor: 'comments-page-1',
                    },
                    nodes: [
                      {
                        id: 'comment-1',
                        author: { login: 'review-router-ai[bot]' },
                        body: parentBody,
                        createdAt: '2026-05-14T00:00:00Z',
                        updatedAt: '2026-05-14T00:00:00Z',
                        path: 'src/app.ts',
                        line: 12,
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      })
      .mockResolvedValueOnce({
        node: {
          comments: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'comment-2',
                author: { login: 'maintainer' },
                body: 'This still needs discussion.',
                createdAt: '2026-05-14T00:01:00Z',
                updatedAt: '2026-05-14T00:01:00Z',
              },
            ],
          },
        },
      });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(graphql).toHaveBeenCalledTimes(2);
    expect(inventory.candidates).toHaveLength(0);
    expect(inventory.manualAttention[0].reasonCodes).toContain('human_reply');
    expect(inventory.manualAttention[0].reasonCodes).not.toContain(
      'pagination_incomplete'
    );
  });

  it('fails the fresh inventory closed when comment pagination is incomplete', async () => {
    const graphql = jest
      .fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            headRefOid: 'head-sha',
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: 'thread-1',
                  isResolved: false,
                  viewerCanResolve: true,
                  path: 'src/app.ts',
                  line: 12,
                  comments: {
                    pageInfo: {
                      hasNextPage: true,
                      endCursor: 'comments-page-1',
                    },
                    nodes: [
                      {
                        id: 'comment-1',
                        author: { login: 'review-router-ai[bot]' },
                        body: parentBody,
                        createdAt: '2026-05-14T00:00:00Z',
                        updatedAt: '2026-05-14T00:00:00Z',
                        path: 'src/app.ts',
                        line: 12,
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      })
      .mockRejectedValueOnce(new Error('comments pagination failed'));
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.failed).toBe(true);
    expect(inventory.candidates).toHaveLength(0);
    expect(inventory.manualAttention).toHaveLength(0);
    expect(inventory.dedupeComments).toHaveLength(0);
    expect(inventory.warnings).toContain(
      'review thread lifecycle inventory failed'
    );
  });

  it('fails closed when per-thread comment pagination repeats a cursor', async () => {
    const graphql = jest
      .fn()
      .mockResolvedValueOnce(
        inventoryPageWithPaginatedComments('repeated-comments-cursor')
      )
      .mockResolvedValueOnce({
        node: {
          comments: {
            pageInfo: {
              hasNextPage: true,
              endCursor: 'repeated-comments-cursor',
            },
            nodes: [],
          },
        },
      });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.failed).toBe(true);
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it('fails closed when per-thread comment pagination exceeds its page bound', async () => {
    let commentPage = 0;
    const graphql = jest
      .fn()
      .mockResolvedValueOnce(
        inventoryPageWithPaginatedComments('comments-page-0')
      )
      .mockImplementation(async () => {
        commentPage += 1;
        return {
          node: {
            comments: {
              pageInfo: {
                hasNextPage: true,
                endCursor: `comments-page-${commentPage}`,
              },
              nodes: [],
            },
          },
        };
      });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.failed).toBe(true);
    expect(graphql).toHaveBeenCalledTimes(101);
  });

  it('loads a lifecycle candidate from the plain v2 finding marker dialect', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head-sha',
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'plain-v2-thread',
                isResolved: false,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: 12,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'plain-v2-comment',
                      author: { login: 'review-router-ai[bot]' },
                      body: [
                        '**🟡 Major - Previous Bug**',
                        '',
                        'Old issue body.',
                        '',
                        'reviewrouter:finding:v2:bbbbbbbbbbbbbbbbbbbbbbbb',
                      ].join('\n'),
                      createdAt: '2026-05-14T00:00:00Z',
                      updatedAt: '2026-05-14T00:00:00Z',
                      path: 'src/app.ts',
                      line: 12,
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.failed).toBe(false);
    expect(inventory.candidates).toHaveLength(1);
    expect(inventory.candidates[0].fingerprint).toBe(
      'bbbbbbbbbbbbbbbbbbbbbbbb'
    );
  });

  it('fails the fresh inventory closed on an invalid lifecycle comment timestamp', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head-sha',
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'thread-1',
                isResolved: false,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: 12,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'comment-1',
                      author: { login: 'review-router-ai[bot]' },
                      body: parentBody,
                      createdAt: 'not-a-timestamp',
                      updatedAt: null,
                      path: 'src/app.ts',
                      line: 12,
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.failed).toBe(true);
    expect(inventory.candidates).toHaveLength(0);
    expect(inventory.manualAttention).toHaveLength(0);
    expect(inventory.dedupeComments).toHaveLength(0);
  });

  it('does not let untrusted marker comments suppress new current findings', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head-sha',
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'thread-1',
                isResolved: false,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: 12,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'comment-1',
                      author: { login: 'random-user' },
                      body: parentBody,
                      createdAt: '2026-05-14T00:00:00Z',
                      updatedAt: '2026-05-14T00:00:00Z',
                      path: 'src/app.ts',
                      line: 12,
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.candidates).toHaveLength(0);
    expect(inventory.manualAttention[0].reasonCodes).toContain(
      'untrusted_author'
    );
    expect(inventory.dedupeComments).toHaveLength(0);
  });

  it.each([
    [
      'conflicting',
      [
        '<!-- review-router-finding:aaaaaaaaaaaaaaaaaaaaaaaa -->',
        'reviewrouter:finding:v2:bbbbbbbbbbbbbbbbbbbbbbbb',
      ].join('\n'),
      'conflicting_finding_marker',
    ],
    [
      'malformed',
      'reviewrouter:finding:v2:aaaaaaaaaaaaaaaaaaaaaaa_injected',
      'malformed_finding_marker',
    ],
  ])(
    'marks trusted %s finding markers incomplete and requiring manual attention',
    async (_label, body, reason) => {
      const graphql = jest
        .fn()
        .mockResolvedValue(inventoryPageWithParentBody(body));
      const loader = new ReviewThreadInventoryLoader({
        owner: 'owner',
        repo: 'repo',
        octokit: { graphql },
      } as unknown as GitHubClient);

      const inventory = await loader.load(123);

      expect(inventory.failed).toBe(true);
      expect(inventory.candidates).toEqual([]);
      expect(inventory.dedupeComments).toEqual([]);
      expect(inventory.manualAttentionIssues).toEqual([
        expect.objectContaining({
          threadId: 'marker-thread',
          parentCommentId: 'marker-parent',
          reason,
        }),
      ]);
    }
  );

  it('ignores conflicting marker syntax on a foreign thread', async () => {
    const graphql = jest
      .fn()
      .mockResolvedValue(
        inventoryPageWithParentBody(
          [
            '<!-- review-router-finding:aaaaaaaaaaaaaaaaaaaaaaaa -->',
            'reviewrouter:finding:v2:bbbbbbbbbbbbbbbbbbbbbbbb',
          ].join('\n'),
          'random-user'
        )
      );
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.failed).toBe(false);
    expect(inventory.candidates).toEqual([]);
    expect(inventory.manualAttention).toEqual([]);
    expect(inventory.manualAttentionIssues).toEqual([]);
  });

  it('trusts configured GitHub App bot comments for lifecycle candidates', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head-sha',
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'thread-1',
                isResolved: false,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: 12,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'comment-1',
                      author: { login: 'review-router-owner[bot]' },
                      body: parentBody,
                      createdAt: '2026-05-14T00:00:00Z',
                      updatedAt: '2026-05-14T00:00:00Z',
                      path: 'src/app.ts',
                      line: 12,
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const loader = new ReviewThreadInventoryLoader(
      {
        owner: 'owner',
        repo: 'repo',
        octokit: { graphql },
      } as unknown as GitHubClient,
      trustedReviewThreadAuthorsFromEnv({
        REVIEW_APP_SLUG: 'review-router-owner',
      } as NodeJS.ProcessEnv)
    );

    const inventory = await loader.load(123);

    expect(inventory.candidates).toHaveLength(1);
    expect(inventory.manualAttention).toHaveLength(0);
    expect(inventory.dedupeComments).toHaveLength(1);
  });
});

function expectGraphqlBracesBalanced(query: string): void {
  let balance = 0;
  for (const char of query) {
    if (char === '{') balance += 1;
    if (char === '}') balance -= 1;
    expect(balance).toBeGreaterThanOrEqual(0);
  }
  expect(balance).toBe(0);
}

function inventoryPageWithPaginatedComments(endCursor: string) {
  return {
    repository: {
      pullRequest: {
        headRefOid: 'head-sha',
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: 'paginated-thread',
              isResolved: false,
              viewerCanResolve: true,
              path: 'src/app.ts',
              line: 12,
              comments: {
                pageInfo: { hasNextPage: true, endCursor },
                nodes: [
                  {
                    id: 'paginated-parent',
                    author: { login: 'review-router-ai[bot]' },
                    body: parentBody,
                    createdAt: '2026-05-14T00:00:00Z',
                    updatedAt: '2026-05-14T00:00:00Z',
                    path: 'src/app.ts',
                    line: 12,
                  },
                ],
              },
            },
          ],
        },
      },
    },
  };
}

function inventoryPageWithParentBody(
  body: string,
  author = 'review-router-ai[bot]'
) {
  return {
    repository: {
      pullRequest: {
        headRefOid: 'head-sha',
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: 'marker-thread',
              isResolved: false,
              viewerCanResolve: true,
              path: 'src/app.ts',
              line: 12,
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: 'marker-parent',
                    author: { login: author },
                    body,
                    createdAt: '2026-05-14T00:00:00Z',
                    updatedAt: '2026-05-14T00:00:00Z',
                    path: 'src/app.ts',
                    line: 12,
                    url: 'https://github.test/marker-thread',
                  },
                ],
              },
            },
          ],
        },
      },
    },
  };
}
