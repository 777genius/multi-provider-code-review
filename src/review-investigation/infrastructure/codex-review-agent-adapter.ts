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
      maxOutputBytes: this.profile.maxOutputBytes * 3,
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
      output = parseReviewAgentTurnOutput(parseFinalJson(result.finalMessage));
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

function parseFinalJson(message: string): unknown {
  const trimmed = message.trim();
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const extracted = extractSingleJsonPayload(trimmed);
    if (extracted === null) throw error;
    return JSON.parse(extracted);
  }
}

function extractSingleJsonPayload(message: string): string | null {
  const fenced = message.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/iu);
  if (fenced) {
    const payload = fenced[1];
    return typeof payload === 'string' ? payload.trim() : null;
  }

  const start = message.indexOf('{');
  const end = message.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const prefix = message.slice(0, start).trim();
  const suffix = message.slice(end + 1).trim();
  if (prefix || suffix) return null;
  return message.slice(start, end + 1);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(',')}]`;
}
