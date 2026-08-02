import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { ReviewTurnRequest } from '../application/review-agent-port';
import {
  ReviewAgentEventStreamSupport,
  ReviewAgentProviderKind,
  createGatewayAttestedRuntimeProfile,
} from '../domain/runtime-profile';
import {
  buildReviewAgentTurnOutputSchema,
  parseReviewAgentTurnOutput,
  type ReviewTurnObservation,
} from '../domain/turn-observation';
import type { ReviewAgentProcessRunnerPort } from './review-agent-process-runner';
import {
  StrictCliReviewAgent,
  parseUsage,
  requireObservedModel,
  schemaFailure,
  streamFailure,
  usageFailure,
} from './strict-cli-review-agent';

const CLAUDE_NATIVE_TOOLS = Object.freeze([
  'Bash',
  'Edit',
  'Write',
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
  'Task',
  'TaskOutput',
  'KillShell',
  'AskUserQuestion',
  'Skill',
]);

export class ClaudeReviewAgentAdapter extends StrictCliReviewAgent {
  constructor(
    runner: ReviewAgentProcessRunnerPort,
    private readonly options: Readonly<{
      binary?: string;
      effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    }> = {}
  ) {
    super(
      createGatewayAttestedRuntimeProfile({
        providerKind: ReviewAgentProviderKind.ClaudeCode,
        eventStream: ReviewAgentEventStreamSupport.SingleEnvelope,
        maxPromptBytes: 8 * 1024 * 1024,
      }),
      runner
    );
  }

  async executeTurn(
    request: ReviewTurnRequest
  ): Promise<ReviewTurnObservation> {
    this.validateRequest(request);
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'review-agent-claude-')
    );
    const mcpConfigPath = path.join(directory, 'mcp.json');
    try {
      await writeFile(
        mcpConfigPath,
        JSON.stringify({
          mcpServers: {
            reviewrouter: {
              type: 'stdio',
              command: request.gateway.command,
              args: request.gateway.args,
              env: {
                ...request.gateway.runtimeEnvironment,
                REVIEWROUTER_CONTEXT_GATEWAY_POLICY_VERSION:
                  'context-gateway-v4',
                ...request.gateway.credentialEnvironment,
              },
            },
          },
        }),
        { mode: 0o600 }
      );
      const result = await this.runProcess(request, {
        binary: this.options.binary ?? 'claude',
        args: this.buildArguments(request, mcpConfigPath),
        environment: this.providerOnlyExecutionEnvironment(request),
      });
      try {
        const envelope = requireRecord(
          JSON.parse(result.stdout),
          'claude_envelope'
        );
        if (
          envelope.type !== 'result' ||
          envelope.subtype !== 'success' ||
          envelope.is_error === true
        ) {
          throw streamFailure('review_agent_claude_stream_incomplete');
        }
        const output = parseReviewAgentTurnOutput(envelope.structured_output);
        const modelUsage = requireRecord(
          envelope.modelUsage,
          'claude_model_usage'
        );
        const models = new Set(Object.keys(modelUsage));
        if (!envelope.usage || typeof envelope.usage !== 'object') {
          throw usageFailure('review_agent_claude_usage_missing');
        }
        const usage = requireRecord(envelope.usage, 'claude_usage');
        const cacheReadTokens = tokenCountOrZero(
          usage.cache_read_input_tokens,
          'claude_cache_read'
        );
        const cacheCreationTokens = tokenCountOrZero(
          usage.cache_creation_input_tokens,
          'claude_cache_creation'
        );
        const uncachedInputTokens = tokenCountOrZero(
          usage.input_tokens,
          'claude_input'
        );
        return this.observation(
          request,
          {
            output,
            actualModel: requireObservedModel(models),
            usage: parseUsage({
              inputTokens:
                uncachedInputTokens + cacheReadTokens + cacheCreationTokens,
              cachedInputTokens: cacheReadTokens,
              outputTokens: usage.output_tokens,
            }),
          },
          result.durationMs
        );
      } catch (error) {
        throw schemaFailure(error);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private buildArguments(
    request: ReviewTurnRequest,
    mcpConfigPath: string
  ): readonly string[] {
    const tools = request.gateway.enabledTools.map(
      (tool) => `mcp__reviewrouter__${tool}`
    );
    return Object.freeze([
      '--print',
      '--model',
      request.requestedModel,
      '--effort',
      this.options.effort ?? 'xhigh',
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--no-chrome',
      '--mcp-config',
      mcpConfigPath,
      '--strict-mcp-config',
      '--tools',
      tools.join(','),
      '--allowedTools',
      tools.join(','),
      '--disallowedTools',
      CLAUDE_NATIVE_TOOLS.join(','),
      '--permission-mode',
      'dontAsk',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(buildReviewAgentTurnOutputSchema()),
      '--no-session-persistence',
      '--max-turns',
      String(request.maxTurns),
    ]);
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`review_agent_${field}_invalid`);
  }
  return value as Record<string, unknown>;
}

function tokenCountOrZero(value: unknown, field: string): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`review_agent_${field}_tokens_invalid`);
  }
  return value as number;
}
