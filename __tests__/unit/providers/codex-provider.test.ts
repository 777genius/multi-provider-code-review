import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import {
  CodexProvider,
  type CodexContextGatewayInvocationConfig,
} from '../../../src/providers/codex';
import { RateLimitError } from '../../../src/providers/base';
import { logger } from '../../../src/utils/logger';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
  spawnSync: jest.fn(),
}));

const spawnMock = spawn as unknown as jest.Mock;
const spawnSyncMock = spawnSync as unknown as jest.Mock;

function overridePrivate(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    value,
    writable: true,
  });
}

function createMockProcess(onStart?: (proc: any) => void, closeCode = 0): any {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  proc.pid = 12345;

  process.nextTick(() => {
    onStart?.(proc);
    proc.emit('close', closeCode);
  });

  return proc;
}

function contextGatewayConfig(
  suffix = 'one'
): CodexContextGatewayInvocationConfig {
  return {
    command: process.execPath,
    args: ['/tmp/reviewrouter-context-gateway.js'],
    cwd: '/tmp/reviewrouter-checkout',
    gatewayBinaryHash: 'a'.repeat(64),
    gatewayPolicyVersion: 'context-gateway-v3',
    enabledTools: [
      'review_read_file',
      'review_list_directory',
      'review_search_text',
      'review_git_fact',
    ],
    runtimeEnvironment: {
      REVIEWROUTER_CONTEXT_GATEWAY_POLICY_VERSION: 'context-gateway-v3',
      REVIEWROUTER_CONTEXT_SESSION_ID: `session-${suffix}`,
      REVIEWROUTER_CONTEXT_ROOT: '/tmp/reviewrouter-checkout',
      REVIEWROUTER_CONTEXT_TRANSCRIPT_PATH: `/tmp/transcript-${suffix}.json`,
      REVIEWROUTER_CONTEXT_REPLAY_MATERIAL_PATH: `/tmp/replay-${suffix}.json`,
      REVIEWROUTER_CONTEXT_GATEWAY_BINARY_HASH: 'a'.repeat(64),
      REVIEWROUTER_CONTEXT_CHECKOUT_TREE_OID: 'b'.repeat(40),
      REVIEWROUTER_CONTEXT_MERGE_BASE_TREE_OID: 'c'.repeat(40),
      REVIEWROUTER_CONTEXT_EVENT_CHAIN_SEED_HASH: 'c'.repeat(64),
      REVIEWROUTER_CONTEXT_BASE_SHA: 'd'.repeat(40),
      REVIEWROUTER_CONTEXT_MERGE_BASE_SHA: 'f'.repeat(40),
      REVIEWROUTER_CONTEXT_HEAD_SHA: 'e'.repeat(40),
    },
  };
}

function contextGatewayV4Config(): CodexContextGatewayInvocationConfig {
  const gateway = contextGatewayConfig('v4');
  return {
    ...gateway,
    gatewayPolicyVersion: 'context-gateway-v4',
    enabledTools: [
      'review_read_file',
      'review_list_directory',
      'review_search_text',
      'review_canonical_inventory',
      'review_git_fact',
    ],
    runtimeEnvironment: {
      ...gateway.runtimeEnvironment,
      REVIEWROUTER_CONTEXT_GATEWAY_POLICY_VERSION: 'context-gateway-v4',
    },
  };
}

describe('CodexProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('builds read-only agentic exec args without dangerous sandbox bypass', () => {
    const provider = new CodexProvider('gpt-5.4-mini');
    const args = (provider as any).buildExecArgs({
      healthCheck: false,
      outputLastMessageFile: '/tmp/codex-output.txt',
      outputSchemaFile: '/tmp/codex-schema.json',
      eventAudit: true,
    });

    expect(args).toContain('exec');
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--ignore-rules');
    expect(args).toContain('--output-schema');
    expect(args).toContain('/tmp/codex-schema.json');
    expect(args).toContain('--output-last-message');
    expect(args).toContain('/tmp/codex-output.txt');
    expect(args).toContain('--json');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('allows generated CODEX_HOME config in fork agentic sandbox mode', () => {
    process.env.REVIEWROUTER_FORK_AGENTIC_SANDBOX = 'true';
    const provider = new CodexProvider('gpt-5.5');
    const args = (provider as any).buildExecArgs({
      healthCheck: false,
      outputLastMessageFile: '/tmp/codex-output.txt',
      outputSchemaFile: '/tmp/codex-schema.json',
      eventAudit: true,
    });

    expect(args).not.toContain('--ignore-user-config');
    expect(args).toContain('--ignore-rules');
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
  });

  it('can request JSON events for agentic audit without enabling verbose event audit', () => {
    const provider = new CodexProvider('gpt-5.4-mini');
    const args = (provider as any).buildExecArgs({
      healthCheck: false,
      outputLastMessageFile: '/tmp/codex-output.txt',
      jsonEvents: true,
      eventAudit: false,
    });

    expect(args).toContain('--json');
  });

  it('can route Codex CLI through OpenRouter without user config', () => {
    const provider = new CodexProvider('openai/gpt-5.3-codex', {
      modelProvider: 'openrouter',
      providerNamePrefix: 'codex-openrouter',
    });
    const args = (provider as any).buildExecArgs({
      healthCheck: false,
      outputLastMessageFile: '/tmp/codex-output.txt',
      outputSchemaFile: '/tmp/codex-schema.json',
    });

    expect(provider.name).toBe('codex-openrouter/openai/gpt-5.3-codex');
    expect(args).toEqual(
      expect.arrayContaining([
        '-c',
        'model_provider="openrouter"',
        'model_providers.openrouter.name="openrouter"',
        'model_providers.openrouter.base_url="https://openrouter.ai/api/v1"',
        'model_providers.openrouter.env_key="OPENROUTER_API_KEY"',
      ])
    );
    expect(args).toContain('--ignore-user-config');
  });

  it('can keep public OpenRouter provider identity while stripping instance suffix from Codex model', () => {
    const provider = new CodexProvider('openai/gpt-oss-120b:free', {
      modelProvider: 'openrouter',
      providerNamePrefix: 'openrouter',
      providerNameModel: 'openai/gpt-oss-120b:free#8',
    });
    const args = (provider as any).buildExecArgs({
      healthCheck: false,
      outputLastMessageFile: '/tmp/codex-output.txt',
    });

    expect(provider.name).toBe('openrouter/openai/gpt-oss-120b:free#8');
    expect(args).toContain('openai/gpt-oss-120b:free');
    expect(args).not.toContain('openai/gpt-oss-120b:free#8');
  });

  it('uses lightweight health checks by default to avoid consuming Codex usage', async () => {
    spawnMock.mockImplementation((_cmd: string, _args: string[]) =>
      createMockProcess()
    );

    const provider = new CodexProvider('gpt-5.4-mini');
    await expect(provider.healthCheck(1000)).resolves.toBe(true);

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('supports explicit exec health checks when requested', async () => {
    process.env.CODEX_HEALTHCHECK_MODE = 'exec';
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess(() => {
        const outputIndex = args.indexOf('--output-last-message');
        fs.writeFileSync(args[outputIndex + 1], 'codex-health-ok');
      });
    });

    const provider = new CodexProvider('gpt-5.4-mini');
    await expect(provider.healthCheck(1000)).resolves.toBe(true);

    const execCall = spawnMock.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1][0] === 'exec'
    );
    expect(execCall).toBeTruthy();
    expect(execCall?.[1]).toContain('gpt-5.4-mini');
  });

  it('logs normalized failures without exposing the original stack', async () => {
    const provider = new CodexProvider('gpt-5.4-mini');
    const providerError = new Error("You've hit your usage limit.");
    providerError.stack = 'provider stack with bearer-secret-value';
    jest
      .spyOn(provider as any, 'executePreparedDetailed')
      .mockRejectedValue(providerError);
    const logError = jest
      .spyOn(logger, 'error')
      .mockImplementation(() => undefined);

    await expect(provider.executePreparedInvocation({} as any)).rejects.toThrow(
      'usage limit'
    );

    expect(logError).toHaveBeenCalledWith(
      'Codex provider failed: codex/gpt-5.4-mini',
      { error: "You've hit your usage limit." }
    );
    expect(JSON.stringify(logError.mock.calls)).not.toContain(
      'bearer-secret-value'
    );
  });

  it('can disable interactive/tool features for isolated discussion prompts', () => {
    const provider = new CodexProvider('gpt-5.4-mini');
    const args = (provider as any).buildExecArgs({
      healthCheck: false,
      outputLastMessageFile: '/tmp/codex-output.txt',
      outputSchemaFile: '/tmp/codex-schema.json',
      disableTools: true,
      skipGitRepoCheck: true,
    });

    expect(args).toEqual(
      expect.arrayContaining([
        '--skip-git-repo-check',
        '--disable',
        'shell_tool',
        'unified_exec',
        'browser_use',
        'computer_use',
        'plugins',
      ])
    );
    expect(args.indexOf('--skip-git-repo-check')).toBe(1);
  });

  it('confines context-gateway reviews to the allowlisted MCP server', () => {
    process.env.REVIEWROUTER_CONTEXT_GATEWAY_SECRET =
      'must-not-appear-in-cli-args';
    const provider = new CodexProvider('gpt-5.4-mini');
    const gateway = contextGatewayConfig();
    const args = (provider as any).buildExecArgs(
      {
        healthCheck: false,
        outputLastMessageFile: '/tmp/codex-output.txt',
        outputSchemaFile: '/tmp/codex-schema.json',
        jsonEvents: true,
      },
      undefined,
      gateway
    );

    expect(args).toEqual(
      expect.arrayContaining([
        '--disable',
        'shell_tool',
        'unified_exec',
        'browser_use',
        'computer_use',
        'web_search_request',
        'plugins',
        '-c',
        'mcp_servers={}',
        `mcp_servers.reviewrouter.command=${JSON.stringify(process.execPath)}`,
        `mcp_servers.reviewrouter.args=${JSON.stringify(gateway.args)}`,
        `mcp_servers.reviewrouter.env_vars=${JSON.stringify(
          [
            ...Object.keys(gateway.runtimeEnvironment),
            'REVIEWROUTER_CONTEXT_GATEWAY_SECRET',
          ].sort()
        )}`,
        'mcp_servers.reviewrouter.required=true',
        'mcp_servers.reviewrouter.startup_timeout_sec=45',
      ])
    );
    expect(args.join('\n')).toContain(
      'mcp_servers.reviewrouter.enabled_tools='
    );
    expect(args.join('\n')).not.toContain('must-not-appear-in-cli-args');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('accepts the versioned v4 context-gateway tool and environment contract', () => {
    const provider = new CodexProvider('gpt-5.5');
    const gateway = contextGatewayV4Config();

    expect(() =>
      (provider as any).validateContextGatewayConfig(gateway)
    ).not.toThrow();
  });

  it('rejects a context-gateway tool set from a different policy version', () => {
    const provider = new CodexProvider('gpt-5.5');
    const v4 = contextGatewayV4Config();
    const mismatched = {
      ...v4,
      gatewayPolicyVersion: 'context-gateway-v3',
      runtimeEnvironment: {
        ...v4.runtimeEnvironment,
        REVIEWROUTER_CONTEXT_GATEWAY_POLICY_VERSION: 'context-gateway-v3',
      },
    };

    expect(() =>
      (provider as any).validateContextGatewayConfig(mismatched)
    ).toThrow('codex_context_gateway_tool_policy_invalid');
  });

  it('rejects a context-gateway runtime policy mismatch', () => {
    const provider = new CodexProvider('gpt-5.5');
    const v4 = contextGatewayV4Config();
    const mismatched = {
      ...v4,
      runtimeEnvironment: {
        ...v4.runtimeEnvironment,
        REVIEWROUTER_CONTEXT_GATEWAY_POLICY_VERSION: 'context-gateway-v3',
      },
    };

    expect(() =>
      (provider as any).validateContextGatewayConfig(mismatched)
    ).toThrow('codex_context_gateway_environment_incomplete');
  });

  it('rejects an unknown context-gateway policy version', () => {
    const provider = new CodexProvider('gpt-5.5');
    const v4 = contextGatewayV4Config();
    const unknown = {
      ...v4,
      gatewayPolicyVersion: 'context-gateway-v5',
      runtimeEnvironment: {
        ...v4.runtimeEnvironment,
        REVIEWROUTER_CONTEXT_GATEWAY_POLICY_VERSION: 'context-gateway-v5',
      },
    };

    expect(() =>
      (provider as any).validateContextGatewayConfig(unknown)
    ).toThrow('codex_context_gateway_config_invalid');
  });

  it('does not delegate the required changed-paths witness to the model', () => {
    const provider = new CodexProvider('gpt-5.4-mini');
    const gateway = contextGatewayConfig();
    const prompt = (provider as any).wrapContextGatewayReviewPrompt(
      'deterministic review input',
      gateway.enabledTools
    );

    expect(prompt).not.toContain('MUST call review_git_fact');
    expect(prompt).toContain('Then inspect changed hunks');
    expect(prompt).toContain('truncated');
    expect(prompt).toContain('complete');
    expect(prompt).toContain('do not produce final JSON');
  });

  it('lists the v4 canonical-inventory tool in the confined review prompt', () => {
    const provider = new CodexProvider('gpt-5.5');
    const gateway = contextGatewayV4Config();
    const prompt = (provider as any).wrapContextGatewayReviewPrompt(
      'deterministic review input',
      gateway.enabledTools
    );

    expect(prompt).toContain('- review_canonical_inventory');
  });

  it('keeps ephemeral runner paths and gateway session data out of semantic identity', async () => {
    spawnMock.mockImplementation(() => createMockProcess());
    const provider = new CodexProvider('gpt-5.4-mini');
    overridePrivate(
      provider,
      'resolveBinary',
      jest
        .fn()
        .mockResolvedValueOnce('/tmp/codex-install-first/bin/codex')
        .mockResolvedValueOnce('/tmp/codex-install-second/bin/codex')
    );

    process.env.CODEX_HOME = '/tmp/codex-home-first';
    process.env.PATH = '/tmp/codex-install-first/bin:/usr/bin';
    const first = await provider.prepareInvocation(
      'same semantic prompt',
      1_000,
      undefined,
      contextGatewayConfig('first')
    );
    process.env.CODEX_HOME = '/tmp/codex-home-second';
    process.env.PATH = '/tmp/codex-install-second/bin:/usr/bin';
    const second = await provider.prepareInvocation(
      'same semantic prompt',
      1_000,
      undefined,
      contextGatewayConfig('second')
    );

    expect(first.observableInputPreimage).toBe(second.observableInputPreimage);
    expect(first.observableInputPreimage).not.toContain('session-first');
    expect(first.observableInputPreimage).not.toContain('transcript-first');
    expect(first.observableInputPreimage).not.toContain('codex-home-first');
    expect(first.observableInputPreimage).not.toContain('codex-install-first');
    expect(first.observableInputPreimage).not.toContain('b'.repeat(40));
    expect(provider.describePreparedEnvironmentContract(first)).toEqual(
      provider.describePreparedEnvironmentContract(second)
    );
    expect(first.request.environment.REVIEWROUTER_CONTEXT_SESSION_ID).toBe(
      'session-first'
    );
  });

  it('keeps ephemeral runner paths out of non-gateway semantic identity', async () => {
    const provider = new CodexProvider('gpt-5.4-mini');
    overridePrivate(
      provider,
      'resolveBinary',
      jest
        .fn()
        .mockResolvedValueOnce('/tmp/codex-install-first/bin/codex')
        .mockResolvedValueOnce('/tmp/codex-install-second/bin/codex')
    );

    process.env.CODEX_HOME = '/tmp/codex-home-first';
    process.env.PATH = '/tmp/codex-install-first/bin:/usr/bin';
    const first = await provider.prepareInvocation(
      'same semantic prompt',
      1_000
    );
    process.env.CODEX_HOME = '/tmp/codex-home-second';
    process.env.PATH = '/tmp/codex-install-second/bin:/usr/bin';
    const second = await provider.prepareInvocation(
      'same semantic prompt',
      1_000
    );

    expect(first.observableInputPreimage).toBe(second.observableInputPreimage);
    expect(first.observableInputPreimage).not.toContain('codex-home-first');
    expect(first.observableInputPreimage).not.toContain('codex-install-first');
    expect(provider.describePreparedEnvironmentContract(first)).toEqual(
      provider.describePreparedEnvironmentContract(second)
    );
  });

  it('keeps behavior-affecting environment changes in semantic identity', async () => {
    const provider = new CodexProvider('gpt-5.4-mini');
    overridePrivate(
      provider,
      'resolveBinary',
      jest.fn().mockResolvedValue('/tmp/codex-install/bin/codex')
    );
    process.env.CODEX_HOME = '/tmp/codex-home';
    process.env.PATH = '/tmp/codex-install/bin:/usr/bin';
    process.env.LANG = 'C.UTF-8';
    const first = await provider.prepareInvocation(
      'same semantic prompt',
      1_000,
      undefined,
      contextGatewayConfig('first')
    );

    process.env.LANG = 'en_US.UTF-8';
    const second = await provider.prepareInvocation(
      'same semantic prompt',
      1_000,
      undefined,
      contextGatewayConfig('second')
    );

    expect(first.observableInputPreimage).not.toBe(
      second.observableInputPreimage
    );
    expect(provider.describePreparedEnvironmentContract(first)).not.toEqual(
      provider.describePreparedEnvironmentContract(second)
    );
  });

  it('distinguishes missing, observed, and ambiguous model telemetry', () => {
    const provider = new CodexProvider('gpt-5.4-mini');
    const inspect = (stdout: string) =>
      (provider as any).inspectActualModel(stdout);

    expect(
      inspect(
        `${JSON.stringify({
          type: 'session_configured',
          model: 'gpt-5.6-codex',
        })}\n`
      )
    ).toEqual({ kind: 'observed', model: 'gpt-5.6-codex' });
    expect(
      inspect(
        [
          JSON.stringify({
            type: 'session_configured',
            model: 'gpt-5.6-codex',
          }),
          JSON.stringify({
            type: 'session_configured',
            model: 'gpt-5.5-codex',
          }),
        ].join('\n')
      )
    ).toEqual({ kind: 'ambiguous' });
    expect(
      inspect(JSON.stringify({ type: 'thread.started', model: 'forged' }))
    ).toEqual({ kind: 'missing' });
  });

  it('sanitizes spawned Codex environment', () => {
    process.env.PATH = '/usr/bin';
    process.env.HOME = '/home/runner';
    process.env.CODEX_HOME = '/tmp/codex';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.GITHUB_TOKEN = 'gh-token';
    process.env.INPUT_GITHUB_TOKEN = 'input-token';
    process.env.OPENROUTER_API_KEY = 'or-key';

    const provider = new CodexProvider('gpt-5.4-mini');
    const env = (provider as any).buildSafeEnv();

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/runner');
    expect(env.CODEX_HOME).toBe('/tmp/codex');
    expect(env.OPENAI_API_KEY).toBe('sk-test');
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.INPUT_GITHUB_TOKEN).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it('allows OpenRouter API key only for OpenRouter-backed Codex runs', () => {
    process.env.PATH = '/usr/bin';
    process.env.HOME = '/home/runner';
    process.env.OPENROUTER_API_KEY = 'or-key';

    const provider = new CodexProvider('openai/gpt-5.3-codex', {
      modelProvider: 'openrouter',
      providerNamePrefix: 'codex-openrouter',
    });
    const env = (provider as any).buildSafeEnv();

    expect(env.OPENROUTER_API_KEY).toBe('or-key');
  });

  it('uses REVIEWROUTER_CODEX_BINARY when provided', async () => {
    process.env.REVIEWROUTER_CODEX_BINARY = '/tmp/reviewrouter-codex';
    spawnMock.mockReturnValue(createMockProcess());

    const provider = new CodexProvider('gpt-5.4-mini');
    const binary = await (provider as any).resolveBinary();

    expect(binary).toBe('/tmp/reviewrouter-codex');
    expect(spawnMock).toHaveBeenCalledWith(
      '/tmp/reviewrouter-codex',
      ['--version'],
      expect.objectContaining({
        cwd: os.tmpdir(),
        env: expect.objectContaining({
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        }),
        stdio: 'ignore',
      })
    );
  });

  it('treats binary health check mode as a lightweight readiness check', async () => {
    process.env.CODEX_HEALTHCHECK_MODE = 'binary';

    const provider = new CodexProvider('gpt-5.4-mini');
    const healthy = await provider.healthCheck(30_000);

    expect(healthy).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('falls back to the prepared rotating Codex CLI install root', async () => {
    const installRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'reviewrouter-codex-cli-')
    );
    const binDir = path.join(installRoot, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const codexBinary = path.join(binDir, 'codex');
    fs.writeFileSync(codexBinary, '#!/usr/bin/env node\n');
    fs.chmodSync(codexBinary, 0o755);
    spawnMock.mockImplementation((cmd: string) => {
      if (cmd === 'codex' || cmd === 'codex-cli') {
        return createMockProcess(undefined, 1);
      }
      return createMockProcess();
    });

    try {
      const provider = new CodexProvider('gpt-5.4-mini');
      const binary = await (provider as any).resolveBinary();

      expect(binary).toBe(codexBinary);
    } finally {
      fs.rmSync(installRoot, { recursive: true, force: true });
    }
  });

  it('trusts the pinned Codex CLI prepared by the bootstrap resolver', async () => {
    (CodexProvider as any).preparedBinaryPath = undefined;
    const failedCommands = new Set(['codex', 'codex-cli']);
    spawnMock.mockImplementation((cmd: string) => {
      if (failedCommands.has(cmd)) {
        return createMockProcess(undefined, 1);
      }
      return createMockProcess();
    });

    const provider = new CodexProvider('gpt-5.4-mini');
    const binary = await (provider as any).resolveBinary();

    expect(binary).toContain('reviewrouter-codex-cli-');
    expect(binary).toContain(path.join('node_modules', '.bin', 'codex'));
  });

  it('allows agentic review findings for concrete user-visible regressions', async () => {
    const provider = new CodexProvider('gpt-5.4-mini');
    const prompt = await (provider as any).wrapAgenticReviewPrompt(
      'review prompt'
    );

    expect(prompt).toContain('user-visible functional regressions');
    expect(prompt).toContain('permanent loading');
    expect(prompt).toContain('stale UI state');
    expect(prompt).toContain('create/update/delete side effects');
    expect(prompt).toContain('dead-end navigation');
    expect(prompt).toContain('wrong access control state');
    expect(prompt).toContain('changed helper/API contract regressions');
    expect(prompt).toContain('inverted boolean/filter/ignore semantics');
    expect(prompt).toContain('dropped non-string structured fields');
    expect(prompt).toContain('broken draft/recovery/delete flows');
    expect(prompt).toContain('Universal context discovery checklist');
    expect(prompt).toContain('package.json');
    expect(prompt).toContain('pubspec.lock');
    expect(prompt).toContain('go.mod');
    expect(prompt).toContain('pyproject.toml');
    expect(prompt).toContain('Cargo.toml');
    expect(prompt).toContain('trace the nearest imports/includes/exports');
    expect(prompt).toContain('treat the issue as insufficiently proven');
    expect(prompt).toContain('distinguish direct caller response handling');
    expect(prompt).toContain('does not prove other open clients');
    expect(prompt).toContain(
      'no framework evidence proves equivalent global propagation'
    );
  });

  it('adds a strict JSON-only output contract to agentic prompts', async () => {
    const provider = new CodexProvider('gpt-5.4-mini');
    const prompt = await (provider as any).wrapAgenticReviewPrompt(
      'review prompt'
    );

    expect(prompt).toContain('Return ONLY one valid JSON object');
    expect(prompt).toContain('No markdown, no prose, no code fences');
    expect(prompt).toContain('comments, trailing commas');
    expect(prompt).toContain('{"findings":[],"revalidations":[]}');
  });

  it('adds a strict JSON-only output contract to prompt-only prompts', () => {
    const provider = new CodexProvider('gpt-5.4-mini');
    const prompt = (provider as any).wrapPromptOnlyReviewPrompt(
      'review prompt'
    );

    expect(prompt).toContain('Return ONLY one valid JSON object');
    expect(prompt).toContain('No markdown, no prose, no code fences');
    expect(prompt).toContain('comments, trailing commas');
    expect(prompt).toContain('{"findings":[],"revalidations":[]}');
  });

  it('never teaches Codex placeholder values that ReviewRouter rejects', async () => {
    const provider = new CodexProvider('gpt-5.6-sol');
    const gateway = contextGatewayConfig();
    const prompts = [
      (provider as any).wrapContextGatewayReviewPrompt(
        'review prompt',
        gateway.enabledTools
      ),
      await (provider as any).wrapAgenticReviewPrompt('review prompt'),
      (provider as any).wrapPromptOnlyReviewPrompt('review prompt'),
    ];

    for (const prompt of prompts) {
      expect(prompt).not.toContain('"file":"path"');
      expect(prompt).not.toContain('"title":"short"');
      expect(prompt).not.toContain('"message":"specific evidence"');
      expect(prompt).not.toContain('"targetId":"rrt_example"');
      expect(prompt).toContain(
        'never copy schema descriptions or field names as field values'
      );
    }
  });

  it('parses strict schema findings with nullable suggestion', () => {
    const provider = new CodexProvider('gpt-5.4-mini');
    const findings = (provider as any).extractFindings(
      JSON.stringify({
        findings: [
          {
            file: 'src/app.ts',
            line: 42,
            severity: 'major',
            title: 'Crash',
            message: 'This can crash.',
            suggestion: null,
          },
        ],
      })
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: 'src/app.ts',
      line: 42,
      severity: 'major',
    });
    expect(findings[0].suggestion).toBeUndefined();
  });

  it('parses strict schema findings with multi-line ranges', () => {
    const provider = new CodexProvider('gpt-5.4-mini');
    const findings = (provider as any).extractFindings(
      JSON.stringify({
        findings: [
          {
            file: 'src/app.ts',
            startLine: 40,
            line: 42,
            endLine: 42,
            severity: 'major',
            title: 'Crash',
            message: 'This changed block can crash.',
            suggestion: null,
          },
        ],
      })
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: 'src/app.ts',
      startLine: 40,
      line: 42,
      endLine: 42,
      severity: 'major',
    });
  });

  it('reads final review content from --output-last-message instead of stdout', async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess(() => {
        const outputIndex = args.indexOf('--output-last-message');
        const outputFile = args[outputIndex + 1];
        fs.writeFileSync(outputFile, '{"findings":[]}');
      });
    });

    const provider = new CodexProvider('gpt-5.4-mini', {
      agenticContext: true,
      eventAudit: false,
    });
    const result = await provider.review('review prompt', 1000);
    const execCall = spawnMock.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1][0] === 'exec'
    );

    expect(result.content).toBe('{"findings":[]}');
    expect(result.findings).toEqual([]);
    expect(execCall).toBeTruthy();
    expect(execCall?.[1]).toContain('--output-schema');
    expect(execCall?.[1]).not.toContain(
      '--dangerously-bypass-approvals-and-sandbox'
    );
  });

  it('drops GitHub workspace env for OpenRouter-backed Codex in fork sandbox mode', async () => {
    process.env.REVIEWROUTER_FORK_AGENTIC_SANDBOX = 'true';
    process.env.GITHUB_WORKSPACE = '/home/runner/work/repo/repo';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess(() => {
        const outputIndex = args.indexOf('--output-last-message');
        const outputFile = args[outputIndex + 1];
        fs.writeFileSync(outputFile, '{"findings":[]}');
      });
    });

    const provider = new CodexProvider('openai/gpt-5.3-codex', {
      agenticContext: true,
      eventAudit: false,
      modelProvider: 'openrouter',
      providerNamePrefix: 'openrouter',
    });
    await provider.review('review prompt', 1000);

    const execCall = spawnMock.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1][0] === 'exec'
    );
    expect(execCall?.[1]).toContain('model_provider="openrouter"');
    expect(execCall?.[2]?.env.OPENROUTER_API_KEY).toBe('sk-or-test');
    expect(execCall?.[2]?.env.GITHUB_WORKSPACE).toBeUndefined();
  });

  it('reruns agentic review once when empty findings have no recorded exploration', async () => {
    let execCount = 0;
    const finding = {
      findings: [
        {
          file: 'src/main/services/error/TriggerMatcher.ts',
          startLine: null,
          line: 83,
          endLine: null,
          severity: 'major',
          title: 'Ignore patterns are inverted',
          message:
            'The changed matchesIgnorePatterns helper now returns true when no ignore patterns match, so callers skip errors that should be reported.',
          suggestion: null,
        },
      ],
      revalidations: [],
    };

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      execCount += 1;
      return createMockProcess((proc) => {
        const outputIndex = args.indexOf('--output-last-message');
        const outputFile = args[outputIndex + 1];
        if (execCount === 1) {
          fs.writeFileSync(outputFile, '{"findings":[],"revalidations":[]}');
          return;
        }

        proc.stdout.emit(
          'data',
          `${JSON.stringify({
            item: {
              type: 'command_execution',
              command:
                'sed -n "70,95p" src/main/services/error/TriggerMatcher.ts',
            },
          })}\n`
        );
        fs.writeFileSync(outputFile, JSON.stringify(finding));
      });
    });

    const provider = new CodexProvider('gpt-5.4-mini', {
      agenticContext: true,
    });
    const result = await provider.review(
      [
        'Files changed:',
        '- src/main/services/error/TriggerMatcher.ts (modified, +1/-1)',
        '',
        'Diff:',
        'diff --git a/src/main/services/error/TriggerMatcher.ts b/src/main/services/error/TriggerMatcher.ts',
      ].join('\n'),
      1000
    );
    const execCalls = spawnMock.mock.calls.filter(
      (call) => Array.isArray(call[1]) && call[1][0] === 'exec'
    );

    expect(execCalls).toHaveLength(2);
    expect(execCalls[0][1]).toContain('--json');
    expect(result.findings ?? []).toHaveLength(1);
    expect(result.findings?.[0]?.title).toBe('Ignore patterns are inverted');
  });

  it('reruns agentic review when non-empty findings have no recorded exploration', async () => {
    let execCount = 0;
    const firstFinding = {
      findings: [
        {
          file: 'src/renderer/utils/memberHelpers.ts',
          startLine: null,
          line: 1353,
          endLine: null,
          severity: 'major',
          title: 'Spawn diagnostic errors are hidden',
          message:
            'The helper marks errored bootstrap-confirmed spawn entries as healthy.',
          suggestion: null,
        },
      ],
      revalidations: [],
    };
    const exploredFinding = {
      findings: [
        {
          file: 'src/renderer/utils/memberHelpers.ts',
          startLine: null,
          line: 1353,
          endLine: null,
          severity: 'major',
          title: 'Spawn diagnostic errors are hidden after caller inspection',
          message:
            'After checking MemberList and teamRuntimeDisplayRows, the helper still renders spawn-level error diagnostics as healthy.',
          suggestion: null,
        },
      ],
      revalidations: [],
    };

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      execCount += 1;
      return createMockProcess((proc) => {
        const outputIndex = args.indexOf('--output-last-message');
        const outputFile = args[outputIndex + 1];
        if (execCount === 1) {
          fs.writeFileSync(outputFile, JSON.stringify(firstFinding));
          return;
        }

        proc.stdout.emit(
          'data',
          `${JSON.stringify({
            item: {
              type: 'command_execution',
              command: 'rg -n "runtimeDiagnosticSeverity" src/renderer',
            },
          })}\n`
        );
        fs.writeFileSync(outputFile, JSON.stringify(exploredFinding));
      });
    });

    const provider = new CodexProvider('gpt-5.4-mini', {
      agenticContext: true,
    });
    const result = await provider.review(
      [
        'Files changed:',
        '- src/renderer/utils/memberHelpers.ts (modified, +4/-1)',
        '',
        'Diff:',
        'diff --git a/src/renderer/utils/memberHelpers.ts b/src/renderer/utils/memberHelpers.ts',
      ].join('\n'),
      1000
    );
    const execCalls = spawnMock.mock.calls.filter(
      (call) => Array.isArray(call[1]) && call[1][0] === 'exec'
    );

    expect(execCalls).toHaveLength(2);
    expect(result.findings?.[0]?.title).toBe(
      'Spawn diagnostic errors are hidden after caller inspection'
    );
  });

  it('preserves first-pass findings when audit retry still lacks exploration and returns fewer findings', async () => {
    let execCount = 0;
    const firstFinding = {
      findings: [
        {
          file: 'src/features/team-runtime-lanes/core/domain/buildMixedPersistedLaunchSnapshot.ts',
          startLine: 236,
          line: 240,
          endLine: 240,
          severity: 'major',
          title: 'Runtime diagnostic errors are rewritten as healthy',
          message:
            'The launch snapshot rewrites an errored runtime diagnostic as confirmed_alive.',
          suggestion: null,
        },
      ],
      revalidations: [],
    };

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      execCount += 1;
      return createMockProcess(() => {
        const outputIndex = args.indexOf('--output-last-message');
        const outputFile = args[outputIndex + 1];
        fs.writeFileSync(
          outputFile,
          execCount === 1
            ? JSON.stringify(firstFinding)
            : '{"findings":[],"revalidations":[]}'
        );
      });
    });

    const provider = new CodexProvider('gpt-5.4-mini', {
      agenticContext: true,
    });
    const result = await provider.review(
      [
        'Files changed:',
        '- src/features/team-runtime-lanes/core/domain/buildMixedPersistedLaunchSnapshot.ts (modified, +8/-2)',
        '',
        'Diff:',
        'diff --git a/src/features/team-runtime-lanes/core/domain/buildMixedPersistedLaunchSnapshot.ts b/src/features/team-runtime-lanes/core/domain/buildMixedPersistedLaunchSnapshot.ts',
      ].join('\n'),
      1000
    );
    const execCalls = spawnMock.mock.calls.filter(
      (call) => Array.isArray(call[1]) && call[1][0] === 'exec'
    );

    expect(execCalls).toHaveLength(2);
    expect(result.findings).toHaveLength(1);
    expect(result.findings?.[0]?.title).toBe(
      'Runtime diagnostic errors are rewritten as healthy'
    );
  });

  it('preserves first-pass findings when audit retry still lacks exploration and returns the same count', async () => {
    let execCount = 0;
    const firstFinding = {
      findings: [
        {
          file: 'src/features/team-runtime-lanes/core/domain/buildMixedPersistedLaunchSnapshot.ts',
          startLine: 236,
          line: 240,
          endLine: 240,
          severity: 'major',
          title: 'Runtime diagnostic errors are rewritten as healthy',
          message:
            'The launch snapshot rewrites an errored runtime diagnostic as confirmed_alive.',
          suggestion: null,
        },
      ],
      revalidations: [],
    };
    const retryFinding = {
      findings: [
        {
          file: 'src/features/team-runtime-lanes/core/domain/buildMixedPersistedLaunchSnapshot.ts',
          startLine: 236,
          line: 240,
          endLine: 240,
          severity: 'major',
          title:
            'Retry result without exploration should not replace first pass',
          message:
            'This retry still did not inspect repository context, so it should not replace the first finding.',
          suggestion: null,
        },
      ],
      revalidations: [],
    };

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      execCount += 1;
      return createMockProcess(() => {
        const outputIndex = args.indexOf('--output-last-message');
        const outputFile = args[outputIndex + 1];
        fs.writeFileSync(
          outputFile,
          JSON.stringify(execCount === 1 ? firstFinding : retryFinding)
        );
      });
    });

    const provider = new CodexProvider('gpt-5.4-mini', {
      agenticContext: true,
    });
    const result = await provider.review(
      [
        'Files changed:',
        '- src/features/team-runtime-lanes/core/domain/buildMixedPersistedLaunchSnapshot.ts (modified, +8/-2)',
        '',
        'Diff:',
        'diff --git a/src/features/team-runtime-lanes/core/domain/buildMixedPersistedLaunchSnapshot.ts b/src/features/team-runtime-lanes/core/domain/buildMixedPersistedLaunchSnapshot.ts',
      ].join('\n'),
      1000
    );
    const execCalls = spawnMock.mock.calls.filter(
      (call) => Array.isArray(call[1]) && call[1][0] === 'exec'
    );

    expect(execCalls).toHaveLength(2);
    expect(result.findings).toHaveLength(1);
    expect(result.findings?.[0]?.title).toBe(
      'Runtime diagnostic errors are rewritten as healthy'
    );
  });

  it('preserves first-pass findings when audit retry hits a Codex usage limit', async () => {
    let execCount = 0;
    const firstFinding = {
      findings: [
        {
          file: 'src/app.ts',
          startLine: null,
          line: 42,
          endLine: null,
          severity: 'major',
          title: 'Retry quota should not discard first pass',
          message:
            'The first pass produced a valid review result before the exploration retry hit quota.',
          suggestion: null,
        },
      ],
      revalidations: [],
    };

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      execCount += 1;
      return createMockProcess(
        (proc) => {
          const outputIndex = args.indexOf('--output-last-message');
          const outputFile = args[outputIndex + 1];
          if (execCount === 1) {
            fs.writeFileSync(outputFile, JSON.stringify(firstFinding));
            return;
          }

          proc.stderr.emit(
            'data',
            "You've hit your usage limit. Visit https://example.test to purchase more credits."
          );
        },
        execCount === 1 ? 0 : 1
      );
    });

    const provider = new CodexProvider('gpt-5.4-mini', {
      agenticContext: true,
    });
    const result = await provider.review(
      [
        'Files changed:',
        '- src/app.ts (modified, +1/-1)',
        '',
        'Diff:',
        'diff --git a/src/app.ts b/src/app.ts',
      ].join('\n'),
      1000
    );
    const execCalls = spawnMock.mock.calls.filter(
      (call) => Array.isArray(call[1]) && call[1][0] === 'exec'
    );

    expect(execCalls).toHaveLength(2);
    expect(result.findings).toHaveLength(1);
    expect(result.findings?.[0]?.title).toBe(
      'Retry quota should not discard first pass'
    );
  });

  it('does not rerun empty agentic review when a read-only exploration command is recorded', async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess((proc) => {
        const outputIndex = args.indexOf('--output-last-message');
        proc.stdout.emit(
          'data',
          `${JSON.stringify({
            item: {
              type: 'command_execution',
              command: 'git diff -- src/main/services/error/TriggerMatcher.ts',
            },
          })}\n`
        );
        fs.writeFileSync(
          args[outputIndex + 1],
          '{"findings":[],"revalidations":[]}'
        );
      });
    });

    const provider = new CodexProvider('gpt-5.4-mini', {
      agenticContext: true,
    });
    const result = await provider.review(
      [
        'Files changed:',
        '- src/main/services/error/TriggerMatcher.ts (modified, +1/-1)',
        '',
        'Diff:',
        'diff --git a/src/main/services/error/TriggerMatcher.ts b/src/main/services/error/TriggerMatcher.ts',
      ].join('\n'),
      1000
    );
    const execCalls = spawnMock.mock.calls.filter(
      (call) => Array.isArray(call[1]) && call[1][0] === 'exec'
    );

    expect(execCalls).toHaveLength(1);
    expect(result.findings).toEqual([]);
  });

  it('does not repeat an oversized prompt only to satisfy the optional agentic audit', async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess(() => {
        const outputIndex = args.indexOf('--output-last-message');
        fs.writeFileSync(
          args[outputIndex + 1],
          '{"findings":[],"revalidations":[]}'
        );
      });
    });

    const provider = new CodexProvider('gpt-5.4-mini', {
      agenticContext: true,
    });
    const result = await provider.review(
      [
        'Files changed:',
        '- src/generated.ts (modified, +1/-1)',
        '',
        'Diff:',
        'diff --git a/src/generated.ts b/src/generated.ts',
        'x'.repeat(120_000),
      ].join('\n'),
      1000
    );
    const execCalls = spawnMock.mock.calls.filter(
      (call) => Array.isArray(call[1]) && call[1][0] === 'exec'
    );

    expect(execCalls).toHaveLength(1);
    expect(result.findings).toEqual([]);
  });

  it('strict agentic audit reruns an oversized prompt, then fails if exploration is still missing', async () => {
    process.env.CODEX_AGENTIC_AUDIT = 'strict';
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess(() => {
        const outputIndex = args.indexOf('--output-last-message');
        fs.writeFileSync(
          args[outputIndex + 1],
          '{"findings":[],"revalidations":[]}'
        );
      });
    });

    const provider = new CodexProvider('gpt-5.4-mini', {
      agenticContext: true,
    });
    await expect(
      provider.review(
        [
          'Files changed:',
          '- src/app.ts (modified, +1/-1)',
          '',
          'Diff:',
          'diff --git a/src/app.ts b/src/app.ts',
          'x'.repeat(120_000),
        ].join('\n'),
        1000
      )
    ).rejects.toThrow('without recorded read-only repository exploration');

    const execCalls = spawnMock.mock.calls.filter(
      (call) => Array.isArray(call[1]) && call[1][0] === 'exec'
    );
    expect(execCalls).toHaveLength(2);
  });

  it('strict agentic audit fails non-empty findings when retry still lacks exploration', async () => {
    process.env.CODEX_AGENTIC_AUDIT = 'strict';
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess(() => {
        const outputIndex = args.indexOf('--output-last-message');
        fs.writeFileSync(
          args[outputIndex + 1],
          JSON.stringify({
            findings: [
              {
                file: 'src/app.ts',
                startLine: null,
                line: 7,
                endLine: null,
                severity: 'major',
                title: 'State is reported as healthy',
                message:
                  'The changed branch reports a failed runtime status as healthy.',
                suggestion: null,
              },
            ],
            revalidations: [],
          })
        );
      });
    });

    const provider = new CodexProvider('gpt-5.4-mini', {
      agenticContext: true,
    });
    await expect(
      provider.review(
        [
          'Files changed:',
          '- src/app.ts (modified, +1/-1)',
          '',
          'Diff:',
          'diff --git a/src/app.ts b/src/app.ts',
        ].join('\n'),
        1000
      )
    ).rejects.toThrow('without recorded read-only repository exploration');

    const execCalls = spawnMock.mock.calls.filter(
      (call) => Array.isArray(call[1]) && call[1][0] === 'exec'
    );
    expect(execCalls).toHaveLength(2);
  });

  it('does not force JSON events or rerun when Codex agentic audit is disabled', async () => {
    process.env.CODEX_AGENTIC_AUDIT = 'off';
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess(() => {
        const outputIndex = args.indexOf('--output-last-message');
        fs.writeFileSync(
          args[outputIndex + 1],
          '{"findings":[],"revalidations":[]}'
        );
      });
    });

    const provider = new CodexProvider('gpt-5.4-mini', {
      agenticContext: true,
    });
    await provider.review(
      [
        'Files changed:',
        '- src/app.ts (modified, +1/-1)',
        '',
        'Diff:',
        'diff --git a/src/app.ts b/src/app.ts',
      ].join('\n'),
      1000
    );
    const execCalls = spawnMock.mock.calls.filter(
      (call) => Array.isArray(call[1]) && call[1][0] === 'exec'
    );

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0][1]).not.toContain('--json');
  });

  it('uses valid review JSON from --output-last-message when Codex exits non-zero', async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess((proc) => {
        const outputIndex = args.indexOf('--output-last-message');
        const outputFile = args[outputIndex + 1];
        fs.writeFileSync(outputFile, '{"findings":[],"revalidations":[]}');
        proc.stderr.emit('data', 'tool command failed after final output');
      }, 1);
    });

    const provider = new CodexProvider('gpt-5.4-mini', {
      agenticContext: false,
    });

    const result = await provider.review('review prompt', 1000);

    expect(result.content).toBe('{"findings":[],"revalidations":[]}');
    expect(result.findings).toEqual([]);
  });

  it('rejects placeholder review JSON even when Codex exits successfully', async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess(() => {
        const outputIndex = args.indexOf('--output-last-message');
        fs.writeFileSync(
          args[outputIndex + 1],
          JSON.stringify({
            findings: [
              {
                file: 'path',
                startLine: null,
                line: 1,
                endLine: null,
                severity: 'major',
                title: 'short',
                message: 'specific evidence',
                suggestion: null,
              },
            ],
            revalidations: [],
          })
        );
      });
    });

    const provider = new CodexProvider('gpt-5.6-sol', {
      agenticContext: false,
    });

    await expect(provider.review('review prompt', 1000)).rejects.toThrow(
      'placeholder review JSON'
    );
  });

  it('uses the pinned native Codex model when JSONL omits session configuration', async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess(() => {
        const outputIndex = args.indexOf('--output-last-message');
        fs.writeFileSync(
          args[outputIndex + 1],
          '{"findings":[],"revalidations":[]}'
        );
      });
    });

    const provider = new CodexProvider('gpt-5.6-sol', {
      agenticContext: false,
    });

    const result = await provider.review('review prompt', 1000);

    expect(result.actualModel).toBe('gpt-5.6-sol');
  });

  it('does not infer a native model from ambiguous session telemetry', async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess((proc) => {
        const outputIndex = args.indexOf('--output-last-message');
        fs.writeFileSync(
          args[outputIndex + 1],
          '{"findings":[],"revalidations":[]}'
        );
        proc.stdout.emit(
          'data',
          [
            JSON.stringify({
              type: 'session_configured',
              model: 'gpt-5.6-sol',
            }),
            JSON.stringify({
              type: 'session_configured',
              model: 'gpt-5.5',
            }),
          ].join('\n')
        );
      });
    });

    const provider = new CodexProvider('gpt-5.6-sol', {
      agenticContext: false,
    });

    const result = await provider.review('review prompt', 1000);

    expect(result.actualModel).toBeUndefined();
  });

  it('does not infer an actual model for routed OpenRouter executions', async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess(() => {
        const outputIndex = args.indexOf('--output-last-message');
        fs.writeFileSync(
          args[outputIndex + 1],
          '{"findings":[],"revalidations":[]}'
        );
      });
    });

    const provider = new CodexProvider('openai/gpt-5.6-sol', {
      agenticContext: false,
      modelProvider: 'openrouter',
      providerNamePrefix: 'codex-openrouter',
    });

    const result = await provider.review('review prompt', 1000);

    expect(result.actualModel).toBeUndefined();
  });

  it('re-clamps the deadline immediately before the initial Codex invocation', async () => {
    const provider = new CodexProvider('gpt-5.4-mini', {
      agenticContext: false,
    });
    jest
      .spyOn(provider as any, 'resolveBinary')
      .mockResolvedValue('/tmp/codex');
    const runCli = jest.spyOn(provider as any, 'runCliWithStdin');
    const clampTimeoutMs = jest.fn().mockReturnValue(0);

    await expect(
      provider.review('review prompt', 1000, {
        canStartOptionalRetry: () => false,
        clampTimeoutMs,
      })
    ).rejects.toMatchObject({ name: 'TimeoutError' });

    expect(clampTimeoutMs).toHaveBeenCalledWith(1000);
    expect(runCli).not.toHaveBeenCalled();
  });

  it('fails review when Codex returns invalid JSON instead of silently passing', async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess(() => {
        const outputIndex = args.indexOf('--output-last-message');
        fs.writeFileSync(args[outputIndex + 1], 'not json');
      });
    });

    const provider = new CodexProvider('gpt-5.4-mini', {
      agenticContext: false,
    });

    await expect(provider.review('review prompt', 1000)).rejects.toThrow(
      'Codex CLI returned invalid review JSON'
    );
  });

  it('sanitizes Codex CLI failure messages before surfacing them', async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess((proc) => {
        proc.stderr.emit(
          'data',
          [
            'invalid_request_error: auth failed',
            'https://auth.openai.com/device?user_code=secret',
            'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
            '"refresh_token":"refresh-secret"',
          ].join('\n')
        );
      }, 1);
    });

    const provider = new CodexProvider('gpt-5.4-mini', {
      agenticContext: false,
    });

    let thrown: Error | undefined;
    try {
      await provider.review('review prompt', 1000);
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).toContain('Codex CLI failed with exit code 1');
    expect(thrown?.message).not.toContain('auth.openai.com');
    expect(thrown?.message).not.toContain(
      'sk-proj-abcdefghijklmnopqrstuvwxyz123456'
    );
    expect(thrown?.message).not.toContain('refresh-secret');
  });

  it('preserves nested Codex usage-limit diagnostics as a capacity error', async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess((proc) => {
        proc.stderr.emit(
          'data',
          JSON.stringify({
            type: 'error',
            message: JSON.stringify({
              error: {
                code: 'usage_limit_reached',
                message:
                  "You've hit your usage limit. Try again after 2026-07-25 01:00.",
              },
            }),
          })
        );
      }, 1);
    });

    const provider = new CodexProvider('gpt-5.6-sol', {
      agenticContext: false,
    });

    let thrown: Error | undefined;
    try {
      await provider.review('review prompt', 1000);
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeInstanceOf(RateLimitError);
    expect(thrown?.message).toContain('usage_limit_reached');
    expect(thrown?.message).toContain("You've hit your usage limit");
    expect(thrown?.message).toContain('2026-07-25 01:00');
    expect(thrown?.message).not.toContain('{\\"');
  });

  it('preserves trailing Codex diagnostics after a long echoed prompt', async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess((proc) => {
        proc.stdout.emit(
          'data',
          JSON.stringify({
            type: 'error',
            message: `SENSITIVE_PROMPT_PREFIX ${'review request with timeout semantics '.repeat(40)}You've hit your usage limit. Try again after 2026-08-10 01:00.`,
          })
        );
      }, 1);
    });

    const provider = new CodexProvider('gpt-5.5', {
      agenticContext: false,
    });

    let thrown: Error | undefined;
    try {
      await provider.review('review prompt', 1000);
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeInstanceOf(RateLimitError);
    expect(thrown?.message).toContain("You've hit your usage limit");
    expect(thrown?.message).toContain('2026-08-10 01:00');
    expect(thrown?.message).not.toContain('SENSITIVE_PROMPT_PREFIX');
  });

  it('redacts secrets decoded from nested Codex error JSON', () => {
    const provider = new CodexProvider('gpt-5.6-sol');
    const formatted = (provider as any).formatCliError(
      JSON.stringify({
        message: JSON.stringify({
          error: {
            message:
              'authentication failed refresh_token=refresh-secret-value-123456789',
          },
        }),
      }),
      ''
    );

    expect(formatted).toContain('authentication failed');
    expect(formatted).toContain('refresh_token=***');
    expect(formatted).not.toContain('refresh-secret-value-123456789');
  });

  it('does not mask a CLI failure with echoed review placeholders', () => {
    const provider = new CodexProvider('gpt-5.6-sol');
    const formatted = (provider as any).formatCliError(
      [
        JSON.stringify({ type: 'error', message: '... specific evidence' }),
        'structured output validation failed',
      ].join('\n'),
      ''
    );

    expect(formatted).toContain('structured output validation failed');
    expect(formatted).not.toBe('... specific evidence');
  });

  it('preserves stdout failures when stderr contains only a placeholder', () => {
    const provider = new CodexProvider('gpt-5.6-sol');
    const formatted = (provider as any).formatCliError(
      JSON.stringify({ type: 'error', message: '... specific evidence' }),
      'structured output validation failed'
    );

    expect(formatted).toContain('structured output validation failed');
    expect(formatted).not.toContain('specific evidence');
  });

  it('redacts secrets from raw Codex CLI error text', () => {
    const provider = new CodexProvider('gpt-5.4-mini');
    const formatted = (provider as any).formatCliError(
      [
        'https://auth.openai.com/device?user_code=secret',
        'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
        '"refresh_token":"refresh-secret"',
      ].join('\n'),
      ''
    );

    expect(formatted).toContain('[redacted-url]');
    expect(formatted).toContain('sk-***');
    expect(formatted).toContain('"refresh_token":"[redacted]"');
    expect(formatted).not.toContain('auth.openai.com');
    expect(formatted).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz123456');
    expect(formatted).not.toContain('refresh-secret');
  });

  it('passes only sanitized env to review spawn', async () => {
    process.env.PATH = '/usr/bin';
    process.env.HOME = '/home/runner';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.GITHUB_TOKEN = 'gh-token';
    process.env.INPUT_GITHUB_TOKEN = 'input-token';
    process.env.OPENROUTER_API_KEY = 'or-key';

    spawnMock.mockImplementation(
      (_cmd: string, args: string[], _options: any) => {
        if (args.includes('--version')) {
          return createMockProcess();
        }

        return createMockProcess(() => {
          const outputIndex = args.indexOf('--output-last-message');
          fs.writeFileSync(args[outputIndex + 1], '{"findings":[]}');
        });
      }
    );

    const provider = new CodexProvider('gpt-5.4-mini');
    await provider.review('review prompt', 1000);

    const execCall = spawnMock.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1][0] === 'exec'
    );
    const env = execCall?.[2]?.env;

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/runner');
    expect(env.OPENAI_API_KEY).toBe('sk-test');
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.INPUT_GITHUB_TOKEN).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it('runs structured prompts in isolated cwd without workspace env or tools', async () => {
    process.env.PATH = '/usr/bin';
    process.env.HOME = '/home/runner';
    process.env.GITHUB_WORKSPACE = '/home/runner/work/repo/repo';

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-structured-cwd-'));
    spawnMock.mockImplementation(
      (_cmd: string, args: string[], _options: any) => {
        if (args.includes('--version')) {
          return createMockProcess();
        }

        return createMockProcess(() => {
          const outputIndex = args.indexOf('--output-last-message');
          fs.writeFileSync(args[outputIndex + 1], '{"ok":true}');
        });
      }
    );

    try {
      const provider = new CodexProvider('gpt-5.4-mini');
      const content = await provider.runStructuredPrompt(
        'Return JSON',
        {
          type: 'object',
          additionalProperties: false,
          required: ['ok'],
          properties: { ok: { type: 'boolean' } },
        },
        1000,
        { cwd, includeWorkspaceEnv: false }
      );

      const execCall = spawnMock.mock.calls.find(
        (call) => Array.isArray(call[1]) && call[1][0] === 'exec'
      );
      expect(content).toBe('{"ok":true}');
      expect(execCall?.[2]?.cwd).toBe(cwd);
      expect(execCall?.[2]?.env.GITHUB_WORKSPACE).toBeUndefined();
      expect(execCall?.[1]).toEqual(
        expect.arrayContaining([
          '--ignore-rules',
          '--disable',
          'shell_tool',
          'unified_exec',
          'browser_use',
          'plugins',
        ])
      );
      expect(execCall?.[1]).not.toContain('--skip-git-repo-check');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('builds deterministic repository context seed from changed files and relative imports', async () => {
    const oldCwd = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-context-seed-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src/passwordReset.js'),
      "import { getPolicy } from './ratePolicies.js';\nconst policy = getPolicy('marketingEmailPreview');\n"
    );
    fs.writeFileSync(
      path.join(dir, 'src/ratePolicies.js'),
      'export const RATE_POLICIES = { passwordReset: { maxAttemptsPerHour: 3 } };\n'
    );

    try {
      process.chdir(dir);
      const provider = new CodexProvider('gpt-5.4-mini');
      const seed = await (provider as any).buildRepositoryContextSeed(
        [
          'Files changed:',
          '- src/passwordReset.js (modified, +1/-1)',
          '',
          'Diff:',
          'diff --git a/src/passwordReset.js b/src/passwordReset.js',
        ].join('\n')
      );

      expect(seed).toContain('DETERMINISTIC REPOSITORY CONTEXT SEED');
      expect(seed).toContain('role="changed"');
      expect(seed).toContain('src/passwordReset.js');
      expect(seed).toContain('role="related"');
      expect(seed).toContain('src/ratePolicies.js');
      expect(seed).toContain('maxAttemptsPerHour: 3');
    } finally {
      process.chdir(oldCwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds Dart package imports and identifier-related files to context seed', async () => {
    const oldCwd = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dart-context-'));
    fs.mkdirSync(path.join(dir, 'app/lib/src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'app/lib/data'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'server/lib/src/crud'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app/pubspec.yaml'), 'name: app\n');
    fs.writeFileSync(path.join(dir, 'server/pubspec.yaml'), 'name: server\n');
    fs.writeFileSync(
      path.join(dir, 'app/lib/data/repository_actions_extension.dart'),
      'class DwRepository { static Future<bool> deleteModel(Object model) async => true; }\n'
    );
    fs.writeFileSync(
      path.join(dir, 'server/lib/src/crud/lesson_crud_config.dart'),
      'final lessonCrudConfig = DwDeleteConfig(afterDelete: notifyGeneralUpdates);\n'
    );
    fs.writeFileSync(
      path.join(dir, 'server/lib/src/crud/course_crud_config.dart'),
      [
        "import 'package:app/data/repository_actions_extension.dart';",
        'final courseCrudConfig = DwDeleteConfig(allowDelete: canDelete);',
        'final channel = UpdateChannels.generalUpdatesChannel;',
      ].join('\n')
    );

    try {
      process.chdir(dir);
      const provider = new CodexProvider('gpt-5.4-mini');
      const seed = await (provider as any).buildRepositoryContextSeed(
        [
          'Files changed:',
          '- server/lib/src/crud/course_crud_config.dart (modified, +1/-1)',
          '',
          'Diff:',
          'diff --git a/server/lib/src/crud/course_crud_config.dart b/server/lib/src/crud/course_crud_config.dart',
        ].join('\n')
      );

      expect(seed).toContain('server/lib/src/crud/course_crud_config.dart');
      expect(seed).toContain('app/lib/data/repository_actions_extension.dart');
      expect(seed).toContain('server/lib/src/crud/lesson_crud_config.dart');
      expect(seed).toContain('afterDelete: notifyGeneralUpdates');
    } finally {
      process.chdir(oldCwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses git dependency metadata from pubspec.lock for dependency context', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lock-'));
    const lockfile = path.join(dir, 'pubspec.lock');
    fs.writeFileSync(
      lockfile,
      [
        'packages:',
        '  dartway_serverpod_core_server:',
        '    dependency: "direct main"',
        '    description:',
        '      path: "packages/dartway_serverpod_core/dartway_serverpod_core_server"',
        '      ref: master',
        '      resolved-ref: "39ec91e397daec37f5252cd1291c9aa72e434ea1"',
        '      url: "https://github.com/dartway/dartway.git"',
        '    source: git',
        '    version: "0.0.0"',
      ].join('\n')
    );

    try {
      const provider = new CodexProvider('gpt-5.4-mini');
      expect(
        (provider as any).parseGitDependencyFromLockfile(
          lockfile,
          'dartway_serverpod_core_server'
        )
      ).toEqual({
        url: 'https://github.com/dartway/dartway.git',
        ref: '39ec91e397daec37f5252cd1291c9aa72e434ea1',
        path: 'packages/dartway_serverpod_core/dartway_serverpod_core_server',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sanitizes absolute workspace paths from model output', () => {
    const provider = new CodexProvider('gpt-5.4-mini');
    const content = (provider as any).sanitizeReviewContent(
      '{"message":"See [src/ratePolicies.js](/home/runner/work/repo/repo/src/ratePolicies.js)"}'
    );

    expect(content).toContain('[src/ratePolicies.js](src/ratePolicies.js)');
    expect(content).not.toContain('/home/runner/work/');
  });

  it('kills the detached Codex process group when execution is aborted', async () => {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = jest.fn();
    proc.pid = 12345;
    spawnMock.mockReturnValue(proc);
    const kill = jest
      .spyOn(process, 'kill')
      .mockImplementation((() => true) as any);
    const abort = new AbortController();
    const provider = new CodexProvider('gpt-5.4-mini');
    const running = (provider as any).runCliWithStdin(
      'codex',
      'review prompt',
      60_000,
      { healthCheck: false, signal: abort.signal }
    );
    const rejected = expect(running).rejects.toMatchObject({
      name: 'AbortError',
    });

    try {
      for (
        let attempt = 0;
        attempt < 100 && spawnMock.mock.calls.length === 0;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(spawnMock).toHaveBeenCalledTimes(1);

      abort.abort();

      await rejected;
      expect(kill).toHaveBeenCalledWith(-proc.pid, 'SIGKILL');
      expect(proc.kill).not.toHaveBeenCalled();
    } finally {
      abort.abort();
      await running.catch(() => undefined);
      kill.mockRestore();
    }
  });
});
