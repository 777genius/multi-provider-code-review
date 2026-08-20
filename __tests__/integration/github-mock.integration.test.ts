/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  ReviewOrchestrator,
  ReviewComponents,
} from '../../src/core/orchestrator';
import { ReviewConfig, ProviderResult, ReviewDepth } from '../../src/types';
import { PromptBuilder } from '../../src/analysis/llm/prompt-builder';
import { LLMExecutor } from '../../src/analysis/llm/executor';
import { Deduplicator } from '../../src/analysis/deduplicator';
import { ConsensusEngine } from '../../src/analysis/consensus';
import { SynthesisEngine } from '../../src/analysis/synthesis';
import { TestCoverageAnalyzer } from '../../src/analysis/test-coverage';
import { ASTAnalyzer } from '../../src/analysis/ast/analyzer';
import { CacheManager } from '../../src/cache/manager';
import { CostTracker } from '../../src/cost/tracker';
import { SecurityScanner } from '../../src/security/scanner';
import { RulesEngine } from '../../src/rules/engine';
import { PullRequestLoader } from '../../src/github/pr-loader';
import { CommentPoster } from '../../src/github/comment-poster';
import { MarkdownFormatter } from '../../src/output/formatter';
import { Provider } from '../../src/providers/base';
import { ContextRetriever } from '../../src/analysis/context';
import { ImpactAnalyzer } from '../../src/analysis/impact';
import { EvidenceScorer } from '../../src/analysis/evidence';
import { MermaidGenerator } from '../../src/output/mermaid';
import { FeedbackFilter } from '../../src/github/feedback';

class FakeProvider extends Provider {
  constructor() {
    super('fake/model');
  }
  async review(prompt?: string, timeoutMs?: number): Promise<any> {
    void prompt;
    void timeoutMs;
    return {
      content: 'ok',
      findings: [
        {
          file: 'src/app.ts',
          line: 5,
          severity: 'major',
          title: 'LLM finding',
          message: 'llm',
        },
      ],
    };
  }
}

class StubLLMExecutor extends LLMExecutor {
  constructor() {
    // @ts-expect-error config unused in stub
    super({ providerMaxParallel: 1 });
  }
  async execute(): Promise<ProviderResult[]> {
    const provider = new FakeProvider();
    const result = await provider.review('prompt', 1000);
    return [
      {
        name: provider.name,
        status: 'success',
        result,
        durationSeconds: 0.1,
      },
    ];
  }
}

class FindingLLMExecutor extends LLMExecutor {
  constructor() {
    // @ts-expect-error config unused in stub
    super({ providerMaxParallel: 1 });
  }

  async execute(): Promise<ProviderResult[]> {
    return [
      {
        name: 'fake/model',
        status: 'success',
        result: {
          content: 'ok',
          findings: [
            {
              file: 'src/app.ts',
              line: 2,
              severity: 'major',
              title: 'Fresh finding',
              message: 'The new line still needs attention.',
            },
          ],
        },
        durationSeconds: 0.1,
      },
    ];
  }
}

class EmptyLLMExecutor extends LLMExecutor {
  constructor() {
    // @ts-expect-error config unused in stub
    super({ providerMaxParallel: 1 });
  }

  async execute(): Promise<ProviderResult[]> {
    return [
      {
        name: 'fake/model',
        status: 'success',
        result: {
          content: 'ok',
          findings: [],
        },
        durationSeconds: 0.1,
      },
    ];
  }
}

describe('GitHub integration mock (no network)', () => {
  const config: ReviewConfig = {
    reviewDepth: ReviewDepth.Balanced,
    providers: ['fake/model'],
    synthesisModel: 'fake/model',
    fallbackProviders: [],
    providerAllowlist: [],
    providerBlocklist: [],
    providerDiscoveryLimit: 8,
    providerLimit: 0,
    providerRetries: 1,
    providerMaxParallel: 1,
    inlineMaxComments: 2,
    inlineMinSeverity: 'minor',
    inlineMinAgreement: 1,
    skipLabels: [],
    skipDrafts: false,
    skipBots: false,
    minChangedLines: 0,
    maxChangedFiles: 0,
    diffMaxBytes: 50000,
    runTimeoutSeconds: 5,
    openrouterTimeoutSeconds: 5,
    budgetMaxUsd: 1,
    enableAstAnalysis: true,
    enableSecurity: true,
    enableCaching: false,
    enableTestHints: false,
    enableAiDetection: false,
    incrementalEnabled: false,
    incrementalCacheTtlDays: 7,
    dryRun: false,
  };

  it('uses fake octokit client to post summary and inline comments', async () => {
    const fakeOctokit: any = {
      rest: {
        pulls: {
          get: jest.fn().mockResolvedValue({
            data: {
              number: 1,
              title: 'Test PR',
              body: '',
              user: { login: 'dev' },
              draft: false,
              labels: [],
              additions: 2,
              deletions: 0,
              base: { sha: 'base' },
              head: { sha: 'head' },
            },
          }),
          listFiles: jest.fn().mockResolvedValue({
            data: [
              {
                filename: 'src/app.ts',
                status: 'modified',
                additions: 2,
                deletions: 0,
                changes: 2,
                patch: '@@ -1,1 +1,2 @@\n const x = 1;\n+console.log(x);\n',
              },
            ],
          }),
          createReview: jest.fn().mockResolvedValue({}),
          listReviewComments: jest.fn().mockResolvedValue({ data: [] }),
        },
        issues: {
          createComment: jest.fn().mockResolvedValue({}),
          updateComment: jest.fn().mockResolvedValue({}),
          deleteComment: jest.fn().mockResolvedValue({}),
          listComments: jest.fn().mockResolvedValue({ data: [] }),
        },
      },
      paginate: jest.fn().mockResolvedValue([]),
      request: jest.fn().mockResolvedValue({ data: '@@ diff' }),
    };

    fakeOctokit.issues = fakeOctokit.rest.issues;
    fakeOctokit.pulls = fakeOctokit.rest.pulls;

    const fakeClient = {
      octokit: fakeOctokit,
      owner: 'owner',
      repo: 'repo',
      getFileContent: async () => null, // Mock getFileContent method
    } as any;

    const components: ReviewComponents = {
      config,
      providerRegistry: {
        createProviders: async () => [new FakeProvider()],
      } as any,
      promptBuilder: new PromptBuilder(config),
      llmExecutor: new StubLLMExecutor() as any,
      deduplicator: new Deduplicator(),
      consensus: new ConsensusEngine({
        minAgreement: 1,
        minSeverity: 'minor',
        maxComments: 10,
      }),
      synthesis: new SynthesisEngine(config),
      testCoverage: new TestCoverageAnalyzer(),
      astAnalyzer: new ASTAnalyzer(),
      cache: new CacheManager(),
      incrementalReviewer: {
        shouldUseIncremental: async () => false,
        getLastReview: async () => null,
        saveReview: async () => {},
        getChangedFilesSince: async () => [],
        mergeFindings: (prev: any, curr: any) => curr,
        generateIncrementalSummary: () => '',
      } as any,
      costTracker: new CostTracker({
        getPricing: async () => ({
          modelId: 'fake',
          promptPrice: 0,
          completionPrice: 0,
          isFree: true,
        }),
      } as any),
      security: new SecurityScanner(),
      rules: new RulesEngine([]),
      prLoader: new PullRequestLoader(fakeClient),
      commentPoster: new CommentPoster(fakeClient),
      formatter: new MarkdownFormatter(),
      contextRetriever: new ContextRetriever(),
      impactAnalyzer: new ImpactAnalyzer(),
      evidenceScorer: new EvidenceScorer(),
      mermaidGenerator: new MermaidGenerator(),
      feedbackFilter: {
        loadSuppressed: async () => new Set(),
        loadReviewCommentState: async () => ({
          suppressed: new Set(),
          alreadyPosted: new Set(),
        }),
        shouldPost: () => true,
      } as unknown as FeedbackFilter,
    };

    const orchestrator = new ReviewOrchestrator(components);
    const review = await orchestrator.execute(1);

    expect(review).toBeTruthy();
    expect(fakeOctokit.issues.createComment).toHaveBeenCalled();
    expect(fakeOctokit.pulls.createReview).toHaveBeenCalled();
  });

  it('updates the existing summary comment when findings exist', async () => {
    const fakeOctokit: any = {
      rest: {
        pulls: {
          get: jest.fn().mockResolvedValue({
            data: {
              number: 1,
              title: 'Test PR',
              body: '',
              user: { login: 'dev' },
              draft: false,
              labels: [],
              additions: 1,
              deletions: 0,
              base: { sha: 'base' },
              head: { sha: 'head' },
            },
          }),
          listFiles: jest.fn().mockResolvedValue({
            data: [
              {
                filename: 'src/app.ts',
                status: 'modified',
                additions: 1,
                deletions: 0,
                changes: 1,
                patch: '@@ -1,1 +1,2 @@\n const x = 1;\n+console.log(x);\n',
              },
            ],
          }),
          createReview: jest.fn().mockResolvedValue({}),
          listReviewComments: jest.fn().mockResolvedValue({ data: [] }),
        },
        issues: {
          createComment: jest.fn().mockResolvedValue({}),
          updateComment: jest.fn().mockResolvedValue({}),
          deleteComment: jest.fn().mockResolvedValue({}),
          listComments: jest.fn().mockResolvedValue({
            data: [
              {
                id: 99,
                body: '<!-- review-router-bot -->\n\n# ReviewRouter\nold top summary',
              },
            ],
          }),
        },
      },
      paginate: jest.fn().mockResolvedValue([]),
      request: jest.fn().mockResolvedValue({ data: '@@ diff' }),
    };

    fakeOctokit.issues = fakeOctokit.rest.issues;
    fakeOctokit.pulls = fakeOctokit.rest.pulls;

    const fakeClient = {
      octokit: fakeOctokit,
      owner: 'owner',
      repo: 'repo',
      getFileContent: async () => null,
    } as any;

    const findingConfig: ReviewConfig = {
      ...config,
      providerLimit: 1,
      enableAstAnalysis: false,
      enableSecurity: false,
      inlineMaxComments: 1,
    };
    const components: ReviewComponents = {
      config: findingConfig,
      providerRegistry: {
        createProviders: async () => [new FakeProvider()],
      } as any,
      promptBuilder: new PromptBuilder(findingConfig),
      llmExecutor: new FindingLLMExecutor() as any,
      deduplicator: new Deduplicator(),
      consensus: new ConsensusEngine({
        minAgreement: 1,
        minSeverity: 'minor',
        maxComments: 10,
      }),
      synthesis: new SynthesisEngine(findingConfig),
      testCoverage: new TestCoverageAnalyzer(),
      astAnalyzer: new ASTAnalyzer(),
      cache: new CacheManager(),
      incrementalReviewer: {
        shouldUseIncremental: async () => false,
        getLastReview: async () => null,
        saveReview: async () => {},
        getChangedFilesSince: async () => [],
        mergeFindings: (prev: any, curr: any) => curr,
        generateIncrementalSummary: () => '',
      } as any,
      costTracker: new CostTracker({
        getPricing: async () => ({
          modelId: 'fake',
          promptPrice: 0,
          completionPrice: 0,
          isFree: true,
        }),
      } as any),
      security: new SecurityScanner(),
      rules: new RulesEngine([]),
      prLoader: new PullRequestLoader(fakeClient),
      commentPoster: new CommentPoster(fakeClient),
      formatter: new MarkdownFormatter(),
      contextRetriever: new ContextRetriever(),
      impactAnalyzer: new ImpactAnalyzer(),
      evidenceScorer: new EvidenceScorer(),
      mermaidGenerator: new MermaidGenerator(),
      feedbackFilter: {
        loadSuppressed: async () => new Set(),
        loadReviewCommentState: async () => ({
          suppressed: new Set(),
          alreadyPosted: new Set(),
        }),
        shouldPost: () => true,
      } as unknown as FeedbackFilter,
    };

    await new ReviewOrchestrator(components).execute(1);

    expect(fakeOctokit.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 99,
        body: expect.stringContaining('Fresh finding'),
      })
    );
    expect(fakeOctokit.issues.deleteComment).not.toHaveBeenCalled();
    expect(fakeOctokit.issues.createComment).not.toHaveBeenCalled();
    expect(fakeOctokit.issues.updateComment.mock.calls[0][0].body).toContain(
      '<!-- review-router-bot -->'
    );
    expect(fakeOctokit.pulls.createReview).toHaveBeenCalledTimes(1);
  });

  it('does not write GitHub comments for a clean review even when an old summary exists', async () => {
    const fakeOctokit: any = {
      rest: {
        pulls: {
          get: jest.fn().mockResolvedValue({
            data: {
              number: 1,
              title: 'Test PR',
              body: '',
              user: { login: 'dev' },
              draft: false,
              labels: [],
              additions: 1,
              deletions: 0,
              base: { sha: 'base' },
              head: { sha: 'head' },
            },
          }),
          listFiles: jest.fn().mockResolvedValue({
            data: [
              {
                filename: 'src/app.ts',
                status: 'modified',
                additions: 1,
                deletions: 0,
                changes: 1,
                patch: '@@ -1,1 +1,2 @@\n const x = 1;\n+const y = 2;\n',
              },
            ],
          }),
          createReview: jest.fn().mockResolvedValue({}),
          listReviewComments: jest.fn().mockResolvedValue({ data: [] }),
        },
        issues: {
          createComment: jest.fn().mockResolvedValue({}),
          updateComment: jest.fn().mockResolvedValue({}),
          deleteComment: jest.fn().mockResolvedValue({}),
          listComments: jest.fn().mockResolvedValue({
            data: [
              {
                id: 99,
                body: '<!-- review-router-bot -->\n\n# ReviewRouter\nold top summary',
              },
            ],
          }),
        },
      },
      paginate: jest.fn().mockResolvedValue([]),
      request: jest.fn().mockResolvedValue({ data: '@@ diff' }),
    };

    fakeOctokit.issues = fakeOctokit.rest.issues;
    fakeOctokit.pulls = fakeOctokit.rest.pulls;

    const fakeClient = {
      octokit: fakeOctokit,
      owner: 'owner',
      repo: 'repo',
      getFileContent: async () => null,
    } as any;

    const cleanConfig: ReviewConfig = {
      ...config,
      providerLimit: 1,
      enableAstAnalysis: false,
      enableSecurity: false,
      enableTestHints: false,
    };
    const components: ReviewComponents = {
      config: cleanConfig,
      providerRegistry: {
        createProviders: async () => [new FakeProvider()],
      } as any,
      promptBuilder: new PromptBuilder(cleanConfig),
      llmExecutor: new EmptyLLMExecutor() as any,
      deduplicator: new Deduplicator(),
      consensus: new ConsensusEngine({
        minAgreement: 1,
        minSeverity: 'minor',
        maxComments: 10,
      }),
      synthesis: new SynthesisEngine(cleanConfig),
      testCoverage: new TestCoverageAnalyzer(),
      astAnalyzer: new ASTAnalyzer(),
      cache: new CacheManager(),
      incrementalReviewer: {
        shouldUseIncremental: async () => false,
        getLastReview: async () => null,
        saveReview: async () => {},
        getChangedFilesSince: async () => [],
        mergeFindings: (prev: any, curr: any) => curr,
        generateIncrementalSummary: () => '',
      } as any,
      costTracker: new CostTracker({
        getPricing: async () => ({
          modelId: 'fake',
          promptPrice: 0,
          completionPrice: 0,
          isFree: true,
        }),
      } as any),
      security: new SecurityScanner(),
      rules: new RulesEngine([]),
      prLoader: new PullRequestLoader(fakeClient),
      commentPoster: new CommentPoster(fakeClient),
      formatter: new MarkdownFormatter(),
      contextRetriever: new ContextRetriever(),
      impactAnalyzer: new ImpactAnalyzer(),
      evidenceScorer: new EvidenceScorer(),
      mermaidGenerator: new MermaidGenerator(),
      feedbackFilter: {
        loadSuppressed: async () => new Set(),
        loadReviewCommentState: async () => ({
          suppressed: new Set(),
          alreadyPosted: new Set(),
        }),
        shouldPost: () => true,
      } as unknown as FeedbackFilter,
    };

    const review = await new ReviewOrchestrator(components).execute(1);

    expect(review?.findings).toHaveLength(0);
    expect(fakeOctokit.issues.createComment).not.toHaveBeenCalled();
    expect(fakeOctokit.issues.updateComment).not.toHaveBeenCalled();
    expect(fakeOctokit.issues.deleteComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      comment_id: 99,
    });
    expect(fakeOctokit.pulls.createReview).not.toHaveBeenCalled();
  });
});
