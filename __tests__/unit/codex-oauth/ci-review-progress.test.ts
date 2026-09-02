import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CI_PROGRESS_MARKER,
  CiReviewProgressPublisher,
  CiOrchestrationProgressReporter,
  createCiReviewProgressPublisher,
  formatCiReviewProgress,
  type CiProgressGitHubPort,
  type ProgressSnapshot,
} from '../../../src/codex-oauth/ci-review-progress';

describe('CI review progress fallback', () => {
  const snapshot: ProgressSnapshot = {
    schemaVersion: 1,
    generation: 1,
    phase: 'reviewing',
    terminal: 'none',
    updatedAt: '2026-08-12T12:00:00.000Z',
    counts: {
      total: 4,
      completed: 2,
      exhausted: 1,
      retrying: 1,
      recovered: 0,
    },
    fileCoverage: { valid: true, total: 3, covered: 1 },
  };

  it('uses one stable marker and accessible counts', () => {
    expect(formatCiReviewProgress(snapshot)).toContain(CI_PROGRESS_MARKER);
    expect(formatCiReviewProgress(snapshot)).toContain(
      'Review units: 2 of 4 complete (50%)'
    );
    expect(formatCiReviewProgress(snapshot)).not.toContain('provider');
  });

  it('upserts the single marker comment when writes are eligible', async () => {
    const github = githubPort([{ id: 17, body: CI_PROGRESS_MARKER }]);
    const publisher = new CiReviewProgressPublisher({
      repository: 'owner/repo',
      pullRequestNumber: 7,
      commentEligible: true,
      github,
    });

    await expect(publisher.publish(snapshot)).resolves.toBe('comment');
    expect(github.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ commentId: 17 })
    );
    expect(github.createComment).not.toHaveBeenCalled();
  });

  it('does not call GitHub for fork or known read-only contexts', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-progress-'));
    const summaryPath = path.join(temp, 'summary.md');
    const github = githubPort([]);
    const publisher = new CiReviewProgressPublisher({
      repository: 'owner/repo',
      pullRequestNumber: 7,
      commentEligible: false,
      github,
      summaryPath,
      info: jest.fn(),
    });

    await expect(publisher.publish(snapshot)).resolves.toBe('summary');
    expect(github.listComments).not.toHaveBeenCalled();
    expect(github.createComment).not.toHaveBeenCalled();
    expect(fs.readFileSync(summaryPath, 'utf8')).toContain(
      'CI progress comment is unavailable'
    );
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it('falls back after a read-only token is rejected without retrying', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-progress-'));
    const summaryPath = path.join(temp, 'summary.md');
    const github = githubPort([]);
    github.listComments.mockRejectedValueOnce(
      new Error('Resource not accessible by integration')
    );
    const publisher = new CiReviewProgressPublisher({
      repository: 'owner/repo',
      pullRequestNumber: 7,
      commentEligible: true,
      github,
      summaryPath,
      info: jest.fn(),
      warning: jest.fn(),
    });

    await expect(publisher.publish(snapshot)).resolves.toBe('summary');
    expect(github.listComments).toHaveBeenCalledTimes(1);
    expect(github.createComment).not.toHaveBeenCalled();
    expect(fs.readFileSync(summaryPath, 'utf8')).toContain(CI_PROGRESS_MARKER);
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it('treats fork PRs as summary-only even when GITHUB_TOKEN exists', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-progress-'));
    const eventPath = path.join(temp, 'event.json');
    const summaryPath = path.join(temp, 'summary.md');
    fs.writeFileSync(
      eventPath,
      JSON.stringify({
        repository: { full_name: 'owner/repo' },
        pull_request: {
          head: { repo: { fork: true, full_name: 'contributor/repo' } },
        },
      })
    );
    const publisher = createCiReviewProgressPublisher({
      repository: 'owner/repo',
      pullRequestNumber: 7,
      eventPath,
      env: {
        REVIEW_ROUTER_CI_PROGRESS_WRITES: 'true',
        GITHUB_TOKEN: 'read-only-fork-token',
        GITHUB_STEP_SUMMARY: summaryPath,
      },
    });

    await expect(publisher?.publish(snapshot)).resolves.toBe('summary');
    expect(fs.readFileSync(summaryPath, 'utf8')).toContain(
      'CI progress comment is unavailable'
    );
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it('stays disabled unless the rollout flag is explicitly enabled', () => {
    expect(
      createCiReviewProgressPublisher({
        repository: 'owner/repo',
        pullRequestNumber: 7,
        env: { GITHUB_TOKEN: 'token' },
      })
    ).toBeNull();
  });

  it('coalesces live transitions and never counts retries as completion', async () => {
    const publish = jest.fn().mockResolvedValue('comment');
    let now = 120_000;
    const reporter = new CiOrchestrationProgressReporter(
      { publish } as never,
      () => now,
      60_000
    );
    const workSlot = (workSlotId: string) =>
      ({ workSlotId, required: true }) as never;

    reporter.report({
      type: 'initialized',
      workSlots: [workSlot('slot-1'), workSlot('slot-2')],
    });
    reporter.report({
      type: 'running',
      workSlotId: 'slot-1',
      attemptOrdinal: 2,
    });
    reporter.report({
      type: 'accepted',
      workSlotId: 'slot-1',
      attemptOrdinal: 2,
    });
    now += 60_000;
    reporter.report({ type: 'assembling' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[0][0].counts).toMatchObject({
      total: 2,
      completed: 0,
      retrying: 0,
      recovered: 0,
    });
    expect(publish.mock.calls[1][0].counts).toMatchObject({
      total: 2,
      completed: 1,
      retrying: 0,
      recovered: 1,
    });
    await reporter.finish('complete_with_gaps');
    expect(publish.mock.calls[2][0]).toMatchObject({
      phase: 'terminal',
      terminal: 'complete_with_gaps',
      counts: { total: 2, completed: 1 },
    });
  });

  it('publishes a terminal progress snapshot only once', async () => {
    const publish = jest.fn().mockResolvedValue('comment');
    const reporter = new CiOrchestrationProgressReporter(
      { publish } as never,
      () => 120_000,
      60_000
    );

    await reporter.finish('failed');
    await reporter.finish('complete');

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'terminal', terminal: 'failed' })
    );
  });

  it('counts only required units in progress', async () => {
    const publish = jest.fn().mockResolvedValue('comment');
    const reporter = new CiOrchestrationProgressReporter(
      { publish } as never,
      () => 120_000,
      60_000
    );

    reporter.report({
      type: 'initialized',
      workSlots: [
        { workSlotId: 'required', required: true } as never,
        { workSlotId: 'optional', required: false } as never,
      ],
    });
    reporter.report({
      type: 'accepted',
      workSlotId: 'optional',
      attemptOrdinal: 1,
    });
    await reporter.finish('complete');

    expect(publish.mock.calls.at(-1)?.[0].counts).toMatchObject({
      total: 1,
      completed: 0,
    });
  });
});

function githubPort(
  comments: readonly { id: number; body?: string | null }[]
): jest.Mocked<CiProgressGitHubPort> {
  return {
    listComments: jest.fn().mockResolvedValue(comments),
    createComment: jest.fn().mockResolvedValue(undefined),
    updateComment: jest.fn().mockResolvedValue(undefined),
  };
}
