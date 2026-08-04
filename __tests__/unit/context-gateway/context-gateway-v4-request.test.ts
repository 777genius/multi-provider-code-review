import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { sha256 } from '../../../src/context-gateway/context-gateway-contract';
import {
  ContextGatewayV4OperationKind,
  ContextOperationFailureClass,
  ContextOperationOutcomeKind,
} from '../../../src/context-gateway/context-gateway-v4-contract';
import { ContextGatewayV4Recorder } from '../../../src/context-gateway/context-gateway-v4-recorder';
import { parseContextGatewayV4Request } from '../../../src/context-gateway/context-gateway-v4-request';

describe('parseContextGatewayV4Request', () => {
  it('records malformed arguments without persisting their values', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'rr-gateway-v4-request-')
    );
    const transcriptPath = path.join(root, 'transcript.json');
    try {
      const recorder = new ContextGatewayV4Recorder({
        sessionId: 'request-session',
        transcriptPath,
        secret: Buffer.alloc(32, 7),
        gatewayBinaryHash: sha256('binary'),
        checkoutTreeOid: 'a'.repeat(40),
        eventChainSeedHash: sha256('seed'),
      });
      await recorder.initialize();

      await expect(
        parseContextGatewayV4Request({
          recorder,
          operationKind: ContextGatewayV4OperationKind.TextSearch,
          argumentsValue: { query: 'SECRET_QUERY', pageSize: 'not-an-integer' },
          parse: () => {
            throw new Error('context_gateway_page_size_invalid');
          },
        })
      ).rejects.toThrow('context_gateway_page_size_invalid');

      expect(recorder.snapshot().events).toMatchObject([
        {
          operationKind: ContextGatewayV4OperationKind.TextSearch,
          outcome: ContextOperationOutcomeKind.Rejected,
          failureClass: ContextOperationFailureClass.RecoverableRequest,
          sanitizedReason: 'context_gateway_tool_arguments_invalid',
        },
      ]);
      expect(await readFile(transcriptPath, 'utf8')).not.toContain(
        'SECRET_QUERY'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
