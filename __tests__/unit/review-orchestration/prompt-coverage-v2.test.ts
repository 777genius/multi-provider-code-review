import { PromptBuilder } from '../../../src/analysis/llm/prompt-builder';
import type { PRContext, ReviewConfig } from '../../../src/types';
import {
  createProviderVisibleReviewCoverage,
  createReviewPromptCoverageManifest,
  isReviewPromptCoverageComplete,
  ReviewPromptPathCoverageKind,
  serializeProviderVisibleReviewCoverage,
} from '../../../src/review-orchestration/domain';

describe('prepared review prompt v2 coverage', () => {
  it('marks a giant compacted single file summary-only, never complete', async () => {
    const prepared = await builder({
      smartDiffCompaction: true,
      maxFullDiffFileBytes: 100,
      diffMaxBytes: 50_000,
    }).buildPreparedV2(pr([file('src/giant.ts', 200)], 200));

    expect(prepared.pathCoverage).toEqual([
      expect.objectContaining({
        path: 'src/giant.ts',
        kind: ReviewPromptPathCoverageKind.SummaryOnly,
      }),
    ]);
    expect(
      isReviewPromptCoverageComplete(manifest(prepared.pathCoverage))
    ).toBe(false);
  });

  it('treats configured low-signal documentation as explicitly policy-excluded', async () => {
    const prepared = await builder({
      smartDiffCompaction: true,
      maxFullDiffFileBytes: 100,
      diffMaxBytes: 50_000,
      skipTrivialChanges: true,
      skipDocumentationOnly: true,
    }).buildPreparedV2(pr([file('docs/plan.md', 200)], 200));

    expect(prepared.pathCoverage).toEqual([
      expect.objectContaining({
        path: 'docs/plan.md',
        kind: ReviewPromptPathCoverageKind.PolicyExcluded,
      }),
    ]);
    expect(
      isReviewPromptCoverageComplete(manifest(prepared.pathCoverage))
    ).toBe(true);
  });

  it('keeps mixed source and generated Dart coverage complete', async () => {
    const prepared = await builder({
      smartDiffCompaction: true,
      maxFullDiffFileBytes: 10_000,
      diffMaxBytes: 50_000,
      skipTrivialChanges: true,
      skipBuildArtifacts: true,
    }).buildPreparedV2(
      pr([file('lib/service.dart', 2), file('lib/service.g.dart', 2)], 2)
    );

    expect(prepared.pathCoverage).toEqual([
      expect.objectContaining({
        path: 'lib/service.dart',
        kind: ReviewPromptPathCoverageKind.FullPatch,
      }),
      expect.objectContaining({
        path: 'lib/service.g.dart',
        kind: ReviewPromptPathCoverageKind.PolicyExcluded,
      }),
    ]);
    expect(
      isReviewPromptCoverageComplete(manifest(prepared.pathCoverage))
    ).toBe(true);
  });

  it('keeps compacted documentation blocking when trivial skipping is disabled', async () => {
    const prepared = await builder({
      smartDiffCompaction: true,
      maxFullDiffFileBytes: 100,
      diffMaxBytes: 50_000,
      skipTrivialChanges: false,
    }).buildPreparedV2(pr([file('docs/plan.md', 200)], 200));

    expect(prepared.pathCoverage).toEqual([
      expect.objectContaining({
        path: 'docs/plan.md',
        kind: ReviewPromptPathCoverageKind.SummaryOnly,
      }),
    ]);
    expect(
      isReviewPromptCoverageComplete(manifest(prepared.pathCoverage))
    ).toBe(false);
  });

  it('marks every omitted tail path trimmed after multi-file byte trimming', async () => {
    const files = [
      file('src/a.ts', 40),
      file('src/b.ts', 40),
      file('src/c.ts', 40),
    ];
    const prepared = await builder({
      smartDiffCompaction: false,
      diffMaxBytes: 260,
    }).buildPreparedV2(pr(files, 40));

    expect(
      prepared.pathCoverage.some(
        (fact) => fact.kind === ReviewPromptPathCoverageKind.Trimmed
      )
    ).toBe(true);
    expect(
      isReviewPromptCoverageComplete(manifest(prepared.pathCoverage))
    ).toBe(false);
  });

  it('requires full-patch proof or an explicit policy exclusion for every assigned path', async () => {
    const kinds = Object.values(ReviewPromptPathCoverageKind).filter(
      (kind) => kind !== ReviewPromptPathCoverageKind.TrustedRead
    );
    for (const kind of kinds) {
      const coverage = manifest([
        {
          path: 'src/a.ts',
          kind,
          contentHash:
            kind === ReviewPromptPathCoverageKind.FullPatch
              ? 'a'.repeat(64)
              : null,
        },
      ]);
      expect(isReviewPromptCoverageComplete(coverage)).toBe(
        kind === ReviewPromptPathCoverageKind.FullPatch ||
          kind === ReviewPromptPathCoverageKind.PolicyExcluded
      );
    }
  });

  it('rejects an unvalidated trusted-read receipt', () => {
    expect(() =>
      manifest([
        {
          path: 'src/a.ts',
          kind: ReviewPromptPathCoverageKind.TrustedRead,
          contentHash: 'a'.repeat(64),
        },
      ])
    ).toThrow('review_prompt_coverage_untrusted_fact');
  });

  it('keeps provider-visible coverage stable across work slots and revisions', () => {
    const pathCoverage = [
      {
        path: 'src/a.ts',
        kind: ReviewPromptPathCoverageKind.FullPatch,
        contentHash: 'a'.repeat(64),
      },
    ];
    const first = createReviewPromptCoverageManifest({
      workSlotId: 'slot-first',
      reviewRevisionHash: '1'.repeat(64),
      assignedPaths: ['src/a.ts'],
      pathCoverage,
    });
    const second = createReviewPromptCoverageManifest({
      workSlotId: 'slot-second',
      reviewRevisionHash: '2'.repeat(64),
      assignedPaths: ['src/a.ts'],
      pathCoverage,
    });

    expect(
      serializeProviderVisibleReviewCoverage(
        createProviderVisibleReviewCoverage(first)
      )
    ).toBe(
      serializeProviderVisibleReviewCoverage(
        createProviderVisibleReviewCoverage(second)
      )
    );
  });
});

function builder(overrides: Partial<ReviewConfig>) {
  return new PromptBuilder({
    diffMaxBytes: 50_000,
    smartDiffCompaction: true,
    ...overrides,
  } as ReviewConfig);
}

function file(filename: string, bodyLines: number) {
  return {
    filename,
    status: 'modified' as const,
    additions: bodyLines,
    deletions: 0,
    changes: bodyLines,
    patch: `@@ -1,1 +1,${bodyLines} @@\n${Array.from(
      { length: bodyLines },
      (_, index) => `+const value${index} = ${index};`
    ).join('\n')}`,
  };
}

function pr(files: ReturnType<typeof file>[], bodyLines: number): PRContext {
  return {
    number: 1,
    title: 'Coverage',
    body: '',
    author: 'reviewer',
    draft: false,
    labels: [],
    files,
    diff: files
      .map(
        (item) =>
          `diff --git a/${item.filename} b/${item.filename}\n--- a/${item.filename}\n+++ b/${item.filename}\n@@ -1,1 +1,${bodyLines} @@\n${Array.from(
            { length: bodyLines },
            (_, index) => `+const value${index} = ${index};`
          ).join('\n')}`
      )
      .join('\n'),
    additions: files.reduce((sum, item) => sum + item.additions, 0),
    deletions: 0,
    baseSha: '1'.repeat(40),
    headSha: '2'.repeat(40),
  };
}

function manifest(
  pathCoverage: Parameters<
    typeof createReviewPromptCoverageManifest
  >[0]['pathCoverage']
) {
  return createReviewPromptCoverageManifest({
    workSlotId: 'slot-1',
    reviewRevisionHash: '1'.repeat(64),
    assignedPaths: pathCoverage.map((fact) => fact.path),
    pathCoverage,
  });
}
