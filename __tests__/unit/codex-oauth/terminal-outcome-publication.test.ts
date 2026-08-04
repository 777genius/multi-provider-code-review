import {
  TerminalOutcomePublicationUseCase,
  type CodexOAuthTerminalOutcomeCommitStatus,
  type CodexOAuthTerminalOutcomeReport,
  type TerminalOutcomePublicationGitHubPort,
} from '../../../src/codex-oauth/terminal-outcome-publication';

describe('TerminalOutcomePublicationUseCase', () => {
  it('keeps a deduped terminal outcome comment write-once while deleting duplicates', async () => {
    const github = fakeGitHub({
      comments: [
        {
          id: 101,
          body: legacyMaxChangedLinesSkipComment('b'.repeat(40)),
        },
        {
          id: 102,
          body: legacyMaxChangedLinesSkipComment('c'.repeat(40)),
        },
      ],
    });
    const logger = fakeLogger();
    const useCase = createUseCase(github, logger);

    await useCase.post(maxChangedLinesReport());

    expect(github.updatePullRequestComment).not.toHaveBeenCalled();
    expect(github.createPullRequestComment).not.toHaveBeenCalled();
    expect(github.deletePullRequestComment).toHaveBeenCalledWith({
      repository: 'Padelapp-Club/monitoring-service',
      commentId: 102,
    });
    expect(github.createCommitStatus).toHaveBeenCalledWith({
      repository: 'Padelapp-Club/monitoring-service',
      headSha: 'a'.repeat(40),
      status: maxChangedLinesReport().commitStatus,
    });
    expect(logger.info).toHaveBeenCalledWith(
      'ReviewRouter terminal outcome comment already exists for max_changed_lines_exceeded; keeping the first comment unchanged.'
    );
  });

  it('creates the first deduped terminal outcome comment', async () => {
    const github = fakeGitHub({ comments: [] });
    const useCase = createUseCase(github);

    await useCase.post(maxChangedLinesReport());

    expect(github.createPullRequestComment).toHaveBeenCalledWith({
      repository: 'Padelapp-Club/monitoring-service',
      pullRequestNumber: 1,
      body: maxChangedLinesReport().body,
    });
    expect(github.updatePullRequestComment).not.toHaveBeenCalled();
    expect(github.deletePullRequestComment).not.toHaveBeenCalled();
  });

  it('replaces conflicting terminal outcomes for the same revision', async () => {
    const headSha = 'a'.repeat(40);
    const github = fakeGitHub({
      comments: [
        {
          id: 111,
          body: `<!-- reviewrouter:codex-oauth:terminal:${headSha}:revision-unavailable -->`,
        },
        {
          id: 112,
          body: `<!-- reviewrouter:codex-oauth:terminal:${headSha}:partial -->`,
        },
      ],
    });
    const useCase = createUseCase(github);
    const report = revisionFailedReport(headSha);

    await useCase.post(report);

    expect(github.updatePullRequestComment).toHaveBeenCalledWith({
      repository: 'Padelapp-Club/monitoring-service',
      commentId: 111,
      body: report.body,
    });
    expect(github.deletePullRequestComment).toHaveBeenCalledWith({
      repository: 'Padelapp-Club/monitoring-service',
      commentId: 112,
    });
    expect(github.createPullRequestComment).not.toHaveBeenCalled();
  });

  it('clears only terminal outcome comments after a completed review', async () => {
    const github = fakeGitHub({
      comments: [
        { id: 201, body: '<!-- reviewrouter:codex-oauth:terminal:abc -->' },
        { id: 202, body: '<!-- reviewrouter:summary:v2:abc -->' },
        { id: 203, body: '<!-- reviewrouter:codex-oauth:terminal:def -->' },
      ],
    });
    const useCase = createUseCase(github);

    await useCase.clear({ reason: 'review_completed' });

    expect(github.deletePullRequestComment).toHaveBeenCalledTimes(2);
    expect(github.deletePullRequestComment).toHaveBeenNthCalledWith(1, {
      repository: 'Padelapp-Club/monitoring-service',
      commentId: 201,
    });
    expect(github.deletePullRequestComment).toHaveBeenNthCalledWith(2, {
      repository: 'Padelapp-Club/monitoring-service',
      commentId: 203,
    });
  });

  it('does not fail the publication use-case when commit status creation fails', async () => {
    const github = fakeGitHub({
      comments: [],
      createCommitStatus: jest.fn(async () => {
        throw new Error('ghs_secret_token failed');
      }),
    });
    const logger = fakeLogger();
    const useCase = createUseCase(github, logger);

    await expect(useCase.status(completedStatus())).resolves.toBeUndefined();

    expect(logger.warning).toHaveBeenCalledWith(
      'ReviewRouter could not publish terminal commit status: [redacted-github-token] failed'
    );
  });
});

function createUseCase(
  github: TerminalOutcomePublicationGitHubPort,
  logger = fakeLogger()
): TerminalOutcomePublicationUseCase {
  return new TerminalOutcomePublicationUseCase({
    context: {
      repository: 'Padelapp-Club/monitoring-service',
      pullRequestNumber: 1,
      headSha: 'a'.repeat(40),
    },
    github,
    logger,
  });
}

function fakeGitHub(input: {
  readonly comments: readonly { readonly id: number; readonly body: string }[];
  readonly createCommitStatus?: jest.Mock;
}): jest.Mocked<TerminalOutcomePublicationGitHubPort> {
  const github = {
    listPullRequestComments: jest.fn(async () => input.comments),
    createPullRequestComment: jest.fn(async () => undefined),
    updatePullRequestComment: jest.fn(async () => undefined),
    deletePullRequestComment: jest.fn(async () => undefined),
    createCommitStatus:
      input.createCommitStatus ?? jest.fn(async () => undefined),
  };
  return github as unknown as jest.Mocked<TerminalOutcomePublicationGitHubPort>;
}

function fakeLogger() {
  return {
    info: jest.fn(),
    warning: jest.fn(),
  };
}

function maxChangedLinesReport(): CodexOAuthTerminalOutcomeReport {
  return {
    marker:
      '<!-- reviewrouter:codex-oauth:terminal:max-changed-lines-exceeded -->',
    dedupeKey: 'max_changed_lines_exceeded',
    body: [
      '<!-- reviewrouter:codex-oauth:terminal:max-changed-lines-exceeded -->',
      '',
      '## Review skipped',
      '',
      'ReviewRouter did not start a model review for this revision because the PR is larger than the configured safety limit.',
    ].join('\n'),
    stepSummary: 'Review skipped',
    logLabel: 'skipped',
    commitStatus: {
      state: 'failure',
      description: 'Review skipped: PR exceeds configured safety limit.',
      context: 'ReviewRouter',
    },
  };
}

function completedStatus(): CodexOAuthTerminalOutcomeCommitStatus {
  return {
    state: 'success',
    description: 'Review completed.',
    context: 'ReviewRouter',
  };
}

function revisionFailedReport(
  headSha: string
): CodexOAuthTerminalOutcomeReport {
  const marker = `<!-- reviewrouter:codex-oauth:terminal:${headSha}:revision-failed -->`;
  return {
    marker,
    body: `${marker}\n\n## Review failed`,
    stepSummary: 'Review failed',
    logLabel: 'revision-failed',
    commitStatus: {
      state: 'error',
      description: 'Review failed: repository revision could not be verified.',
      context: 'ReviewRouter',
    },
  };
}

function legacyMaxChangedLinesSkipComment(headSha: string): string {
  return [
    `<!-- reviewrouter:codex-oauth:terminal:${headSha}:skipped -->`,
    '',
    '## Review skipped',
    '',
    'ReviewRouter did not start a model review for this revision because the PR is larger than the configured safety limit.',
    '',
    '| Field | Value |',
    '|---|---|',
    '| Changed lines | 382,374 |',
    '| Configured limit | 250,000 |',
    '| Model calls | 0 |',
  ].join('\n');
}
