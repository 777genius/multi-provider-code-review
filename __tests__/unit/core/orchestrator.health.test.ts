import {
  ReviewOrchestrator,
  ReviewComponents,
} from '../../../src/core/orchestrator';
import {
  ReviewConfig,
  PRContext,
  Finding,
  FileChange,
  LifecycleThreadRecord,
  ProviderResult,
  PullRequestLoadOmissionReason,
  PullRequestLoadStatus,
} from '../../../src/types';
import { Provider } from '../../../src/providers/base';
import { DEFAULT_CONFIG } from '../../../src/config/defaults';
import { IncrementalReviewPlanMode } from '../../../src/cache/incremental';
import { PullRequestLoader } from '../../../src/github/pr-loader';
import { GitHubClient } from '../../../src/github/client';
import { findingFingerprintFromFinding } from '../../../src/github/comment-fingerprint';

// Minimal helpers
const emptyReview: any = {
  summary: '',
  findings: [],
  inlineComments: [],
  actionItems: [],
  metrics: {
    totalFindings: 0,
    critical: 0,
    major: 0,
    minor: 0,
    providersUsed: 0,
    providersSuccess: 0,
    providersFailed: 0,
    totalTokens: 0,
    totalCost: 0,
    durationSeconds: 0,
  },
  runDetails: {
    providers: [],
    totalCost: 0,
    totalTokens: 0,
    durationSeconds: 0,
    cacheHit: false,
    synthesisModel: '',
    providerPoolSize: 0,
  },
};

function makeOrchestrator(
  overrides: Partial<ReviewComponents & { config: ReviewConfig }>
) {
  const providers: Provider[] = [
    {
      name: 'p1',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider,
  ];

  const config: ReviewConfig = {
    ...DEFAULT_CONFIG,
    dryRun: true,
    enableCaching: false,
    analyticsEnabled: false,
    graphEnabled: false,
    providers: [],
    fallbackProviders: [],
    providerLimit: 4,
  };

  const components: ReviewComponents = {
    config,
    providerRegistry: {
      createProviders: jest.fn().mockResolvedValue(providers),
      discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
    } as any,
    promptBuilder: { build: jest.fn().mockReturnValue('prompt') } as any,
    llmExecutor: {
      filterHealthyProviders: jest.fn(),
      execute: jest.fn(() => {
        throw new Error(
          'execute should not be called when no healthy providers'
        );
      }),
    } as any,
    deduplicator: { dedupe: (f: Finding[]) => f } as any,
    consensus: { filter: (f: Finding[]) => f } as any,
    synthesis: {
      synthesize: jest
        .fn()
        .mockImplementation(() => JSON.parse(JSON.stringify(emptyReview))),
    } as any,
    testCoverage: { analyze: jest.fn().mockReturnValue(undefined) } as any,
    astAnalyzer: { analyze: jest.fn().mockReturnValue([]) } as any,
    cache: { load: jest.fn().mockResolvedValue(null), save: jest.fn() } as any,
    incrementalReviewer: {
      shouldUseIncremental: jest.fn().mockResolvedValue(false),
      getLastReview: jest.fn(),
      mergeFindings: jest.fn(),
      generateIncrementalSummary: jest.fn(),
      saveReview: jest.fn(),
      getChangedFilesSince: jest.fn(),
      getIncrementalChangeSet: jest.fn(),
    } as any,
    costTracker: {
      record: jest.fn(),
      summary: jest
        .fn()
        .mockReturnValue({ totalCost: 0, totalTokens: 0, breakdown: {} }),
      reset: jest.fn(),
    } as any,
    security: { scan: jest.fn().mockReturnValue([]) } as any,
    rules: { run: jest.fn().mockReturnValue([]) } as any,
    prLoader: { load: jest.fn() } as any,
    commentPoster: {
      postSummary: jest.fn(),
      postInline: jest.fn(),
      deleteSummaryComments: jest.fn(),
    } as any,
    formatter: { format: jest.fn().mockReturnValue('') } as any,
    contextRetriever: {
      findRelatedContext: jest.fn().mockReturnValue([]),
    } as any,
    impactAnalyzer: { analyze: jest.fn().mockReturnValue([]) } as any,
    evidenceScorer: {
      score: jest.fn().mockReturnValue({ confidence: 1 }),
    } as any,
    mermaidGenerator: {
      generateImpactDiagram: jest.fn().mockReturnValue(''),
    } as any,
    feedbackFilter: {
      loadSuppressed: jest.fn().mockResolvedValue([]),
      loadReviewCommentState: jest.fn().mockResolvedValue({
        suppressed: new Set(),
        alreadyPosted: new Set(),
      }),
      shouldPost: jest.fn().mockReturnValue(true),
    } as any,
    reliabilityTracker: {
      isCircuitOpen: jest.fn().mockResolvedValue(false),
      rankProviders: jest.fn().mockResolvedValue([]),
      recordResult: jest.fn(),
    } as any,
    promptGenerator: {
      generateFixPrompts: jest.fn().mockReturnValue([]),
      saveToFile: jest.fn(),
    } as any,
    quietModeFilter: undefined,
    graphBuilder: undefined,
    feedbackTracker: undefined,
    metricsCollector: undefined,
    batchOrchestrator: undefined,
    githubClient: undefined,
  } as any;

  Object.assign(components, overrides);
  return new ReviewOrchestrator(components);
}

function makePR(files: FileChange[]): PRContext {
  const normalizedFiles = files.map((file, index) => ({
    ...file,
    patch:
      file.patch ?? `@@ -0,0 +1 @@\n+export const fixture${index} = ${index};`,
  }));
  return {
    number: 1,
    title: 't',
    author: 'a',
    draft: false,
    labels: [],
    additions: 0,
    deletions: 0,
    files: normalizedFiles,
    diff: normalizedFiles
      .map((file) =>
        [
          `diff --git a/${file.filename} b/${file.filename}`,
          `--- a/${file.filename}`,
          `+++ b/${file.filename}`,
          file.patch,
        ].join('\n')
      )
      .join('\n'),
    baseSha: 'b',
    headSha: 'h',
    body: '',
  };
}

describe('ReviewOrchestrator health check guard rails', () => {
  const originalProgressComments = process.env.REVIEW_ROUTER_PROGRESS_COMMENTS;
  const originalCompleteProviderCoverage =
    process.env.REQUIRE_COMPLETE_PROVIDER_COVERAGE;

  afterEach(() => {
    if (originalProgressComments === undefined) {
      delete process.env.REVIEW_ROUTER_PROGRESS_COMMENTS;
    } else {
      process.env.REVIEW_ROUTER_PROGRESS_COMMENTS = originalProgressComments;
    }
    if (originalCompleteProviderCoverage === undefined) {
      delete process.env.REQUIRE_COMPLETE_PROVIDER_COVERAGE;
    } else {
      process.env.REQUIRE_COMPLETE_PROVIDER_COVERAGE =
        originalCompleteProviderCoverage;
    }
  });

  it('does not initialize graph, memory, or providers for an already reviewed head', async () => {
    const finding: Finding = {
      file: 'src/a.ts',
      line: 1,
      severity: 'major',
      title: 'Existing finding',
      message: 'Already reviewed',
    };
    const providerRegistry = {
      createProviders: jest.fn(),
      discoverAdditionalFreeProviders: jest.fn(),
    } as any;
    const graphBuilder = {
      buildGraph: jest.fn(),
      updateGraph: jest.fn(),
    } as any;
    const memoryBundleProvider = {
      fetchBundleForPullRequest: jest.fn(),
    } as any;
    const commentPoster = {
      postSummary: jest.fn(),
      postInline: jest.fn(),
      deleteSummaryComments: jest.fn(),
    } as any;
    const incrementalReviewer = {
      planReview: jest.fn().mockResolvedValue({
        mode: IncrementalReviewPlanMode.ReuseCompleted,
        files: [],
        invalidatedPaths: [],
        lastReview: {
          prNumber: 1,
          lastReviewedCommit: 'h',
          baseSha: 'b',
          timestamp: Date.now(),
          findings: [finding],
          reviewSummary: 'Previous completed review',
        },
      }),
      mergeFindings: jest.fn().mockReturnValue([finding]),
      generateIncrementalSummary: jest
        .fn()
        .mockReturnValue('Reused completed review'),
      saveReview: jest.fn(),
    } as any;
    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        analyticsEnabled: false,
        enableCaching: false,
        graphEnabled: true,
        graphCacheEnabled: false,
        skipTrivialChanges: false,
      },
      providerRegistry,
      graphBuilder,
      memoryBundleProvider,
      incrementalReviewer,
      commentPoster,
      formatter: { format: jest.fn().mockReturnValue('Cached review') } as any,
    });

    const review = await orchestrator.executeReview(
      makePR([
        {
          filename: 'src/a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ])
    );

    expect(review.findings).toEqual([finding]);
    expect(providerRegistry.createProviders).not.toHaveBeenCalled();
    expect(graphBuilder.buildGraph).not.toHaveBeenCalled();
    expect(graphBuilder.updateGraph).not.toHaveBeenCalled();
    expect(
      memoryBundleProvider.fetchBundleForPullRequest
    ).not.toHaveBeenCalled();
    expect(
      (orchestrator as any).components.llmExecutor.execute
    ).not.toHaveBeenCalled();
    expect(
      (orchestrator as any).components.synthesis.synthesize
    ).not.toHaveBeenCalled();
    expect(incrementalReviewer.mergeFindings).not.toHaveBeenCalled();
    expect(
      incrementalReviewer.generateIncrementalSummary
    ).not.toHaveBeenCalled();
    expect(incrementalReviewer.saveReview).not.toHaveBeenCalled();
    expect(
      (orchestrator as any).components.feedbackFilter.loadReviewCommentState
    ).toHaveBeenCalledWith(1, 'h');
    expect(review.summary).toBe('Previous completed review');
    expect(review.metrics.cached).toBe(true);
    expect(review.findingProvenance).toEqual({
      fromCurrentReview: { critical: 0, major: 0, minor: 0 },
      carriedForward: { critical: 0, major: 1, minor: 0 },
    });
    expect(commentPoster.postSummary).toHaveBeenCalledWith(
      1,
      'Cached review',
      true,
      expect.objectContaining({ reviewedHeadSha: 'h' })
    );
  });

  it('rejects completed snapshot reuse when complete provider coverage is required', async () => {
    process.env.REQUIRE_COMPLETE_PROVIDER_COVERAGE = 'true';
    const finding: Finding = {
      file: 'src/a.ts',
      line: 1,
      severity: 'major',
      title: 'Existing finding',
      message: 'Already reviewed',
    };
    const providerRegistry = {
      createProviders: jest.fn(),
      discoverAdditionalFreeProviders: jest.fn(),
    } as any;
    const format = jest.fn().mockReturnValue('Cached review');
    const postSummary = jest.fn();
    const postInline = jest.fn();
    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        analyticsEnabled: false,
        enableCaching: false,
        graphEnabled: false,
        skipTrivialChanges: false,
      },
      providerRegistry,
      incrementalReviewer: {
        planReview: jest.fn().mockResolvedValue({
          mode: IncrementalReviewPlanMode.ReuseCompleted,
          files: [],
          invalidatedPaths: [],
          lastReview: {
            prNumber: 1,
            lastReviewedCommit: 'h',
            baseSha: 'b',
            timestamp: Date.now(),
            findings: [finding],
            reviewSummary: 'Previous completed review',
          },
        }),
      } as any,
      formatter: { format } as any,
      commentPoster: {
        postSummary,
        postInline,
        deleteSummaryComments: jest.fn(),
      } as any,
    });

    await expect(
      orchestrator.executeReview(
        makePR([
          {
            filename: 'src/a.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
          },
        ])
      )
    ).rejects.toThrow(
      /Completed incremental snapshot cannot satisfy REQUIRE_COMPLETE_PROVIDER_COVERAGE/
    );

    expect(providerRegistry.createProviders).not.toHaveBeenCalled();
    expect(format).not.toHaveBeenCalled();
    expect(postSummary).not.toHaveBeenCalled();
    expect(postInline).not.toHaveBeenCalled();
  });

  it('preserves REST inline dedupe fallback when GraphQL lifecycle inventory fails', async () => {
    const finding: Finding = {
      file: 'src/a.ts',
      line: 1,
      severity: 'major',
      title: 'Current finding',
      message: 'Current review output.',
    };
    const restReference = {
      path: 'src/existing.ts',
      line: 2,
      body: 'existing ReviewRouter inline comment',
    };
    const commentState = {
      suppressed: new Set<string>(),
      alreadyPosted: new Set(['rest-signature']),
      suppressedComments: [],
      alreadyPostedComments: [restReference],
      commandDismissed: new Set<string>(),
      commandDismissedLocations: new Set<string>(),
    };
    const postInline = jest.fn();
    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        analyticsEnabled: false,
        enableCaching: false,
        graphEnabled: false,
        skipTrivialChanges: false,
        reviewThreadLifecycle: 'report',
        providers: [],
        fallbackProviders: [],
      },
      githubClient: { owner: 'owner', repo: 'repo' } as any,
      reviewThreadInventory: {
        load: jest.fn().mockResolvedValue({
          candidates: [],
          manualAttention: [],
          dedupeComments: [],
          warnings: ['GraphQL unavailable'],
          failed: true,
        }),
      } as any,
      feedbackFilter: {
        loadReviewCommentState: jest.fn().mockResolvedValue(commentState),
        shouldPost: jest.fn(() => true),
        isFindingCommandDismissed: jest.fn(() => false),
        isInlineCommandDismissed: jest.fn(() => false),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [],
          healthCheckResults: [],
        }),
        execute: jest.fn(),
      } as any,
      synthesis: {
        synthesize: jest.fn().mockReturnValue({
          ...JSON.parse(JSON.stringify(emptyReview)),
          findings: [finding],
          inlineComments: [
            {
              path: finding.file,
              line: finding.line,
              side: 'RIGHT',
              severity: finding.severity,
              title: finding.title,
              body: finding.message,
            },
          ],
          metrics: {
            ...emptyReview.metrics,
            totalFindings: 1,
            major: 1,
          },
        }),
      } as any,
      astAnalyzer: { analyze: jest.fn().mockReturnValue([finding]) } as any,
      commentPoster: {
        postSummary: jest.fn(),
        postInline,
        deleteSummaryComments: jest.fn(),
      } as any,
    });

    await orchestrator.executeReview(
      makePR([
        {
          filename: 'src/a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ])
    );

    expect(commentState.alreadyPosted).toEqual(new Set(['rest-signature']));
    expect(commentState.alreadyPostedComments).toEqual([restReference]);
    expect(postInline).toHaveBeenCalledWith(
      1,
      expect.any(Array),
      expect.any(Array),
      'h',
      undefined
    );
  });

  it('re-projects current dismissals and human replies for an already reviewed head', async () => {
    const dismissedFinding: Finding = {
      file: 'src/dismissed.ts',
      line: 4,
      severity: 'major',
      title: 'Dismissed finding',
      message: 'No longer relevant by maintainer command.',
    };
    const retainedFinding: Finding = {
      file: 'src/active.ts',
      line: 8,
      severity: 'major',
      title: 'Active finding',
      message: 'Still active on this revision.',
    };
    const markerResolvedFinding: Finding = {
      file: 'src/resolved.ts',
      line: 12,
      severity: 'major',
      title: 'Resolved finding',
      message: 'A trusted fallback reply already recorded this as resolved.',
    };
    const providerRegistry = {
      createProviders: jest.fn(),
      discoverAdditionalFreeProviders: jest.fn(),
    } as any;
    const loadReviewCommentState = jest.fn().mockResolvedValue({
      suppressed: new Set(),
      alreadyPosted: new Set(),
      suppressedComments: [],
      alreadyPostedComments: [],
      commandDismissed: new Set(['dismissed']),
      commandDismissedLocations: new Set(),
      commandDismissedComments: [],
    });
    const humanReplyTarget = {
      targetId: 'thread-1',
      threadId: 'thread-1',
      fingerprint: 'a'.repeat(24),
      severity: 'major' as const,
      title: 'Earlier finding with reply',
      message: 'Maintainer replied to this thread.',
      originalPath: 'src/active.ts',
      currentPath: 'src/active.ts',
      originalLine: 8,
      currentLine: 8,
      parentCommentId: 'comment-1',
      parentCommentUpdatedAt: '2026-07-22T00:00:00.000Z',
      threadCommentCount: 2,
      viewerCanResolve: true,
      hasHumanReply: true,
      trustedAuthor: true,
    };
    const markerResolvedTarget = {
      targetId: 'thread-resolved-1',
      threadId: 'thread-resolved-1',
      fingerprint: findingFingerprintFromFinding(markerResolvedFinding),
      severity: 'major' as const,
      title: markerResolvedFinding.title,
      message: markerResolvedFinding.message,
      originalPath: markerResolvedFinding.file,
      currentPath: markerResolvedFinding.file,
      originalLine: markerResolvedFinding.line,
      currentLine: markerResolvedFinding.line,
      parentCommentId: 'comment-resolved-1',
      parentCommentUpdatedAt: '2026-07-22T00:00:00.000Z',
      threadCommentCount: 2,
      viewerCanResolve: false,
      hasHumanReply: false,
      trustedAuthor: true,
      trustedResolutionMarker: {
        schemaVersion: 'reviewrouter-lifecycle-resolution.v1' as const,
        targetId: 'thread-resolved-1',
        fingerprint: findingFingerprintFromFinding(markerResolvedFinding),
        commentId: 'resolution-reply-1',
        commentUpdatedAt: '2026-07-22T00:01:00.000Z',
      },
    };
    const loadInventory = jest.fn().mockResolvedValue({
      headRefOid: 'h',
      candidates: [markerResolvedTarget],
      manualAttention: [
        { target: humanReplyTarget, reasonCodes: ['human_reply'] },
      ],
      dedupeComments: [],
      warnings: [],
      failed: false,
    });
    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        analyticsEnabled: false,
        enableCaching: false,
        graphEnabled: false,
        skipTrivialChanges: false,
        reviewThreadLifecycle: 'report',
      },
      providerRegistry,
      githubClient: { owner: 'owner', repo: 'repo' } as any,
      reviewThreadInventory: { load: loadInventory } as any,
      feedbackFilter: {
        loadReviewCommentState,
        isFindingCommandDismissed: jest.fn(
          (finding: Finding) => finding.title === dismissedFinding.title
        ),
        isInlineCommandDismissed: jest.fn(() => false),
        shouldPost: jest.fn(() => true),
      } as any,
      incrementalReviewer: {
        planReview: jest.fn().mockResolvedValue({
          mode: IncrementalReviewPlanMode.ReuseCompleted,
          files: [],
          invalidatedPaths: [],
          lastReview: {
            prNumber: 1,
            lastReviewedCommit: 'h',
            baseSha: 'b',
            timestamp: Date.now(),
            findings: [
              dismissedFinding,
              retainedFinding,
              markerResolvedFinding,
            ],
            reviewSummary: 'Previous completed review',
          },
        }),
        saveReview: jest.fn(),
      } as any,
      formatter: { format: jest.fn().mockReturnValue('Cached review') } as any,
    });

    const review = await orchestrator.executeReview(
      makePR([
        {
          filename: 'src/active.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ])
    );

    expect(loadReviewCommentState).toHaveBeenCalledWith(1, 'h');
    expect(loadInventory).toHaveBeenCalledWith(1);
    expect(providerRegistry.createProviders).not.toHaveBeenCalled();
    expect(review.findings).toEqual([retainedFinding]);
    expect(review.metrics.dismissedFindings).toBe(1);
    expect(review.findingProvenance?.carriedForward).toEqual({
      critical: 0,
      major: 1,
      minor: 0,
    });
    expect(review.threadLifecycle?.manualAttention).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ targetId: 'thread-1' }),
        reasonCodes: expect.arrayContaining(['human_reply']),
      }),
    ]);
  });

  it('marks unchanged-file findings as carried forward in a delta review', async () => {
    const carriedFinding: Finding = {
      file: 'src/unchanged.ts',
      line: 7,
      severity: 'major',
      title: 'Existing finding',
      message: 'Still applies to an unchanged file.',
    };
    const incrementalReviewer = {
      planReview: jest.fn().mockResolvedValue({
        mode: IncrementalReviewPlanMode.Delta,
        files: [],
        invalidatedPaths: [],
        lastReview: {
          prNumber: 1,
          lastReviewedCommit: 'previous-head',
          baseSha: 'b',
          timestamp: Date.now(),
          findings: [carriedFinding],
          reviewSummary: 'Previous review',
        },
      }),
      mergeFindings: jest.fn().mockReturnValue([carriedFinding]),
      generateIncrementalSummary: jest.fn().mockReturnValue('Delta review'),
      saveReview: jest.fn(),
    } as any;
    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        skipTrivialChanges: false,
        incrementalEnabled: true,
        providers: [],
        fallbackProviders: [],
      },
      incrementalReviewer,
    });

    const review = await orchestrator.executeReview(
      makePR([
        {
          filename: 'docs/update.md',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ])
    );

    expect(review.findingProvenance).toEqual({
      fromCurrentReview: { critical: 0, major: 0, minor: 0 },
      carriedForward: { critical: 0, major: 1, minor: 0 },
    });
    expect(incrementalReviewer.mergeFindings).toHaveBeenCalledWith(
      [carriedFinding],
      [],
      [],
      []
    );
  });

  it('preserves finding provenance when an incremental adapter clones findings', async () => {
    const changedFile: FileChange = {
      filename: 'src/changed.ts',
      status: 'modified',
      additions: 1,
      deletions: 0,
      changes: 1,
    };
    const carriedFinding: Finding = {
      file: 'src/unchanged.ts',
      line: 7,
      severity: 'critical',
      title: 'Existing finding',
      message: 'Still applies to an unchanged file.',
    };
    const currentFinding: Finding = {
      file: changedFile.filename,
      line: 1,
      severity: 'major',
      title: 'Current finding',
      message: 'Produced while reviewing the changed file.',
    };
    const incrementalReviewer = {
      planReview: jest.fn().mockResolvedValue({
        mode: IncrementalReviewPlanMode.Delta,
        files: [changedFile],
        invalidatedPaths: [],
        lastReview: {
          prNumber: 1,
          lastReviewedCommit: 'previous-head',
          baseSha: 'b',
          timestamp: Date.now(),
          findings: [carriedFinding],
          reviewSummary: 'Previous review',
        },
      }),
      mergeFindings: jest
        .fn()
        .mockImplementation((previous: Finding[], current: Finding[]) =>
          JSON.parse(JSON.stringify([...previous, ...current]))
        ),
      generateIncrementalSummary: jest.fn().mockReturnValue('Delta review'),
      saveReview: jest.fn(),
    } as any;
    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        skipTrivialChanges: false,
        incrementalEnabled: true,
        providers: [],
        fallbackProviders: [],
      },
      incrementalReviewer,
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue([]),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [],
          healthCheckResults: [],
        }),
        execute: jest.fn(),
      } as any,
      synthesis: {
        synthesize: jest.fn().mockReturnValue({
          ...emptyReview,
          findings: [currentFinding],
        }),
      } as any,
    });

    const review = await orchestrator.executeReview(makePR([changedFile]));

    expect(review.findingProvenance).toEqual({
      fromCurrentReview: { critical: 0, major: 1, minor: 0 },
      carriedForward: { critical: 1, major: 0, minor: 0 },
    });
  });

  it('deactivates a carried finding after a trusted lifecycle fallback reply is posted', async () => {
    const changedFile: FileChange = {
      filename: 'src/unchanged.ts',
      status: 'modified',
      additions: 1,
      deletions: 0,
      changes: 1,
    };
    const carriedFinding: Finding = {
      file: changedFile.filename,
      line: 7,
      severity: 'major',
      title: 'Missing imported module',
      message: 'The imported module does not exist.',
    };
    const lifecycleTarget = {
      targetId: 'thread-carried-1',
      threadId: 'thread-carried-1',
      threadUrl: 'https://github.test/thread/carried-1',
      fingerprint: findingFingerprintFromFinding(carriedFinding),
      severity: 'major' as const,
      title: carriedFinding.title,
      message: carriedFinding.message,
      originalPath: carriedFinding.file,
      currentPath: carriedFinding.file,
      originalLine: carriedFinding.line,
      currentLine: carriedFinding.line,
      parentCommentId: 'comment-carried-1',
      parentCommentUpdatedAt: '2026-07-22T00:00:00.000Z',
      threadCommentCount: 1,
      viewerCanResolve: true,
      hasHumanReply: false,
      trustedAuthor: true,
    };
    const provider = {
      name: 'p1',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider;
    const providerResult: ProviderResult = {
      name: provider.name,
      status: 'success',
      durationSeconds: 1,
      result: {
        content: '{}',
        findings: [],
        revalidations: [
          {
            targetId: lifecycleTarget.targetId,
            fingerprint: lifecycleTarget.fingerprint,
            verdict: 'resolved',
            confidence: 0.99,
            evidence: [
              {
                path: carriedFinding.file,
                reason: 'The imported module exists on the current head.',
              },
            ],
            rationale: 'The old failure mode is gone.',
          },
        ],
      },
    };
    const resolveGuarded = jest
      .fn()
      .mockImplementation(
        async (
          _prNumber: number,
          _headSha: string,
          records: LifecycleThreadRecord[]
        ) => ({
          resolved: [],
          manualAttention: [],
          skipped: [],
          failed: records.map((record) => ({
            ...record,
            reasonCodes: [
              ...record.reasonCodes,
              'mutation_permission_denied' as const,
              'resolution_comment_posted' as const,
            ],
            errorMessage: 'Resource not accessible by integration',
          })),
          warnings: [],
        })
      );
    const loadInventory = jest
      .fn()
      .mockResolvedValueOnce({
        headRefOid: 'h',
        candidates: [lifecycleTarget],
        manualAttention: [],
        dedupeComments: [],
        warnings: [],
        failed: false,
      })
      .mockResolvedValue({
        headRefOid: 'h',
        candidates: [],
        manualAttention: [],
        dedupeComments: [],
        warnings: [],
        failed: false,
      });
    const incrementalReviewer = {
      planReview: jest.fn().mockResolvedValue({
        mode: IncrementalReviewPlanMode.Delta,
        files: [changedFile],
        invalidatedPaths: [],
        lastReview: {
          prNumber: 1,
          lastReviewedCommit: 'previous-head',
          baseSha: 'b',
          timestamp: Date.now(),
          findings: [carriedFinding],
          reviewSummary: 'Previous review',
        },
      }),
      mergeFindings: jest.fn().mockReturnValue([carriedFinding]),
      generateIncrementalSummary: jest.fn().mockReturnValue('Delta review'),
      saveReview: jest.fn(),
    } as any;
    const commentState = {
      suppressed: new Set<string>(),
      alreadyPosted: new Set<string>(),
      suppressedComments: [],
      alreadyPostedComments: [],
      commandDismissed: new Set<string>(),
      commandDismissedLocations: new Set<string>(),
      commandDismissedComments: [],
    };
    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        skipTrivialChanges: false,
        incrementalEnabled: true,
        reviewThreadLifecycle: 'resolve',
        providers: [provider.name],
        fallbackProviders: [],
        providerLimit: 1,
      },
      githubClient: { owner: 'owner', repo: 'repo' } as any,
      reviewThreadInventory: { load: loadInventory } as any,
      reviewThreadResolver: { resolveGuarded } as any,
      feedbackFilter: {
        loadReviewCommentState: jest.fn().mockResolvedValue(commentState),
        shouldPost: jest.fn().mockReturnValue(true),
        isFindingCommandDismissed: jest.fn().mockReturnValue(false),
        isInlineCommandDismissed: jest.fn().mockReturnValue(false),
      } as any,
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue([provider]),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [provider],
          healthCheckResults: [],
        }),
        execute: jest.fn().mockResolvedValue([providerResult]),
      } as any,
      synthesis: {
        synthesize: jest.fn().mockReturnValue({
          ...JSON.parse(JSON.stringify(emptyReview)),
          findings: [],
        }),
      } as any,
      incrementalReviewer,
    });

    const review = await orchestrator.executeReview(makePR([changedFile]));

    expect(resolveGuarded).toHaveBeenCalledWith(
      1,
      'h',
      expect.arrayContaining([
        expect.objectContaining({
          target: expect.objectContaining({
            targetId: lifecycleTarget.targetId,
          }),
        }),
      ])
    );
    expect(review.findings).toEqual([]);
    expect(review.metrics).toMatchObject({
      totalFindings: 0,
      major: 0,
    });
    expect(review.findingProvenance).toEqual({
      fromCurrentReview: { critical: 0, major: 0, minor: 0 },
      carriedForward: { critical: 0, major: 0, minor: 0 },
    });
    expect(review.threadLifecycle?.resolvedByLifecycle).toHaveLength(0);
    expect(review.threadLifecycle?.mutationFailed).toEqual([
      expect.objectContaining({
        reasonCodes: expect.arrayContaining([
          'mutation_permission_denied',
          'resolution_comment_posted',
        ]),
      }),
    ]);
  });

  it('detects a trivial PR before building its code graph', async () => {
    const graphBuilder = {
      buildGraph: jest.fn(),
      updateGraph: jest.fn(),
    } as any;
    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        analyticsEnabled: false,
        graphEnabled: true,
        graphCacheEnabled: false,
        skipTrivialChanges: true,
      },
      graphBuilder,
    });

    await orchestrator.executeReview(
      makePR([
        {
          filename: 'README.md',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ])
    );

    expect(graphBuilder.buildGraph).not.toHaveBeenCalled();
    expect(graphBuilder.updateGraph).not.toHaveBeenCalled();
  });

  it('short-circuits LLM execution when no healthy providers and records reliability', async () => {
    const healthResults: ProviderResult[] = [
      { name: 'p1', status: 'timeout', durationSeconds: 0 } as any,
    ];

    const orchestrator = makeOrchestrator({
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [],
          healthCheckResults: healthResults,
        }),
        execute: jest.fn(),
      } as any,
    });

    const pr = makePR([
      {
        filename: 'a.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
      },
    ]);

    const review = await orchestrator.executeReview(pr);

    expect(review).toBeTruthy();
    expect(
      (orchestrator as any).components.llmExecutor.execute
    ).not.toHaveBeenCalled();
    expect(
      (orchestrator as any).components.reliabilityTracker.recordResult
    ).toHaveBeenCalledWith('p1', false, 0, undefined);
  });

  it('executes LLM review with one explicit healthy provider', async () => {
    const provider = {
      name: 'p1',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider;
    const execute = jest.fn().mockResolvedValue([
      {
        name: 'p1',
        status: 'success',
        result: {
          content: '{"findings":[]}',
          findings: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
        durationSeconds: 0,
      } as ProviderResult,
    ]);

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: ['p1'],
        fallbackProviders: [],
        providerLimit: 1,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue([provider]),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [provider],
          healthCheckResults: [],
        }),
        execute,
      } as any,
    });

    const pr = makePR([
      {
        filename: 'a.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
      },
    ]);

    const review = await orchestrator.executeReview(pr);

    expect(review).toBeTruthy();
    expect(execute).toHaveBeenCalledWith(
      [provider],
      expect.any(String),
      expect.any(Number)
    );
  });

  it('does not post GitHub comments for a clean review', async () => {
    const provider = {
      name: 'p1',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider;
    const postSummary = jest.fn();
    const postInline = jest.fn();
    const deleteSummaryComments = jest.fn();

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: false,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: ['p1'],
        fallbackProviders: [],
        providerLimit: 1,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue([provider]),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [provider],
          healthCheckResults: [],
        }),
        execute: jest.fn().mockResolvedValue([
          {
            name: 'p1',
            status: 'success',
            result: {
              content: '{"findings":[]}',
              findings: [],
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            },
            durationSeconds: 0,
          } as ProviderResult,
        ]),
      } as any,
      commentPoster: {
        postSummary,
        postInline,
        deleteSummaryComments,
      } as any,
      formatter: { format: jest.fn().mockReturnValue('## All Clear!') } as any,
    });

    const pr = makePR([
      {
        filename: 'a.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
      },
    ]);

    const review = await orchestrator.executeReview(pr);

    expect(review.findings).toHaveLength(0);
    expect(postSummary).not.toHaveBeenCalled();
    expect(deleteSummaryComments).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ reviewedHeadSha: 'h' }),
      'no reportable findings were found'
    );
    expect(postInline).toHaveBeenCalledWith(1, [], pr.files, 'h');
  });

  it('creates a progress comment by default for the first GitHub review', async () => {
    delete process.env.REVIEW_ROUTER_PROGRESS_COMMENTS;
    const provider = {
      name: 'p1',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider;
    const createComment = jest.fn().mockResolvedValue({ data: { id: 456 } });
    const updateComment = jest.fn().mockResolvedValue({});
    const listIssueComments = jest.fn().mockResolvedValue({ data: [] });
    const listReviewComments = jest.fn().mockResolvedValue({ data: [] });

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: false,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: ['p1'],
        fallbackProviders: [],
        providerLimit: 1,
      },
      githubClient: {
        owner: 'owner',
        repo: 'repo',
        octokit: {
          rest: {
            issues: {
              listComments: listIssueComments,
              createComment,
              updateComment,
            },
            pulls: {
              listReviewComments,
            },
          },
        },
      } as any,
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue([provider]),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [provider],
          healthCheckResults: [],
        }),
        execute: jest.fn().mockResolvedValue([
          {
            name: 'p1',
            status: 'success',
            result: {
              content: '{"findings":[]}',
              findings: [],
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            },
            durationSeconds: 0,
          } as ProviderResult,
        ]),
      } as any,
      formatter: { format: jest.fn().mockReturnValue('## All Clear!') } as any,
    });

    await orchestrator.executeReview(
      makePR([
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ])
    );

    expect(listIssueComments).toHaveBeenCalled();
    expect(listReviewComments).toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 1,
        body: expect.stringContaining('## 🤖 ReviewRouter Progress'),
      })
    );
    expect(updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 456,
        body: expect.stringContaining('Build code graph'),
      })
    );
    expect(updateComment).toHaveBeenLastCalledWith(
      expect.objectContaining({
        comment_id: 456,
        body: expect.stringContaining('## All Clear!'),
      })
    );
    expect(updateComment.mock.calls.at(-1)?.[0].body).not.toContain(
      '<!-- review-router-progress-tracker -->'
    );
  });

  it('skips default progress when the PR already has ReviewRouter activity', async () => {
    delete process.env.REVIEW_ROUTER_PROGRESS_COMMENTS;
    const provider = {
      name: 'p1',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider;
    const createComment = jest.fn();
    const listIssueComments = jest.fn().mockResolvedValue({
      data: [
        {
          id: 99,
          body: '<!-- review-router-bot -->\n\n# ReviewRouter\nold summary',
        },
      ],
    });
    const listReviewComments = jest.fn().mockResolvedValue({ data: [] });

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: false,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: ['p1'],
        fallbackProviders: [],
        providerLimit: 1,
      },
      githubClient: {
        owner: 'owner',
        repo: 'repo',
        octokit: {
          rest: {
            issues: {
              listComments: listIssueComments,
              createComment,
              updateComment: jest.fn(),
            },
            pulls: {
              listReviewComments,
            },
          },
        },
      } as any,
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue([provider]),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [provider],
          healthCheckResults: [],
        }),
        execute: jest.fn().mockResolvedValue([
          {
            name: 'p1',
            status: 'success',
            result: {
              content: '{"findings":[]}',
              findings: [],
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            },
            durationSeconds: 0,
          } as ProviderResult,
        ]),
      } as any,
      formatter: { format: jest.fn().mockReturnValue('## All Clear!') } as any,
    });

    await orchestrator.executeReview(
      makePR([
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ])
    );

    expect(listIssueComments).toHaveBeenCalled();
    expect(listReviewComments).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });

  it('reuses progress-only comments instead of treating them as completed activity', async () => {
    delete process.env.REVIEW_ROUTER_PROGRESS_COMMENTS;
    const provider = {
      name: 'p1',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider;
    const createComment = jest.fn();
    const updateComment = jest.fn().mockResolvedValue({});
    const listIssueComments = jest.fn().mockResolvedValue({
      data: [
        {
          id: 99,
          body: '## 🤖 ReviewRouter Progress\n\n<!-- review-router-progress-tracker -->',
        },
      ],
    });
    const listReviewComments = jest.fn().mockResolvedValue({ data: [] });

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: false,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: ['p1'],
        fallbackProviders: [],
        providerLimit: 1,
      },
      githubClient: {
        owner: 'owner',
        repo: 'repo',
        octokit: {
          rest: {
            issues: {
              listComments: listIssueComments,
              createComment,
              updateComment,
            },
            pulls: {
              listReviewComments,
            },
          },
        },
      } as any,
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue([provider]),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [provider],
          healthCheckResults: [],
        }),
        execute: jest.fn().mockResolvedValue([
          {
            name: 'p1',
            status: 'success',
            result: {
              content: '{"findings":[]}',
              findings: [],
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            },
            durationSeconds: 0,
          } as ProviderResult,
        ]),
      } as any,
      formatter: { format: jest.fn().mockReturnValue('## All Clear!') } as any,
    });

    await orchestrator.executeReview(
      makePR([
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ])
    );

    expect(listIssueComments).toHaveBeenCalled();
    expect(listReviewComments).toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).toHaveBeenLastCalledWith(
      expect.objectContaining({
        comment_id: 99,
        body: expect.stringContaining('## All Clear!'),
      })
    );
    expect(updateComment.mock.calls.at(-1)?.[0].body).not.toContain(
      '<!-- review-router-progress-tracker -->'
    );
  });

  it('does not create progress comments when explicitly disabled', async () => {
    process.env.REVIEW_ROUTER_PROGRESS_COMMENTS = 'false';
    const provider = {
      name: 'p1',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider;
    const createComment = jest.fn();
    const listIssueComments = jest.fn().mockResolvedValue({ data: [] });

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: false,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: ['p1'],
        fallbackProviders: [],
        providerLimit: 1,
      },
      githubClient: {
        owner: 'owner',
        repo: 'repo',
        octokit: {
          rest: {
            issues: {
              listComments: listIssueComments,
              createComment,
              updateComment: jest.fn(),
            },
            pulls: {
              listReviewComments: jest.fn(),
            },
          },
        },
      } as any,
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue([provider]),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [provider],
          healthCheckResults: [],
        }),
        execute: jest.fn().mockResolvedValue([
          {
            name: 'p1',
            status: 'success',
            result: {
              content: '{"findings":[]}',
              findings: [],
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            },
            durationSeconds: 0,
          } as ProviderResult,
        ]),
      } as any,
      formatter: { format: jest.fn().mockReturnValue('## All Clear!') } as any,
    });

    await orchestrator.executeReview(
      makePR([
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ])
    );

    expect(listIssueComments).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });

  it('continues when one provider succeeds and other providers degrade', async () => {
    const previousFailOnNoHealthy = process.env.FAIL_ON_NO_HEALTHY_PROVIDERS;
    process.env.FAIL_ON_NO_HEALTHY_PROVIDERS = 'true';

    const providers = ['p1', 'p2', 'p3', 'p4'].map(
      (name) =>
        ({
          name,
          review: jest.fn(),
          healthCheck: jest.fn(),
        }) as unknown as Provider
    );
    const finding: Finding = {
      file: 'a.ts',
      line: 1,
      severity: 'major',
      title: 'Runtime exception',
      message:
        'The changed line dereferences config.value after config is assigned null, so this path will throw at runtime.',
    };
    const synthesize = jest.fn(
      (
        findings: Finding[],
        _reviewPR: PRContext,
        _testHints: unknown,
        _aiAnalysis: unknown,
        _providerResults: ProviderResult[],
        runDetails: unknown
      ) => ({
        ...emptyReview,
        summary: 'summary',
        findings,
        metrics: {
          ...emptyReview.metrics,
          totalFindings: findings.length,
          major: findings.length,
        },
        runDetails,
      })
    );

    try {
      const orchestrator = makeOrchestrator({
        config: {
          ...DEFAULT_CONFIG,
          dryRun: true,
          enableCaching: false,
          analyticsEnabled: false,
          graphEnabled: false,
          providers: providers.map((provider) => provider.name),
          fallbackProviders: [],
          providerLimit: 4,
          inlineMinSeverity: 'minor',
        },
        providerRegistry: {
          createProviders: jest.fn().mockResolvedValue(providers),
          discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
        } as any,
        llmExecutor: {
          filterHealthyProviders: jest.fn().mockResolvedValue({
            healthy: providers,
            healthCheckResults: [],
          }),
          execute: jest.fn().mockResolvedValue([
            {
              name: 'p1',
              status: 'success',
              result: {
                content:
                  '{"findings":[{"file":"a.ts","line":1,"severity":"major","title":"Runtime exception","message":"runtime crash"}]}',
                findings: [finding],
              },
              durationSeconds: 1,
            } as ProviderResult,
            {
              name: 'p2',
              status: 'error',
              error: new Error(
                'OpenRouter returned invalid review JSON: response was not valid JSON'
              ),
              durationSeconds: 1,
            } as ProviderResult,
            {
              name: 'p3',
              status: 'timeout',
              error: new Error('Provider timed out after 600000ms'),
              durationSeconds: 600,
            } as ProviderResult,
            {
              name: 'p4',
              status: 'error',
              error: new Error(
                'OpenRouter returned invalid review JSON: expected an object with a findings array'
              ),
              durationSeconds: 1,
            } as ProviderResult,
          ]),
        } as any,
        synthesis: { synthesize } as any,
      });

      const diff = 'diff --git a/a.ts b/a.ts\n@@ -0,0 +1 @@\n+config.value\n';
      const pr = makePR([
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: '@@ -0,0 +1 @@\n+config.value\n',
        },
      ]);
      pr.diff = diff;

      const review = await orchestrator.executeReview(pr);

      expect(review.findings).toContainEqual(expect.objectContaining(finding));
      expect(review.metrics.providersSuccess).toBe(1);
      expect(review.metrics.providersFailed).toBe(3);
      expect(review.runDetails?.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'p1', status: 'success' }),
          expect.objectContaining({ name: 'p2', status: 'error' }),
          expect.objectContaining({ name: 'p3', status: 'timeout' }),
          expect.objectContaining({ name: 'p4', status: 'error' }),
        ])
      );
    } finally {
      if (previousFailOnNoHealthy === undefined) {
        delete process.env.FAIL_ON_NO_HEALTHY_PROVIDERS;
      } else {
        process.env.FAIL_ON_NO_HEALTHY_PROVIDERS = previousFailOnNoHealthy;
      }
    }
  });

  it('fails when a required healthy provider fails health checks', async () => {
    const providers = ['codex/gpt-5.5', 'openrouter/free'].map(
      (name) =>
        ({
          name,
          review: jest.fn(),
          healthCheck: jest.fn(),
        }) as unknown as Provider
    );

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: providers.map((provider) => provider.name),
        requiredHealthyProviders: ['codex/gpt-5.5'],
        fallbackProviders: [],
        providerLimit: 2,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue(providers),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [providers[1]],
          healthCheckResults: [
            {
              name: 'codex/gpt-5.5',
              status: 'timeout',
              error: new Error('health check timed out'),
              durationSeconds: 30,
            } as ProviderResult,
            {
              name: 'openrouter/free',
              status: 'success',
              durationSeconds: 0.1,
            } as ProviderResult,
          ],
        }),
        execute: jest.fn(),
      } as any,
    });

    await expect(
      orchestrator.executeReview(
        makePR([
          {
            filename: 'a.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
          },
        ])
      )
    ).rejects.toThrow(
      /Required healthy provider codex\/gpt-5\.5 failed health check/
    );
  });

  it('fails when a required healthy provider fails execution while another provider succeeds', async () => {
    const providers = ['codex/gpt-5.5', 'openrouter/free'].map(
      (name) =>
        ({
          name,
          review: jest.fn(),
          healthCheck: jest.fn(),
        }) as unknown as Provider
    );

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: providers.map((provider) => provider.name),
        requiredHealthyProviders: ['codex/gpt-5.5'],
        fallbackProviders: [],
        providerLimit: 2,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue(providers),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: providers,
          healthCheckResults: [],
        }),
        execute: jest.fn().mockResolvedValue([
          {
            name: 'codex/gpt-5.5',
            status: 'timeout',
            error: new Error('Codex CLI timed out after 600000ms'),
            durationSeconds: 600,
          } as ProviderResult,
          {
            name: 'openrouter/free',
            status: 'success',
            result: {
              content: '{"findings":[],"revalidations":[]}',
              findings: [],
              revalidations: [],
            },
            durationSeconds: 1,
          } as ProviderResult,
        ]),
      } as any,
    });

    await expect(
      orchestrator.executeReview(
        makePR([
          {
            filename: 'a.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
          },
        ])
      )
    ).rejects.toThrow(
      /Required healthy provider codex\/gpt-5\.5 failed during review/
    );
  });

  it('fails when a required healthy provider only returns a health-check-shaped success', async () => {
    const providers = ['codex/gpt-5.5'].map(
      (name) =>
        ({
          name,
          review: jest.fn(),
          healthCheck: jest.fn(),
        }) as unknown as Provider
    );

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: providers.map((provider) => provider.name),
        requiredHealthyProviders: ['codex/gpt-5.5'],
        fallbackProviders: [],
        providerLimit: 1,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue(providers),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: providers,
          healthCheckResults: [
            {
              name: 'codex/gpt-5.5',
              status: 'success',
              durationSeconds: 0.01,
            } as ProviderResult,
          ],
        }),
        execute: jest.fn().mockResolvedValue([
          {
            name: 'codex/gpt-5.5',
            status: 'success',
            durationSeconds: 0.01,
          } as ProviderResult,
        ]),
      } as any,
    });

    await expect(
      orchestrator.executeReview(
        makePR([
          {
            filename: 'a.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
          },
        ])
      )
    ).rejects.toThrow(
      /Required healthy provider codex\/gpt-5\.5 did not return a review result/
    );
  });

  it('fails when a required healthy provider succeeds in one batch but fails in another', async () => {
    const providers = ['codex/gpt-5.5', 'openrouter/free'].map(
      (name) =>
        ({
          name,
          review: jest.fn(),
          healthCheck: jest.fn(),
        }) as unknown as Provider
    );
    const execute = jest
      .fn()
      .mockResolvedValueOnce([
        {
          name: 'codex/gpt-5.5',
          status: 'success',
          result: {
            content: '{"findings":[],"revalidations":[]}',
            findings: [],
            revalidations: [],
          },
          durationSeconds: 1,
        } as ProviderResult,
        {
          name: 'openrouter/free',
          status: 'success',
          result: {
            content: '{"findings":[],"revalidations":[]}',
            findings: [],
            revalidations: [],
          },
          durationSeconds: 1,
        } as ProviderResult,
      ])
      .mockResolvedValueOnce([
        {
          name: 'codex/gpt-5.5',
          status: 'error',
          error: new Error('returned invalid review JSON after retries'),
          durationSeconds: 3,
        } as ProviderResult,
        {
          name: 'openrouter/free',
          status: 'success',
          result: {
            content: '{"findings":[],"revalidations":[]}',
            findings: [],
            revalidations: [],
          },
          durationSeconds: 1,
        } as ProviderResult,
      ]);

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: providers.map((provider) => provider.name),
        requiredHealthyProviders: ['codex/gpt-5.5'],
        fallbackProviders: [],
        providerLimit: 2,
        batchMaxFiles: 1,
        enableTokenAwareBatching: false,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue(providers),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: providers,
          healthCheckResults: [],
        }),
        execute,
      } as any,
    });

    await expect(
      orchestrator.executeReview(
        makePR([
          {
            filename: 'a.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
          },
          {
            filename: 'b.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
          },
        ])
      )
    ).rejects.toThrow(
      /Required healthy provider codex\/gpt-5\.5 failed during review/
    );
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('publishes partial coverage without advancing the completed snapshot', async () => {
    const provider = {
      name: 'codex/gpt-5.5',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider;
    const execute = jest
      .fn()
      .mockResolvedValueOnce([
        {
          name: provider.name,
          status: 'success',
          result: {
            content: '{"findings":[],"revalidations":[]}',
            findings: [],
            revalidations: [],
          },
          durationSeconds: 1,
        } as ProviderResult,
      ])
      .mockResolvedValueOnce([
        {
          name: provider.name,
          status: 'error',
          error: new Error('capacity_unavailable'),
          durationSeconds: 1,
        } as ProviderResult,
      ]);
    const saveReview = jest.fn();
    const format = jest.fn().mockReturnValue('');
    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        incrementalEnabled: true,
        providers: [provider.name],
        requiredHealthyProviders: [],
        fallbackProviders: [],
        providerLimit: 1,
        batchMaxFiles: 1,
        enableTokenAwareBatching: false,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue([provider]),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [provider],
          healthCheckResults: [],
        }),
        execute,
      } as any,
      incrementalReviewer: {
        shouldUseIncremental: jest.fn().mockResolvedValue(false),
        getLastReview: jest.fn(),
        mergeFindings: jest.fn(),
        generateIncrementalSummary: jest.fn(),
        saveReview,
        getChangedFilesSince: jest.fn(),
        getIncrementalChangeSet: jest.fn(),
      } as any,
      formatter: { format } as any,
    });

    const review = await orchestrator.executeReview(
      makePR([
        {
          filename: 'src/first.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
        {
          filename: 'src/second.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ])
    );

    expect(review.coverage).toMatchObject({
      complete: false,
      unreviewedFiles: 1,
    });
    expect(review.coverage?.files).toContainEqual(
      expect.objectContaining({
        path: 'src/second.ts',
        status: 'unreviewed',
      })
    );
    expect(saveReview).not.toHaveBeenCalled();
    expect(
      format.mock.calls.some(
        ([formattedReview]) => formattedReview.coverage?.complete === false
      )
    ).toBe(true);
  });

  it('fails closed before caching or publication when complete provider coverage is required', async () => {
    process.env.REQUIRE_COMPLETE_PROVIDER_COVERAGE = 'true';
    const provider = {
      name: 'codex/gpt-5.5',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider;
    const execute = jest
      .fn()
      .mockResolvedValueOnce([
        {
          name: provider.name,
          status: 'success',
          result: {
            content: '{"findings":[],"revalidations":[]}',
            findings: [],
            revalidations: [],
          },
          durationSeconds: 1,
        } as ProviderResult,
      ])
      .mockResolvedValueOnce([
        {
          name: provider.name,
          status: 'error',
          error: new Error("You've hit your usage limit"),
          durationSeconds: 1,
        } as ProviderResult,
      ]);
    const cacheLoad = jest.fn().mockResolvedValue(null);
    const cacheSave = jest.fn();
    const postSummary = jest.fn();
    const postInline = jest.fn();
    const createProgressComment = jest.fn();
    const updateProgressComment = jest.fn();
    const listIssueComments = jest.fn();
    const listReviewComments = jest.fn();
    const getPullRequest = jest.fn();
    const format = jest.fn().mockReturnValue('');
    const commitSuccessfulBatch = jest.fn();
    const finalize = jest.fn();
    const openReviewCheckpointSession = jest.fn().mockResolvedValue({
      acceptedBatchResults: new Map(),
      commitSuccessfulBatch,
      finalize,
    });
    const saveReview = jest.fn();
    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: false,
        enableCaching: true,
        analyticsEnabled: false,
        graphEnabled: false,
        incrementalEnabled: true,
        providers: [provider.name],
        requiredHealthyProviders: [],
        fallbackProviders: [],
        providerLimit: 1,
        batchMaxFiles: 1,
        enableTokenAwareBatching: false,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue([provider]),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [provider],
          healthCheckResults: [],
        }),
        execute,
      } as any,
      cache: { load: cacheLoad, save: cacheSave } as any,
      incrementalReviewer: {
        shouldUseIncremental: jest.fn().mockResolvedValue(false),
        getLastReview: jest.fn(),
        mergeFindings: jest.fn(),
        generateIncrementalSummary: jest.fn(),
        saveReview,
        getChangedFilesSince: jest.fn(),
        getIncrementalChangeSet: jest.fn(),
      } as any,
      formatter: { format } as any,
      commentPoster: {
        postSummary,
        postInline,
        deleteSummaryComments: jest.fn(),
      } as any,
      githubClient: {
        owner: 'owner',
        repo: 'repo',
        octokit: {
          rest: {
            issues: {
              listComments: listIssueComments,
              createComment: createProgressComment,
              updateComment: updateProgressComment,
            },
            pulls: {
              get: getPullRequest,
              listReviewComments,
            },
          },
        },
      } as any,
      openReviewCheckpointSession,
    });

    await expect(
      orchestrator.executeReview(
        makePR([
          {
            filename: 'src/first.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
          },
          {
            filename: 'src/second.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
          },
        ])
      )
    ).rejects.toThrow(
      /Provider review coverage is incomplete \(1 failed batch\(es\), 1 batch\(es\) with successful output, 2 planned\)/
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(cacheLoad).toHaveBeenCalledTimes(1);
    expect(cacheSave).not.toHaveBeenCalled();
    expect(saveReview).not.toHaveBeenCalled();
    expect(commitSuccessfulBatch).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
    expect(format).not.toHaveBeenCalled();
    expect(postSummary).not.toHaveBeenCalled();
    expect(postInline).not.toHaveBeenCalled();
    expect(listIssueComments).not.toHaveBeenCalled();
    expect(listReviewComments).not.toHaveBeenCalled();
    expect(getPullRequest).not.toHaveBeenCalled();
    expect(createProgressComment).not.toHaveBeenCalled();
    expect(updateProgressComment).not.toHaveBeenCalled();
  });

  it('fails closed when batching produces no work for nonempty review files', async () => {
    process.env.REQUIRE_COMPLETE_PROVIDER_COVERAGE = 'true';
    const provider = {
      name: 'codex/gpt-5.5',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider;
    const execute = jest.fn();
    const cacheSave = jest.fn();
    const postSummary = jest.fn();
    const postInline = jest.fn();
    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: true,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: [provider.name],
        requiredHealthyProviders: [],
        fallbackProviders: [],
        providerLimit: 1,
        enableTokenAwareBatching: false,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue([provider]),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [provider],
          healthCheckResults: [],
        }),
        execute,
      } as any,
      batchOrchestrator: {
        getBatchSize: jest.fn().mockReturnValue(1),
        createBatches: jest.fn().mockReturnValue([]),
      } as any,
      cache: {
        load: jest.fn().mockResolvedValue(null),
        save: cacheSave,
      } as any,
      commentPoster: {
        postSummary,
        postInline,
        deleteSummaryComments: jest.fn(),
      } as any,
    });

    await expect(
      orchestrator.executeReview(
        makePR([
          {
            filename: 'src/a.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
          },
        ])
      )
    ).rejects.toThrow(
      /batching produced no work for 1 file\(s\).*REQUIRE_COMPLETE_PROVIDER_COVERAGE=true/
    );

    expect(execute).not.toHaveBeenCalled();
    expect(cacheSave).not.toHaveBeenCalled();
    expect(postSummary).not.toHaveBeenCalled();
    expect(postInline).not.toHaveBeenCalled();
  });

  it('defers checkpoint commits until complete provider coverage is proven', async () => {
    process.env.REQUIRE_COMPLETE_PROVIDER_COVERAGE = 'true';
    const provider = {
      name: 'codex/gpt-5.5',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider;
    const execute = jest.fn().mockResolvedValue([
      {
        name: provider.name,
        status: 'success',
        result: {
          content: '{"findings":[],"revalidations":[]}',
          findings: [],
          revalidations: [],
        },
        durationSeconds: 1,
      } as ProviderResult,
    ]);
    const commitSuccessfulBatch = jest.fn();
    const finalize = jest.fn().mockResolvedValue({ status: 'finalized' });
    const openReviewCheckpointSession = jest.fn().mockResolvedValue({
      acceptedBatchResults: new Map(),
      commitSuccessfulBatch,
      finalize,
    });
    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: [provider.name],
        requiredHealthyProviders: [],
        fallbackProviders: [],
        providerLimit: 1,
        batchMaxFiles: 1,
        enableTokenAwareBatching: false,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue([provider]),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [provider],
          healthCheckResults: [],
        }),
        execute,
      } as any,
      openReviewCheckpointSession,
      incrementalSnapshotAdvancementEnabled: false,
    });

    await orchestrator.executeReview(
      makePR([
        {
          filename: 'src/first.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
        {
          filename: 'src/second.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ])
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(commitSuccessfulBatch).toHaveBeenCalledTimes(2);
    expect(execute.mock.invocationCallOrder[1]).toBeLessThan(
      commitSuccessfulBatch.mock.invocationCallOrder[0]
    );
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(commitSuccessfulBatch.mock.invocationCallOrder[1]).toBeLessThan(
      finalize.mock.invocationCallOrder[0]
    );
  });

  it('does not save a completed snapshot when GitHub omitted files but loaded work is empty', async () => {
    const saveReview = jest.fn();
    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        incrementalEnabled: true,
        providers: [],
        fallbackProviders: [],
      },
      incrementalReviewer: {
        shouldUseIncremental: jest.fn().mockResolvedValue(false),
        getLastReview: jest.fn(),
        mergeFindings: jest.fn(),
        generateIncrementalSummary: jest.fn(),
        saveReview,
        getChangedFilesSince: jest.fn(),
        getIncrementalChangeSet: jest.fn(),
      } as any,
    });
    const pr: PRContext = {
      ...makePR([]),
      loadCompleteness: {
        status: PullRequestLoadStatus.Truncated,
        omissions: [
          {
            reason: PullRequestLoadOmissionReason.GitHubFileLimit,
            omittedFileCount: 1,
          },
        ],
      },
    };

    const review = await orchestrator.executeReview(pr);

    expect(review.coverage).toMatchObject({
      complete: false,
      unreviewedFiles: 1,
    });
    expect(saveReview).not.toHaveBeenCalled();
  });

  it('does not advance the snapshot when the reviewed head is unverifiable', async () => {
    const saveReview = jest.fn();
    const getPullRequest = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('GitHub unavailable'), { status: 503 })
      );
    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        incrementalEnabled: true,
        providers: [],
        fallbackProviders: [],
      },
      githubClient: {
        owner: 'owner',
        repo: 'repo',
        octokit: { rest: { pulls: { get: getPullRequest } } },
      } as any,
      incrementalReviewer: {
        shouldUseIncremental: jest.fn().mockResolvedValue(false),
        getLastReview: jest.fn(),
        mergeFindings: jest.fn(),
        generateIncrementalSummary: jest.fn(),
        saveReview,
        getChangedFilesSince: jest.fn(),
        getIncrementalChangeSet: jest.fn(),
      } as any,
    });
    const pr = makePR([]);

    await orchestrator.executeReview(pr);

    expect(getPullRequest).toHaveBeenCalledTimes(1);
    expect(saveReview).not.toHaveBeenCalled();
  });

  it('pins required healthy providers during execution limiting', async () => {
    const providers = ['opencode/high', 'opencode/required-low'].map(
      (name) =>
        ({
          name,
          review: jest.fn(),
          healthCheck: jest.fn(),
        }) as unknown as Provider
    );
    const execute = jest.fn().mockResolvedValue([
      {
        name: 'opencode/required-low',
        status: 'success',
        result: {
          content: '{"findings":[],"revalidations":[]}',
          findings: [],
          revalidations: [],
        },
        durationSeconds: 1,
      } as ProviderResult,
    ]);

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: providers.map((provider) => provider.name),
        requiredHealthyProviders: ['opencode/required-low'],
        fallbackProviders: [],
        providerLimit: 1,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue(providers),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: providers,
          healthCheckResults: [],
        }),
        execute,
      } as any,
    });

    await orchestrator.executeReview(
      makePR([
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ])
    );

    expect(execute).toHaveBeenCalledWith(
      [expect.objectContaining({ name: 'opencode/required-low' })],
      expect.any(String),
      expect.any(Number)
    );
  });

  it('executes a required healthy provider even when optional provider discovery is below the multi-provider minimum', async () => {
    const providers = [
      'codex/gpt-5.5',
      'openrouter/free-a',
      'openrouter/free-b',
      'opencode/free',
    ].map(
      (name) =>
        ({
          name,
          review: jest.fn(),
          healthCheck: jest.fn(),
        }) as unknown as Provider
    );
    const codexProvider = providers[0];
    const execute = jest.fn().mockResolvedValue([
      {
        name: 'codex/gpt-5.5',
        status: 'success',
        result: {
          content: '{"findings":[],"revalidations":[]}',
          findings: [],
          revalidations: [],
        },
        durationSeconds: 1,
      } as ProviderResult,
    ]);

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: providers.map((provider) => provider.name),
        requiredHealthyProviders: ['codex/gpt-5.5'],
        fallbackProviders: [],
        providerLimit: 4,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue(providers),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [codexProvider],
          healthCheckResults: [
            {
              name: 'codex/gpt-5.5',
              status: 'success',
              durationSeconds: 0.01,
            } as ProviderResult,
            {
              name: 'openrouter/free-a',
              status: 'error',
              error: new Error('OPENROUTER_API_KEY not set'),
              durationSeconds: 0.01,
            } as ProviderResult,
          ],
        }),
        execute,
      } as any,
    });

    await orchestrator.executeReview(
      makePR([
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ])
    );

    expect(execute).toHaveBeenCalledWith(
      [codexProvider],
      expect.any(String),
      expect.any(Number)
    );
  });

  it('keeps non-required provider findings eligible for severity blocking', async () => {
    const providers = ['codex/gpt-5.5', 'openrouter/free'].map(
      (name) =>
        ({
          name,
          review: jest.fn(),
          healthCheck: jest.fn(),
        }) as unknown as Provider
    );
    const finding: Finding = {
      file: 'a.ts',
      line: 1,
      severity: 'major',
      title: 'OpenRouter finding',
      message: 'The changed line can throw at runtime.',
      provider: 'openrouter/free',
    };
    const synthesize = jest.fn((findings: Finding[], ...rest: any[]) => ({
      ...emptyReview,
      findings,
      metrics: {
        ...emptyReview.metrics,
        totalFindings: findings.length,
        major: findings.length,
      },
      runDetails: rest[4],
    }));

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: providers.map((provider) => provider.name),
        requiredHealthyProviders: ['codex/gpt-5.5'],
        fallbackProviders: [],
        providerLimit: 2,
        inlineMinSeverity: 'minor',
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue(providers),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: providers,
          healthCheckResults: [],
        }),
        execute: jest.fn().mockResolvedValue([
          {
            name: 'codex/gpt-5.5',
            status: 'success',
            result: {
              content: '{"findings":[],"revalidations":[]}',
              findings: [],
              revalidations: [],
            },
            durationSeconds: 1,
          } as ProviderResult,
          {
            name: 'openrouter/free',
            status: 'success',
            result: {
              content:
                '{"findings":[{"file":"a.ts","line":1,"severity":"major","title":"OpenRouter finding","message":"runtime crash"}],"revalidations":[]}',
              findings: [finding],
              revalidations: [],
            },
            durationSeconds: 1,
          } as ProviderResult,
        ]),
      } as any,
      synthesis: { synthesize } as any,
    });

    const pr = makePR([
      {
        filename: 'a.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: '@@ -0,0 +1 @@\n+dangerousCall()\n',
      },
    ]);
    pr.diff = 'diff --git a/a.ts b/a.ts\n@@ -0,0 +1 @@\n+dangerousCall()\n';

    const review = await orchestrator.executeReview(pr);

    expect(review.findings).toContainEqual(expect.objectContaining(finding));
    expect(review.runDetails?.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'codex/gpt-5.5',
          requiredHealthy: true,
        }),
        expect.objectContaining({
          name: 'openrouter/free',
          requiredHealthy: false,
        }),
      ])
    );
  });

  it('fails when all selected providers fail and provider failure is blocking', async () => {
    const previousFailOnNoHealthy = process.env.FAIL_ON_NO_HEALTHY_PROVIDERS;
    process.env.FAIL_ON_NO_HEALTHY_PROVIDERS = 'true';

    const providers = ['p1', 'p2', 'p3', 'p4'].map(
      (name) =>
        ({
          name,
          review: jest.fn(),
          healthCheck: jest.fn(),
        }) as unknown as Provider
    );

    try {
      const orchestrator = makeOrchestrator({
        config: {
          ...DEFAULT_CONFIG,
          dryRun: true,
          enableCaching: false,
          analyticsEnabled: false,
          graphEnabled: false,
          providers: providers.map((provider) => provider.name),
          fallbackProviders: [],
          providerLimit: 4,
        },
        providerRegistry: {
          createProviders: jest.fn().mockResolvedValue(providers),
          discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
        } as any,
        llmExecutor: {
          filterHealthyProviders: jest.fn().mockResolvedValue({
            healthy: providers,
            healthCheckResults: [],
          }),
          execute: jest.fn().mockResolvedValue([
            {
              name: 'p1',
              status: 'error',
              error: new Error(
                'OpenRouter returned invalid review JSON: response was not valid JSON'
              ),
              durationSeconds: 1,
            },
            {
              name: 'p2',
              status: 'timeout',
              error: new Error('Provider timed out after 600000ms'),
              durationSeconds: 600,
            },
            {
              name: 'p3',
              status: 'error',
              error: new Error(
                'OpenRouter returned invalid review JSON: expected an object with a findings array'
              ),
              durationSeconds: 1,
            },
            {
              name: 'p4',
              status: 'error',
              error: new Error(
                'OpenRouter returned invalid review JSON: missing required file, line, severity, title, or message'
              ),
              durationSeconds: 1,
            },
          ] as ProviderResult[]),
        } as any,
      });

      await expect(
        orchestrator.executeReview(
          makePR([
            {
              filename: 'a.ts',
              status: 'modified',
              additions: 1,
              deletions: 0,
              changes: 1,
            },
          ])
        )
      ).rejects.toThrow(/All LLM providers failed during review/);
    } finally {
      if (previousFailOnNoHealthy === undefined) {
        delete process.env.FAIL_ON_NO_HEALTHY_PROVIDERS;
      } else {
        process.env.FAIL_ON_NO_HEALTHY_PROVIDERS = previousFailOnNoHealthy;
      }
    }
  });

  it('succeeds across multiple batches when each batch has one successful provider', async () => {
    const previousFailOnNoHealthy = process.env.FAIL_ON_NO_HEALTHY_PROVIDERS;
    process.env.FAIL_ON_NO_HEALTHY_PROVIDERS = 'true';

    const providers = ['p1', 'p2'].map(
      (name) =>
        ({
          name,
          review: jest.fn(),
          healthCheck: jest.fn(),
        }) as unknown as Provider
    );
    const execute = jest.fn().mockResolvedValue([
      {
        name: 'p1',
        status: 'success',
        result: {
          content: '{"findings":[],"revalidations":[]}',
          findings: [],
          revalidations: [],
        },
        durationSeconds: 1,
      } as ProviderResult,
      {
        name: 'p2',
        status: 'error',
        error: new Error(
          'OpenRouter returned invalid review JSON: response was not valid JSON'
        ),
        durationSeconds: 1,
      } as ProviderResult,
    ]);
    const commitSuccessfulBatch = jest.fn();
    const finalizeCheckpoint = jest.fn().mockResolvedValue({
      status: 'incomplete',
      missingWorkKeys: ['mixed-provider-batch'],
    });
    const openReviewCheckpointSession = jest.fn().mockResolvedValue({
      acceptedBatchResults: new Map(),
      commitSuccessfulBatch,
      finalize: finalizeCheckpoint,
    });

    try {
      const orchestrator = makeOrchestrator({
        config: {
          ...DEFAULT_CONFIG,
          dryRun: true,
          enableCaching: false,
          analyticsEnabled: false,
          graphEnabled: false,
          providers: providers.map((provider) => provider.name),
          fallbackProviders: [],
          providerLimit: 2,
          batchMaxFiles: 1,
          enableTokenAwareBatching: false,
        },
        providerRegistry: {
          createProviders: jest.fn().mockResolvedValue(providers),
          discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
        } as any,
        llmExecutor: {
          filterHealthyProviders: jest.fn().mockResolvedValue({
            healthy: providers,
            healthCheckResults: [],
          }),
          execute,
        } as any,
        openReviewCheckpointSession,
      });

      const review = await orchestrator.executeReview(
        makePR([
          {
            filename: 'a.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
          },
          {
            filename: 'b.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
          },
        ])
      );

      expect(review).toBeTruthy();
      expect(execute).toHaveBeenCalledTimes(2);
      expect(review.metrics.providersSuccess).toBe(1);
      expect(review.metrics.providersFailed).toBe(1);
      expect(openReviewCheckpointSession).toHaveBeenCalledTimes(1);
      expect(commitSuccessfulBatch).not.toHaveBeenCalled();
      expect(finalizeCheckpoint).toHaveBeenCalledTimes(1);
      expect(review.coverage).toMatchObject({
        complete: false,
        limitations: [
          'One or more selected providers did not complete every review batch',
        ],
      });
    } finally {
      if (previousFailOnNoHealthy === undefined) {
        delete process.env.FAIL_ON_NO_HEALTHY_PROVIDERS;
      } else {
        process.env.FAIL_ON_NO_HEALTHY_PROVIDERS = previousFailOnNoHealthy;
      }
    }
  });

  it('resumes accepted batches and invokes providers only for missing work', async () => {
    const restoredUsage = {
      promptTokens: 11,
      completionTokens: 3,
      totalTokens: 14,
    };
    const executedUsage = {
      promptTokens: 17,
      completionTokens: 5,
      totalTokens: 22,
    };
    const provider = {
      name: 'p1',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider;
    const execute = jest.fn().mockResolvedValue([
      {
        name: 'p1',
        status: 'success',
        result: {
          content: '{"findings":[]}',
          findings: [],
          revalidations: [],
          usage: executedUsage,
        },
        durationSeconds: 1,
      } as ProviderResult,
    ]);
    const commitSuccessfulBatch = jest.fn().mockResolvedValue({
      status: 'accepted',
      expectedVersion: 3,
      payload: { filePaths: [], findings: [], providerResults: [] },
    });
    const finalize = jest.fn().mockResolvedValue({
      status: 'finalized',
      expectedVersion: 4,
      markerWritten: true,
    });
    let plannedWorkKeys: string[] = [];
    const openReviewCheckpointSession = jest
      .fn()
      .mockImplementation(async (plan: { workKeys: string[] }) => {
        plannedWorkKeys = [...plan.workKeys];
        return {
          acceptedBatchResults: new Map([
            [
              plan.workKeys[0],
              {
                filePaths: ['a.ts'],
                findings: [],
                providerResults: [
                  {
                    name: 'p1',
                    status: 'success',
                    durationMs: 1000,
                    usage: restoredUsage,
                    lifecycleAssignedTargetIds: [],
                    lifecycleRevalidations: [],
                  },
                ],
              },
            ],
          ]),
          commitSuccessfulBatch,
          finalize,
        };
      });

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: ['p1'],
        fallbackProviders: [],
        providerLimit: 1,
        batchMaxFiles: 1,
        enableTokenAwareBatching: false,
        budgetMaxUsd: 5,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue([provider]),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [provider],
          healthCheckResults: [],
        }),
        execute,
      } as any,
      reviewCompatibilityKey: '1'.repeat(64),
      incrementalSnapshotAdvancementEnabled: false,
      openReviewCheckpointSession,
    });

    const review = await orchestrator.executeReview(
      makePR([
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
        {
          filename: 'b.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ])
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(commitSuccessfulBatch).toHaveBeenCalledTimes(1);
    expect(commitSuccessfulBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workKey: plannedWorkKeys[1],
        files: [expect.objectContaining({ filename: 'b.ts' })],
      })
    );
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith({
      snapshotAdvancementRequired: false,
    });
    const recordUsage = (orchestrator as any).components.costTracker
      .record as jest.Mock;
    expect(recordUsage).toHaveBeenNthCalledWith(1, 'p1', restoredUsage, 5);
    expect(recordUsage).toHaveBeenNthCalledWith(2, 'p1', executedUsage, 5);
    expect(commitSuccessfulBatch.mock.invocationCallOrder[0]).toBeLessThan(
      recordUsage.mock.invocationCallOrder[1]
    );
    expect(review.coverage?.complete).toBe(true);
  });

  it('reruns all work when a legacy checkpoint contains mixed provider outcomes', async () => {
    const providers = ['p1', 'p2'].map(
      (name) =>
        ({
          name,
          review: jest.fn(),
          healthCheck: jest.fn(),
        }) as unknown as Provider
    );
    const execute = jest.fn().mockResolvedValue(
      providers.map(
        (provider) =>
          ({
            name: provider.name,
            status: 'success',
            result: {
              content: '{"findings":[]}',
              findings: [],
              revalidations: [],
            },
            durationSeconds: 1,
          }) as ProviderResult
      )
    );
    const commitSuccessfulBatch = jest.fn();
    const finalize = jest.fn();
    const openReviewCheckpointSession = jest
      .fn()
      .mockImplementation(async (plan: { workKeys: string[] }) => ({
        acceptedBatchResults: new Map([
          [
            plan.workKeys[0],
            {
              filePaths: ['a.ts'],
              findings: [],
              providerResults: [
                {
                  name: 'p1',
                  status: 'success',
                  durationMs: 1000,
                },
                {
                  name: 'p2',
                  status: 'timeout',
                  durationMs: 1000,
                  errorMessage: 'timed out',
                },
              ],
            },
          ],
        ]),
        commitSuccessfulBatch,
        finalize,
      }));
    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: providers.map((provider) => provider.name),
        fallbackProviders: [],
        providerLimit: 2,
        batchMaxFiles: 1,
        enableTokenAwareBatching: false,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue(providers),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: providers,
          healthCheckResults: [],
        }),
        execute,
      } as any,
      openReviewCheckpointSession,
      incrementalSnapshotAdvancementEnabled: false,
    });

    const review = await orchestrator.executeReview(
      makePR([
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
        {
          filename: 'b.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ])
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(commitSuccessfulBatch).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
    expect(review.coverage?.complete).toBe(true);
  });

  it('does not open a durable checkpoint for a single-batch review', async () => {
    const provider = {
      name: 'p1',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider;
    const openReviewCheckpointSession = jest.fn();
    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: ['p1'],
        fallbackProviders: [],
        providerLimit: 1,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue([provider]),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [provider],
          healthCheckResults: [],
        }),
        execute: jest.fn().mockResolvedValue([
          {
            name: 'p1',
            status: 'success',
            result: {
              content: '{"findings":[]}',
              findings: [],
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            },
            durationSeconds: 0,
          } as ProviderResult,
        ]),
      } as any,
      openReviewCheckpointSession,
    });

    await orchestrator.executeReview(
      makePR([
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ])
    );

    expect(openReviewCheckpointSession).not.toHaveBeenCalled();
  });

  it('restores plural provider attribution without duplicating findings', () => {
    const orchestrator = makeOrchestrator({});
    const restored = (orchestrator as any).restoreCheckpointProviderResults({
      filePaths: ['src/a.ts'],
      findings: [
        {
          id: 'finding-1',
          file: 'src/a.ts',
          line: 1,
          severity: 'major',
          title: 'Finding',
          message: 'Message',
          confidence: 0.9,
          providers: ['p1'],
        },
      ],
      providerResults: [
        { name: 'p1', status: 'success', durationMs: 1 },
        { name: 'p2', status: 'success', durationMs: 1 },
      ],
    });

    expect(restored[0].result.findings).toHaveLength(1);
    expect(restored[1].result.findings).toHaveLength(0);
  });

  it('reviews a 759-file capped diff once, recovers batch patches, and reuses the completed snapshot', async () => {
    const files = Array.from({ length: 759 }, (_, fileIndex) => {
      const patch = [
        '@@ -0,0 +1,259 @@',
        ...Array.from({ length: 259 }, (_, lineIndex) =>
          `+export const value_${fileIndex}_${lineIndex} = ${lineIndex};`.padEnd(
            72,
            'x'
          )
        ),
      ].join('\n');
      return {
        filename: `src/generated/file-${fileIndex}.ts`,
        status: 'modified' as const,
        additions: 259,
        deletions: 0,
        changes: 259,
        patch,
      };
    });
    const baseSha = 'b'.repeat(40);
    const headSha = 'c'.repeat(40);
    const pullRequest = {
      number: 240,
      title: 'Representative huge PR',
      body: '',
      draft: false,
      labels: [],
      additions: 759 * 259,
      deletions: 0,
      changed_files: files.length,
      base: { sha: baseSha },
      head: { sha: headSha },
      user: { login: 'fixture-author', type: 'User' },
    };
    const octokit = {
      request: jest.fn(),
      rest: {
        pulls: {
          get: jest.fn().mockResolvedValue({ data: pullRequest }),
          listFiles: jest.fn().mockImplementation(({ page, per_page }) =>
            Promise.resolve({
              data: files.slice((page - 1) * per_page, page * per_page),
            })
          ),
        },
      },
    };
    const loader = new PullRequestLoader({
      octokit,
      owner: 'fixture-owner',
      repo: 'fixture-repo',
    } as unknown as GitHubClient);
    const pr = await loader.load(240);
    const synthesizedDiffBytes = Buffer.byteLength(pr.diff, 'utf8');

    expect(octokit.request).not.toHaveBeenCalled();
    expect(synthesizedDiffBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(pr.loadCompleteness).toEqual({
      status: PullRequestLoadStatus.Truncated,
      omissions: [
        expect.objectContaining({
          reason: PullRequestLoadOmissionReason.SynthesizedDiffSizeLimit,
          omittedFileCount: expect.any(Number),
        }),
      ],
    });
    expect(pr.loadCompleteness?.omissions[0]?.omittedFileCount).toBeGreaterThan(
      0
    );

    const provider = {
      name: 'p1',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider;
    const prompts: string[] = [];
    const execute = jest.fn().mockImplementation(async (_providers, prompt) => {
      prompts.push(prompt);
      return [
        {
          name: 'p1',
          status: 'success',
          result: {
            content: '{"findings":[],"revalidations":[]}',
            findings: [],
            revalidations: [],
          },
          durationSeconds: 1,
        } as ProviderResult,
      ];
    });
    let savedSnapshot:
      | {
          prNumber: number;
          lastReviewedCommit: string;
          baseSha: string;
          timestamp: number;
          findings: Finding[];
          reviewSummary: string;
        }
      | undefined;
    const saveReview = jest.fn().mockImplementation(async (_pr, review) => {
      savedSnapshot = {
        prNumber: pr.number,
        lastReviewedCommit: pr.headSha,
        baseSha: pr.baseSha,
        timestamp: Date.now(),
        findings: review.findings,
        reviewSummary: review.summary,
      };
    });
    const planReview = jest.fn().mockImplementation(async () =>
      savedSnapshot
        ? {
            mode: IncrementalReviewPlanMode.ReuseCompleted,
            files: [],
            invalidatedPaths: [],
            lastReview: savedSnapshot,
          }
        : {
            mode: IncrementalReviewPlanMode.Full,
            files: pr.files,
            invalidatedPaths: [],
            lastReview: null,
          }
    );
    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        skipTrivialChanges: false,
        incrementalEnabled: true,
        smartDiffCompaction: false,
        diffMaxBytes: 2 * 1024 * 1024,
        enableTokenAwareBatching: false,
        batchMaxFiles: 50,
        providers: ['p1'],
        fallbackProviders: [],
        requiredHealthyProviders: [],
        providerLimit: 1,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue([provider]),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as unknown as ReviewComponents['providerRegistry'],
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [provider],
          healthCheckResults: [],
        }),
        execute,
      } as unknown as ReviewComponents['llmExecutor'],
      incrementalReviewer: {
        planReview,
        saveReview,
        mergeFindings: jest.fn(),
        generateIncrementalSummary: jest.fn(),
      } as unknown as ReviewComponents['incrementalReviewer'],
    });

    const firstReview = await orchestrator.executeReview(pr);
    const providerCallsAfterFirstReview = execute.mock.calls.length;
    const secondReview = await orchestrator.executeReview(pr);

    expect(pr.additions).toBeGreaterThanOrEqual(196_000);
    expect(firstReview.coverage).toMatchObject({
      totalFiles: 759,
      fullDiffFiles: 759,
      unreviewedFiles: 0,
      complete: true,
    });
    expect(prompts.some((prompt) => prompt.includes('file-758.ts'))).toBe(true);
    expect(providerCallsAfterFirstReview).toBeGreaterThan(1);
    expect(execute).toHaveBeenCalledTimes(providerCallsAfterFirstReview);
    expect(saveReview).toHaveBeenCalledTimes(1);
    expect(secondReview.metrics.cached).toBe(true);
  });

  it('fails when every LLM provider fails and provider failure is configured as blocking', async () => {
    const previousFailOnNoHealthy = process.env.FAIL_ON_NO_HEALTHY_PROVIDERS;
    process.env.FAIL_ON_NO_HEALTHY_PROVIDERS = 'true';

    const provider = {
      name: 'codex/gpt-5.5',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider;
    const execute = jest.fn().mockResolvedValue([
      {
        name: 'codex/gpt-5.5',
        status: 'error',
        error: new Error(
          'Codex CLI failed: OPENAI_API_KEY=sk-1234567890abcdef refresh_token=secret-value'
        ),
        durationSeconds: 0,
      } as ProviderResult,
    ]);

    try {
      const orchestrator = makeOrchestrator({
        config: {
          ...DEFAULT_CONFIG,
          dryRun: true,
          enableCaching: false,
          analyticsEnabled: false,
          graphEnabled: false,
          providers: ['codex/gpt-5.5'],
          fallbackProviders: [],
          providerLimit: 1,
        },
        providerRegistry: {
          createProviders: jest.fn().mockResolvedValue([provider]),
          discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
        } as any,
        llmExecutor: {
          filterHealthyProviders: jest.fn().mockResolvedValue({
            healthy: [provider],
            healthCheckResults: [],
          }),
          execute,
        } as any,
      });

      const pr = makePR([
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ]);

      let thrown: Error | undefined;
      try {
        await orchestrator.executeReview(pr);
      } catch (error) {
        thrown = error as Error;
      }

      expect(thrown?.message).toMatch(/All LLM providers failed during review/);
      expect(thrown?.message).not.toMatch(/sk-1234567890abcdef|secret-value/);
    } finally {
      if (previousFailOnNoHealthy === undefined) {
        delete process.env.FAIL_ON_NO_HEALTHY_PROVIDERS;
      } else {
        process.env.FAIL_ON_NO_HEALTHY_PROVIDERS = previousFailOnNoHealthy;
      }
    }
  });
});
