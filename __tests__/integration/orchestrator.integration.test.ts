import {
  ReviewOrchestrator,
  ReviewComponents,
} from '../../src/core/orchestrator';
import {
  ReviewConfig,
  PRContext,
  Finding,
  ProviderResult,
  ReviewDepth,
} from '../../src/types';
import { ConsensusEngine } from '../../src/analysis/consensus';
import { Deduplicator } from '../../src/analysis/deduplicator';
import { SynthesisEngine } from '../../src/analysis/synthesis';
import { TestCoverageAnalyzer } from '../../src/analysis/test-coverage';
import { ASTAnalyzer } from '../../src/analysis/ast/analyzer';
import { CacheManager } from '../../src/cache/manager';
import { CostTracker } from '../../src/cost/tracker';
import { SecurityScanner } from '../../src/security/scanner';
import { RulesEngine } from '../../src/rules/engine';
import { PromptBuilder } from '../../src/analysis/llm/prompt-builder';
import { MarkdownFormatter } from '../../src/output/formatter';
import { CommentPoster } from '../../src/github/comment-poster';
import { PullRequestLoader } from '../../src/github/pr-loader';
import { Provider } from '../../src/providers/base';
import { ContextRetriever } from '../../src/analysis/context';
import { CodeGraph } from '../../src/analysis/context/graph-builder';
import { ImpactAnalyzer } from '../../src/analysis/impact';
import { EvidenceScorer } from '../../src/analysis/evidence';
import { MermaidGenerator } from '../../src/output/mermaid';
import { FeedbackFilter } from '../../src/github/feedback';

class FakeProvider extends Provider {
  constructor() {
    super('fake/model');
  }
  async review(_prompt: string, _timeoutMs: number): Promise<any> {
    void _prompt;
    void _timeoutMs;
    return {
      content: 'ok',
      findings: [
        {
          file: 'src/index.ts',
          line: 15,
          severity: 'major',
          title: 'LLM issue',
          message: 'From LLM',
        },
      ],
    };
  }
}

class StubLLMExecutor {
  lastTimeoutMs: number | undefined;

  async filterHealthyProviders(
    providers: Provider[]
  ): Promise<{ healthy: Provider[]; healthCheckResults: ProviderResult[] }> {
    // In tests, assume all providers are healthy
    return { healthy: providers, healthCheckResults: [] };
  }

  async execute(
    _providers?: Provider[],
    _prompt?: string,
    timeoutMs?: number
  ): Promise<ProviderResult[]> {
    this.lastTimeoutMs = timeoutMs;
    const provider = new FakeProvider();
    const result = await provider.review('', 1000);
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

class StubProviderRegistry {
  async createProviders(): Promise<Provider[]> {
    return [new FakeProvider()];
  }
}

class StubPRLoader {
  async load(): Promise<PRContext> {
    return {
      number: 1,
      title: 'Test PR',
      body: '',
      author: 'dev',
      draft: false,
      labels: [],
      files: [
        {
          filename: 'src/index.ts',
          status: 'modified',
          additions: 2,
          deletions: 0,
          changes: 2,
          patch: '@@ -1,1 +1,2 @@\n const a = 1;\n+console.log(a);\n',
        },
      ],
      diff: '',
      additions: 2,
      deletions: 0,
      baseSha: 'base',
      headSha: 'head',
    };
  }
}

class ShardedStubPRLoader extends StubPRLoader {
  async load(): Promise<PRContext> {
    return {
      ...(await super.load()),
      pathShard: { index: 3, count: 12, totalFiles: 48 },
    };
  }
}

class StubCommentPoster {
  postedSummary: string | null = null;
  postedInline: any[] = [];
  inlinePublication: unknown = null;
  clearedSummaries = false;
  async postSummary(_pr: number, body: string): Promise<void> {
    void _pr;
    this.postedSummary = body;
  }
  async postInline(
    _pr: number,
    comments: any[],
    _files?: unknown,
    _headSha?: string,
    _dedupeComments?: unknown,
    publication?: unknown
  ): Promise<void> {
    void _pr;
    this.postedInline = comments;
    this.inlinePublication = publication;
  }
  async deleteSummaryComments(): Promise<void> {
    this.clearedSummaries = true;
  }
}

class NoopCache extends CacheManager {
  async load(): Promise<Finding[] | null> {
    return null;
  }
  async save(): Promise<void> {
    return;
  }
}

class StubFeedbackFilter {
  constructor(private readonly inventoryComplete = true) {}

  async loadSuppressed(): Promise<Set<string>> {
    return new Set();
  }
  async loadReviewCommentState(): Promise<{
    inventoryComplete: boolean;
    suppressed: Set<string>;
    alreadyPosted: Set<string>;
  }> {
    return {
      inventoryComplete: this.inventoryComplete,
      suppressed: new Set(),
      alreadyPosted: new Set(),
    };
  }
  shouldPost(): boolean {
    return true;
  }
}

describe('ReviewOrchestrator integration (offline)', () => {
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
    inlineMaxComments: 1,
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

  it('merges AST/security/static with LLM findings and respects inline limit only for inline comments', async () => {
    const llmExecutor = new StubLLMExecutor();
    const components: ReviewComponents = {
      config,
      providerRegistry: new StubProviderRegistry() as any,
      promptBuilder: new PromptBuilder(config),
      llmExecutor: llmExecutor as any,
      deduplicator: new Deduplicator(),
      consensus: new ConsensusEngine({
        minAgreement: 1,
        minSeverity: 'minor',
        maxComments: 100,
      }),
      synthesis: new SynthesisEngine(config),
      testCoverage: new TestCoverageAnalyzer(),
      astAnalyzer: new ASTAnalyzer(),
      cache: new NoopCache(),
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
      prLoader: new StubPRLoader() as unknown as PullRequestLoader,
      commentPoster: new StubCommentPoster() as unknown as CommentPoster,
      formatter: new MarkdownFormatter(),
      contextRetriever: new ContextRetriever(),
      impactAnalyzer: new ImpactAnalyzer(),
      evidenceScorer: new EvidenceScorer(),
      mermaidGenerator: new MermaidGenerator(),
      feedbackFilter: new StubFeedbackFilter() as unknown as FeedbackFilter,
    };

    const orchestrator = new ReviewOrchestrator(components);
    const review = await orchestrator.execute(1);

    expect(review).toBeTruthy();
    expect(review?.findings.length).toBeGreaterThanOrEqual(1); // At least one finding from AST or LLM
    expect(review?.inlineComments.length).toBe(1);
    expect(
      (components.commentPoster as unknown as StubCommentPoster).postedSummary
    ).toBeTruthy();
  });

  it('publishes only inline findings for a path shard', async () => {
    const commentPoster = new StubCommentPoster();
    const updateDescription = jest.fn();
    const shardedConfig = { ...config, updatePrDescription: true };
    const components: ReviewComponents = {
      config: shardedConfig,
      providerRegistry: new StubProviderRegistry() as any,
      promptBuilder: new PromptBuilder(shardedConfig),
      llmExecutor: new StubLLMExecutor() as any,
      deduplicator: new Deduplicator(),
      consensus: new ConsensusEngine({
        minAgreement: 1,
        minSeverity: 'minor',
        maxComments: 100,
      }),
      synthesis: new SynthesisEngine(shardedConfig),
      testCoverage: new TestCoverageAnalyzer(),
      astAnalyzer: new ASTAnalyzer(),
      cache: new NoopCache(),
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
      prLoader: new ShardedStubPRLoader() as unknown as PullRequestLoader,
      commentPoster: commentPoster as unknown as CommentPoster,
      formatter: new MarkdownFormatter(),
      contextRetriever: new ContextRetriever(),
      impactAnalyzer: new ImpactAnalyzer(),
      evidenceScorer: new EvidenceScorer(),
      mermaidGenerator: new MermaidGenerator(),
      feedbackFilter: new StubFeedbackFilter() as unknown as FeedbackFilter,
      prDescriptionUpdater: { update: updateDescription } as any,
    };

    const review = await new ReviewOrchestrator(components).execute(1);

    expect(review?.findings.length).toBeGreaterThan(0);
    expect(commentPoster.postedInline.length).toBeGreaterThan(0);
    expect(commentPoster.postedSummary).toBeNull();
    expect(commentPoster.clearedSummaries).toBe(false);
    expect(commentPoster.inlinePublication).toEqual({
      mode: 'strict-inline-only',
    });
    expect(updateDescription).not.toHaveBeenCalled();

    const blockedPoster = new StubCommentPoster();
    await expect(
      new ReviewOrchestrator({
        ...components,
        commentPoster: blockedPoster as unknown as CommentPoster,
        feedbackFilter: new StubFeedbackFilter(
          false
        ) as unknown as FeedbackFilter,
      }).execute(1)
    ).rejects.toThrow(
      'Path-sharded inline publication requires a complete trusted review-comment inventory; refusing publication'
    );
    expect(blockedPoster.postedInline).toEqual([]);
  });

  it('replaces the progress comment with the final summary when findings are posted', async () => {
    const createComment = jest.fn().mockResolvedValue({ data: { id: 456 } });
    const updateComment = jest.fn().mockResolvedValue({ data: {} });
    const listComments = jest.fn().mockResolvedValue({ data: [] });
    const listReviewComments = jest.fn().mockResolvedValue({ data: [] });
    const getPullRequest = jest
      .fn()
      .mockResolvedValue({ data: { head: { sha: 'head' } } });
    const githubClient = {
      owner: 'test-owner',
      repo: 'test-repo',
      octokit: {
        rest: {
          issues: {
            createComment,
            updateComment,
            listComments,
          },
          pulls: {
            get: getPullRequest,
            listReviewComments,
          },
        },
      },
    };
    const commentPoster = new StubCommentPoster();
    const components: ReviewComponents = {
      config,
      providerRegistry: new StubProviderRegistry() as any,
      promptBuilder: new PromptBuilder(config),
      llmExecutor: new StubLLMExecutor() as any,
      deduplicator: new Deduplicator(),
      consensus: new ConsensusEngine({
        minAgreement: 1,
        minSeverity: 'minor',
        maxComments: 100,
      }),
      synthesis: new SynthesisEngine(config),
      testCoverage: new TestCoverageAnalyzer(),
      astAnalyzer: new ASTAnalyzer(),
      cache: new NoopCache(),
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
      prLoader: new StubPRLoader() as unknown as PullRequestLoader,
      commentPoster: commentPoster as unknown as CommentPoster,
      formatter: new MarkdownFormatter(),
      contextRetriever: new ContextRetriever(),
      impactAnalyzer: new ImpactAnalyzer(),
      evidenceScorer: new EvidenceScorer(),
      mermaidGenerator: new MermaidGenerator(),
      feedbackFilter: new StubFeedbackFilter() as unknown as FeedbackFilter,
      githubClient: githubClient as any,
    };

    const review = await new ReviewOrchestrator(components).execute(1);

    expect(review?.findings.length).toBeGreaterThan(0);
    expect(commentPoster.postedSummary).toBeNull();
    expect(commentPoster.postedInline.length).toBeGreaterThan(0);

    const lastUpdate =
      updateComment.mock.calls[updateComment.mock.calls.length - 1]?.[0];
    expect(lastUpdate).toEqual(
      expect.objectContaining({
        owner: 'test-owner',
        repo: 'test-repo',
        comment_id: 456,
      })
    );
    expect(lastUpdate.body).toContain('<!-- review-router-bot -->');
    expect(lastUpdate.body).toContain('# ReviewRouter');
    expect(lastUpdate.body).toContain('<!-- review-router-summary:');
    expect(lastUpdate.body).not.toContain(
      '<!-- review-router-progress-tracker -->'
    );
  });

  it('uses RUN_TIMEOUT_SECONDS as a floor for intensity timeout', async () => {
    const llmExecutor = new StubLLMExecutor();
    const components: ReviewComponents = {
      config: {
        ...config,
        runTimeoutSeconds: 600,
        pathDefaultIntensity: 'standard',
        intensityTimeouts: {
          thorough: 180000,
          standard: 120000,
          light: 60000,
        },
      },
      providerRegistry: new StubProviderRegistry() as any,
      promptBuilder: new PromptBuilder(config),
      llmExecutor: llmExecutor as any,
      deduplicator: new Deduplicator(),
      consensus: new ConsensusEngine({
        minAgreement: 1,
        minSeverity: 'minor',
        maxComments: 100,
      }),
      synthesis: new SynthesisEngine(config),
      testCoverage: new TestCoverageAnalyzer(),
      astAnalyzer: new ASTAnalyzer(),
      cache: new NoopCache(),
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
      prLoader: new StubPRLoader() as unknown as PullRequestLoader,
      commentPoster: new StubCommentPoster() as unknown as CommentPoster,
      formatter: new MarkdownFormatter(),
      contextRetriever: new ContextRetriever(),
      impactAnalyzer: new ImpactAnalyzer(),
      evidenceScorer: new EvidenceScorer(),
      mermaidGenerator: new MermaidGenerator(),
      feedbackFilter: new StubFeedbackFilter() as unknown as FeedbackFilter,
    };

    const orchestrator = new ReviewOrchestrator(components);
    await orchestrator.execute(1);

    expect(llmExecutor.lastTimeoutMs).toBe(600000);
  });

  it('filters duplicate inline comments before posting', async () => {
    class BlockingFeedbackFilter extends StubFeedbackFilter {
      async loadReviewCommentState(): Promise<{
        inventoryComplete: boolean;
        suppressed: Set<string>;
        alreadyPosted: Set<string>;
      }> {
        return {
          inventoryComplete: true,
          suppressed: new Set(),
          alreadyPosted: new Set(['existing-finding']),
        };
      }

      shouldPost(): boolean {
        return false;
      }
    }

    const commentPoster = new StubCommentPoster();
    const components: ReviewComponents = {
      config,
      providerRegistry: new StubProviderRegistry() as any,
      promptBuilder: new PromptBuilder(config),
      llmExecutor: new StubLLMExecutor() as any,
      deduplicator: new Deduplicator(),
      consensus: new ConsensusEngine({
        minAgreement: 1,
        minSeverity: 'minor',
        maxComments: 100,
      }),
      synthesis: new SynthesisEngine(config),
      testCoverage: new TestCoverageAnalyzer(),
      astAnalyzer: new ASTAnalyzer(),
      cache: new NoopCache(),
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
      prLoader: new StubPRLoader() as unknown as PullRequestLoader,
      commentPoster: commentPoster as unknown as CommentPoster,
      formatter: new MarkdownFormatter(),
      contextRetriever: new ContextRetriever(),
      impactAnalyzer: new ImpactAnalyzer(),
      evidenceScorer: new EvidenceScorer(),
      mermaidGenerator: new MermaidGenerator(),
      feedbackFilter: new BlockingFeedbackFilter() as unknown as FeedbackFilter,
    };

    const orchestrator = new ReviewOrchestrator(components);
    const review = await orchestrator.execute(1);

    expect(review?.inlineComments.length).toBe(1);
    expect(commentPoster.postedInline).toEqual([]);
  });

  it('normalizes model-reported finding lines before rendering the summary', async () => {
    class LineMismatchLLMExecutor {
      async filterHealthyProviders(providers: Provider[]): Promise<{
        healthy: Provider[];
        healthCheckResults: ProviderResult[];
      }> {
        return { healthy: providers, healthCheckResults: [] };
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
                  file: 'src/billing.js',
                  line: 8,
                  severity: 'critical',
                  title: 'Interpolated billing query allows SQL injection',
                  message:
                    'The changed line builds SQL with normalizedEmail inside the query string.',
                },
              ],
            },
            durationSeconds: 0.1,
          },
        ];
      }
    }

    class BillingPRLoader {
      async load(): Promise<PRContext> {
        return {
          number: 4,
          title: 'Billing regression',
          body: '',
          author: 'dev',
          draft: false,
          labels: [],
          files: [
            {
              filename: 'src/billing.js',
              status: 'modified',
              additions: 2,
              deletions: 5,
              changes: 7,
              patch: [
                '@@ -4,9 +4,6 @@ export async function getBillingSummary(db, plans, planId, email) {',
                ' export async function getBillingSummary(db, plans, planId, email) {',
                '   const plan = findPlan(plans, planId);',
                '   const normalizedEmail = normalizeEmail(email);',
                "-  return db.query('select * from billing where email = ? and plan = ?', [",
                '-    normalizedEmail,',
                "-    plan?.id ?? 'free',",
                '-  ]);',
                "+  const rows = await db.query(`select * from billing where email = '${normalizedEmail}' and plan = '${plan.id}' limit 1`);",
                '+  return rows[0] || null;',
                ' }',
              ].join('\n'),
            },
          ],
          diff: '',
          additions: 2,
          deletions: 5,
          baseSha: 'base',
          headSha: 'head',
        };
      }
    }

    const lineConfig = {
      ...config,
      inlineMaxComments: 5,
      enableAstAnalysis: false,
      enableSecurity: false,
    };
    const commentPoster = new StubCommentPoster();
    const components: ReviewComponents = {
      config: lineConfig,
      providerRegistry: new StubProviderRegistry() as any,
      promptBuilder: new PromptBuilder(lineConfig),
      llmExecutor: new LineMismatchLLMExecutor() as any,
      deduplicator: new Deduplicator(),
      consensus: new ConsensusEngine({
        minAgreement: 1,
        minSeverity: 'minor',
        maxComments: 100,
      }),
      synthesis: new SynthesisEngine(lineConfig),
      testCoverage: new TestCoverageAnalyzer(),
      astAnalyzer: new ASTAnalyzer(),
      cache: new NoopCache(),
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
      prLoader: new BillingPRLoader() as unknown as PullRequestLoader,
      commentPoster: commentPoster as unknown as CommentPoster,
      formatter: new MarkdownFormatter(),
      contextRetriever: new ContextRetriever(),
      impactAnalyzer: new ImpactAnalyzer(),
      evidenceScorer: new EvidenceScorer(),
      mermaidGenerator: new MermaidGenerator(),
      feedbackFilter: new StubFeedbackFilter() as unknown as FeedbackFilter,
    };

    const review = await new ReviewOrchestrator(components).execute(4);
    const finding = review?.findings.find((f) =>
      f.title.includes('Interpolated billing query')
    );

    expect(finding?.line).toBe(7);
    expect(review?.inlineComments[0].line).toBe(7);
    expect(commentPoster.postedSummary).toContain('src/billing.js:7');
    expect(commentPoster.postedSummary).not.toContain('src/billing.js:8');
  });

  it('passes built code graph context into batch prompt builder when graph is enabled', async () => {
    class CapturingLLMExecutor {
      prompts: string[] = [];

      async filterHealthyProviders(providers: Provider[]): Promise<{
        healthy: Provider[];
        healthCheckResults: ProviderResult[];
      }> {
        return { healthy: providers, healthCheckResults: [] };
      }

      async execute(
        _providers: Provider[],
        prompt: string
      ): Promise<ProviderResult[]> {
        this.prompts.push(prompt);
        return [];
      }
    }

    class StubGraphBuilder {
      async buildGraph(): Promise<CodeGraph> {
        const graph = new CodeGraph(['src/index.ts'], 1);
        graph.addDefinition({
          name: 'handle',
          file: 'src/index.ts',
          line: 1,
          type: 'function',
          exported: true,
        });
        graph.addCall('src/index.ts', 'handle', 'validate');
        return graph;
      }

      async updateGraph(graph: CodeGraph): Promise<CodeGraph> {
        return graph;
      }
    }

    const llmExecutor = new CapturingLLMExecutor();
    const graphConfig: ReviewConfig = {
      ...config,
      graphEnabled: true,
      graphCacheEnabled: false,
      enableAstAnalysis: false,
      enableSecurity: false,
      providerLimit: 1,
    };
    const components: ReviewComponents = {
      config: graphConfig,
      providerRegistry: new StubProviderRegistry() as any,
      promptBuilder: new PromptBuilder(graphConfig),
      llmExecutor: llmExecutor as any,
      deduplicator: new Deduplicator(),
      consensus: new ConsensusEngine({
        minAgreement: 1,
        minSeverity: 'minor',
        maxComments: 100,
      }),
      synthesis: new SynthesisEngine(graphConfig),
      testCoverage: new TestCoverageAnalyzer(),
      astAnalyzer: new ASTAnalyzer(),
      cache: new NoopCache(),
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
      prLoader: new StubPRLoader() as unknown as PullRequestLoader,
      commentPoster: new StubCommentPoster() as unknown as CommentPoster,
      formatter: new MarkdownFormatter(),
      contextRetriever: new ContextRetriever(),
      impactAnalyzer: new ImpactAnalyzer(),
      evidenceScorer: new EvidenceScorer(),
      mermaidGenerator: new MermaidGenerator(),
      feedbackFilter: new StubFeedbackFilter() as unknown as FeedbackFilter,
      graphBuilder: new StubGraphBuilder() as any,
    };

    const orchestrator = new ReviewOrchestrator(components);
    await orchestrator.execute(1);

    expect(llmExecutor.prompts[0]).toContain('CODE GRAPH CONTEXT');
    expect(llmExecutor.prompts[0]).toContain('Calls: src/index.ts:validate');
  });

  it('handles provider failures gracefully', async () => {
    class FailingLLMExecutor {
      async filterHealthyProviders(providers: Provider[]): Promise<{
        healthy: Provider[];
        healthCheckResults: ProviderResult[];
      }> {
        // Return providers unchanged to test failure handling
        return { healthy: providers, healthCheckResults: [] };
      }

      async execute(): Promise<ProviderResult[]> {
        return [
          {
            name: 'fake/model',
            status: 'error',
            error: new Error('Provider failed'),
            durationSeconds: 0.1,
          },
        ];
      }
    }

    const components: ReviewComponents = {
      config,
      providerRegistry: new StubProviderRegistry() as any,
      promptBuilder: new PromptBuilder(config),
      llmExecutor: new FailingLLMExecutor() as any,
      deduplicator: new Deduplicator(),
      consensus: new ConsensusEngine({
        minAgreement: 1,
        minSeverity: 'minor',
        maxComments: 100,
      }),
      synthesis: new SynthesisEngine(config),
      testCoverage: new TestCoverageAnalyzer(),
      astAnalyzer: new ASTAnalyzer(),
      cache: new NoopCache(),
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
      prLoader: new StubPRLoader() as unknown as PullRequestLoader,
      commentPoster: new StubCommentPoster() as unknown as CommentPoster,
      formatter: new MarkdownFormatter(),
      contextRetriever: new ContextRetriever(),
      impactAnalyzer: new ImpactAnalyzer(),
      evidenceScorer: new EvidenceScorer(),
      mermaidGenerator: new MermaidGenerator(),
      feedbackFilter: new StubFeedbackFilter() as unknown as FeedbackFilter,
    };

    const orchestrator = new ReviewOrchestrator(components);
    const review = await orchestrator.execute(1);

    expect(review).toBeTruthy();
    // Should still have AST/security findings even if LLM fails
    expect(review?.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('uses cached findings when available', async () => {
    const cachedFindings: Finding[] = [
      {
        file: 'src/cached.ts',
        line: 10,
        severity: 'major',
        title: 'Cached issue',
        message: 'From cache',
        providers: ['fake/model'],
      },
    ];

    class CacheWithData extends CacheManager {
      async load(): Promise<Finding[] | null> {
        return cachedFindings;
      }
      async save(): Promise<void> {
        return;
      }
    }

    const components: ReviewComponents = {
      config: { ...config, enableCaching: true },
      providerRegistry: new StubProviderRegistry() as any,
      promptBuilder: new PromptBuilder(config),
      llmExecutor: new StubLLMExecutor() as any,
      deduplicator: new Deduplicator(),
      consensus: new ConsensusEngine({
        minAgreement: 1,
        minSeverity: 'minor',
        maxComments: 100,
      }),
      synthesis: new SynthesisEngine(config),
      testCoverage: new TestCoverageAnalyzer(),
      astAnalyzer: new ASTAnalyzer(),
      cache: new CacheWithData(),
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
      prLoader: new StubPRLoader() as unknown as PullRequestLoader,
      commentPoster: new StubCommentPoster() as unknown as CommentPoster,
      formatter: new MarkdownFormatter(),
      contextRetriever: new ContextRetriever(),
      impactAnalyzer: new ImpactAnalyzer(),
      evidenceScorer: new EvidenceScorer(),
      mermaidGenerator: new MermaidGenerator(),
      feedbackFilter: new StubFeedbackFilter() as unknown as FeedbackFilter,
    };

    const orchestrator = new ReviewOrchestrator(components);
    const review = await orchestrator.execute(1);

    expect(review).toBeTruthy();
    expect(review?.findings.some((f) => f.file === 'src/cached.ts')).toBe(true);
  });

  it('skips draft PRs when configured', async () => {
    class DraftPRLoader {
      async load(): Promise<PRContext> {
        return {
          number: 1,
          title: 'Draft PR',
          body: '',
          author: 'dev',
          draft: true,
          labels: [],
          files: [],
          diff: '',
          additions: 0,
          deletions: 0,
          baseSha: 'base',
          headSha: 'head',
        };
      }
    }

    const draftConfig: ReviewConfig = {
      ...config,
      skipDrafts: true,
    };

    const components: ReviewComponents = {
      config: draftConfig,
      providerRegistry: new StubProviderRegistry() as any,
      promptBuilder: new PromptBuilder(draftConfig),
      llmExecutor: new StubLLMExecutor() as any,
      deduplicator: new Deduplicator(),
      consensus: new ConsensusEngine({
        minAgreement: 1,
        minSeverity: 'minor',
        maxComments: 100,
      }),
      synthesis: new SynthesisEngine(draftConfig),
      testCoverage: new TestCoverageAnalyzer(),
      astAnalyzer: new ASTAnalyzer(),
      cache: new NoopCache(),
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
      prLoader: new DraftPRLoader() as unknown as PullRequestLoader,
      commentPoster: new StubCommentPoster() as unknown as CommentPoster,
      formatter: new MarkdownFormatter(),
      contextRetriever: new ContextRetriever(),
      impactAnalyzer: new ImpactAnalyzer(),
      evidenceScorer: new EvidenceScorer(),
      mermaidGenerator: new MermaidGenerator(),
      feedbackFilter: new StubFeedbackFilter() as unknown as FeedbackFilter,
    };

    const orchestrator = new ReviewOrchestrator(components);
    const review = await orchestrator.execute(1);

    expect(review).toBeNull();
  });

  it('applies consensus filtering with multiple providers', async () => {
    class MultiProviderLLMExecutor {
      async filterHealthyProviders(providers: Provider[]): Promise<{
        healthy: Provider[];
        healthCheckResults: ProviderResult[];
      }> {
        return { healthy: providers, healthCheckResults: [] };
      }

      async execute(): Promise<ProviderResult[]> {
        return [
          {
            name: 'provider1',
            status: 'success',
            result: {
              content: 'ok',
              findings: [
                {
                  file: 'src/index.ts',
                  line: 15,
                  severity: 'major',
                  title: 'Issue',
                  message: 'Agreed',
                },
              ],
            },
            durationSeconds: 0.1,
          },
          {
            name: 'provider2',
            status: 'success',
            result: {
              content: 'ok',
              findings: [
                {
                  file: 'src/index.ts',
                  line: 15,
                  severity: 'major',
                  title: 'Issue',
                  message: 'Agreed',
                },
                {
                  file: 'src/index.ts',
                  line: 20,
                  severity: 'minor',
                  title: 'Noise',
                  message: 'Only one provider',
                },
              ],
            },
            durationSeconds: 0.1,
          },
        ];
      }
    }

    const consensusConfig: ReviewConfig = {
      ...config,
      inlineMinAgreement: 2, // Require 2 providers to agree
    };

    const components: ReviewComponents = {
      config: consensusConfig,
      providerRegistry: new StubProviderRegistry() as any,
      promptBuilder: new PromptBuilder(consensusConfig),
      llmExecutor: new MultiProviderLLMExecutor() as any,
      deduplicator: new Deduplicator(),
      consensus: new ConsensusEngine({
        minAgreement: 2,
        minSeverity: 'minor',
        maxComments: 100,
      }),
      synthesis: new SynthesisEngine(consensusConfig),
      testCoverage: new TestCoverageAnalyzer(),
      astAnalyzer: new ASTAnalyzer(),
      cache: new NoopCache(),
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
      prLoader: new StubPRLoader() as unknown as PullRequestLoader,
      commentPoster: new StubCommentPoster() as unknown as CommentPoster,
      formatter: new MarkdownFormatter(),
      contextRetriever: new ContextRetriever(),
      impactAnalyzer: new ImpactAnalyzer(),
      evidenceScorer: new EvidenceScorer(),
      mermaidGenerator: new MermaidGenerator(),
      feedbackFilter: new StubFeedbackFilter() as unknown as FeedbackFilter,
    };

    const orchestrator = new ReviewOrchestrator(components);
    const review = await orchestrator.execute(1);

    expect(review).toBeTruthy();
    // Verify consensus filtering: inline comments should be produced
    expect(review?.inlineComments.length).toBeGreaterThan(0);
    // Verify at least one finding was generated
    expect(review?.findings.length).toBeGreaterThan(0);
  });

  it('generates complete review with all outputs', async () => {
    const components: ReviewComponents = {
      config,
      providerRegistry: new StubProviderRegistry() as any,
      promptBuilder: new PromptBuilder(config),
      llmExecutor: new StubLLMExecutor() as any,
      deduplicator: new Deduplicator(),
      consensus: new ConsensusEngine({
        minAgreement: 1,
        minSeverity: 'minor',
        maxComments: 100,
      }),
      synthesis: new SynthesisEngine(config),
      testCoverage: new TestCoverageAnalyzer(),
      astAnalyzer: new ASTAnalyzer(),
      cache: new NoopCache(),
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
      prLoader: new StubPRLoader() as unknown as PullRequestLoader,
      commentPoster: new StubCommentPoster() as unknown as CommentPoster,
      formatter: new MarkdownFormatter(),
      contextRetriever: new ContextRetriever(),
      impactAnalyzer: new ImpactAnalyzer(),
      evidenceScorer: new EvidenceScorer(),
      mermaidGenerator: new MermaidGenerator(),
      feedbackFilter: new StubFeedbackFilter() as unknown as FeedbackFilter,
    };

    const orchestrator = new ReviewOrchestrator(components);
    const review = await orchestrator.execute(1);

    expect(review).toBeTruthy();
    expect(review?.findings).toBeDefined();
    expect(review?.inlineComments).toBeDefined();
    expect(review?.providerResults).toBeDefined();
    expect(review?.runDetails).toBeDefined();
    expect(review?.runDetails?.durationSeconds).toBeGreaterThanOrEqual(0);
    expect(review?.runDetails?.totalCost).toBeGreaterThanOrEqual(0);
    expect(review?.metrics).toBeDefined();
    expect(review?.summary).toBeDefined();
  });
});
