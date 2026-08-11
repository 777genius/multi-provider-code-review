import { Provider, ProviderExecutionPolicy, RateLimitError } from './base';
import { Finding, ReviewResult } from '../types';
import { logger } from '../utils/logger';
import { redactSensitiveText } from '../utils/redaction';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { estimateTokensSimple } from '../utils/token-estimation';
import { buildCliSafeEnv } from './cli-env';
import { CODEX_CONFINEMENT_DISABLED_FEATURES } from './codex-confinement-policy';
import { prepareCodexCliBeforeAuthRead } from '../codex-oauth/codex-cli';
import {
  buildReviewFindingsSchema,
  type ParsedReviewOutput,
  parseReviewOutputStrict,
  parseReviewFindingsStrict,
} from './review-output';
import {
  createPreparedProviderInvocation,
  describeEnvironmentContract,
  mergeCredentialEnvironment,
  type PreparedProviderInvocation,
  type ProviderCredentialLease,
  ProviderKind,
  requirePreparedProviderInvocation,
} from './prepared-invocation';
import {
  CONTEXT_GATEWAY_POLICY_VERSION,
  CONTEXT_GATEWAY_RUNTIME_ENV_KEYS,
  CONTEXT_GATEWAY_V3_ENABLED_TOOLS,
} from '../context-gateway/context-gateway-contract';
import {
  CONTEXT_GATEWAY_V4_ENABLED_TOOLS,
  CONTEXT_GATEWAY_V4_POLICY_VERSION,
} from '../context-gateway/context-gateway-v4-contract';

export interface CodexProviderOptions {
  agenticContext?: boolean;
  eventAudit?: boolean;
  modelProvider?: 'openai' | 'openrouter';
  providerNamePrefix?: 'codex' | 'codex-openrouter' | 'openrouter';
  providerNameModel?: string;
}

export type CodexContextGatewayInvocationConfig = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  gatewayBinaryHash: string;
  gatewayPolicyVersion: string;
  enabledTools: readonly string[];
  runtimeEnvironment: Readonly<NodeJS.ProcessEnv>;
}>;

type CodexRunOptions = {
  healthCheck: boolean;
  outputSchema?: unknown;
  eventAudit?: boolean;
  jsonEvents?: boolean;
  cwd?: string;
  includeWorkspaceEnv?: boolean;
  disableTools?: boolean;
  skipGitRepoCheck?: boolean;
  acceptReviewOutputOnNonZero?: boolean;
  signal?: AbortSignal;
};

type CodexRunResult = {
  stdout: string;
  stderr: string;
  lastMessage: string;
  actualModelObservation: CodexActualModelObservation;
  audit?: CodexAgenticAudit;
};

enum CodexActualModelObservationKind {
  Missing = 'missing',
  Observed = 'observed',
  Ambiguous = 'ambiguous',
}

type CodexActualModelObservation =
  | Readonly<{ kind: CodexActualModelObservationKind.Missing }>
  | Readonly<{
      kind: CodexActualModelObservationKind.Observed;
      model: string;
    }>
  | Readonly<{ kind: CodexActualModelObservationKind.Ambiguous }>;

type CodexAgenticAuditMode = 'off' | 'rerun' | 'strict';

const MAX_OPTIONAL_AGENTIC_RETRY_PROMPT_TOKENS = 24_000;

const REVIEW_OUTPUT_CONTRACT = [
  'FINAL OUTPUT CONTRACT:',
  'Return exactly one JSON object with exactly two top-level arrays: "findings" and "revalidations".',
  'Each finding object must contain exactly these fields: "file", "startLine", "line", "endLine", "severity", "title", "message", and "suggestion".',
  'Each revalidation object must contain exactly these fields: "targetId", "fingerprint", "verdict", "confidence", "evidence", and "rationale".',
  'Each revalidation evidence object must contain exactly these fields: "path", "startLine", "endLine", and "reason".',
  'Return ONLY one valid JSON object.',
  'No markdown, no prose, no code fences, comments, trailing commas, or text before/after the JSON.',
  'If there are no findings and no lifecycle targets to revalidate, return exactly {"findings":[],"revalidations":[]}.',
  'Do not invent example findings or revalidations, and never copy schema descriptions or field names as field values.',
  'The "findings" array may be empty. "severity" must be one of "critical", "major", or "minor".',
  'The "revalidations" array may be empty. Include entries only for targetId values listed in the deterministic prompt.',
  'When a finding covers a changed block, set "startLine" and "endLine" to its RIGHT-side range and keep "line" equal to "endLine". For a single line, use null for both range fields.',
  'The "suggestion" field is required; use null unless there is an exact safe replacement.',
] as const;

type CodexAgenticAudit = {
  commandExecutions: number;
  readOnlyExplorationCommands: number;
  commands: string[];
};

type CodexPreparedRequest = {
  readonly binary: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly argsTemplate: readonly string[];
  readonly outputSchema: unknown;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly eventAudit: boolean;
  readonly jsonEvents: boolean;
  readonly auditMode: CodexAgenticAuditMode;
  readonly optionalAgenticRetryMaxPromptTokens: number;
  readonly acceptReviewOutputOnNonZero: boolean;
  readonly contextGateway?: CodexContextGatewayInvocationConfig;
};

type CodexPreparedExecution = {
  readonly result: ReviewResult;
  readonly content: string;
  readonly parsed: ParsedReviewOutput;
  readonly runResult: CodexRunResult;
};

type CodexFrozenCliConfig = {
  readonly model: string;
  readonly modelProvider: CodexProviderOptions['modelProvider'];
  readonly forkSandbox: boolean;
  readonly reasoningEffort?: string;
};

const CODEX_OUTPUT_FILE_PLACEHOLDER = '{reviewrouter_output_file}';
const CODEX_SCHEMA_FILE_PLACEHOLDER = '{reviewrouter_schema_file}';
const CONTEXT_GATEWAY_RUNTIME_ENV_KEY_SET = new Set(
  CONTEXT_GATEWAY_RUNTIME_ENV_KEYS
);
const CONTEXT_GATEWAY_MCP_ENV_VARS = Object.freeze(
  [
    ...CONTEXT_GATEWAY_RUNTIME_ENV_KEY_SET,
    'REVIEWROUTER_CONTEXT_GATEWAY_SECRET',
  ].sort()
);

class CodexCliExitError extends Error {
  constructor(
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string,
    message: string
  ) {
    super(message);
    this.name = 'CodexCliExitError';
  }
}

export class CodexProvider extends Provider {
  private static preparedBinaryPath: string | undefined;

  constructor(
    private readonly model: string,
    private readonly options: CodexProviderOptions = {}
  ) {
    super(
      `${options.providerNamePrefix || 'codex'}/${options.providerNameModel || model}`
    );
  }

  // Verify the CLI is available. Model/auth failures are surfaced by the real
  // review call; a model-exec health check costs an extra Codex subscription
  // request and can exhaust limited OAuth usage before review starts.
  async healthCheck(_timeoutMs: number = 5000): Promise<boolean> {
    const timeoutMs = Math.max(500, _timeoutMs ?? 5000);
    const mode = (process.env.CODEX_HEALTHCHECK_MODE || 'binary').toLowerCase();

    if (mode === 'none' || mode === 'binary') {
      return true;
    }

    let timeoutId: NodeJS.Timeout;
    let isTimedOut = false;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        isTimedOut = true;
        reject(new Error(`Codex health check timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      const binary = await Promise.race([
        this.resolveBinary().then((resolved) => {
          if (isTimedOut) {
            logger.debug(`Codex binary resolved after timeout (${this.name})`);
          }
          return resolved;
        }),
        timeoutPromise,
      ]);
      clearTimeout(timeoutId!);

      const result = await this.runCliWithStdin(
        binary,
        'Respond with exactly: codex-health-ok',
        timeoutMs,
        { healthCheck: true }
      );
      const output = result.lastMessage || result.stdout;

      if (!output.includes('codex-health-ok')) {
        logger.warn(
          `Codex health check returned unexpected output for ${this.name}`
        );
        return false;
      }

      return true;
    } catch (error) {
      if (timeoutId!) {
        clearTimeout(timeoutId);
      }
      logger.warn(
        `Codex health check failed for ${this.name}: ${(error as Error).message}`
      );
      return false;
    }
  }

  async review(
    prompt: string,
    timeoutMs: number,
    executionPolicy?: ProviderExecutionPolicy
  ): Promise<ReviewResult> {
    const started = Date.now();
    try {
      let invocation = await this.prepareInvocation(
        prompt,
        timeoutMs,
        executionPolicy
      );
      const credentialLease = this.captureCredentialLease(invocation);
      let execution = await this.executePreparedDetailed(
        invocation,
        credentialLease
      );
      if (execution.runResult.audit) {
        this.logAgenticAudit(execution.runResult.audit, false);
      }

      if (
        this.shouldRetryForMissingAgenticExploration(
          execution.parsed,
          execution.runResult.audit,
          prompt,
          invocation.request.auditMode,
          invocation.request.optionalAgenticRetryMaxPromptTokens
        ) &&
        (executionPolicy?.canStartOptionalRetry() ?? true)
      ) {
        logger.warn(
          `Codex agentic review completed without read-only exploration; retrying once for ${this.name}`
        );
        const firstExecution = execution;
        try {
          const retryTimeoutMs =
            executionPolicy?.clampTimeoutMs(timeoutMs) ?? timeoutMs;
          if (retryTimeoutMs <= 0) {
            throw new Error(
              'Review execution deadline reached before Codex agentic retry'
            );
          }
          invocation = this.prepareRetryInvocation(
            invocation,
            this.buildAgenticRetryPrompt(
              invocation.request.prompt,
              execution.runResult.audit
            ),
            retryTimeoutMs
          );
          execution = await this.executePreparedDetailed(
            invocation,
            credentialLease
          );
          if (execution.runResult.audit) {
            this.logAgenticAudit(execution.runResult.audit, true);
          }
        } catch (retryError) {
          if (invocation.request.auditMode === 'strict') {
            throw retryError;
          }
          const normalizedRetryError = this.normalizeCodexError(retryError);
          logger.warn(
            `Codex agentic retry failed for ${this.name}; preserving first-pass findings. ${normalizedRetryError.message}`
          );
          execution = firstExecution;
        }
        if (
          execution !== firstExecution &&
          this.isMissingAgenticExploration(
            execution.parsed,
            execution.runResult.audit,
            prompt
          ) &&
          firstExecution.parsed.findings.length >=
            execution.parsed.findings.length
        ) {
          logger.warn(
            `Codex agentic retry still lacked read-only exploration and did not add findings; preserving first-pass findings for ${this.name}`
          );
          execution = firstExecution;
        }
      }

      if (
        invocation.request.auditMode === 'strict' &&
        this.isMissingAgenticExploration(
          execution.parsed,
          execution.runResult.audit,
          prompt
        )
      ) {
        throw new Error(
          'Codex agentic review completed without recorded read-only repository exploration'
        );
      }

      const durationSeconds = (Date.now() - started) / 1000;
      logger.info(
        `Codex CLI output for ${this.name}: final=${execution.content.length} bytes, stdout=${execution.runResult.stdout.length} bytes, stderr=${execution.runResult.stderr.length} bytes, duration=${durationSeconds.toFixed(1)}s`
      );

      return {
        ...execution.result,
        durationSeconds,
        usage: this.estimateUsage(prompt, execution.content),
      };
    } catch (error) {
      const normalized = this.normalizeCodexError(error);
      this.logNormalizedFailure(normalized);
      throw normalized;
    }
  }

  async prepareInvocation(
    prompt: string,
    timeoutMs: number,
    executionPolicy?: ProviderExecutionPolicy,
    contextGateway?: CodexContextGatewayInvocationConfig
  ): Promise<PreparedProviderInvocation<CodexPreparedRequest>> {
    if (contextGateway) this.validateContextGatewayConfig(contextGateway);
    const effectiveTimeoutMs =
      executionPolicy?.clampTimeoutMs(timeoutMs) ?? timeoutMs;
    if (effectiveTimeoutMs <= 0) {
      const deadlineError = new Error(
        'Review execution deadline reached before Codex invocation'
      );
      deadlineError.name = 'TimeoutError';
      throw deadlineError;
    }
    const binary = await this.resolveBinary();
    const cwd = process.cwd();
    const agenticContext = contextGateway
      ? true
      : this.shouldUseAgenticContext();
    const finalPrompt = contextGateway
      ? this.wrapContextGatewayReviewPrompt(
          prompt,
          contextGateway.enabledTools,
          contextGateway.gatewayPolicyVersion
        )
      : agenticContext
        ? await this.wrapAgenticReviewPrompt(prompt)
        : this.wrapPromptOnlyReviewPrompt(prompt);
    // Gateway sessions prove exploration through their authenticated transcript.
    // The legacy audit only understands shell command events.
    const auditMode =
      agenticContext && !contextGateway ? this.agenticAuditMode() : 'off';
    const eventAudit = contextGateway ? true : this.shouldUseEventAudit();
    const forkSandbox = this.shouldUseForkSandboxCodexHomeConfig();
    const reasoningEffort = this.resolveReasoningEffort(false);
    const frozenCliConfig: CodexFrozenCliConfig = {
      model: this.model,
      modelProvider: this.options.modelProvider,
      forkSandbox,
      reasoningEffort,
    };
    const fullEnvironment = {
      ...this.buildSafeEnv(true, frozenCliConfig),
      ...(contextGateway?.runtimeEnvironment ?? {}),
    };
    const environment = this.withoutCredentialEnvironment(fullEnvironment);
    const outputSchema = this.buildFindingsSchema();
    const argsTemplate = this.buildExecArgs(
      {
        healthCheck: false,
        outputLastMessageFile: CODEX_OUTPUT_FILE_PLACEHOLDER,
        outputSchemaFile: CODEX_SCHEMA_FILE_PLACEHOLDER,
        eventAudit,
        jsonEvents: auditMode !== 'off' || contextGateway !== undefined,
      },
      frozenCliConfig,
      contextGateway
    );

    const request: CodexPreparedRequest = {
      binary,
      prompt: finalPrompt,
      cwd,
      argsTemplate,
      outputSchema,
      environment,
      eventAudit,
      jsonEvents: auditMode !== 'off' || contextGateway !== undefined,
      auditMode,
      optionalAgenticRetryMaxPromptTokens:
        MAX_OPTIONAL_AGENTIC_RETRY_PROMPT_TOKENS,
      acceptReviewOutputOnNonZero: true,
      ...(contextGateway ? { contextGateway } : {}),
    };
    return createPreparedProviderInvocation({
      providerKind: ProviderKind.CodexCli,
      providerName: this.name,
      requestedModel: this.model,
      timeoutMs: effectiveTimeoutMs,
      request,
      observableRequest: this.observablePreparedRequest(request),
    });
  }

  async executePreparedInvocation(
    invocation: PreparedProviderInvocation,
    credentialLease?: ProviderCredentialLease,
    signal?: AbortSignal
  ): Promise<ReviewResult> {
    try {
      return (
        await this.executePreparedDetailed(invocation, credentialLease, signal)
      ).result;
    } catch (error) {
      const normalized = this.normalizeCodexError(error);
      this.logNormalizedFailure(normalized);
      throw normalized;
    }
  }

  describePreparedEnvironmentContract(
    invocation: PreparedProviderInvocation
  ): Readonly<Record<string, string>> {
    const prepared = requirePreparedProviderInvocation<CodexPreparedRequest>(
      invocation,
      ProviderKind.CodexCli,
      this.name
    );
    return describeEnvironmentContract(
      this.observablePreparedEnvironment(prepared.request)
    );
  }

  private logNormalizedFailure(error: Error): void {
    logger.error(`Codex provider failed: ${this.name}`, {
      error: error.message,
    });
  }

  private prepareRetryInvocation(
    previous: PreparedProviderInvocation<CodexPreparedRequest>,
    retryPrompt: string,
    timeoutMs: number
  ): PreparedProviderInvocation<CodexPreparedRequest> {
    return createPreparedProviderInvocation({
      providerKind: ProviderKind.CodexCli,
      providerName: previous.providerName,
      requestedModel: previous.requestedModel,
      timeoutMs,
      request: {
        ...previous.request,
        prompt: retryPrompt,
        jsonEvents: true,
      },
    });
  }

  private async executePreparedDetailed(
    invocation: PreparedProviderInvocation,
    credentialLease?: ProviderCredentialLease,
    signal?: AbortSignal
  ): Promise<CodexPreparedExecution> {
    const prepared = requirePreparedProviderInvocation<CodexPreparedRequest>(
      invocation,
      ProviderKind.CodexCli,
      this.name
    );
    const request = prepared.request;
    logger.info(
      `Running Codex CLI safely: ${request.binary} exec --model ${prepared.requestedModel} --sandbox read-only --ephemeral ...`
    );
    const started = Date.now();
    const runResult = await this.runCliWithStdin(
      request.binary,
      request.prompt,
      prepared.timeoutMs,
      {
        healthCheck: false,
        outputSchema: request.outputSchema,
        eventAudit: request.eventAudit,
        jsonEvents: request.jsonEvents,
        cwd: request.cwd,
        acceptReviewOutputOnNonZero: request.acceptReviewOutputOnNonZero,
        signal,
      },
      {
        argsTemplate: request.argsTemplate,
        cwd: request.cwd,
        environment: mergeCredentialEnvironment(
          request.environment,
          credentialLease?.environment
        ),
      }
    );
    const content = this.sanitizeReviewContent(
      (runResult.lastMessage || runResult.stdout).trim(),
      request.cwd
    );
    const parsed = this.parseNonEmptyReviewContent(content, runResult.stderr);
    this.assertNoPlaceholderFindings(parsed.findings);
    const actualModel = this.resolveEffectiveActualModel(
      runResult.actualModelObservation,
      prepared.requestedModel
    );
    return {
      content,
      parsed,
      runResult,
      result: {
        content,
        durationSeconds: (Date.now() - started) / 1000,
        usage: this.estimateUsage(request.prompt, content),
        findings: parsed.findings,
        revalidations: parsed.revalidations,
        ...(actualModel ? { actualModel } : {}),
      },
    };
  }

  private captureCredentialLease(
    invocation: PreparedProviderInvocation<CodexPreparedRequest>
  ): ProviderCredentialLease {
    const environment: NodeJS.ProcessEnv = {};
    const credentialKeys = ['OPENAI_API_KEY'];
    if (
      invocation.request.argsTemplate.includes(
        'model_providers.openrouter.env_key="OPENROUTER_API_KEY"'
      )
    ) {
      credentialKeys.push('OPENROUTER_API_KEY');
    }
    for (const key of credentialKeys) {
      if (process.env[key] !== undefined) environment[key] = process.env[key];
    }
    return { environment: Object.freeze(environment) };
  }

  private withoutCredentialEnvironment(
    environment: NodeJS.ProcessEnv
  ): Readonly<NodeJS.ProcessEnv> {
    const sanitized = { ...environment };
    delete sanitized.OPENAI_API_KEY;
    delete sanitized.OPENROUTER_API_KEY;
    delete sanitized.REVIEWROUTER_CONTEXT_GATEWAY_SECRET;
    return Object.freeze(sanitized);
  }

  async runStructuredPrompt(
    prompt: string,
    outputSchema: unknown,
    timeoutMs: number,
    options: {
      cwd?: string;
      eventAudit?: boolean;
      includeWorkspaceEnv?: boolean;
      skipGitRepoCheck?: boolean;
    } = {}
  ): Promise<string> {
    const binary = await this.resolveBinary();
    const { stdout, stderr, lastMessage } = await this.runCliWithStdin(
      binary,
      prompt,
      timeoutMs,
      {
        healthCheck: false,
        outputSchema,
        eventAudit: options.eventAudit,
        cwd: options.cwd,
        includeWorkspaceEnv: options.includeWorkspaceEnv,
        disableTools: true,
        skipGitRepoCheck: options.skipGitRepoCheck,
      }
    );
    const content = this.sanitizeReviewContent((lastMessage || stdout).trim());
    if (!content) {
      throw new Error(
        `Codex CLI returned no output${stderr ? `; stderr: ${stderr.slice(0, 200)}` : ''}`
      );
    }
    return content;
  }

  private estimateUsage(prompt: string, content: string) {
    const promptTokens = estimateTokensSimple(prompt).tokens;
    const completionTokens = estimateTokensSimple(content).tokens;

    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }

  private buildExecArgs(
    options: {
      healthCheck: boolean;
      outputLastMessageFile: string;
      outputSchemaFile?: string;
      eventAudit?: boolean;
      jsonEvents?: boolean;
      disableTools?: boolean;
      skipGitRepoCheck?: boolean;
    },
    frozenConfig?: CodexFrozenCliConfig,
    contextGateway?: CodexContextGatewayInvocationConfig
  ): string[] {
    const config =
      frozenConfig ??
      ({
        model: this.model,
        modelProvider: this.options.modelProvider,
        forkSandbox: this.shouldUseForkSandboxCodexHomeConfig(),
        reasoningEffort: this.resolveReasoningEffort(options.healthCheck),
      } satisfies CodexFrozenCliConfig);
    // The top-level `codex` command starts the interactive TUI and fails in CI.
    const args = [
      'exec',
      '--model',
      config.model,
      '--sandbox',
      'read-only',
      '--ephemeral',
      '--ignore-rules',
      '-c',
      'approval_policy=never',
      '--output-last-message',
      options.outputLastMessageFile,
    ];

    if (!config.forkSandbox) {
      args.splice(args.indexOf('--ignore-rules'), 0, '--ignore-user-config');
    }

    if (options.skipGitRepoCheck) {
      args.splice(1, 0, '--skip-git-repo-check');
    }

    if (options.disableTools || contextGateway) {
      for (const feature of CODEX_CONFINEMENT_DISABLED_FEATURES) {
        args.push('--disable', feature);
      }
      args.push('--disable', 'web_search_request');
    }

    if (contextGateway) {
      args.push(
        '-c',
        'mcp_servers={}',
        '-c',
        `mcp_servers.reviewrouter.command=${tomlString(contextGateway.command)}`,
        '-c',
        `mcp_servers.reviewrouter.args=${tomlStringArray(contextGateway.args)}`,
        '-c',
        `mcp_servers.reviewrouter.cwd=${tomlString(contextGateway.cwd)}`,
        '-c',
        `mcp_servers.reviewrouter.env_vars=${tomlStringArray(
          CONTEXT_GATEWAY_MCP_ENV_VARS
        )}`,
        '-c',
        'mcp_servers.reviewrouter.required=true',
        '-c',
        'mcp_servers.reviewrouter.startup_timeout_sec=45',
        '-c',
        'mcp_servers.reviewrouter.tool_timeout_sec=30',
        '-c',
        `mcp_servers.reviewrouter.enabled_tools=${tomlStringArray(
          contextGateway.enabledTools
        )}`
      );
    }

    if (options.outputSchemaFile) {
      args.push('--output-schema', options.outputSchemaFile);
    }

    if (options.eventAudit || options.jsonEvents) {
      args.push('--json');
    }

    if (config.reasoningEffort) {
      const normalized = config.reasoningEffort.trim().toLowerCase();
      if (/^[a-z]+$/.test(normalized)) {
        args.push('-c', `model_reasoning_effort="${normalized}"`);
      }
    }

    if (config.modelProvider === 'openrouter') {
      args.push(
        '-c',
        'model_provider="openrouter"',
        '-c',
        'model_providers.openrouter.name="openrouter"',
        '-c',
        'model_providers.openrouter.base_url="https://openrouter.ai/api/v1"',
        '-c',
        'model_providers.openrouter.env_key="OPENROUTER_API_KEY"'
      );
    }

    args.push('-');
    return args;
  }

  private async runCliWithStdin(
    bin: string,
    stdin: string,
    timeoutMs: number,
    options: CodexRunOptions,
    prepared?: {
      readonly argsTemplate: readonly string[];
      readonly cwd: string;
      readonly environment: Readonly<NodeJS.ProcessEnv>;
    }
  ): Promise<CodexRunResult> {
    // Write prompt to temporary file to avoid TTY check issues
    // Use restrictive permissions (0600) since prompt may contain sensitive PR diffs
    const runId = crypto.randomBytes(8).toString('hex');
    const tmpFile = path.join(os.tmpdir(), `codex-prompt-${runId}.txt`);
    const outputFile = path.join(os.tmpdir(), `codex-output-${runId}.txt`);
    const schemaFile = options.outputSchema
      ? path.join(os.tmpdir(), `codex-schema-${runId}.json`)
      : undefined;
    let fd: fs.FileHandle | undefined;
    try {
      await fs.writeFile(tmpFile, stdin, { encoding: 'utf8', mode: 0o600 });
      await fs.writeFile(outputFile, '', { encoding: 'utf8', mode: 0o600 });
      if (schemaFile) {
        await fs.writeFile(schemaFile, JSON.stringify(options.outputSchema), {
          encoding: 'utf8',
          mode: 0o600,
        });
      }

      const args = prepared
        ? prepared.argsTemplate.map((argument) =>
            argument
              .replace(CODEX_OUTPUT_FILE_PLACEHOLDER, outputFile)
              .replace(CODEX_SCHEMA_FILE_PLACEHOLDER, schemaFile ?? '')
          )
        : this.buildExecArgs({
            healthCheck: options.healthCheck,
            outputLastMessageFile: outputFile,
            outputSchemaFile: schemaFile,
            eventAudit: options.eventAudit && !options.healthCheck,
            jsonEvents: options.jsonEvents && !options.healthCheck,
            disableTools: options.disableTools,
            skipGitRepoCheck: options.skipGitRepoCheck,
          });

      // Use stdin redirection via file descriptor instead of shell
      // This avoids both "stdin is not a terminal" error and shell injection
      fd = await fs.open(tmpFile, 'r');
      const fdNum = fd.fd;

      const { stdout, stderr } = await new Promise<{
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        if (options.signal?.aborted) {
          reject(abortError());
          return;
        }
        const proc = spawn(bin, args, {
          stdio: [fdNum, 'pipe', 'pipe'],
          detached: true,
          cwd: prepared?.cwd ?? options.cwd ?? process.cwd(),
          env:
            prepared?.environment ??
            this.buildSafeEnv(options.includeWorkspaceEnv !== false),
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

        const terminate = () => {
          try {
            if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
          } catch {
            proc.kill('SIGKILL');
          }
        };
        const cleanup = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
        };
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        const onAbort = () => {
          terminate();
          fail(abortError());
        };

        const timer = setTimeout(() => {
          logger.warn(
            `Codex CLI timeout (${timeoutMs}ms), killing process and all children`
          );
          terminate();
          fail(new Error(`Codex CLI timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        options.signal?.addEventListener('abort', onAbort, { once: true });

        proc.stdout?.on('data', (chunk) => {
          stdout += chunk.toString();
        });
        proc.stderr?.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        proc.on('error', (err) => {
          fail(err);
        });
        proc.on('close', (code) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (code !== 0) {
            const message = `Codex CLI failed with exit code ${code}: ${this.formatCliError(stderr, stdout)}`;
            reject(new CodexCliExitError(code, stdout, stderr, message));
          } else {
            resolve({ stdout, stderr });
          }
        });
      }).catch(async (error) => {
        if (options.signal?.aborted) throw error;
        const lastMessage = await this.readOptionalFile(outputFile);
        if (
          options.acceptReviewOutputOnNonZero &&
          this.isUsableReviewOutput(lastMessage)
        ) {
          const exitError =
            error instanceof CodexCliExitError ? error : undefined;
          logger.warn(
            `Codex CLI exited non-zero for ${this.name} but produced valid review JSON; using --output-last-message`
          );
          return {
            stdout: exitError?.stdout || '',
            stderr: exitError?.stderr || '',
          };
        }

        throw error;
      });

      const lastMessage = await this.readOptionalFile(outputFile);
      if (options.eventAudit && !options.healthCheck) {
        this.logEventAudit(stdout);
      }

      return {
        stdout,
        stderr,
        lastMessage,
        actualModelObservation: this.inspectActualModel(stdout),
        audit:
          !options.healthCheck && (options.jsonEvents || options.eventAudit)
            ? this.buildAgenticAudit(stdout)
            : undefined,
      };
    } finally {
      // Clean up temp file and file descriptor
      try {
        if (fd) {
          await fd.close();
        }
        await fs.unlink(tmpFile);
        await fs.unlink(outputFile);
        if (schemaFile) {
          await fs.unlink(schemaFile);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  private shouldUseAgenticContext(): boolean {
    if (this.options.agenticContext !== undefined) {
      return this.options.agenticContext;
    }
    return this.parseBooleanEnv(process.env.CODEX_AGENTIC_CONTEXT, true);
  }

  private shouldUseEventAudit(): boolean {
    if (this.options.eventAudit !== undefined) {
      return this.options.eventAudit;
    }
    return this.parseBooleanEnv(process.env.CODEX_EVENT_AUDIT, false);
  }

  private agenticAuditMode(): CodexAgenticAuditMode {
    const raw = process.env.CODEX_AGENTIC_AUDIT?.trim().toLowerCase();
    if (!raw) {
      return 'rerun';
    }
    if (['0', 'false', 'no', 'off'].includes(raw)) {
      return 'off';
    }
    if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') {
      return 'rerun';
    }
    if (raw === 'rerun' || raw === 'strict') {
      return raw;
    }
    logger.warn(
      `Unknown CODEX_AGENTIC_AUDIT value "${raw}", falling back to rerun`
    );
    return 'rerun';
  }

  private parseNonEmptyReviewContent(
    content: string,
    stderr: string
  ): ParsedReviewOutput {
    if (!content) {
      throw new Error(
        `Codex CLI returned no output${stderr ? `; stderr: ${stderr.slice(0, 200)}` : ''}`
      );
    }
    return parseReviewOutputStrict(content, 'Codex CLI');
  }

  private shouldRetryForMissingAgenticExploration(
    parsed: ParsedReviewOutput,
    audit: CodexAgenticAudit | undefined,
    prompt: string,
    mode: CodexAgenticAuditMode,
    maxPromptTokens = MAX_OPTIONAL_AGENTIC_RETRY_PROMPT_TOKENS
  ): boolean {
    if (
      (mode !== 'rerun' && mode !== 'strict') ||
      !this.isMissingAgenticExploration(parsed, audit, prompt)
    ) {
      return false;
    }
    if (mode === 'strict') return true;

    const promptTokens = estimateTokensSimple(prompt).tokens;
    if (promptTokens > maxPromptTokens) {
      logger.info(
        `Skipping optional Codex agentic retry for ${this.name}: prompt is approximately ${promptTokens} tokens (limit ${maxPromptTokens})`
      );
      return false;
    }
    return true;
  }

  private isMissingAgenticExploration(
    parsed: ParsedReviewOutput,
    audit: CodexAgenticAudit | undefined,
    prompt: string
  ): boolean {
    if (!this.looksLikePullRequestReviewPrompt(prompt)) return false;
    return !audit || audit.readOnlyExplorationCommands === 0;
  }

  private looksLikePullRequestReviewPrompt(prompt: string): boolean {
    return (
      prompt.includes('Files changed:') ||
      prompt.includes('Diff:') ||
      /^diff --git a\//m.test(prompt)
    );
  }

  private buildAgenticRetryPrompt(
    prompt: string,
    audit?: CodexAgenticAudit
  ): string {
    const commands =
      audit && audit.commands.length > 0
        ? audit.commands.slice(0, 5).join(' | ')
        : 'none recorded';

    return [
      'Your previous Codex review pass completed without enough recorded read-only repository exploration.',
      `Recorded commands: ${commands}`,
      '',
      'Rerun the review from scratch.',
      'Before final JSON, inspect changed hunks and at least one related caller, test, schema, config, or helper file when available using read-only commands such as git diff, git show, rg, git grep, sed, cat, ls, find, pwd, nl, head, or tail.',
      'Changed helper/API contract regressions are reportable bugs when callers will behave incorrectly, even if the broken behavior is indirect.',
      'Specifically check for inverted boolean/filter/ignore semantics, dropped structured fields, broken draft/recovery/delete flows, stale cache/list summaries, workflow routing regressions, auth/config mistakes, and persistence side effects.',
      'If exploration proves there is no concrete bug, return exactly {"findings":[],"revalidations":[]}.',
      '',
      prompt,
    ].join('\n');
  }

  private parseBooleanEnv(
    value: string | undefined,
    defaultValue: boolean
  ): boolean {
    if (value === undefined || value === '') return defaultValue;
    return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
  }

  private observablePreparedRequest(
    request: CodexPreparedRequest
  ): CodexPreparedRequest | Readonly<Record<string, unknown>> {
    const gateway = request.contextGateway;
    const environment = this.observablePreparedEnvironment(request);
    const replacements = new Map<string, string>([
      [request.binary, '<codex-binary>'],
      [request.cwd, '<checkout-root>'],
      ...(gateway
        ? [
            [gateway.command, '<context-gateway-command>'] as const,
            [gateway.cwd, '<checkout-root>'] as const,
            ...gateway.args.map(
              (argument, index) =>
                [argument, `<context-gateway-arg-${index}>`] as const
            ),
          ]
        : []),
    ]);
    const argsTemplate = request.argsTemplate.map((argument) => {
      let normalized = argument;
      for (const [actual, replacement] of replacements) {
        if (actual.length > 0) {
          normalized = normalized.split(actual).join(replacement);
        }
      }
      return normalized;
    });

    const observableRequest = {
      ...request,
      binary: '<codex-binary>',
      cwd: '<checkout-root>',
      argsTemplate,
      environment,
    };
    if (!gateway) return observableRequest;

    return {
      ...observableRequest,
      contextGateway: {
        gatewayBinaryHash: gateway.gatewayBinaryHash,
        gatewayPolicyVersion: gateway.gatewayPolicyVersion,
        enabledTools: [...gateway.enabledTools].sort(),
        transport: 'stdio',
        confinement: 'mcp_only',
      },
    };
  }

  private observablePreparedEnvironment(
    request: CodexPreparedRequest
  ): Readonly<NodeJS.ProcessEnv> {
    const runtimeKeys = new Set(
      Object.keys(request.contextGateway?.runtimeEnvironment ?? {})
    );
    const replacements: readonly (readonly [string, string])[] = [
      ...(path.isAbsolute(request.binary)
        ? ([[path.dirname(request.binary), '<codex-binary-dir>']] as const)
        : []),
      [request.cwd, '<checkout-root>'],
      ...(request.contextGateway
        ? ([[request.contextGateway.cwd, '<checkout-root>']] as const)
        : []),
    ];
    return Object.freeze(
      Object.fromEntries(
        Object.entries(request.environment)
          .filter(
            (entry): entry is [string, string] =>
              !runtimeKeys.has(entry[0]) && entry[1] !== undefined
          )
          .map(([key, value]) => {
            if (key === 'CODEX_HOME') return [key, '<codex-home>'];
            let normalized = value;
            for (const [actual, replacement] of replacements) {
              if (actual.length > 0) {
                normalized = normalized.split(actual).join(replacement);
              }
            }
            return [key, normalized];
          })
      )
    );
  }

  private validateContextGatewayConfig(
    gateway: CodexContextGatewayInvocationConfig
  ): void {
    if (
      !path.isAbsolute(gateway.command) ||
      gateway.args.length !== 1 ||
      !path.isAbsolute(gateway.args[0]) ||
      !path.isAbsolute(gateway.cwd) ||
      !/^[a-f0-9]{64}$/u.test(gateway.gatewayBinaryHash) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(gateway.gatewayPolicyVersion)
    ) {
      throw new Error('codex_context_gateway_config_invalid');
    }
    const expectedTools = this.contextGatewayTools(
      gateway.gatewayPolicyVersion
    );
    const tools = [...gateway.enabledTools].sort();
    if (
      tools.length !== expectedTools.length ||
      tools.some((tool, index) => tool !== expectedTools[index])
    ) {
      throw new Error('codex_context_gateway_tool_policy_invalid');
    }
    for (const [key, value] of Object.entries(gateway.runtimeEnvironment)) {
      if (
        !CONTEXT_GATEWAY_RUNTIME_ENV_KEY_SET.has(key) ||
        typeof value !== 'string' ||
        value.length === 0
      ) {
        throw new Error('codex_context_gateway_environment_invalid');
      }
    }
    if (
      Object.keys(gateway.runtimeEnvironment).length !==
        CONTEXT_GATEWAY_RUNTIME_ENV_KEY_SET.size ||
      gateway.runtimeEnvironment.REVIEWROUTER_CONTEXT_GATEWAY_POLICY_VERSION !==
        gateway.gatewayPolicyVersion
    ) {
      throw new Error('codex_context_gateway_environment_incomplete');
    }
  }

  private contextGatewayTools(policyVersion: string): readonly string[] {
    switch (policyVersion) {
      case CONTEXT_GATEWAY_POLICY_VERSION:
        return [...CONTEXT_GATEWAY_V3_ENABLED_TOOLS].sort();
      case CONTEXT_GATEWAY_V4_POLICY_VERSION:
        return [...CONTEXT_GATEWAY_V4_ENABLED_TOOLS].sort();
      default:
        throw new Error('codex_context_gateway_config_invalid');
    }
  }

  private wrapContextGatewayReviewPrompt(
    prompt: string,
    enabledTools: readonly string[],
    gatewayPolicyVersion?: string
  ): string {
    return [
      'You are running as review-router inside GitHub Actions.',
      '',
      'Use the deterministic PR context below as the source of truth for review scope.',
      'For related repository context, use only these read-only ReviewRouter MCP tools:',
      ...enabledTools.map((tool) => `- ${tool}`),
      'Before returning final JSON, you MUST call at least one ReviewRouter MCP tool to inspect repository context beyond the deterministic prompt.',
      'Then inspect changed hunks and at least one directly related caller, test, schema, config, or helper when available.',
      ...(gatewayPolicyVersion === CONTEXT_GATEWAY_V4_POLICY_VERSION
        ? [
            'If any ReviewRouter MCP tool result says "truncated": true, do not produce final JSON from that partial result. Use the tool-specific continuation contract or a smaller range/maxResults/maxBytes follow-up until the inspected result is not truncated.',
            'For every review_list_directory, review_search_text, or review_canonical_inventory result with "complete": false, you MUST NOT produce final JSON. Continue the exact same operation and query inputs, changing only the cursor to the returned nextCursor, until that operation returns "complete": true. You MUST NOT abandon that cursor chain or narrow, broaden, or switch the query before it is complete.',
            'For every review_read_file result with "eof": false, you MUST NOT produce final JSON. Continue reading the same path and revision contiguously with startByte equal to the prior startByte plus byteCount until review_read_file returns "eof": true.',
          ]
        : [
            'If any ReviewRouter MCP tool result says "truncated": true or "complete": false, do not produce final JSON from that partial result. Narrow the path/query/range or use a smaller maxResults/maxBytes follow-up until the inspected result is complete and not truncated.',
          ]),
      'Do not attempt shell, browser, web, network, environment, credential, or filesystem access outside these tools.',
      'Use repository-relative paths only. Only report concrete bugs on changed lines.',
      '',
      '<deterministic_review_prompt>',
      prompt,
      '</deterministic_review_prompt>',
      '',
      ...REVIEW_OUTPUT_CONTRACT,
    ].join('\n');
  }

  private async wrapAgenticReviewPrompt(prompt: string): Promise<string> {
    const contextSeed = await this.buildRepositoryContextSeed(prompt);

    return [
      'You are running as review-router inside GitHub Actions.',
      '',
      'Use the deterministic PR context below as the source of truth for review scope.',
      contextSeed,
      contextSeed ? '' : '',
      'You may inspect related repository files before producing findings, but only with read-only shell commands such as rg, sed, cat, git diff, git show, git grep, ls, find, and pwd.',
      'Before deciding whether findings is empty or non-empty, run read-only exploration commands: inspect changed source files with git diff/sed, then use rg/git grep on imported or changed symbols to find related files.',
      'Inspect at least one directly related file when available, such as imports, called modules, schema/config files, tests, or callers.',
      '',
      'Universal context discovery checklist:',
      '- First identify the project ecosystems from changed file extensions plus nearby manifests, lockfiles, workspace files, and build config such as package.json, pnpm-workspace.yaml, tsconfig.json, pubspec.yaml, pubspec.lock, go.mod, Cargo.toml, pyproject.toml, requirements.txt, pom.xml, build.gradle, composer.json, Gemfile, Dockerfile, Makefile, and CI workflow files.',
      '- For every changed symbol or behavior, trace the nearest imports/includes/exports, dependency injection registrations, routes/controllers, schema files, generated protocol files, database migrations, ORM models, event names, feature flags, cache keys, permissions, and public API contracts before reporting a finding.',
      '- Prefer repo-local evidence: sibling implementations, previous patterns, tests, mocks, fixtures, generated clients, migration history, and direct callers/callees found with rg/git grep.',
      '- For dependencies, inspect committed lockfiles and already available read-only package source/cache directories when present. If dependency source is unavailable and repo-local evidence is not enough, treat the issue as insufficiently proven instead of guessing.',
      '- For large PRs, prioritize changed files with security, auth, persistence, migrations, concurrency, realtime/eventing, billing, external API, public contract, or data-loss impact before low-risk formatting or generated files.',
      '',
      'For CRUD, realtime, cache, or repository-state changes, explicitly compare create/update/delete side effects, broadcasts, invalidation, and listener update paths.',
      'For destructive operations such as delete/remove/archive/revoke/cancel, distinguish direct caller response handling from global side effects. A local API response that updates only the caller does not prove other open clients, subscribers, caches, workers, or projections are invalidated. If create/update paths broadcast, invalidate, enqueue, or publish but the new destructive path does not, report it when the changed line is the destructive config/call and no framework evidence proves equivalent global propagation.',
      'When a changed file uses framework APIs from a dependency, you may inspect read-only language package caches referenced by lockfiles, such as ~/.pub-cache/git, but never inspect secrets or credentials.',
      'Do not produce the final JSON until this context exploration is complete.',
      'When a finding depends on related context, cite the concrete related file evidence in the message.',
      'Use repository-relative paths only. Do not include absolute local filesystem paths in findings.',
      'Do not read environment variables, secret files, ~/.codex, git credentials, or GitHub token files.',
      'Do not run package installation, tests, builds, formatters, network commands, or commands that write files.',
      'Do not return empty findings until you inspected the changed hunks and at least one related caller, test, schema, config, or helper file when available.',
      'Only report real bugs on changed lines from the diff: crashes, data loss, security vulnerabilities, clear user-visible functional regressions such as permanent loading, stale UI state, dead-end navigation, hidden required content, or wrong access control state, or changed helper/API contract regressions that will break callers, tests, workflows, persistence, auth, configuration, MCP tools, or public/internal APIs.',
      'Changed helper contracts and semantic inversions are reportable even when the failure is indirect, if callers will behave incorrectly.',
      'Specifically check for inverted boolean/filter/ignore semantics, dropped non-string structured fields, broken draft/recovery/delete flows, stale cache/list summaries, workflow routing regressions, auth/config mistakes, and persistence side effects.',
      'A repeated local repository pattern, adjacent implementation, generated protocol/schema file, or direct dependency source counts as concrete evidence. If there is still no concrete evidence after exploration, return no finding rather than guessing.',
      '',
      '<deterministic_review_prompt>',
      prompt,
      '</deterministic_review_prompt>',
      '',
      ...REVIEW_OUTPUT_CONTRACT,
    ]
      .filter((line) => line !== undefined)
      .join('\n');
  }

  private wrapPromptOnlyReviewPrompt(prompt: string): string {
    return [
      'Use the deterministic PR context below. Do not assume access to extra context.',
      '',
      '<deterministic_review_prompt>',
      prompt,
      '</deterministic_review_prompt>',
      '',
      ...REVIEW_OUTPUT_CONTRACT,
    ].join('\n');
  }

  private buildFindingsSchema(): unknown {
    return buildReviewFindingsSchema();
  }

  private buildSafeEnv(
    includeWorkspaceEnv = true,
    frozenConfig?: Pick<CodexFrozenCliConfig, 'forkSandbox' | 'modelProvider'>
  ): NodeJS.ProcessEnv {
    const forkSandbox =
      frozenConfig?.forkSandbox ?? this.shouldUseForkSandboxCodexHomeConfig();
    const modelProvider =
      frozenConfig?.modelProvider ?? this.options.modelProvider;
    return buildCliSafeEnv({
      includeWorkspaceEnv: includeWorkspaceEnv && !forkSandbox,
      extraAllowedKeys: [
        'CODEX_HOME',
        'OPENAI_API_KEY',
        ...(modelProvider === 'openrouter' ? ['OPENROUTER_API_KEY'] : []),
      ],
    });
  }

  private shouldUseForkSandboxCodexHomeConfig(): boolean {
    return this.parseBooleanEnv(
      process.env.REVIEWROUTER_FORK_AGENTIC_SANDBOX,
      false
    );
  }

  private sanitizeReviewContent(
    content: string,
    workingDirectory = process.cwd()
  ): string {
    const cwd = workingDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return content
      .replace(new RegExp(`${cwd}/?`, 'g'), '')
      .replace(/\/home\/runner\/work\/[^/\s")]+\/[^/\s")]+\//g, '')
      .replace(/\/private\/tmp\/[^/\s")]+\//g, '');
  }

  private resolveReasoningEffort(healthCheck: boolean): string | undefined {
    return healthCheck
      ? process.env.CODEX_HEALTHCHECK_REASONING_EFFORT || 'low'
      : process.env.CODEX_REASONING_EFFORT;
  }

  private async buildRepositoryContextSeed(prompt: string): Promise<string> {
    const changedFiles = this.extractChangedFiles(prompt)
      .filter((file) => this.isContextReadableFile(file))
      .slice(0, 5);

    if (changedFiles.length === 0) {
      return '';
    }

    const snippets: string[] = [];
    const relatedFiles = new Set<string>();

    for (const file of changedFiles) {
      const content = await this.readRepoFileSnippet(file);
      if (!content) continue;

      snippets.push(this.formatContextSnippet(file, 'changed', content));
      for (const related of this.extractRelatedImportFiles(file, content)) {
        if (this.isContextReadableFile(related)) {
          relatedFiles.add(related);
        }
      }
    }

    for (const related of this.findIdentifierRelatedFiles(changedFiles)) {
      if (this.isContextReadableFile(related)) {
        relatedFiles.add(related);
      }
    }

    for (const file of [...relatedFiles]
      .filter((file) => !changedFiles.includes(file))
      .slice(0, 8)) {
      const content = await this.readRepoFileSnippet(file);
      if (content) {
        snippets.push(this.formatContextSnippet(file, 'related', content));
      }
    }

    if (snippets.length === 0) {
      return '';
    }

    return [
      'DETERMINISTIC REPOSITORY CONTEXT SEED:',
      'These snippets were read before Codex agentic exploration. Use them as evidence, but only comment on changed lines.',
      ...snippets,
      'END DETERMINISTIC REPOSITORY CONTEXT SEED',
    ].join('\n');
  }

  private extractChangedFiles(prompt: string): string[] {
    const files = new Set<string>();
    const fileListPattern =
      /^- ([^\s]+) \((?:added|modified|removed|renamed|changed)/gm;
    let match;

    while ((match = fileListPattern.exec(prompt)) !== null) {
      files.add(match[1]);
    }

    const diffPattern = /^diff --git a\/(.+?) b\/(.+?)$/gm;
    while ((match = diffPattern.exec(prompt)) !== null) {
      files.add(match[2]);
    }

    return [...files];
  }

  private isContextReadableFile(file: string): boolean {
    const normalized = this.normalizeRepoPath(file);
    if (!normalized) return false;
    const lower = normalized.toLowerCase();

    if (
      lower.includes('/.git/') ||
      lower.includes('/.codex/') ||
      lower.includes('.env') ||
      lower.includes('secret') ||
      lower.includes('credential') ||
      lower.endsWith('.pem') ||
      lower.endsWith('.key') ||
      lower.endsWith('auth.json')
    ) {
      return false;
    }

    return /\.(?:[cm]?js|jsx|tsx?|py|go|rs|java|kt|kts|dart|rb|php|cs|cpp|c|h|hpp|swift|scala|json|ya?ml|toml|sql|graphql|proto)$/i.test(
      normalized
    );
  }

  private normalizeRepoPath(file: string): string | null {
    if (!file || file.includes('\0') || path.isAbsolute(file)) {
      return null;
    }

    const normalized = path.normalize(file).replace(/\\/g, '/');
    if (
      normalized === '.' ||
      normalized.startsWith('../') ||
      normalized === '..'
    ) {
      return null;
    }

    return normalized;
  }

  private async readRepoFileSnippet(file: string): Promise<string> {
    const normalized = this.normalizeRepoPath(file);
    if (!normalized) return '';

    const repoRoot = process.cwd();
    const fullPath = path.resolve(repoRoot, normalized);
    if (!fullPath.startsWith(repoRoot + path.sep)) {
      return '';
    }

    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isFile() || stat.size > 200_000) {
        return '';
      }

      const content = await fs.readFile(fullPath, 'utf8');
      return content.split(/\r?\n/).slice(0, 220).join('\n').slice(0, 16_000);
    } catch {
      return '';
    }
  }

  private extractRelatedImportFiles(
    fromFile: string,
    content: string
  ): string[] {
    const imports = new Set<string>();
    const importPattern =
      /(?:import\s+(?:[^'"]+\s+from\s+)?|export\s+[^'"]+\s+from\s+|require\(|import\s+|export\s+)\s*['"]([^'"]+)['"]/g;
    let match;

    while ((match = importPattern.exec(content)) !== null) {
      const specifier = match[1];
      const resolved = specifier.startsWith('.')
        ? this.resolveRelativeImport(fromFile, specifier)
        : this.resolvePackageImport(specifier);
      if (resolved) imports.add(resolved);
    }

    return [...imports];
  }

  private resolveRelativeImport(
    fromFile: string,
    specifier: string
  ): string | null {
    const base = path.dirname(fromFile);
    const raw = this.normalizeRepoPath(path.join(base, specifier));
    if (!raw) return null;

    const candidates = [
      raw,
      ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'].map(
        (ext) => `${raw}${ext}`
      ),
      ...['.ts', '.tsx', '.js', '.jsx', '.json'].map((ext) =>
        path.posix.join(raw, `index${ext}`)
      ),
    ];

    for (const candidate of candidates) {
      const normalized = this.normalizeRepoPath(candidate);
      if (!normalized || !this.isContextReadableFile(normalized)) continue;
      try {
        const fullPath = path.resolve(process.cwd(), normalized);
        if (fullPath.startsWith(process.cwd() + path.sep)) {
          const stat = fsSync.statSync(fullPath);
          if (stat.isFile()) return normalized;
        }
      } catch {
        // Try next candidate.
      }
    }

    return null;
  }

  private resolvePackageImport(specifier: string): string | null {
    const match = /^package:([^/]+)\/(.+)$/.exec(specifier);
    if (!match) return null;

    const [, packageName, packagePath] = match;
    const roots = this.getWorkspacePackageRoots();
    const root =
      roots.get(packageName) || this.getDependencyPackageRoot(packageName);
    if (!root) return null;

    return this.resolveImportCandidate(path.posix.join(root, packagePath));
  }

  private getDependencyPackageRoot(packageName: string): string | null {
    if (!this.parseBooleanEnv(process.env.CODEX_DEPENDENCY_CONTEXT, true)) {
      return null;
    }

    const dependency = this.findGitDependency(packageName);
    if (!dependency) return null;

    const safePackage = packageName.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const cacheKey = crypto
      .createHash('sha1')
      .update(`${dependency.url}:${dependency.ref}:${dependency.path}`)
      .digest('hex')
      .slice(0, 10);
    const checkoutDir = path.join(
      process.cwd(),
      '.review-router-deps',
      `${safePackage}-${cacheKey}`
    );
    const root = path.posix.join(
      '.review-router-deps',
      `${safePackage}-${cacheKey}`,
      dependency.path
    );

    if (fsSync.existsSync(path.join(checkoutDir, dependency.path))) {
      return root;
    }

    if (!this.isSafeDependencyGitUrl(dependency.url)) {
      logger.debug(
        `Skipping dependency context for ${packageName}: unsupported git URL`
      );
      return null;
    }

    try {
      fsSync.mkdirSync(path.dirname(checkoutDir), { recursive: true });
      fsSync.rmSync(checkoutDir, { recursive: true, force: true });
      fsSync.mkdirSync(checkoutDir, { recursive: true });

      this.runGitForDependency(['init', '--quiet'], checkoutDir);
      this.runGitForDependency(
        ['remote', 'add', 'origin', dependency.url],
        checkoutDir
      );
      this.runGitForDependency(
        ['fetch', '--quiet', '--depth', '1', 'origin', dependency.ref],
        checkoutDir
      );
      this.runGitForDependency(
        ['checkout', '--quiet', 'FETCH_HEAD'],
        checkoutDir
      );

      if (fsSync.existsSync(path.join(checkoutDir, dependency.path))) {
        logger.info(
          `Loaded dependency context for ${packageName} from ${dependency.url}@${dependency.ref}`
        );
        return root;
      }
    } catch (error) {
      logger.debug(
        `Failed to load dependency context for ${packageName}: ${(error as Error).message}`
      );
      fsSync.rmSync(checkoutDir, { recursive: true, force: true });
    }

    return null;
  }

  private findGitDependency(packageName: string): {
    url: string;
    ref: string;
    path: string;
  } | null {
    for (const lockfile of this.findPubspecLockFiles(process.cwd(), 3)) {
      const dependency = this.parseGitDependencyFromLockfile(
        lockfile,
        packageName
      );
      if (dependency) return dependency;
    }
    return null;
  }

  private findPubspecLockFiles(root: string, maxDepth: number): string[] {
    const found: string[] = [];

    const walk = (dir: string, depth: number) => {
      if (depth > maxDepth || found.length >= 50) return;

      let entries: fsSync.Dirent[];
      try {
        entries = fsSync.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      if (
        entries.some((entry) => entry.isFile() && entry.name === 'pubspec.lock')
      ) {
        found.push(path.join(dir, 'pubspec.lock'));
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (this.shouldSkipContextDirectory(entry.name)) continue;
        walk(path.join(dir, entry.name), depth + 1);
      }
    };

    walk(root, 0);
    return found;
  }

  private parseGitDependencyFromLockfile(
    lockfile: string,
    packageName: string
  ): { url: string; ref: string; path: string } | null {
    let content = '';
    try {
      content = fsSync.readFileSync(lockfile, 'utf8');
    } catch {
      return null;
    }

    const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const blockMatch = new RegExp(
      `^  ${escapedName}:\\n([\\s\\S]*?)(?=^  [^\\s].*:\\n|(?![\\s\\S]))`,
      'm'
    ).exec(content);
    const block = blockMatch?.[1];
    if (!block || !/^\s{4}source:\s+git\s*$/m.test(block)) {
      return null;
    }

    const url = this.extractYamlScalar(block, 'url');
    const dependencyPath = this.extractYamlScalar(block, 'path');
    const ref =
      this.extractYamlScalar(block, 'resolved-ref') ||
      this.extractYamlScalar(block, 'ref');

    if (!url || !dependencyPath || !ref) return null;

    return {
      url,
      ref,
      path: dependencyPath.replace(/^\/+/, ''),
    };
  }

  private extractYamlScalar(block: string, key: string): string | null {
    const match = new RegExp(`^\\s+${key}:\\s+(.+?)\\s*$`, 'm').exec(block);
    if (!match) return null;
    return match[1].replace(/^['"]|['"]$/g, '');
  }

  private isSafeDependencyGitUrl(url: string): boolean {
    return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(
      url
    );
  }

  private runGitForDependency(args: string[], cwd: string): void {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        PATH: process.env.PATH || '',
        LANG: process.env.LANG || 'C',
        LC_ALL: process.env.LC_ALL || 'C',
        HOME: path.join(os.tmpdir(), 'review-router-git-home'),
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });

    if (result.status !== 0) {
      throw new Error(
        `git ${args[0]} failed: ${(result.stderr || result.stdout || '').slice(0, 200)}`
      );
    }
  }

  private getWorkspacePackageRoots(): Map<string, string> {
    const roots = new Map<string, string>();

    for (const pubspec of this.findPubspecFiles(process.cwd(), 3)) {
      try {
        const content = fsSync.readFileSync(pubspec, 'utf8');
        const name = /^name:\s*['"]?([^'"\s#]+)['"]?/m.exec(content)?.[1];
        if (!name) continue;

        const packageDir = path
          .relative(process.cwd(), path.dirname(pubspec))
          .replace(/\\/g, '/');
        const libDir =
          packageDir === '' ? 'lib' : path.posix.join(packageDir, 'lib');
        roots.set(name, libDir);
      } catch {
        // Ignore malformed or unreadable pubspec files.
      }
    }

    return roots;
  }

  private findPubspecFiles(root: string, maxDepth: number): string[] {
    const found: string[] = [];

    const walk = (dir: string, depth: number) => {
      if (depth > maxDepth || found.length >= 50) return;

      let entries: fsSync.Dirent[];
      try {
        entries = fsSync.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      if (
        entries.some((entry) => entry.isFile() && entry.name === 'pubspec.yaml')
      ) {
        found.push(path.join(dir, 'pubspec.yaml'));
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (this.shouldSkipContextDirectory(entry.name)) continue;
        walk(path.join(dir, entry.name), depth + 1);
      }
    };

    walk(root, 0);
    return found;
  }

  private findIdentifierRelatedFiles(changedFiles: string[]): string[] {
    const changedContents = changedFiles
      .map((file) => this.readRepoFileSync(file))
      .filter(Boolean)
      .join('\n');
    if (!changedContents) return [];

    const identifiers = this.extractContextIdentifiers(changedContents);
    if (identifiers.length === 0) return [];

    const candidates = this.findContextCandidateFiles(process.cwd(), 5);
    const changed = new Set(changedFiles);
    const scored: Array<{ file: string; score: number }> = [];

    for (const file of candidates) {
      if (changed.has(file)) continue;

      const content = this.readRepoFileSync(file);
      if (!content) continue;

      let score = 0;
      for (const identifier of identifiers) {
        if (content.includes(identifier))
          score += this.contextIdentifierWeight(identifier);
      }

      if (score > 0) {
        scored.push({ file, score });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
      .slice(0, 8)
      .map((item) => item.file);
  }

  private extractContextIdentifiers(content: string): string[] {
    const identifiers = new Set<string>();
    const importantPatterns = [
      /\b[A-Z][A-Za-z0-9_]*(?:Config|Provider|Repository|Endpoint|Widget|Dialog|Service)\b/g,
      /\bDw[A-Za-z0-9_]+\b/g,
      /\bUpdateChannels\.[A-Za-z0-9_]+\b/g,
      /\b[a-z][A-Za-z0-9_]*(?:Config|Provider|Repository|Endpoint|Channel|Model|Wrapper)\b/g,
    ];

    for (const pattern of importantPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        identifiers.add(match[0]);
      }
    }

    return [...identifiers]
      .filter((identifier) => identifier.length >= 5)
      .filter((identifier) => !this.isNoisyContextIdentifier(identifier))
      .slice(0, 40);
  }

  private contextIdentifierWeight(identifier: string): number {
    if (identifier.startsWith('Dw')) return 4;
    if (identifier.startsWith('UpdateChannels.')) return 4;
    if (/(Config|Repository|Endpoint|Wrapper)$/.test(identifier)) return 3;
    return 1;
  }

  private isNoisyContextIdentifier(identifier: string): boolean {
    return [
      'BuildContext',
      'ConsumerWidget',
      'ConsumerState',
      'ConsumerStatefulWidget',
      'TextEditingController',
      'StatefulWidget',
      'StatelessWidget',
      'Widget',
    ].includes(identifier);
  }

  private findContextCandidateFiles(root: string, maxDepth: number): string[] {
    const files: string[] = [];

    const walk = (dir: string, depth: number) => {
      if (depth > maxDepth || files.length >= 2000) return;

      let entries: fsSync.Dirent[];
      try {
        entries = fsSync.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!this.shouldSkipContextDirectory(entry.name)) {
            walk(fullPath, depth + 1);
          }
          continue;
        }

        if (!entry.isFile()) continue;

        const relative = path.relative(root, fullPath).replace(/\\/g, '/');
        if (!this.isContextReadableFile(relative)) continue;

        try {
          const stat = fsSync.statSync(fullPath);
          if (stat.size <= 200_000) files.push(relative);
        } catch {
          // Ignore files that disappear during traversal.
        }
      }
    };

    walk(root, 0);
    return files;
  }

  private shouldSkipContextDirectory(name: string): boolean {
    return [
      '.git',
      '.codex',
      '.dart_tool',
      'node_modules',
      'build',
      'dist',
      'coverage',
      '.next',
      '.turbo',
    ].includes(name);
  }

  private readRepoFileSync(file: string): string {
    const normalized = this.normalizeRepoPath(file);
    if (!normalized) return '';

    const repoRoot = process.cwd();
    const fullPath = path.resolve(repoRoot, normalized);
    if (!fullPath.startsWith(repoRoot + path.sep)) return '';

    try {
      const stat = fsSync.statSync(fullPath);
      if (!stat.isFile() || stat.size > 200_000) return '';
      return fsSync.readFileSync(fullPath, 'utf8');
    } catch {
      return '';
    }
  }

  private resolveImportCandidate(raw: string): string | null {
    const candidates = [
      raw,
      ...['.dart', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'].map(
        (ext) => `${raw}${ext}`
      ),
      ...['.dart', '.ts', '.tsx', '.js', '.jsx', '.json'].map((ext) =>
        path.posix.join(raw, `index${ext}`)
      ),
    ];

    for (const candidate of candidates) {
      const normalized = this.normalizeRepoPath(candidate);
      if (!normalized || !this.isContextReadableFile(normalized)) continue;
      try {
        const fullPath = path.resolve(process.cwd(), normalized);
        if (fullPath.startsWith(process.cwd() + path.sep)) {
          const stat = fsSync.statSync(fullPath);
          if (stat.isFile()) return normalized;
        }
      } catch {
        // Try next candidate.
      }
    }

    return null;
  }

  private isUsableReviewOutput(content: string): boolean {
    const trimmed = content.trim();
    if (!trimmed) return false;

    try {
      const parsed = parseReviewOutputStrict(
        this.sanitizeReviewContent(trimmed),
        'Codex CLI'
      );
      return !parsed.findings.some((finding) =>
        this.isPlaceholderFinding(finding)
      );
    } catch {
      return false;
    }
  }

  private assertNoPlaceholderFindings(findings: Finding[]): void {
    if (findings.some((finding) => this.isPlaceholderFinding(finding))) {
      throw new Error('Codex CLI returned placeholder review JSON');
    }
  }

  private isPlaceholderFinding(finding: Finding): boolean {
    return (
      finding.file === 'path' ||
      finding.title === 'short' ||
      finding.message.trim().toLowerCase() === 'specific evidence'
    );
  }

  private formatContextSnippet(
    file: string,
    role: 'changed' | 'related',
    content: string
  ): string {
    return [
      `<context-file path="${file}" role="${role}">`,
      content,
      '</context-file>',
    ].join('\n');
  }

  private async readOptionalFile(file: string): Promise<string> {
    try {
      return await fs.readFile(file, 'utf8');
    } catch {
      return '';
    }
  }

  private logEventAudit(stdout: string): void {
    const audit = this.extractEventAudit(stdout);
    if (audit.commandCount === 0) {
      logger.info('Codex event audit: no shell commands recorded');
      return;
    }

    const commands =
      audit.commandNames.length > 0 ? audit.commandNames.join(', ') : 'unknown';
    const files = audit.fileCount > 0 ? `, files=${audit.fileCount}` : '';
    logger.info(
      `Codex event audit: commands=${audit.commandCount}, commandNames=${commands}${files}`
    );
  }

  private inspectActualModel(stdout: string): CodexActualModelObservation {
    const models = new Set<string>();
    for (const line of stdout.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        this.collectSessionConfiguredModels(JSON.parse(line), models, 0);
      } catch {
        // Ignore non-JSON progress lines.
      }
    }
    if (models.size === 0) {
      return Object.freeze({ kind: CodexActualModelObservationKind.Missing });
    }
    if (models.size === 1) {
      return Object.freeze({
        kind: CodexActualModelObservationKind.Observed,
        model: [...models][0],
      });
    }
    return Object.freeze({ kind: CodexActualModelObservationKind.Ambiguous });
  }

  private resolveEffectiveActualModel(
    observation: CodexActualModelObservation,
    requestedModel: string
  ): string | undefined {
    if (observation.kind === CodexActualModelObservationKind.Observed) {
      return observation.model;
    }
    if (observation.kind === CodexActualModelObservationKind.Ambiguous) {
      return undefined;
    }

    // Native Codex receives an explicit --model and has no downstream router
    // in this provider contract, so the pin is authoritative when JSONL omits it.
    return this.options.modelProvider === 'openrouter'
      ? undefined
      : requestedModel;
  }

  private collectSessionConfiguredModels(
    value: unknown,
    models: Set<string>,
    depth: number
  ): void {
    if (!value || typeof value !== 'object' || depth > 5) return;
    const event = value as Record<string, unknown>;
    const type = event.type ?? event.event ?? event.kind;
    if (type === 'session_configured') {
      const model = this.findConfiguredModel(event);
      if (model) models.add(model);
    }
    for (const nested of Object.values(event)) {
      if (nested && typeof nested === 'object') {
        this.collectSessionConfiguredModels(nested, models, depth + 1);
      }
    }
  }

  private findConfiguredModel(
    event: Readonly<Record<string, unknown>>
  ): string | undefined {
    for (const candidate of [
      event.model,
      isRecord(event.payload) ? event.payload.model : undefined,
      isRecord(event.data) ? event.data.model : undefined,
      isRecord(event.session) ? event.session.model : undefined,
    ]) {
      if (
        typeof candidate === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._:/+#-]{0,199}$/u.test(candidate)
      ) {
        return candidate;
      }
    }
    return undefined;
  }

  private logAgenticAudit(audit: CodexAgenticAudit, retry: boolean): void {
    const suffix = retry ? ' after retry' : '';
    const preview =
      audit.commands.length > 0
        ? `, commands=${audit.commands.slice(0, 3).join(', ')}`
        : '';
    logger.info(
      `Codex agentic audit${suffix}: commandExecutions=${audit.commandExecutions}, readOnlyExplorationCommands=${audit.readOnlyExplorationCommands}${preview}`
    );
  }

  private buildAgenticAudit(stdout: string): CodexAgenticAudit {
    const commands: string[] = [];
    let commandExecutions = 0;
    let readOnlyExplorationCommands = 0;

    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line);
        const command = this.extractCommandFromCodexEvent(event);
        if (!command) continue;

        commandExecutions += 1;
        if (commands.length < 20) {
          commands.push(command);
        }
        if (this.isReadOnlyExplorationCommand(command)) {
          readOnlyExplorationCommands += 1;
        }
      } catch {
        // Ignore non-JSON progress lines.
      }
    }

    return {
      commandExecutions,
      readOnlyExplorationCommands,
      commands,
    };
  }

  private extractCommandFromCodexEvent(value: unknown): string | null {
    return this.extractCommandFromCodexEventInner(value, 0);
  }

  private extractCommandFromCodexEventInner(
    value: unknown,
    depth: number
  ): string | null {
    if (!value || typeof value !== 'object' || depth > 4) {
      return null;
    }

    const event = value as Record<string, unknown>;
    const command =
      typeof event.command === 'string'
        ? event.command
        : typeof event.cmd === 'string'
          ? event.cmd
          : undefined;
    const type = String(event.type || event.event || event.kind || '');
    if (
      command &&
      /(command|shell|exec|unified).*?(execution|call|tool)|tool.*?(command|shell|exec)/i.test(
        type
      )
    ) {
      return command;
    }

    for (const key of [
      'item',
      'message',
      'payload',
      'data',
      'event',
      'tool_call',
      'call',
      'arguments',
    ]) {
      const nested = this.extractCommandFromCodexEventInner(
        event[key],
        depth + 1
      );
      if (nested) return nested;
    }

    return null;
  }

  private isReadOnlyExplorationCommand(command: string): boolean {
    const commandName = this.extractCommandName(command);
    if (!commandName) return false;

    const base = path.basename(commandName).toLowerCase();
    if (
      [
        'rg',
        'grep',
        'git',
        'sed',
        'cat',
        'ls',
        'find',
        'pwd',
        'nl',
        'head',
        'tail',
        'wc',
        'awk',
        'jq',
        'sort',
        'uniq',
      ].includes(base)
    ) {
      if (base === 'git') {
        return this.isReadOnlyGitCommand(command);
      }
      return !this.commandContainsWriteRedirection(command);
    }

    return false;
  }

  private isReadOnlyGitCommand(command: string): boolean {
    const normalized = command.replace(/\s+/g, ' ').trim();
    return /(?:^|\s)git\s+(?:diff|show|grep|log|status|ls-files|ls-tree|cat-file|rev-parse|merge-base|branch|describe|name-rev)\b/.test(
      normalized
    );
  }

  private commandContainsWriteRedirection(command: string): boolean {
    return /(^|[^<])>{1,2}|\b(?:tee|xargs|rm|mv|cp|touch|mkdir|chmod|chown|npm|pnpm|yarn|bun|pip|go|cargo|flutter|dart|make)\b/.test(
      command
    );
  }

  private extractEventAudit(stdout: string): {
    commandCount: number;
    commandNames: string[];
    fileCount: number;
  } {
    const commandNames = new Set<string>();
    const files = new Set<string>();
    let commandCount = 0;

    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line);
        const item = event?.item;
        if (
          item?.type !== 'command_execution' ||
          typeof item.command !== 'string'
        ) {
          continue;
        }

        commandCount += 1;
        const commandName = this.extractCommandName(item.command);
        if (commandName) commandNames.add(commandName);
        for (const file of this.extractLikelyFilePaths(item.command)) {
          files.add(file);
        }
      } catch {
        // Ignore non-JSON progress lines.
      }
    }

    return {
      commandCount,
      commandNames: [...commandNames].sort(),
      fileCount: files.size,
    };
  }

  private extractCommandName(command: string): string | null {
    const shellMatch = command.match(
      /(?:^|\s)(?:\/[^\s]+\/)?(?:bash|zsh|sh)\s+-lc\s+["']?([^"']+)/
    );
    const normalized = shellMatch?.[1] || command;
    const match = normalized.trim().match(/^([A-Za-z0-9_.-]+)/);
    return match?.[1] || null;
  }

  private extractLikelyFilePaths(command: string): string[] {
    const matches = command.matchAll(
      /(?:^|[\s"'`])((?:\.{0,2}\/)?[A-Za-z0-9_@./:+-]+\.(?:[cm]?js|tsx?|jsx|py|go|rs|java|kt|kts|dart|rb|php|cs|cpp|c|h|hpp|swift|scala|json|ya?ml|toml|md|sh|sql|graphql|proto))(?:$|[\s"'`])/g
    );
    return [...matches].map((match) => match[1]).filter(Boolean);
  }

  private formatCliError(stderr: string, stdout: string): string {
    const input = [stderr, stdout].filter(Boolean).join('\n') || 'no output';
    const jsonMessages = this.extractCliErrorMessages(input)
      .map((message) => this.sanitizeCliErrorText(message))
      .map((message) => message.trim())
      .filter(Boolean)
      .filter((message) => !this.isPlaceholderCliDiagnostic(message));
    if (jsonMessages.length > 0) {
      return this.truncateCliError([...new Set(jsonMessages)].join(' '));
    }

    const raw = this.sanitizeCliErrorText(input);
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => {
        const nestedDiagnostics = this.extractCliErrorMessages(line);
        return (
          nestedDiagnostics.length === 0 ||
          nestedDiagnostics.some(
            (message) => !this.isPlaceholderCliDiagnostic(message)
          )
        );
      })
      .filter(
        (line) =>
          !line.startsWith('user') && !line.includes('Respond with exactly:')
      );

    const important = lines.filter((line) =>
      /not supported|invalid_request_error|auth|error|failed|timed out|timeout|capacity|limit|quota/i.test(
        line
      )
    );
    const summary = (important.length > 0 ? important : lines).join(' ');

    return this.truncateCliError(summary);
  }

  private isPlaceholderCliDiagnostic(message: string): boolean {
    return /^(?:\.\.\.\s*)?(?:warning\s+)?specific evidence$/i.test(
      message.trim()
    );
  }

  private sanitizeCliErrorText(value: string): string {
    return redactSensitiveText(value)
      .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
      .replace(
        /www_authenticate_header:\s*"[^"]+"/gi,
        'www_authenticate_header: "[redacted]"'
      )
      .replace(/authorization_uri="[^"]+"/gi, 'authorization_uri="[redacted]"')
      .replace(
        /authorization_uri=\\?"[^"\\]*(?:\\.[^"\\]*)*\\?"/gi,
        'authorization_uri="[redacted]"'
      )
      .replace(/https?:\/\/[^\s",)]+/gi, '[redacted-url]')
      .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[redacted-openai-key]')
      .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '[redacted-github-token]')
      .replace(/github_pat_[A-Za-z0-9_]+/g, '[redacted-github-token]')
      .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"[redacted]"')
      .replace(
        /"refresh_token"\s*:\s*"[^"]+"/gi,
        '"refresh_token":"[redacted]"'
      )
      .replace(/session id:\s*[a-f0-9-]+/gi, 'session id: [redacted]')
      .replace(/thread\s+[a-f0-9-]{8,}/gi, 'thread [redacted]');
  }

  private extractCliErrorMessages(raw: string): string[] {
    const messages: string[] = [];
    const seen = new Set<string>();

    const visit = (value: unknown, depth: number): void => {
      if (depth > 4 || value === null || value === undefined) return;

      if (typeof value === 'string') {
        const text = value.trim();
        if (!text || seen.has(text)) return;
        seen.add(text);

        if (
          (text.startsWith('{') && text.endsWith('}')) ||
          (text.startsWith('[') && text.endsWith(']'))
        ) {
          try {
            visit(JSON.parse(text), depth + 1);
            return;
          } catch {
            // Keep the original text when a provider emits malformed JSON.
          }
        }

        const nestedValues = this.extractJsonStringFields(text);
        if (nestedValues.length > 0) {
          nestedValues.forEach((nested) => visit(nested, depth + 1));
          return;
        }

        messages.push(text);
        return;
      }

      if (Array.isArray(value)) {
        value.forEach((item) => visit(item, depth + 1));
        return;
      }

      if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        for (const key of [
          'message',
          'error',
          'detail',
          'error_description',
          'code',
          'status',
        ]) {
          if (key in record) visit(record[key], depth + 1);
        }
      }
    };

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))
      ) {
        try {
          visit(JSON.parse(trimmed), 0);
        } catch {
          // The field scanner below still handles JSON embedded in log text.
        }
      }
    }

    this.extractJsonStringFields(raw).forEach((value) => visit(value, 0));
    return messages;
  }

  private extractJsonStringFields(raw: string): string[] {
    const fields =
      /"(?:message|error|detail|error_description|code|status)"\s*:\s*("(?:\\.|[^"\\])*")/gi;
    const values: string[] = [];

    for (const match of raw.matchAll(fields)) {
      try {
        const decoded = JSON.parse(match[1]);
        if (typeof decoded === 'string') values.push(decoded);
      } catch {
        // Ignore malformed string fields and use the sanitized raw fallback.
      }
    }

    return values;
  }

  private truncateCliError(message: string): string {
    if (message.length <= 800) return message;

    // Codex JSON error events can echo the entire request before appending the
    // actionable provider diagnostic. Keeping only the prefix both exposes
    // prompt content and discards errors such as usage-limit or auth failures.
    // Preserve the bounded suffix where CLI diagnostics are emitted instead.
    return `[leading output truncated] ...${message.slice(-768)}`;
  }

  private normalizeCodexError(error: unknown): Error {
    const err = error instanceof Error ? error : new Error(String(error));
    const detail =
      err instanceof CodexCliExitError
        ? this.formatCliError(err.stderr, err.stdout)
        : this.formatCliError(err.message, '');
    const rawMessage = this.truncateCliError(
      this.sanitizeReviewContent(
        err instanceof CodexCliExitError
          ? `Codex CLI failed with exit code ${err.code}: ${detail}`
          : detail
      )
    );
    const message = this.withActionableAuthHint(rawMessage);
    const normalized = this.isCapacityUnavailable(message)
      ? new RateLimitError(message || 'Codex capacity unavailable')
      : new Error(message || 'Codex CLI failed');
    if (!(normalized instanceof RateLimitError)) {
      normalized.name = err.name || 'CodexProviderError';
    }
    normalized.stack = err.stack;
    return normalized;
  }

  private isCapacityUnavailable(message: string): boolean {
    return /(?:\b429\b|\btoo many requests\b|\bcapacity[\s_-]*unavailable\b|\brate[\s_-]*limit(?:ed|ing)?\b|\busage[\s_-]*limit(?:ed|[\s_-]*(?:reached|exceeded|exhausted))?\b|\bquota(?:[\s_-]*(?:exceeded|exhausted|unavailable|limited))?\b|\binsufficient[\s_-]*quota\b|\bresource[\s_-]*exhausted\b)/i.test(
      message
    );
  }

  private withActionableAuthHint(message: string): string {
    if (!message) return message;
    if (
      !/(401|unauthorized|access token|refresh token|auth|login)/i.test(message)
    ) {
      return message;
    }

    const hint =
      'Codex authentication failed. If using ChatGPT subscription OAuth, reseed auth.json by running `codex login` on a trusted machine and updating CODEX_AUTH_JSON. If using API-key mode, verify OPENAI_API_KEY.';

    return message.includes('reseed auth.json')
      ? message
      : this.truncateCliError(`${message} ${hint}`);
  }

  private async resolveBinary(): Promise<string> {
    if (
      CodexProvider.preparedBinaryPath &&
      (await this.canRun(CodexProvider.preparedBinaryPath, ['--version']))
    ) {
      return CodexProvider.preparedBinaryPath;
    }
    const explicitBinary = process.env.REVIEWROUTER_CODEX_BINARY?.trim();
    if (explicitBinary) {
      if (await this.canRun(explicitBinary, ['--version'])) {
        return explicitBinary;
      }
      throw new Error(
        'Codex CLI is not available at REVIEWROUTER_CODEX_BINARY'
      );
    }
    // Try codex command directly
    if (await this.canRun('codex', ['--version'])) {
      return 'codex';
    }
    // Try codex-cli
    if (await this.canRun('codex-cli', ['--version'])) {
      return 'codex-cli';
    }
    const preparedBinary = await this.findPreparedRotatingCodexBinary();
    if (preparedBinary && (await this.canRun(preparedBinary, ['--version']))) {
      CodexProvider.preparedBinaryPath = preparedBinary;
      return preparedBinary;
    }
    const installedBinary = await this.installPinnedCodexCli();
    CodexProvider.preparedBinaryPath = installedBinary;
    return installedBinary;
  }

  private async findPreparedRotatingCodexBinary(): Promise<string | undefined> {
    try {
      const entries = await fs.readdir(os.tmpdir(), { withFileTypes: true });
      const candidates: Array<{ path: string; mtimeMs: number }> = [];
      for (const entry of entries) {
        if (
          !entry.isDirectory() ||
          !entry.name.startsWith('reviewrouter-codex-cli-')
        ) {
          continue;
        }
        const candidate = path.join(
          os.tmpdir(),
          entry.name,
          'node_modules',
          '.bin',
          'codex'
        );
        try {
          const stat = await fs.stat(candidate);
          if (stat.isFile() || stat.isSymbolicLink()) {
            candidates.push({ path: candidate, mtimeMs: stat.mtimeMs });
          }
        } catch {
          // Ignore incomplete or already-cleaned install roots.
        }
      }
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return candidates[0]?.path;
    } catch {
      return undefined;
    }
  }

  private async canRun(cmd: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(cmd, args, {
        cwd: os.tmpdir(),
        env: {
          PATH: process.env.PATH || '',
          HOME: process.env.HOME || os.tmpdir(),
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
        stdio: 'ignore',
      });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
  }

  private async installPinnedCodexCli(): Promise<string> {
    const prepared = await prepareCodexCliBeforeAuthRead({
      logger: {
        info: (message) => logger.info(message),
        warn: (message) => logger.warn(message),
      },
    });
    return prepared.binaryPath;
  }

  private extractFindings(content: string): Finding[] {
    try {
      return this.parseFindingsStrict(content);
    } catch (error) {
      logger.debug(
        'Failed to parse findings from Codex response',
        error as Error
      );
    }
    return [];
  }

  private parseFindingsStrict(content: string): Finding[] {
    return parseReviewFindingsStrict(content, 'Codex CLI');
  }
}

function abortError(): Error {
  const error = new Error('Codex CLI aborted');
  error.name = 'AbortError';
  return error;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(',')}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
