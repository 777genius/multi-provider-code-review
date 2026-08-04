import { CapacitySignal } from '../domain/capacity-signal';

export const ADAPTIVE_BATCH_HARD_MAX_CONCURRENCY = 3;
const INITIAL_MULTIPLE_ITEM_CONCURRENCY = 2;

export enum BatchExecutionStatus {
  Fulfilled = 'fulfilled',
  Rejected = 'rejected',
}

export enum BatchDeferralReason {
  InsufficientDeadline = 'insufficient_deadline',
}

export interface BatchStartPolicy {
  canStartBatch(): boolean;
}

export interface FulfilledBatchExecution<TItem, TResult> {
  readonly status: BatchExecutionStatus.Fulfilled;
  readonly index: number;
  readonly item: TItem;
  readonly result: TResult;
}

export interface RejectedBatchExecution<TItem> {
  readonly status: BatchExecutionStatus.Rejected;
  readonly index: number;
  readonly item: TItem;
  readonly error: unknown;
}

export type CompletedBatchExecution<TItem, TResult> =
  FulfilledBatchExecution<TItem, TResult> | RejectedBatchExecution<TItem>;

export interface DeferredBatchExecution<TItem> {
  readonly index: number;
  readonly item: TItem;
  readonly reason: BatchDeferralReason;
}

export interface AdaptiveBatchScheduleResult<TItem, TResult> {
  readonly completed: readonly CompletedBatchExecution<TItem, TResult>[];
  readonly deferred: readonly DeferredBatchExecution<TItem>[];
}

export type BatchExecutor<TItem, TResult> = (
  item: TItem,
  index: number
) => Promise<TResult>;

export type CompletionSignalClassifier<TResult> = (
  result: TResult
) => CapacitySignal;

export class AdaptiveBatchScheduler {
  constructor(private readonly startPolicy: BatchStartPolicy) {}

  schedule<TItem, TResult>(
    items: readonly TItem[],
    execute: BatchExecutor<TItem, TResult>,
    classifyCompletion: CompletionSignalClassifier<TResult>
  ): Promise<AdaptiveBatchScheduleResult<TItem, TResult>> {
    if (items.length === 0) {
      return Promise.resolve({ completed: [], deferred: [] });
    }

    return new Promise((resolve) => {
      const completed: CompletedBatchExecution<TItem, TResult>[] = [];
      const deferred: DeferredBatchExecution<TItem>[] = [];
      let nextIndex = 0;
      let activeCount = 0;
      let concurrency =
        items.length > 1 ? INITIAL_MULTIPLE_ITEM_CONCURRENCY : 1;
      let capacityPressureObserved = false;
      let launchClosed = false;
      let resolved = false;

      const finishIfDone = (): void => {
        if (resolved || nextIndex < items.length || activeCount > 0) return;
        resolved = true;
        completed.sort((left, right) => left.index - right.index);
        deferred.sort((left, right) => left.index - right.index);
        resolve({ completed, deferred });
      };

      const deferUnstarted = (): void => {
        launchClosed = true;
        while (nextIndex < items.length) {
          deferred.push({
            index: nextIndex,
            item: items[nextIndex],
            reason: BatchDeferralReason.InsufficientDeadline,
          });
          nextIndex += 1;
        }
      };

      const adaptConcurrency = (signal: CapacitySignal): void => {
        if (signal === CapacitySignal.CapacityPressure) {
          capacityPressureObserved = true;
          concurrency = 1;
          return;
        }
        if (signal === CapacitySignal.Healthy && !capacityPressureObserved) {
          concurrency = ADAPTIVE_BATCH_HARD_MAX_CONCURRENCY;
        }
      };

      const pump = (): void => {
        while (
          !launchClosed &&
          activeCount < concurrency &&
          nextIndex < items.length
        ) {
          if (!this.startPolicy.canStartBatch()) {
            deferUnstarted();
            break;
          }

          const index = nextIndex;
          const item = items[index];
          nextIndex += 1;
          activeCount += 1;

          void Promise.resolve()
            .then(() => execute(item, index))
            .then((result) => {
              const signal = classifyCompletion(result);
              completed.push({
                status: BatchExecutionStatus.Fulfilled,
                index,
                item,
                result,
              });
              adaptConcurrency(signal);
            })
            .catch((error: unknown) => {
              completed.push({
                status: BatchExecutionStatus.Rejected,
                index,
                item,
                error,
              });
            })
            .finally(() => {
              activeCount -= 1;
              pump();
              finishIfDone();
            });
        }

        finishIfDone();
      };

      pump();
    });
  }
}
