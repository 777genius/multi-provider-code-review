import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
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
  decryptContextGatewayV4ReplayMaterial,
  operationForReplayInput,
} from '../../../src/context-gateway/context-gateway-v4-replay-material';

describe('ContextGatewayV4ReplayMaterialRecorder', () => {
  it('persists private successful inputs and resumes their exact receipt binding', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'rr-v4-replay-material-')
    );
    const transcriptPath = path.join(root, 'transcript.json');
    const replayMaterialPath = path.join(root, 'replay-material.json');
    const secret = Buffer.alloc(32, 7);
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
        secret,
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
      await material.recordSucceeded({ event, replayInput });
      expect(material.snapshot().entries).toHaveLength(1);
      await expect(
        material.recordSucceeded({
          event,
          replayInput: { ...replayInput, pageSize: 10 },
        })
      ).rejects.toThrow('context_gateway_v4_replay_receipt_collision');

      const restored = new ContextGatewayV4ReplayMaterialRecorder({
        sessionId: 'session-v4-replay',
        replayMaterialPath,
        secret,
      });
      await restored.resume();
      expect(restored.snapshot()).toEqual(material.snapshot());
      expect((await stat(replayMaterialPath)).mode & 0o777).toBe(0o600);
      const encrypted = await readFile(replayMaterialPath, 'utf8');
      expect(encrypted).not.toContain('private query');
      expect(JSON.parse(encrypted)).toMatchObject({
        encryptionVersion: 1,
        algorithm: 'aes-256-gcm',
        sessionId: 'session-v4-replay',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects tampering and replay under a different secret or session', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'rr-v4-replay-material-negative-')
    );
    const replayMaterialPath = path.join(root, 'replay-material.json');
    const secret = Buffer.alloc(32, 11);
    try {
      const material = new ContextGatewayV4ReplayMaterialRecorder({
        sessionId: 'session-v4-negative',
        replayMaterialPath,
        secret,
      });
      await material.initialize();
      const encrypted = await readFile(replayMaterialPath, 'utf8');
      const envelope = JSON.parse(encrypted) as Record<string, string | number>;
      const ciphertext = Buffer.from(String(envelope.ciphertext), 'base64url');
      ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
      const tampered = canonicalJson({
        ...envelope,
        ciphertext: ciphertext.toString('base64url'),
      });

      expect(() =>
        decryptContextGatewayV4ReplayMaterial({
          encryptedCanonicalJson: tampered,
          secret,
          sessionId: 'session-v4-negative',
        })
      ).toThrow('context_gateway_v4_replay_decryption_invalid');
      expect(() =>
        decryptContextGatewayV4ReplayMaterial({
          encryptedCanonicalJson: encrypted,
          secret: Buffer.alloc(32, 12),
          sessionId: 'session-v4-negative',
        })
      ).toThrow('context_gateway_v4_replay_decryption_invalid');
      expect(() =>
        decryptContextGatewayV4ReplayMaterial({
          encryptedCanonicalJson: encrypted,
          secret,
          sessionId: 'session-v4-other',
        })
      ).toThrow('context_gateway_v4_replay_envelope_invalid');

      await writeFile(replayMaterialPath, tampered, {
        encoding: 'utf8',
        mode: 0o600,
      });
      const restored = new ContextGatewayV4ReplayMaterialRecorder({
        sessionId: 'session-v4-negative',
        replayMaterialPath,
        secret,
      });
      await expect(restored.resume()).rejects.toThrow(
        'context_gateway_v4_replay_decryption_invalid'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
