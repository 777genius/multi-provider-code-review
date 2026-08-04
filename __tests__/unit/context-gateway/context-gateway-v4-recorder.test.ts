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

describe('ContextGatewayV4Recorder', () => {
  it('accepts a recoverable rejection followed by authenticated success and restores exactly', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'rr-gateway-v4-recorder-')
    );
    const transcriptPath = path.join(root, 'transcript.json');
    try {
      const recorder = createRecorder(transcriptPath);
      await recorder.initialize();
      await recorder.recordRejected({
        operation: {
          kind: ContextGatewayV4OperationKind.FileRead,
          pathHash: sha256('missing'),
        },
        failureClass: ContextOperationFailureClass.RecoverableRequest,
        sanitizedReason: 'file_missing',
      });
      await recorder.recordSucceeded({
        operation: {
          kind: ContextGatewayV4OperationKind.FileRead,
          pathHash: sha256('present'),
        },
        result: { blobOid: 'b'.repeat(40), complete: true },
        operationReceiptId: sha256('receipt'),
      });
      expect(recorder.snapshot()).toMatchObject({
        confinementTainted: false,
        terminalFailureClass: null,
        events: [
          { outcome: ContextOperationOutcomeKind.Rejected },
          { outcome: ContextOperationOutcomeKind.Succeeded },
        ],
      });

      const restored = createRecorder(transcriptPath);
      await restored.resume();
      expect(restored.snapshot().events).toEqual(recorder.snapshot().events);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('taints the session after a confinement violation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rr-gateway-v4-taint-'));
    const transcriptPath = path.join(root, 'transcript.json');
    try {
      const recorder = createRecorder(transcriptPath);
      await recorder.initialize();
      await recorder.recordRejected({
        operation: {
          kind: ContextGatewayV4OperationKind.FileRead,
          pathHash: sha256('../escape'),
        },
        failureClass: ContextOperationFailureClass.ConfinementViolation,
        sanitizedReason: 'path_escape',
      });
      await expect(
        recorder.recordSucceeded({
          operation: { kind: ContextGatewayV4OperationKind.FileRead },
          result: { complete: true },
          operationReceiptId: sha256('late'),
        })
      ).rejects.toThrow('context_gateway_v4_session_tainted');
      expect(recorder.snapshot().confinementTainted).toBe(true);
      expect(
        (await readFile(transcriptPath, 'utf8')).includes('../escape')
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('folds an identical successful receipt and rejects receipt collisions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rr-gateway-v4-retry-'));
    const transcriptPath = path.join(root, 'transcript.json');
    try {
      const recorder = createRecorder(transcriptPath);
      await recorder.initialize();
      const input = {
        operation: {
          kind: ContextGatewayV4OperationKind.FileRead,
          pathHash: sha256('stable'),
        },
        result: { blobOid: 'b'.repeat(40), complete: true },
        operationReceiptId: sha256('stable-receipt'),
      } as const;

      const first = await recorder.recordSucceeded(input);
      const retried = await recorder.recordSucceeded(input);

      expect(retried).toBe(first);
      expect(recorder.snapshot().events).toHaveLength(1);
      await expect(
        recorder.recordSucceeded({
          ...input,
          result: { blobOid: 'c'.repeat(40), complete: true },
        })
      ).rejects.toThrow('context_gateway_v4_operation_receipt_collision');
      expect(recorder.snapshot().events).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function createRecorder(transcriptPath: string) {
  return new ContextGatewayV4Recorder({
    sessionId: 'session-v4',
    transcriptPath,
    secret: Buffer.alloc(32, 3),
    gatewayBinaryHash: sha256('binary'),
    checkoutTreeOid: 'a'.repeat(40),
    eventChainSeedHash: sha256('seed'),
    now: () => 1_000,
  });
}
