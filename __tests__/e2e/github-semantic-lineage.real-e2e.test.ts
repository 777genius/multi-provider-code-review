import { GitHubClient } from '../../src/github/client';
import {
  extractFindingFingerprint,
  extractInlineSeverity,
  findingFingerprintFromInlineComment,
  parseTrustedEscalationMarker,
  REVIEW_ROUTER_ESCALATION_MARKER_V2,
} from '../../src/github/comment-fingerprint';
import { CommentPoster } from '../../src/github/comment-poster';
import { FileChange, InlineComment } from '../../src/types';

const runSemanticLineageE2E =
  process.env.RUN_GITHUB_SEMANTIC_LINEAGE_E2E === '1';

const fixtureRepository = '777genius/rr-codex-rotating-e2e';
const fixtureBranch = 'test/semantic-lineage-e2e-fixture';
const targetPath = 'src/semantic-lineage-target.ts';
const targetLine = 3;

describe('GitHub semantic finding lineage real e2e', () => {
  (runSemanticLineageE2E ? it : it.skip)(
    'keeps one immutable parent and one idempotent escalation reply',
    async () => {
      const token = process.env.GITHUB_TOKEN;
      const repository = process.env.GITHUB_REPOSITORY;
      const prNumber = Number(
        process.env.GITHUB_SEMANTIC_LINEAGE_E2E_PR_NUMBER
      );
      const headSha = process.env.GITHUB_SEMANTIC_LINEAGE_E2E_HEAD_SHA;
      const phase = process.env.GITHUB_SEMANTIC_LINEAGE_E2E_PHASE;

      if (
        !token ||
        repository !== fixtureRepository ||
        !Number.isInteger(prNumber) ||
        !headSha ||
        (phase !== 'clean' && phase !== 'rerun') ||
        process.env.REVIEW_THREAD_LIFECYCLE !== 'off'
      ) {
        throw new Error(
          'The semantic lineage E2E requires the allowlisted repository, token, PR, head, clean|rerun phase, and lifecycle=off'
        );
      }

      const client = new GitHubClient(token);
      const pull = await client.octokit.rest.pulls.get({
        owner: client.owner,
        repo: client.repo,
        pull_number: prNumber,
      });
      if (
        pull.data.state !== 'open' ||
        !pull.data.draft ||
        pull.data.head.sha !== headSha ||
        pull.data.head.ref !== fixtureBranch ||
        pull.data.head.repo?.full_name !== fixtureRepository
      ) {
        throw new Error(
          'The semantic lineage E2E only mutates the expected open disposable draft PR at its exact head'
        );
      }

      const filesResponse = await client.octokit.rest.pulls.listFiles({
        owner: client.owner,
        repo: client.repo,
        pull_number: prNumber,
        per_page: 100,
      });
      const targetFile = filesResponse.data.find(
        (file: { filename: string }) => file.filename === targetPath
      );
      if (!targetFile?.patch) {
        throw new Error(`${targetPath} patch was not available`);
      }

      const files: FileChange[] = [
        {
          filename: targetFile.filename,
          status: targetFile.status as FileChange['status'],
          additions: targetFile.additions,
          deletions: targetFile.deletions,
          changes: targetFile.changes,
          patch: targetFile.patch,
        },
      ];
      const fixtureMarker = `Semantic lineage E2E ${headSha.slice(0, 12)} retry cursor`;
      const minor: InlineComment = {
        path: targetPath,
        line: targetLine,
        side: 'RIGHT',
        severity: 'minor',
        body: [
          `**🔵 Minor - ${fixtureMarker} advances after failed persistence**`,
          '',
          'When `persistRetryState` returns false, `retryCursor` is still advanced. Keep the cursor unchanged so a retry cannot skip pending work.',
        ].join('\n'),
      };
      const major: InlineComment = {
        path: targetPath,
        line: targetLine,
        side: 'RIGHT',
        severity: 'major',
        body: [
          `**🟡 Major - ${fixtureMarker} must wait for durable persistence**`,
          '',
          'Do not advance `retryCursor` when `persistRetryState` fails. Otherwise the next retry skips pending work and can lose the operation.',
        ].join('\n'),
      };
      const expectedMinorFingerprint = findingFingerprintFromInlineComment(
        minor.path,
        minor.line,
        minor.body
      );
      const expectedMajorFingerprint = findingFingerprintFromInlineComment(
        major.path,
        major.line,
        major.body
      );
      const poster = new CommentPoster(client);
      const strictInlineOnly = { mode: 'strict-inline-only' } as const;

      const initial = await loadFixtureComments(
        client,
        prNumber,
        fixtureMarker,
        headSha
      );
      const initialState = assertFixtureState(
        initial,
        phase === 'clean' ? 0 : 1,
        phase === 'clean' ? 0 : 1,
        expectedMinorFingerprint,
        expectedMajorFingerprint
      );

      await poster.postInline(
        prNumber,
        [minor],
        files,
        headSha,
        undefined,
        strictInlineOnly
      );

      const afterMinor = await waitForFixtureState(
        client,
        prNumber,
        fixtureMarker,
        headSha,
        1,
        phase === 'clean' ? 0 : 1,
        expectedMinorFingerprint,
        expectedMajorFingerprint
      );
      const immutableParentBody = afterMinor.parents[0].body;

      await poster.postInline(
        prNumber,
        [major],
        files,
        headSha,
        undefined,
        strictInlineOnly
      );
      await waitForFixtureState(
        client,
        prNumber,
        fixtureMarker,
        headSha,
        1,
        1,
        expectedMinorFingerprint,
        expectedMajorFingerprint
      );

      await poster.postInline(
        prNumber,
        [major],
        files,
        headSha,
        undefined,
        strictInlineOnly
      );
      const finalState = await waitForFixtureState(
        client,
        prNumber,
        fixtureMarker,
        headSha,
        1,
        1,
        expectedMinorFingerprint,
        expectedMajorFingerprint
      );

      expect(finalState.parents[0].body).toBe(immutableParentBody);
      expect(finalState.replies[0].in_reply_to_id).toBe(
        finalState.parents[0].id
      );
      expect(
        finalState.replies[0].body?.match(
          new RegExp(REVIEW_ROUTER_ESCALATION_MARKER_V2, 'g')
        )
      ).toHaveLength(1);
      expect(
        parseTrustedEscalationMarker(finalState.replies[0].body)
      ).toMatchObject({
        kind: 'valid',
        parentCommentDatabaseId: finalState.parents[0].id,
        targetSeverity: 'major',
        aliasLine: targetLine,
      });
      if (phase === 'rerun') {
        expect(finalState.parents[0].id).toBe(initialState.parents[0].id);
        expect(finalState.replies[0].id).toBe(initialState.replies[0].id);
        expect(finalState.replies[0].body).toBe(initialState.replies[0].body);
      }
    },
    60000
  );
});

type FixtureComments = Awaited<ReturnType<typeof loadFixtureComments>>;

function assertFixtureState(
  comments: FixtureComments,
  expectedParents: number,
  expectedReplies: number,
  expectedMinorFingerprint: string,
  expectedMajorFingerprint: string
) {
  const parents = comments.filter((comment) => comment.in_reply_to_id == null);
  const replies = comments.filter((comment) => comment.in_reply_to_id != null);
  expect(parents).toHaveLength(expectedParents);
  expect(replies).toHaveLength(expectedReplies);
  if (parents[0]) {
    expect(parents[0].line).toBe(targetLine);
    expect(extractInlineSeverity(parents[0].body ?? '')).toBe('minor');
    expect(extractFindingFingerprint(parents[0].body)).toBe(
      expectedMinorFingerprint
    );
  }
  if (replies[0]) {
    expect(extractInlineSeverity(replies[0].body ?? '')).toBe('major');
    expect(extractFindingFingerprint(replies[0].body)).toBe(
      expectedMajorFingerprint
    );
  }
  return { parents, replies };
}

async function waitForFixtureState(
  client: GitHubClient,
  prNumber: number,
  fixtureMarker: string,
  headSha: string,
  expectedParents: number,
  expectedReplies: number,
  expectedMinorFingerprint: string,
  expectedMajorFingerprint: string
) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const comments = await loadFixtureComments(
      client,
      prNumber,
      fixtureMarker,
      headSha
    );
    const parentCount = comments.filter(
      (comment) => comment.in_reply_to_id == null
    ).length;
    const replyCount = comments.length - parentCount;
    if (parentCount > expectedParents || replyCount > expectedReplies) {
      throw new Error(
        `Semantic lineage E2E observed duplicate publication (${parentCount} parents, ${replyCount} replies)`
      );
    }
    if (parentCount === expectedParents && replyCount === expectedReplies) {
      return assertFixtureState(
        comments,
        expectedParents,
        expectedReplies,
        expectedMinorFingerprint,
        expectedMajorFingerprint
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Timed out waiting for the expected GitHub comment state');
}

async function loadFixtureComments(
  client: GitHubClient,
  prNumber: number,
  fixtureMarker: string,
  headSha: string
) {
  const comments = await client.octokit.paginate(
    client.octokit.rest.pulls.listReviewComments,
    {
      owner: client.owner,
      repo: client.repo,
      pull_number: prNumber,
      per_page: 100,
    }
  );
  return comments.filter(
    (comment) =>
      comment.body?.includes(fixtureMarker) &&
      comment.user?.login === 'github-actions[bot]' &&
      comment.path === targetPath &&
      comment.commit_id === headSha
  );
}
