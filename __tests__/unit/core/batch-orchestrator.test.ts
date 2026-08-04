import { BatchOrchestrator } from '../../../src/core/batch-orchestrator';
import { ReviewTaskKind } from '../../../src/review-orchestration/application';
import { createStableReviewBatchId } from '../../../src/review-orchestration/domain';
import { FileChange } from '../../../src/types';

const makeFiles = (count: number): FileChange[] =>
  Array.from({ length: count }).map((_, idx) => ({
    filename: `file-${idx}.ts`,
    status: 'modified',
    additions: 1,
    deletions: 0,
    changes: 1,
  }));

describe('BatchOrchestrator', () => {
  it('splits files into batches using default size', () => {
    const files = makeFiles(7);
    const orchestrator = new BatchOrchestrator({ defaultBatchSize: 3 });

    const batches = orchestrator.createBatches(
      files,
      orchestrator.getBatchSize(['provider/a'])
    );

    expect(batches.length).toBeGreaterThanOrEqual(3);
    expect(batches.every((batch) => batch.length <= 3)).toBe(true);
    expect(
      batches
        .flat()
        .map((file) => file.filename)
        .sort()
    ).toEqual(files.map((file) => file.filename).sort());
  });

  it('honors provider-specific override by picking the smallest', () => {
    const files = makeFiles(5);
    const orchestrator = new BatchOrchestrator({
      defaultBatchSize: 10,
      providerOverrides: { openrouter: 2 },
    });

    const batchSize = orchestrator.getBatchSize([
      'openrouter/model',
      'opencode/model',
    ]);
    expect(batchSize).toBe(2);

    const batches = orchestrator.createBatches(files, batchSize);
    expect(batches.length).toBeGreaterThanOrEqual(3);
    expect(batches.every((batch) => batch.length <= 2)).toBe(true);
  });

  it('uses prefix overrides when exact match not provided', () => {
    const files = makeFiles(4);
    const orchestrator = new BatchOrchestrator({
      defaultBatchSize: 5,
      providerOverrides: { opencode: 1 },
    });

    const batchSize = orchestrator.getBatchSize(['opencode/gemini:free']);
    expect(batchSize).toBe(1);
    const batches = orchestrator.createBatches(files, batchSize);
    expect(batches.every((batch) => batch.length === 1)).toBe(true);
  });

  it('returns empty batches for empty file list', () => {
    const orchestrator = new BatchOrchestrator({ defaultBatchSize: 3 });
    const batches = orchestrator.createBatches([], 3);
    expect(batches).toEqual([]);
  });

  it('throws on invalid batch sizes to avoid infinite loops', () => {
    const orchestrator = new BatchOrchestrator({ defaultBatchSize: 3 });
    expect(() => orchestrator.createBatches(makeFiles(2), 0)).toThrow(
      /invalid batch size/i
    );
    expect(() => orchestrator.createBatches(makeFiles(2), Number.NaN)).toThrow(
      /invalid batch size/i
    );
  });

  it('caps batch size using maxBatchSize even when overrides are larger', () => {
    const orchestrator = new BatchOrchestrator({
      defaultBatchSize: 25,
      maxBatchSize: 10,
      providerOverrides: { openrouter: 15 },
    });

    const batchSize = orchestrator.getBatchSize(['openrouter/model-x']);
    expect(batchSize).toBe(10); // capped by maxBatchSize
  });

  it('chooses the smallest override across mixed provider names', () => {
    const orchestrator = new BatchOrchestrator({
      defaultBatchSize: 8,
      providerOverrides: { openrouter: 5, opencode: 3 },
    });

    const batchSize = orchestrator.getBatchSize([
      'unknown',
      'opencode/fast',
      'openrouter/model',
    ]);
    expect(batchSize).toBe(3);
    const batches = orchestrator.createBatches(makeFiles(7), batchSize);
    expect(batches.length).toBeGreaterThanOrEqual(3);
    expect(batches.every((batch) => batch.length <= 3)).toBe(true);
  });

  it('keeps risk-prioritized input as scheduling order without using it for membership', () => {
    const orchestrator = new BatchOrchestrator({
      defaultBatchSize: 3,
      maxBatchSize: 3,
    });
    const files = makeFiles(24);
    const highRisk = files[17];
    const prioritized = [
      highRisk,
      ...files.filter((file) => file !== highRisk),
    ];

    const prioritizedBatches = orchestrator.createBatches(prioritized, 3);
    const permutedBatches = orchestrator.createBatches(
      [...prioritized].reverse(),
      3
    );

    expect(
      prioritizedBatches[0].some((file) => file.filename === highRisk.filename)
    ).toBe(true);
    expect(batchIds(permutedBatches)).toEqual(batchIds(prioritizedBatches));
  });

  it('preserves every unaffected production batch id after a local perturbation', () => {
    const orchestrator = new BatchOrchestrator({
      defaultBatchSize: 9,
      maxBatchSize: 9,
    });
    const files = makeFiles(211);
    const before = batchIds(orchestrator.createBatches(files, 9));
    const changed = files.map((file, index) =>
      index === 77 ? { ...file, additions: 2, changes: 2 } : file
    );
    const added = [
      ...files,
      {
        filename: 'new-local-file.ts',
        status: 'modified' as const,
        additions: 1,
        deletions: 0,
        changes: 1,
      },
    ];

    expect(
      sharedIdentityCount(
        before,
        batchIds(orchestrator.createBatches(changed, 9))
      )
    ).toBeGreaterThanOrEqual(before.length - 1);
    expect(
      sharedIdentityCount(
        before,
        batchIds(orchestrator.createBatches(added, 9))
      )
    ).toBeGreaterThanOrEqual(before.length - 1);
  });

  it('does not undercount files that prompt compaction keeps in full', () => {
    const largeFiles: FileChange[] = ['large-a.ts', 'large-b.ts'].map(
      (filename) => ({
        filename,
        status: 'modified',
        additions: 900,
        deletions: 0,
        changes: 900,
        patch: 'x'.repeat(45_000),
      })
    );
    const compacted = new BatchOrchestrator({
      defaultBatchSize: 10,
      maxBatchSize: 10,
      enableTokenAwareBatching: true,
      targetTokensPerBatch: 20_000,
      maxFullFileBytes: 40_000,
      maxFullFileChanges: 800,
    });
    const fullPatch = new BatchOrchestrator({
      defaultBatchSize: 10,
      maxBatchSize: 10,
      enableTokenAwareBatching: true,
      targetTokensPerBatch: 20_000,
      maxFullFileBytes: 60_000,
      maxFullFileChanges: 1_000,
    });

    expect(
      compacted.createTokenAwareBatches(largeFiles, ['codex/test'])
    ).toHaveLength(1);
    expect(
      fullPatch.createTokenAwareBatches(largeFiles, ['codex/test'])
    ).toHaveLength(2);
  });
});

function batchIds(batches: readonly FileChange[][]): string[] {
  return batches
    .map((members) =>
      createStableReviewBatchId({
        taskKind: ReviewTaskKind.FindingDiscovery,
        members,
      })
    )
    .sort();
}

function sharedIdentityCount(
  before: readonly string[],
  after: readonly string[]
): number {
  const afterSet = new Set(after);
  return before.filter((identity) => afterSet.has(identity)).length;
}
