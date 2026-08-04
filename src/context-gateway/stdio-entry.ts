#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  CONTEXT_GATEWAY_POLICY_VERSION,
  requireGitOid,
  requireSha256,
  sha256,
} from './context-gateway-contract';
import {
  CONTEXT_GATEWAY_V4_POLICY_VERSION,
  ContextGatewayV4OperationKind,
  ContextGatewayV4Revision,
  ContextOperationFailureClass,
} from './context-gateway-v4-contract';
import {
  CONTEXT_GATEWAY_OMITTED_POLICY_FALLBACK_VERSION,
  CONTEXT_GATEWAY_RELEASE_DESCRIPTION,
} from './context-gateway-release-contract';
import { ContextGatewayRecorder } from './context-gateway-recorder';
import { ContextGatewayV4Recorder } from './context-gateway-v4-recorder';
import { ContextGatewayV4ReplayMaterialRecorder } from './context-gateway-v4-replay-material';
import { parseContextGatewayV4Request } from './context-gateway-v4-request';
import {
  CONTEXT_GATEWAY_TOOL_DEFINITIONS,
  CONTEXT_GATEWAY_V4_TOOL_DEFINITIONS,
} from './context-gateway-tool-definitions';
import { FilesystemContextGateway } from './filesystem-context-gateway';
import { FilesystemContextGatewayV4 } from './filesystem-context-gateway-v4';
import { captureRequiredContextWitness } from './required-context-witness';

async function main(): Promise<void> {
  const mode = readMode(process.argv.slice(2));
  if (mode === ContextGatewayMode.Describe) {
    process.stdout.write(
      `${JSON.stringify(CONTEXT_GATEWAY_RELEASE_DESCRIPTION)}\n`
    );
    return;
  }
  const config = readConfig();
  const preflightOnly = mode === ContextGatewayMode.Preflight;
  if (config.policyVersion === CONTEXT_GATEWAY_V4_POLICY_VERSION) {
    await runV4(config, preflightOnly);
    return;
  }
  const recorder = new ContextGatewayRecorder({
    sessionId: config.sessionId,
    transcriptPath: config.transcriptPath,
    replayMaterialPath: config.replayMaterialPath,
    secret: Buffer.from(config.secret, 'base64url'),
    gatewayBinaryHash: config.gatewayBinaryHash,
    checkoutTreeOid: config.checkoutTreeOid,
    eventChainSeedHash: config.eventChainSeedHash,
  });
  if (preflightOnly) {
    await recorder.initialize();
  } else {
    await recorder.resume();
  }
  const gateway = await FilesystemContextGateway.create({
    root: config.root,
    checkoutTreeOid: config.checkoutTreeOid,
    baseSha: config.baseSha,
    mergeBaseSha: config.mergeBaseSha,
    headSha: config.headSha,
    recorder,
  });
  if (preflightOnly) {
    await captureRequiredContextWitness(gateway);
    return;
  }
  const server = new Server(
    {
      name: 'reviewrouter-context-gateway',
      version: CONTEXT_GATEWAY_POLICY_VERSION,
    },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: CONTEXT_GATEWAY_TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = requireRecord(request.params.arguments);
    switch (request.params.name) {
      case 'review_read_file':
        return response(
          await gateway.readFile({
            path: requireString(args.path, 'path'),
            startByte: optionalInteger(args.startByte, 'startByte'),
            maxBytes: optionalInteger(args.maxBytes, 'maxBytes'),
          })
        );
      case 'review_list_directory':
        return response(
          await gateway.listDirectory({
            path: requireString(args.path, 'path'),
            maxDepth: optionalInteger(args.maxDepth, 'maxDepth'),
            includeHidden: optionalBoolean(args.includeHidden, 'includeHidden'),
            maxEntries: optionalInteger(args.maxEntries, 'maxEntries'),
          })
        );
      case 'review_search_text':
        return response(
          await gateway.searchText({
            query: requireString(args.query, 'query'),
            paths: optionalStringArray(args.paths, 'paths'),
            maxResults: optionalInteger(args.maxResults, 'maxResults'),
            caseSensitive: optionalBoolean(args.caseSensitive, 'caseSensitive'),
          })
        );
      case 'review_git_fact':
        return response(
          await gateway.gitFact({
            fact: requireGitFact(args.fact),
          })
        );
      default:
        throw new Error('context_gateway_tool_unknown');
    }
  });

  await server.connect(new StdioServerTransport());
}

async function runV4(
  config: ReturnType<typeof readConfig>,
  preflightOnly: boolean
): Promise<void> {
  const secret = Buffer.from(config.secret, 'base64url');
  const recorder = new ContextGatewayV4Recorder({
    sessionId: config.sessionId,
    transcriptPath: config.transcriptPath,
    secret,
    gatewayBinaryHash: config.gatewayBinaryHash,
    checkoutTreeOid: config.checkoutTreeOid,
    eventChainSeedHash: config.eventChainSeedHash,
  });
  const replayMaterial = new ContextGatewayV4ReplayMaterialRecorder({
    sessionId: config.sessionId,
    replayMaterialPath: config.replayMaterialPath,
    secret,
  });
  if (preflightOnly) {
    await recorder.initialize();
    await replayMaterial.initialize();
  } else {
    await recorder.resume();
    await replayMaterial.resume();
  }
  const gateway = await FilesystemContextGatewayV4.create({
    root: config.root,
    sessionId: config.sessionId,
    checkoutTreeOid: config.checkoutTreeOid,
    mergeBaseSha: config.mergeBaseSha,
    headSha: config.headSha,
    secret,
    recorder,
    replayMaterial,
  });
  if (preflightOnly) {
    let cursor: string | undefined;
    do {
      const page = await gateway.canonicalInventory({
        pageSize: 2_000,
        cursor,
      });
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    await gateway.gitFact({ fact: 'merge_base' });
    return;
  }

  const server = new Server(
    {
      name: 'reviewrouter-context-gateway',
      version: CONTEXT_GATEWAY_V4_POLICY_VERSION,
    },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: CONTEXT_GATEWAY_V4_TOOL_DEFINITIONS,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    switch (request.params.name) {
      case 'review_read_file': {
        const requestInput = await parseContextGatewayV4Request({
          recorder,
          operationKind: ContextGatewayV4OperationKind.FileRead,
          argumentsValue: request.params.arguments,
          parse: (args) => ({
            path: requireString(args.path, 'path'),
            revision: optionalRevision(args.revision),
            startByte: optionalInteger(args.startByte, 'startByte'),
            maxBytes: optionalInteger(args.maxBytes, 'maxBytes'),
          }),
        });
        return response(await gateway.readFile(requestInput));
      }
      case 'review_list_directory': {
        const requestInput = await parseContextGatewayV4Request({
          recorder,
          operationKind: ContextGatewayV4OperationKind.DirectoryList,
          argumentsValue: request.params.arguments,
          parse: (args) => ({
            path: requireString(args.path, 'path'),
            revision: optionalRevision(args.revision),
            maxDepth: optionalInteger(args.maxDepth, 'maxDepth'),
            includeHidden: optionalBoolean(args.includeHidden, 'includeHidden'),
            pageSize: optionalInteger(args.pageSize, 'pageSize'),
            cursor: optionalString(args.cursor, 'cursor'),
          }),
        });
        return response(await gateway.listDirectory(requestInput));
      }
      case 'review_search_text': {
        const requestInput = await parseContextGatewayV4Request({
          recorder,
          operationKind: ContextGatewayV4OperationKind.TextSearch,
          argumentsValue: request.params.arguments,
          parse: (args) => ({
            query: requireString(args.query, 'query'),
            paths: optionalStringArray(args.paths, 'paths'),
            revision: optionalRevision(args.revision),
            caseSensitive: optionalBoolean(args.caseSensitive, 'caseSensitive'),
            pageSize: optionalInteger(args.pageSize, 'pageSize'),
            cursor: optionalString(args.cursor, 'cursor'),
          }),
        });
        return response(await gateway.searchText(requestInput));
      }
      case 'review_canonical_inventory': {
        const requestInput = await parseContextGatewayV4Request({
          recorder,
          operationKind: ContextGatewayV4OperationKind.CanonicalInventory,
          argumentsValue: request.params.arguments,
          parse: (args) => ({
            pageSize: optionalInteger(args.pageSize, 'pageSize'),
            cursor: optionalString(args.cursor, 'cursor'),
          }),
        });
        return response(await gateway.canonicalInventory(requestInput));
      }
      case 'review_git_fact': {
        const requestInput = await parseContextGatewayV4Request({
          recorder,
          operationKind: ContextGatewayV4OperationKind.GitFact,
          argumentsValue: request.params.arguments,
          parse: (args) => ({ fact: requireGitFact(args.fact) }),
        });
        return response(await gateway.gitFact(requestInput));
      }
      default:
        await recorder.recordRejected({
          operation: {
            kind: ContextGatewayV4OperationKind.UnsupportedTool,
            requestedToolHash: sha256(request.params.name),
          },
          failureClass: ContextOperationFailureClass.ConfinementViolation,
          sanitizedReason: 'context_gateway_tool_unknown',
        });
        throw new Error('context_gateway_tool_unknown');
    }
  });
  await server.connect(new StdioServerTransport());
}

enum ContextGatewayMode {
  Serve = 'serve',
  Preflight = 'preflight',
  Describe = 'describe',
}

function readMode(args: readonly string[]): ContextGatewayMode {
  if (args.length === 0) return ContextGatewayMode.Serve;
  if (args.length === 1 && args[0] === '--preflight') {
    return ContextGatewayMode.Preflight;
  }
  if (args.length === 1 && args[0] === '--describe') {
    return ContextGatewayMode.Describe;
  }
  throw new Error('context_gateway_mode_invalid');
}

function response(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  };
}

function readConfig() {
  const config = {
    policyVersion: readPolicyVersion(
      process.env.REVIEWROUTER_CONTEXT_GATEWAY_POLICY_VERSION
    ),
    sessionId: requiredEnv('REVIEWROUTER_CONTEXT_SESSION_ID'),
    root: requiredEnv('REVIEWROUTER_CONTEXT_ROOT'),
    transcriptPath: requiredEnv('REVIEWROUTER_CONTEXT_TRANSCRIPT_PATH'),
    replayMaterialPath: requiredEnv(
      'REVIEWROUTER_CONTEXT_REPLAY_MATERIAL_PATH'
    ),
    secret: requiredEnv('REVIEWROUTER_CONTEXT_GATEWAY_SECRET'),
    gatewayBinaryHash: requireSha256(
      requiredEnv('REVIEWROUTER_CONTEXT_GATEWAY_BINARY_HASH'),
      'gateway_binary_hash'
    ),
    checkoutTreeOid: requireGitOid(
      requiredEnv('REVIEWROUTER_CONTEXT_CHECKOUT_TREE_OID'),
      'checkout_tree_oid'
    ),
    eventChainSeedHash: requireSha256(
      requiredEnv('REVIEWROUTER_CONTEXT_EVENT_CHAIN_SEED_HASH'),
      'event_chain_seed_hash'
    ),
    baseSha: requireGitOid(
      requiredEnv('REVIEWROUTER_CONTEXT_BASE_SHA'),
      'base_sha'
    ),
    mergeBaseSha: requireGitOid(
      requiredEnv('REVIEWROUTER_CONTEXT_MERGE_BASE_SHA'),
      'merge_base_sha'
    ),
    headSha: requireGitOid(
      requiredEnv('REVIEWROUTER_CONTEXT_HEAD_SHA'),
      'head_sha'
    ),
  };
  if (Buffer.from(config.secret, 'base64url').byteLength < 32) {
    throw new Error('context_gateway_secret_invalid');
  }
  return config;
}

function readPolicyVersion(
  value: string | undefined
):
  | typeof CONTEXT_GATEWAY_POLICY_VERSION
  | typeof CONTEXT_GATEWAY_V4_POLICY_VERSION {
  if (value === undefined) {
    return CONTEXT_GATEWAY_OMITTED_POLICY_FALLBACK_VERSION;
  }
  if (value === CONTEXT_GATEWAY_POLICY_VERSION) {
    return CONTEXT_GATEWAY_POLICY_VERSION;
  }
  if (value === CONTEXT_GATEWAY_V4_POLICY_VERSION) {
    return CONTEXT_GATEWAY_V4_POLICY_VERSION;
  }
  throw new Error('context_gateway_policy_version_invalid');
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('context_gateway_tool_arguments_invalid');
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`context_gateway_${field}_invalid`);
  }
  return value;
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`context_gateway_${field}_invalid`);
  }
  return value as number;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`context_gateway_${field}_invalid`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function optionalRevision(
  value: unknown
): ContextGatewayV4Revision | undefined {
  if (value === undefined) return undefined;
  if (
    value !== ContextGatewayV4Revision.Head &&
    value !== ContextGatewayV4Revision.MergeBase
  ) {
    throw new Error('context_gateway_revision_invalid');
  }
  return value;
}

function optionalStringArray(
  value: unknown,
  field: string
): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string')
  ) {
    throw new Error(`context_gateway_${field}_invalid`);
  }
  return value;
}

function requireGitFact(
  value: unknown
): 'changed_paths' | 'diff_stat' | 'merge_base' {
  if (
    value !== 'changed_paths' &&
    value !== 'diff_stat' &&
    value !== 'merge_base'
  ) {
    throw new Error('context_gateway_git_fact_invalid');
  }
  return value;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name.toLowerCase()}_missing`);
  return value;
}

main().catch((error) => {
  process.stderr.write(
    `ReviewRouter context gateway failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`
  );
  process.exitCode = 1;
});
