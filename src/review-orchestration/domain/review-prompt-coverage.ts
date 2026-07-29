import { createHash } from 'crypto';
import {
  PreparedPromptPathCoverageKind,
  type PreparedPromptPathCoverage,
} from '../../analysis/llm/prepared-review-prompt';

export { PreparedPromptPathCoverageKind as ReviewPromptPathCoverageKind };

export type ReviewPromptCoverageManifest = Readonly<{
  version: 'review_prompt_coverage.v2';
  workSlotId: string;
  reviewRevisionHash: string;
  paths: readonly PreparedPromptPathCoverage[];
  coverageHash: string;
}>;

export type ProviderVisibleReviewCoverage = Readonly<{
  version: 'provider_visible_review_coverage.v1';
  paths: readonly PreparedPromptPathCoverage[];
  coverageHash: string;
}>;

export function createReviewPromptCoverageManifest(input: {
  readonly workSlotId: string;
  readonly reviewRevisionHash: string;
  readonly assignedPaths: readonly string[];
  readonly pathCoverage: readonly PreparedPromptPathCoverage[];
}): ReviewPromptCoverageManifest {
  if (!input.workSlotId || !/^[a-f0-9]{64}$/.test(input.reviewRevisionHash)) {
    throw new Error('review_prompt_coverage_scope_invalid');
  }
  const assigned = [...new Set(input.assignedPaths)].sort(compareCodePoints);
  if (assigned.length !== input.assignedPaths.length) {
    throw new Error('review_prompt_coverage_assigned_paths_invalid');
  }
  const byPath = new Map<string, PreparedPromptPathCoverage>();
  for (const fact of input.pathCoverage) {
    if (!fact.path || byPath.has(fact.path)) {
      throw new Error('review_prompt_coverage_path_fact_invalid');
    }
    if (
      fact.kind === PreparedPromptPathCoverageKind.TrustedRead ||
      !Object.values(PreparedPromptPathCoverageKind).includes(fact.kind) ||
      (fact.contentHash !== null && !/^[a-f0-9]{64}$/.test(fact.contentHash))
    ) {
      throw new Error('review_prompt_coverage_untrusted_fact');
    }
    byPath.set(fact.path, fact);
  }
  if (
    byPath.size !== assigned.length ||
    assigned.some((path) => !byPath.has(path))
  ) {
    throw new Error('review_prompt_coverage_path_set_mismatch');
  }
  const paths = Object.freeze(assigned.map((path) => byPath.get(path)!));
  const canonicalFacts = canonicalJson({
    paths,
    reviewRevisionHash: input.reviewRevisionHash,
    version: 'review_prompt_coverage.v2',
    workSlotId: input.workSlotId,
  });
  return Object.freeze({
    version: 'review_prompt_coverage.v2',
    workSlotId: input.workSlotId,
    reviewRevisionHash: input.reviewRevisionHash,
    paths,
    coverageHash: sha256(canonicalFacts),
  });
}

export function isReviewPromptCoverageComplete(
  manifest: ReviewPromptCoverageManifest
): boolean {
  return (
    manifest.paths.length > 0 &&
    manifest.paths.every(
      (path) =>
        path.kind === PreparedPromptPathCoverageKind.FullPatch ||
        path.kind === PreparedPromptPathCoverageKind.PolicyExcluded
    )
  );
}

export function serializeReviewPromptCoverageManifest(
  manifest: ReviewPromptCoverageManifest
): string {
  const canonical = canonicalJson({
    coverageHash: manifest.coverageHash,
    paths: manifest.paths,
    reviewRevisionHash: manifest.reviewRevisionHash,
    version: manifest.version,
    workSlotId: manifest.workSlotId,
  });
  if (
    createReviewPromptCoverageManifest({
      workSlotId: manifest.workSlotId,
      reviewRevisionHash: manifest.reviewRevisionHash,
      assignedPaths: manifest.paths.map((path) => path.path),
      pathCoverage: manifest.paths,
    }).coverageHash !== manifest.coverageHash
  ) {
    throw new Error('review_prompt_coverage_hash_mismatch');
  }
  return canonical;
}

export function createProviderVisibleReviewCoverage(
  manifest: ReviewPromptCoverageManifest
): ProviderVisibleReviewCoverage {
  const paths = Object.freeze(manifest.paths.map((entry) => ({ ...entry })));
  return Object.freeze({
    version: 'provider_visible_review_coverage.v1',
    paths,
    coverageHash: sha256(
      canonicalJson({
        paths,
        version: 'provider_visible_review_coverage.v1',
      })
    ),
  });
}

export function serializeProviderVisibleReviewCoverage(
  coverage: ProviderVisibleReviewCoverage
): string {
  const canonical = canonicalJson({
    coverageHash: coverage.coverageHash,
    paths: coverage.paths,
    version: coverage.version,
  });
  if (
    createProviderVisibleReviewCoverage(
      createReviewPromptCoverageManifest({
        workSlotId: 'semantic-validation',
        reviewRevisionHash: '0'.repeat(64),
        assignedPaths: coverage.paths.map((entry) => entry.path),
        pathCoverage: coverage.paths,
      })
    ).coverageHash !== coverage.coverageHash
  ) {
    throw new Error('provider_visible_review_coverage_hash_mismatch');
  }
  return canonical;
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort(compareCodePoints)
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
