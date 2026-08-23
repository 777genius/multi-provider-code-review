import { readFile, writeFile } from 'fs/promises';
import {
  REVIEW_INVESTIGATION_GATEWAY_TOOLS,
  ReviewAgentExecutionError,
  ReviewAgentExecutionSessionKind,
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
  ReviewTurnObligationKind,
  ReviewTurnPurpose,
} from '../../../src/review-investigation/domain';
import {
  canonicalJson,
  sha256,
} from '../../../src/review-investigation/domain/canonical-json';
import {
  ClaudeReviewAgentAdapter,
  CodexReviewAgentAdapter,
  classifyCodexAppServerDiagnostic,
  ReviewAgentProcessTermination,
  type ReviewAgentExecutionSessionResolverPort,
  type ReviewAgentGatewayLaunchBinding,
  type ReviewAgentProcessRequest,
  type ReviewAgentProcessResult,
  type ReviewAgentProcessRunnerPort,
  type CodexAppServerTurnRequest,
  type CodexAppServerTurnResult,
} from '../../../src/review-investigation/infrastructure';

const digest = (character: string) => character.repeat(64);
const proposedPath = 'src/service.ts';
const proposedPathHash = sha256(proposedPath);
const turnOutput = Object.freeze({
  outputVersion: 2 as const,
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
  obligationProposals: Object.freeze([
    Object.freeze({
      kind: ReviewTurnObligationKind.DirectCaller,
      canonicalSubject: canonicalJson({
        kind: 'file_read',
        pathHash: proposedPathHash,
        revision: 'head',
        subjectVersion: 1,
      }),
      canonicalRequirement: canonicalJson({
        kind: 'complete_file',
        path: proposedPath,
        pathHash: proposedPathHash,
        requirementVersion: 1,
        revision: 'head',
      }),
      riskPriority: 800_000,
    }),
  ]),
  closureClaims: Object.freeze([
    Object.freeze({
      obligationId: digest('b'),
      operationReceiptIds: Object.freeze([digest('a')]),
    }),
  ]),
  operationBackedDiscoveryClaims: Object.freeze([
    Object.freeze({
      sourceObligationId: digest('c'),
      query: 'sharedContract',
      operationReceiptIds: Object.freeze([digest('d')]),
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
      outputVersion: 2,
      observationVersion: 2,
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
        reasoningOutputTokens:
          providerKind === ReviewAgentProviderKind.Codex ? 3 : 0,
        totalTokens: 110,
      },
      findings: turnOutput.findings,
      obligationProposals: turnOutput.obligationProposals,
      closureClaims: turnOutput.closureClaims,
      operationBackedDiscoveryClaims: turnOutput.operationBackedDiscoveryClaims,
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
    } else {
      expect(runner.requests[0]).toMatchObject({
        maxEventStreamBytes: 128 * 1024 * 1024,
        maxEventBytes: 8 * 1024 * 1024,
        maxFinalOutputBytes: 4 * 1024 * 1024,
      });
    }
  });

  it('wires authenticated obligation ids into the provider schema', async () => {
    const { adapter, runner, request } = fixture(providerKind);

    await adapter.executeTurn(request);

    const schema =
      providerKind === ReviewAgentProviderKind.Codex
        ? runner.requests[0].outputSchema
        : JSON.parse(argumentAfter(runner.requests[0].args, '--json-schema'));
    expect(schema).toMatchObject({
      properties: {
        closureClaims: {
          items: {
            properties: {
              obligationId: { enum: [digest('b')] },
            },
          },
        },
        unresolvableClaims: {
          items: {
            properties: {
              obligationId: { enum: [digest('b')] },
            },
          },
        },
        operationBackedDiscoveryClaims: {
          items: {
            properties: {
              sourceObligationId: { pattern: '^[a-f0-9]{64}$' },
            },
          },
        },
      },
    });
  });

  it('delegates cancellation with the exact fencing token', async () => {
    const { adapter, runner } = fixture(providerKind);
    await adapter.cancel('invocation-1', 'fence-7');
    expect(runner.cancellations).toEqual([
      { invocationId: 'invocation-1', fencingToken: 'fence-7' },
    ]);
  });

  it('sanitizes cancellation failures from the process runner', async () => {
    const { adapter, runner } = fixture(providerKind);
    runner.cancelError = new Error(
      'cancel failed auth=provider-cancellation-private-material'
    );

    await expect(
      adapter.cancel('invocation-1', 'fence-7')
    ).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.ProcessFailure,
      retryAfterMs: null,
      message: 'review_agent_cancel_failure',
    });
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

  it('maps unknown CLI output to an allowlisted error without leaking material', async () => {
    const secret = 'credential-secret-private-material';
    const query = 'select * from private_accounts';
    const source = 'const customerToken = "private-source-token";';
    const { adapter, request } = fixture(providerKind, {
      termination: ReviewAgentProcessTermination.Exited,
      exitCode: 1,
      stdout: `${source}\n${secret}`,
      stderr: `unknown provider failure query=${query}`,
      durationMs: 4,
    });

    let failure: unknown;
    try {
      await adapter.executeTurn(request);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      failureClass: ReviewAgentFailureClass.ProcessFailure,
      retryAfterMs: null,
      message: 'review_agent_process_failure',
    });
    const rendered =
      failure instanceof Error
        ? `${failure.name}\n${failure.message}\n${failure.stack ?? ''}`
        : JSON.stringify(failure);
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain(query);
    expect(rendered).not.toContain(source);
  });

  it('fails closed when actual model attribution is absent', async () => {
    const { adapter, runner, request } = fixture(providerKind);
    runner.omitModel = true;
    await expect(adapter.executeTurn(request)).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.ModelAttributionMissing,
    });
  });

  it('accepts fenced JSON from the Codex app-server terminal message', async () => {
    const { adapter, runner, request } = fixture(ReviewAgentProviderKind.Codex);
    runner.rawCodexOutput = `\`\`\`json\n${JSON.stringify(turnOutput)}\n\`\`\``;

    await expect(adapter.executeTurn(request)).resolves.toMatchObject({
      outputVersion: 2,
      findings: turnOutput.findings,
    });
  });

  it('accepts exactly one schema-valid JSON payload surrounded by provider prose', async () => {
    const { adapter, runner, request } = fixture(ReviewAgentProviderKind.Codex);
    runner.rawCodexOutput = `Completed review.\n${JSON.stringify(turnOutput)}\nEnd of review.`;

    await expect(adapter.executeTurn(request)).resolves.toMatchObject({
      outputVersion: 2,
      findings: turnOutput.findings,
    });
  });

  it('rejects ambiguous provider prose containing multiple valid payloads', async () => {
    const { adapter, runner, request } = fixture(ReviewAgentProviderKind.Codex);
    runner.rawCodexOutput = `${JSON.stringify(turnOutput)}\n${JSON.stringify({
      ...turnOutput,
      findings: [],
    })}`;

    await expect(adapter.executeTurn(request)).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.SchemaInvalidOutput,
    });
  });

  it('fails malformed provider output as schema-invalid', async () => {
    const { adapter, runner, request } = fixture(providerKind);
    runner.output = { ...turnOutput, authoritativeClean: true };
    await expect(adapter.executeTurn(request)).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.SchemaInvalidOutput,
    });
  });

  it('rejects an oversized Codex output file before JSON parsing', async () => {
    const { adapter, runner, request } = fixture(ReviewAgentProviderKind.Codex);
    runner.rawCodexOutput = Buffer.alloc(4 * 1024 * 1024 + 1, 97);

    await expect(adapter.executeTurn(request)).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.SchemaInvalidOutput,
      message: 'review_agent_output_invalid',
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
      obligationProposals: Object.freeze([]),
      closureClaims: Object.freeze([]),
      criticDecision: ReviewTurnCriticDecision.Accept,
    };
    await expect(
      critic.adapter.executeTurn({
        ...critic.request,
        purpose: ReviewTurnPurpose.Critic,
        allowedObligationIds: Object.freeze([]),
      })
    ).resolves.toMatchObject({
      purpose: ReviewTurnPurpose.Critic,
      criticDecision: ReviewTurnCriticDecision.Accept,
    });
  });

  it.each([
    [
      'an out-of-scope closure',
      {
        closureClaims: [
          { ...turnOutput.closureClaims[0], obligationId: digest('f') },
        ],
      },
    ],
    [
      'duplicate closures',
      {
        closureClaims: [
          turnOutput.closureClaims[0],
          turnOutput.closureClaims[0],
        ],
      },
    ],
    [
      'duplicate unresolvable claims',
      {
        unresolvableClaims: [
          {
            obligationId: digest('b'),
            reason: 'Unavailable in the authenticated repository context.',
            evidenceOperationReceiptIds: [],
          },
          {
            obligationId: digest('b'),
            reason: 'Unavailable in the authenticated repository context.',
            evidenceOperationReceiptIds: [],
          },
        ],
      },
    ],
    [
      'an out-of-scope unresolvable claim',
      {
        closureClaims: [],
        unresolvableClaims: [
          {
            obligationId: digest('f'),
            reason: 'Unavailable in the authenticated repository context.',
            evidenceOperationReceiptIds: [],
          },
        ],
      },
    ],
    [
      'a closure and unresolvable claim for the same obligation',
      {
        unresolvableClaims: [
          {
            obligationId: digest('b'),
            reason: 'Unavailable in the authenticated repository context.',
            evidenceOperationReceiptIds: [],
          },
        ],
      },
    ],
  ])('fails closed for %s', async (_name, override) => {
    const { adapter, runner, request } = fixture(providerKind);
    runner.output = { ...turnOutput, ...override };

    await expect(adapter.executeTurn(request)).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.SchemaInvalidOutput,
      message: 'review_agent_turn_obligation_claim_invalid',
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
      "invalid_json_schema: Invalid schema for response_format 'codex_output_schema'",
      ReviewAgentFailureClass.SchemaInvalidOutput,
    ],
    [
      '429 while submitting structured output schema',
      ReviewAgentFailureClass.CapacityUnavailable,
    ],
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
        'app-server',
        '--stdio',
        '--strict-config',
        'approval_policy="never"',
        'sandbox_mode="read-only"',
        'project_doc_max_bytes=0',
        'web_search="disabled"',
      ])
    );
    for (const feature of [
      'shell_tool',
      'unified_exec',
      'browser_use',
      'computer_use',
      'js_repl',
      'tool_search',
      'multi_agent',
      'apps',
      'plugins',
      'hooks',
      'memories',
      'external_agent_memory_import',
      'chronicle',
    ]) {
      expect(isFeatureDisabled(args, feature)).toBe(true);
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

describe('review agent environment allowlists', () => {
  it.each([
    [ReviewAgentProviderKind.Codex, 'GITHUB_TOKEN'],
    [ReviewAgentProviderKind.Codex, 'AWS_SECRET_ACCESS_KEY'],
    [ReviewAgentProviderKind.Codex, 'BROWSER_SESSION_COOKIE'],
    [ReviewAgentProviderKind.Codex, 'CLAUDE_CODE_OAUTH_TOKEN'],
    [ReviewAgentProviderKind.ClaudeCode, 'GITHUB_TOKEN'],
    [ReviewAgentProviderKind.ClaudeCode, 'AWS_SECRET_ACCESS_KEY'],
    [ReviewAgentProviderKind.ClaudeCode, 'BROWSER_SESSION_COOKIE'],
    [ReviewAgentProviderKind.ClaudeCode, 'OPENAI_API_KEY'],
  ])(
    'rejects %s provider environment key %s before process launch',
    async (providerKind, key) => {
      const { adapter, credentials, runner, request } = fixture(providerKind);
      credentials.environment = { [key]: 'secret-canary' };

      await expect(adapter.executeTurn(request)).rejects.toThrow(
        'review_agent_provider_credential_environment_invalid'
      );
      expect(runner.requests).toHaveLength(0);
    }
  );

  it.each(['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'SESSION_COOKIE'])(
    'rejects gateway credential key %s before process launch',
    async (key) => {
      const { adapter, runner, request, sessions } = fixture(
        ReviewAgentProviderKind.Codex
      );
      sessions.binding = Object.freeze({
        ...sessions.binding,
        credentialEnvironment: Object.freeze({ [key]: 'secret-canary' }),
      });

      await expect(adapter.executeTurn(request)).rejects.toThrow(
        'review_agent_gateway_credential_environment_invalid'
      );
      expect(runner.requests).toHaveLength(0);
    }
  );

  it('rejects arbitrary gateway runtime keys before process launch', async () => {
    const { adapter, runner, request, sessions } = fixture(
      ReviewAgentProviderKind.Codex
    );
    sessions.binding = Object.freeze({
      ...sessions.binding,
      runtimeEnvironment: Object.freeze({
        ...sessions.binding.runtimeEnvironment,
        AWS_REGION: 'us-east-1',
      }),
    });

    await expect(adapter.executeTurn(request)).rejects.toThrow(
      'review_agent_runtime_environment_invalid'
    );
    expect(runner.requests).toHaveLength(0);
  });

  it('rejects a workspace outside the adapter-bound gateway authority', async () => {
    const { adapter, runner, request, sessions } = fixture(
      ReviewAgentProviderKind.Codex
    );
    sessions.binding = Object.freeze({
      ...sessions.binding,
      cwd: '/tmp/different-review-workspace',
    });

    await expect(adapter.executeTurn(request)).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.ConfinementViolation,
      message: 'review_agent_workspace_authority_mismatch',
    });
    expect(runner.requests).toHaveLength(0);
  });

  it.each([
    [
      ReviewAgentProviderKind.Codex,
      {
        CODEX_HOME: '/tmp/codex-home',
        OPENAI_API_KEY: 'openai-canary',
        OPENROUTER_API_KEY: 'openrouter-canary',
      },
    ],
    [
      ReviewAgentProviderKind.ClaudeCode,
      {
        CLAUDE_CODE_OAUTH_TOKEN: 'claude-canary',
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
      },
    ],
  ])(
    'retains only supported %s credentials and configuration',
    async (providerKind, providerEnvironment) => {
      const { adapter, credentials, runner, request } = fixture(providerKind);
      credentials.environment = providerEnvironment;

      await adapter.executeTurn(request);

      expect(runner.requests[0].environment).toMatchObject(providerEnvironment);
    }
  );
});

class FakeRunner implements ReviewAgentProcessRunnerPort {
  readonly requests: Array<{
    readonly args: readonly string[];
    readonly stdin: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly outputSchema?: Readonly<Record<string, unknown>>;
    readonly maxEventStreamBytes?: number;
    readonly maxEventBytes?: number;
    readonly maxFinalOutputBytes?: number;
  }> = [];
  readonly cancellations: Array<{
    invocationId: string;
    fencingToken: string;
  }> = [];
  output: unknown = turnOutput;
  omitModel = false;
  omitUsage = false;
  incompleteStream = false;
  cancelError: unknown = null;
  claudeMcpConfig: unknown;
  rawCodexOutput: string | Buffer | null = null;

  constructor(
    private readonly providerKind: ReviewAgentProviderKind,
    private readonly forcedResult?: ReviewAgentProcessResult
  ) {}

  async run(
    request: ReviewAgentProcessRequest
  ): Promise<ReviewAgentProcessResult> {
    this.requests.push({
      args: request.args,
      stdin: request.stdin,
      environment: request.environment,
    });
    if (this.forcedResult) return this.forcedResult;
    if (this.providerKind === ReviewAgentProviderKind.Codex) {
      const outputPath = argumentAfter(request.args, '--output-last-message');
      await writeFile(
        outputPath,
        this.rawCodexOutput ?? JSON.stringify(this.output)
      );
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

  async executeTurn(
    request: CodexAppServerTurnRequest
  ): Promise<CodexAppServerTurnResult> {
    this.requests.push({
      args: request.args,
      stdin: request.protocol.prompt,
      environment: request.environment,
      outputSchema: request.protocol.outputSchema,
      maxEventStreamBytes: request.maxEventStreamBytes,
      maxEventBytes: request.maxEventBytes,
      maxFinalOutputBytes: request.protocol.maxOutputBytes,
    });
    if (this.forcedResult) {
      if (this.forcedResult.exitCode !== 0) {
        throw classifyCodexAppServerDiagnostic(
          this.forcedResult.stderr,
          this.forcedResult.termination ===
            ReviewAgentProcessTermination.StartupFailed
            ? ReviewAgentFailureClass.StartupFailure
            : ReviewAgentFailureClass.ProcessFailure
        );
      }
    }
    if (this.incompleteStream) {
      throw new ReviewAgentExecutionError(
        ReviewAgentFailureClass.StreamIncomplete,
        null,
        'review_agent_stream_incomplete'
      );
    }
    if (this.omitModel) {
      throw new ReviewAgentExecutionError(
        ReviewAgentFailureClass.ModelAttributionMissing,
        null,
        'review_agent_model_attribution_missing'
      );
    }
    if (this.omitUsage) {
      throw new ReviewAgentExecutionError(
        ReviewAgentFailureClass.UsageAttributionMissing,
        null,
        'review_agent_usage_attribution_missing'
      );
    }
    if (
      Buffer.isBuffer(this.rawCodexOutput) &&
      this.rawCodexOutput.byteLength > 4 * 1024 * 1024
    ) {
      throw new ReviewAgentExecutionError(
        ReviewAgentFailureClass.SchemaInvalidOutput,
        null,
        'review_agent_output_invalid'
      );
    }
    return {
      finalMessage:
        this.rawCodexOutput === null
          ? JSON.stringify(this.output)
          : String(this.rawCodexOutput),
      actualModel: 'gpt-5.6-codex',
      modelProvider: 'openai',
      usage: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 10,
        reasoningOutputTokens: 3,
        totalTokens: 110,
      },
      durationMs: 25,
    };
  }

  async cancel(invocationId: string, fencingToken: string): Promise<void> {
    this.cancellations.push({ invocationId, fencingToken });
    if (this.cancelError) throw this.cancelError;
  }
}

class FakeExecutionSessions implements ReviewAgentExecutionSessionResolverPort {
  readonly session = Object.freeze({
    kind: ReviewAgentExecutionSessionKind.ContextGatewayV4,
  });
  binding: ReviewAgentGatewayLaunchBinding = Object.freeze({
    policyVersion: 'context-gateway-v4',
    binaryHash: digest('e'),
    command: process.execPath,
    args: Object.freeze(['/tmp/context-gateway.cjs']),
    cwd: process.cwd(),
    enabledTools: REVIEW_INVESTIGATION_GATEWAY_TOOLS,
    runtimeEnvironment: Object.freeze({
      REVIEWROUTER_CONTEXT_SESSION_ID: 'session-1',
    }),
    credentialEnvironment: Object.freeze({
      REVIEWROUTER_CONTEXT_GATEWAY_SECRET: 'gateway-secret',
    }),
  });

  resolve(
    session: ReviewTurnRequest['executionSession'],
    _providerKind: ReviewAgentProviderKind
  ): ReviewAgentGatewayLaunchBinding {
    if (session !== this.session) {
      throw new Error('test_execution_session_unavailable');
    }
    return this.binding;
  }
}

function fixture(
  providerKind: ReviewAgentProviderKind,
  forcedResult?: ReviewAgentProcessResult
): {
  adapter: ReviewAgentPort;
  credentials: { environment: Readonly<NodeJS.ProcessEnv> };
  runner: FakeRunner;
  request: ReviewTurnRequest;
  sessions: FakeExecutionSessions;
} {
  const runner = new FakeRunner(providerKind, forcedResult);
  const sessions = new FakeExecutionSessions();
  const credentials = {
    environment:
      providerKind === ReviewAgentProviderKind.Codex
        ? { CODEX_HOME: '/tmp/codex-home' }
        : { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret' },
  };
  const adapter =
    providerKind === ReviewAgentProviderKind.Codex
      ? new CodexReviewAgentAdapter(runner, {
          executionSessions: sessions,
          providerCredentialEnvironment: () => credentials.environment,
          binary: 'codex-test',
          appServerRunner: runner,
        })
      : new ClaudeReviewAgentAdapter(runner, {
          executionSessions: sessions,
          providerCredentialEnvironment: () => credentials.environment,
          binary: 'claude-test',
        });
  return {
    adapter,
    credentials,
    runner,
    sessions,
    request: {
      invocationId: 'invocation-1',
      fencingToken: 'fence-1',
      turnId: 'turn-1',
      dossierVersion: 3,
      dossierDigest: digest('d'),
      purpose: ReviewTurnPurpose.Discovery,
      allowedObligationIds: Object.freeze([digest('b')]),
      prompt: 'Inspect the durable dossier using only ReviewRouter tools.',
      workspaceRoot: process.cwd(),
      requestedModel:
        providerKind === ReviewAgentProviderKind.Codex
          ? 'gpt-5.6-codex'
          : 'claude-sonnet-5',
      timeoutMs: 30_000,
      maxTurns: 8,
      executionSession: sessions.session,
    },
  };
}

function argumentAfter(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1])
    throw new Error(`test_argument_missing:${name}`);
  return args[index + 1];
}

function isFeatureDisabled(args: readonly string[], feature: string): boolean {
  return args.some(
    (argument, index) => argument === feature && args[index - 1] === '--disable'
  );
}
