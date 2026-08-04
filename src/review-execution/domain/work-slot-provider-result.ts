import type { ProviderResult, ReviewResult, TokenUsage } from '../../types';

export interface WorkSlotProviderResult {
  readonly workSlotId: string;
  readonly providerResult: ProviderResult;
}

const EMPTY_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

/**
 * Produces one deterministic provider summary without discarding work-slot
 * outcomes. A provider is successful only when every executed slot succeeded.
 */
export function aggregateWorkSlotProviderResults(
  healthResults: readonly ProviderResult[],
  workSlotResults: readonly WorkSlotProviderResult[]
): ProviderResult[] {
  const healthByProvider = new Map(
    [...healthResults]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((result) => [result.name, result] as const)
  );
  const workByProvider = new Map<string, WorkSlotProviderResult[]>();

  for (const scoped of [...workSlotResults].sort(compareScopedResults)) {
    const provider = scoped.providerResult.name;
    const existing = workByProvider.get(provider) ?? [];
    existing.push(scoped);
    workByProvider.set(provider, existing);
  }

  const providerNames = new Set([
    ...healthByProvider.keys(),
    ...workByProvider.keys(),
  ]);

  return [...providerNames]
    .sort((left, right) => left.localeCompare(right))
    .map((provider) => {
      const scoped = workByProvider.get(provider);
      if (!scoped || scoped.length === 0) {
        return healthByProvider.get(provider)!;
      }
      return aggregateProvider(provider, scoped);
    });
}

function aggregateProvider(
  provider: string,
  scopedResults: readonly WorkSlotProviderResult[]
): ProviderResult {
  const results = scopedResults.map((scoped) => scoped.providerResult);
  const firstFailure = results.find((result) => result.status !== 'success');
  const successfulReviews = results.flatMap((result) =>
    result.status === 'success' && result.result ? [result.result] : []
  );
  const aggregateResult = aggregateSuccessfulReviews(successfulReviews);

  return {
    name: provider,
    status: firstFailure?.status ?? 'success',
    durationSeconds: results.reduce(
      (total, result) => total + Math.max(0, result.durationSeconds),
      0
    ),
    ...(aggregateResult ? { result: aggregateResult } : {}),
    ...(firstFailure?.error ? { error: firstFailure.error } : {}),
    lifecycleAssignedTargetIds: [
      ...new Set(
        results.flatMap((result) => result.lifecycleAssignedTargetIds ?? [])
      ),
    ].sort((left, right) => left.localeCompare(right)),
  };
}

function aggregateSuccessfulReviews(
  reviews: readonly ReviewResult[]
): ReviewResult | undefined {
  if (reviews.length === 0) return undefined;

  const usage = reviews.reduce<TokenUsage>(
    (total, review) => ({
      promptTokens: total.promptTokens + (review.usage?.promptTokens ?? 0),
      completionTokens:
        total.completionTokens + (review.usage?.completionTokens ?? 0),
      totalTokens: total.totalTokens + (review.usage?.totalTokens ?? 0),
    }),
    EMPTY_USAGE
  );
  const likelihoods = reviews.flatMap((review) =>
    typeof review.aiLikelihood === 'number' ? [review.aiLikelihood] : []
  );
  const models = new Set(
    reviews.flatMap((review) =>
      review.actualModel ? [review.actualModel] : []
    )
  );

  return {
    content: reviews
      .map((review) => review.content)
      .filter(Boolean)
      .join('\n'),
    findings: reviews.flatMap((review) => review.findings ?? []),
    revalidations: reviews.flatMap((review) => review.revalidations ?? []),
    usage,
    durationSeconds: reviews.reduce(
      (total, review) => total + Math.max(0, review.durationSeconds ?? 0),
      0
    ),
    transportAttemptCount: reviews.reduce(
      (total, review) => total + Math.max(0, review.transportAttemptCount ?? 0),
      0
    ),
    ...(likelihoods.length > 0
      ? {
          aiLikelihood:
            likelihoods.reduce((total, value) => total + value, 0) /
            likelihoods.length,
        }
      : {}),
    ...(models.size === 1 ? { actualModel: [...models][0] } : {}),
  };
}

function compareScopedResults(
  left: WorkSlotProviderResult,
  right: WorkSlotProviderResult
): number {
  return (
    left.workSlotId.localeCompare(right.workSlotId) ||
    left.providerResult.name.localeCompare(right.providerResult.name)
  );
}
