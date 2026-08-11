import {
  ExecutionDeadline,
  type EpochClock,
} from '../domain/execution-deadline';

export const REVIEW_EXECUTION_DEADLINE_ENV_KEY =
  'REVIEWROUTER_EXECUTION_DEADLINE_EPOCH_MS';

const DEFAULT_COMPLETION_RESERVE_MS = 120_000;
const DEFAULT_MINIMUM_BATCH_START_WINDOW_MS = 30_000;
const DEFAULT_MINIMUM_RETRY_START_WINDOW_MS = 30_000;

function parseOptionalEpochMs(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `${REVIEW_EXECUTION_DEADLINE_ENV_KEY} must be a positive epoch timestamp`
    );
  }
  return parsed;
}

export function createExecutionDeadlineFromEnvironment(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  clock?: EpochClock
): ExecutionDeadline {
  return new ExecutionDeadline(
    parseOptionalEpochMs(environment[REVIEW_EXECUTION_DEADLINE_ENV_KEY]),
    {
      completionReserveMs: DEFAULT_COMPLETION_RESERVE_MS,
      minimumBatchStartWindowMs: DEFAULT_MINIMUM_BATCH_START_WINDOW_MS,
      minimumOptionalRetryStartWindowMs: DEFAULT_MINIMUM_RETRY_START_WINDOW_MS,
    },
    clock
  );
}
