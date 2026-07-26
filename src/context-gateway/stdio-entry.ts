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
} from './context-gateway-contract';
import { ContextGatewayRecorder } from './context-gateway-recorder';
import { CONTEXT_GATEWAY_TOOL_DEFINITIONS } from './context-gateway-tool-definitions';
import { FilesystemContextGateway } from './filesystem-context-gateway';
import { captureRequiredContextWitness } from './required-context-witness';

async function main(): Promise<void> {
  const mode = readMode(process.argv.slice(2));
  if (mode === ContextGatewayMode.Describe) {
    process.stdout.write(
      `${JSON.stringify({
        artifactKind: 'reviewrouter-context-gateway',
        contextGatewayPolicyVersion: CONTEXT_GATEWAY_POLICY_VERSION,
        metadataVersion: 1,
      })}\n`
    );
    return;
  }
  const config = readConfig();
  const preflightOnly = mode === ContextGatewayMode.Preflight;
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
