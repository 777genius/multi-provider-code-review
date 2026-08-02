import {
  aggregateWorkSlotProviderResults,
  type WorkSlotProviderResult,
} from '../../../src/review-execution/domain/work-slot-provider-result';
import type { ProviderResult } from '../../../src/types';

function scoped(
  workSlotId: string,
  providerResult: ProviderResult
): WorkSlotProviderResult {
  return { workSlotId, providerResult };
}

describe('aggregateWorkSlotProviderResults', () => {
  it('does not let a later successful slot hide an earlier provider failure', () => {
    const failure = new Error('slot failed');
    const result = aggregateWorkSlotProviderResults(
      [],
      [
        scoped('slot-b', {
          name: 'codex',
          status: 'success',
          durationSeconds: 2,
          result: { content: 'second', findings: [] },
        }),
        scoped('slot-a', {
          name: 'codex',
          status: 'error',
          durationSeconds: 1,
          error: failure,
        }),
      ]
    );

    expect(result).toEqual([
      expect.objectContaining({
        name: 'codex',
        status: 'error',
        durationSeconds: 3,
        error: failure,
      }),
    ]);
  });

  it('aggregates usage, findings and target identity across every work slot', () => {
    const result = aggregateWorkSlotProviderResults(
      [],
      [
        scoped('slot-b', {
          name: 'codex',
          status: 'success',
          durationSeconds: 2,
          lifecycleAssignedTargetIds: ['target-b'],
          result: {
            content: 'second',
            findings: [
              {
                file: 'b.ts',
                line: 2,
                severity: 'major',
                title: 'B',
                message: 'B',
              },
            ],
            usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
            aiLikelihood: 0.8,
            actualModel: 'review-model',
          },
        }),
        scoped('slot-a', {
          name: 'codex',
          status: 'success',
          durationSeconds: 1,
          lifecycleAssignedTargetIds: ['target-a'],
          result: {
            content: 'first',
            findings: [
              {
                file: 'a.ts',
                line: 1,
                severity: 'minor',
                title: 'A',
                message: 'A',
              },
            ],
            usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 },
            aiLikelihood: 0.4,
            actualModel: 'review-model',
          },
        }),
      ]
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      expect.objectContaining({
        name: 'codex',
        status: 'success',
        durationSeconds: 3,
        lifecycleAssignedTargetIds: ['target-a', 'target-b'],
        result: expect.objectContaining({
          content: 'first\nsecond',
          usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 },
          actualModel: 'review-model',
        }),
      })
    );
    expect(result[0].result?.aiLikelihood).toBeCloseTo(0.6);
    expect(result[0].result?.findings?.map((finding) => finding.file)).toEqual([
      'a.ts',
      'b.ts',
    ]);
  });

  it('uses health results only for providers without executed work slots', () => {
    const health: ProviderResult[] = [
      {
        name: 'claude',
        status: 'timeout',
        durationSeconds: 5,
      },
      {
        name: 'codex',
        status: 'error',
        durationSeconds: 5,
      },
    ];

    const result = aggregateWorkSlotProviderResults(health, [
      scoped('slot-a', {
        name: 'codex',
        status: 'success',
        durationSeconds: 1,
        result: { content: '', findings: [] },
      }),
    ]);

    expect(result.map(({ name, status }) => ({ name, status }))).toEqual([
      { name: 'claude', status: 'timeout' },
      { name: 'codex', status: 'success' },
    ]);
  });
});
