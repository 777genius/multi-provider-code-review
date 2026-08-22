import { timingSafeEqual } from 'crypto';
import {
  canonicalJson,
  keyedSha256,
  requireGitOid,
  requireSha256,
  sha256,
} from './context-gateway-contract';

export const CONTEXT_GATEWAY_V4_POLICY_VERSION = 'context-gateway-v4' as const;
export const CONTEXT_GATEWAY_V4_CURSOR_VERSION = 1 as const;
export const CONTEXT_GATEWAY_V4_PAGE_MAX_ITEMS = 2_000;
export const CONTEXT_GATEWAY_V4_RELATION_PATH_MAX_ITEMS = 512;
export const CONTEXT_GATEWAY_V4_CURSOR_MAX_LIFETIME_MS = 15 * 60 * 1_000;
export const CONTEXT_GATEWAY_V4_ENABLED_TOOLS = Object.freeze([
  'review_read_file',
  'review_list_directory',
  'review_search_text',
  'review_canonical_inventory',
  'review_git_fact',
]);

export enum ContextOperationOutcomeKind {
  Succeeded = 'succeeded',
  Rejected = 'rejected',
  Failed = 'failed',
}

export enum ContextOperationFailureClass {
  RecoverableRequest = 'recoverable_request',
  IncompleteResult = 'incomplete_result',
  ConfinementViolation = 'confinement_violation',
  InfrastructureFailure = 'infrastructure_failure',
  BudgetExceeded = 'budget_exceeded',
}

export enum ContextGatewayV4OperationKind {
  FileRead = 'file_read',
  DirectoryList = 'directory_list',
  TextSearch = 'text_search',
  CanonicalInventory = 'canonical_inventory',
  GitFact = 'git_fact',
  UnsupportedTool = 'unsupported_tool',
}

export enum ContextGatewayV4Revision {
  Head = 'head',
  MergeBase = 'merge_base',
}

export type ContextGatewayV4CursorPayload = Readonly<{
  cursorVersion: typeof CONTEXT_GATEWAY_V4_CURSOR_VERSION;
  sessionId: string;
  operationKind: ContextGatewayV4OperationKind;
  treeOid: string;
  policyVersion: typeof CONTEXT_GATEWAY_V4_POLICY_VERSION;
  queryDigest: string;
  pageSize: number;
  nextOffset: number;
  expiresAtMs: number;
}>;

export type ContextGatewayV4PageReceipt = Readonly<{
  operationReceiptId: string;
  operationKind: ContextGatewayV4OperationKind;
  cursorInputHash: string | null;
  pageOrdinal: number;
  pageItemCount: number;
  pageItemsHash: string;
  pagePathHashes: readonly string[];
  aggregatePathCount: number;
  aggregatePathSetHash: string;
  aggregateItemCount: number;
  aggregateHash: string;
  complete: boolean;
  nextCursor: string | null;
}>;

export type ContextGatewayV4OutcomeEvent = Readonly<{
  outcome: ContextOperationOutcomeKind;
  failureClass: ContextOperationFailureClass | null;
  operationKind: ContextGatewayV4OperationKind;
  operationReceiptId: string | null;
  sanitizedReason: string | null;
}>;

export function encodeContextGatewayV4Cursor(input: {
  readonly secret: Buffer;
  readonly payload: ContextGatewayV4CursorPayload;
}): string {
  assertSecret(input.secret);
  assertCursorPayload(input.payload);
  const encoded = Buffer.from(canonicalJson(input.payload), 'utf8').toString(
    'base64url'
  );
  return `${encoded}.${keyedSha256(input.secret, encoded)}`;
}

export function decodeContextGatewayV4Cursor(input: {
  readonly secret: Buffer;
  readonly cursor: string;
  readonly expected: Omit<
    ContextGatewayV4CursorPayload,
    'cursorVersion' | 'nextOffset' | 'expiresAtMs'
  >;
  readonly nowMs: number;
}): ContextGatewayV4CursorPayload {
  assertSecret(input.secret);
  if (
    typeof input.cursor !== 'string' ||
    input.cursor.length < 80 ||
    input.cursor.length > 2_048
  ) {
    throw new Error('context_gateway_cursor_invalid');
  }
  const [encoded, signature, extra] = input.cursor.split('.');
  if (!encoded || !signature || extra !== undefined || !isSha256(signature)) {
    throw new Error('context_gateway_cursor_invalid');
  }
  const expectedSignature = keyedSha256(input.secret, encoded);
  if (
    !timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    )
  ) {
    throw new Error('context_gateway_cursor_tampered');
  }
  let parsed: unknown;
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    parsed = JSON.parse(decoded);
    if (canonicalJson(parsed) !== decoded) {
      throw new Error('non_canonical');
    }
  } catch {
    throw new Error('context_gateway_cursor_invalid');
  }
  const payload = parsed as ContextGatewayV4CursorPayload;
  assertCursorPayload(payload);
  if (
    payload.sessionId !== input.expected.sessionId ||
    payload.operationKind !== input.expected.operationKind ||
    payload.treeOid !== input.expected.treeOid ||
    payload.policyVersion !== input.expected.policyVersion ||
    payload.queryDigest !== input.expected.queryDigest ||
    payload.pageSize !== input.expected.pageSize
  ) {
    throw new Error('context_gateway_cursor_scope_mismatch');
  }
  if (payload.expiresAtMs <= input.nowMs) {
    throw new Error('context_gateway_cursor_expired');
  }
  return Object.freeze({ ...payload });
}

export function createContextGatewayV4PageReceipt<T>(input: {
  readonly secret: Buffer;
  readonly sessionId: string;
  readonly operationKind: ContextGatewayV4OperationKind;
  readonly operationKey: string;
  readonly queryDigest: string;
  readonly treeOid: string;
  readonly pageSize: number;
  readonly offset: number;
  readonly allItems: readonly T[];
  readonly cursorInputHash: string | null;
  readonly allItemPathHashes: readonly string[];
  readonly nowMs: number;
}): ContextGatewayV4PageReceipt {
  assertSecret(input.secret);
  requireGitOid(input.treeOid, 'context_gateway_page_tree_oid');
  requireSha256(input.operationKey, 'context_gateway_page_operation_key');
  requireSha256(input.queryDigest, 'context_gateway_page_query_digest');
  assertPageSize(input.pageSize);
  if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
    throw new Error('context_gateway_page_offset_invalid');
  }
  if (
    input.cursorInputHash !== null &&
    !/^[a-f0-9]{64}$/u.test(input.cursorInputHash)
  ) {
    throw new Error('context_gateway_page_cursor_hash_invalid');
  }
  const allItemPathHashes = [...new Set(input.allItemPathHashes)].sort();
  if (
    allItemPathHashes.length > 250_000 ||
    allItemPathHashes.length > input.allItems.length ||
    allItemPathHashes.some((value) => !/^[a-f0-9]{64}$/u.test(value))
  ) {
    throw new Error('context_gateway_page_path_hashes_invalid');
  }
  const page = input.allItems.slice(
    input.offset,
    input.offset + input.pageSize
  );
  const nextOffset = input.offset + page.length;
  const complete = nextOffset >= input.allItems.length;
  const pageOrdinal = Math.floor(input.offset / input.pageSize);
  const aggregateItems = input.allItems.slice(0, nextOffset);
  const pagePathHashes = allItemPathHashes.slice(
    input.offset,
    input.offset + input.pageSize
  );
  const aggregatePathHashes = allItemPathHashes.slice(0, nextOffset);
  const receiptIdentity = {
    sessionId: input.sessionId,
    operationKind: input.operationKind,
    operationKey: input.operationKey,
    queryDigest: input.queryDigest,
    treeOid: input.treeOid,
    pageSize: input.pageSize,
    pageOrdinal,
    cursorInputHash: input.cursorInputHash,
    pageItemCount: page.length,
    pageItemsHash: sha256(canonicalJson(page)),
    pagePathHashes,
    aggregatePathCount: aggregatePathHashes.length,
    aggregatePathSetHash: sha256(canonicalJson(aggregatePathHashes)),
    aggregateItemCount: aggregateItems.length,
    aggregateHash: sha256(canonicalJson(aggregateItems)),
    complete,
  };
  return Object.freeze({
    operationReceiptId: keyedSha256(
      input.secret,
      canonicalJson(receiptIdentity)
    ),
    operationKind: input.operationKind,
    cursorInputHash: input.cursorInputHash,
    pageOrdinal,
    pageItemCount: page.length,
    pageItemsHash: receiptIdentity.pageItemsHash,
    pagePathHashes: Object.freeze(pagePathHashes),
    aggregatePathCount: receiptIdentity.aggregatePathCount,
    aggregatePathSetHash: receiptIdentity.aggregatePathSetHash,
    aggregateItemCount: aggregateItems.length,
    aggregateHash: receiptIdentity.aggregateHash,
    complete,
    nextCursor: complete
      ? null
      : encodeContextGatewayV4Cursor({
          secret: input.secret,
          payload: {
            cursorVersion: CONTEXT_GATEWAY_V4_CURSOR_VERSION,
            sessionId: input.sessionId,
            operationKind: input.operationKind,
            treeOid: input.treeOid,
            policyVersion: CONTEXT_GATEWAY_V4_POLICY_VERSION,
            queryDigest: input.queryDigest,
            pageSize: input.pageSize,
            nextOffset,
            expiresAtMs:
              input.nowMs + CONTEXT_GATEWAY_V4_CURSOR_MAX_LIFETIME_MS,
          },
        }),
  });
}

export function verifyCompleteContextGatewayV4PageChain(
  pages: readonly ContextGatewayV4PageReceipt[]
): void {
  if (pages.length === 0) {
    throw new Error('context_gateway_page_chain_empty');
  }
  let aggregateCount = 0;
  let terminalSeen = false;
  let expectedCursorInputHash: string | null = null;
  const aggregatePathHashes = new Set<string>();
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    if (
      terminalSeen ||
      page.pageOrdinal !== index ||
      page.cursorInputHash !== expectedCursorInputHash ||
      page.aggregateItemCount !== aggregateCount + page.pageItemCount ||
      !isSha256(page.pageItemsHash) ||
      !isSha256(page.aggregateHash) ||
      !isSha256(page.aggregatePathSetHash) ||
      !isSha256(page.operationReceiptId) ||
      page.pagePathHashes.length > CONTEXT_GATEWAY_V4_PAGE_MAX_ITEMS ||
      page.pagePathHashes.some((value) => !isSha256(value)) ||
      new Set(page.pagePathHashes).size !== page.pagePathHashes.length ||
      (page.complete ? page.nextCursor !== null : page.nextCursor === null)
    ) {
      throw new Error('context_gateway_page_chain_invalid');
    }
    for (const pathHash of page.pagePathHashes) {
      if (aggregatePathHashes.has(pathHash)) {
        throw new Error('context_gateway_page_chain_invalid');
      }
      aggregatePathHashes.add(pathHash);
    }
    if (page.aggregatePathCount !== aggregatePathHashes.size) {
      throw new Error('context_gateway_page_chain_invalid');
    }
    aggregateCount = page.aggregateItemCount;
    terminalSeen = page.complete;
    expectedCursorInputHash = page.nextCursor ? sha256(page.nextCursor) : null;
  }
  if (!terminalSeen) {
    throw new Error('context_gateway_page_chain_incomplete');
  }
}

export function classifyContextGatewayV4Failure(
  error: unknown
): ContextOperationFailureClass {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /(?:path_invalid|cursor_(?:tampered|scope_mismatch)|tool_unknown|unauthorized|escape)/u.test(
      message
    )
  ) {
    return ContextOperationFailureClass.ConfinementViolation;
  }
  if (/(?:limit_exceeded|budget|too_large)/u.test(message)) {
    return ContextOperationFailureClass.BudgetExceeded;
  }
  if (/(?:truncated|incomplete|cursor_expired)/u.test(message)) {
    return ContextOperationFailureClass.IncompleteResult;
  }
  if (/(?:invalid|missing|not_in_.*tree)/u.test(message)) {
    return ContextOperationFailureClass.RecoverableRequest;
  }
  return ContextOperationFailureClass.InfrastructureFailure;
}

function assertCursorPayload(payload: ContextGatewayV4CursorPayload): void {
  if (
    payload.cursorVersion !== CONTEXT_GATEWAY_V4_CURSOR_VERSION ||
    payload.policyVersion !== CONTEXT_GATEWAY_V4_POLICY_VERSION ||
    typeof payload.sessionId !== 'string' ||
    payload.sessionId.length < 1 ||
    payload.sessionId.length > 255 ||
    !Object.values(ContextGatewayV4OperationKind).includes(
      payload.operationKind
    ) ||
    !Number.isSafeInteger(payload.nextOffset) ||
    payload.nextOffset < 0 ||
    !Number.isSafeInteger(payload.expiresAtMs) ||
    payload.expiresAtMs < 0
  ) {
    throw new Error('context_gateway_cursor_payload_invalid');
  }
  requireGitOid(payload.treeOid, 'context_gateway_cursor_tree_oid');
  requireSha256(payload.queryDigest, 'context_gateway_cursor_query_digest');
  assertPageSize(payload.pageSize);
}

function assertSecret(secret: Buffer): void {
  if (!Buffer.isBuffer(secret) || secret.byteLength < 32) {
    throw new Error('context_gateway_cursor_secret_invalid');
  }
}

function assertPageSize(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > CONTEXT_GATEWAY_V4_PAGE_MAX_ITEMS
  ) {
    throw new Error('context_gateway_page_size_invalid');
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
