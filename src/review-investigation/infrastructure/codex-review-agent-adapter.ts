import {
  ReviewAgentExecutionError,
  ReviewAgentFailureClass,
  type ReviewTurnRequest,
} from '../application/review-agent-port';
import {
  ReviewAgentEventStreamSupport,
  ReviewAgentProviderKind,
  createGatewayAttestedRuntimeProfile,
} from '../domain/runtime-profile';
import {
  buildReviewAgentTurnOutputSchema,
  parseReviewAgentTurnOutput,
  type ReviewAgentTurnOutput,
  type ReviewTurnObservation,
} from '../domain/turn-observation';
import {
  NodeCodexAppServerTurnRunner,
  type CodexAppServerTurnRunnerPort,
} from './codex-app-server-turn-runner';
import type { ReviewAgentProcessResult } from './review-agent-process-runner';
import type { ReviewAgentProcessRunnerPort } from './review-agent-process-runner';
import type {
  ReviewAgentExecutionSessionResolverPort,
  ReviewAgentGatewayLaunchBinding,
} from './review-agent-execution-session';
import { StrictCliReviewAgent, schemaFailure } from './strict-cli-review-agent';
import type { CodexAppServerReasoningEffort } from './codex-app-server-protocol';
import { CODEX_CONFINEMENT_DISABLED_FEATURES } from '../../providers/codex-confinement-policy';

export type CodexReviewAgentAdapterOptions = Readonly<{
  executionSessions: ReviewAgentExecutionSessionResolverPort;
  providerCredentialEnvironment?: () => Readonly<NodeJS.ProcessEnv>;
  binary?: string;
  reasoningEffort?: CodexAppServerReasoningEffort;
  appServerRunner?: CodexAppServerTurnRunnerPort;
  interruptGraceMs?: number;
  processResultObserver?: (result: ReviewAgentProcessResult) => void;
}>;

const CODEX_APP_SERVER_EVENT_STREAM_OUTPUT_MULTIPLIER = 32;
const CODEX_APP_SERVER_SINGLE_EVENT_OUTPUT_MULTIPLIER = 2;

export class CodexReviewAgentAdapter extends StrictCliReviewAgent {
  private readonly appServerRunner: CodexAppServerTurnRunnerPort;

  constructor(
    runner: ReviewAgentProcessRunnerPort,
    private readonly options: CodexReviewAgentAdapterOptions
  ) {
    super(
      createGatewayAttestedRuntimeProfile({
        providerKind: ReviewAgentProviderKind.Codex,
        eventStream: ReviewAgentEventStreamSupport.JsonLines,
        maxPromptBytes: 8 * 1024 * 1024,
      }),
      runner,
      options.executionSessions,
      options.providerCredentialEnvironment ?? (() => ({}))
    );
    this.appServerRunner =
      options.appServerRunner ??
      new NodeCodexAppServerTurnRunner({
        ...(options.interruptGraceMs === undefined
          ? {}
          : { interruptGraceMs: options.interruptGraceMs }),
        ...(options.processResultObserver === undefined
          ? {}
          : { processResultObserver: options.processResultObserver }),
      });
  }

  async executeTurn(
    request: ReviewTurnRequest
  ): Promise<ReviewTurnObservation> {
    const execution = this.prepareExecution(request);
    const reasoningEffort = this.options.reasoningEffort ?? 'xhigh';
    const result = await this.appServerRunner.executeTurn({
      invocationId: request.invocationId,
      fencingToken: request.fencingToken,
      binary: this.options.binary ?? 'codex',
      args: this.buildArguments(execution.gateway),
      cwd: execution.gateway.cwd,
      environment: this.executionEnvironment(execution),
      timeoutMs: request.timeoutMs,
      maxEventStreamBytes:
        this.profile.maxOutputBytes *
        CODEX_APP_SERVER_EVENT_STREAM_OUTPUT_MULTIPLIER,
      maxEventBytes:
        this.profile.maxOutputBytes *
        CODEX_APP_SERVER_SINGLE_EVENT_OUTPUT_MULTIPLIER,
      signal: request.signal,
      protocol: {
        cwd: execution.gateway.cwd,
        prompt: request.prompt,
        clientTurnId: request.turnId,
        requestedModel: request.requestedModel,
        reasoningEffort,
        outputSchema: buildReviewAgentTurnOutputSchema(
          request.allowedObligationIds
        ),
        allowedTools: execution.gateway.enabledTools,
        maxOutputBytes: this.profile.maxOutputBytes,
      },
    });

    let output;
    try {
      output = parseFinalTurnOutput(result.finalMessage);
    } catch (error) {
      throw schemaFailure(error);
    }
    return this.observation(
      request,
      {
        output,
        actualModel: result.actualModel,
        usage: result.usage,
      },
      result.durationMs
    );
  }

  async cancel(invocationId: string, fencingToken: string): Promise<void> {
    try {
      await this.appServerRunner.cancel(invocationId, fencingToken);
    } catch {
      throw new ReviewAgentExecutionError(
        ReviewAgentFailureClass.ProcessFailure,
        null,
        'review_agent_cancel_failure'
      );
    }
  }

  private buildArguments(
    gateway: ReviewAgentGatewayLaunchBinding
  ): readonly string[] {
    const args = ['app-server', '--stdio', '--strict-config'];
    for (const feature of CODEX_CONFINEMENT_DISABLED_FEATURES) {
      args.push('--disable', feature);
    }
    args.push(
      '-c',
      'approval_policy="never"',
      '-c',
      'sandbox_mode="read-only"',
      '-c',
      'project_doc_max_bytes=0',
      '-c',
      'web_search="disabled"',
      '-c',
      'mcp_servers={}',
      '-c',
      `mcp_servers.reviewrouter.command=${tomlString(gateway.command)}`,
      '-c',
      `mcp_servers.reviewrouter.args=${tomlStringArray(gateway.args)}`,
      '-c',
      `mcp_servers.reviewrouter.cwd=${tomlString(gateway.cwd)}`,
      '-c',
      `mcp_servers.reviewrouter.env_vars=${tomlStringArray(
        Object.keys({
          ...gateway.runtimeEnvironment,
          ...gateway.credentialEnvironment,
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
        gateway.enabledTools
      )}`
    );
    return Object.freeze(args);
  }
}

function parseFinalTurnOutput(message: string): ReviewAgentTurnOutput {
  const trimmed = message.trim();
  const valid = new Map<string, ReviewAgentTurnOutput>();
  const validationFailures = new Set<string>();
  let parsedPayloads = 0;
  for (const candidate of extractJsonPayloadCandidates(trimmed)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
      parsedPayloads += 1;
    } catch {
      continue;
    }
    try {
      const output = parseReviewAgentTurnOutput(parsed);
      valid.set(JSON.stringify(output), output);
    } catch (error) {
      validationFailures.add(classifyOutputValidationFailure(error));
    }
  }
  if (valid.size !== 1) {
    if (
      valid.size === 0 &&
      parsedPayloads === 1 &&
      validationFailures.size === 1
    ) {
      throw new Error([...validationFailures][0]!);
    }
    throw new Error('review_agent_output_invalid');
  }
  return [...valid.values()][0]!;
}

function classifyOutputValidationFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (
    /obligation_(?:kind|proposal|requirement|subject)|risk_priority/u.test(
      message
    )
  ) {
    return 'review_agent_output_invalid_obligation_proposal';
  }
  if (/finding/u.test(message)) {
    return 'review_agent_output_invalid_finding';
  }
  if (/critic/u.test(message)) {
    return 'review_agent_output_invalid_critic';
  }
  if (/closure|discovery|receipt|unresolvable|obligation_id/u.test(message)) {
    return 'review_agent_output_invalid_claims';
  }
  return 'review_agent_output_invalid_shape';
}

function extractJsonPayloadCandidates(message: string): readonly string[] {
  const candidates = new Set<string>();
  if (message) candidates.add(message);

  const fencedPattern = /```(?:json)?\s*\n([\s\S]*?)\n```/giu;
  for (const match of message.matchAll(fencedPattern)) {
    const payload = match[1]?.trim();
    if (payload) candidates.add(payload);
  }

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < message.length; index += 1) {
    const character = message[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"' && depth > 0) {
      inString = true;
      continue;
    }
    if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character !== '}' || depth === 0) continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      candidates.add(message.slice(start, index + 1));
      start = -1;
    }
  }
  return Object.freeze([...candidates]);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(',')}]`;
}
