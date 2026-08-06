import { createHash } from 'crypto';
import {
  BuildCurrentReviewProjection,
  type BuildCurrentReviewProjectionCommand,
} from '../../review-projection/application';
import { ProjectionCoverageState } from '../../review-projection/domain';
import type {
  AcceptedReviewWorkSlotEvidence,
  CurrentReviewProjection,
  CurrentReviewProjectionBuilderPort,
} from '../application';

export interface ReviewProjectionCommandFactoryPort {
  create(input: {
    readonly acceptedEvidence: readonly AcceptedReviewWorkSlotEvidence[];
    readonly exhaustedWorkSlotIds: readonly string[];
    readonly reviewRevisionHash: string;
  }): Promise<BuildCurrentReviewProjectionCommand>;
}

/**
 * Maps the projection context's immutable result into the transport artifact.
 * Finding selection, lineage, lifecycle, placement and merge-gate policy stay
 * exclusively inside BuildCurrentReviewProjection.
 */
export class CurrentReviewProjectionBuilderAdapter implements CurrentReviewProjectionBuilderPort {
  constructor(
    private readonly projection: BuildCurrentReviewProjection,
    private readonly commands: ReviewProjectionCommandFactoryPort
  ) {}

  async build(
    input: Parameters<CurrentReviewProjectionBuilderPort['build']>[0]
  ): Promise<CurrentReviewProjection> {
    const command = await this.commands.create(input);
    if (command.scope.reviewRevisionHash !== input.reviewRevisionHash) {
      throw new Error('review_projection_command_revision_mismatch');
    }
    const built = await this.projection.execute(command);
    const operationsCanonicalJson = canonicalJson(built.envelope.publishing);
    const artifactHash = sha256(
      `rr.review-artifact.v1\0${canonicalJson({
        operationsCanonicalJson,
        projectionHash: built.projectionHash,
      })}`
    );
    return Object.freeze({
      artifactId: `rr:artifact:${artifactHash}`,
      artifactHash,
      projectionEnvelopeVersion: 1,
      projectionEnvelopeCanonicalJson: built.canonicalJson,
      projectionHash: built.projectionHash,
      lifecycleStateHash: built.envelope.lifecycleStateHash,
      commandLedgerWatermark: built.envelope.commandLedgerWatermark,
      operationsCanonicalJson,
      findingCount: built.findingCount,
      mergeGateConclusion: built.envelope.mergeGate.conclusion,
      publicationOperationCount:
        2 +
        built.envelope.publishing.inlineReviewChunks.length +
        built.envelope.publishing.lifecycle.length,
      publicationChunkCount:
        built.envelope.publishing.inlineReviewChunks.length,
      coverageComplete:
        built.envelope.coverage.state === ProjectionCoverageState.Complete,
    });
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
