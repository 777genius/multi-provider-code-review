import { createExecutionDeadlineFromEnvironment } from '../../../src/review-execution/infrastructure/execution-deadline-from-environment';

describe('createExecutionDeadlineFromEnvironment', () => {
  it('uses the shared production safety windows', () => {
    let now = 1_000;
    const deadline = createExecutionDeadlineFromEnvironment(
      {
        REVIEWROUTER_EXECUTION_DEADLINE_EPOCH_MS: '151000',
      },
      { now: () => now }
    );

    expect(deadline.canStartBatch()).toBe(true);
    expect(deadline.clampProviderTimeout(60_000)).toBe(30_000);

    now += 1;
    expect(deadline.canStartBatch()).toBe(false);
  });

  it('rejects an invalid configured epoch', () => {
    expect(() =>
      createExecutionDeadlineFromEnvironment({
        REVIEWROUTER_EXECUTION_DEADLINE_EPOCH_MS: 'tomorrow',
      })
    ).toThrow(
      'REVIEWROUTER_EXECUTION_DEADLINE_EPOCH_MS must be a positive epoch timestamp'
    );
  });
});
