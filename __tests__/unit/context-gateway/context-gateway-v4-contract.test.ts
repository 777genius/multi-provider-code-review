import {
  CONTEXT_GATEWAY_V4_POLICY_VERSION,
  ContextGatewayV4OperationKind,
  ContextOperationFailureClass,
  classifyContextGatewayV4Failure,
  createContextGatewayV4PageReceipt,
  decodeContextGatewayV4Cursor,
  verifyCompleteContextGatewayV4PageChain,
} from '../../../src/context-gateway/context-gateway-v4-contract';
import { sha256 } from '../../../src/context-gateway/context-gateway-contract';

const secret = Buffer.alloc(32, 7);
const sessionId = 'gateway-v4-session';
const treeOid = 'a'.repeat(40);
const queryDigest = sha256('query');

describe('Context Gateway v4 contract', () => {
  it('binds cursors to session, tree, operation, query, and page size', () => {
    const first = page(0);
    expect(first.complete).toBe(false);
    const payload = decodeContextGatewayV4Cursor({
      secret,
      cursor: requireCursor(first.nextCursor),
      expected: {
        sessionId,
        operationKind: ContextGatewayV4OperationKind.DirectoryList,
        treeOid,
        policyVersion: CONTEXT_GATEWAY_V4_POLICY_VERSION,
        queryDigest,
        pageSize: 2,
      },
      nowMs: 1_001,
    });
    expect(payload.nextOffset).toBe(2);

    expect(() =>
      decodeContextGatewayV4Cursor({
        secret,
        cursor: requireCursor(first.nextCursor),
        expected: {
          sessionId: 'other-session',
          operationKind: ContextGatewayV4OperationKind.DirectoryList,
          treeOid,
          policyVersion: CONTEXT_GATEWAY_V4_POLICY_VERSION,
          queryDigest,
          pageSize: 2,
        },
        nowMs: 1_001,
      })
    ).toThrow('context_gateway_cursor_scope_mismatch');

    const originalCursor = requireCursor(first.nextCursor);
    const tampered = `${originalCursor.slice(0, -1)}${originalCursor.endsWith('0') ? '1' : '0'}`;
    expect(() =>
      decodeContextGatewayV4Cursor({
        secret,
        cursor: tampered,
        expected: {
          sessionId,
          operationKind: ContextGatewayV4OperationKind.DirectoryList,
          treeOid,
          policyVersion: CONTEXT_GATEWAY_V4_POLICY_VERSION,
          queryDigest,
          pageSize: 2,
        },
        nowMs: 1_001,
      })
    ).toThrow('context_gateway_cursor_tampered');
  });

  it('requires an ordered terminal page chain', () => {
    const first = page(0);
    const second = page(2, sha256(requireCursor(first.nextCursor)));
    const third = page(4, sha256(requireCursor(second.nextCursor)));
    const pages = [first, second, third];
    expect(() => verifyCompleteContextGatewayV4PageChain(pages)).not.toThrow();
    expect(() =>
      verifyCompleteContextGatewayV4PageChain([pages[1], pages[0], pages[2]])
    ).toThrow('context_gateway_page_chain_invalid');
    expect(() =>
      verifyCompleteContextGatewayV4PageChain(pages.slice(0, 2))
    ).toThrow('context_gateway_page_chain_incomplete');
  });

  it('rejects path membership claims larger than the result set', () => {
    expect(() =>
      createContextGatewayV4PageReceipt({
        secret,
        sessionId,
        operationKind: ContextGatewayV4OperationKind.TextSearch,
        operationKey: sha256('text-search-operation'),
        queryDigest,
        treeOid,
        pageSize: 2,
        offset: 0,
        allItems: ['single-match'],
        cursorInputHash: null,
        allItemPathHashes: [sha256('one'), sha256('two')],
        nowMs: 1_000,
      })
    ).toThrow('context_gateway_page_path_hashes_invalid');
  });

  it('classifies confinement, incomplete, recoverable, and infrastructure failures', () => {
    expect(
      classifyContextGatewayV4Failure(new Error('context_gateway_path_invalid'))
    ).toBe(ContextOperationFailureClass.ConfinementViolation);
    expect(
      classifyContextGatewayV4Failure(
        new Error('context_gateway_cursor_expired')
      )
    ).toBe(ContextOperationFailureClass.IncompleteResult);
    expect(
      classifyContextGatewayV4Failure(new Error('context_gateway_file_missing'))
    ).toBe(ContextOperationFailureClass.RecoverableRequest);
    expect(
      classifyContextGatewayV4Failure(new Error('git_process_crashed'))
    ).toBe(ContextOperationFailureClass.InfrastructureFailure);
  });
});

function page(offset: number, cursorInputHash: string | null = null) {
  return createContextGatewayV4PageReceipt({
    secret,
    sessionId,
    operationKind: ContextGatewayV4OperationKind.DirectoryList,
    operationKey: sha256('directory-list-operation'),
    queryDigest,
    treeOid,
    pageSize: 2,
    offset,
    allItems: ['a', 'b', 'c', 'd', 'e'],
    cursorInputHash,
    allItemPathHashes: [],
    nowMs: 1_000,
  });
}

function requireCursor(value: string | null): string {
  if (value === null) throw new Error('test_cursor_missing');
  return value;
}
