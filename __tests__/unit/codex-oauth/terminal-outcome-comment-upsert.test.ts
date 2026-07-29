import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCodexOAuthRotatingRuntime } from '../../../src/codex-oauth/runtime';
import { runCodexOAuthRotatingAction } from '../../../src/codex-oauth/action';

jest.mock('../../../src/codex-oauth/runtime', () => ({
  ...jest.requireActual('../../../src/codex-oauth/runtime'),
  runCodexOAuthRotatingRuntime: jest.fn(),
}));

const mockGitHubClientConstructor = jest.fn();
let mockGitHubClientInstance: {
  owner: string;
  repo: string;
  octokit: {
    paginate: jest.Mock;
    rest: {
      issues: {
        listComments: jest.Mock;
        updateComment: jest.Mock;
        createComment: jest.Mock;
        deleteComment: jest.Mock;
      };
      repos: {
        createCommitStatus: jest.Mock;
      };
    };
  };
};

jest.mock('../../../src/github/client', () => ({
  GitHubClient: jest.fn((token: string) => {
    mockGitHubClientConstructor(token);
    return mockGitHubClientInstance;
  }),
}));

const mockedRuntime = runCodexOAuthRotatingRuntime as jest.MockedFunction<
  typeof runCodexOAuthRotatingRuntime
>;

describe('Codex OAuth terminal outcome comment upsert', () => {
  const originalEnv = process.env;
  let tempDir: string;
  let eventPath: string;
  let outputPath: string;
  let stepSummaryPath: string;

  beforeEach(() => {
    process.exitCode = undefined;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-terminal-upsert-'));
    eventPath = path.join(tempDir, 'event.json');
    outputPath = path.join(tempDir, 'output');
    stepSummaryPath = path.join(tempDir, 'step-summary.md');
    mockGitHubClientConstructor.mockReset();
    mockedRuntime.mockReset();
    mockedRuntime.mockResolvedValue({
      status: 'skipped',
      reason: 'max_changed_lines_exceeded',
      changedLines: 382_374,
      maxChangedLines: 250_000,
      decisionHash: 'a'.repeat(64),
    });
    mockGitHubClientInstance = {
      owner: 'Padelapp-Club',
      repo: 'monitoring-service',
      octokit: {
        paginate: jest.fn(async () => [
          {
            id: 101,
            body: legacyMaxChangedLinesSkipComment('b'.repeat(40)),
          },
          {
            id: 102,
            body: legacyMaxChangedLinesSkipComment('c'.repeat(40)),
          },
        ]),
        rest: {
          issues: {
            listComments: jest.fn(),
            updateComment: jest.fn(async () => ({})),
            createComment: jest.fn(async () => ({})),
            deleteComment: jest.fn(async () => ({})),
          },
          repos: {
            createCommitStatus: jest.fn(async () => ({})),
          },
        },
      },
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
    process.exitCode = undefined;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('keeps the first oversized skip comment unchanged instead of posting again', async () => {
    const fetchImpl = jest.fn(async (url, init) => {
      const urlText = String(url);
      if (urlText.startsWith('https://oidc.actions.example/token')) {
        expect((init?.headers as Record<string, string>).authorization).toBe(
          'Bearer runner-oidc-request-token'
        );
        return jsonResponse({ value: 'runner-oidc-token' });
      }
      if (
        urlText ===
        'https://api.reviewrouter.site/api/action/v1/session/exchange'
      ) {
        return jsonResponse({
          protocolVersion: 1,
          sessionToken: 'action-session-token',
        });
      }
      if (
        urlText === 'https://api.reviewrouter.site/api/action/v1/comment-token'
      ) {
        return jsonResponse({
          protocolVersion: 1,
          token: 'comment-token',
          expiresAt: '2026-07-29T10:00:00.000Z',
          repository: 'Padelapp-Club/monitoring-service',
        });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    process.env = {
      ...actionEnv({
        eventPath,
        outputPath,
        headRef: 'feature/huge-pr',
      }),
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.actions.example/token',
      GITHUB_STEP_SUMMARY: stepSummaryPath,
      GITHUB_RUN_ID: '123456',
      GITHUB_SERVER_URL: 'https://github.example.com',
    };

    await runCodexOAuthRotatingAction({ fetchImpl });

    expect(process.exitCode).toBeUndefined();
    expect(mockGitHubClientConstructor).toHaveBeenCalledWith('comment-token');
    expect(
      mockGitHubClientInstance.octokit.rest.issues.updateComment
    ).not.toHaveBeenCalled();
    expect(
      mockGitHubClientInstance.octokit.rest.issues.createComment
    ).not.toHaveBeenCalled();
    expect(
      mockGitHubClientInstance.octokit.rest.issues.deleteComment
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'Padelapp-Club',
        repo: 'monitoring-service',
        comment_id: 102,
      })
    );
    expect(
      mockGitHubClientInstance.octokit.rest.repos.createCommitStatus
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'Padelapp-Club',
        repo: 'monitoring-service',
        sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        state: 'failure',
        context: 'ReviewRouter',
        description: 'Review skipped: PR exceeds configured safety limit.',
      })
    );
  });

  it('creates the oversized skip comment on the first occurrence', async () => {
    mockGitHubClientInstance.octokit.paginate.mockResolvedValueOnce([]);
    const fetchImpl = jest.fn(async (url, init) => {
      const urlText = String(url);
      if (urlText.startsWith('https://oidc.actions.example/token')) {
        expect((init?.headers as Record<string, string>).authorization).toBe(
          'Bearer runner-oidc-request-token'
        );
        return jsonResponse({ value: 'runner-oidc-token' });
      }
      if (
        urlText ===
        'https://api.reviewrouter.site/api/action/v1/session/exchange'
      ) {
        return jsonResponse({
          protocolVersion: 1,
          sessionToken: 'action-session-token',
        });
      }
      if (
        urlText === 'https://api.reviewrouter.site/api/action/v1/comment-token'
      ) {
        return jsonResponse({
          protocolVersion: 1,
          token: 'comment-token',
          expiresAt: '2026-07-29T10:00:00.000Z',
          repository: 'Padelapp-Club/monitoring-service',
        });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    process.env = {
      ...actionEnv({
        eventPath,
        outputPath,
        headRef: 'feature/huge-pr',
      }),
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.actions.example/token',
      GITHUB_STEP_SUMMARY: stepSummaryPath,
      GITHUB_RUN_ID: '123456',
      GITHUB_SERVER_URL: 'https://github.example.com',
    };

    await runCodexOAuthRotatingAction({ fetchImpl });

    expect(
      mockGitHubClientInstance.octokit.rest.issues.createComment
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'Padelapp-Club',
        repo: 'monitoring-service',
        issue_number: 1,
        body: expect.stringContaining(
          '<!-- reviewrouter:codex-oauth:terminal:max-changed-lines-exceeded -->'
        ),
      })
    );
    expect(
      mockGitHubClientInstance.octokit.rest.issues.updateComment
    ).not.toHaveBeenCalled();
    expect(
      mockGitHubClientInstance.octokit.rest.issues.deleteComment
    ).not.toHaveBeenCalled();
  });
});

function actionEnv(input: {
  readonly eventPath: string;
  readonly outputPath: string;
  readonly headRef: string;
}): NodeJS.ProcessEnv {
  fs.writeFileSync(
    input.eventPath,
    JSON.stringify({
      repository: { full_name: 'Padelapp-Club/monitoring-service' },
      pull_request: {
        number: 1,
        head: {
          ref: input.headRef,
          repo: { full_name: 'Padelapp-Club/monitoring-service' },
          sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      },
    })
  );

  return {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: input.eventPath,
    GITHUB_OUTPUT: input.outputPath,
    GITHUB_REPOSITORY: 'Padelapp-Club/monitoring-service',
    GITHUB_WORKSPACE: ensureDirectory(
      path.join(path.dirname(input.eventPath), 'github-workspace')
    ),
    RUNNER_TEMP: ensureDirectory(
      path.join(path.dirname(input.eventPath), 'runner-temp')
    ),
    'INPUT_API-URL': 'https://api.reviewrouter.site',
    'INPUT_PROVIDER-INSTANCE-ID': 'codex-rotating:1196598615',
    'INPUT_WORKFLOW-SCHEMA-VERSION': '1',
  };
}

function legacyMaxChangedLinesSkipComment(headSha: string): string {
  return [
    `<!-- reviewrouter:codex-oauth:terminal:${headSha}:skipped -->`,
    '',
    '## Review skipped ⚠️',
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

function ensureDirectory(directory: string): string {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
