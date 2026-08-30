import { CommentPoster } from '../../../src/github/comment-poster';
import { GitHubClient } from '../../../src/github/client';
import { InlineComment, FileChange } from '../../../src/types';
import { logger } from '../../../src/utils/logger';
import { appendReviewSummaryMetadata } from '../../../src/github/summary-metadata';
import {
  findingFingerprintFromInlineComment,
  findingFingerprintMarker,
  parseTrustedEscalationMarker,
  sameSemanticLineage,
} from '../../../src/github/comment-fingerprint';

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('CommentPoster', () => {
  let mockClient: jest.Mocked<GitHubClient>;
  let mockOctokit: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockOctokit = {
      rest: {
        issues: {
          createComment: jest.fn().mockResolvedValue({}),
          updateComment: jest.fn().mockResolvedValue({}),
          deleteComment: jest.fn().mockResolvedValue({}),
          listComments: jest.fn().mockResolvedValue({ data: [] }),
          listEventsForTimeline: jest.fn().mockResolvedValue({ data: [] }),
        },
        pulls: {
          get: jest
            .fn()
            .mockResolvedValue({ data: { head: { sha: 'head-sha' } } }),
          createReview: jest.fn().mockResolvedValue({}),
          createReviewComment: jest.fn().mockResolvedValue({}),
          createReplyForReviewComment: jest.fn().mockResolvedValue({}),
          listReviewComments: jest.fn(),
        },
      },
      paginate: jest.fn().mockResolvedValue([]),
    };

    mockClient = {
      octokit: mockOctokit,
      owner: 'test-owner',
      repo: 'test-repo',
    } as any;
  });

  function expectNoSharedIssueCommentAccess(): void {
    expect(mockOctokit.rest.issues.listComments).not.toHaveBeenCalled();
    expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(mockOctokit.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(mockOctokit.rest.issues.deleteComment).not.toHaveBeenCalled();
  }

  describe('Normal Mode', () => {
    it('posts summary comment', async () => {
      const poster = new CommentPoster(mockClient, false);
      const body = 'Test summary';

      await poster.postSummary(123, body, false); // Don't update existing

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 123,
        body: expect.stringContaining('Test summary'),
      });
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('<!-- review-router-bot -->'),
        })
      );
    });

    it('updates an existing ReviewRouter summary instead of duplicating it', async () => {
      mockOctokit.rest.issues.listComments.mockResolvedValueOnce({
        data: [
          {
            id: 99,
            body: '<!-- review-router-bot -->\n\n# ReviewRouter\nold summary',
          },
        ],
      });
      const poster = new CommentPoster(mockClient, false);

      await poster.postSummary(123, 'New summary', true);

      expect(mockOctokit.rest.issues.updateComment).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        comment_id: 99,
        body: expect.stringContaining('New summary'),
      });
      expect(mockOctokit.rest.issues.deleteComment).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it('falls back to timeline comments when the issue comments list has no summaries', async () => {
      mockOctokit.rest.issues.listComments.mockResolvedValueOnce({
        data: [],
      });
      mockOctokit.rest.issues.listEventsForTimeline.mockResolvedValueOnce({
        data: [
          {
            id: 97,
            event: 'commented',
            body: '<!-- review-router-bot -->\n\n# ReviewRouter\nolder summary',
          },
          {
            id: 99,
            event: 'commented',
            body: '<!-- review-router-bot -->\n\n# ReviewRouter\nold summary',
          },
        ],
      });
      const poster = new CommentPoster(mockClient, false);

      await poster.postSummary(123, 'New summary', true);

      expect(mockOctokit.rest.issues.updateComment).toHaveBeenCalledWith(
        expect.objectContaining({
          comment_id: 99,
          body: expect.stringContaining('New summary'),
        })
      );
      expect(mockOctokit.rest.issues.deleteComment).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        comment_id: 97,
      });
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it('deletes older duplicate ReviewRouter summaries after updating the latest one', async () => {
      mockOctokit.rest.issues.listComments.mockResolvedValueOnce({
        data: [
          {
            id: 98,
            body: '<!-- review-router-bot -->\n\n# ReviewRouter\nolder summary',
          },
          {
            id: 99,
            body: '<!-- review-router-bot -->\n\n# ReviewRouter\nold summary',
          },
        ],
      });
      const poster = new CommentPoster(mockClient, false);

      await poster.postSummary(123, 'New summary', true);

      expect(mockOctokit.rest.issues.updateComment).toHaveBeenCalledWith(
        expect.objectContaining({
          comment_id: 99,
          body: expect.stringContaining('New summary'),
        })
      );
      expect(mockOctokit.rest.issues.deleteComment).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        comment_id: 98,
      });
    });

    it('deletes stale summary comments after an all-clear rerun', async () => {
      const oldBody = appendReviewSummaryMetadata(
        '<!-- review-router-bot -->\n\n# ReviewRouter\nold finding',
        {
          reviewedHeadSha: 'head-sha',
          workflowRunId: '10',
          workflowRunAttempt: 1,
        }
      );
      const newerBody = appendReviewSummaryMetadata(
        '<!-- review-router-bot -->\n\n# ReviewRouter\nnewer finding',
        {
          reviewedHeadSha: 'head-sha',
          workflowRunId: '30',
          workflowRunAttempt: 1,
        }
      );
      mockOctokit.rest.issues.listComments.mockResolvedValueOnce({
        data: [
          { id: 11, body: oldBody },
          { id: 12, body: newerBody },
          {
            id: 13,
            body: '<!-- review-router-inline-fallback -->\n# fallback',
          },
          { id: 14, body: 'human comment' },
        ],
      });
      const poster = new CommentPoster(mockClient, false);

      await poster.deleteSummaryComments(123, {
        reviewedHeadSha: 'head-sha',
        workflowRunId: '20',
        workflowRunAttempt: 1,
      });

      expect(mockOctokit.rest.issues.deleteComment).toHaveBeenCalledTimes(1);
      expect(mockOctokit.rest.issues.deleteComment).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        comment_id: 11,
      });
    });

    it('posts inline comments', async () => {
      const poster = new CommentPoster(mockClient, false);
      const comments: InlineComment[] = [
        {
          path: 'src/test.ts',
          line: 10,
          side: 'RIGHT' as const,
          body: [
            'Test comment',
            '',
            '<sub>Model: openrouter/poolside/laguna-m.1:free</sub>',
          ].join('\n'),
          severity: 'major',
        },
      ];
      const files: FileChange[] = [
        {
          filename: 'src/test.ts',
          status: 'modified',
          additions: 5,
          deletions: 2,
          changes: 7,
          patch: '@@ -8,3 +8,4 @@\n line8\n line9\n+line10\n line11',
        },
      ];

      await poster.postInline(123, comments, files);

      const reviewCall = mockOctokit.rest.pulls.createReview.mock.calls[0][0];
      expect(reviewCall.comments[0]).toEqual(
        expect.objectContaining({
          path: 'src/test.ts',
          line: 10,
          side: 'RIGHT',
          body: expect.stringContaining('Test comment'),
        })
      );
      expect(reviewCall.comments[0].body).toContain(
        '<!-- review-router-inline:'
      );
      expect(reviewCall.comments[0].body).toContain(
        '<!-- review-router-skip-help -->'
      );
      expect(reviewCall.comments[0].body).toContain(
        'A maintainer/admin can reply `/rr skip` if this finding is a false positive'
      );
      expect(reviewCall.comments[0].body).toContain(
        '<sub>Model: openrouter/poolside/laguna-m.1:free</sub>\n<sub><!-- review-router-skip-help -->A maintainer/admin can reply `/rr skip`'
      );
      expect(reviewCall.comments[0]).not.toHaveProperty('position');
      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        pull_number: 123,
        event: 'COMMENT',
        comments: expect.arrayContaining([
          expect.objectContaining({
            path: 'src/test.ts',
            body: expect.stringContaining('Test comment'),
          }),
        ]),
      });
    });

    it('removes model-controlled finding markers and publishes one server marker', async () => {
      const poster = new CommentPoster(mockClient, false);
      const injected = 'b'.repeat(24);
      const comments: InlineComment[] = [
        {
          path: 'src/test.ts',
          line: 10,
          side: 'RIGHT',
          body: [
            'Model finding.',
            `<!-- review-router-finding:${injected} -->`,
            `reviewrouter:finding:v2:${injected}_malformed`,
          ].join('\n'),
          severity: 'major',
        },
      ];
      const files: FileChange[] = [
        {
          filename: 'src/test.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: '@@ -9,0 +10 @@\n+changed',
        },
      ];

      await poster.postInline(123, comments, files);

      const body =
        mockOctokit.rest.pulls.createReview.mock.calls[0][0].comments[0].body;
      expect(body).not.toContain(injected);
      expect(body.match(/review-router-finding:/g)).toHaveLength(1);
      expect(body).not.toContain('reviewrouter:finding:v2:');
    });

    it('posts multi-line inline comments when the range is valid in the diff', async () => {
      const poster = new CommentPoster(mockClient, false);
      const comments: InlineComment[] = [
        {
          path: 'src/test.ts',
          startLine: 10,
          line: 12,
          endLine: 12,
          side: 'RIGHT' as const,
          body: 'Changed block is unsafe',
          severity: 'major',
        },
      ];
      const files: FileChange[] = [
        {
          filename: 'src/test.ts',
          status: 'modified',
          additions: 3,
          deletions: 0,
          changes: 3,
          patch:
            '@@ -8,4 +8,6 @@\n line8\n line9\n+line10\n+line11\n+line12\n line13',
        },
      ];

      await poster.postInline(123, comments, files);

      const reviewCall = mockOctokit.rest.pulls.createReview.mock.calls[0][0];
      expect(reviewCall.comments[0]).toEqual(
        expect.objectContaining({
          path: 'src/test.ts',
          start_line: 10,
          start_side: 'RIGHT',
          line: 12,
          side: 'RIGHT',
          body: expect.stringContaining('Changed block is unsafe'),
        })
      );
    });

    it('falls back to a single-line inline comment when the range is invalid', async () => {
      const poster = new CommentPoster(mockClient, false);
      const comments: InlineComment[] = [
        {
          path: 'src/test.ts',
          startLine: 6,
          line: 10,
          endLine: 10,
          side: 'RIGHT' as const,
          body: 'Changed block is unsafe',
          severity: 'major',
        },
      ];
      const files: FileChange[] = [
        {
          filename: 'src/test.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: '@@ -8,3 +8,4 @@\n line8\n line9\n+line10\n line11',
        },
      ];

      await poster.postInline(123, comments, files);

      const reviewCall = mockOctokit.rest.pulls.createReview.mock.calls[0][0];
      expect(reviewCall.comments[0]).toEqual(
        expect.objectContaining({
          path: 'src/test.ts',
          line: 10,
          side: 'RIGHT',
        })
      );
      expect(reviewCall.comments[0]).not.toHaveProperty('start_line');
      expect(reviewCall.comments[0]).not.toHaveProperty('start_side');
    });

    it('deletes stale PR-comment fallback after batch inline review succeeds', async () => {
      mockOctokit.rest.issues.listComments.mockResolvedValue({
        data: [
          {
            id: 77,
            body: '<!-- review-router-inline-fallback -->\n\nold fallback',
          },
        ],
      });

      const poster = new CommentPoster(mockClient, false);
      await poster.postInline(
        123,
        [
          {
            path: 'src/test.ts',
            line: 10,
            side: 'RIGHT' as const,
            body: '**🟡 Major - Test finding**\n\nBody',
            severity: 'major',
          },
        ],
        [
          {
            filename: 'src/test.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: '@@ -8,3 +8,4 @@\n line8\n line9\n+line10\n line11',
          },
        ]
      );

      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
      expect(mockOctokit.rest.issues.deleteComment).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        comment_id: 77,
      });
    });

    it('anchors inline comments to the most relevant nearby added line', async () => {
      const poster = new CommentPoster(mockClient, false);
      const comments: InlineComment[] = [
        {
          path: 'src/users.js',
          line: 9,
          side: 'RIGHT' as const,
          body: '**🔴 Critical - SQL injection**\n\nThe email value is inserted directly into the SQL string.',
        },
      ];
      const files: FileChange[] = [
        {
          filename: 'src/users.js',
          status: 'modified',
          additions: 5,
          deletions: 0,
          changes: 5,
          patch: [
            '@@ -5,3 +5,8 @@',
            '   }',
            '   return id;',
            ' }',
            '+',
            '+export async function findUserByEmail(db, email) {',
            "+  const rows = await db.query(`SELECT * FROM users WHERE email = '${email}' LIMIT 1`);",
            '+  return rows[0] || null;',
            '+}',
          ].join('\n'),
        },
      ];

      await poster.postInline(123, comments, files);

      const reviewCall = mockOctokit.rest.pulls.createReview.mock.calls[0][0];
      expect(reviewCall.comments[0]).toEqual(
        expect.objectContaining({
          path: 'src/users.js',
          line: 10,
        })
      );
    });

    it('skips duplicate inline comments after correcting the anchor line', async () => {
      mockOctokit.paginate.mockResolvedValue([
        {
          id: 1,
          user: { login: 'review-router-ai[bot]' },
          path: 'src/users.js',
          line: 10,
          body: '**🔴 Critical - SQL injection**\n\nThe email value is inserted directly into the SQL string.\n\n<!-- review-router-inline:legacy -->',
        },
      ]);

      const poster = new CommentPoster(mockClient, false);
      const comments: InlineComment[] = [
        {
          path: 'src/users.js',
          line: 9,
          side: 'RIGHT' as const,
          body: '**🔴 Critical - SQL injection**\n\nThe email value is inserted directly into the SQL string.',
        },
      ];
      const files: FileChange[] = [
        {
          filename: 'src/users.js',
          status: 'modified',
          additions: 5,
          deletions: 0,
          changes: 5,
          patch: [
            '@@ -5,3 +5,8 @@',
            '   }',
            '   return id;',
            ' }',
            '+',
            '+export async function findUserByEmail(db, email) {',
            "+  const rows = await db.query(`SELECT * FROM users WHERE email = '${email}' LIMIT 1`);",
            '+  return rows[0] || null;',
            '+}',
          ].join('\n'),
        },
      ];

      await poster.postInline(123, comments, files);

      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        'Skipping duplicate active inline comment at src/users.js:10'
      );
    });

    it('recognizes legacy AI Robot Review inline fingerprints for deduplication', async () => {
      mockOctokit.paginate.mockResolvedValue([
        {
          id: 1,
          user: { login: 'review-router-ai[bot]' },
          path: 'src/users.js',
          line: 10,
          body: '**🔴 Critical - SQL injection**\n\nThe email value is inserted directly into the SQL string.\n\n<!-- ai-robot-review-inline:0123456789abcdef -->',
        },
      ]);

      const poster = new CommentPoster(mockClient, false);
      const comments: InlineComment[] = [
        {
          path: 'src/users.js',
          line: 10,
          side: 'RIGHT' as const,
          body: '**🔴 Critical - SQL injection**\n\nThe email value is inserted directly into the SQL string.',
        },
      ];
      const files: FileChange[] = [
        {
          filename: 'src/users.js',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
          patch:
            "+  const rows = await db.query(`SELECT * FROM users WHERE email = '${email}' LIMIT 1`);",
        },
      ];

      await poster.postInline(123, comments, files);

      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
    });

    it('posts distinct v2 findings at the same location and severity', async () => {
      const existingBody =
        '**🟡 Major - Null cache entry crashes startup**\n\nDereferencing `cacheEntry` throws before the fallback runs.';
      mockOctokit.paginate.mockResolvedValue([
        {
          id: 1,
          user: { login: 'review-router-ai[bot]' },
          path: 'src/test.ts',
          line: 10,
          body: `${existingBody}\n\n${findingFingerprintMarker(
            findingFingerprintFromInlineComment('src/test.ts', 10, existingBody)
          )}`,
        },
      ]);

      const poster = new CommentPoster(mockClient, false);
      await poster.postInline(
        123,
        [
          {
            path: 'src/test.ts',
            line: 10,
            side: 'RIGHT',
            severity: 'major',
            body: '**🟡 Major - Audit export exhausts memory**\n\nLoading every audit row into one array can terminate the worker.',
          },
        ],
        [
          {
            filename: 'src/test.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: '@@ -9,0 +10 @@\n+changed',
          },
        ]
      );

      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
    });

    it('skips an exact v2 finding duplicate', async () => {
      const body =
        '**🟡 Major - Null cache entry crashes startup**\n\nDereferencing `cacheEntry` throws before the fallback runs.';
      mockOctokit.paginate.mockResolvedValue([
        {
          id: 1,
          user: { login: 'review-router-ai[bot]' },
          path: 'src/test.ts',
          line: 10,
          body: `${body}\n\n${findingFingerprintMarker(
            findingFingerprintFromInlineComment('src/test.ts', 10, body)
          )}`,
        },
      ]);

      const poster = new CommentPoster(mockClient, false);
      await poster.postInline(
        123,
        [
          {
            path: 'src/test.ts',
            line: 10,
            side: 'RIGHT',
            severity: 'major',
            body,
          },
        ],
        [
          {
            filename: 'src/test.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: '@@ -9,0 +10 @@\n+changed',
          },
        ]
      );

      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
    });

    it.each([
      ['an untrusted author', { login: 'mallory' }],
      ['a missing author', undefined],
    ])(
      'does not suppress a finding from a forged marker posted by %s',
      async (_label, user) => {
        const body =
          '**🟡 Major - Null cache entry crashes startup**\n\nDereferencing `cacheEntry` throws before the fallback runs.';
        mockOctokit.paginate.mockResolvedValue([
          {
            id: 1,
            user,
            path: 'src/test.ts',
            line: 10,
            body: `${body}\n\n${findingFingerprintMarker(
              findingFingerprintFromInlineComment('src/test.ts', 10, body)
            )}`,
          },
        ]);

        const poster = new CommentPoster(mockClient, false);
        await poster.postInline(
          123,
          [
            {
              path: 'src/test.ts',
              line: 10,
              side: 'RIGHT',
              severity: 'major',
              body,
            },
          ],
          [
            {
              filename: 'src/test.ts',
              status: 'modified',
              additions: 1,
              deletions: 0,
              changes: 1,
              patch: '@@ -9,0 +10 @@\n+changed',
            },
          ]
        );

        expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
      }
    );

    it('fails closed without mutation when trusted inline inventory cannot be loaded', async () => {
      mockOctokit.paginate.mockRejectedValue(new Error('inventory timeout'));
      const poster = new CommentPoster(mockClient, false);

      await expect(
        poster.postInline(
          123,
          [
            {
              path: 'src/test.ts',
              line: 10,
              side: 'RIGHT',
              severity: 'major',
              body: '**🟡 Major - Test finding**\n\nBody',
            },
          ],
          [
            {
              filename: 'src/test.ts',
              status: 'modified',
              additions: 1,
              deletions: 0,
              changes: 1,
              patch: '@@ -9,0 +10 @@\n+changed',
            },
          ]
        )
      ).rejects.toThrow(
        'Failed to load trusted inline comment inventory; refusing publication'
      );

      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
      expect(mockOctokit.rest.pulls.createReviewComment).not.toHaveBeenCalled();
      expectNoSharedIssueCommentAccess();
    });

    it('skips semantic duplicate inline comments after small line shifts and model rewrites', async () => {
      const existingBody = [
        '**🟡 Major - Deep links to hidden paid chats spin forever**',
        '',
        '**Severity:** 🟡 **Major** - should fix before merge; correctness risk.',
        '',
        'When `hidePaidFeaturesInfo` is true, this branch removes every inaccessible course from `courseItems`, so a direct chat link can keep waiting forever.',
      ].join('\n');
      mockOctokit.paginate.mockResolvedValue([
        {
          id: 1,
          user: { login: 'review-router-ai[bot]' },
          path: 'lib/app/chat/chats_page.dart',
          line: 52,
          body: `${existingBody}\n\n${findingFingerprintMarker(
            findingFingerprintFromInlineComment(
              'lib/app/chat/chats_page.dart',
              52,
              existingBody
            )
          )}`,
        },
      ]);

      const poster = new CommentPoster(mockClient, false);
      const comments: InlineComment[] = [
        {
          path: 'lib/app/chat/chats_page.dart',
          line: 54,
          side: 'RIGHT' as const,
          body: [
            '**🟡 Major - Direct links to hidden paid chats hang**',
            '',
            '**Severity:** 🟡 **Major** - should fix before merge; correctness risk.',
            '',
            'When `hidePaidFeaturesInfo` is true this branch removes every unavailable paid course from `courseItems`, so opening a direct chat link hangs.',
          ].join('\n'),
        },
      ];
      const files: FileChange[] = [
        {
          filename: 'lib/app/chat/chats_page.dart',
          status: 'modified',
          additions: 5,
          deletions: 0,
          changes: 5,
          patch: [
            '@@ -50,3 +50,8 @@',
            ' context line',
            '+final courseItems = courses.where((course) => course.available).toList();',
            '+if (hidePaidFeaturesInfo) {',
            '+  courseItems.removeWhere((course) => !course.isFree);',
            '+}',
            '+return courseItems;',
          ].join('\n'),
        },
      ];

      await poster.postInline(123, comments, files);

      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        'Skipping duplicate active inline comment at lib/app/chat/chats_page.dart:53'
      );
    });

    it('skips semantic duplicates when severity drifts between runs', async () => {
      mockOctokit.paginate.mockResolvedValue([
        {
          id: 1,
          user: { login: 'review-router-ai[bot]' },
          path: 'src/users.js',
          line: 6,
          body: [
            '**🔴 Critical - SQL injection in email lookup**',
            '',
            '**Severity:** 🔴 **Critical** - blocks merge; security risk.',
            '',
            'The changed query interpolates `email` directly into SQL, so a crafted email can alter the WHERE clause.',
            '',
            '<!-- review-router-inline:legacy -->',
          ].join('\n'),
        },
      ]);

      const poster = new CommentPoster(mockClient, false);
      const comments: InlineComment[] = [
        {
          path: 'src/users.js',
          line: 6,
          side: 'RIGHT' as const,
          body: [
            '**🟡 Major - SQL injection in email lookup**',
            '',
            '**Severity:** 🟡 **Major** - should fix before merge; correctness risk.',
            '',
            'The query interpolates `email` directly into SQL, allowing a crafted email to change the WHERE clause.',
          ].join('\n'),
        },
      ];
      const files: FileChange[] = [
        {
          filename: 'src/users.js',
          status: 'modified',
          additions: 1,
          deletions: 2,
          changes: 3,
          patch: [
            '@@ -3,8 +3,7 @@ function normalizeEmail(email) {',
            ' }',
            ' async function findUserByEmail(db, email) {',
            '-  const normalized = normalizeEmail(email);',
            "-  const rows = await db.query('SELECT * FROM users WHERE email = ? LIMIT 1', [normalized]);",
            "+  const rows = await db.query(`SELECT * FROM users WHERE email = '${email}' LIMIT 1`);",
            '   return rows[0] || null;',
          ].join('\n'),
        },
      ];

      await poster.postInline(123, comments, files);

      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        'Skipping duplicate active inline comment at src/users.js:5'
      );
    });

    it('does not treat outdated inline comments as active duplicates', async () => {
      mockOctokit.paginate.mockResolvedValue([
        {
          id: 1,
          user: { login: 'review-router-ai[bot]' },
          path: 'src/test.ts',
          line: null,
          original_line: 10,
          body: '**🟡 Major - SQL injection**\n\nUse parameterized queries.',
        },
      ]);

      const poster = new CommentPoster(mockClient, false);
      const comments: InlineComment[] = [
        {
          path: 'src/test.ts',
          line: 10,
          side: 'RIGHT' as const,
          body: '**🟡 Major - SQL injection**\n\nUse parameterized queries.',
        },
      ];
      const files: FileChange[] = [
        {
          filename: 'src/test.ts',
          status: 'modified',
          additions: 5,
          deletions: 2,
          changes: 7,
          patch: '@@ -8,3 +8,4 @@\n line8\n line9\n+line10\n line11',
        },
      ];

      await poster.postInline(123, comments, files);

      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
    });

    it('uses lifecycle GraphQL dedupe refs instead of REST comments when refs are provided', async () => {
      mockOctokit.paginate.mockResolvedValue([
        {
          id: 1,
          user: { login: 'review-router-ai[bot]' },
          path: 'src/test.ts',
          line: 10,
          body: '**🟡 Major - SQL injection**\n\nUse parameterized queries.',
        },
      ]);

      const poster = new CommentPoster(mockClient, false);
      const comments: InlineComment[] = [
        {
          path: 'src/test.ts',
          line: 10,
          side: 'RIGHT' as const,
          body: '**🟡 Major - SQL injection**\n\nUse parameterized queries.',
          severity: 'major',
        },
      ];
      const files: FileChange[] = [
        {
          filename: 'src/test.ts',
          status: 'modified',
          additions: 5,
          deletions: 2,
          changes: 7,
          patch: '@@ -8,3 +8,4 @@\n line8\n line9\n+line10\n line11',
        },
      ];

      await poster.postInline(123, comments, files, 'head-sha', []);

      expect(mockOctokit.paginate).not.toHaveBeenCalled();
      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({ commit_id: 'head-sha' })
      );
    });

    it('suppresses duplicates from trusted unresolved lifecycle dedupe refs', async () => {
      const poster = new CommentPoster(mockClient, false);
      const comments: InlineComment[] = [
        {
          path: 'src/test.ts',
          line: 10,
          side: 'RIGHT' as const,
          body: '**🟡 Major - SQL injection**\n\nUse parameterized queries.',
          severity: 'major',
        },
      ];
      const files: FileChange[] = [
        {
          filename: 'src/test.ts',
          status: 'modified',
          additions: 5,
          deletions: 2,
          changes: 7,
          patch: '@@ -8,3 +8,4 @@\n line8\n line9\n+line10\n line11',
        },
      ];

      await poster.postInline(123, comments, files, 'head-sha', [
        {
          path: 'src/test.ts',
          line: 10,
          body: '**🟡 Major - SQL injection**\n\nUse parameterized queries.',
        },
      ]);

      expect(mockOctokit.paginate).not.toHaveBeenCalled();
      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
    });

    it('falls back to a PR comment when GitHub rejects inline review creation with 422', async () => {
      const error = new Error(
        'Unprocessable Entity: "An internal error occurred, please try again."'
      ) as Error & { status: number };
      error.status = 422;
      mockOctokit.rest.pulls.createReview.mockRejectedValue(error);

      const poster = new CommentPoster(mockClient, false);
      const comments: InlineComment[] = [
        {
          path: 'src/test.ts',
          line: 10,
          side: 'RIGHT' as const,
          body: [
            '**🔴 Critical - Auth bypass**',
            '',
            'The changed lookup ignores the requested email.',
            '',
            '```suggestion',
            'return db.users.find((user) => user.email === email) || null;',
            '```',
          ].join('\n'),
          severity: 'critical',
        },
      ];
      const files: FileChange[] = [
        {
          filename: 'src/test.ts',
          status: 'modified',
          additions: 1,
          deletions: 1,
          changes: 2,
          patch: '@@ -8,3 +8,4 @@\n line8\n line9\n+line10\n line11',
        },
      ];

      await expect(
        poster.postInline(123, comments, files)
      ).resolves.toBeUndefined();

      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 123,
        body: expect.stringContaining('<!-- review-router-inline-fallback -->'),
      });
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('src/test.ts:10'),
        })
      );
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining(
            'Committable suggestion is only available on inline review comments'
          ),
        })
      );
    });

    it('retries individual inline comments before PR-comment fallback when head SHA is available', async () => {
      const error = new Error(
        'Unprocessable Entity: "An internal error occurred, please try again."'
      ) as Error & { status: number };
      error.status = 422;
      mockOctokit.rest.pulls.createReview.mockRejectedValue(error);

      const poster = new CommentPoster(mockClient, false);
      await poster.postInline(
        123,
        [
          {
            path: 'src/test.ts',
            line: 10,
            side: 'RIGHT' as const,
            body: '**🟡 Major - Test finding**\n\nBody',
            severity: 'major',
          },
        ],
        [
          {
            filename: 'src/test.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: '@@ -8,3 +8,4 @@\n line8\n line9\n+line10\n line11',
          },
        ],
        'head-sha'
      );

      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
      expect(mockOctokit.rest.pulls.createReviewComment).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        pull_number: 123,
        commit_id: 'head-sha',
        path: 'src/test.ts',
        line: 10,
        side: 'RIGHT',
        body: expect.stringContaining('Test finding'),
      });
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it('deletes stale PR-comment fallback after individual inline retry succeeds', async () => {
      const error = new Error(
        'Unprocessable Entity: "An internal error occurred, please try again."'
      ) as Error & { status: number };
      error.status = 422;
      mockOctokit.rest.pulls.createReview.mockRejectedValue(error);
      mockOctokit.rest.issues.listComments.mockResolvedValue({
        data: [
          {
            id: 88,
            body: '<!-- review-router-inline-fallback -->\n\nold fallback',
          },
        ],
      });

      const poster = new CommentPoster(mockClient, false);
      await poster.postInline(
        123,
        [
          {
            path: 'src/test.ts',
            line: 10,
            side: 'RIGHT' as const,
            body: '**🟡 Major - Test finding**\n\nBody',
            severity: 'major',
          },
        ],
        [
          {
            filename: 'src/test.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: '@@ -8,3 +8,4 @@\n line8\n line9\n+line10\n line11',
          },
        ],
        'head-sha'
      );

      expect(mockOctokit.rest.pulls.createReviewComment).toHaveBeenCalledTimes(
        1
      );
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.deleteComment).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        comment_id: 88,
      });
    });

    it('deletes stale PR-comment fallback when no current inline findings remain', async () => {
      mockOctokit.rest.issues.listComments.mockResolvedValue({
        data: [
          {
            id: 97,
            body: '<!-- review-router-inline-fallback -->\n\nold fallback',
          },
        ],
      });

      const poster = new CommentPoster(mockClient, false);
      await poster.postInline(123, [], []);

      expect(mockOctokit.rest.issues.deleteComment).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        comment_id: 97,
      });
      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it('does not inspect shared fallbacks for zero findings in strict inline-only mode', async () => {
      const poster = new CommentPoster(mockClient, false);

      await poster.postInline(123, [], [], 'head-sha', undefined, {
        mode: 'strict-inline-only',
      });

      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
      expectNoSharedIssueCommentAccess();
    });

    it('does not inspect shared fallbacks after a successful strict inline batch', async () => {
      const poster = new CommentPoster(mockClient, false);

      await poster.postInline(
        123,
        [
          {
            path: 'src/test.ts',
            line: 10,
            side: 'RIGHT',
            severity: 'major',
            body: '**🟡 Major - Test finding**\n\nBody',
          },
        ],
        [
          {
            filename: 'src/test.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: '@@ -9,0 +10 @@\n+changed',
          },
        ],
        'head-sha',
        undefined,
        { mode: 'strict-inline-only' }
      );

      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
      expectNoSharedIssueCommentAccess();
    });

    it('retries a rejected strict inline batch individually without shared fallback access', async () => {
      const error = new Error('Validation Failed') as Error & {
        status: number;
      };
      error.status = 422;
      mockOctokit.rest.pulls.createReview.mockRejectedValue(error);
      const poster = new CommentPoster(mockClient, false);

      await poster.postInline(
        123,
        [
          {
            path: 'src/test.ts',
            line: 10,
            side: 'RIGHT',
            severity: 'major',
            body: '**🟡 Major - Test finding**\n\nBody',
          },
        ],
        [
          {
            filename: 'src/test.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: '@@ -9,0 +10 @@\n+changed',
          },
        ],
        'head-sha',
        undefined,
        { mode: 'strict-inline-only' }
      );

      expect(mockOctokit.rest.pulls.createReviewComment).toHaveBeenCalledTimes(
        1
      );
      expectNoSharedIssueCommentAccess();
    });

    it('fails rejected strict individual publication without creating a shared fallback', async () => {
      const error = new Error('Validation Failed') as Error & {
        status: number;
      };
      error.status = 422;
      mockOctokit.rest.pulls.createReview.mockRejectedValue(error);
      mockOctokit.rest.pulls.createReviewComment.mockRejectedValue(error);
      const poster = new CommentPoster(mockClient, false);

      await expect(
        poster.postInline(
          123,
          [
            {
              path: 'src/test.ts',
              line: 10,
              side: 'RIGHT',
              severity: 'major',
              body: '**🟡 Major - Test finding**\n\nBody',
            },
          ],
          [
            {
              filename: 'src/test.ts',
              status: 'modified',
              additions: 1,
              deletions: 0,
              changes: 1,
              patch: '@@ -9,0 +10 @@\n+changed',
            },
          ],
          'head-sha',
          undefined,
          { mode: 'strict-inline-only' }
        )
      ).rejects.toThrow(
        'Strict inline-only publication left 1/1 finding(s) unpublished after GitHub rejected batch and individual inline comment APIs'
      );
      expect(mockOctokit.rest.pulls.createReviewComment).toHaveBeenCalledTimes(
        1
      );
      expectNoSharedIssueCommentAccess();
    });

    it.each([
      [
        'a 500 response',
        Object.assign(new Error('server failed'), { status: 500 }),
      ],
      ['a timeout', new Error('request timed out')],
    ])(
      'does not blindly retry or fallback after an ambiguous batch mutation result: %s',
      async (_label, error) => {
        mockOctokit.rest.pulls.createReview.mockRejectedValue(error);
        const poster = new CommentPoster(mockClient, false);

        await expect(
          poster.postInline(
            123,
            [
              {
                path: 'src/test.ts',
                line: 10,
                side: 'RIGHT',
                severity: 'major',
                body: '**🟡 Major - Test finding**\n\nBody',
              },
            ],
            [
              {
                filename: 'src/test.ts',
                status: 'modified',
                additions: 1,
                deletions: 0,
                changes: 1,
                patch: '@@ -9,0 +10 @@\n+changed',
              },
            ],
            'head-sha',
            undefined,
            { mode: 'strict-inline-only' }
          )
        ).rejects.toBe(error);

        expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
        expect(
          mockOctokit.rest.pulls.createReviewComment
        ).not.toHaveBeenCalled();
        expectNoSharedIssueCommentAccess();
      }
    );

    it('does not blindly retry or fallback after an ambiguous individual mutation result', async () => {
      const batchError = Object.assign(new Error('Validation Failed'), {
        status: 422,
      });
      const individualError = Object.assign(new Error('server failed'), {
        status: 500,
      });
      mockOctokit.rest.pulls.createReview.mockRejectedValue(batchError);
      mockOctokit.rest.pulls.createReviewComment.mockRejectedValue(
        individualError
      );
      const poster = new CommentPoster(mockClient, false);

      await expect(
        poster.postInline(
          123,
          [
            {
              path: 'src/test.ts',
              line: 10,
              side: 'RIGHT',
              severity: 'major',
              body: '**🟡 Major - Test finding**\n\nBody',
            },
          ],
          [
            {
              filename: 'src/test.ts',
              status: 'modified',
              additions: 1,
              deletions: 0,
              changes: 1,
              patch: '@@ -9,0 +10 @@\n+changed',
            },
          ],
          'head-sha',
          undefined,
          { mode: 'strict-inline-only' }
        )
      ).rejects.toBe(individualError);

      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
      expect(mockOctokit.rest.pulls.createReviewComment).toHaveBeenCalledTimes(
        1
      );
      expectNoSharedIssueCommentAccess();
    });

    it('retries individual inline comments without committable suggestion before PR-comment fallback', async () => {
      const batchError = new Error(
        'Unprocessable Entity: "An internal error occurred, please try again."'
      ) as Error & { status: number };
      batchError.status = 422;
      const suggestionError = new Error('Validation Failed') as Error & {
        status: number;
      };
      suggestionError.status = 422;
      mockOctokit.rest.pulls.createReview.mockRejectedValue(batchError);
      mockOctokit.rest.pulls.createReviewComment
        .mockRejectedValueOnce(suggestionError)
        .mockResolvedValueOnce({});

      const poster = new CommentPoster(mockClient, false);
      await poster.postInline(
        123,
        [
          {
            path: 'src/test.txt',
            line: 10,
            side: 'RIGHT' as const,
            body: [
              '**🔴 Critical - Auth bypass**',
              '',
              'The changed lookup ignores the requested email.',
              '',
              '<!-- suggestion_start -->',
              '',
              '```suggestion',
              '  return db.users.find((user) => user.email === email) || null;',
              '```',
              '',
              '<!-- suggestion_end -->',
            ].join('\n'),
            severity: 'critical',
          },
        ],
        [
          {
            filename: 'src/test.txt',
            status: 'modified',
            additions: 1,
            deletions: 1,
            changes: 2,
            patch: '@@ -8,3 +8,4 @@\n line8\n line9\n+line10\n line11',
          },
        ],
        'head-sha'
      );

      expect(mockOctokit.rest.pulls.createReviewComment).toHaveBeenCalledTimes(
        2
      );
      expect(
        mockOctokit.rest.pulls.createReviewComment.mock.calls[0][0].body
      ).toContain('```suggestion');
      expect(
        mockOctokit.rest.pulls.createReviewComment.mock.calls[1][0].body
      ).not.toContain('```suggestion');
      expect(
        mockOctokit.rest.pulls.createReviewComment.mock.calls[1][0].body
      ).toContain(
        'Committable suggestion omitted because GitHub rejected this inline suggestion block'
      );
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it('falls back only for individual inline comments that GitHub still rejects', async () => {
      const batchError = new Error(
        'Unprocessable Entity: "An internal error occurred, please try again."'
      ) as Error & { status: number };
      batchError.status = 422;
      const lineError = new Error('Validation Failed') as Error & {
        status: number;
      };
      lineError.status = 422;
      mockOctokit.rest.pulls.createReview.mockRejectedValue(batchError);
      mockOctokit.rest.pulls.createReviewComment
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(lineError)
        .mockRejectedValueOnce(lineError)
        .mockRejectedValueOnce(lineError);

      const poster = new CommentPoster(mockClient, false);
      await poster.postInline(
        123,
        [
          {
            path: 'src/one.ts',
            line: 10,
            side: 'RIGHT' as const,
            body: '**🟡 Major - First finding**\n\nBody',
            severity: 'major',
          },
          {
            path: 'src/two.ts',
            line: 20,
            side: 'RIGHT' as const,
            body: '**🟡 Major - Second finding**\n\nBody',
            severity: 'major',
          },
        ],
        [
          {
            filename: 'src/one.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: '@@ -8,3 +8,4 @@\n line8\n line9\n+line10\n line11',
          },
          {
            filename: 'src/two.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: '@@ -18,3 +18,4 @@\n line18\n line19\n+line20\n line21',
          },
        ],
        'head-sha'
      );

      expect(mockOctokit.rest.pulls.createReviewComment).toHaveBeenCalledTimes(
        2
      );
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('src/two.ts:20'),
        })
      );
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.not.stringContaining('src/one.ts:10'),
        })
      );
    });

    it('updates an existing inline fallback comment instead of duplicating it', async () => {
      const error = new Error('Validation Failed') as Error & {
        status: number;
      };
      error.status = 422;
      mockOctokit.rest.pulls.createReview.mockRejectedValue(error);
      mockOctokit.rest.issues.listComments.mockResolvedValue({
        data: [
          {
            id: 77,
            body: '<!-- review-router-inline-fallback -->\n\nold fallback',
          },
        ],
      });

      const poster = new CommentPoster(mockClient, false);
      await poster.postInline(
        123,
        [
          {
            path: 'src/test.ts',
            line: 10,
            side: 'RIGHT' as const,
            body: '**🟡 Major - Test finding**\n\nBody',
            severity: 'major',
          },
        ],
        [
          {
            filename: 'src/test.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: '@@ -8,3 +8,4 @@\n line8\n line9\n+line10\n line11',
          },
        ]
      );

      expect(mockOctokit.rest.issues.updateComment).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        comment_id: 77,
        body: expect.stringContaining('src/test.ts:10'),
      });
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it('does not fallback for non-review-position permission failures', async () => {
      const error = new Error(
        'Resource not accessible by integration'
      ) as Error & { status: number };
      error.status = 403;
      mockOctokit.rest.pulls.createReview.mockRejectedValue(error);

      const poster = new CommentPoster(mockClient, false);

      await expect(
        poster.postInline(
          123,
          [
            {
              path: 'src/test.ts',
              line: 10,
              side: 'RIGHT' as const,
              body: 'Test comment',
              severity: 'major',
            },
          ],
          [
            {
              filename: 'src/test.ts',
              status: 'modified',
              additions: 1,
              deletions: 0,
              changes: 1,
              patch: '@@ -8,3 +8,4 @@\n line8\n line9\n+line10\n line11',
            },
          ]
        )
      ).rejects.toThrow('Resource not accessible by integration');
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it('splits large comments into chunks', async () => {
      const poster = new CommentPoster(mockClient, false);
      const largeBody = 'x'.repeat(70000); // Exceeds MAX_COMMENT_SIZE

      await poster.postSummary(123, largeBody);

      // Should be called twice (chunked)
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(2);
    });
  });

  describe('Dry Run Mode', () => {
    it('does not post summary comment in dry run mode', async () => {
      const poster = new CommentPoster(mockClient, true);
      const body = 'Test summary';

      await poster.postSummary(123, body);

      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining(
          '[DRY RUN] Would post 1 summary comment(s) to PR #123'
        )
      );
    });

    it('does not post inline comments in dry run mode', async () => {
      const poster = new CommentPoster(mockClient, true);
      const comments: InlineComment[] = [
        {
          path: 'src/test.ts',
          line: 10,
          side: 'RIGHT' as const,
          body: 'Test comment',
        },
      ];
      const files: FileChange[] = [
        {
          filename: 'src/test.ts',
          status: 'modified',
          additions: 5,
          deletions: 2,
          changes: 7,
          patch: '@@ -8,3 +8,4 @@\n line8\n line9\n+line10\n line11',
        },
      ];

      await poster.postInline(123, comments, files);

      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('[DRY RUN] Would post')
      );
    });

    it('logs summary preview in dry run mode', async () => {
      const poster = new CommentPoster(mockClient, true);
      const body = 'Test summary with some content';

      await poster.postSummary(123, body);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('[DRY RUN] Summary comment 1:')
      );
    });

    it('logs inline comments preview in dry run mode', async () => {
      const poster = new CommentPoster(mockClient, true);
      const comments: InlineComment[] = [
        {
          path: 'src/test.ts',
          line: 10,
          side: 'RIGHT' as const,
          body: 'Test inline comment',
        },
      ];
      const files: FileChange[] = [
        {
          filename: 'src/test.ts',
          status: 'modified',
          additions: 5,
          deletions: 2,
          changes: 7,
          patch: '@@ -8,3 +8,4 @@\n line8\n line9\n+line10\n line11',
        },
      ];

      await poster.postInline(123, comments, files);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('[DRY RUN] Inline comment at src/test.ts')
      );
    });
  });

  describe('Edge Cases', () => {
    it('handles empty inline comments array', async () => {
      const poster = new CommentPoster(mockClient, false);

      await poster.postInline(123, [], []);

      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
    });

    it('skips inline comments without valid diff positions', async () => {
      const poster = new CommentPoster(mockClient, false);
      const comments: InlineComment[] = [
        {
          path: 'src/test.ts',
          line: 999, // Line not in patch
          side: 'RIGHT' as const,
          body: 'Test comment',
        },
      ];
      const files: FileChange[] = [
        {
          filename: 'src/test.ts',
          status: 'modified',
          additions: 5,
          deletions: 2,
          changes: 7,
          patch: '@@ -8,3 +8,4 @@\n line8\n line9\n+line10\n line11',
        },
      ];

      await poster.postInline(123, comments, files);

      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Cannot find diff position')
      );
    });
  });

  it('skips summary write when the PR head changed after review', async () => {
    mockOctokit.rest.pulls.get.mockResolvedValueOnce({
      data: { head: { sha: 'new-head' } },
    });
    const poster = new CommentPoster(mockClient, false);

    const result = await poster.postSummary(123, 'stale summary', true, {
      reviewedHeadSha: 'old-head',
      workflowRunId: '10',
      workflowRunAttempt: 1,
    });

    expect(result).toMatchObject({
      posted: false,
      skippedStale: true,
      reason: 'head_sha_changed',
    });
    expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(mockOctokit.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it('fails closed when the PR head cannot be verified before summary write', async () => {
    mockOctokit.rest.pulls.get.mockRejectedValueOnce(
      new Error('GitHub unavailable')
    );
    const poster = new CommentPoster(mockClient, false);

    const result = await poster.postSummary(123, 'summary', true, {
      reviewedHeadSha: 'head-sha',
    });

    expect(result).toMatchObject({
      posted: false,
      skippedStale: true,
      reason: 'head_unverifiable',
    });
    expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(mockOctokit.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it('does not publish inline findings when the head changes immediately before createReview', async () => {
    mockOctokit.rest.pulls.get
      .mockResolvedValueOnce({ data: { head: { sha: 'head-sha' } } })
      .mockResolvedValueOnce({ data: { head: { sha: 'new-head' } } });
    const poster = new CommentPoster(mockClient, false);

    await poster.postInline(
      123,
      [
        {
          path: 'src/test.ts',
          line: 10,
          side: 'RIGHT',
          body: 'Stale finding',
          severity: 'major',
        },
      ],
      [
        {
          filename: 'src/test.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: '@@ -9,1 +9,2 @@\n line9\n+line10',
        },
      ],
      'head-sha',
      []
    );

    expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
    expect(mockOctokit.rest.pulls.createReviewComment).not.toHaveBeenCalled();
    expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('does not delete summary comments when the head changes after listing', async () => {
    mockOctokit.rest.pulls.get
      .mockResolvedValueOnce({ data: { head: { sha: 'head-sha' } } })
      .mockResolvedValueOnce({ data: { head: { sha: 'new-head' } } });
    mockOctokit.rest.issues.listComments.mockResolvedValueOnce({
      data: [
        {
          id: 99,
          body: '<!-- review-router-bot -->\n\n# ReviewRouter\nold',
        },
      ],
    });
    const poster = new CommentPoster(mockClient, false);

    await poster.deleteSummaryComments(123, {
      reviewedHeadSha: 'head-sha',
    });

    expect(mockOctokit.rest.issues.deleteComment).not.toHaveBeenCalled();
  });

  it('skips replacing a newer same-head summary', async () => {
    const newerBody = appendReviewSummaryMetadata(
      '<!-- review-router-bot -->\n\n# ReviewRouter\nnewer',
      {
        reviewedHeadSha: 'head-sha',
        workflowRunId: '20',
        workflowRunAttempt: 1,
        summaryGeneratedAt: '2026-05-14T00:02:00Z',
      }
    );
    mockOctokit.rest.issues.listComments.mockResolvedValueOnce({
      data: [{ id: 99, body: newerBody }],
    });
    const poster = new CommentPoster(mockClient, false);

    const result = await poster.postSummary(123, 'older summary', true, {
      reviewedHeadSha: 'head-sha',
      workflowRunId: '10',
      workflowRunAttempt: 1,
      summaryGeneratedAt: '2026-05-14T00:01:00Z',
    });

    expect(result).toMatchObject({
      posted: false,
      skippedStale: true,
      reason: 'newer_summary_exists',
    });
    expect(mockOctokit.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('finds newer same-head summaries beyond the first issue-comment page', async () => {
    const newerBody = appendReviewSummaryMetadata(
      '<!-- review-router-bot -->\n\n# ReviewRouter\nnewer',
      {
        reviewedHeadSha: 'head-sha',
        workflowRunId: '20',
        workflowRunAttempt: 1,
        summaryGeneratedAt: '2026-05-14T00:02:00Z',
      }
    );
    mockOctokit.rest.issues.listComments
      .mockResolvedValueOnce({
        data: Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          body: 'unrelated',
        })),
      })
      .mockResolvedValueOnce({
        data: [{ id: 101, body: newerBody }],
      });
    const poster = new CommentPoster(mockClient, false);

    const result = await poster.postSummary(123, 'older summary', true, {
      reviewedHeadSha: 'head-sha',
      workflowRunId: '10',
      workflowRunAttempt: 1,
      summaryGeneratedAt: '2026-05-14T00:01:00Z',
    });

    expect(result).toMatchObject({
      posted: false,
      skippedStale: true,
      reason: 'newer_summary_exists',
    });
    expect(mockOctokit.rest.issues.listComments).toHaveBeenCalledTimes(2);
    expect(mockOctokit.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  describe('semantic escalation lineage', () => {
    const files: FileChange[] = [
      {
        filename: 'src/users.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: '@@ -9,2 +9,3 @@\n old\n+query(accountId)\n next',
      },
    ];
    const parentBody = [
      '**🟡 Major - SQL injection in account lookup**',
      '',
      'The query interpolates `accountId` directly into SQL and permits crafted input.',
    ].join('\n');
    const parent = (overrides: Record<string, unknown> = {}) => ({
      path: 'src/users.ts',
      line: 10,
      body: parentBody,
      parentCommentDatabaseId: 77,
      highestTrustedEscalationSeverity: 'major' as const,
      inventoryHeadSha: 'head-sha',
      ...overrides,
    });
    const finding = (
      severity: 'minor' | 'major' | 'critical',
      message = 'The query interpolates `accountId` directly into SQL and permits crafted input.'
    ): InlineComment => ({
      path: 'src/users.ts',
      line: 10,
      side: 'RIGHT',
      severity,
      body: [
        `**${severity === 'critical' ? '🔴 Critical' : severity === 'major' ? '🟡 Major' : '🔵 Minor'} - SQL injection in account lookup**`,
        '',
        message,
      ].join('\n'),
    });
    const restParentBody = parentBody
      .replace('🟡 Major', '🔵 Minor')
      .replace('Major -', 'Minor -');
    const restParent = {
      id: 77,
      path: 'src/users.ts',
      line: 10,
      original_line: 10,
      body: restParentBody,
      in_reply_to_id: null,
      user: { login: 'github-actions[bot]' },
    };

    it('posts Major to Critical as one reply and never a new review', async () => {
      const poster = new CommentPoster(mockClient, false);

      await poster.postInline(123, [finding('critical')], files, 'head-sha', [
        parent(),
      ]);

      expect(
        mockOctokit.rest.pulls.createReplyForReviewComment
      ).toHaveBeenCalledTimes(1);
      expect(
        mockOctokit.rest.pulls.createReplyForReviewComment
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          comment_id: 77,
          body: expect.stringContaining(
            '<!-- review-router-escalation:v2 parent_id=77 severity=critical alias_line=10 -->'
          ),
        })
      );
      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
    });

    it('uses the lifecycle-off REST inventory for one Minor to Major reply', async () => {
      mockOctokit.paginate.mockResolvedValueOnce([restParent]);
      const poster = new CommentPoster(mockClient, false);

      await poster.postInline(123, [finding('major')], files, 'head-sha');

      expect(
        mockOctokit.rest.pulls.createReplyForReviewComment
      ).toHaveBeenCalledTimes(1);
      expect(
        mockOctokit.rest.pulls.createReplyForReviewComment
      ).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 77 }));
      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
    });

    it('suppresses a lifecycle-off rerun already represented by a trusted reply', async () => {
      const replyFindingBody = finding('major').body;
      mockOctokit.paginate.mockResolvedValueOnce([
        restParent,
        {
          id: 78,
          body: `${replyFindingBody}\n\n<!-- review-router-escalation:v1 parent_id=77 severity=major -->`,
          in_reply_to_id: 77,
          user: { login: 'github-actions[bot]' },
        },
      ]);
      const poster = new CommentPoster(mockClient, false);

      await poster.postInline(123, [finding('major')], files, 'head-sha');

      expect(
        mockOctokit.rest.pulls.createReplyForReviewComment
      ).not.toHaveBeenCalled();
      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
    });

    it('routes a candidate matching only a trusted reply alias to its stable parent', async () => {
      const aliasBody = [
        '**🟡 Major - Unsafe account query bypasses tenant isolation**',
        '',
        'The `tenantScope` predicate is omitted while `loadAccount` reads the row.',
      ].join('\n');
      mockOctokit.paginate.mockResolvedValueOnce([
        restParent,
        {
          id: 78,
          body: `${aliasBody}\n\n<!-- review-router-escalation:v1 parent_id=77 severity=major -->`,
          in_reply_to_id: 77,
          user: { login: 'github-actions[bot]' },
        },
      ]);
      const poster = new CommentPoster(mockClient, false);

      await poster.postInline(
        123,
        [
          {
            ...finding('critical'),
            body: aliasBody.replace('🟡 Major', '🔴 Critical'),
          },
        ],
        files,
        'head-sha'
      );

      expect(
        mockOctokit.rest.pulls.createReplyForReviewComment
      ).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 77 }));
      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
    });

    it('uses the persisted v2 alias line when a later Critical matches only the moved reply', async () => {
      const movedFiles: FileChange[] = [
        {
          ...files[0],
          patch: '@@ -119,1 +119,2 @@\n old\n+query(accountId)',
        },
      ];
      const aliasBody = [
        '**🟡 Major - Staged credential cleanup removes the active key**',
        '',
        '`activateStagedKey` installs the key before `cleanupPairingPath` deletes the same file.',
      ].join('\n');
      const oldParent = parent({
        line: 100,
        body: '**🔵 Minor - Reset recovery can damage credentials**\n\nThe recovery order is unsafe.',
        highestTrustedEscalationSeverity: 'major',
        semanticAliases: [{ path: 'src/users.ts', line: 120, body: aliasBody }],
      });
      const poster = new CommentPoster(mockClient, false);

      await poster.postInline(
        123,
        [
          {
            path: 'src/users.ts',
            line: 120,
            side: 'RIGHT',
            severity: 'critical',
            body: aliasBody.replace('🟡 Major', '🔴 Critical'),
          },
        ],
        movedFiles,
        'head-sha',
        [oldParent]
      );

      expect(
        mockOctokit.rest.pulls.createReplyForReviewComment
      ).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 77 }));
      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
    });

    it('keeps same-run weaker alias evidence while publishing only the strongest body', async () => {
      const movedFiles: FileChange[] = [
        {
          ...files[0],
          patch: '@@ -119,1 +119,2 @@\n old\n+query(accountId)',
        },
      ];
      const oldParent = parent({
        line: 100,
        body: '**🔵 Minor - Staged credential path is deleted before activation**\n\n`stagedCredentialPath` is removed before activation completes.',
        highestTrustedEscalationSeverity: 'minor',
      });
      const weaker: InlineComment = {
        path: 'src/users.ts',
        line: 120,
        side: 'RIGHT',
        severity: 'major',
        body: '**🟡 Major - Staged credential cleanup loses key during activation**\n\n`stagedCredentialPath` is removed before activation completes. Cleanup then removes the activated key after recovery installs it.',
      };
      const strongest: InlineComment = {
        path: 'src/users.ts',
        line: 120,
        side: 'RIGHT',
        severity: 'critical',
        body: '**🔴 Critical - Staged credential cleanup loses active key**\n\nCleanup removes the activated key after recovery installs it.',
      };
      const poster = new CommentPoster(mockClient, false);

      expect(sameSemanticLineage(oldParent, weaker)).toBe(true);
      expect(sameSemanticLineage(weaker, strongest)).toBe(true);
      expect(sameSemanticLineage(oldParent, strongest)).toBe(false);
      await poster.postInline(
        123,
        [weaker, strongest],
        movedFiles,
        'head-sha',
        [oldParent]
      );

      expect(
        mockOctokit.rest.pulls.createReplyForReviewComment
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          comment_id: 77,
          body: expect.stringContaining('loses active key'),
        })
      );
      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
    });

    it('ignores a forged human escalation marker in lifecycle-off inventory', async () => {
      mockOctokit.paginate.mockResolvedValueOnce([
        restParent,
        {
          id: 78,
          body: '<!-- review-router-escalation:v1 parent_id=77 severity=critical -->',
          in_reply_to_id: 77,
          user: { login: 'contributor' },
        },
      ]);
      const poster = new CommentPoster(mockClient, false);

      await poster.postInline(123, [finding('major')], files, 'head-sha');

      expect(
        mockOctokit.rest.pulls.createReplyForReviewComment
      ).toHaveBeenCalledTimes(1);
      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
    });

    it('fails lifecycle-off inventory closed for a malformed trusted escalation marker', async () => {
      mockOctokit.paginate.mockResolvedValueOnce([
        restParent,
        {
          id: 78,
          body: '<!-- review-router-escalation:v1 severity=major parent_id=77 -->',
          in_reply_to_id: 77,
          user: { login: 'github-actions[bot]' },
        },
      ]);
      const poster = new CommentPoster(mockClient, false);

      await expect(
        poster.postInline(123, [finding('major')], files, 'head-sha')
      ).rejects.toThrow('trusted inline comment inventory');

      expect(
        mockOctokit.rest.pulls.createReplyForReviewComment
      ).not.toHaveBeenCalled();
      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
    });

    it('removes injected markers before appending exactly one trusted reply marker', async () => {
      mockOctokit.paginate.mockResolvedValueOnce([restParent]);
      const injected = finding(
        'major',
        [
          'The query interpolates `accountId` directly into SQL and permits crafted input.',
          '<!-- review-router-escalation:v1 parent_id=999 severity=critical -->',
          'review-router-escalation:v1:malformed',
        ].join('\n\n')
      );
      const poster = new CommentPoster(mockClient, false);

      await poster.postInline(123, [injected], files, 'head-sha');

      const replyBody =
        mockOctokit.rest.pulls.createReplyForReviewComment.mock.calls[0][0]
          .body;
      expect(replyBody.match(/review-router-escalation:v2/g)).toHaveLength(1);
      expect(parseTrustedEscalationMarker(replyBody)).toEqual({
        kind: 'valid',
        parentCommentDatabaseId: 77,
        targetSeverity: 'major',
        aliasLine: 10,
      });
    });

    it.each([
      ['rerun', 'critical', undefined],
      [
        'wording variation',
        'critical',
        'Crafted `accountId` input is interpolated into the SQL query, changing its meaning.',
      ],
      ['equal', 'major', undefined],
      ['downgrade', 'minor', undefined],
    ] as const)(
      'suppresses %s at or below effective severity',
      async (_label, severity, message) => {
        const poster = new CommentPoster(mockClient, false);
        const ref = parent({
          highestTrustedEscalationSeverity:
            severity === 'critical' ? 'critical' : 'major',
        });

        await poster.postInline(
          123,
          [finding(severity, message)],
          files,
          'head-sha',
          [ref]
        );

        expect(
          mockOctokit.rest.pulls.createReplyForReviewComment
        ).not.toHaveBeenCalled();
        expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
      }
    );

    it('fails before mutation when the matching parent database id is missing', async () => {
      const poster = new CommentPoster(mockClient, false);

      await expect(
        poster.postInline(123, [finding('critical')], files, 'head-sha', [
          parent({ parentCommentDatabaseId: undefined }),
        ])
      ).rejects.toThrow('parent review comment database id');

      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
      expect(
        mockOctokit.rest.pulls.createReplyForReviewComment
      ).not.toHaveBeenCalled();
    });

    it('calls reply exactly once and throws an ambiguous 500 without fallback', async () => {
      mockOctokit.rest.pulls.createReplyForReviewComment.mockRejectedValueOnce(
        Object.assign(new Error('server error'), { status: 500 })
      );
      const poster = new CommentPoster(mockClient, false);

      await expect(
        poster.postInline(123, [finding('critical')], files, 'head-sha', [
          parent(),
        ])
      ).rejects.toThrow('server error');

      expect(
        mockOctokit.rest.pulls.createReplyForReviewComment
      ).toHaveBeenCalledTimes(1);
      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it('coalesces two same-run escalation candidates to one maximum reply', async () => {
      const poster = new CommentPoster(mockClient, false);

      await poster.postInline(
        123,
        [
          finding('critical'),
          finding(
            'critical',
            'The SQL query directly interpolates crafted `accountId` input.'
          ),
        ],
        files,
        'head-sha',
        [parent()]
      );

      expect(
        mockOctokit.rest.pulls.createReplyForReviewComment
      ).toHaveBeenCalledTimes(1);
      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
    });

    it.each([
      ['ascending', ['minor', 'major', 'critical']],
      ['descending', ['critical', 'major', 'minor']],
    ] as const)(
      'coalesces %s same-run top-level candidates to one maximum-severity parent',
      async (_label, severities) => {
        const poster = new CommentPoster(mockClient, false);

        await poster.postInline(
          123,
          severities.map((severity) => finding(severity)),
          files,
          'head-sha'
        );

        expect(
          mockOctokit.rest.pulls.createReplyForReviewComment
        ).not.toHaveBeenCalled();
        expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
        const reviewComments =
          mockOctokit.rest.pulls.createReview.mock.calls[0][0].comments;
        expect(reviewComments).toHaveLength(1);
        expect(reviewComments[0].body).toContain('🔴 Critical');
      }
    );

    it('keeps an unrelated same-line finding as a top-level review comment', async () => {
      const poster = new CommentPoster(mockClient, false);
      const unrelated: InlineComment = {
        path: 'src/users.ts',
        line: 10,
        side: 'RIGHT',
        severity: 'critical',
        body: '**🔴 Critical - Authorization bypass**\n\nThe handler never checks the current tenant membership.',
      };

      await poster.postInline(123, [unrelated], files, 'head-sha', [parent()]);

      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
      expect(
        mockOctokit.rest.pulls.createReplyForReviewComment
      ).not.toHaveBeenCalled();
    });

    it('does not reuse a parent from a stale inventory', async () => {
      const poster = new CommentPoster(mockClient, false);

      await expect(
        poster.postInline(123, [finding('critical')], files, 'head-sha', [
          parent({ inventoryHeadSha: 'old-head' }),
        ])
      ).rejects.toThrow('stale review-thread inventory');

      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
      expect(
        mockOctokit.rest.pulls.createReplyForReviewComment
      ).not.toHaveBeenCalled();
    });

    it('keeps the oldest canonical parent while aggregating cluster maximum severity', async () => {
      const minorParent = parent({
        parentCommentDatabaseId: 76,
        body: parentBody.replace('Major', 'Minor').replace('🟡', '🔵'),
        highestTrustedEscalationSeverity: 'minor',
      });
      const poster = new CommentPoster(mockClient, false);

      await poster.postInline(123, [finding('major')], files, 'head-sha', [
        minorParent,
        parent(),
      ]);
      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();

      await poster.postInline(123, [finding('critical')], files, 'head-sha', [
        minorParent,
        parent(),
      ]);
      expect(
        mockOctokit.rest.pulls.createReplyForReviewComment
      ).toHaveBeenCalledTimes(1);
      expect(
        mockOctokit.rest.pulls.createReplyForReviewComment
      ).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 76 }));
    });

    it('suppresses through a lower-severity parent alias when its direct cluster already contains Major', async () => {
      const minorParent = parent({
        parentCommentDatabaseId: 76,
        line: 10,
        body: [
          '**🔵 Minor - Cache write can silently lose tenant data**',
          '',
          '`saveTenant` clears the pending record before the durable write completes.',
        ].join('\n'),
        highestTrustedEscalationSeverity: 'minor',
      });
      const majorDuplicate = parent({
        parentCommentDatabaseId: 77,
        line: 14,
        body: [
          '**🟡 Major - Cache write can silently lose account data**',
          '',
          '`saveAccount` clears the pending record before persistence completes.',
        ].join('\n'),
        highestTrustedEscalationSeverity: 'major',
      });
      const lowerAliasOnly: InlineComment = {
        path: 'src/users.ts',
        line: 6,
        side: 'RIGHT',
        severity: 'major',
        body: [
          '**🟡 Major - Tenant data is lost during cache save**',
          '',
          '`saveTenant` clears the pending record before the durable write completes.',
        ].join('\n'),
      };
      const poster = new CommentPoster(mockClient, false);

      expect(sameSemanticLineage(minorParent, majorDuplicate)).toBe(true);
      expect(sameSemanticLineage(minorParent, lowerAliasOnly)).toBe(true);
      expect(sameSemanticLineage(majorDuplicate, lowerAliasOnly)).toBe(false);

      await poster.postInline(123, [lowerAliasOnly], files, 'head-sha', [
        minorParent,
        majorDuplicate,
      ]);

      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
      expect(
        mockOctokit.rest.pulls.createReplyForReviewComment
      ).not.toHaveBeenCalled();
    });

    it('does not let an unrelated ambiguous parent bridge block the candidate shard', async () => {
      const alpha = parent({
        parentCommentDatabaseId: 76,
        line: 10,
        body: '**🟡 Major - Alpha beta gamma failure**\n\nA cache-key collision destroys the stored payload.',
      });
      const bridge = parent({
        parentCommentDatabaseId: 77,
        line: 14,
        body: '**🟡 Major - Alpha beta gamma delta epsilon zeta failure**\n\nA cache-key collision destroys the stored payload, while a missing permission lookup exposes tenant records.',
      });
      const zeta = parent({
        parentCommentDatabaseId: 78,
        line: 18,
        body: '**🟡 Major - Delta epsilon zeta failure**\n\nA missing permission lookup exposes tenant records.',
      });
      const poster = new CommentPoster(mockClient, false);

      expect(sameSemanticLineage(alpha, bridge)).toBe(true);
      expect(sameSemanticLineage(bridge, zeta)).toBe(true);
      expect(sameSemanticLineage(alpha, zeta)).toBe(false);
      await poster.postInline(123, [finding('minor')], files, 'head-sha', [
        alpha,
        bridge,
        zeta,
      ]);

      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
      expect(
        mockOctokit.rest.pulls.createReplyForReviewComment
      ).not.toHaveBeenCalled();
    });

    it('fails closed when the candidate intersects a transitive non-clique parent bridge', async () => {
      const alpha = parent({
        parentCommentDatabaseId: 76,
        line: 10,
        body: '**🟡 Major - Alpha beta gamma failure**\n\nA cache-key collision destroys the stored payload.',
      });
      const bridge = parent({
        parentCommentDatabaseId: 77,
        line: 14,
        body: '**🟡 Major - Alpha beta gamma delta epsilon zeta failure**\n\nA cache-key collision destroys the stored payload, while a missing permission lookup exposes tenant records.',
      });
      const zeta = parent({
        parentCommentDatabaseId: 78,
        line: 18,
        body: '**🟡 Major - Delta epsilon zeta failure**\n\nA missing permission lookup exposes tenant records.',
      });
      const candidate = {
        ...finding('critical'),
        body: bridge.body.replace('🟡 Major', '🔴 Critical'),
      };
      const poster = new CommentPoster(mockClient, false);

      await expect(
        poster.postInline(123, [candidate], files, 'head-sha', [
          alpha,
          bridge,
          zeta,
        ])
      ).rejects.toThrow('ambiguous parent bridge');

      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
      expect(
        mockOctokit.rest.pulls.createReplyForReviewComment
      ).not.toHaveBeenCalled();
    });

    it('suppresses an exact v2 finding fingerprint inside an ambiguous live-style component', async () => {
      const exactBody =
        '**🟡 Major - Delta epsilon zeta failure**\n\nA missing permission lookup exposes tenant records.';
      const exactFingerprint = findingFingerprintFromInlineComment(
        'src/users.ts',
        18,
        exactBody
      );
      const alpha = parent({
        parentCommentDatabaseId: 76,
        line: 10,
        body: '**🟡 Major - Alpha beta gamma failure**\n\nA cache-key collision destroys the stored payload.',
      });
      const bridge = parent({
        parentCommentDatabaseId: 77,
        line: 14,
        body: '**🟡 Major - Alpha beta gamma delta epsilon zeta failure**\n\nA cache-key collision destroys the stored payload, while a missing permission lookup exposes tenant records.',
      });
      const exactParent = parent({
        parentCommentDatabaseId: 78,
        line: 18,
        body: `${exactBody}\n\n${findingFingerprintMarker(exactFingerprint)}`,
      });
      const line18Files: FileChange[] = [
        {
          ...files[0],
          patch: '@@ -17,1 +17,2 @@\n old\n+query(accountId)',
        },
      ];
      const poster = new CommentPoster(mockClient, false);

      expect(sameSemanticLineage(alpha, bridge)).toBe(true);
      expect(sameSemanticLineage(bridge, exactParent)).toBe(true);
      expect(sameSemanticLineage(alpha, exactParent)).toBe(false);
      await poster.postInline(
        123,
        [
          {
            path: 'src/users.ts',
            line: 18,
            side: 'RIGHT',
            severity: 'major',
            body: exactBody,
          },
        ],
        line18Files,
        'head-sha',
        [alpha, bridge, exactParent]
      );

      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
      expect(
        mockOctokit.rest.pulls.createReplyForReviewComment
      ).not.toHaveBeenCalled();
    });

    it('fails closed when reply aliases overlap otherwise distinct parent components', async () => {
      const sharedAlias = [
        '**🟡 Major - Shared bridge wording**',
        '',
        '`bridgeToken` exposes the same reported symptom.',
      ].join('\n');
      const first = parent({
        parentCommentDatabaseId: 76,
        body: '**🟡 Major - Cache corruption**\n\n`cacheKey` overwrites stored data.',
        semanticAliases: [
          { path: 'src/users.ts', line: 10, body: sharedAlias },
        ],
      });
      const second = parent({
        parentCommentDatabaseId: 77,
        body: '**🟡 Major - Authorization bypass**\n\n`permissionSet` is never checked.',
        semanticAliases: [
          { path: 'src/users.ts', line: 10, body: sharedAlias },
        ],
      });
      const poster = new CommentPoster(mockClient, false);

      await expect(
        poster.postInline(
          123,
          [{ ...finding('critical'), body: sharedAlias }],
          files,
          'head-sha',
          [first, second]
        )
      ).rejects.toThrow('multiple active parent lineages');

      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
      expect(
        mockOctokit.rest.pulls.createReplyForReviewComment
      ).not.toHaveBeenCalled();
    });

    it('fails an escalation closed when matching parents are not one lineage cluster', async () => {
      const firstParent = parent({
        body: [
          '**🟡 Major - Alpha beta gamma failure**',
          '',
          'A cache-key collision destroys the stored payload.',
        ].join('\n'),
      });
      const secondParent = parent({
        parentCommentDatabaseId: 78,
        body: [
          '**🟡 Major - Delta epsilon zeta failure**',
          '',
          'A missing permission lookup exposes tenant records.',
        ].join('\n'),
      });
      const combined: InlineComment = {
        path: 'src/users.ts',
        line: 10,
        side: 'RIGHT',
        severity: 'critical',
        body: [
          '**🔴 Critical - Alpha beta gamma delta epsilon zeta failure**',
          '',
          'A cache-key collision destroys the stored payload, while a missing permission lookup exposes tenant records.',
        ].join('\n'),
      };
      const poster = new CommentPoster(mockClient, false);

      await expect(
        poster.postInline(123, [combined], files, 'head-sha', [
          firstParent,
          secondParent,
        ])
      ).rejects.toThrow('multiple active parent lineages');

      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
      expect(
        mockOctokit.rest.pulls.createReplyForReviewComment
      ).not.toHaveBeenCalled();
    });
  });
});
