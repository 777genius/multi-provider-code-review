import { readFile, writeFile } from 'fs/promises';
import {
  REVIEW_INVESTIGATION_GATEWAY_TOOLS,
  ReviewAgentFailureClass,
  type ReviewAgentPort,
  type ReviewTurnRequest,
} from '../../../src/review-investigation/application';
import {
  ReviewAgentConfinementStrength,
  ReviewAgentExecutionProfile,
  ReviewAgentProviderKind,
  ReviewTurnCriticDecision,
  ReviewTurnFindingSeverity,
  ReviewTurnPurpose,
} from '../../../src/review-investigation/domain';
import {
  ClaudeReviewAgentAdapter,
  CodexReviewAgentAdapter,
  ReviewAgentProcessTermination,
  type ReviewAgentProcessRequest,
  type ReviewAgentProcessResult,
  type ReviewAgentProcessRunnerPort,
} from '../../../src/review-investigation/infrastructure';

const digest = (character: string) => character.repeat(64);
const turnOutput = Object.freeze({
  outputVersion: 1 as const,
  findings: Object.freeze([
    Object.freeze({
      severity: ReviewTurnFindingSeverity.Major,
      title: 'Boundary contract changed',
      body: 'The changed value breaks a direct consumer.',
      path: 'src/service.ts',
      line: 7,
      evidenceOperationReceiptIds: Object.freeze([digest('a')]),
    }),
  ]),
  obligationProposals: Object.freeze([]),
  closureClaims: Object.freeze([
    Object.freeze({
      obligationId: digest('b'),
      operationReceiptIds: Object.freeze([digest('a')]),
    }),
  ]),
  unresolvableClaims: Object.freeze([]),
  criticDecision: null,
});

describe.each([
  ReviewAgentProviderKind.Codex,
  ReviewAgentProviderKind.ClaudeCode,
])('ReviewAgentPort contract: %s', (providerKind) => {
  it('negotiates the same gateway-attested semantic profile', async () => {
    const { adapter } = fixture(providerKind);
    const profile = await adapter.negotiate({
      providerKind,
      executionProfile: ReviewAgentExecutionProfile.GatewayAttestedAgentV1,
      minimumConfinement: ReviewAgentConfinementStrength.GatewayOnly,
      requireActualModelAttribution: true,
      requireUsageAttribution: true,
      requireFencedCancellation: true,
      minimumMaxTurns: 4,
    });
    expect(profile).toMatchObject({
      providerKind,
      executionProfile: ReviewAgentExecutionProfile.GatewayAttestedAgentV1,
      confinement: ReviewAgentConfinementStrength.GatewayOnly,
    });
  });

  it('produces equivalent normalized observations with observed model and usage', async () => {
    const { adapter, runner, request } = fixture(providerKind);
    const observation = await adapter.executeTurn(request);
    expect(observation).toMatchObject({
      invocationId: 'invocation-1',
      turnId: 'turn-1',
      dossierVersion: 3,
      purpose: ReviewTurnPurpose.Discovery,
      actualProviderKind: providerKind,
      runtimeProfile: ReviewAgentExecutionProfile.GatewayAttestedAgentV1,
      usage: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 10,
        totalTokens: 110,
      },
      findings: turnOutput.findings,
      closureClaims: turnOutput.closureClaims,
      schemaComplete: true,
      streamComplete: true,
      contextAttestationReference: null,
    });
    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0].stdin).toBe(request.prompt);
    expect(JSON.stringify(runner.requests[0].args)).not.toContain(
      request.prompt
    );
    expect(JSON.stringify(runner.requests[0].args)).not.toContain(
      'gateway-secret'
    );
    if (providerKind === ReviewAgentProviderKind.ClaudeCode) {
      expect(runner.requests[0].environment).not.toHaveProperty(
        'REVIEWROUTER_CONTEXT_GATEWAY_SECRET'
      );
    }
  });

  it('delegates cancellation with the exact fencing token', async () => {
    const { adapter, runner } = fixture(providerKind);
    await adapter.cancel('invocation-1', 'fence-7');
    expect(runner.cancellations).toEqual([
      { invocationId: 'invocation-1', fencingToken: 'fence-7' },
    ]);
  });

  it('classifies revoked auth once without retrying or exposing diagnostics', async () => {
    const { adapter, runner, request } = fixture(providerKind, {
      termination: ReviewAgentProcessTermination.Exited,
      exitCode: 1,
      stdout: '',
      stderr: 'refresh token revoked sk-secret-material-123456789',
      durationMs: 4,
    });
    await expect(adapter.executeTurn(request)).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.AuthenticationUnavailable,
      message: 'review_agent_authentication_unavailable',
    });
    expect(runner.requests).toHaveLength(1);
  });

  it('fails closed when actual model attribution is absent', async () => {
    const { adapter, runner, request } = fixture(providerKind);
    runner.omitModel = true;
    await expect(adapter.executeTurn(request)).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.ModelAttributionMissing,
    });
  });

  it('fails malformed provider output as schema-invalid', async () => {
    const { adapter, runner, request } = fixture(providerKind);
    runner.output = { ...turnOutput, authoritativeClean: true };
    await expect(adapter.executeTurn(request)).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.SchemaInvalidOutput,
    });
  });

  it('keeps critic decisions out of discovery turns and requires them for critic turns', async () => {
    const discovery = fixture(providerKind);
    discovery.runner.output = {
      ...turnOutput,
      criticDecision: ReviewTurnCriticDecision.Accept,
    };
    await expect(
      discovery.adapter.executeTurn(discovery.request)
    ).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.SchemaInvalidOutput,
    });

    const critic = fixture(providerKind);
    critic.runner.output = {
      ...turnOutput,
      criticDecision: ReviewTurnCriticDecision.Accept,
    };
    await expect(
      critic.adapter.executeTurn({
        ...critic.request,
        purpose: ReviewTurnPurpose.Critic,
      })
    ).resolves.toMatchObject({
      purpose: ReviewTurnPurpose.Critic,
      criticDecision: ReviewTurnCriticDecision.Accept,
    });
  });

  it('distinguishes incomplete streams from missing usage', async () => {
    const incomplete = fixture(providerKind);
    incomplete.runner.incompleteStream = true;
    await expect(
      incomplete.adapter.executeTurn(incomplete.request)
    ).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.StreamIncomplete,
    });

    const missingUsage = fixture(providerKind);
    missingUsage.runner.omitUsage = true;
    await expect(
      missingUsage.adapter.executeTurn(missingUsage.request)
    ).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.UsageAttributionMissing,
    });
  });

  it.each([
    ['usage quota exceeded', ReviewAgentFailureClass.QuotaUnavailable],
    ['429 capacity_unavailable', ReviewAgentFailureClass.CapacityUnavailable],
    [
      'model cache failed during startup',
      ReviewAgentFailureClass.StartupFailure,
    ],
  ])('classifies %s without a provider retry', async (stderr, failureClass) => {
    const { adapter, runner, request } = fixture(providerKind, {
      termination: ReviewAgentProcessTermination.Exited,
      exitCode: 1,
      stdout: '',
      stderr,
      durationMs: 4,
    });
    await expect(adapter.executeTurn(request)).rejects.toMatchObject({
      failureClass,
    });
    expect(runner.requests).toHaveLength(1);
  });
});

describe('strict provider command shapes', () => {
  it('resets Codex config and exposes only the gateway v4 MCP tools', async () => {
    const { adapter, runner, request } = fixture(ReviewAgentProviderKind.Codex);
    await adapter.executeTurn(request);
    const args = runner.requests[0].args;
    expect(args).toEqual(
      expect.arrayContaining([
        'exec',
        '--sandbox',
        'read-only',
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '--strict-config',
        '--json',
        'mcp_servers={}',
      ])
    );
    for (const feature of [
      'shell_tool',
      'unified_exec',
      'browser_use',
      'computer_use',
      'js_repl',
      'tool_search',
      'web_search_request',
      'plugins',
    ]) {
      expect(args).toContain(feature);
    }
    const enabled = args.find((argument) =>
      argument.startsWith('mcp_servers.reviewrouter.enabled_tools=')
    );
    for (const tool of REVIEW_INVESTIGATION_GATEWAY_TOOLS) {
      expect(enabled).toContain(tool);
    }
  });

  it('disables Claude customizations and native tools with one strict MCP server', async () => {
    const { adapter, runner, request } = fixture(
      ReviewAgentProviderKind.ClaudeCode
    );
    await adapter.executeTurn(request);
    const args = runner.requests[0].args;
    expect(args).toEqual(
      expect.arrayContaining([
        '--strict-mcp-config',
        '--no-session-persistence',
        '--no-chrome',
        '--disable-slash-commands',
        '--permission-mode',
        'dontAsk',
      ])
    );
    expect(args).not.toContain('--bare');
    expect(args).not.toContain('--safe-mode');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    const toolValue = args[args.indexOf('--tools') + 1];
    expect(toolValue).not.toMatch(/(?:Bash|Read|Grep|Glob|Edit|Write)/u);
    for (const tool of REVIEW_INVESTIGATION_GATEWAY_TOOLS) {
      expect(toolValue).toContain(`mcp__reviewrouter__${tool}`);
    }
    expect(runner.claudeMcpConfig).toMatchObject({
      mcpServers: {
        reviewrouter: {
          type: 'stdio',
          command: process.execPath,
          env: {
            REVIEWROUTER_CONTEXT_GATEWAY_POLICY_VERSION: 'context-gateway-v4',
            REVIEWROUTER_CONTEXT_GATEWAY_SECRET: 'gateway-secret',
          },
        },
      },
    });
  });
});

class FakeRunner implements ReviewAgentProcessRunnerPort {
  readonly requests: ReviewAgentProcessRequest[] = [];
  readonly cancellations: Array<{
    invocationId: string;
    fencingToken: string;
  }> = [];
  output: unknown = turnOutput;
  omitModel = false;
  omitUsage = false;
  incompleteStream = false;
  claudeMcpConfig: unknown;

  constructor(
    private readonly providerKind: ReviewAgentProviderKind,
    private readonly forcedResult?: ReviewAgentProcessResult
  ) {}

  async run(
    request: ReviewAgentProcessRequest
  ): Promise<ReviewAgentProcessResult> {
    this.requests.push(request);
    if (this.forcedResult) return this.forcedResult;
    if (this.providerKind === ReviewAgentProviderKind.Codex) {
      const outputPath = argumentAfter(request.args, '--output-last-message');
      await writeFile(outputPath, JSON.stringify(this.output));
      return {
        termination: ReviewAgentProcessTermination.Exited,
        exitCode: 0,
        stdout: [
          ...(this.omitModel
            ? []
            : [
                JSON.stringify({
                  type: 'session_configured',
                  model: 'gpt-5.6-codex',
                }),
              ]),
          ...(this.incompleteStream
            ? []
            : [
                JSON.stringify({
                  type: 'turn.completed',
                  ...(this.omitUsage
                    ? {}
                    : {
                        usage: {
                          input_tokens: 100,
                          cached_input_tokens: 20,
                          output_tokens: 10,
                          reasoning_output_tokens: 3,
                        },
                      }),
                }),
              ]),
        ].join('\n'),
        stderr: '',
        durationMs: 25,
      };
    }
    const mcpConfigPath = argumentAfter(request.args, '--mcp-config');
    this.claudeMcpConfig = JSON.parse(await readFile(mcpConfigPath, 'utf8'));
    return {
      termination: ReviewAgentProcessTermination.Exited,
      exitCode: 0,
      stdout: JSON.stringify({
        type: 'result',
        subtype: this.incompleteStream ? 'error' : 'success',
        is_error: this.incompleteStream,
        structured_output: this.output,
        ...(this.omitUsage
          ? {}
          : {
              usage: {
                input_tokens: 80,
                cache_read_input_tokens: 20,
                output_tokens: 10,
              },
            }),
        modelUsage: this.omitModel
          ? {}
          : { 'claude-sonnet-5': { inputTokens: 100, outputTokens: 10 } },
      }),
      stderr: '',
      durationMs: 25,
    };
  }

  async cancel(invocationId: string, fencingToken: string): Promise<void> {
    this.cancellations.push({ invocationId, fencingToken });
  }
}

function fixture(
  providerKind: ReviewAgentProviderKind,
  forcedResult?: ReviewAgentProcessResult
): {
  adapter: ReviewAgentPort;
  runner: FakeRunner;
  request: ReviewTurnRequest;
} {
  const runner = new FakeRunner(providerKind, forcedResult);
  const adapter =
    providerKind === ReviewAgentProviderKind.Codex
      ? new CodexReviewAgentAdapter(runner, { binary: 'codex-test' })
      : new ClaudeReviewAgentAdapter(runner, { binary: 'claude-test' });
  return {
    adapter,
    runner,
    request: {
      invocationId: 'invocation-1',
      fencingToken: 'fence-1',
      turnId: 'turn-1',
      dossierVersion: 3,
      dossierDigest: digest('d'),
      purpose: ReviewTurnPurpose.Discovery,
      prompt: 'Inspect the durable dossier using only ReviewRouter tools.',
      workingDirectory: process.cwd(),
      requestedModel:
        providerKind === ReviewAgentProviderKind.Codex
          ? 'gpt-5.6-codex'
          : 'claude-sonnet-5',
      timeoutMs: 30_000,
      maxTurns: 8,
      gateway: {
        policyVersion: 'context-gateway-v4',
        binaryHash: digest('e'),
        command: process.execPath,
        args: ['/tmp/context-gateway.cjs'],
        cwd: process.cwd(),
        enabledTools: REVIEW_INVESTIGATION_GATEWAY_TOOLS,
        runtimeEnvironment: {
          REVIEWROUTER_CONTEXT_SESSION_ID: 'session-1',
        },
        credentialEnvironment: {
          REVIEWROUTER_CONTEXT_GATEWAY_SECRET: 'gateway-secret',
        },
      },
      providerCredentialEnvironment:
        providerKind === ReviewAgentProviderKind.Codex
          ? { CODEX_HOME: '/tmp/codex-home' }
          : { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret' },
    },
  };
}

function argumentAfter(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1])
    throw new Error(`test_argument_missing:${name}`);
  return args[index + 1];
}
