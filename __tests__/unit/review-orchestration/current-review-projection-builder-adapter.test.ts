import { CurrentReviewProjectionBuilderAdapter } from '../../../src/review-orchestration/infrastructure';
import {
  ProjectionCoverageState,
  MergeGateConclusion,
  ReviewProjectionEnvelopeVersion,
} from '../../../src/review-projection/domain';

describe('CurrentReviewProjectionBuilderAdapter', () => {
  it('delegates all projection policy to BuildCurrentReviewProjection', async () => {
    const command = {
      scope: { reviewRevisionHash: '1'.repeat(64) },
    } as never;
    const publishing = {
      summary: { marker: 'summary' },
      check: { marker: 'check' },
      inlineReviewChunks: [{ chunkIndex: 0 }],
      lifecycle: [{ targetId: 'target-1' }],
    };
    const envelope = {
      envelopeVersion: ReviewProjectionEnvelopeVersion.V1,
      lifecycleStateHash: '2'.repeat(64),
      commandLedgerWatermark: 'watermark-1',
      coverage: { state: ProjectionCoverageState.Complete },
      mergeGate: { conclusion: MergeGateConclusion.Fail },
      publishing,
    } as never;
    const execute = jest.fn(async () => ({
      envelope,
      canonicalJson: '{"projection":true}',
      projectionHash: '3'.repeat(64),
      byteCount: 19,
      findingCount: 2,
    }));
    const create = jest.fn(async () => command);
    const adapter = new CurrentReviewProjectionBuilderAdapter(
      { execute } as never,
      { create }
    );
    const input = {
      acceptedEvidence: [],
      exhaustedWorkSlotIds: [],
      reviewRevisionHash: '1'.repeat(64),
    };

    const result = await adapter.build(input);

    expect(create).toHaveBeenCalledWith(input);
    expect(execute).toHaveBeenCalledWith(command);
    expect(result).toMatchObject({
      projectionEnvelopeVersion: 1,
      projectionEnvelopeCanonicalJson: '{"projection":true}',
      projectionHash: '3'.repeat(64),
      findingCount: 2,
      mergeGateConclusion: MergeGateConclusion.Fail,
      publicationOperationCount: 4,
      publicationChunkCount: 1,
    });
    expect(result.artifactId).toBe(`rr:artifact:${result.artifactHash}`);
    expect(JSON.parse(result.operationsCanonicalJson)).toEqual(publishing);
  });

  it('rejects a command for a different review revision', async () => {
    const adapter = new CurrentReviewProjectionBuilderAdapter(
      { execute: jest.fn() } as never,
      {
        create: jest.fn(async () => ({
          scope: { reviewRevisionHash: '2'.repeat(64) },
        })) as never,
      }
    );

    await expect(
      adapter.build({
        acceptedEvidence: [],
        exhaustedWorkSlotIds: [],
        reviewRevisionHash: '1'.repeat(64),
      })
    ).rejects.toThrow('review_projection_command_revision_mismatch');
  });
});
