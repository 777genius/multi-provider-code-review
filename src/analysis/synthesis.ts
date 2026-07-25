import {
  Finding,
  InlineComment,
  PRContext,
  Review,
  ReviewConfig,
  ReviewMetrics,
  TestCoverageHint,
  AIAnalysis,
  ProviderResult,
  RunDetails,
  ImpactAnalysis,
} from '../types';
import { compareSeverityDesc, getSeverityDisplay } from '../utils/severity';
import {
  countMaxConsecutiveBackticks,
  formatSuggestionBlock,
} from '../utils/suggestion-formatter';

export interface ProviderExecutionSummary {
  readonly planned: number;
  readonly succeeded: number;
}

export class SynthesisEngine {
  constructor(private readonly config: ReviewConfig) {}

  synthesize(
    findings: Finding[],
    pr: PRContext,
    testHints?: TestCoverageHint[],
    aiAnalysis?: AIAnalysis,
    providerResults?: ProviderResult[],
    runDetails?: RunDetails,
    impactAnalysis?: ImpactAnalysis,
    mermaidDiagram?: string
  ): Review {
    const metrics = this.buildMetrics(findings, providerResults, runDetails);
    return this.buildReview({
      findings,
      pr,
      metrics,
      testHints,
      aiAnalysis,
      providerResults,
      runDetails,
      impactAnalysis,
      mermaidDiagram,
    });
  }

  synthesizeWithProviderExecutionSummary(
    findings: Finding[],
    pr: PRContext,
    providerExecution: ProviderExecutionSummary
  ): Review {
    const metrics = this.buildMetrics(
      findings,
      undefined,
      undefined,
      providerExecution
    );
    return this.buildReview({ findings, pr, metrics });
  }

  private buildReview(input: {
    findings: Finding[];
    pr: PRContext;
    metrics: ReviewMetrics;
    testHints?: TestCoverageHint[];
    aiAnalysis?: AIAnalysis;
    providerResults?: ProviderResult[];
    runDetails?: RunDetails;
    impactAnalysis?: ImpactAnalysis;
    mermaidDiagram?: string;
  }): Review {
    const summary = this.buildSummary(
      input.pr,
      input.findings,
      input.metrics,
      input.testHints,
      input.aiAnalysis,
      input.impactAnalysis
    );
    const inlineComments = this.buildInlineComments(input.findings);
    const actionItems = this.buildActionItems(input.findings);

    return {
      summary,
      findings: input.findings,
      inlineComments,
      actionItems,
      testHints: input.testHints,
      aiAnalysis: input.aiAnalysis,
      metrics: input.metrics,
      providerResults: input.providerResults,
      runDetails: input.runDetails,
      impactAnalysis: input.impactAnalysis,
      mermaidDiagram: input.mermaidDiagram,
    };
  }

  private buildMetrics(
    findings: Finding[],
    providerResults?: ProviderResult[],
    runDetails?: RunDetails,
    providerExecution?: ProviderExecutionSummary
  ): ReviewMetrics {
    const critical = findings.filter((f) => f.severity === 'critical').length;
    const major = findings.filter((f) => f.severity === 'major').length;
    const minor = findings.filter((f) => f.severity === 'minor').length;

    // Compute provider metrics from runDetails or providerResults
    let providersUsed = 0;
    let providersSuccess = 0;
    let providersFailed = 0;
    let totalTokens = 0;
    let totalCost = 0;
    let durationSeconds = 0;

    if (providerExecution) {
      providersUsed = providerExecution.planned;
      providersSuccess = providerExecution.succeeded;
      providersFailed = providerExecution.planned - providerExecution.succeeded;
    } else if (runDetails) {
      // Prefer runDetails if available as it has aggregated values
      providersUsed = runDetails.providers.length;
      providersSuccess = runDetails.providers.filter(
        (p) => p.status === 'success'
      ).length;
      providersFailed = runDetails.providers.filter(
        (p) => p.status === 'error' || p.status === 'timeout'
      ).length;
      totalTokens = runDetails.totalTokens;
      totalCost = runDetails.totalCost;
      durationSeconds = runDetails.durationSeconds;
    } else if (providerResults) {
      // Fallback to calculating from providerResults
      providersUsed = providerResults.length;
      providersSuccess = providerResults.filter(
        (p) => p.status === 'success'
      ).length;
      providersFailed = providerResults.filter(
        (p) => p.status === 'error' || p.status === 'timeout'
      ).length;

      // Sum tokens from successful results
      totalTokens = providerResults.reduce((sum, p) => {
        return sum + (p.result?.usage?.totalTokens ?? 0);
      }, 0);

      // Note: totalCost would need pricing info, so leave at 0 if not in runDetails
      totalCost = 0;

      // Sum durations
      durationSeconds = providerResults.reduce(
        (sum, p) => sum + p.durationSeconds,
        0
      );
    }

    return {
      totalFindings: findings.length,
      critical,
      major,
      minor,
      providersUsed,
      providersSuccess,
      providersFailed,
      totalTokens,
      totalCost,
      durationSeconds,
    };
  }

  private buildSummary(
    pr: PRContext,
    findings: Finding[],
    metrics: ReviewMetrics,
    testHints?: TestCoverageHint[],
    aiAnalysis?: AIAnalysis,
    impactAnalysis?: ImpactAnalysis
  ): string {
    const totalProviders = metrics.providersUsed;
    const successes = metrics.providersSuccess;
    const failures = totalProviders - successes;

    const impactText = impactAnalysis
      ? ` • Impact: ${impactAnalysis.impactLevel}`
      : '';
    const aiText = aiAnalysis
      ? ` • AI-likelihood: ${(aiAnalysis.averageLikelihood * 100).toFixed(1)}%`
      : '';

    return [
      `Review for PR #${pr.number}: ${pr.title}`,
      `Files: ${pr.files.length} (+${pr.additions}/-${pr.deletions}) • Providers: ${successes}/${totalProviders} succeeded${failures > 0 ? `, ${failures} failed` : ''} • Findings: ${metrics.totalFindings} (C${metrics.critical}/M${metrics.major}/m${metrics.minor})${impactText}${aiText}`,
    ].join('\n');
  }

  private buildInlineComments(findings: Finding[]): InlineComment[] {
    const minSeverity = this.config.inlineMinSeverity;

    const sorted = findings
      .filter((f) => compareSeverityDesc(minSeverity, f.severity) >= 0)
      .sort(
        (a, b) =>
          compareSeverityDesc(a.severity, b.severity) ||
          a.file.localeCompare(b.file) ||
          a.line - b.line
      )
      .slice(0, this.config.inlineMaxComments);

    return sorted.map((f) => ({
      path: f.file,
      startLine: f.startLine,
      line: f.line,
      endLine: f.endLine,
      side: 'RIGHT',
      body: this.commentBody(f),
      severity: f.severity,
      title: f.title,
      category: f.category,
      provider: f.provider,
      providers: f.providers,
      confidence: f.confidence,
      hasConsensus: f.hasConsensus,
      suggestion: f.suggestion,
    }));
  }

  private commentBody(finding: Finding): string {
    const parts = [
      this.inlineHeader(finding),
      '',
      `**${finding.title}**`,
      '',
      finding.message.trim(),
    ];
    if (finding.suggestion) {
      parts.push('', this.suggestedFixDetails(finding.suggestion));
      if (isSingleLineSuggestion(finding.suggestion)) {
        parts.push('', '<!-- suggestion_start -->');
        parts.push('', this.committableSuggestionDetails(finding.suggestion));
        parts.push('', '<!-- suggestion_end -->');
      }
    }
    parts.push('', this.agentPromptDetails(finding));
    const attribution = this.modelAttributionFooter(finding);
    if (attribution) {
      parts.push('', attribution);
    }
    return parts.join('\n');
  }

  private modelAttributionFooter(finding: Finding): string | null {
    const attributions = this.normalizeProviderModels(finding);
    if (attributions.length === 0) {
      return null;
    }

    if (attributions.length === 1) {
      return `<sub>Model: ${this.formatProviderModel(attributions[0])}</sub>`;
    }

    const total = Math.max(
      finding.providerPoolSize ?? attributions.length,
      attributions.length
    );
    return `<sub>Models: ${attributions.map((item) => this.formatProviderModel(item)).join(', ')} · agreement ${attributions.length}/${total}</sub>`;
  }

  private normalizeProviderModels(
    finding: Finding
  ): Array<{ provider: string; actualModel?: string }> {
    const merged = new Map<
      string,
      { provider: string; actualModel?: string }
    >();
    for (const item of finding.providerModels || []) {
      merged.set(item.provider, item);
    }
    for (const provider of finding.providers || []) {
      if (!merged.has(provider)) {
        merged.set(provider, { provider });
      }
    }
    if (finding.provider && !merged.has(finding.provider)) {
      merged.set(finding.provider, {
        provider: finding.provider,
        actualModel: finding.actualModel,
      });
    }
    return Array.from(merged.values());
  }

  private formatProviderModel(input: {
    provider: string;
    actualModel?: string;
  }): string {
    return input.provider;
  }

  private inlineHeader(finding: Finding): string {
    const display = getSeverityDisplay(finding.severity);
    const labels = [`_${display.emoji} ${display.label}_`];
    if (finding.suggestion) {
      labels.push('_⚡ Quick win_');
    }
    return labels.join(' | ');
  }

  private suggestedFixDetails(suggestion: string): string {
    return [
      '<details>',
      '<summary>Suggested fix</summary>',
      '',
      this.formatCodeFence('diff', suggestionToDiff(suggestion)),
      '</details>',
    ].join('\n');
  }

  private committableSuggestionDetails(suggestion: string): string {
    return [
      '<details>',
      '<summary>📝 Committable suggestion</summary>',
      '',
      '> ‼️ **IMPORTANT**',
      '> Carefully review the code before committing. Ensure that it accurately replaces the highlighted code, contains no missing lines, and has no indentation issues. Test the change before merging.',
      '',
      formatSuggestionBlock(suggestion),
      '',
      '</details>',
    ].join('\n');
  }

  private agentPromptDetails(finding: Finding): string {
    const location =
      finding.startLine !== undefined &&
      finding.endLine !== undefined &&
      finding.startLine < finding.endLine
        ? `lines ${finding.startLine}-${finding.endLine}`
        : `line ${finding.line}`;

    return [
      '<details>',
      '<summary>🤖 Prompt for AI Agents</summary>',
      '',
      this.formatCodeFence(
        'text',
        [
          'Verify this finding against the current code and only fix it if needed.',
          '',
          `In \`@${finding.file}\` around ${location}, ${finding.message.trim()}`,
          finding.suggestion
            ? `Apply this candidate fix if it is still correct:\n\n${finding.suggestion.trim()}`
            : 'If the finding is valid, produce a minimal safe fix and update or add tests when appropriate.',
        ].join('\n')
      ),
      '</details>',
    ].join('\n');
  }

  private formatCodeFence(language: string, content: string): string {
    const fence = '`'.repeat(
      Math.max(3, countMaxConsecutiveBackticks(content) + 1)
    );
    return `${fence}${language}\n${content.trimEnd()}\n${fence}`;
  }

  private buildActionItems(findings: Finding[]): string[] {
    const items = findings
      .filter((f) => f.severity !== 'minor')
      .slice(0, 5)
      .map((f) => `${this.findingLocationLabel(f)} - ${f.title}`);

    return Array.from(new Set(items));
  }

  private findingLocationLabel(finding: Finding): string {
    return finding.startLine !== undefined &&
      finding.endLine !== undefined &&
      finding.startLine < finding.endLine
      ? `${finding.file}:${finding.startLine}-${finding.endLine}`
      : `${finding.file}:${finding.line}`;
  }
}

function suggestionToDiff(suggestion: string): string {
  return suggestion
    .trimEnd()
    .split('\n')
    .map((line) => `+${line}`)
    .join('\n');
}

function isSingleLineSuggestion(suggestion: string): boolean {
  return suggestion.trimEnd().split('\n').length === 1;
}
