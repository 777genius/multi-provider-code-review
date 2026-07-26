import fs from 'fs';
import os from 'os';
import path from 'path';
import { GitHubClient } from '../../../src/github/client';
import { ReviewLedger } from '../../../src/github/ledger';
import { ReviewInteractionHandler } from '../../../src/github/interaction';
import {
  ActionMemoryCandidateRequest,
  ActionMemoryCommand,
  ActionMemoryInteractionPort,
  ActionMemoryMutationResponse,
} from '../../../src/control-plane/memory';
import {
  ManualReviewRequestAvailability,
  type ManualReviewRequestPort,
  type ManualReviewRequestCommandKind,
} from '../../../src/control-plane/review-request';

function writeEvent(payload: unknown): string {
  const file = path.join(
    os.tmpdir(),
    `review-router-event-${Date.now()}-${Math.random()}.json`
  );
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

function makeClient(options: { parentBody?: string } = {}) {
  const listReviewComments = jest.fn();
  const updateReviewComment = jest.fn().mockResolvedValue({});
  const getPull = jest.fn().mockResolvedValue({
    data: {
      number: 123,
      head: { sha: 'abc', repo: { fork: false } },
      user: { login: 'author' },
    },
  });
  const listComments = jest.fn();
  const parentBody =
    options.parentBody ||
    '**🟡 Major - SQL injection**\n\nUse parameterized queries.';
  const octokit = {
    rest: {
      pulls: { listReviewComments, updateReviewComment, get: getPull },
      issues: {
        listComments,
        createComment: jest.fn().mockResolvedValue({}),
        updateComment: jest.fn().mockResolvedValue({}),
      },
      repos: {
        getCollaboratorPermissionLevel: jest.fn(),
      },
      actions: {
        listWorkflowRunsForRepo: jest.fn(),
        getWorkflowRun: jest.fn(),
        reRunWorkflowFailedJobs: jest.fn().mockResolvedValue({}),
      },
    },
    graphql: jest.fn().mockResolvedValue({}) as jest.Mock,
    paginate: jest.fn((method: jest.Mock) => {
      if (method === listReviewComments) {
        return Promise.resolve([
          {
            id: 10,
            path: 'src/file.ts',
            line: 10,
            body: parentBody,
          },
        ]);
      }
      if (method === listComments) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    }),
  };
  const client = {
    octokit,
    owner: 'test-owner',
    repo: 'test-repo',
  } as unknown as GitHubClient;
  return { client, octokit };
}

class CapturingMemoryClient implements ActionMemoryInteractionPort {
  public readonly candidates: ActionMemoryCandidateRequest[] = [];
  public readonly commands: ActionMemoryCommand[][] = [];

  constructor(
    private readonly options: {
      readonly available?: boolean;
      readonly candidateResponse?: ActionMemoryMutationResponse;
      readonly commandResponses?: readonly ActionMemoryMutationResponse[];
    } = {}
  ) {}

  isAvailable(): boolean {
    return this.options.available ?? true;
  }

  async submitCandidate(
    input: ActionMemoryCandidateRequest
  ): Promise<ActionMemoryMutationResponse> {
    this.candidates.push(input);
    return (
      this.options.candidateResponse ?? {
        status: 'created',
        id: 'mem_direct',
        version: 1,
      }
    );
  }

  async submitCommands(
    commands: readonly ActionMemoryCommand[]
  ): Promise<readonly ActionMemoryMutationResponse[]> {
    this.commands.push([...commands]);
    return (
      this.options.commandResponses ?? [
        { status: 'updated', id: 'mem_confirmed', version: 2 },
      ]
    );
  }
}

class CapturingReviewRequestClient implements ManualReviewRequestPort {
  public readonly requests: Array<{
    readonly pullRequestNumber: number;
    readonly expectedHeadSha: string;
    readonly sourceId: string;
    readonly commandKind: ManualReviewRequestCommandKind;
  }> = [];

  constructor(
    private readonly state = ManualReviewRequestAvailability.Available
  ) {}

  availability(): ManualReviewRequestAvailability {
    return this.state;
  }

  async request(input: (typeof this.requests)[number]) {
    this.requests.push(input);
    return { status: 'queued' as const };
  }
}

describe('ReviewInteractionHandler', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('records /rr skip from maintainer and reruns the failed review job', async () => {
    const { client, octokit } = makeClient();
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 11,
        in_reply_to_id: 10,
        body: '/rr skip validated elsewhere',
        user: { login: 'maintainer' },
      },
      pull_request: {
        number: 123,
        head: { sha: 'abc', repo: { fork: false } },
        user: { login: 'author' },
      },
    });
    octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'write', role_name: 'maintain' },
    });
    octokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            id: 456,
            path: '.github/workflows/reviewrouter.yml',
            head_sha: 'abc',
            conclusion: 'failure',
            pull_requests: [{ number: 123 }],
          },
        ],
      },
    });

    const ledger = new ReviewLedger(client, 'test-secret');
    await new ReviewInteractionHandler(client, ledger).execute();

    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 123,
        body: expect.stringContaining('reviewrouter-ledger:v1'),
      })
    );
    expect(octokit.rest.actions.reRunWorkflowFailedJobs).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 456 })
    );
    expect(octokit.graphql).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.updateReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 10,
        body: expect.stringContaining('review-router-dismissal:start'),
      })
    );
    expect(octokit.rest.pulls.updateReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(
          'Dismissed by @maintainer via `/rr skip`; this finding no longer blocks ReviewRouter. Reason: validated elsewhere'
        ),
      })
    );
  });

  it('creates a revision-aware manual intent without rerunning an old workflow attempt', async () => {
    const { client, octokit } = makeClient();
    const reviewRequests = new CapturingReviewRequestClient();
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 11,
        in_reply_to_id: 10,
        body: '/rr skip verified',
        user: { login: 'maintainer' },
      },
      pull_request: {
        number: 123,
        head: { sha: 'a'.repeat(40), repo: { fork: false } },
        user: { login: 'author' },
      },
    });
    octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'write', role_name: 'maintain' },
    });

    await new ReviewInteractionHandler(
      client,
      new ReviewLedger(client, 'test-secret'),
      undefined,
      client,
      undefined,
      reviewRequests
    ).execute();

    expect(reviewRequests.requests).toEqual([
      {
        pullRequestNumber: 123,
        expectedHeadSha: 'a'.repeat(40),
        sourceId: 'review-comment:11',
        commandKind: 'skip',
      },
    ]);
    expect(octokit.rest.actions.listWorkflowRunsForRepo).not.toHaveBeenCalled();
    expect(octokit.rest.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
  });

  it('queues a top-level /rr review as a distinct same-head request', async () => {
    const { client, octokit } = makeClient();
    const reviewRequests = new CapturingReviewRequestClient();
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 22,
        body: '/rr review',
        user: { login: 'maintainer' },
      },
      issue: { number: 123, pull_request: {} },
    });
    octokit.rest.pulls.get.mockResolvedValue({
      data: {
        number: 123,
        head: { sha: 'b'.repeat(40), repo: { fork: false } },
        user: { login: 'author' },
      },
    });
    octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'write', role_name: 'maintain' },
    });

    await new ReviewInteractionHandler(
      client,
      new ReviewLedger(client, 'test-secret'),
      undefined,
      client,
      undefined,
      reviewRequests
    ).execute();

    expect(reviewRequests.requests).toEqual([
      {
        pullRequestNumber: 123,
        expectedHeadSha: 'b'.repeat(40),
        sourceId: 'manual-comment:22',
        commandKind: 'review',
      },
    ]);
    expect(octokit.rest.actions.listWorkflowRunsForRepo).not.toHaveBeenCalled();
  });

  it('queues a top-level @codex review as a distinct same-head request', async () => {
    const { client, octokit } = makeClient();
    const reviewRequests = new CapturingReviewRequestClient();
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 23,
        body: '@codex review',
        user: { login: 'maintainer' },
      },
      issue: { number: 123, pull_request: {} },
    });
    octokit.rest.pulls.get.mockResolvedValue({
      data: {
        number: 123,
        head: { sha: 'c'.repeat(40), repo: { fork: false } },
        user: { login: 'author' },
      },
    });
    octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'write', role_name: 'maintain' },
    });

    await new ReviewInteractionHandler(
      client,
      new ReviewLedger(client, 'test-secret'),
      undefined,
      client,
      undefined,
      reviewRequests
    ).execute();

    expect(reviewRequests.requests).toEqual([
      {
        pullRequestNumber: 123,
        expectedHeadSha: 'c'.repeat(40),
        sourceId: 'manual-comment:23',
        commandKind: 'review',
      },
    ]);
    expect(octokit.rest.actions.listWorkflowRunsForRepo).not.toHaveBeenCalled();
  });

  it('does not rerun a legacy attempt when control-plane availability is ambiguous', async () => {
    const { client, octokit } = makeClient();
    const reviewRequests = new CapturingReviewRequestClient(
      ManualReviewRequestAvailability.Unavailable
    );
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 11,
        in_reply_to_id: 10,
        body: '/rr skip verified',
        user: { login: 'maintainer' },
      },
      pull_request: {
        number: 123,
        head: { sha: 'a'.repeat(40), repo: { fork: false } },
        user: { login: 'author' },
      },
    });
    octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'write', role_name: 'maintain' },
    });

    await new ReviewInteractionHandler(
      client,
      new ReviewLedger(client, 'test-secret'),
      undefined,
      client,
      undefined,
      reviewRequests
    ).execute();

    expect(octokit.rest.actions.listWorkflowRunsForRepo).not.toHaveBeenCalled();
    expect(octokit.rest.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(
          'did not rerun an older workflow attempt'
        ),
      })
    );
  });

  it('uses the workflow token client for rerunning checks when comments use an App token', async () => {
    const { client: commentClient, octokit: commentOctokit } = makeClient();
    const { client: actionsClient, octokit: actionsOctokit } = makeClient();
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 11,
        in_reply_to_id: 10,
        body: '/rr skip validated by maintainer',
        user: { login: 'maintainer' },
      },
      pull_request: {
        number: 123,
        head: { sha: 'abc', repo: { fork: false } },
        user: { login: 'author' },
      },
    });
    actionsOctokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'write', role_name: 'maintain' },
    });
    actionsOctokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            id: 456,
            path: '.github/workflows/reviewrouter.yml',
            head_sha: 'abc',
            conclusion: 'failure',
            pull_requests: [{ number: 123 }],
          },
        ],
      },
    });
    commentOctokit.rest.actions.listWorkflowRunsForRepo.mockRejectedValue(
      Object.assign(new Error('App token must not rerun workflows'), {
        status: 403,
      })
    );

    const ledger = new ReviewLedger(commentClient, 'test-secret');
    await new ReviewInteractionHandler(
      commentClient,
      ledger,
      undefined,
      actionsClient
    ).execute();

    expect(
      actionsOctokit.rest.actions.reRunWorkflowFailedJobs
    ).toHaveBeenCalledWith(expect.objectContaining({ run_id: 456 }));
    expect(commentOctokit.graphql).not.toHaveBeenCalled();
    expect(actionsOctokit.graphql).not.toHaveBeenCalled();
    expect(
      commentOctokit.rest.actions.reRunWorkflowFailedJobs
    ).not.toHaveBeenCalled();
    expect(commentOctokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 123,
        body: expect.stringContaining('reviewrouter-ledger:v1'),
      })
    );
    expect(commentOctokit.rest.pulls.updateReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 10,
        body: expect.stringContaining('review-router-dismissal:start'),
      })
    );
    expect(
      actionsOctokit.rest.pulls.updateReviewComment
    ).not.toHaveBeenCalled();
  });

  it('records /rr skip without requiring a reason', async () => {
    const { client, octokit } = makeClient();
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 11,
        in_reply_to_id: 10,
        body: '/rr skip',
        user: { login: 'maintainer' },
      },
      pull_request: {
        number: 123,
        head: { sha: 'abc', repo: { fork: false } },
        user: { login: 'author' },
      },
    });
    octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'write', role_name: 'maintain' },
    });
    octokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            id: 456,
            path: '.github/workflows/reviewrouter.yml',
            head_sha: 'abc',
            conclusion: 'failure',
            pull_requests: [{ number: 123 }],
          },
        ],
      },
    });

    const ledger = new ReviewLedger(client, 'test-secret');
    await new ReviewInteractionHandler(client, ledger).execute();

    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 123,
        body: expect.stringContaining('reviewrouter-ledger:v1'),
      })
    );
    expect(octokit.rest.actions.reRunWorkflowFailedJobs).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 456 })
    );
    expect(octokit.rest.pulls.updateReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 10,
        body: expect.stringContaining(
          'Dismissed by @maintainer via `/rr skip`; this finding no longer blocks ReviewRouter.'
        ),
      })
    );
  });

  it('does not post a rerun warning when the current review run already succeeded', async () => {
    const { client, octokit } = makeClient();
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 11,
        in_reply_to_id: 10,
        body: '/rr skip already handled',
        user: { login: 'maintainer' },
      },
      pull_request: {
        number: 123,
        head: { sha: 'abc', repo: { fork: false } },
        user: { login: 'author' },
      },
    });
    octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'write', role_name: 'maintain' },
    });
    octokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            id: 456,
            path: '.github/workflows/reviewrouter.yml',
            head_sha: 'abc',
            status: 'completed',
            conclusion: 'success',
            pull_requests: [{ number: 123 }],
          },
        ],
      },
    });

    const ledger = new ReviewLedger(client, 'test-secret');
    await new ReviewInteractionHandler(client, ledger).execute();

    expect(octokit.rest.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 123,
        body: expect.not.stringContaining('could not automatically rerun'),
      })
    );
  });

  it('waits for an active review rerun and reruns again if it still fails', async () => {
    const { client, octokit } = makeClient();
    process.env.REVIEW_ROUTER_RERUN_WAIT_SECONDS = '1';
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 11,
        in_reply_to_id: 10,
        body: '/rr skip',
        user: { login: 'maintainer' },
      },
      pull_request: {
        number: 123,
        head: { sha: 'abc', repo: { fork: false } },
        user: { login: 'author' },
      },
    });
    octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'write', role_name: 'maintain' },
    });
    octokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            id: 456,
            path: '.github/workflows/reviewrouter.yml',
            head_sha: 'abc',
            status: 'in_progress',
            conclusion: null,
            updated_at: '2026-05-01T17:46:44Z',
            pull_requests: [{ number: 123 }],
          },
        ],
      },
    });
    octokit.rest.actions.getWorkflowRun.mockResolvedValue({
      data: {
        id: 456,
        status: 'completed',
        conclusion: 'failure',
      },
    });

    const ledger = new ReviewLedger(client, 'test-secret');
    await new ReviewInteractionHandler(client, ledger).execute();

    expect(octokit.rest.actions.getWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 456 })
    );
    expect(octokit.rest.actions.reRunWorkflowFailedJobs).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 456 })
    );
  });

  it('removes the dismissal marker for /rr unskip', async () => {
    const { client, octokit } = makeClient({
      parentBody:
        '**🟡 Major - SQL injection**\n\n<!-- review-router-dismissal:start -->\n<sub>Dismissed by @maintainer via `/rr skip`; this finding no longer blocks ReviewRouter.</sub>\n<!-- review-router-dismissal:end -->\nUse parameterized queries.',
    });
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 11,
        in_reply_to_id: 10,
        body: '/rr unskip',
        user: { login: 'maintainer' },
      },
      pull_request: {
        number: 123,
        head: { sha: 'abc', repo: { fork: false } },
        user: { login: 'author' },
      },
    });
    octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'write', role_name: 'maintain' },
    });
    octokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            id: 456,
            path: '.github/workflows/reviewrouter.yml',
            head_sha: 'abc',
            conclusion: 'failure',
            pull_requests: [{ number: 123 }],
          },
        ],
      },
    });

    const ledger = new ReviewLedger(client, 'test-secret');
    await new ReviewInteractionHandler(client, ledger).execute();

    expect(octokit.graphql).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.updateReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 10,
        body: expect.not.stringContaining('review-router-dismissal:start'),
      })
    );
  });

  it('rejects blocking skips from PR authors without maintain/admin permission by default', async () => {
    const { client, octokit } = makeClient();
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 11,
        in_reply_to_id: 10,
        body: '/rr skip',
        user: { login: 'author' },
      },
      pull_request: {
        number: 123,
        head: { sha: 'abc', repo: { fork: false } },
        user: { login: 'Author' },
      },
    });
    octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'write', role_name: 'write' },
    });

    const ledger = new ReviewLedger(client, 'test-secret');
    await new ReviewInteractionHandler(client, ledger).execute();

    expect(octokit.rest.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 123,
        body: expect.stringContaining(
          'PR authors without maintain/admin permission cannot override blocking ReviewRouter findings by default'
        ),
      })
    );
  });

  it('allows blocking skips from PR authors with admin permission', async () => {
    const { client, octokit } = makeClient();
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 11,
        in_reply_to_id: 10,
        body: '/rr skip owner verified',
        user: { login: 'owner' },
      },
      pull_request: {
        number: 123,
        head: { sha: 'abc', repo: { fork: false } },
        user: { login: 'Owner' },
      },
    });
    octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'admin', role_name: 'admin' },
    });
    octokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            id: 456,
            path: '.github/workflows/reviewrouter.yml',
            head_sha: 'abc',
            conclusion: 'failure',
            pull_requests: [{ number: 123 }],
          },
        ],
      },
    });

    const ledger = new ReviewLedger(client, 'test-secret');
    await new ReviewInteractionHandler(client, ledger).execute();

    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 123,
        body: expect.stringContaining('reviewrouter-ledger:v1'),
      })
    );
    expect(octokit.rest.actions.reRunWorkflowFailedJobs).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 456 })
    );
  });

  it('does not rerun when the ledger key is missing', async () => {
    const { client, octokit } = makeClient();
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 11,
        in_reply_to_id: 10,
        body: '/rr skip validated elsewhere',
        user: { login: 'maintainer' },
      },
      pull_request: {
        number: 123,
        head: { sha: 'abc', repo: { fork: false } },
        user: { login: 'author' },
      },
    });
    octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'write', role_name: 'maintain' },
    });

    const ledger = new ReviewLedger(client, undefined);
    await new ReviewInteractionHandler(client, ledger).execute();

    expect(octokit.rest.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 123,
        body: expect.stringContaining('Could not record `/rr skip`'),
      })
    );
  });

  it('submits direct repository memory commands from PR issue comments', async () => {
    const { client, octokit } = makeClient();
    const memoryClient = new CapturingMemoryClient({
      candidateResponse: { status: 'created', id: 'mem_direct', version: 1 },
    });
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 77,
        body: '/rr remember repo Use Playwright screenshots for memory dashboard QA.',
        user: { login: 'maintainer', type: 'User' },
      },
      issue: { number: 123, pull_request: {} },
      repository: { full_name: 'test-owner/test-repo' },
    });

    const ledger = new ReviewLedger(client, 'test-secret');
    await new ReviewInteractionHandler(
      client,
      ledger,
      undefined,
      client,
      memoryClient
    ).execute();

    expect(octokit.rest.pulls.get).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 123 })
    );
    expect(memoryClient.candidates).toHaveLength(1);
    expect(memoryClient.candidates[0]).toMatchObject({
      protocolVersion: 1,
      intent: 'explicit_command',
      requestedScope: 'repository',
      candidateBody: 'Use Playwright screenshots for memory dashboard QA.',
      extractionMethod: 'explicit_command',
      source: {
        sourceId: 'github-comment:77',
        githubCommentId: '77',
        githubPullRequestNumber: 123,
        url: 'https://github.com/test-owner/test-repo/pull/123#issuecomment-77',
        redactedExcerpt: 'Use Playwright screenshots for memory dashboard QA.',
        sourceVisibility: 'private',
      },
    });
    expect(memoryClient.candidates[0].sourceTextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 123,
        body: expect.stringContaining('Saved repository memory `mem_direct`'),
      })
    );
  });

  it('turns natural-language memory requests into pending suggestions', async () => {
    const { client, octokit } = makeClient();
    const memoryClient = new CapturingMemoryClient({
      candidateResponse: {
        status: 'created',
        id: 'mem_suggestion_natural',
        version: 1,
      },
    });
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 78,
        body: 'Remember for this repository: prefer compact badges over button-like badges.',
        user: { login: 'maintainer', type: 'User' },
      },
      issue: { number: 123, pull_request: {} },
      repository: { full_name: 'test-owner/test-repo' },
    });

    const ledger = new ReviewLedger(client, 'test-secret');
    await new ReviewInteractionHandler(
      client,
      ledger,
      undefined,
      client,
      memoryClient
    ).execute();

    expect(memoryClient.candidates).toHaveLength(1);
    expect(memoryClient.candidates[0]).toMatchObject({
      intent: 'explicit_natural_language',
      requestedScope: 'repository',
      candidateBody: 'prefer compact badges over button-like badges.',
      extractionMethod: 'explicit_natural_language',
    });
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(
          'Confirm with `/rr remember mem_suggestion_natural`'
        ),
      })
    );
  });

  it('submits memory confirmation commands without treating them as skip commands', async () => {
    const { client, octokit } = makeClient();
    const memoryClient = new CapturingMemoryClient({
      commandResponses: [
        { status: 'created', id: 'mem_confirmed', version: 1 },
      ],
    });
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 79,
        body: '/rr remember mem_suggestion_natural',
        user: { login: 'maintainer', type: 'User' },
      },
      issue: { number: 123, pull_request: {} },
      repository: { full_name: 'test-owner/test-repo' },
    });

    const ledger = new ReviewLedger(client, 'test-secret');
    await new ReviewInteractionHandler(
      client,
      ledger,
      undefined,
      client,
      memoryClient
    ).execute();

    expect(memoryClient.candidates).toHaveLength(0);
    expect(memoryClient.commands).toEqual([
      [{ kind: 'confirm_suggestion', suggestionId: 'mem_suggestion_natural' }],
    ]);
    expect(octokit.rest.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(
          'Confirmed memory suggestion `mem_suggestion_natural` as `mem_confirmed`'
        ),
      })
    );
  });

  it('ignores bot memory comments to prevent loops', async () => {
    const { client, octokit } = makeClient();
    const memoryClient = new CapturingMemoryClient();
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 80,
        body: '/rr remember repo bot generated memory',
        user: { login: 'github-actions[bot]', type: 'Bot' },
      },
      issue: { number: 123, pull_request: {} },
      repository: { full_name: 'test-owner/test-repo' },
    });

    const ledger = new ReviewLedger(client, 'test-secret');
    await new ReviewInteractionHandler(
      client,
      ledger,
      undefined,
      client,
      memoryClient
    ).execute();

    expect(memoryClient.candidates).toHaveLength(0);
    expect(memoryClient.commands).toHaveLength(0);
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('does not submit memory from fork pull requests', async () => {
    const { client, octokit } = makeClient();
    octokit.rest.pulls.get.mockResolvedValueOnce({
      data: {
        number: 123,
        head: { sha: 'abc', repo: { fork: true } },
        user: { login: 'author' },
      },
    });
    const memoryClient = new CapturingMemoryClient();
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 81,
        body: '/rr remember repo fork memory',
        user: { login: 'maintainer', type: 'User' },
      },
      issue: { number: 123, pull_request: {} },
      repository: { full_name: 'test-owner/test-repo' },
    });

    const ledger = new ReviewLedger(client, 'test-secret');
    await new ReviewInteractionHandler(
      client,
      ledger,
      undefined,
      client,
      memoryClient
    ).execute();

    expect(memoryClient.candidates).toHaveLength(0);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('fork pull requests'),
      })
    );
  });
});
