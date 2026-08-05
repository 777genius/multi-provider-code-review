import readline from 'readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

type ScenarioOperation = Readonly<{
  tool: string;
  arguments: Readonly<Record<string, unknown>>;
  paginate?: boolean;
  stopAfterPages?: number;
  tamperNextCursor?: boolean;
  readMatchedPaths?: boolean;
  omitMatchedPaths?: readonly string[];
  substituteMatchedPath?: string;
  additionalMatchedPaths?: readonly string[];
}>;

type Scenario = Readonly<{
  mode?: 'success' | 'capacity' | 'kill';
  operations?: readonly ScenarioOperation[];
  closureKinds?: readonly string[];
  findings?: readonly Readonly<{
    severity: string;
    title: string;
    body: string;
    path: string;
    line: number | null;
  }>[];
  unresolvableKinds?: readonly string[];
  criticDecision?: 'accept' | 'veto' | 'abstain' | null;
  delayMs?: number;
  maximumOperations?: number;
}>;

type TurnBrief = Readonly<{
  purpose: 'discovery' | 'critic';
  obligations: readonly Readonly<{
    obligationId: string;
    kind: string;
  }>[];
}>;

type JsonRpcRequest = Readonly<{
  id?: number;
  method: string;
  params?: Readonly<Record<string, unknown>>;
}>;

const scenarioMarker = 'REVIEWROUTER_E2E_SCENARIO_V1_BASE64URL:';
const briefMarker = 'REVIEWROUTER_INVESTIGATION_TURN_BRIEF_V1_BASE64URL:';
const threadId = 'reviewrouter-e2e-thread';
const turnId = 'reviewrouter-e2e-turn';
let protocolCwd = process.cwd();
let outputQueue = Promise.resolve();
let interrupted = false;
let itemSequence = 0;

void main();

async function main(): Promise<void> {
  if (process.argv.includes('--version')) {
    process.stdout.write('codex-cli 0.145.0\n');
    return;
  }
  if (!process.argv.includes('app-server')) {
    throw new Error('fake_provider_app_server_required');
  }

  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  input.on('line', (line) => {
    void handleRequest(JSON.parse(line) as JsonRpcRequest).catch(fail);
  });
}

async function handleRequest(message: JsonRpcRequest): Promise<void> {
  switch (message.method) {
    case 'initialize':
      await respond(message, {
        userAgent: 'Codex Desktop/0.145.0 reviewrouter-e2e',
        codexHome: process.cwd(),
        platformFamily: 'unix',
        platformOs: process.platform,
      });
      await notify('remoteControl/status/changed', { status: 'disabled' });
      return;
    case 'initialized':
      return;
    case 'thread/start': {
      const params = requireRecord(message.params, 'thread_start_params');
      const model = stringField(params, 'model');
      protocolCwd = stringField(params, 'cwd');
      const reasoningEffort = stringField(
        requireRecord(params.config, 'thread_start_config'),
        'model_reasoning_effort'
      );
      const thread = threadRecord();
      await respond(message, {
        thread,
        model,
        modelProvider: 'openai',
        serviceTier: null,
        cwd: protocolCwd,
        instructionSources: [],
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: { type: 'readOnly', networkAccess: false },
        reasoningEffort,
      });
      await notify('thread/started', { thread });
      return;
    }
    case 'turn/start': {
      const params = requireRecord(message.params, 'turn_start_params');
      const prompt = turnPrompt(params);
      await respond(message, { turn: turnRecord('inProgress') });
      await notify('turn/started', {
        threadId,
        turn: turnRecord('inProgress'),
      });
      void executeTurn(prompt).catch(fail);
      return;
    }
    case 'turn/interrupt':
      interrupted = true;
      await respond(message, {});
      return;
    default:
      throw new Error(`fake_provider_request_unsupported:${message.method}`);
  }
}

async function executeTurn(prompt: string): Promise<void> {
  const scenario = decodeMarker<Scenario>(prompt, scenarioMarker);
  const brief = decodeMarker<TurnBrief>(prompt, briefMarker);
  const mode = scenario.mode ?? 'success';
  if (mode === 'capacity') {
    process.stderr.write('capacity_unavailable\n');
    process.exitCode = 1;
    process.stdin.destroy();
    return;
  }
  if (mode === 'kill') {
    process.kill(process.pid, 'SIGKILL');
    return;
  }

  const transport = new StdioClientTransport({
    command: parseReviewRouterConfig('command') as string,
    args: parseReviewRouterConfig('args') as string[],
    cwd: parseReviewRouterConfig('cwd') as string,
    env: stringEnvironment(process.env),
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'reviewrouter-e2e-fake-provider', version: '1.0.0' },
    { capabilities: {} }
  );
  const receiptIds: string[] = [];
  let operationCount = 0;
  try {
    await client.connect(transport);
    for (const operation of scenario.operations ?? []) {
      let cursor: string | undefined;
      let page = 0;
      const matchedPaths = new Set<string>();
      do {
        operationCount += 1;
        assertOperationBudget(operationCount, scenario);
        const args = {
          ...operation.arguments,
          ...(cursor === undefined ? {} : { cursor }),
        };
        const result = await callGateway(client, operation.tool, args);
        const payload = parseToolPayload(result.content);
        receiptIds.push(stringField(payload, 'operationReceiptId'));
        for (const match of arrayField(payload, 'matches')) {
          if (typeof match === 'string') {
            matchedPaths.add(match.split(':', 1)[0]!);
          }
        }
        page += 1;
        if (
          !operation.paginate ||
          page >= (operation.stopAfterPages ?? Number.MAX_SAFE_INTEGER)
        ) {
          cursor = undefined;
        } else {
          const next = nullableStringField(payload, 'nextCursor');
          cursor =
            operation.tamperNextCursor && next
              ? `${next.slice(0, -1)}${next.endsWith('0') ? '1' : '0'}`
              : (next ?? undefined);
        }
      } while (cursor !== undefined);
      if (operation.readMatchedPaths) {
        const omitted = new Set(operation.omitMatchedPaths ?? []);
        const requiredPaths = operation.substituteMatchedPath
          ? [operation.substituteMatchedPath]
          : [...matchedPaths].filter((item) => !omitted.has(item));
        const paths = [
          ...new Set([
            ...requiredPaths,
            ...(operation.additionalMatchedPaths ?? []),
          ]),
        ].sort();
        for (const matchedPath of paths) {
          operationCount += 1;
          assertOperationBudget(operationCount, scenario);
          const result = await callGateway(client, 'review_read_file', {
            path: matchedPath,
            revision: 'head',
            startByte: 0,
            maxBytes: 2 * 1024 * 1024,
          });
          receiptIds.push(
            stringField(parseToolPayload(result.content), 'operationReceiptId')
          );
        }
      }
    }
  } finally {
    await client.close();
  }

  if ((scenario.delayMs ?? 0) > 0) {
    await new Promise((resolve) => setTimeout(resolve, scenario.delayMs));
  }
  if (interrupted) return;

  const closureKinds = new Set(scenario.closureKinds ?? []);
  const unresolvableKinds = new Set(scenario.unresolvableKinds ?? []);
  const output = {
    outputVersion: 2,
    findings: (scenario.findings ?? []).map((finding) => ({
      ...finding,
      evidenceOperationReceiptIds: receiptIds,
    })),
    obligationProposals: [],
    closureClaims: brief.obligations
      .filter(
        (obligation) =>
          closureKinds.has('*') || closureKinds.has(obligation.kind)
      )
      .map((obligation) => ({
        obligationId: obligation.obligationId,
        operationReceiptIds: receiptIds,
      })),
    operationBackedDiscoveryClaims: [],
    unresolvableClaims: brief.obligations
      .filter((obligation) => unresolvableKinds.has(obligation.kind))
      .map((obligation) => ({
        obligationId: obligation.obligationId,
        reason: 'deterministic_fixture_unresolvable',
        evidenceOperationReceiptIds: receiptIds,
      })),
    criticDecision:
      brief.purpose === 'critic' ? (scenario.criticDecision ?? 'accept') : null,
  };
  const finalText = JSON.stringify(output);
  const item = {
    type: 'agentMessage',
    id: 'final-answer',
    text: finalText,
    phase: 'final_answer',
    memoryCitation: null,
  };
  await notify('item/started', {
    threadId,
    turnId,
    startedAtMs: 1,
    item,
  });
  await notify('item/completed', {
    threadId,
    turnId,
    completedAtMs: 2,
    item,
  });
  const usage = tokenUsage(
    Buffer.byteLength(prompt, 'utf8'),
    Buffer.byteLength(finalText, 'utf8')
  );
  await notify('rawResponse/completed', {
    threadId,
    turnId,
    responseId: 'response-1',
    usage,
  });
  await notify('thread/tokenUsage/updated', {
    threadId,
    turnId,
    tokenUsage: { total: usage, last: usage, modelContextWindow: 200_000 },
  });
  await notify('turn/completed', {
    threadId,
    turn: turnRecord('completed'),
  });
}

async function callGateway(
  client: Client,
  tool: string,
  args: Readonly<Record<string, unknown>>
) {
  const id = `mcp-${++itemSequence}`;
  await notify('item/started', {
    threadId,
    turnId,
    startedAtMs: 1,
    item: mcpItem(id, tool, args, 'inProgress', null),
  });
  const result = await client.callTool({ name: tool, arguments: args });
  await notify('item/completed', {
    threadId,
    turnId,
    completedAtMs: 2,
    item: mcpItem(id, tool, args, 'completed', { content: result.content }),
  });
  return result;
}

function mcpItem(
  id: string,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  status: 'inProgress' | 'completed',
  result: Readonly<Record<string, unknown>> | null
) {
  return {
    type: 'mcpToolCall',
    id,
    server: 'reviewrouter',
    tool,
    arguments: args,
    status,
    result,
    error: null,
    pluginId: null,
    appContext: null,
  };
}

function assertOperationBudget(count: number, scenario: Scenario): void {
  if (count > (scenario.maximumOperations ?? 10_000)) {
    throw new Error('fake_provider_operation_budget_exceeded');
  }
}

function tokenUsage(inputTokens: number, outputTokens: number) {
  return {
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: 0,
  };
}

function threadRecord() {
  return {
    id: threadId,
    ephemeral: true,
    modelProvider: 'openai',
    path: null,
    cwd: protocolCwd,
    cliVersion: '0.145.0',
    turns: [],
  };
}

function turnRecord(status: 'inProgress' | 'completed') {
  return { id: turnId, status, error: null, items: [] };
}

function turnPrompt(params: Readonly<Record<string, unknown>>): string {
  const input = params.input;
  if (!Array.isArray(input) || input.length !== 1) {
    throw new Error('fake_provider_turn_input_invalid');
  }
  const content = requireRecord(input[0], 'turn_input');
  return stringField(content, 'text');
}

function respond(
  request: JsonRpcRequest,
  result: Readonly<Record<string, unknown>>
): Promise<void> {
  if (!Number.isSafeInteger(request.id)) {
    throw new Error('fake_provider_request_id_invalid');
  }
  return send({ id: request.id, result });
}

function notify(
  method: string,
  params: Readonly<Record<string, unknown>>
): Promise<void> {
  return send({ method, params, emittedAtMs: 1 });
}

function send(value: Readonly<Record<string, unknown>>): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  outputQueue = outputQueue.then(
    () =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(line, 'utf8', (error) => {
          if (error) reject(error);
          else resolve();
        });
      })
  );
  return outputQueue;
}

function fail(error: unknown): void {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'fake_provider_failure'}\n`
  );
  process.exitCode = 1;
  process.stdin.destroy();
}

function parseToolPayload(content: unknown): Record<string, unknown> {
  if (!Array.isArray(content) || content.length !== 1) {
    throw new Error('fake_provider_tool_content_invalid');
  }
  const item = content[0] as Record<string, unknown>;
  if (item.type !== 'text' || typeof item.text !== 'string') {
    throw new Error('fake_provider_tool_text_invalid');
  }
  return requireRecord(JSON.parse(item.text), 'tool_payload');
}

function decodeMarker<T>(input: string, marker: string): T {
  const encoded = input
    .split(/\r?\n/u)
    .find((line) => line.startsWith(marker))
    ?.slice(marker.length);
  if (!encoded) throw new Error('fake_provider_prompt_contract_missing');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as T;
}

function parseReviewRouterConfig(field: 'command' | 'args' | 'cwd'): unknown {
  const prefix = `mcp_servers.reviewrouter.${field}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  if (!value) throw new Error(`fake_provider_gateway_${field}_missing`);
  return JSON.parse(value.slice(prefix.length));
}

function stringEnvironment(
  environment: NodeJS.ProcessEnv
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );
}

function requireRecord(
  value: unknown,
  field: string
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`fake_provider_${field}_invalid`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function stringField(value: Readonly<Record<string, unknown>>, field: string) {
  const result = value[field];
  if (typeof result !== 'string') {
    throw new Error(`fake_provider_${field}_invalid`);
  }
  return result;
}

function nullableStringField(
  value: Readonly<Record<string, unknown>>,
  field: string
): string | null {
  const result = value[field];
  if (result !== null && typeof result !== 'string') {
    throw new Error(`fake_provider_${field}_invalid`);
  }
  return result;
}

function arrayField(
  value: Readonly<Record<string, unknown>>,
  field: string
): readonly unknown[] {
  const result = value[field];
  if (result === undefined) return [];
  if (!Array.isArray(result)) {
    throw new Error(`fake_provider_${field}_invalid`);
  }
  return result;
}
