import {
  REVIEW_INVESTIGATION_PROBE_LIMITS,
  REVIEW_INVESTIGATION_PROBE_SELECTION_POLICY_VERSION,
  ReviewInvestigationChangedFileStatus,
  ReviewInvestigationProbeKind,
  ReviewInvestigationProbePlanStatus,
  createReviewInvestigationProbePlan,
  reviewInvestigationSearchOperationInputHash,
} from '../../../src/review-investigation/domain/deterministic-context-probe-plan';
import {
  canonicalJson,
  sha256,
} from '../../../src/review-investigation/domain/canonical-json';
import { ReviewTurnObligationKind } from '../../../src/review-investigation/domain/turn-observation';

describe('deterministic context probe plan', () => {
  it('derives bounded typed probes from full changed lines and path facts', () => {
    const plan = createReviewInvestigationProbePlan({
      files: [
        file('src/service.ts'),
        file('config/routes.yaml'),
        file(
          'src/new-name.ts',
          ReviewInvestigationChangedFileStatus.Renamed,
          'src/old-name.ts'
        ),
        file(
          'src/deleted-worker.ts',
          ReviewInvestigationChangedFileStatus.Removed
        ),
      ],
      fullDiff: [
        diff(
          'src/service.ts',
          '-export function changedApi(): number { return 1; }',
          '+export function changedApi(): string { return "1"; }',
          '+export { SharedContract } from "./contracts/shared";',
          '+emit("user.deleted");',
          '+requirePermission("admin");',
          '+cache.invalidate("users[0].*");',
          '+featureFlag("new-checkout");',
          '+deleteUser();'
        ),
        diff(
          'config/routes.yaml',
          '-"required":["tenantId"]',
          '+"required":[]',
          '+route: "/v1/users/:id"'
        ),
      ].join('\n'),
    });

    expect(plan.status).toBe(ReviewInvestigationProbePlanStatus.Complete);
    if (plan.status !== ReviewInvestigationProbePlanStatus.Complete) {
      throw new Error('expected_complete_probe_plan');
    }
    expect(plan.limits).toEqual(REVIEW_INVESTIGATION_PROBE_LIMITS);
    expect(plan.probes.map((probe) => probe.query)).toEqual(
      [...plan.probes.map((probe) => probe.query)].sort()
    );
    expect(new Set(plan.probes.map((probe) => probe.query)).size).toBe(
      plan.probes.length
    );

    expect(probe(plan, 'changedApi')).toMatchObject({
      probeKind: ReviewInvestigationProbeKind.DeclarationIdentifier,
      obligationKind: ReviewTurnObligationKind.DirectReferenceSearch,
    });
    expect(probe(plan, 'SharedContract')).toMatchObject({
      probeKind: ReviewInvestigationProbeKind.ImportExportIdentifier,
    });
    expect(probe(plan, './contracts/shared')).toMatchObject({
      probeKind: ReviewInvestigationProbeKind.ModulePath,
    });
    expect(probe(plan, 'tenantId')).toMatchObject({
      probeKind: ReviewInvestigationProbeKind.StructuredKey,
      obligationKind: ReviewTurnObligationKind.ConfigurationContract,
    });
    expect(probe(plan, '/v1/users/:id')).toMatchObject({
      probeKind: ReviewInvestigationProbeKind.RuntimeContractIdentifier,
      obligationKind: ReviewTurnObligationKind.ConfigurationContract,
    });
    expect(probe(plan, 'user.deleted')).toMatchObject({
      probeKind: ReviewInvestigationProbeKind.SideEffectIdentifier,
      obligationKind: ReviewTurnObligationKind.SideEffectParity,
    });
    expect(probe(plan, 'requirePermission')).toMatchObject({
      probeKind: ReviewInvestigationProbeKind.RuntimeContractIdentifier,
    });
    expect(probe(plan, 'deleteUser')).toMatchObject({
      probeKind: ReviewInvestigationProbeKind.SideEffectIdentifier,
    });
    expect(probe(plan, 'src/old-name.ts')).toMatchObject({
      probeKind: ReviewInvestigationProbeKind.PreviousPath,
    });
    expect(probe(plan, 'src/deleted-worker.ts')).toMatchObject({
      probeKind: ReviewInvestigationProbeKind.PreviousPath,
    });
    expect(probe(plan, 'src/service.ts')).toMatchObject({
      probeKind: ReviewInvestigationProbeKind.BasenameFallback,
    });
    expect(probe(plan, 'new-checkout')).toMatchObject({
      probeKind: ReviewInvestigationProbeKind.RuntimeContractIdentifier,
    });
    expect(probe(plan, 'users[0].*')).toMatchObject({
      probeKind: ReviewInvestigationProbeKind.SideEffectIdentifier,
    });
  });

  it('deduplicates by maximum risk with a deterministic source tie-break', () => {
    const files = [
      file('src/z.ts'),
      file('src/a.ts'),
      file('src/auth/z.ts'),
      file('src/auth/a.ts'),
    ];
    const fullDiff = [
      diff(
        'src/z.ts',
        '+export function sharedApi() {}',
        '+export function normalApi() {}',
        '+export function sharedKind() {}'
      ),
      diff(
        'src/a.ts',
        '+import { sharedKind } from "./contracts";',
        '+export function sharedApi() {}',
        '+export function normalApi() {}'
      ),
      diff('src/auth/z.ts', '+export function sharedApi() {}'),
      diff('src/auth/a.ts', '+export function sharedApi() {}'),
    ].join('\n');
    const first = createReviewInvestigationProbePlan({ files, fullDiff });
    const second = createReviewInvestigationProbePlan({
      files: [...files].reverse(),
      fullDiff,
    });

    expect(first).toEqual(second);
    expect(first.planHash).toBe(second.planHash);
    expect(
      first.probes.filter((item) => item.query === 'sharedApi')
    ).toHaveLength(1);
    expect(probe(first, 'sharedApi')).toMatchObject({
      sourcePath: 'src/auth/a.ts',
      riskPriority: 900_000,
    });
    expect(probe(first, 'normalApi')).toMatchObject({
      sourcePath: 'src/a.ts',
      riskPriority: 500_000,
    });
    expect(probe(first, 'sharedKind')).toMatchObject({
      sourcePath: 'src/a.ts',
      probeKind: ReviewInvestigationProbeKind.ImportExportIdentifier,
      riskPriority: 500_000,
    });
  });

  it('rejects broad generic probes before applying candidate limits', () => {
    const plan = createReviewInvestigationProbePlan({
      files: [file('src/data.ts')],
      fullDiff: diff(
        'src/data.ts',
        '+export function get() {}',
        '+export function load() {}',
        '+export function read() {}',
        '+export const id = 1;',
        '+export const data = {};',
        '+export const result = null;',
        '+export const route = "/users/:id";',
        '+export function getUser() {}'
      ),
      limits: { maxProbesPerFile: 3, maxProbesOverall: 3 },
    });

    expect(plan.status).toBe(ReviewInvestigationProbePlanStatus.Complete);
    expect(plan.probes.map((item) => item.query)).toEqual([
      '/users/:id',
      'getUser',
      'src/data.ts',
    ]);
    expect(plan.probes.map((item) => item.query)).not.toEqual(
      expect.arrayContaining([
        'get',
        'load',
        'read',
        'id',
        'route',
        'data',
        'result',
      ])
    );
  });

  it('keeps the highest-risk per-file probes with a deterministic truncation witness', () => {
    const plan = createReviewInvestigationProbePlan({
      files: [file('src/service.ts')],
      fullDiff: diff(
        'src/service.ts',
        '+export const first = 1;',
        '+export const second = 2;'
      ),
      limits: { maxProbesPerFile: 2, maxProbesOverall: 4 },
    });

    expect(plan).toMatchObject({
      status: ReviewInvestigationProbePlanStatus.Complete,
      exceededLimit: null,
      selectionWitness: {
        policyVersion: REVIEW_INVESTIGATION_PROBE_SELECTION_POLICY_VERSION,
        perFileTruncations: [
          {
            sourcePathHash: sha256('src/service.ts'),
            maximum: 2,
            discardedCandidateOccurrences: 1,
          },
        ],
        overallTruncation: null,
      },
    });
    expect(plan.probes.map((item) => item.query)).toEqual(['first', 'second']);
  });

  it('keeps the highest-risk global probes with a deterministic truncation witness', () => {
    const plan = createReviewInvestigationProbePlan({
      files: [file('src/a.ts'), file('src/b.ts')],
      fullDiff: [
        diff('src/a.ts', '+export const alpha = 1;'),
        diff('src/b.ts', '+export const beta = 2;'),
      ].join('\n'),
      limits: { maxProbesPerFile: 3, maxProbesOverall: 3 },
    });

    expect(plan).toMatchObject({
      status: ReviewInvestigationProbePlanStatus.Complete,
      exceededLimit: null,
      selectionWitness: {
        policyVersion: REVIEW_INVESTIGATION_PROBE_SELECTION_POLICY_VERSION,
        perFileTruncations: [],
        overallTruncation: {
          maximum: 3,
          discardedCandidateOccurrences: 1,
        },
      },
    });
    expect(plan.probes).toHaveLength(3);
    expect(plan.probes.map((item) => item.query)).toEqual([
      'alpha',
      'beta',
      'src/a.ts',
    ]);
  });

  it('binds regex metacharacters as an exact fixed-string query', () => {
    const plan = createReviewInvestigationProbePlan({
      files: [file('src/cache.ts')],
      fullDiff: diff('src/cache.ts', '+cache.invalidate("users[0].*");'),
    });
    const exact = probe(plan, 'users[0].*');
    const subject = JSON.parse(exact.canonicalSubject);
    const requirement = JSON.parse(exact.canonicalRequirement);

    expect(requirement).toMatchObject({
      matchMode: 'fixed_string',
      pageSize: 500,
      paths: ['.'],
      probeKind: ReviewInvestigationProbeKind.SideEffectIdentifier,
      query: 'users[0].*',
      queryHash: sha256('users[0].*'),
      requirementVersion: 2,
      revision: 'head',
      searchPolicyVersion: 'review-investigation-fixed-string-search.v1',
      sourcePathHash: sha256('src/cache.ts'),
      initialOperationInputHash:
        reviewInvestigationSearchOperationInputHash('users[0].*'),
    });
    expect(Object.keys(requirement).sort()).toEqual([
      'initialOperationInputHash',
      'kind',
      'matchMode',
      'operationKind',
      'pageSize',
      'paths',
      'probeKind',
      'query',
      'queryHash',
      'requirementVersion',
      'revision',
      'searchPolicyVersion',
      'sourcePathHash',
    ]);
    expect(Object.keys(subject).sort()).toEqual([
      'initialOperationInputHash',
      'kind',
      'matchMode',
      'obligationKind',
      'probeKind',
      'queryHash',
      'subjectVersion',
    ]);
    expect(subject).toMatchObject({
      matchMode: 'fixed_string',
      probeKind: ReviewInvestigationProbeKind.SideEffectIdentifier,
      queryHash: sha256('users[0].*'),
    });
    expect(exact.queryHash).toBe(sha256('users[0].*'));
    expect(exact.initialOperationInputHash).toBe(
      sha256(
        canonicalJson({
          caseSensitive: true,
          cursor: null,
          pageSize: 500,
          paths: ['.'],
          query: sha256('users[0].*'),
          revision: 'head',
        })
      )
    );
  });
});

function file(
  path: string,
  status = ReviewInvestigationChangedFileStatus.Modified,
  previousPath: string | null = null
) {
  return Object.freeze({ path, previousPath, status, patch: null });
}

function diff(path: string, ...lines: readonly string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    ...lines,
  ].join('\n');
}

function probe(
  plan: ReturnType<typeof createReviewInvestigationProbePlan>,
  query: string
) {
  const result = plan.probes.find((candidate) => candidate.query === query);
  if (!result) throw new Error(`probe_missing:${query}`);
  return result;
}
