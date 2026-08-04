import { DEFAULT_CONFIG } from '../../../src/config/defaults';

describe('DEFAULT_CONFIG', () => {
  it('should have valid default providers', () => {
    expect(Array.isArray(DEFAULT_CONFIG.providers)).toBe(true);
  });

  it('should have valid default thresholds', () => {
    expect(DEFAULT_CONFIG.inlineMinSeverity).toBe('major');
    expect(DEFAULT_CONFIG.inlineMinAgreement).toBeGreaterThan(0);
  });

  it('should enable core features by default', () => {
    expect(DEFAULT_CONFIG.enableAstAnalysis).toBe(true);
    expect(DEFAULT_CONFIG.enableSecurity).toBe(true);
  });

  it('should have reasonable timeout and budget limits', () => {
    expect(DEFAULT_CONFIG.runTimeoutSeconds).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.openrouterTimeoutSeconds).toBe(300);
    expect(DEFAULT_CONFIG.openrouterTimeoutSeconds).toBeLessThan(
      DEFAULT_CONFIG.runTimeoutSeconds
    );
    expect(DEFAULT_CONFIG.budgetMaxUsd).toBeGreaterThanOrEqual(0);
  });

  it('defaults provider retries to three total attempts', () => {
    expect(DEFAULT_CONFIG.providerRetries).toBe(3);
  });

  it('keeps required healthy providers opt-in for raw action usage', () => {
    expect(DEFAULT_CONFIG.requiredHealthyProviders).toEqual([]);
  });

  it('keeps full-patch and prompt budgets aligned for large review batches', () => {
    expect(DEFAULT_CONFIG.diffMaxBytes).toBe(240_000);
    expect(DEFAULT_CONFIG.maxFullDiffFileBytes).toBe(60_000);
    expect(DEFAULT_CONFIG.maxFullDiffFileChanges).toBe(1_000);
  });
});
