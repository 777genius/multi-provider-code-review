import { createHash } from 'crypto';
import path from 'path';
import {
  ReviewAgentExecutionError,
  ReviewAgentFailureClass,
} from '../application/review-agent-port';
import type { ReviewTurnUsage } from '../domain/turn-observation';

export const CODEX_APP_SERVER_VERSION = '0.145.0';
export const CODEX_APP_SERVER_MCP_NAME = 'reviewrouter';

export type CodexAppServerReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export type CodexAppServerProtocolRequest = Readonly<{
  cwd: string;
  prompt: string;
  clientTurnId: string;
  requestedModel: string;
  reasoningEffort: CodexAppServerReasoningEffort;
  outputSchema: Readonly<Record<string, unknown>>;
  allowedTools: readonly string[];
  maxOutputBytes: number;
}>;

export type CodexAppServerProtocolResult = Readonly<{
  finalMessage: string;
  actualModel: string;
  modelProvider: string;
  usage: ReviewTurnUsage;
}>;

export type CodexAppServerProtocolWriter = (
  message: Readonly<Record<string, unknown>>
) => Promise<void>;

type PendingRequest = Readonly<{
  deferred: Deferred<unknown>;
}>;

type RawTokenUsage = Readonly<{
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}>;

type ActiveItem = Readonly<{
  type: string;
  server?: string;
  tool?: string;
}>;

type ParsedTurnError = Readonly<{
  failure: ReviewAgentExecutionError;
  fingerprint: string;
}>;

const OPTED_OUT_NOTIFICATIONS = Object.freeze([
  'thread/status/changed',
  'thread/settings/updated',
  'thread/name/updated',
  'turn/plan/updated',
  'rawResponseItem/completed',
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'item/mcpToolCall/progress',
  'serverRequest/resolved',
  'account/updated',
  'account/rateLimits/updated',
  'app/list/updated',
  'remoteControl/status/changed',
  'deprecationNotice',
]);

const IGNORED_NOTIFICATION_METHODS = new Set(OPTED_OUT_NOTIFICATIONS);

const ALLOWED_ITEM_TYPES = new Set([
  'userMessage',
  'agentMessage',
  'reasoning',
  'mcpToolCall',
  'contextCompaction',
]);

const FORBIDDEN_ITEM_TYPES = new Set([
  'hookPrompt',
  'plan',
  'commandExecution',
  'fileChange',
  'dynamicToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'webSearch',
  'imageView',
  'sleep',
  'imageGeneration',
  'enteredReviewMode',
  'exitedReviewMode',
]);

const CODEX_ERROR_INFO_STRING_VARIANTS = new Set([
  'contextWindowExceeded',
  'sessionBudgetExceeded',
  'usageLimitExceeded',
  'serverOverloaded',
  'cyberPolicy',
  'internalServerError',
  'unauthorized',
  'badRequest',
  'threadRollbackFailed',
  'sandboxError',
  'other',
]);

const CODEX_ERROR_INFO_HTTP_VARIANTS = new Set([
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
]);

const MAX_METADATA_JSON_BYTES = 32_768;
const MAX_METADATA_JSON_DEPTH = 16;
const MAX_METADATA_JSON_NODES = 2_048;
const MAX_METADATA_COLLECTION_SIZE = 256;
const MAX_METADATA_STRING_BYTES = 16_384;
const MAX_NOTIFICATION_STRING_ARRAY_SIZE = 64;
const MAX_NOTIFICATION_STRING_BYTES = 1_024;
const MAX_WARNING_MESSAGE_BYTES = 16_384;

export class CodexAppServerProtocolClient {
  private readonly completion = deferred<CodexAppServerProtocolResult>();
  private readonly threadStartedSignal = deferred<void>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly activeItems = new Map<string, ActiveItem>();
  private readonly completedItems = new Map<string, ActiveItem>();
  private readonly rawUsageByResponseId = new Map<string, RawTokenUsage>();
  private readonly allowedTools: ReadonlySet<string>;
  private nextRequestId = 1;
  private failed = false;
  private initialized = false;
  private threadId: string | null = null;
  private provisionalThreadId: string | null = null;
  private turnId: string | null = null;
  private provisionalTurnId: string | null = null;
  private threadStarted = false;
  private turnStarted = false;
  private turnCompleted = false;
  private actualModel: string | null = null;
  private modelProvider: string | null = null;
  private readonly finalMessageCandidates: Array<{
    readonly phase: 'final_answer' | null;
    readonly text: string;
  }> = [];
  private aggregateUsage: RawTokenUsage | null = null;
  private lastAggregateUsage: RawTokenUsage | null = null;
  private completionResolved = false;
  private postCompletionFailure: ReviewAgentExecutionError | null = null;
  private terminalFailure: ReviewAgentExecutionError | null = null;
  private retainedTerminalError: ParsedTurnError | null = null;

  constructor(
    private readonly request: CodexAppServerProtocolRequest,
    private readonly write: CodexAppServerProtocolWriter
  ) {
    this.allowedTools = new Set(request.allowedTools);
    void this.completion.promise.catch(() => undefined);
    void this.threadStartedSignal.promise.catch(() => undefined);
  }

  async run(): Promise<CodexAppServerProtocolResult> {
    await withProtocolRunStage(
      CodexProtocolDiagnosticStage.InitializeResponse,
      () =>
        this.sendRequest('initialize', {
          clientInfo: {
            name: 'review_router_action',
            title: 'ReviewRouter Action',
            version: '1',
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            mcpServerOpenaiFormElicitation: false,
            optOutNotificationMethods: OPTED_OUT_NOTIFICATIONS,
          },
        }).then((value) => {
          validateInitializeResponse(value);
          return value;
        })
    );
    this.initialized = true;
    await withProtocolRunStage(
      CodexProtocolDiagnosticStage.InitializedNotification,
      () => this.sendNotification('initialized')
    );

    await withProtocolRunStage(
      CodexProtocolDiagnosticStage.ThreadStartResponse,
      () =>
        this.sendRequest('thread/start', {
          model: this.request.requestedModel,
          allowProviderModelFallback: false,
          cwd: this.request.cwd,
          runtimeWorkspaceRoots: [],
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          sandbox: 'read-only',
          config: {
            model_reasoning_effort: this.request.reasoningEffort,
          },
          ephemeral: true,
          environments: [],
          dynamicTools: [],
          selectedCapabilityRoots: [],
          experimentalRawEvents: true,
        }).then((value) => this.bindThread(value))
    );
    await withProtocolRunStage(
      CodexProtocolDiagnosticStage.ThreadStartedWait,
      () => this.threadStartedSignal.promise
    );

    await withProtocolRunStage(
      CodexProtocolDiagnosticStage.TurnStartResponse,
      () =>
        this.sendRequest('turn/start', {
          threadId: this.threadId,
          clientUserMessageId: this.request.clientTurnId,
          input: [
            {
              type: 'text',
              text: this.request.prompt,
              text_elements: [],
            },
          ],
          environments: [],
          runtimeWorkspaceRoots: [],
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          sandboxPolicy: {
            type: 'readOnly',
            networkAccess: false,
          },
          effort: this.request.reasoningEffort,
          outputSchema: this.request.outputSchema,
        }).then((value) => this.bindTurn(value))
    );
    this.maybeComplete();
    return withProtocolRunStage(
      CodexProtocolDiagnosticStage.Completion,
      () => this.completion.promise
    );
  }

  receive(value: unknown): void {
    if (this.failed) return;
    let diagnosticStage: CodexProtocolDiagnosticStageValue =
      CodexProtocolDiagnosticStage.Envelope;
    try {
      const message = requireRecord(value, 'protocol_message');
      const hasMethod = Object.prototype.hasOwnProperty.call(message, 'method');
      const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
      if (hasMethod && hasId) {
        throw confinementFailure();
      }
      if (hasId) {
        diagnosticStage = CodexProtocolDiagnosticStage.Response;
        this.receiveResponse(message);
        return;
      }
      if (hasMethod) {
        diagnosticStage = notificationDiagnosticStage(message.method);
        this.receiveNotification(message);
        return;
      }
      throw streamFailure();
    } catch (error) {
      this.fail(withStreamDiagnosticStage(error, diagnosticStage));
    }
  }

  fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    const failure = normalizeProtocolFailure(error);
    this.terminalFailure = failure;
    if (this.completionResolved) {
      this.postCompletionFailure = failure;
    }
    for (const pending of this.pending.values()) {
      pending.deferred.reject(failure);
    }
    this.pending.clear();
    this.threadStartedSignal.reject(failure);
    this.completion.reject(failure);
  }

  end(): void {
    if (!this.failed && !this.turnCompleted) {
      this.fail(streamFailure(CodexProtocolDiagnosticStage.ProcessEnd));
    }
  }

  failureAfterCompletion(): ReviewAgentExecutionError | null {
    return this.postCompletionFailure;
  }

  canInterrupt(): boolean {
    return this.threadId !== null && this.turnId !== null;
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.turnId || this.failed) return;
    await this.sendRequest('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.turnId,
    });
  }

  private async sendRequest(
    method: string,
    params: Readonly<Record<string, unknown>>
  ): Promise<unknown> {
    if (this.failed) throw this.terminalFailure ?? streamFailure();
    const id = this.nextRequestId++;
    const response = deferred<unknown>();
    this.pending.set(requestIdKey(id), { deferred: response });
    try {
      await this.write({ method, id, params });
    } catch {
      this.pending.delete(requestIdKey(id));
      throw processFailure();
    }
    return response.promise;
  }

  private async sendNotification(method: string): Promise<void> {
    if (this.failed) throw this.terminalFailure ?? streamFailure();
    try {
      await this.write({ method });
    } catch (error) {
      if (this.failed) throw this.terminalFailure ?? streamFailure();
      throw error;
    }
    if (this.failed) throw this.terminalFailure ?? streamFailure();
  }

  private receiveResponse(message: Record<string, unknown>): void {
    const hasResult = Object.prototype.hasOwnProperty.call(message, 'result');
    const hasError = Object.prototype.hasOwnProperty.call(message, 'error');
    if (
      hasResult === hasError ||
      Object.prototype.hasOwnProperty.call(message, 'method') ||
      Object.prototype.hasOwnProperty.call(message, 'params') ||
      !hasOnlyKeys(message, hasResult ? ['id', 'result'] : ['error', 'id'])
    ) {
      throw streamFailure();
    }
    const id = requireRequestId(message.id);
    const pending = this.pending.get(requestIdKey(id));
    if (!pending) throw streamFailure();
    this.pending.delete(requestIdKey(id));
    if (hasError) {
      pending.deferred.reject(responseFailure(message.error));
      return;
    }
    pending.deferred.resolve(message.result);
  }

  private receiveNotification(message: Record<string, unknown>): void {
    if (
      !hasRequiredAndOptionalKeys(
        message,
        ['method', 'params'],
        ['emittedAtMs']
      ) ||
      (message.emittedAtMs !== undefined &&
        (!Number.isSafeInteger(message.emittedAtMs) ||
          (message.emittedAtMs as number) < 0))
    ) {
      throw streamFailure();
    }
    const method = requireNonEmptyString(message.method, 'notification_method');
    const params = requireRecord(message.params, 'notification_params');
    switch (method) {
      case 'thread/started':
        this.onThreadStarted(params);
        return;
      case 'thread/name/updated':
        this.onThreadNameUpdated(params);
        return;
      case 'mcpServer/startupStatus/updated':
        this.onMcpServerStatus(params);
        return;
      case 'serverRequest/resolved':
        this.onServerRequestResolved(params);
        return;
      case 'turn/started':
        this.onTurnStarted(params);
        return;
      case 'item/started':
        this.onItemStarted(params);
        return;
      case 'item/completed':
        this.onItemCompleted(params);
        return;
      case 'rawResponse/completed':
        this.onRawResponseCompleted(params);
        return;
      case 'thread/tokenUsage/updated':
        this.onTokenUsageUpdated(params);
        return;
      case 'turn/completed':
        this.onTurnCompleted(params);
        return;
      case 'model/rerouted':
        this.assertTurnFence(params);
        throw modelFailure();
      case 'model/verification':
        this.onModelVerification(params);
        return;
      case 'turn/moderationMetadata':
        this.onTurnModerationMetadata(params);
        return;
      case 'model/safetyBuffering/updated':
        this.onModelSafetyBufferingUpdated(params);
        return;
      case 'warning':
        this.onWarning(params);
        return;
      case 'error':
        this.onErrorNotification(params);
        return;
      default:
        if (IGNORED_NOTIFICATION_METHODS.has(method)) return;
        throw streamFailure();
    }
  }

  private bindThread(value: unknown): void {
    const response = requireRecord(value, 'thread_start_response');
    const thread = requireRecord(response.thread, 'thread');
    const threadId = requireIdentifier(thread.id, 'thread_id');
    const actualModel = requireModel(response.model);
    const responseModelProvider = requireModelProvider(response.modelProvider);
    const threadModelProvider = requireModelProvider(thread.modelProvider);
    if (
      responseModelProvider !== threadModelProvider ||
      thread.ephemeral !== true ||
      thread.path !== null ||
      thread.cliVersion !== CODEX_APP_SERVER_VERSION ||
      response.cwd !== this.request.cwd ||
      thread.cwd !== this.request.cwd ||
      response.approvalPolicy !== 'never' ||
      response.approvalsReviewer !== 'user' ||
      !isReadOnlySandbox(response.sandbox) ||
      response.reasoningEffort !== this.request.reasoningEffort ||
      !Array.isArray(response.instructionSources) ||
      response.instructionSources.length !== 0 ||
      !Array.isArray(thread.turns) ||
      thread.turns.length !== 0 ||
      (this.provisionalThreadId !== null &&
        this.provisionalThreadId !== threadId)
    ) {
      throw confinementFailure();
    }
    this.threadId = threadId;
    this.provisionalThreadId = threadId;
    this.actualModel = actualModel;
    this.modelProvider = responseModelProvider;
  }

  private bindTurn(value: unknown): void {
    if (!this.threadId) throw streamFailure();
    const response = requireRecord(value, 'turn_start_response');
    const turn = requireRecord(response.turn, 'turn');
    const turnId = requireIdentifier(turn.id, 'turn_id');
    if (
      turn.status !== 'inProgress' ||
      !hasAbsentOrNullProperty(turn, 'error') ||
      !Array.isArray(turn.items) ||
      turn.items.length !== 0 ||
      (this.provisionalTurnId !== null && this.provisionalTurnId !== turnId)
    ) {
      throw streamFailure();
    }
    this.turnId = turnId;
    this.provisionalTurnId = turnId;
  }

  private onThreadStarted(params: Record<string, unknown>): void {
    if (!this.initialized || this.threadStarted) throw streamFailure();
    const thread = requireRecord(params.thread, 'thread_started_thread');
    const threadId = requireIdentifier(thread.id, 'thread_id');
    if (
      (this.provisionalThreadId !== null &&
        this.provisionalThreadId !== threadId) ||
      thread.ephemeral !== true ||
      thread.path !== null ||
      thread.cliVersion !== CODEX_APP_SERVER_VERSION ||
      thread.cwd !== this.request.cwd ||
      !Array.isArray(thread.turns) ||
      thread.turns.length !== 0
    ) {
      throw confinementFailure();
    }
    requireModelProvider(thread.modelProvider);
    this.provisionalThreadId = threadId;
    this.threadStarted = true;
    this.threadStartedSignal.resolve();
  }

  private onMcpServerStatus(params: Record<string, unknown>): void {
    const name = requireNonEmptyString(params.name, 'mcp_server_name');
    if (name !== CODEX_APP_SERVER_MCP_NAME) throw confinementFailure();
    if (params.threadId !== null) {
      this.assertThreadId(requireIdentifier(params.threadId, 'thread_id'));
    }
    if (
      params.status !== 'starting' &&
      params.status !== 'ready' &&
      params.status !== 'failed' &&
      params.status !== 'cancelled'
    ) {
      throw streamFailure();
    }
    if (params.status === 'failed' || params.status === 'cancelled') {
      throw processFailure();
    }
  }

  private onThreadNameUpdated(params: Record<string, unknown>): void {
    if (
      !this.threadStarted ||
      !hasRequiredAndOptionalKeys(params, ['threadId'], ['threadName'])
    ) {
      throw streamFailure();
    }
    this.assertThreadId(requireIdentifier(params.threadId, 'thread_id'));
    if (params.threadName !== null && params.threadName !== undefined) {
      const threadName = requireNonEmptyString(
        params.threadName,
        'thread_name'
      );
      if (
        Buffer.byteLength(threadName, 'utf8') > MAX_NOTIFICATION_STRING_BYTES
      ) {
        throw streamFailure();
      }
    }
  }

  private onTurnStarted(params: Record<string, unknown>): void {
    if (!this.threadStarted || this.turnStarted) throw streamFailure();
    this.assertThreadId(requireIdentifier(params.threadId, 'thread_id'));
    const turn = requireRecord(params.turn, 'turn_started_turn');
    const turnId = requireIdentifier(turn.id, 'turn_id');
    if (
      (this.provisionalTurnId !== null && this.provisionalTurnId !== turnId) ||
      turn.status !== 'inProgress' ||
      !hasAbsentOrNullProperty(turn, 'error') ||
      !Array.isArray(turn.items) ||
      turn.items.length !== 0
    ) {
      throw streamFailure();
    }
    this.provisionalTurnId = turnId;
    this.turnStarted = true;
  }

  private onItemStarted(params: Record<string, unknown>): void {
    this.assertTurnFence(params);
    if (!this.turnStarted || this.turnCompleted) throw streamFailure();
    const item = requireRecord(params.item, 'item');
    const id = requireIdentifier(item.id, 'item_id');
    const type = requireNonEmptyString(item.type, 'item_type');
    if (this.activeItems.has(id) || this.completedItems.has(id)) {
      throw streamFailure();
    }
    this.validateAllowedItem(item, 'started');
    const active: ActiveItem =
      type === 'mcpToolCall'
        ? Object.freeze({
            type,
            server: requireNonEmptyString(item.server, 'mcp_server'),
            tool: requireNonEmptyString(item.tool, 'mcp_tool'),
          })
        : Object.freeze({ type });
    this.activeItems.set(id, active);
  }

  private onItemCompleted(params: Record<string, unknown>): void {
    this.assertTurnFence(params);
    if (!this.turnStarted || this.turnCompleted) throw streamFailure();
    const item = requireRecord(params.item, 'item');
    const id = requireIdentifier(item.id, 'item_id');
    const type = requireNonEmptyString(item.type, 'item_type');
    const active = this.activeItems.get(id);
    if (!active || active.type !== type || this.completedItems.has(id)) {
      throw streamFailure();
    }
    this.validateAllowedItem(item, 'completed');
    if (
      type === 'mcpToolCall' &&
      (active.server !== item.server || active.tool !== item.tool)
    ) {
      throw confinementFailure();
    }
    this.activeItems.delete(id);
    this.completedItems.set(id, active);
    if (type === 'agentMessage') this.captureFinalMessage(item);
  }

  private validateTurnItemSnapshot(items: readonly unknown[]): void {
    const snapshotItemIds = new Set<string>();
    for (const value of items) {
      try {
        const item = requireRecord(value, 'turn_snapshot_item');
        const id = requireIdentifier(item.id, 'item_id');
        const type = requireNonEmptyString(item.type, 'item_type');
        this.validateAllowedItem(item, 'completed');
        const observed = this.completedItems.get(id);
        if (
          !observed ||
          snapshotItemIds.has(id) ||
          observed.type !== type ||
          (type === 'mcpToolCall' &&
            (observed.server !== item.server || observed.tool !== item.tool))
        ) {
          throw streamFailure();
        }
        snapshotItemIds.add(id);
      } catch (error) {
        if (error instanceof ReviewAgentExecutionError) {
          throw streamFailure();
        }
        throw error;
      }
    }
  }

  private validateAllowedItem(
    item: Record<string, unknown>,
    lifecycle: 'started' | 'completed'
  ): void {
    const type = requireNonEmptyString(item.type, 'item_type');
    if (FORBIDDEN_ITEM_TYPES.has(type)) throw confinementFailure();
    if (!ALLOWED_ITEM_TYPES.has(type)) throw streamFailure();
    switch (type) {
      case 'userMessage':
        this.validateUserMessage(item);
        return;
      case 'agentMessage':
        this.validateAgentMessage(item);
        return;
      case 'reasoning':
        requireStringArray(item.summary, 'reasoning_summary');
        requireStringArray(item.content, 'reasoning_content');
        return;
      case 'mcpToolCall':
        this.validateMcpToolCall(item, lifecycle);
        return;
      case 'contextCompaction':
        return;
    }
  }

  private validateUserMessage(item: Record<string, unknown>): void {
    if (item.clientId !== this.request.clientTurnId) throw streamFailure();
    if (!Array.isArray(item.content) || item.content.length !== 1) {
      throw streamFailure();
    }
    const content = requireRecord(item.content[0], 'user_message_content');
    if (
      content.type !== 'text' ||
      content.text !== this.request.prompt ||
      !Array.isArray(content.text_elements) ||
      content.text_elements.length !== 0
    ) {
      throw streamFailure();
    }
  }

  private validateAgentMessage(item: Record<string, unknown>): void {
    if (
      typeof item.text !== 'string' ||
      (item.phase !== null &&
        item.phase !== 'commentary' &&
        item.phase !== 'final_answer') ||
      item.memoryCitation !== null
    ) {
      throw streamFailure();
    }
    if (Buffer.byteLength(item.text, 'utf8') > this.request.maxOutputBytes) {
      throw schemaFailure();
    }
  }

  private validateMcpToolCall(
    item: Record<string, unknown>,
    lifecycle: 'started' | 'completed'
  ): void {
    const server = requireNonEmptyString(item.server, 'mcp_server');
    const tool = requireNonEmptyString(item.tool, 'mcp_tool');
    if (
      server !== CODEX_APP_SERVER_MCP_NAME ||
      !this.allowedTools.has(tool) ||
      item.pluginId !== null ||
      item.appContext !== null
    ) {
      throw confinementFailure();
    }
    requireRecord(item.arguments, 'mcp_arguments');
    if (lifecycle === 'started') {
      if (
        item.status !== 'inProgress' ||
        item.result !== null ||
        item.error !== null
      ) {
        throw streamFailure();
      }
      return;
    }
    if (
      item.status !== 'completed' ||
      item.error !== null ||
      !isRecord(item.result)
    ) {
      throw confinementFailure();
    }
  }

  private captureFinalMessage(item: Record<string, unknown>): void {
    if (item.phase === 'commentary') return;
    const text = item.text as string;
    if (!text.trim()) throw schemaFailure();
    this.finalMessageCandidates.push({
      phase: item.phase as 'final_answer' | null,
      text,
    });
  }

  private onRawResponseCompleted(params: Record<string, unknown>): void {
    this.assertTurnFence(params);
    if (!this.turnStarted || this.turnCompleted) throw streamFailure();
    const responseId = requireIdentifier(params.responseId, 'response_id');
    if (params.usage === null) throw usageFailure();
    const usage = parseTokenUsage(params.usage);
    const existing = this.rawUsageByResponseId.get(responseId);
    if (existing) {
      throw usageFailure();
    }
    this.rawUsageByResponseId.set(responseId, usage);
  }

  private onTokenUsageUpdated(params: Record<string, unknown>): void {
    this.assertTurnFence(params);
    if (!this.turnStarted || this.turnCompleted) throw streamFailure();
    const tokenUsage = requireRecord(params.tokenUsage, 'thread_token_usage');
    this.aggregateUsage = parseTokenUsage(tokenUsage.total);
    this.lastAggregateUsage = parseTokenUsage(tokenUsage.last);
    if (
      tokenUsage.modelContextWindow !== null &&
      (!Number.isSafeInteger(tokenUsage.modelContextWindow) ||
        (tokenUsage.modelContextWindow as number) < 1)
    ) {
      throw usageFailure();
    }
  }

  private onErrorNotification(params: Record<string, unknown>): void {
    if (
      !this.turnStarted ||
      this.turnCompleted ||
      !hasOnlyKeys(params, ['error', 'threadId', 'turnId', 'willRetry']) ||
      typeof params.willRetry !== 'boolean'
    ) {
      throw streamFailure();
    }
    this.assertTurnFence(params);
    const parsed = parseTurnError(params.error);
    if (params.willRetry) {
      if (this.retainedTerminalError !== null) throw streamFailure();
      return;
    }
    if (this.retainedTerminalError !== null) throw streamFailure();
    this.retainedTerminalError = parsed;
  }

  private onModelVerification(params: Record<string, unknown>): void {
    this.assertActiveTurnMetadata(params, [
      'threadId',
      'turnId',
      'verifications',
    ]);
    if (
      !Array.isArray(params.verifications) ||
      params.verifications.length > MAX_NOTIFICATION_STRING_ARRAY_SIZE ||
      params.verifications.some(
        (verification) => verification !== 'trustedAccessForCyber'
      )
    ) {
      throw streamFailure();
    }
  }

  private onTurnModerationMetadata(params: Record<string, unknown>): void {
    this.assertActiveTurnMetadata(params, ['metadata', 'threadId', 'turnId']);
    validateBoundedJson(params.metadata);
  }

  private onModelSafetyBufferingUpdated(params: Record<string, unknown>): void {
    this.assertActiveTurnMetadata(params, [
      'fasterModel',
      'model',
      'reasons',
      'showBufferingUi',
      'threadId',
      'turnId',
      'useCases',
    ]);
    requireModel(params.model);
    requireBoundedStringArray(params.useCases);
    requireBoundedStringArray(params.reasons);
    if (params.showBufferingUi !== true && params.showBufferingUi !== false) {
      throw streamFailure();
    }
    if (params.fasterModel !== null) requireModel(params.fasterModel);
  }

  private onTurnCompleted(params: Record<string, unknown>): void {
    this.assertThreadId(requireIdentifier(params.threadId, 'thread_id'));
    const turn = requireRecord(params.turn, 'turn_completed_turn');
    this.assertTurnId(requireIdentifier(turn.id, 'turn_id'));
    if (!this.turnStarted || this.turnCompleted || !Array.isArray(turn.items)) {
      throw streamFailure();
    }
    this.validateTurnItemSnapshot(turn.items);
    const turnError = turn.error ?? null;
    switch (turn.status) {
      case 'completed':
        if (
          turnError !== null ||
          this.retainedTerminalError !== null ||
          this.activeItems.size !== 0
        ) {
          throw streamFailure();
        }
        this.turnCompleted = true;
        this.maybeComplete();
        return;
      case 'failed': {
        if (this.activeItems.size !== 0) throw streamFailure();
        const completedError = parseTurnError(turnError);
        const retained = this.retainedTerminalError;
        if (
          retained === null ||
          retained.fingerprint !== completedError.fingerprint
        ) {
          throw streamFailure();
        }
        this.turnCompleted = true;
        this.fail(retained.failure);
        return;
      }
      case 'interrupted':
        if (turnError !== null || this.activeItems.size !== 0) {
          throw streamFailure();
        }
        this.turnCompleted = true;
        this.fail(cancelledFailure());
        return;
      default:
        throw streamFailure();
    }
  }

  private maybeComplete(): void {
    if (!this.turnCompleted || this.failed) return;
    if (!this.threadId || !this.turnId) return;
    if (
      !this.threadStarted ||
      !this.turnStarted ||
      !this.actualModel ||
      !this.modelProvider
    ) {
      this.fail(streamFailure());
      return;
    }
    if (
      this.rawUsageByResponseId.size === 0 ||
      !this.aggregateUsage ||
      !this.lastAggregateUsage
    ) {
      this.fail(usageFailure());
      return;
    }
    const rawUsage = sumUsage([...this.rawUsageByResponseId.values()]);
    const lastRawUsage = [...this.rawUsageByResponseId.values()].at(-1);
    if (
      !sameUsage(rawUsage, this.aggregateUsage) ||
      !lastRawUsage ||
      !sameUsage(lastRawUsage, this.lastAggregateUsage)
    ) {
      this.fail(usageFailure());
      return;
    }
    const finalMessage = selectFinalMessage(this.finalMessageCandidates);
    if (finalMessage === null) {
      this.fail(schemaFailure());
      return;
    }
    this.completionResolved = true;
    this.completion.resolve(
      Object.freeze({
        finalMessage,
        actualModel: this.actualModel,
        modelProvider: this.modelProvider,
        usage: Object.freeze({
          inputTokens: rawUsage.inputTokens,
          cachedInputTokens: rawUsage.cachedInputTokens,
          outputTokens: rawUsage.outputTokens,
          reasoningOutputTokens: rawUsage.reasoningOutputTokens,
          totalTokens: rawUsage.totalTokens,
        }),
      })
    );
  }

  private assertTurnFence(params: Record<string, unknown>): void {
    this.assertThreadId(requireIdentifier(params.threadId, 'thread_id'));
    this.assertTurnId(requireIdentifier(params.turnId, 'turn_id'));
  }

  private onServerRequestResolved(params: Record<string, unknown>): void {
    if (
      !this.threadStarted ||
      !hasOnlyKeys(params, ['requestId', 'threadId'])
    ) {
      throw streamFailure();
    }
    requireRequestId(params.requestId);
    this.assertThreadId(requireIdentifier(params.threadId, 'thread_id'));
  }

  private assertActiveTurnMetadata(
    params: Record<string, unknown>,
    keys: readonly string[]
  ): void {
    if (
      !this.threadStarted ||
      this.turnCompleted ||
      !hasOnlyKeys(params, keys)
    ) {
      throw streamFailure();
    }
    this.assertTurnFence(params);
  }

  private onWarning(params: Record<string, unknown>): void {
    if (!hasRequiredAndOptionalKeys(params, ['message'], ['threadId'])) {
      throw streamFailure();
    }
    if (params.threadId !== null && params.threadId !== undefined) {
      const expectedThreadId = this.threadId ?? this.provisionalThreadId;
      if (expectedThreadId === null) throw streamFailure();
      const warningThreadId = requireIdentifier(params.threadId, 'thread_id');
      if (warningThreadId !== expectedThreadId) throw streamFailure();
    }
    const message = requireNonEmptyString(params.message, 'warning_message');
    if (Buffer.byteLength(message, 'utf8') > MAX_WARNING_MESSAGE_BYTES) {
      throw streamFailure();
    }
  }

  private assertThreadId(threadId: string): void {
    const expected = this.threadId ?? this.provisionalThreadId;
    if (expected !== null && expected !== threadId) throw streamFailure();
    if (expected === null) this.provisionalThreadId = threadId;
  }

  private assertTurnId(turnId: string): void {
    const expected = this.turnId ?? this.provisionalTurnId;
    if (expected !== null && expected !== turnId) throw streamFailure();
    if (expected === null) this.provisionalTurnId = turnId;
  }
}

function selectFinalMessage(
  candidates: readonly Readonly<{
    phase: 'final_answer' | null;
    text: string;
  }>[]
): string | null {
  const finalAnswers = candidates.filter(
    (candidate) => candidate.phase === 'final_answer'
  );
  if (finalAnswers.length === 1) return finalAnswers[0].text;
  if (finalAnswers.length > 1) return null;
  const compatible = candidates.filter((candidate) => candidate.phase === null);
  return compatible.length === 1 ? compatible[0].text : null;
}

export function classifyCodexAppServerDiagnostic(
  diagnostic: string,
  fallback: ReviewAgentFailureClass = ReviewAgentFailureClass.ProcessFailure
): ReviewAgentExecutionError {
  if (
    /(?:401|403|unauthorized|not logged in|refresh token|oauth|authentication)/iu.test(
      diagnostic
    )
  ) {
    return new ReviewAgentExecutionError(
      ReviewAgentFailureClass.AuthenticationUnavailable,
      null,
      'review_agent_authentication_unavailable'
    );
  }
  if (
    /(?:invalid_json_schema|invalid schema for response_format|(?:invalid|rejected|unsupported) structured output schema|structured output schema (?:is )?(?:invalid|rejected|unsupported))/iu.test(
      diagnostic
    )
  ) {
    return schemaFailure();
  }
  if (
    /(?:usage\s*limit|usageLimitExceeded|sessionBudgetExceeded|quota|insufficient_quota|billing limit)/iu.test(
      diagnostic
    )
  ) {
    return new ReviewAgentExecutionError(
      ReviewAgentFailureClass.QuotaUnavailable,
      null,
      'review_agent_quota_unavailable'
    );
  }
  if (
    /(?:capacity[_ -]unavailable|serverOverloaded|overloaded|too many requests|\b429\b|rate limit)/iu.test(
      diagnostic
    )
  ) {
    return new ReviewAgentExecutionError(
      ReviewAgentFailureClass.CapacityUnavailable,
      null,
      'review_agent_capacity_unavailable'
    );
  }
  if (
    /(?:model cache|startup|failed to start|enoent|spawn)/iu.test(diagnostic)
  ) {
    return new ReviewAgentExecutionError(
      ReviewAgentFailureClass.StartupFailure,
      null,
      'review_agent_startup_failure'
    );
  }
  return new ReviewAgentExecutionError(fallback, null, failureCode(fallback));
}

function validateInitializeResponse(value: unknown): void {
  const response = requireRecord(value, 'initialize_response');
  const userAgent = requireNonEmptyString(response.userAgent, 'user_agent');
  const versionPattern = new RegExp(
    `^[A-Za-z][A-Za-z0-9 ._-]{0,64}/${CODEX_APP_SERVER_VERSION.replaceAll('.', '\\.')}(?:\\s|$)`,
    'u'
  );
  if (
    !versionPattern.test(userAgent) ||
    !path.isAbsolute(requireNonEmptyString(response.codexHome, 'codex_home')) ||
    !requireNonEmptyString(response.platformFamily, 'platform_family') ||
    !requireNonEmptyString(response.platformOs, 'platform_os')
  ) {
    throw new ReviewAgentExecutionError(
      ReviewAgentFailureClass.CapabilityUnavailable,
      null,
      'review_agent_capability_unavailable'
    );
  }
}

function parseTokenUsage(value: unknown): RawTokenUsage {
  const usage = requireRecord(value, 'token_usage');
  if (
    !hasOnlyKeys(usage, [
      'cacheWriteInputTokens',
      'cachedInputTokens',
      'inputTokens',
      'outputTokens',
      'reasoningOutputTokens',
      'totalTokens',
    ])
  ) {
    throw usageFailure();
  }
  const parsed = Object.freeze({
    totalTokens: requireTokenCount(usage.totalTokens),
    inputTokens: requireTokenCount(usage.inputTokens),
    cachedInputTokens: requireTokenCount(usage.cachedInputTokens),
    cacheWriteInputTokens: requireTokenCount(usage.cacheWriteInputTokens),
    outputTokens: requireTokenCount(usage.outputTokens),
    reasoningOutputTokens: requireTokenCount(usage.reasoningOutputTokens),
  });
  if (
    parsed.cachedInputTokens > parsed.inputTokens ||
    parsed.cacheWriteInputTokens > parsed.inputTokens ||
    parsed.reasoningOutputTokens > parsed.outputTokens ||
    parsed.totalTokens !== parsed.inputTokens + parsed.outputTokens
  ) {
    throw usageFailure();
  }
  return parsed;
}

function sumUsage(values: readonly RawTokenUsage[]): RawTokenUsage {
  const total = {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
  for (const usage of values) {
    for (const key of Object.keys(total) as (keyof RawTokenUsage)[]) {
      const next = total[key] + usage[key];
      if (!Number.isSafeInteger(next)) throw usageFailure();
      total[key] = next;
    }
  }
  return Object.freeze(total);
}

function sameUsage(left: RawTokenUsage, right: RawTokenUsage): boolean {
  return (
    left.totalTokens === right.totalTokens &&
    left.inputTokens === right.inputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.cacheWriteInputTokens === right.cacheWriteInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.reasoningOutputTokens === right.reasoningOutputTokens
  );
}

function responseFailure(value: unknown): ReviewAgentExecutionError {
  const error = requireRecord(value, 'protocol_error');
  if (
    !Number.isSafeInteger(error.code) ||
    typeof error.message !== 'string' ||
    error.message.length > 16_384
  ) {
    return streamFailure();
  }
  const diagnostic =
    `${error.code} ${error.message} ${safeJson(error.data)}`.slice(0, 16_384);
  return classifyCodexAppServerDiagnostic(diagnostic);
}

function parseTurnError(value: unknown): ParsedTurnError {
  const error = requireRecord(value, 'turn_error');
  const additionalDetails = error.additionalDetails ?? null;
  const codexErrorInfo = parseCodexErrorInfo(error.codexErrorInfo ?? null);
  if (
    typeof error.message !== 'string' ||
    error.message.length > 16_384 ||
    (additionalDetails !== null &&
      (typeof additionalDetails !== 'string' ||
        additionalDetails.length > 16_384))
  ) {
    throw streamFailure();
  }
  if (
    error.message.length === 0 &&
    !hasCodexErrorClassification(codexErrorInfo)
  ) {
    throw streamFailure();
  }
  const normalized = Object.freeze({
    message: error.message,
    additionalDetails,
    codexErrorInfo,
  });
  const canonical = canonicalProtocolValue(normalized);
  if (Buffer.byteLength(canonical, 'utf8') > 32_768) {
    throw streamFailure();
  }
  const diagnostic = [
    error.message,
    additionalDetails ?? '',
    safeJson(codexErrorInfo),
  ]
    .join(' ')
    .slice(0, 16_384);
  return Object.freeze({
    failure: classifyCodexAppServerDiagnostic(diagnostic),
    fingerprint: createHash('sha256').update(canonical).digest('hex'),
  });
}

function hasCodexErrorClassification(value: unknown): boolean {
  return value !== null;
}

function parseCodexErrorInfo(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'string') {
    if (!CODEX_ERROR_INFO_STRING_VARIANTS.has(value)) throw streamFailure();
    return value;
  }
  const tagged = requireRecord(value, 'codex_error_info');
  const variants = Object.keys(tagged);
  if (variants.length !== 1) throw streamFailure();
  const variant = variants[0];
  const payload = requireRecord(tagged[variant], 'codex_error_info_payload');
  if (CODEX_ERROR_INFO_HTTP_VARIANTS.has(variant)) {
    if (!hasRequiredAndOptionalKeys(payload, [], ['httpStatusCode'])) {
      throw streamFailure();
    }
    const status = payload.httpStatusCode;
    if (
      status !== undefined &&
      status !== null &&
      (!Number.isSafeInteger(status) ||
        (status as number) < 0 ||
        (status as number) > 65_535)
    ) {
      throw streamFailure();
    }
    return value;
  }
  if (
    variant === 'activeTurnNotSteerable' &&
    hasOnlyKeys(payload, ['turnKind']) &&
    (payload.turnKind === 'review' || payload.turnKind === 'compact')
  ) {
    return value;
  }
  throw streamFailure();
}

function canonicalProtocolValue(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string') throw streamFailure();
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalProtocolValue).join(',')}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalProtocolValue(record[key])}`
    )
    .join(',')}}`;
}

function normalizeProtocolFailure(error: unknown): ReviewAgentExecutionError {
  return error instanceof ReviewAgentExecutionError ? error : streamFailure();
}

function requireRecord(
  value: unknown,
  _field: string
): Record<string, unknown> {
  if (!isRecord(value)) throw streamFailure();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireRequestId(value: unknown): string | number {
  if (
    typeof value === 'string' ||
    (Number.isSafeInteger(value) && typeof value === 'number')
  ) {
    return value;
  }
  throw streamFailure();
}

function requestIdKey(value: string | number): string {
  return `${typeof value}:${String(value)}`;
}

function requireNonEmptyString(value: unknown, _field: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 16_384 ||
    containsControlCharacter(value)
  ) {
    throw streamFailure();
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function requireIdentifier(value: unknown, field: string): string {
  const result = requireNonEmptyString(value, field);
  if (result.length > 512) throw streamFailure();
  return result;
}

function requireModel(value: unknown): string {
  const model = requireNonEmptyString(value, 'model');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+#-]{0,199}$/u.test(model)) {
    throw modelFailure();
  }
  return model;
}

function requireModelProvider(value: unknown): string {
  const provider = requireNonEmptyString(value, 'model_provider');
  if (provider.trim() !== provider || provider.length > 200) {
    throw modelFailure();
  }
  return provider;
}

function requireStringArray(value: unknown, _field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw streamFailure();
  }
  return value as string[];
}

function requireBoundedStringArray(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_NOTIFICATION_STRING_ARRAY_SIZE
  ) {
    throw streamFailure();
  }
  for (const item of value) {
    if (
      typeof item !== 'string' ||
      Buffer.byteLength(item, 'utf8') > MAX_NOTIFICATION_STRING_BYTES ||
      containsControlCharacter(item)
    ) {
      throw streamFailure();
    }
  }
  return value as string[];
}

function validateBoundedJson(value: unknown): void {
  const pending: Array<Readonly<{ value: unknown; depth: number }>> = [
    { value, depth: 0 },
  ];
  let nodeCount = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || ++nodeCount > MAX_METADATA_JSON_NODES) {
      throw streamFailure();
    }
    const candidate = current.value;
    if (
      candidate === null ||
      typeof candidate === 'boolean' ||
      (typeof candidate === 'number' && Number.isFinite(candidate))
    ) {
      continue;
    }
    if (typeof candidate === 'string') {
      if (
        Buffer.byteLength(candidate, 'utf8') > MAX_METADATA_STRING_BYTES ||
        containsControlCharacter(candidate)
      ) {
        throw streamFailure();
      }
      continue;
    }
    if (current.depth >= MAX_METADATA_JSON_DEPTH) throw streamFailure();
    if (Array.isArray(candidate)) {
      if (candidate.length > MAX_METADATA_COLLECTION_SIZE) {
        throw streamFailure();
      }
      for (const item of candidate) {
        pending.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }
    if (!isRecord(candidate)) throw streamFailure();
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw streamFailure();
    }
    const entries = Object.entries(candidate);
    if (entries.length > MAX_METADATA_COLLECTION_SIZE) throw streamFailure();
    for (const [key, item] of entries) {
      if (
        Buffer.byteLength(key, 'utf8') > MAX_NOTIFICATION_STRING_BYTES ||
        containsControlCharacter(key)
      ) {
        throw streamFailure();
      }
      pending.push({ value: item, depth: current.depth + 1 });
    }
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw streamFailure();
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_METADATA_JSON_BYTES) {
    throw streamFailure();
  }
}

function requireTokenCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw usageFailure();
  }
  return value as number;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function hasRequiredAndOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[]
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function hasAbsentOrNullProperty(
  value: Record<string, unknown>,
  key: string
): boolean {
  return (
    !Object.prototype.hasOwnProperty.call(value, key) || value[key] === null
  );
}

function isReadOnlySandbox(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === 'readOnly' &&
    value.networkAccess === false
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

enum CodexProtocolDiagnosticStage {
  Completion = 'completion',
  Envelope = 'envelope',
  Error = 'error',
  IgnoredNotification = 'ignored_notification',
  InitializedNotification = 'initialized_notification',
  InitializeResponse = 'initialize_response',
  ItemCompleted = 'item_completed',
  ItemStarted = 'item_started',
  McpServerStatus = 'mcp_server_status',
  ModelRerouted = 'model_rerouted',
  ModelSafety = 'model_safety',
  ModelVerification = 'model_verification',
  ModerationMetadata = 'moderation_metadata',
  ProcessEnd = 'process_end',
  RawResponseCompleted = 'raw_response_completed',
  Response = 'response',
  ServerRequestResolved = 'server_request_resolved',
  ThreadStarted = 'thread_started',
  ThreadNameUpdated = 'thread_name_updated',
  ThreadStartedWait = 'thread_started_wait',
  ThreadStartResponse = 'thread_start_response',
  TokenUsageUpdated = 'token_usage_updated',
  TurnCompleted = 'turn_completed',
  TurnStartResponse = 'turn_start_response',
  TurnStarted = 'turn_started',
  UnknownNotification = 'unknown_notification',
  Warning = 'warning',
}

type CodexProtocolDiagnosticStageValue =
  | CodexProtocolDiagnosticStage
  | `unknown_notification_${string}`;

function notificationDiagnosticStage(
  value: unknown
): CodexProtocolDiagnosticStageValue {
  switch (value) {
    case 'thread/started':
      return CodexProtocolDiagnosticStage.ThreadStarted;
    case 'thread/name/updated':
      return CodexProtocolDiagnosticStage.ThreadNameUpdated;
    case 'mcpServer/startupStatus/updated':
      return CodexProtocolDiagnosticStage.McpServerStatus;
    case 'serverRequest/resolved':
      return CodexProtocolDiagnosticStage.ServerRequestResolved;
    case 'turn/started':
      return CodexProtocolDiagnosticStage.TurnStarted;
    case 'item/started':
      return CodexProtocolDiagnosticStage.ItemStarted;
    case 'item/completed':
      return CodexProtocolDiagnosticStage.ItemCompleted;
    case 'rawResponse/completed':
      return CodexProtocolDiagnosticStage.RawResponseCompleted;
    case 'thread/tokenUsage/updated':
      return CodexProtocolDiagnosticStage.TokenUsageUpdated;
    case 'turn/completed':
      return CodexProtocolDiagnosticStage.TurnCompleted;
    case 'model/rerouted':
      return CodexProtocolDiagnosticStage.ModelRerouted;
    case 'model/verification':
      return CodexProtocolDiagnosticStage.ModelVerification;
    case 'turn/moderationMetadata':
      return CodexProtocolDiagnosticStage.ModerationMetadata;
    case 'model/safetyBuffering/updated':
      return CodexProtocolDiagnosticStage.ModelSafety;
    case 'warning':
      return CodexProtocolDiagnosticStage.Warning;
    case 'error':
      return CodexProtocolDiagnosticStage.Error;
    default:
      if (
        typeof value === 'string' &&
        IGNORED_NOTIFICATION_METHODS.has(value)
      ) {
        return CodexProtocolDiagnosticStage.IgnoredNotification;
      }
      return typeof value === 'string'
        ? `unknown_notification_${createHash('sha256')
            .update(value)
            .digest('hex')
            .slice(0, 12)}`
        : CodexProtocolDiagnosticStage.UnknownNotification;
  }
}

function withStreamDiagnosticStage(
  error: unknown,
  stage: CodexProtocolDiagnosticStageValue
): unknown {
  return error instanceof ReviewAgentExecutionError &&
    error.failureClass === ReviewAgentFailureClass.StreamIncomplete &&
    error.message === 'review_agent_stream_incomplete'
    ? streamFailure(stage)
    : error;
}

async function withProtocolRunStage<T>(
  stage: CodexProtocolDiagnosticStageValue,
  operation: () => T | Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw withStreamDiagnosticStage(error, stage);
  }
}

function streamFailure(
  stage?: CodexProtocolDiagnosticStageValue
): ReviewAgentExecutionError {
  return new ReviewAgentExecutionError(
    ReviewAgentFailureClass.StreamIncomplete,
    null,
    stage
      ? `review_agent_stream_incomplete_${stage}`
      : 'review_agent_stream_incomplete'
  );
}

function schemaFailure(): ReviewAgentExecutionError {
  return new ReviewAgentExecutionError(
    ReviewAgentFailureClass.SchemaInvalidOutput,
    null,
    'review_agent_output_invalid'
  );
}

function usageFailure(): ReviewAgentExecutionError {
  return new ReviewAgentExecutionError(
    ReviewAgentFailureClass.UsageAttributionMissing,
    null,
    'review_agent_usage_attribution_missing'
  );
}

function modelFailure(): ReviewAgentExecutionError {
  return new ReviewAgentExecutionError(
    ReviewAgentFailureClass.ModelAttributionMissing,
    null,
    'review_agent_actual_model_unavailable'
  );
}

function confinementFailure(): ReviewAgentExecutionError {
  return new ReviewAgentExecutionError(
    ReviewAgentFailureClass.ConfinementViolation,
    null,
    'review_agent_confinement_violation'
  );
}

function processFailure(): ReviewAgentExecutionError {
  return new ReviewAgentExecutionError(
    ReviewAgentFailureClass.ProcessFailure,
    null,
    'review_agent_process_failure'
  );
}

function cancelledFailure(): ReviewAgentExecutionError {
  return new ReviewAgentExecutionError(
    ReviewAgentFailureClass.Cancelled,
    null,
    'review_agent_process_cancelled'
  );
}

function failureCode(failureClass: ReviewAgentFailureClass): string {
  switch (failureClass) {
    case ReviewAgentFailureClass.CapabilityUnavailable:
      return 'review_agent_capability_unavailable';
    case ReviewAgentFailureClass.AuthenticationUnavailable:
      return 'review_agent_authentication_unavailable';
    case ReviewAgentFailureClass.QuotaUnavailable:
      return 'review_agent_quota_unavailable';
    case ReviewAgentFailureClass.CapacityUnavailable:
      return 'review_agent_capacity_unavailable';
    case ReviewAgentFailureClass.StartupFailure:
      return 'review_agent_startup_failure';
    case ReviewAgentFailureClass.ProcessFailure:
      return 'review_agent_process_failure';
    case ReviewAgentFailureClass.Timeout:
      return 'review_agent_process_timeout';
    case ReviewAgentFailureClass.Cancelled:
      return 'review_agent_process_cancelled';
    case ReviewAgentFailureClass.SchemaInvalidOutput:
      return 'review_agent_output_invalid';
    case ReviewAgentFailureClass.StreamIncomplete:
      return 'review_agent_stream_incomplete';
    case ReviewAgentFailureClass.ModelAttributionMissing:
      return 'review_agent_actual_model_unavailable';
    case ReviewAgentFailureClass.UsageAttributionMissing:
      return 'review_agent_usage_attribution_missing';
    case ReviewAgentFailureClass.ConfinementViolation:
      return 'review_agent_confinement_violation';
  }
}

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
