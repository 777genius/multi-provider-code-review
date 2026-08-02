import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
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

const DISABLED_CODEX_FEATURES = Object.freeze([
  'shell_tool',
  'unified_exec',
  'browser_use',
  'computer_use',
  'js_repl',
  'tool_search',
  'web_search_request',
  'plugins',
]);

export class CodexReviewAgentAdapter extends StrictCliReviewAgent {
  constructor(
    runner: ReviewAgentProcessRunnerPort,
    private readonly options: Readonly<{
      binary?: string;
      reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
    }> = {}
  ) {
    super(
      createGatewayAttestedRuntimeProfile({
        providerKind: ReviewAgentProviderKind.Codex,
        eventStream: ReviewAgentEventStreamSupport.JsonLines,
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
      path.join(os.tmpdir(), 'review-agent-codex-')
    );
    const schemaPath = path.join(directory, 'turn-output.schema.json');
    const outputPath = path.join(directory, 'turn-output.json');
    try {
      await Promise.all([
        writeFile(
          schemaPath,
          JSON.stringify(buildReviewAgentTurnOutputSchema()),
          {
            mode: 0o600,
          }
        ),
        writeFile(outputPath, '', { mode: 0o600 }),
      ]);
      const result = await this.runProcess(request, {
        binary: this.options.binary ?? 'codex',
        args: this.buildArguments(request, schemaPath, outputPath),
      });
      try {
        const output = parseReviewAgentTurnOutput(
          JSON.parse(await readFile(outputPath, 'utf8'))
        );
        const events = parseJsonLines(result.stdout);
        const models = new Set<string>();
        let usage: ReturnType<typeof parseUsage> | null = null;
        let turnCompleted = false;
        for (const event of events) {
          collectConfiguredModels(event, models, 0);
          if (event.type === 'turn.completed') {
            if (turnCompleted)
              throw new Error('review_agent_turn_completed_duplicate');
            turnCompleted = true;
            if (!isRecord(event.usage)) {
              throw usageFailure('review_agent_codex_usage_missing');
            }
            const rawUsage = requireRecord(event.usage, 'codex_usage');
            usage = parseUsage({
              inputTokens: rawUsage.input_tokens,
              cachedInputTokens: rawUsage.cached_input_tokens,
              outputTokens: rawUsage.output_tokens,
              reasoningOutputTokens: rawUsage.reasoning_output_tokens,
            });
          }
        }
        if (!turnCompleted) {
          throw streamFailure('review_agent_codex_stream_incomplete');
        }
        if (!usage) throw usageFailure('review_agent_codex_usage_missing');
        return this.observation(
          request,
          {
            output,
            actualModel: requireObservedModel(models),
            usage,
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
    schemaPath: string,
    outputPath: string
  ): readonly string[] {
    const args = [
      'exec',
      '--model',
      request.requestedModel,
      '--sandbox',
      'read-only',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--strict-config',
      '--color',
      'never',
      '-c',
      'approval_policy=never',
      '--output-last-message',
      outputPath,
      '--output-schema',
      schemaPath,
      '--json',
    ];
    for (const feature of DISABLED_CODEX_FEATURES) {
      args.push('--disable', feature);
    }
    args.push(
      '-c',
      'mcp_servers={}',
      '-c',
      `mcp_servers.reviewrouter.command=${tomlString(request.gateway.command)}`,
      '-c',
      `mcp_servers.reviewrouter.args=${tomlStringArray(request.gateway.args)}`,
      '-c',
      `mcp_servers.reviewrouter.cwd=${tomlString(request.gateway.cwd)}`,
      '-c',
      `mcp_servers.reviewrouter.env_vars=${tomlStringArray(
        Object.keys({
          ...request.gateway.runtimeEnvironment,
          ...request.gateway.credentialEnvironment,
          REVIEWROUTER_CONTEXT_GATEWAY_POLICY_VERSION: 'context-gateway-v4',
        }).sort()
      )}`,
      '-c',
      'mcp_servers.reviewrouter.required=true',
      '-c',
      'mcp_servers.reviewrouter.startup_timeout_sec=45',
      '-c',
      'mcp_servers.reviewrouter.tool_timeout_sec=30',
      '-c',
      `mcp_servers.reviewrouter.enabled_tools=${tomlStringArray(
        request.gateway.enabledTools
      )}`,
      '-c',
      `model_reasoning_effort=${tomlString(
        this.options.reasoningEffort ?? 'xhigh'
      )}`,
      '-'
    );
    return Object.freeze(args);
  }
}

function parseJsonLines(value: string): readonly Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of value.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw streamFailure('review_agent_codex_event_json_invalid');
    }
    events.push(requireRecord(parsed, 'codex_event'));
  }
  if (events.length === 0)
    throw streamFailure('review_agent_codex_event_stream_empty');
  return events;
}

function collectConfiguredModels(
  value: unknown,
  models: Set<string>,
  depth: number
): void {
  if (!value || typeof value !== 'object' || depth > 5) return;
  const record = value as Record<string, unknown>;
  if (record.type === 'session_configured') {
    for (const candidate of [
      record.model,
      isRecord(record.payload) ? record.payload.model : undefined,
      isRecord(record.data) ? record.data.model : undefined,
      isRecord(record.session) ? record.session.model : undefined,
    ]) {
      if (typeof candidate === 'string') models.add(candidate);
    }
  }
  for (const nested of Object.values(record)) {
    if (nested && typeof nested === 'object') {
      collectConfiguredModels(nested, models, depth + 1);
    }
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`review_agent_${field}_invalid`);
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(',')}]`;
}
