import { FeedbackFilter } from '../../../src/github/feedback';
import { GitHubClient } from '../../../src/github/client';
import { InlineComment } from '../../../src/types';
import {
  findingFingerprintMarker,
  findingFingerprintFromInlineComment,
  fingerprintFromInlineComment,
} from '../../../src/github/comment-fingerprint';

// Mock GitHubClient
jest.mock('../../../src/github/client');

type MockOctokit = {
  rest: {
    pulls: {
      listReviewComments: jest.Mock;
    };
    reactions: {
      listForPullRequestReviewComment: jest.Mock;
    };
    repos: {
      getCollaboratorPermissionLevel: jest.Mock;
    };
  };
  paginate: jest.Mock;
};

describe('FeedbackFilter', () => {
  const trustedReviewRouterAuthor = {
    user: { login: 'review-router-ai[bot]' },
  };
  let feedbackFilter: FeedbackFilter;
  let mockClient: jest.Mocked<GitHubClient>;
  let mockOctokit: MockOctokit;

  beforeEach(() => {
    mockOctokit = {
      rest: {
        pulls: {
          listReviewComments: jest.fn(),
        },
        reactions: {
          listForPullRequestReviewComment: jest.fn(),
        },
        repos: {
          getCollaboratorPermissionLevel: jest.fn(),
        },
      },
      paginate: jest.fn(),
    };

    mockClient = {
      octokit: mockOctokit,
      owner: 'test-owner',
      repo: 'test-repo',
    } as unknown as jest.Mocked<GitHubClient>;

    feedbackFilter = new FeedbackFilter(mockClient);
  });

  describe('loadSuppressed', () => {
    it('should return empty set when no comments exist', async () => {
      mockOctokit.paginate.mockResolvedValue([]);

      const suppressed = await feedbackFilter.loadSuppressed(123);

      expect(suppressed.size).toBe(0);
      expect(mockOctokit.paginate).toHaveBeenCalledWith(
        mockOctokit.rest.pulls.listReviewComments,
        {
          owner: 'test-owner',
          repo: 'test-repo',
          pull_number: 123,
          per_page: 100,
        }
      );
    });

    it('does not treat thumbs-down reactions as override state', async () => {
      const mockComments = [
        {
          id: 1,
          path: 'src/file.ts',
          line: 10,
          body: '**Security Issue**\nThis is a finding',
        },
        {
          id: 2,
          path: 'src/other.ts',
          line: 20,
          body: '**Performance Issue**\nAnother finding',
        },
      ];

      mockOctokit.paginate.mockResolvedValue(mockComments);

      const suppressed = await feedbackFilter.loadSuppressed(123);

      expect(suppressed.size).toBe(0);
      expect(
        mockOctokit.rest.reactions.listForPullRequestReviewComment
      ).not.toHaveBeenCalled();
    });
  });

  describe('loadReviewCommentState', () => {
    it('tracks existing ReviewRouter inline comments without thumbs-down', async () => {
      mockOctokit.paginate.mockResolvedValue([
        {
          ...trustedReviewRouterAuthor,
          id: 1,
          path: 'src/file.ts',
          line: 10,
          body: '**🟡 Major - SQL injection**\n\nUse parameterized queries.',
        },
      ]);
      mockOctokit.rest.reactions.listForPullRequestReviewComment.mockResolvedValue(
        {
          data: [],
        }
      );

      const state = await feedbackFilter.loadReviewCommentState(123);

      expect(state.suppressed.size).toBe(0);
      expect(state.alreadyPosted.has('src/file.ts:10:major')).toBe(true);
      expect(
        feedbackFilter.shouldPost(
          {
            path: 'src/file.ts',
            line: 10,
            side: 'RIGHT',
            body: '**🟡 Major - SQL injection**\n\nUse parameterized queries.',
          },
          state
        )
      ).toBe(false);
    });

    it('does not treat human review comments as already posted', async () => {
      mockOctokit.paginate.mockResolvedValue([
        {
          user: { login: 'alice' },
          id: 1,
          path: 'src/file.ts',
          line: 10,
          body: '**SQL injection**\n\nHuman reviewer comment.',
        },
      ]);
      mockOctokit.rest.reactions.listForPullRequestReviewComment.mockResolvedValue(
        {
          data: [],
        }
      );

      const state = await feedbackFilter.loadReviewCommentState(123);

      expect(state.alreadyPosted.size).toBe(0);
    });

    it.each([undefined, 'mallory'])(
      '%s author cannot forge a dedup marker',
      async (login) => {
        const body =
          '**🟡 Major - SQL injection**\n\nUse parameterized queries.';
        const fingerprint = findingFingerprintFromInlineComment(
          'src/file.ts',
          10,
          body
        );
        mockOctokit.paginate.mockResolvedValue([
          {
            id: 1,
            path: 'src/file.ts',
            line: 10,
            body: `${body}\n\n${findingFingerprintMarker(fingerprint)}`,
            ...(login ? { user: { login } } : {}),
          },
        ]);

        const state = await feedbackFilter.loadReviewCommentState(123);

        expect(state.inventoryComplete).toBe(true);
        expect(state.alreadyPostedFindings?.size).toBe(0);
        expect(
          feedbackFilter.shouldPost(
            { path: 'src/file.ts', line: 10, side: 'RIGHT', body },
            state
          )
        ).toBe(true);
      }
    );

    it('uses hidden inline fingerprint markers for stable duplicate detection', async () => {
      const existingBody =
        '**🟡 Major - SQL injection**\n\nUse parameterized queries.';
      const fingerprint = fingerprintFromInlineComment(
        'src/file.ts',
        10,
        existingBody
      );
      mockOctokit.paginate.mockResolvedValue([
        {
          ...trustedReviewRouterAuthor,
          id: 1,
          path: 'src/file.ts',
          line: 10,
          body: `${existingBody}\n\n<!-- review-router-inline:${fingerprint} -->`,
        },
      ]);
      mockOctokit.rest.reactions.listForPullRequestReviewComment.mockResolvedValue(
        {
          data: [],
        }
      );

      const state = await feedbackFilter.loadReviewCommentState(123);

      expect(state.alreadyPosted.has(fingerprint)).toBe(true);
      expect(
        feedbackFilter.shouldPost(
          {
            path: 'src/file.ts',
            line: 10,
            side: 'RIGHT',
            body: existingBody,
          },
          state
        )
      ).toBe(false);
    });

    it('blocks duplicates when model rewrites the title for the same severity and line', async () => {
      mockOctokit.paginate.mockResolvedValue([
        {
          ...trustedReviewRouterAuthor,
          id: 1,
          path: 'src/file.ts',
          line: 10,
          body: '**🟡 Major - Unknown plan crashes lookup**\n\nUse a fallback.',
        },
      ]);
      mockOctokit.rest.reactions.listForPullRequestReviewComment.mockResolvedValue(
        {
          data: [],
        }
      );

      const state = await feedbackFilter.loadReviewCommentState(123);

      expect(
        feedbackFilter.shouldPost(
          {
            path: 'src/file.ts',
            line: 10,
            side: 'RIGHT',
            body: '**🟡 Major - Missing plan crashes billing lookup**\n\nUse a fallback.',
          },
          state
        )
      ).toBe(false);
    });

    it('derives exact v2 identity for an unmarked synthesized duplicate', async () => {
      const body =
        '**🟡 Major - Null cache entry crashes startup**\n\nDereferencing `cacheEntry` throws before the fallback runs.';
      const findingFingerprint = findingFingerprintFromInlineComment(
        'src/file.ts',
        10,
        body
      );
      const markedBody = `${body}\n\n${findingFingerprintMarker(findingFingerprint)}`;
      mockOctokit.paginate.mockResolvedValue([
        {
          ...trustedReviewRouterAuthor,
          id: 1,
          path: 'src/file.ts',
          line: 10,
          body: markedBody,
        },
      ]);

      const state = await feedbackFilter.loadReviewCommentState(123);

      expect(
        feedbackFilter.shouldPost(
          {
            path: 'src/file.ts',
            line: 10,
            side: 'RIGHT',
            body,
          },
          state
        )
      ).toBe(false);
    });

    it('does not let a coarse location key suppress distinct v2 findings', async () => {
      const existingBody =
        '**🟡 Major - Null cache entry crashes startup**\n\nDereferencing `cacheEntry` throws before the fallback runs.';
      const candidateBody =
        '**🟡 Major - Audit export exhausts memory**\n\nLoading every audit row into one array can terminate the worker.';
      mockOctokit.paginate.mockResolvedValue([
        {
          ...trustedReviewRouterAuthor,
          id: 1,
          path: 'src/file.ts',
          line: 10,
          body: `${existingBody}\n\n${findingFingerprintMarker(
            findingFingerprintFromInlineComment('src/file.ts', 10, existingBody)
          )}`,
        },
      ]);

      const state = await feedbackFilter.loadReviewCommentState(123);
      expect(
        feedbackFilter.shouldPost(
          {
            path: 'src/file.ts',
            line: 10,
            side: 'RIGHT',
            body: candidateBody,
          },
          state
        )
      ).toBe(true);
    });

    it('keeps coarse compatibility for a markerless legacy comment', async () => {
      mockOctokit.paginate.mockResolvedValue([
        {
          ...trustedReviewRouterAuthor,
          id: 1,
          path: 'src/file.ts',
          line: 10,
          body: '**🟡 Major - Legacy cache warning**\n\nOld diagnostic text.',
        },
      ]);

      const state = await feedbackFilter.loadReviewCommentState(123);
      const candidateBody =
        '**🟡 Major - Distinct export warning**\n\nCompletely unrelated diagnostic text.';

      expect(
        feedbackFilter.shouldPost(
          {
            path: 'src/file.ts',
            line: 10,
            side: 'RIGHT',
            body: candidateBody,
          },
          state
        )
      ).toBe(false);
    });

    it.each([
      `reviewrouter:finding:v2:${'a'.repeat(23)}`,
      `${findingFingerprintMarker('a'.repeat(24))}\n${findingFingerprintMarker(
        'b'.repeat(24)
      )}`,
    ])(
      'fails open for malformed or conflicting finding markers',
      async (marker) => {
        mockOctokit.paginate.mockResolvedValue([
          {
            ...trustedReviewRouterAuthor,
            id: 1,
            path: 'src/file.ts',
            line: 10,
            body: `**🟡 Major - Legacy cache warning**\n\nOld diagnostic text.\n\n${marker}`,
          },
        ]);

        const state = await feedbackFilter.loadReviewCommentState(123);
        const candidateBody =
          '**🟡 Major - Distinct export warning**\n\nCompletely unrelated diagnostic text.';

        expect(
          feedbackFilter.shouldPost(
            {
              path: 'src/file.ts',
              line: 10,
              side: 'RIGHT',
              body: candidateBody,
            },
            state
          )
        ).toBe(true);
      }
    );

    it.each([
      `reviewrouter:finding:v2:${'a'.repeat(23)}`,
      `${findingFingerprintMarker('a'.repeat(24))}\n${findingFingerprintMarker(
        'b'.repeat(24)
      )}`,
    ])('fails open for an invalid candidate marker', async (marker) => {
      const body =
        '**🟡 Major - Null cache entry crashes startup**\n\nDereferencing `cacheEntry` throws before the fallback runs.';
      mockOctokit.paginate.mockResolvedValue([
        {
          ...trustedReviewRouterAuthor,
          id: 1,
          path: 'src/file.ts',
          line: 10,
          body: `${body}\n\n${findingFingerprintMarker(
            findingFingerprintFromInlineComment('src/file.ts', 10, body)
          )}`,
        },
      ]);

      const state = await feedbackFilter.loadReviewCommentState(123);

      expect(
        feedbackFilter.shouldPost(
          {
            path: 'src/file.ts',
            line: 10,
            side: 'RIGHT',
            body: `${body}\n\n${marker}`,
          },
          state
        )
      ).toBe(true);
    });

    it('blocks semantic duplicates when the model shifts the line and rewrites the title', async () => {
      mockOctokit.paginate.mockResolvedValue([
        {
          ...trustedReviewRouterAuthor,
          id: 1,
          path: 'lib/app/chat/chats_page.dart',
          line: 52,
          body: [
            '**🟡 Major - Deep links to hidden paid chats spin forever**',
            '',
            'When `hidePaidFeaturesInfo` is true, this branch removes every inaccessible course from `courseItems`, so a direct chat link can keep waiting forever.',
          ].join('\n'),
        },
      ]);
      mockOctokit.rest.reactions.listForPullRequestReviewComment.mockResolvedValue(
        {
          data: [],
        }
      );

      const state = await feedbackFilter.loadReviewCommentState(123);

      expect(
        feedbackFilter.shouldPost(
          {
            path: 'lib/app/chat/chats_page.dart',
            line: 54,
            side: 'RIGHT',
            body: [
              '**🟡 Major - Direct links to hidden paid chats hang**',
              '',
              'When `hidePaidFeaturesInfo` is true this branch removes every unavailable paid course from `courseItems`, so opening a direct chat link hangs.',
            ].join('\n'),
          },
          state
        )
      ).toBe(false);
    });

    it('does not treat outdated ReviewRouter comments as already posted', async () => {
      mockOctokit.paginate.mockResolvedValue([
        {
          ...trustedReviewRouterAuthor,
          id: 1,
          path: 'src/file.ts',
          line: null,
          original_line: 10,
          body: '**🟡 Major - SQL injection**\n\nUse parameterized queries.',
        },
      ]);
      mockOctokit.rest.reactions.listForPullRequestReviewComment.mockResolvedValue(
        {
          data: [],
        }
      );

      const state = await feedbackFilter.loadReviewCommentState(123);

      expect(state.alreadyPosted.size).toBe(0);
      expect(
        feedbackFilter.shouldPost(
          {
            path: 'src/file.ts',
            line: 10,
            side: 'RIGHT',
            body: '**🟡 Major - SQL injection**\n\nUse parameterized queries.',
          },
          state
        )
      ).toBe(true);
    });

    it('uses valid signed ledger skip entries to suppress matching findings', async () => {
      const parentBody = [
        '**🟡 Major - SQL injection**',
        '',
        '**Severity:** 🟡 **Major** - should fix before merge; correctness, reliability, or maintainability risk.',
        '',
        'Use parameterized queries.',
      ].join('\n');
      const findingFingerprint = findingFingerprintFromInlineComment(
        'src/file.ts',
        10,
        parentBody
      );
      const ledger = {
        load: jest.fn().mockResolvedValue({
          valid: true,
          payload: {
            version: 1,
            repo: 'test-owner/test-repo',
            pr: 123,
            entries: [],
          },
        }),
        activeSkips: jest.fn().mockReturnValue([
          {
            action: 'skip',
            fingerprint: findingFingerprint,
            severity: 'major',
            path: 'src/file.ts',
            line: 10,
            title: 'SQL injection',
            body: parentBody,
            reason: 'validated false positive',
            actor: 'maintainer',
            actorRole: 'maintain',
            parentCommentId: 10,
            createdAt: '2026-05-01T00:00:00.000Z',
          },
        ]),
      };
      feedbackFilter = new FeedbackFilter(mockClient, undefined, ledger as any);

      mockOctokit.paginate.mockResolvedValue([
        {
          ...trustedReviewRouterAuthor,
          id: 10,
          path: 'src/file.ts',
          line: 10,
          body: parentBody,
        },
      ]);

      const state = await feedbackFilter.loadReviewCommentState(123);

      expect(state.commandDismissed?.has(findingFingerprint)).toBe(true);
      expect(state.commandDismissedLocations?.has('src/file.ts:10')).toBe(true);
      expect(
        feedbackFilter.shouldPost(
          {
            path: 'src/file.ts',
            line: 10,
            side: 'RIGHT',
            body: parentBody,
          },
          state
        )
      ).toBe(false);
      expect(
        feedbackFilter.isFindingCommandDismissed(
          {
            file: 'src/file.ts',
            line: 10,
            severity: 'major',
            title: 'SQL injection',
            message: 'Use parameterized queries.',
          },
          state
        )
      ).toBe(true);
      expect(
        feedbackFilter.isFindingCommandDismissed(
          {
            file: 'src/file.ts',
            line: 10,
            severity: 'major',
            title: 'Email lookup still has SQL injection',
            message:
              'The rerun can phrase the same skipped finding differently, but it still says the query should be parameterized.',
          },
          state
        )
      ).toBe(true);
      expect(
        feedbackFilter.isFindingCommandDismissed(
          {
            file: 'src/file.ts',
            line: 10,
            severity: 'critical',
            title: 'Different auth bypass on the same line',
            message:
              'A new and unrelated blocking issue on the same path and line must still be reported.',
          },
          state
        )
      ).toBe(false);
      expect(
        feedbackFilter.isFindingCommandDismissed(
          {
            file: 'src/file.ts',
            line: 11,
            severity: 'critical',
            title: 'Different line should still block',
            message: 'A skip is exact to the dismissed path and line.',
          },
          state
        )
      ).toBe(false);
    });

    it('keeps a maintainer skip when the same issue is reclassified from major to critical', async () => {
      const parentBody = [
        '_🟡 Major_ | _⚡ Quick win_',
        '',
        '**Email lookup ignores requested address**',
        '',
        '`findUserByEmail` now returns `db.users[0]` regardless of the `email` argument, so `canLogin(db, email)` allows any email whenever the database has at least one user.',
      ].join('\n');
      const ledger = {
        load: jest.fn().mockResolvedValue({
          valid: true,
          payload: {
            version: 1,
            repo: 'test-owner/test-repo',
            pr: 123,
            entries: [],
          },
        }),
        activeSkips: jest.fn().mockReturnValue([
          {
            action: 'skip',
            fingerprint: 'old-fingerprint',
            severity: 'major',
            path: 'src.js',
            line: 2,
            title: 'Email lookup ignores requested address',
            body: parentBody,
            reason: '',
            actor: 'maintainer',
            actorRole: 'admin',
            parentCommentId: 10,
            createdAt: '2026-05-01T00:00:00.000Z',
          },
        ]),
      };
      feedbackFilter = new FeedbackFilter(mockClient, undefined, ledger as any);
      mockOctokit.paginate.mockResolvedValue([]);

      const state = await feedbackFilter.loadReviewCommentState(123);

      expect(
        feedbackFilter.isFindingCommandDismissed(
          {
            file: 'src.js',
            line: 2,
            severity: 'critical',
            title: 'Email lookup now authenticates the wrong user',
            message:
              '`findUserByEmail` returns `db.users[0]` without comparing `email`, and `canLogin` treats any returned user as authorization. Any unknown email can log in when the database has at least one user.',
          },
          state
        )
      ).toBe(true);
      expect(
        feedbackFilter.isFindingCommandDismissed(
          {
            file: 'src.js',
            line: 2,
            severity: 'critical',
            title: 'Password hash comparison is missing',
            message:
              'The code accepts a request without validating the password hash.',
          },
          state
        )
      ).toBe(false);
    });

    it('keeps a maintainer skip across model title rewrites when the location and issue are still the same', async () => {
      const ledger = {
        load: jest.fn().mockResolvedValue({
          valid: true,
          payload: {
            version: 1,
            repo: 'test-owner/test-repo',
            pr: 123,
            entries: [],
          },
        }),
        activeSkips: jest.fn().mockReturnValue([
          {
            action: 'skip',
            fingerprint: '67806f285f81dc0c6144468fe09c14df',
            legacyFingerprint: '6010d64ea131dcc7',
            severity: 'critical',
            path: 'auth.js',
            line: 5,
            title: 'Login bypass returns admin for any email',
            reason: 'maintainer verified',
            actor: 'maintainer',
            actorRole: 'admin',
            parentCommentId: 10,
            createdAt: '2026-05-01T00:00:00.000Z',
          },
        ]),
      };
      feedbackFilter = new FeedbackFilter(mockClient, undefined, ledger as any);
      mockOctokit.paginate.mockResolvedValue([]);

      const state = await feedbackFilter.loadReviewCommentState(
        123,
        'new-head'
      );

      expect(
        feedbackFilter.isFindingCommandDismissed(
          {
            file: 'auth.js',
            line: 5,
            severity: 'critical',
            title: 'Login ignores the supplied email',
            message:
              'The lookup ignores the supplied email and returns the first user, so login succeeds for any address.',
          },
          state
        )
      ).toBe(true);
      expect(
        feedbackFilter.isFindingCommandDismissed(
          {
            file: 'auth.js',
            line: 5,
            severity: 'critical',
            title: 'Password hash comparison is missing',
            message:
              'The code accepts a request without validating the password hash.',
          },
          state
        )
      ).toBe(false);
    });

    it('fails closed when the GitHub comment inventory fails while preserving ledger dismissals', async () => {
      const body = '**🟡 Major - SQL injection**\n\nUse parameterized queries.';
      const findingFingerprint = findingFingerprintFromInlineComment(
        'src/file.ts',
        10,
        body
      );
      const ledger = {
        load: jest.fn().mockResolvedValue({
          valid: true,
          payload: {
            version: 1,
            repo: 'test-owner/test-repo',
            pr: 123,
            entries: [],
          },
        }),
        activeSkips: jest.fn().mockReturnValue([
          {
            action: 'skip',
            fingerprint: findingFingerprint,
            severity: 'major',
            path: 'src/file.ts',
            line: 10,
            title: 'SQL injection',
            body,
            reason: 'validated false positive',
            actor: 'maintainer',
            actorRole: 'maintain',
            parentCommentId: 10,
            createdAt: '2026-05-01T00:00:00.000Z',
          },
        ]),
      };
      feedbackFilter = new FeedbackFilter(mockClient, undefined, ledger as any);
      mockOctokit.paginate.mockRejectedValue(
        new Error('review comment pagination failed')
      );

      const state = await feedbackFilter.loadReviewCommentState(123);

      expect(state.inventoryComplete).toBe(false);
      expect(state.inventoryFailure).toBe('review comment pagination failed');
      expect(state.alreadyPosted.size).toBe(0);
      expect(
        feedbackFilter.shouldPost(
          { path: 'src/another.ts', line: 20, side: 'RIGHT', body },
          state
        )
      ).toBe(false);
      expect(
        feedbackFilter.isFindingCommandDismissed(
          {
            file: 'src/file.ts',
            line: 10,
            severity: 'major',
            title: 'SQL injection',
            message: 'Use parameterized queries.',
          },
          state
        )
      ).toBe(true);
    });

    it('ignores invalid ledger state and keeps active duplicate suppression', async () => {
      const ledger = {
        load: jest.fn().mockResolvedValue({
          valid: false,
          payload: {
            version: 1,
            repo: 'test-owner/test-repo',
            pr: 123,
            entries: [],
          },
          invalidReason: 'bad signature',
        }),
        activeSkips: jest.fn(),
      };
      feedbackFilter = new FeedbackFilter(mockClient, undefined, ledger as any);
      mockOctokit.paginate.mockResolvedValue([
        {
          ...trustedReviewRouterAuthor,
          id: 10,
          path: 'src/file.ts',
          line: 10,
          body: '**🟡 Major - SQL injection**\n\nUse parameterized queries.',
        },
      ]);

      const state = await feedbackFilter.loadReviewCommentState(123);

      expect(state.commandDismissed?.size).toBe(0);
      expect(ledger.activeSkips).not.toHaveBeenCalled();
      expect(
        feedbackFilter.isFindingCommandDismissed(
          {
            file: 'src/file.ts',
            line: 10,
            severity: 'major',
            title: 'SQL injection',
            message: 'Use parameterized queries.',
          },
          state
        )
      ).toBe(false);
      expect(
        feedbackFilter.shouldPost(
          {
            path: 'src/file.ts',
            line: 10,
            side: 'RIGHT',
            body: '**🟡 Major - SQL injection**\n\nUse parameterized queries.',
          },
          state
        )
      ).toBe(false);
    });
  });

  describe('shouldPost', () => {
    it('should allow posting when comment is not suppressed', () => {
      const comment: InlineComment = {
        path: 'src/file.ts',
        line: 10,
        side: 'RIGHT',
        body: '**Issue Title**\nDescription',
      };

      const suppressed = new Set<string>();
      const result = feedbackFilter.shouldPost(comment, suppressed);

      expect(result).toBe(true);
    });

    it('should block posting when comment is suppressed', () => {
      const comment: InlineComment = {
        path: 'src/file.ts',
        line: 10,
        side: 'RIGHT',
        body: '**Issue Title**\nDescription',
      };

      const suppressed = new Set<string>(['src/file.ts:10:issue title']);
      const result = feedbackFilter.shouldPost(comment, suppressed);

      expect(result).toBe(false);
    });

    it('should be case-insensitive for file paths and titles', () => {
      const comment: InlineComment = {
        path: 'src/File.TS',
        line: 10,
        side: 'RIGHT',
        body: '**Issue TITLE**\nDescription',
      };

      const suppressed = new Set<string>(['src/file.ts:10:issue title']);
      const result = feedbackFilter.shouldPost(comment, suppressed);

      expect(result).toBe(false);
    });

    it('should differentiate between different line numbers', () => {
      const comment1: InlineComment = {
        path: 'src/file.ts',
        line: 10,
        side: 'RIGHT',
        body: '**Issue**\nDescription',
      };

      const comment2: InlineComment = {
        path: 'src/file.ts',
        line: 20,
        side: 'RIGHT',
        body: '**Issue**\nDescription',
      };

      const suppressed = new Set<string>(['src/file.ts:10:issue']);

      expect(feedbackFilter.shouldPost(comment1, suppressed)).toBe(false);
      expect(feedbackFilter.shouldPost(comment2, suppressed)).toBe(true);
    });

    it('should differentiate between different files', () => {
      const comment1: InlineComment = {
        path: 'src/file1.ts',
        line: 10,
        side: 'RIGHT',
        body: '**Issue**\nDescription',
      };

      const comment2: InlineComment = {
        path: 'src/file2.ts',
        line: 10,
        side: 'RIGHT',
        body: '**Issue**\nDescription',
      };

      const suppressed = new Set<string>(['src/file1.ts:10:issue']);

      expect(feedbackFilter.shouldPost(comment1, suppressed)).toBe(false);
      expect(feedbackFilter.shouldPost(comment2, suppressed)).toBe(true);
    });
  });

  describe('reaction feedback', () => {
    it('does not use reactions for dismissal or provider learning', async () => {
      const mockWeightTracker = {
        recordFeedback: jest.fn().mockResolvedValue(undefined),
      };
      const filter = new FeedbackFilter(mockClient, mockWeightTracker as any);

      mockOctokit.paginate.mockResolvedValue([
        {
          id: 1,
          path: 'test.ts',
          line: 10,
          body: '**Issue Title**\n\n**Provider:** `claude`',
        },
      ]);

      const suppressed = await filter.loadSuppressed(123);

      expect(suppressed.size).toBe(0);
      expect(mockWeightTracker.recordFeedback).not.toHaveBeenCalled();
      expect(
        mockOctokit.rest.reactions.listForPullRequestReviewComment
      ).not.toHaveBeenCalled();
    });
  });
});
