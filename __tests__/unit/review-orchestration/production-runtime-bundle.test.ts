import { readFileSync } from 'fs';

type ProductionSourceMap = Readonly<{
  sources: readonly string[];
  sourcesContent: readonly (string | null)[];
}>;

const bundledReviewSources = Object.freeze([
  'src/review-investigation/infrastructure/review-action-v2-investigation-adapter.ts',
  'src/review-investigation/infrastructure/strict-cli-review-agent.ts',
  'src/review-orchestration/infrastructure/context-gateway-invocation-session.ts',
  'src/review-orchestration/infrastructure/production-review-investigation-composition.ts',
  'src/review-orchestration/infrastructure/production-review-projection.ts',
  'src/review-orchestration/infrastructure/production-t0-review-runner.ts',
  'src/review-projection/application/build-current-review-projection.ts',
  'src/review-projection/domain/review-projection.ts',
]);

describe('committed production review runtime bundle', () => {
  it('is the runtime launched by production entrypoints', () => {
    const actionLauncher = readFileSync('action-dist/index.cjs', 'utf8');
    const reusableWorkflow = readFileSync(
      '.github/workflows/reviewrouter-execution-reusable.yml',
      'utf8'
    );

    expect(actionLauncher).toContain('(actionPath, "dist", "index.js")');
    expect(reusableWorkflow).toContain(
      'node .reviewrouter-runtime/dist/index.js'
    );
  });

  it('contains the current authoritative projection and environment boundary', () => {
    const bundle = readFileSync('dist/index.js', 'utf8');

    expect(bundle).toContain('authoritativeObservationIds');
    expect(bundle).toContain('REVIEWROUTER_CONTEXT_GATEWAY_SECRET');
    expect(bundle).toContain('CLAUDE_CONFIG_DIR');
    expect(bundle).toContain('review_agent_runtime_environment_invalid');
    expect(bundle).toContain('//# sourceMappingURL=index.js.map');
  });

  it('keeps unfenced provider lanes out of the production investigation runner', () => {
    const source = readFileSync(
      'src/review-orchestration/infrastructure/production-t0-review-runner.ts',
      'utf8'
    );

    expect(source).not.toContain('ClaudeReviewAgentAdapter');
    expect(source).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(source).not.toContain('readCodexRotatingProviderSecretInputs');
  });

  it.each(bundledReviewSources)(
    'embeds current source for %s',
    (sourcePath) => {
      const sourceMap = JSON.parse(
        readFileSync('dist/index.js.map', 'utf8')
      ) as ProductionSourceMap;
      const bundledPath = `../${sourcePath}`;
      const sourceIndex = sourceMap.sources.indexOf(bundledPath);

      expect(sourceIndex).toBeGreaterThanOrEqual(0);
      expect(sourceMap.sourcesContent[sourceIndex]).toBe(
        readFileSync(sourcePath, 'utf8')
      );
    }
  );
});
