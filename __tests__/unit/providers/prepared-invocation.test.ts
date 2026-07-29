import { ClaudeCodeProvider } from '../../../src/providers/claude-code';
import { CodexProvider } from '../../../src/providers/codex';
import { GeminiProvider } from '../../../src/providers/gemini';
import { OpenCodeProvider } from '../../../src/providers/opencode';
import { OpenRouterProvider } from '../../../src/providers/openrouter';
import {
  createPreparedProviderInvocation,
  mergeCredentialEnvironment,
  ProviderKind,
} from '../../../src/providers/prepared-invocation';
import { RateLimiter } from '../../../src/providers/rate-limiter';

function overridePrivate(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    value,
    writable: true,
  });
}

describe('prepared provider invocation contract', () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it('canonicalizes deterministically, distinguishes observable input, and deeply freezes it', () => {
    const left = createPreparedProviderInvocation({
      providerKind: ProviderKind.OpenRouterHttp,
      providerName: 'openrouter/test',
      requestedModel: 'test',
      timeoutMs: 1000,
      request: { z: [2, 1], a: { value: 'first' } },
    });
    const same = createPreparedProviderInvocation({
      providerKind: ProviderKind.OpenRouterHttp,
      providerName: 'openrouter/test',
      requestedModel: 'test',
      timeoutMs: 1000,
      request: { a: { value: 'first' }, z: [2, 1] },
    });
    const changed = createPreparedProviderInvocation({
      providerKind: ProviderKind.OpenRouterHttp,
      providerName: 'openrouter/test',
      requestedModel: 'test',
      timeoutMs: 1000,
      request: { a: { value: 'second' }, z: [2, 1] },
    });

    expect(left.observableInputPreimage).toBe(same.observableInputPreimage);
    expect(changed.observableInputPreimage).not.toBe(
      left.observableInputPreimage
    );
    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(left.request)).toBe(true);
    expect(Object.isFrozen(left.request.a)).toBe(true);
    expect(Object.isFrozen(left.request.z)).toBe(true);
    expect(() =>
      mergeCredentialEnvironment(
        { PATH: '/prepared/path' },
        { PATH: '/mutated/path' }
      )
    ).toThrow('provider_credential_lease_contains_runtime_config');
  });

  it('changes every built-in provider preimage when its final prompt changes', async () => {
    process.env.CODEX_AGENTIC_CONTEXT = 'false';
    const providers = [
      new CodexProvider('codex-model', { agenticContext: false }),
      new ClaudeCodeProvider('claude-model', { agenticContext: false }),
      new GeminiProvider('gemini-model'),
      new OpenCodeProvider('opencode-model'),
      new OpenRouterProvider('openrouter-model', 'credential', {
        isRateLimited: jest.fn().mockResolvedValue(false),
        markRateLimited: jest.fn().mockResolvedValue(undefined),
      } as unknown as RateLimiter),
    ];
    for (const provider of providers) {
      overridePrivate(
        provider,
        'resolveBinary',
        jest
          .fn()
          .mockResolvedValue(
            provider instanceof CodexProvider ||
              provider instanceof ClaudeCodeProvider
              ? 'provider-bin'
              : { bin: 'provider-bin', args: [] }
          )
      );
      const first = await provider.prepareInvocation('first prompt', 1000);
      const second = await provider.prepareInvocation('second prompt', 1000);
      expect(second.observableInputPreimage).not.toBe(
        first.observableInputPreimage
      );
    }
  });

  it('OpenRouter executes the frozen model, body, endpoint, and retry options', async () => {
    const limiter = {
      isRateLimited: jest.fn().mockResolvedValue(false),
      markRateLimited: jest.fn().mockResolvedValue(undefined),
    } as unknown as RateLimiter;
    const provider = new OpenRouterProvider('first-model', 'old-key', limiter);
    const prepared = await provider.prepareInvocation('first prompt', 1500);
    (provider as unknown as { modelId: string }).modelId = 'mutated-model';
    (provider as unknown as { apiKey: string }).apiKey = 'mutated-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({ findings: [], revalidations: [] }),
            },
          },
        ],
      }),
    } as unknown as Response);

    await provider.executePreparedInvocation(prepared, {
      bearerToken: 'leased-key',
    });

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'first-model',
      messages: [{ role: 'user', content: 'first prompt' }],
      temperature: 0.1,
      max_tokens: 2000,
    });
    expect(init.headers.Authorization).toBe('Bearer leased-key');
    expect(prepared.observableInputPreimage).not.toContain('old-key');
    expect(prepared.observableInputPreimage).not.toContain('leased-key');
  });

  it('CLI providers execute frozen binaries, models, prompts, cwd, and options', async () => {
    process.env.CODEX_AGENTIC_CONTEXT = 'false';
    process.env.CODEX_REASONING_EFFORT = 'low';
    process.env.OPENAI_API_KEY = 'codex-secret';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-first-secret';

    const codex = new CodexProvider('codex-first', {
      agenticContext: false,
      eventAudit: false,
    });
    overridePrivate(
      codex,
      'resolveBinary',
      jest.fn().mockResolvedValue('codex-first-bin')
    );
    const codexPrepared = await codex.prepareInvocation('codex prompt', 1200);
    overridePrivate(codex, 'model', 'codex-mutated');
    overridePrivate(codex, 'options', {
      agenticContext: true,
      eventAudit: true,
    });
    process.env.CODEX_REASONING_EFFORT = 'high';
    const codexRun = jest.fn().mockResolvedValue({
      stdout: '',
      stderr: '',
      lastMessage: JSON.stringify({ findings: [], revalidations: [] }),
      actualModelObservation: { kind: 'missing' },
    });
    overridePrivate(codex, 'runCliWithStdin', codexRun);
    await codex.executePreparedInvocation(codexPrepared, {
      environment: { OPENAI_API_KEY: 'leased-codex-secret' },
    });
    expect(codexRun.mock.calls[0][0]).toBe('codex-first-bin');
    expect(codexRun.mock.calls[0][1]).toContain('codex prompt');
    expect(codexRun.mock.calls[0][4].argsTemplate).toEqual(
      expect.arrayContaining([
        '--model',
        'codex-first',
        'model_reasoning_effort="low"',
      ])
    );
    expect(codexRun.mock.calls[0][4].environment.OPENAI_API_KEY).toBe(
      'leased-codex-secret'
    );
    expect(codexPrepared.observableInputPreimage).not.toContain('codex-secret');

    const claude = new ClaudeCodeProvider('claude-first', {
      agenticContext: false,
    });
    overridePrivate(
      claude,
      'resolveBinary',
      jest.fn().mockResolvedValue('claude-first-bin')
    );
    const claudePrepared = await claude.prepareInvocation(
      'claude prompt',
      1300
    );
    overridePrivate(claude, 'model', 'claude-mutated');
    overridePrivate(claude, 'options', { agenticContext: true });
    process.env.REVIEWROUTER_FORK_AGENTIC_SANDBOX = 'true';
    const claudeRun = jest.fn().mockResolvedValue({
      stdout: JSON.stringify({
        structured_output: { findings: [], revalidations: [] },
      }),
      stderr: '',
    });
    overridePrivate(claude, 'runCliWithStdin', claudeRun);
    await claude.executePreparedInvocation(claudePrepared, {
      bearerToken: 'sk-ant-oat01-leased-secret',
    });
    expect(claudeRun.mock.calls[0][0]).toMatchObject({
      binary: 'claude-first-bin',
      prompt: 'claude prompt',
      forkSandbox: false,
    });
    expect(claudePrepared.requestedModel).toBe('claude-first');
    expect(claudePrepared.observableInputPreimage).not.toContain(
      'sk-ant-oat01-first-secret'
    );

    process.env.PATH = '/prepared/path';
    const gemini = new GeminiProvider('gemini-first');
    overridePrivate(
      gemini,
      'resolveBinary',
      jest.fn().mockResolvedValue({ bin: 'gemini-first-bin', args: ['base'] })
    );
    const geminiPrepared = await gemini.prepareInvocation(
      'gemini prompt',
      1400
    );
    overridePrivate(gemini, 'model', 'gemini-mutated');
    process.env.PATH = '/mutated/path';
    const geminiRun = jest.fn().mockResolvedValue({
      stdout: JSON.stringify({ findings: [], revalidations: [] }),
      stderr: '',
    });
    overridePrivate(gemini, 'runCli', geminiRun);
    await gemini.executePreparedInvocation(geminiPrepared, {
      environment: { GEMINI_API_KEY: 'leased-gemini-secret' },
    });
    expect(geminiRun.mock.calls[0][0]).toBe('gemini-first-bin');
    expect(geminiRun.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['--model', 'gemini-first'])
    );
    expect(geminiRun.mock.calls[0][4]).toMatchObject({
      PATH: '/prepared/path',
      GEMINI_API_KEY: 'leased-gemini-secret',
    });

    process.env.PATH = '/prepared/opencode/path';
    const opencode = new OpenCodeProvider('opencode-first');
    overridePrivate(
      opencode,
      'resolveBinary',
      jest.fn().mockResolvedValue({ bin: 'opencode-first-bin', args: ['base'] })
    );
    const opencodePrepared = await opencode.prepareInvocation(
      'opencode prompt',
      1500
    );
    overridePrivate(opencode, 'modelId', 'opencode-mutated');
    process.env.PATH = '/mutated/opencode/path';
    const opencodeRun = jest.fn().mockResolvedValue({
      stdout: JSON.stringify({ findings: [], revalidations: [] }),
      stderr: '',
    });
    overridePrivate(opencode, 'runCli', opencodeRun);
    await opencode.executePreparedInvocation(opencodePrepared, {
      environment: { OPENCODE_API_KEY: 'leased-opencode-secret' },
    });
    expect(opencodeRun.mock.calls[0][0]).toBe('opencode-first-bin');
    expect(opencodeRun.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['-m', 'opencode/opencode-first'])
    );
    expect(opencodeRun.mock.calls[0][4]).toMatchObject({
      PATH: '/prepared/opencode/path',
      OPENCODE_API_KEY: 'leased-opencode-secret',
    });
  });
});
