type BuildFullReviewRuntimeEnv = (
  input: {
    sourceEnv: NodeJS.ProcessEnv;
    inputs: {
      apiUrl: string;
      providerInstanceId: string;
      reviewTimeoutMinutes: number;
      providerSecrets: Record<string, never>;
    };
    leaseId: string;
    event: {
      number: number;
      repository: string;
      headSha: string;
      baseSha: string;
    };
    workspace: string;
    tempHome: string;
    tempCodexHome: string;
    codexBinDir: string;
    commentToken: string;
    runtimeConfigVersion: number;
    runtimeEnv: Record<string, string>;
  } & Record<string, unknown>
) => Record<string, string>;

const actionBundle = jest.requireActual('../../../action-dist/index.cjs') as {
  buildFullReviewRuntimeEnv: BuildFullReviewRuntimeEnv;
};

describe('hosted review runtime timeout compatibility', () => {
  it.each([
    {},
    { sourceEnv: { RUN_TIMEOUT_SECONDS: '  ' } },
    { runtimeEnv: { RUN_TIMEOUT_SECONDS: '  ' } },
  ])('defaults gpt-5.6-sol ultra reviews to 30 minutes: %o', (overrides) => {
    expect(buildRuntimeEnv(overrides).RUN_TIMEOUT_SECONDS).toBe('1800');
  });

  it('preserves an authoritative runtime timeout', () => {
    expect(
      buildRuntimeEnv({
        sourceEnv: { RUN_TIMEOUT_SECONDS: '2100' },
        runtimeEnv: { RUN_TIMEOUT_SECONDS: '2400' },
      }).RUN_TIMEOUT_SECONDS
    ).toBe('2400');
  });

  it('preserves an explicit ambient workflow timeout', () => {
    expect(
      buildRuntimeEnv({ sourceEnv: { RUN_TIMEOUT_SECONDS: '2100' } })
        .RUN_TIMEOUT_SECONDS
    ).toBe('2100');
  });

  it.each([
    { CODEX_MODEL: 'gpt-5.6-sol', CODEX_REASONING_EFFORT: 'xhigh' },
    { CODEX_MODEL: 'gpt-5.5', CODEX_REASONING_EFFORT: 'ultra' },
  ])('does not change non-target runtimes: %o', (runtimeEnv) => {
    expect(buildRuntimeEnv({ runtimeEnv }).RUN_TIMEOUT_SECONDS).toBeUndefined();
  });
});

function buildRuntimeEnv(
  overrides: {
    sourceEnv?: NodeJS.ProcessEnv;
    runtimeEnv?: Record<string, string>;
  } = {}
): Record<string, string> {
  return actionBundle.buildFullReviewRuntimeEnv({
    sourceEnv: { PATH: '/usr/bin', ...overrides.sourceEnv },
    inputs: {
      apiUrl: 'https://reviewrouter.test',
      providerInstanceId: 'provider-1',
      reviewTimeoutMinutes: 120,
      providerSecrets: {},
    },
    leaseId: 'lease-1',
    event: {
      number: 717,
      repository: 'Padelapp-Club/monorepository',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
    },
    workspace: '/tmp/reviewrouter-workspace',
    tempHome: '/tmp/reviewrouter-home',
    tempCodexHome: '/tmp/reviewrouter-codex-home',
    codexBinDir: '/tmp/reviewrouter-bin',
    commentToken: 'test-comment-token',
    runtimeConfigVersion: 4,
    runtimeEnv: {
      CODEX_MODEL: 'gpt-5.6-sol',
      CODEX_REASONING_EFFORT: 'ultra',
      ...overrides.runtimeEnv,
    },
  });
}
