import { createHash } from 'crypto';
import { createContentDefinedReviewBatches } from '../review-orchestration/domain/content-defined-review-batches';
import { FileChange } from '../types';
import { logger } from '../utils/logger';
import {
  estimateTokensForFile,
  getContextWindowSize,
} from '../utils/token-estimation';

export interface BatchOrchestratorOptions {
  defaultBatchSize: number;
  providerOverrides?: Record<string, number>;
  maxBatchSize?: number;
  enableTokenAwareBatching?: boolean;
  targetTokensPerBatch?: number;
  maxFullFileBytes?: number;
  maxFullFileChanges?: number;
}

/**
 * Splits file lists into batches to keep prompts small and avoid provider timeouts.
 * Supports provider-specific batch size overrides (e.g., slower models) and
 * parallel-friendly batching.
 */
export class BatchOrchestrator {
  constructor(private readonly options: BatchOrchestratorOptions) {}

  /**
   * Determine the effective batch size for the current provider set.
   * Uses the smallest override to ensure no provider receives more than it can handle.
   */
  getBatchSize(providerNames: string[]): number {
    let size = this.options.defaultBatchSize;

    for (const name of providerNames) {
      const override = this.getOverrideForProvider(name);
      if (override) {
        size = Math.min(size, override);
      }
    }

    const capped = this.options.maxBatchSize
      ? Math.min(size, this.options.maxBatchSize)
      : size;

    const finalSize = Math.max(1, capped);
    logger.debug(
      `Batch size resolved: ${finalSize} (providers: ${providerNames.join(',') || 'none'})`
    );
    return finalSize;
  }

  /**
   * Split files into stable content-defined batches of at most batchSize items.
   */
  createBatches(files: FileChange[], batchSize: number): FileChange[][] {
    if (
      !Number.isFinite(batchSize) ||
      batchSize <= 0 ||
      !Number.isInteger(batchSize)
    ) {
      throw new Error(
        `Invalid batch size: ${batchSize}. Must be a positive integer.`
      );
    }
    return this.createContentDefinedBatches(
      files,
      batchSize,
      Number.MAX_SAFE_INTEGER,
      () => 0
    );
  }

  /**
   * Create batches using token-aware sizing
   * Automatically determines optimal batch size based on file sizes and provider context windows
   */
  createTokenAwareBatches(
    files: FileChange[],
    providerNames: string[]
  ): FileChange[][] {
    if (!this.options.enableTokenAwareBatching) {
      // Fall back to fixed-size batching
      const batchSize = this.getBatchSize(providerNames);
      return this.createBatches(files, batchSize);
    }

    if (files.length === 0) return [];

    // Find smallest context window among providers
    let smallestWindow = Infinity;
    for (const providerName of providerNames) {
      const window = getContextWindowSize(providerName);
      if (window < smallestWindow) {
        smallestWindow = window;
      }
    }

    // Handle case where no valid context window data is available
    // Fall back to conservative default (100k tokens ~ 400KB of code)
    const DEFAULT_CONTEXT_WINDOW = 100000;
    if (!isFinite(smallestWindow) || smallestWindow === 0) {
      logger.warn(
        `No valid context window data available for providers: ${providerNames.join(', ')}. ` +
          `Falling back to default ${DEFAULT_CONTEXT_WINDOW} tokens.`
      );
      smallestWindow = DEFAULT_CONTEXT_WINDOW;
    }

    // Calculate target tokens per batch based on smallest context window
    // Use 50% of available context window to leave room for instructions and response
    const targetTokens =
      this.options.targetTokensPerBatch ?? Math.floor(smallestWindow * 0.5);

    // Get max files per batch from config
    const maxFiles = this.options.maxBatchSize ?? 200;

    logger.debug(
      `Token-aware batching: target ${targetTokens} tokens/batch, ` +
        `max ${maxFiles} files/batch, smallest context window: ${smallestWindow}`
    );

    const batches = this.createContentDefinedBatches(
      files,
      maxFiles,
      targetTokens,
      (file) =>
        estimateTokensForFile(file, {
          maxFullFileBytes: this.options.maxFullFileBytes,
          maxFullFileChanges: this.options.maxFullFileChanges,
        })
    );

    const averageFiles =
      batches.length === 0 ? 0 : Math.ceil(files.length / batches.length);
    logger.info(
      `Token-aware content-defined batching: ${batches.length} batches ` +
        `(avg ${averageFiles} files)`
    );

    return batches;
  }

  /**
   * Get batch size optimized for token budget and provider context windows
   */
  getBatchSizeForTokenBudget(
    files: FileChange[],
    providerNames: string[]
  ): number {
    if (!this.options.enableTokenAwareBatching || files.length === 0) {
      return this.getBatchSize(providerNames);
    }

    const batches = this.createTokenAwareBatches(files, providerNames);
    if (batches.length === 0) return this.getBatchSize(providerNames);

    // Return average batch size
    return Math.ceil(files.length / batches.length);
  }

  private getOverrideForProvider(providerName: string): number | undefined {
    const overrides = this.options.providerOverrides || {};
    if (overrides[providerName] !== undefined) return overrides[providerName];

    // Allow prefix-based override, e.g., "openrouter/" to cover multiple models
    const prefix = providerName.split('/')[0];
    return overrides[prefix];
  }

  private createContentDefinedBatches(
    files: readonly FileChange[],
    maxFilesPerBatch: number,
    maxTokensPerBatch: number,
    estimateTokens: (file: FileChange) => number
  ): FileChange[][] {
    return createContentDefinedReviewBatches(
      files.map((file, schedulingPriority) => ({
        value: file,
        routeKey: file.filename,
        canonicalIdentity: fileIdentity(file),
        tokenCost: estimateTokens(file),
        schedulingPriority,
      })),
      {
        maxFilesPerBatch,
        maxTokensPerBatch,
      }
    ).map((batch) => batch.units.map((unit) => unit.value));
  }
}

function fileIdentity(file: FileChange): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        additions: file.additions,
        changes: file.changes,
        deletions: file.deletions,
        filename: file.filename,
        language: file.language ?? null,
        patch: file.patch ?? null,
        previousFilename: file.previousFilename ?? null,
        status: file.status,
      })
    )
    .digest('hex');
}
