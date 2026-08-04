import { writeFile } from 'fs/promises';
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

const scenarioMarker = 'REVIEWROUTER_E2E_SCENARIO_V1_BASE64URL:';
const briefMarker = 'REVIEWROUTER_INVESTIGATION_TURN_BRIEF_V1_BASE64URL:';

void main();

async function main(): Promise<void> {
  const prompt = await readStdin();
  const scenario = decodeMarker<Scenario>(prompt, scenarioMarker);
  const brief = decodeMarker<TurnBrief>(prompt, briefMarker);
  const mode = scenario.mode ?? 'success';
  if (mode === 'capacity') {
    process.stderr.write('capacity_unavailable\n');
    process.exitCode = 1;
    return;
  }
  if (mode === 'kill') {
    process.kill(process.pid, 'SIGKILL');
    return;
  }

  const outputPath = requireArgumentValue('--output-last-message');
  const model = requireArgumentValue('--model');
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
        if (operationCount > (scenario.maximumOperations ?? 10_000)) {
          throw new Error('fake_provider_operation_budget_exceeded');
        }
        const result = await client.callTool({
          name: operation.tool,
          arguments: {
            ...operation.arguments,
            ...(cursor === undefined ? {} : { cursor }),
          },
        });
        const payload = parseToolPayload(result.content);
        const receiptId = stringField(payload, 'operationReceiptId');
        receiptIds.push(receiptId);
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
          if (operationCount > (scenario.maximumOperations ?? 10_000)) {
            throw new Error('fake_provider_operation_budget_exceeded');
          }
          const result = await client.callTool({
            name: 'review_read_file',
            arguments: {
              path: matchedPath,
              revision: 'head',
              startByte: 0,
              maxBytes: 2 * 1024 * 1024,
            },
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
  await writeFile(outputPath, JSON.stringify(output), 'utf8');
  process.stdout.write(
    `${JSON.stringify({ type: 'session_configured', model })}\n`
  );
  process.stdout.write(
    `${JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: Buffer.byteLength(prompt, 'utf8'),
        cached_input_tokens: 0,
        output_tokens: Buffer.byteLength(JSON.stringify(output), 'utf8'),
        reasoning_output_tokens: 0,
      },
    })}\n`
  );
}

function parseToolPayload(content: unknown): Record<string, unknown> {
  if (!Array.isArray(content) || content.length !== 1) {
    throw new Error('fake_provider_tool_content_invalid');
  }
  const item = content[0] as Record<string, unknown>;
  if (item.type !== 'text' || typeof item.text !== 'string') {
    throw new Error('fake_provider_tool_text_invalid');
  }
  const parsed = JSON.parse(item.text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('fake_provider_tool_payload_invalid');
  }
  return parsed as Record<string, unknown>;
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

function requireArgumentValue(flag: string): string {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`fake_provider_argument_missing:${flag}`);
  return value;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
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

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== 'string') {
    throw new Error(`fake_provider_${field}_invalid`);
  }
  return result;
}

function nullableStringField(
  value: Record<string, unknown>,
  field: string
): string | null {
  const result = value[field];
  if (result !== null && typeof result !== 'string') {
    throw new Error(`fake_provider_${field}_invalid`);
  }
  return result;
}

function arrayField(
  value: Record<string, unknown>,
  field: string
): readonly unknown[] {
  const result = value[field];
  if (result === undefined) return [];
  if (!Array.isArray(result)) {
    throw new Error(`fake_provider_${field}_invalid`);
  }
  return result;
}
