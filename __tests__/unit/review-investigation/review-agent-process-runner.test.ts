import {
  NodeReviewAgentProcessRunner,
  ReviewAgentProcessTermination,
} from '../../../src/review-investigation/infrastructure';

describe('NodeReviewAgentProcessRunner', () => {
  it('cancels only the active process with the matching fencing token', async () => {
    const runner = new NodeReviewAgentProcessRunner();
    const running = runner.run({
      invocationId: 'process-1',
      fencingToken: 'fence-1',
      binary: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      environment: { PATH: process.env.PATH },
      stdin: '',
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(runner.cancel('process-1', 'wrong-fence')).rejects.toThrow(
      'review_agent_cancel_fencing_mismatch'
    );
    await runner.cancel('process-1', 'fence-1');
    await expect(running).resolves.toMatchObject({
      termination: ReviewAgentProcessTermination.Cancelled,
    });
  });
});
