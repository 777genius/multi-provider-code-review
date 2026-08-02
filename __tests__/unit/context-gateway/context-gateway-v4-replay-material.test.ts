import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  canonicalJson,
  sha256,
} from '../../../src/context-gateway/context-gateway-contract';
import { ContextGatewayV4OperationKind } from '../../../src/context-gateway/context-gateway-v4-contract';
import { ContextGatewayV4Recorder } from '../../../src/context-gateway/context-gateway-v4-recorder';
import {
  ContextGatewayV4ReplayMaterialRecorder,
  operationForReplayInput,
} from '../../../src/context-gateway/context-gateway-v4-replay-material';

describe('ContextGatewayV4ReplayMaterialRecorder', () => {
  it('persists private successful inputs and resumes their exact receipt binding', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'rr-v4-replay-material-')
    );
    const transcriptPath = path.join(root, 'transcript.json');
    const replayMaterialPath = path.join(root, 'replay-material.json');
    try {
      const recorder = new ContextGatewayV4Recorder({
        sessionId: 'session-v4-replay',
        transcriptPath,
        secret: Buffer.alloc(32, 7),
        gatewayBinaryHash: sha256('binary'),
        checkoutTreeOid: 'a'.repeat(40),
        eventChainSeedHash: sha256('seed'),
      });
      const material = new ContextGatewayV4ReplayMaterialRecorder({
        sessionId: 'session-v4-replay',
        replayMaterialPath,
      });
      await Promise.all([recorder.initialize(), material.initialize()]);
      const replayInput = Object.freeze({
        query: 'private query',
        paths: ['src'],
        pageSize: 100,
      });
      const operation = Object.freeze({
        kind: ContextGatewayV4OperationKind.TextSearch,
        inputHash: sha256(
          canonicalJson({
            ...replayInput,
            query: sha256(replayInput.query),
            cursor: null,
          })
        ),
      });
      expect(sha256(canonicalJson(operation))).toBe(
        operationForReplayInput(
          ContextGatewayV4OperationKind.TextSearch,
          replayInput
        )
      );
      const event = await recorder.recordSucceeded({
        operation,
        result: { complete: true },
        operationReceiptId: sha256('receipt'),
      });
      await material.recordSucceeded({ event, replayInput });

      const restored = new ContextGatewayV4ReplayMaterialRecorder({
        sessionId: 'session-v4-replay',
        replayMaterialPath,
      });
      await restored.resume();
      expect(restored.snapshot()).toEqual(material.snapshot());
      expect((await stat(replayMaterialPath)).mode & 0o777).toBe(0o600);
      expect(await readFile(replayMaterialPath, 'utf8')).toContain(
        'private query'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
