import { execFile } from 'child_process';
import { createHash, createHmac } from 'crypto';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import {
  canonicalizeReviewContextConfinementEvidence,
  canonicalizeReviewContextGatewayEvent,
  canonicalizeReviewInvestigationContextConfinementEvidence,
} from '../../../src/control-plane/generated/review-action-v2/review-action-v2';
import {
  CONTEXT_GATEWAY_POLICY_VERSION,
  canonicalJson,
  contextGitFactOperandsHash,
} from '../../../src/context-gateway/context-gateway-contract';
import {
  CONTEXT_GATEWAY_V4_POLICY_VERSION,
  ContextGatewayV4OperationKind,
  ContextOperationFailureClass,
} from '../../../src/context-gateway/context-gateway-v4-contract';
import {
  CONTEXT_GATEWAY_V4_MAX_TRANSCRIPT_BYTES,
  ContextGatewayV4Recorder,
} from '../../../src/context-gateway/context-gateway-v4-recorder';
import { ContextGatewayV4ReplayMaterialRecorder } from '../../../src/context-gateway/context-gateway-v4-replay-material';
import { ContextGatewayLeaseAuthorityKind } from '../../../src/context-gateway/context-gateway-lease-authority';
import {
  ReviewContextInspectionFailureReason,
  ReviewContextInspectionFailureStage,
  type ReviewContextAttestationPort,
  type ReviewInvocationLease,
} from '../../../src/review-orchestration/application';
import {
  ContextGatewayInvocationSessionFactory,
  type ContextGatewayPolicyVersion,
  type RequiredContextWitnessRunnerPort,
} from '../../../src/review-orchestration/infrastructure/context-gateway-invocation-session';

const execFileAsync = promisify(execFile);

describe('ContextGatewayInvocationSessionFactory', () => {
  it('rejects an unknown provider before opening runtime resources', async () => {
    const factory = new ContextGatewayInvocationSessionFactory(
      {} as ReviewContextAttestationPort,
      {
        checkoutRoot: '/tmp',
        gatewayBundlePath: '/tmp/context-gateway.cjs',
      },
      {} as RequiredContextWitnessRunnerPort
    );

    await expect(
      factory.open({
        invocationLease: {
          leaseId: 'lease-1',
          attemptId: 'attempt-1',
          leaseCapability: 'lease-capability',
          fencingToken: '1',
          expiresAt: '2026-08-04T10:05:00.000Z',
          resultReportUntil: '2026-08-04T10:10:00.000Z',
          renewalCeilingReached: false,
        },
        leaseAuthorityKind: ContextGatewayLeaseAuthorityKind.StandardExecution,
        sourceExecutionId: 'execution-1',
        sourceWorkSlotId: 'slot-1',
        sourceReviewRevisionHash: hash('revision'),
        providerKind: 'unknown-provider',
        requestedModel: 'model',
        executionProfile: 'context_gateway_v1',
        providerInvocationKey: hash('provider-invocation'),
        toolPolicyHash: hash('tool-policy'),
        revision: {
          baseSha: 'b'.repeat(40),
          mergeBaseSha: 'c'.repeat(40),
          headSha: 'd'.repeat(40),
        },
      })
    ).rejects.toThrow('context_gateway_provider_kind_invalid');

    await expect(
      factory.open({
        invocationLease: {
          leaseId: 'lease-1',
          attemptId: 'attempt-1',
          leaseCapability: 'lease-capability',
          fencingToken: '1',
          expiresAt: '2026-08-04T10:05:00.000Z',
          resultReportUntil: '2026-08-04T10:10:00.000Z',
          renewalCeilingReached: false,
        },
        leaseAuthorityKind: ContextGatewayLeaseAuthorityKind.StandardExecution,
        sourceExecutionId: 'execution-1',
        sourceWorkSlotId: 'slot-1',
        sourceReviewRevisionHash: hash('revision'),
        providerKind: 'codex',
        requestedModel: 'model',
        executionProfile: 'unknown-profile',
        providerInvocationKey: hash('provider-invocation'),
        toolPolicyHash: hash('tool-policy'),
        revision: {
          baseSha: 'b'.repeat(40),
          mergeBaseSha: 'c'.repeat(40),
          headSha: 'd'.repeat(40),
        },
      })
    ).rejects.toThrow('context_gateway_execution_profile_invalid');
  });

  it('abandons the server session when required witness preflight fails', async () => {
    const checkoutRoot = await mkdtemp(
      path.join(os.tmpdir(), 'reviewrouter-gateway-open-failure-test-')
    );
    try {
      const gatewayBundlePath = path.join(checkoutRoot, 'gateway.cjs');
      await writeFile(path.join(checkoutRoot, 'tracked.txt'), 'tracked\n');
      await writeFile(gatewayBundlePath, 'gateway-v1\n');
      await git(checkoutRoot, ['init']);
      await git(checkoutRoot, ['config', 'user.email', 'test@example.com']);
      await git(checkoutRoot, ['config', 'user.name', 'ReviewRouter Test']);
      await git(checkoutRoot, ['add', '.']);
      await git(checkoutRoot, ['commit', '-m', 'test fixture']);
      const revisionSha = (
        await git(checkoutRoot, ['rev-parse', 'HEAD'])
      ).trim();
      const invocationLease = {
        leaseId: 'lease-1',
        attemptId: 'attempt-1',
        leaseCapability: 'lease-capability',
        fencingToken: '3',
        expiresAt: '2026-07-24T19:00:00.000Z',
        resultReportUntil: '2026-07-24T19:10:00.000Z',
        renewalCeilingReached: false,
      };
      const serverSession = {
        sessionId: 'gateway-session-1',
        eventChainSeedHash: '0'.repeat(64),
        sealCapability: 'seal-capability',
        gatewaySessionSecret: Buffer.alloc(32, 7).toString('base64url'),
        expiresAt: '2026-07-24T20:00:00.000Z',
      };
      const attestations = {
        openGatewaySession: jest.fn().mockResolvedValue(serverSession),
        sealGatewaySession: jest.fn(),
        abandonGatewaySession: jest.fn().mockResolvedValue(undefined),
      };
      const factory = new ContextGatewayInvocationSessionFactory(
        attestations,
        { checkoutRoot, gatewayBundlePath },
        {
          capture: jest
            .fn()
            .mockRejectedValue(new Error('required_witness_failed')),
        }
      );

      await expect(
        factory.open({
          invocationLease,
          leaseAuthorityKind:
            ContextGatewayLeaseAuthorityKind.StandardExecution,
          sourceExecutionId: 'execution-1',
          sourceWorkSlotId: 'slot-1',
          sourceReviewRevisionHash: hash('revision'),
          providerKind: 'codex',
          requestedModel: 'model',
          executionProfile: 'context_gateway_v1',
          providerInvocationKey: hash('provider-invocation'),
          toolPolicyHash: hash('tool-policy'),
          revision: {
            baseSha: revisionSha,
            mergeBaseSha: revisionSha,
            headSha: revisionSha,
          },
        })
      ).rejects.toThrow('required_witness_failed');
      expect(attestations.abandonGatewaySession).toHaveBeenCalledWith({
        invocationLease,
        session: serverSession,
      });
    } finally {
      await rm(checkoutRoot, { recursive: true, force: true });
    }
  });

  it('seals an authenticated v4 transcript with bound replay material', async () => {
    const fixture = await openSessionFixture(CONTEXT_GATEWAY_V4_POLICY_VERSION);
    try {
      const recorder = new ContextGatewayV4Recorder({
        sessionId: fixture.serverSession.sessionId,
        transcriptPath:
          fixture.session.providerConfig.runtimeEnvironment
            .REVIEWROUTER_CONTEXT_TRANSCRIPT_PATH!,
        secret: fixture.secret,
        gatewayBinaryHash: fixture.gatewayHash,
        checkoutTreeOid: fixture.checkoutTreeOid,
        eventChainSeedHash: fixture.serverSession.eventChainSeedHash,
      });
      await recorder.resume();
      const replay = new ContextGatewayV4ReplayMaterialRecorder({
        sessionId: fixture.serverSession.sessionId,
        replayMaterialPath:
          fixture.session.providerConfig.runtimeEnvironment
            .REVIEWROUTER_CONTEXT_REPLAY_MATERIAL_PATH!,
        secret: fixture.secret,
      });
      await replay.resume();
      const event = await recorder.recordSucceeded({
        operation: {
          kind: ContextGatewayV4OperationKind.GitFact,
          fact: 'merge_base',
        },
        result: {
          complete: true,
          fact: 'merge_base',
          itemCount: 1,
          resultHash: hash('merge-base-result'),
        },
        operationReceiptId: hash('operation-receipt'),
      });
      await replay.recordSucceeded({
        event,
        replayInput: { fact: 'merge_base' },
      });

      await expect(
        fixture.session.seal({
          actualModel: 'gpt-test-actual',
          terminalOutcomeHash: hash('outcome'),
        })
      ).resolves.toMatchObject({ attestationId: 'attestation-1' });

      const sealInput =
        fixture.attestations.sealGatewaySession.mock.calls[0][0];
      await expect(
        access(
          fixture.session.providerConfig.runtimeEnvironment
            .REVIEWROUTER_CONTEXT_REPLAY_MATERIAL_PATH!
        )
      ).resolves.toBeUndefined();
      expect(JSON.parse(sealInput.transcriptCanonicalJson)).toMatchObject({
        manifestVersion: 3,
        gatewayPolicyVersion: CONTEXT_GATEWAY_V4_POLICY_VERSION,
        complete: true,
      });
      expect(JSON.parse(sealInput.replayMaterialCanonicalJson)).toEqual({
        replayMaterialVersion: 2,
        sessionId: fixture.serverSession.sessionId,
        entries: expect.arrayContaining([
          expect.objectContaining({
            operationKind: ContextGatewayV4OperationKind.GitFact,
            replayInput: { fact: 'merge_base' },
          }),
        ]),
      });
      expect(fixture.session.providerConfig.enabledTools).toContain(
        'review_canonical_inventory'
      );
      expect(fixture.attestations.openGatewaySession).toHaveBeenCalledWith(
        expect.objectContaining({
          gatewayPolicyVersion: CONTEXT_GATEWAY_V4_POLICY_VERSION,
        })
      );
      await fixture.session.dispose();
      await expect(
        access(
          fixture.session.providerConfig.runtimeEnvironment
            .REVIEWROUTER_CONTEXT_REPLAY_MATERIAL_PATH!
        )
      ).rejects.toThrow();
      await fixture.session.dispose();
      expect(fixture.attestations.abandonGatewaySession).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });

  it('seals a valid v4 transcript above the legacy 2 MiB boundary', async () => {
    const fixture = await openSessionFixture(CONTEXT_GATEWAY_V4_POLICY_VERSION);
    try {
      const recorder = v4Recorder(fixture);
      await recorder.resume();
      const replay = new ContextGatewayV4ReplayMaterialRecorder({
        sessionId: fixture.serverSession.sessionId,
        replayMaterialPath:
          fixture.session.providerConfig.runtimeEnvironment
            .REVIEWROUTER_CONTEXT_REPLAY_MATERIAL_PATH!,
        secret: fixture.secret,
      });
      await replay.resume();
      const event = await recorder.recordSucceeded({
        operation: {
          kind: ContextGatewayV4OperationKind.GitFact,
          fact: 'merge_base',
        },
        result: {
          complete: true,
          fact: 'merge_base',
          itemCount: 1,
          resultHash: hash('large-provider-result'),
          padding: 'x'.repeat(2 * 1024 * 1024),
        },
        operationReceiptId: hash('large-provider-receipt'),
      });
      await replay.recordSucceeded({
        event,
        replayInput: { fact: 'merge_base' },
      });
      const transcriptSize = (
        await stat(
          fixture.session.providerConfig.runtimeEnvironment
            .REVIEWROUTER_CONTEXT_TRANSCRIPT_PATH!
        )
      ).size;
      expect(transcriptSize).toBeGreaterThan(2 * 1024 * 1024);
      expect(transcriptSize).toBeLessThanOrEqual(
        CONTEXT_GATEWAY_V4_MAX_TRANSCRIPT_BYTES
      );

      await expect(
        fixture.session.seal({
          actualModel: 'gpt-test-actual',
          terminalOutcomeHash: hash('outcome'),
        })
      ).resolves.toMatchObject({ attestationId: 'attestation-1' });
    } finally {
      await fixture.dispose();
    }
  });

  it.each([
    {
      name: 'transcript resume',
      stage: ReviewContextInspectionFailureStage.TranscriptResume,
      mutate: async (fixture: SessionFixture) => {
        await writeFile(
          fixture.session.providerConfig.runtimeEnvironment
            .REVIEWROUTER_CONTEXT_TRANSCRIPT_PATH!,
          'not-json'
        );
      },
    },
    {
      name: 'replay read',
      stage: ReviewContextInspectionFailureStage.ReplayRead,
      mutate: async (fixture: SessionFixture) => {
        await writeFile(
          fixture.session.providerConfig.runtimeEnvironment
            .REVIEWROUTER_CONTEXT_REPLAY_MATERIAL_PATH!,
          'x'
        );
      },
    },
    {
      name: 'replay decrypt',
      stage: ReviewContextInspectionFailureStage.ReplayDecrypt,
      mutate: async (fixture: SessionFixture) => {
        await writeFile(
          fixture.session.providerConfig.runtimeEnvironment
            .REVIEWROUTER_CONTEXT_REPLAY_MATERIAL_PATH!,
          '{}'
        );
      },
    },
  ])('reports the safe v4 $name failure stage', async ({ stage, mutate }) => {
    const fixture = await openSessionFixture(CONTEXT_GATEWAY_V4_POLICY_VERSION);
    try {
      await writeValidV4Evidence(fixture);
      await mutate(fixture);

      await expect(
        fixture.session.seal({
          actualModel: 'gpt-test-actual',
          terminalOutcomeHash: hash('outcome'),
        })
      ).rejects.toMatchObject({
        reason: ReviewContextInspectionFailureReason.GatewayOutputUnavailable,
        stage,
      });
      expect(fixture.attestations.sealGatewaySession).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });

  it('reports the control-plane v4 seal failure stage', async () => {
    const fixture = await openSessionFixture(CONTEXT_GATEWAY_V4_POLICY_VERSION);
    try {
      await writeValidV4Evidence(fixture);
      fixture.attestations.sealGatewaySession.mockRejectedValueOnce(
        new Error('control-plane-unavailable')
      );

      await expect(
        fixture.session.seal({
          actualModel: 'gpt-test-actual',
          terminalOutcomeHash: hash('outcome'),
        })
      ).rejects.toMatchObject({
        reason: ReviewContextInspectionFailureReason.GatewayOutputUnavailable,
        stage: ReviewContextInspectionFailureStage.ControlPlaneSeal,
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects an empty v4 transcript before contacting the control plane', async () => {
    const fixture = await openSessionFixture(CONTEXT_GATEWAY_V4_POLICY_VERSION);
    try {
      const recorder = new ContextGatewayV4Recorder({
        sessionId: fixture.serverSession.sessionId,
        transcriptPath:
          fixture.session.providerConfig.runtimeEnvironment
            .REVIEWROUTER_CONTEXT_TRANSCRIPT_PATH!,
        secret: fixture.secret,
        gatewayBinaryHash: fixture.gatewayHash,
        checkoutTreeOid: fixture.checkoutTreeOid,
        eventChainSeedHash: fixture.serverSession.eventChainSeedHash,
      });
      await recorder.resume();
      const replay = new ContextGatewayV4ReplayMaterialRecorder({
        sessionId: fixture.serverSession.sessionId,
        replayMaterialPath:
          fixture.session.providerConfig.runtimeEnvironment
            .REVIEWROUTER_CONTEXT_REPLAY_MATERIAL_PATH!,
        secret: fixture.secret,
      });
      await replay.resume();

      await expect(
        fixture.session.seal({
          actualModel: 'gpt-test-actual',
          terminalOutcomeHash: hash('outcome'),
        })
      ).rejects.toMatchObject({
        reason: ReviewContextInspectionFailureReason.MissingProviderInspection,
      });
      expect(fixture.attestations.sealGatewaySession).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
    expect(fixture.attestations.abandonGatewaySession).toHaveBeenCalledTimes(1);
    expect(fixture.attestations.abandonGatewaySession).toHaveBeenCalledWith({
      invocationLease: fixture.invocationLease,
      session: fixture.serverSession,
    });
  });

  it('rejects a provider suffix containing only rejected operations', async () => {
    const fixture = await openSessionFixture(CONTEXT_GATEWAY_V4_POLICY_VERSION);
    try {
      const recorder = v4Recorder(fixture);
      await recorder.resume();
      await recorder.recordRejected({
        operation: {
          kind: ContextGatewayV4OperationKind.UnsupportedTool,
          requestedToolHash: hash('unsupported-provider-tool'),
        },
        failureClass: ContextOperationFailureClass.RecoverableRequest,
        sanitizedReason: 'unsupported_tool',
      });

      await expect(
        fixture.session.seal({
          actualModel: 'gpt-test-actual',
          terminalOutcomeHash: hash('outcome'),
        })
      ).rejects.toMatchObject({
        reason: ReviewContextInspectionFailureReason.MissingProviderInspection,
      });
      expect(fixture.attestations.sealGatewaySession).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects an authenticated transcript whose preflight prefix changed', async () => {
    const fixture = await openSessionFixture(CONTEXT_GATEWAY_V4_POLICY_VERSION);
    try {
      await rm(
        fixture.session.providerConfig.runtimeEnvironment
          .REVIEWROUTER_CONTEXT_TRANSCRIPT_PATH!
      );
      const recorder = v4Recorder(fixture);
      await recorder.initialize();
      await recorder.recordSucceeded({
        operation: {
          kind: ContextGatewayV4OperationKind.GitFact,
          fact: 'head_commit',
        },
        result: {
          complete: true,
          fact: 'head_commit',
          itemCount: 1,
          resultHash: hash('replacement-preflight'),
        },
        operationReceiptId: hash('replacement-preflight-receipt'),
      });
      await recorder.recordSucceeded({
        operation: {
          kind: ContextGatewayV4OperationKind.GitFact,
          fact: 'merge_base',
        },
        result: {
          complete: true,
          fact: 'merge_base',
          itemCount: 1,
          resultHash: hash('provider-result'),
        },
        operationReceiptId: hash('provider-receipt'),
      });

      await expect(
        fixture.session.seal({
          actualModel: 'gpt-test-actual',
          terminalOutcomeHash: hash('outcome'),
        })
      ).rejects.toMatchObject({
        reason: ReviewContextInspectionFailureReason.IncompleteTranscript,
      });
      expect(fixture.attestations.sealGatewaySession).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects replay material that omits the authenticated preflight prefix', async () => {
    const fixture = await openSessionFixture(CONTEXT_GATEWAY_V4_POLICY_VERSION);
    try {
      const recorder = v4Recorder(fixture);
      await recorder.resume();
      const providerEvent = await recorder.recordSucceeded({
        operation: {
          kind: ContextGatewayV4OperationKind.GitFact,
          fact: 'head_commit',
        },
        result: {
          complete: true,
          fact: 'head_commit',
          itemCount: 1,
          resultHash: hash('provider-result'),
        },
        operationReceiptId: hash('provider-receipt'),
      });
      const replayPath =
        fixture.session.providerConfig.runtimeEnvironment
          .REVIEWROUTER_CONTEXT_REPLAY_MATERIAL_PATH!;
      await rm(replayPath);
      const replay = new ContextGatewayV4ReplayMaterialRecorder({
        sessionId: fixture.serverSession.sessionId,
        replayMaterialPath: replayPath,
        secret: fixture.secret,
      });
      await replay.initialize();
      await replay.recordSucceeded({
        event: providerEvent,
        replayInput: { fact: 'head_commit' },
      });

      await expect(
        fixture.session.seal({
          actualModel: 'gpt-test-actual',
          terminalOutcomeHash: hash('outcome'),
        })
      ).rejects.toMatchObject({
        reason: ReviewContextInspectionFailureReason.IncompleteTranscript,
      });
      expect(fixture.attestations.sealGatewaySession).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });

  it('preserves preflight-only v4 sealing for the investigation profile', async () => {
    const fixture = await openSessionFixture(
      CONTEXT_GATEWAY_V4_POLICY_VERSION,
      ContextGatewayLeaseAuthorityKind.ReviewInvestigation
    );
    try {
      await expect(
        fixture.session.seal({
          actualModel: 'gpt-test-actual',
          terminalOutcomeHash: hash('outcome'),
        })
      ).resolves.toMatchObject({ attestationId: 'attestation-1' });
    } finally {
      await fixture.dispose();
    }
  });

  it('abandons with the current invocation lease after capability renewal', async () => {
    const currentLease: ReviewInvocationLease = Object.freeze({
      leaseId: 'lease-1',
      attemptId: 'attempt-1',
      leaseCapability: 'renewed-lease-capability',
      fencingToken: '4',
      expiresAt: '2026-07-24T19:05:00.000Z',
      resultReportUntil: '2026-07-24T19:10:00.000Z',
      renewalCeilingReached: false,
    });
    const fixture = await openSessionFixture(
      CONTEXT_GATEWAY_V4_POLICY_VERSION,
      ContextGatewayLeaseAuthorityKind.StandardExecution,
      () => currentLease
    );

    try {
      await fixture.session.dispose();
      expect(fixture.attestations.abandonGatewaySession).toHaveBeenCalledWith({
        invocationLease: currentLease,
        session: fixture.serverSession,
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects a tainted v4 transcript before contacting the control plane', async () => {
    const fixture = await openSessionFixture(CONTEXT_GATEWAY_V4_POLICY_VERSION);
    try {
      const recorder = new ContextGatewayV4Recorder({
        sessionId: fixture.serverSession.sessionId,
        transcriptPath:
          fixture.session.providerConfig.runtimeEnvironment
            .REVIEWROUTER_CONTEXT_TRANSCRIPT_PATH!,
        secret: fixture.secret,
        gatewayBinaryHash: fixture.gatewayHash,
        checkoutTreeOid: fixture.checkoutTreeOid,
        eventChainSeedHash: fixture.serverSession.eventChainSeedHash,
      });
      await recorder.resume();
      await recorder.recordRejected({
        operation: {
          kind: ContextGatewayV4OperationKind.UnsupportedTool,
          requestedToolHash: hash('unsupported-tool'),
        },
        failureClass: ContextOperationFailureClass.ConfinementViolation,
        sanitizedReason: 'unsupported_tool',
      });
      const replay = new ContextGatewayV4ReplayMaterialRecorder({
        sessionId: fixture.serverSession.sessionId,
        replayMaterialPath:
          fixture.session.providerConfig.runtimeEnvironment
            .REVIEWROUTER_CONTEXT_REPLAY_MATERIAL_PATH!,
        secret: fixture.secret,
      });
      await replay.resume();

      await expect(
        fixture.session.seal({
          actualModel: 'gpt-test-actual',
          terminalOutcomeHash: hash('outcome'),
        })
      ).rejects.toMatchObject({
        reason: ReviewContextInspectionFailureReason.IncompleteTranscript,
        stage: undefined,
      });
      expect(fixture.attestations.sealGatewaySession).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects a terminally failed v4 transcript before contacting the control plane', async () => {
    const fixture = await openSessionFixture(CONTEXT_GATEWAY_V4_POLICY_VERSION);
    try {
      const recorder = new ContextGatewayV4Recorder({
        sessionId: fixture.serverSession.sessionId,
        transcriptPath:
          fixture.session.providerConfig.runtimeEnvironment
            .REVIEWROUTER_CONTEXT_TRANSCRIPT_PATH!,
        secret: fixture.secret,
        gatewayBinaryHash: fixture.gatewayHash,
        checkoutTreeOid: fixture.checkoutTreeOid,
        eventChainSeedHash: fixture.serverSession.eventChainSeedHash,
      });
      await recorder.resume();
      await recorder.recordFailed({
        operation: {
          kind: ContextGatewayV4OperationKind.UnsupportedTool,
          requestedToolHash: hash('failed-tool'),
        },
        sanitizedReason: 'gateway_infrastructure_failure',
      });
      const replay = new ContextGatewayV4ReplayMaterialRecorder({
        sessionId: fixture.serverSession.sessionId,
        replayMaterialPath:
          fixture.session.providerConfig.runtimeEnvironment
            .REVIEWROUTER_CONTEXT_REPLAY_MATERIAL_PATH!,
        secret: fixture.secret,
      });
      await replay.resume();

      await expect(
        fixture.session.seal({
          actualModel: 'gpt-test-actual',
          terminalOutcomeHash: hash('outcome'),
        })
      ).rejects.toMatchObject({
        reason: ReviewContextInspectionFailureReason.IncompleteTranscript,
      });
      expect(fixture.attestations.sealGatewaySession).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });

  it('seals a complete changed_paths witness with a non-empty replay plan', async () => {
    const fixture = await openSessionFixture();
    try {
      const changedPaths = changedPathsDependency(fixture);
      await writeTranscript(fixture, [
        changedPaths,
        dependency(
          fixture,
          { kind: 'file_read', path: 'tracked.txt' },
          {
            kind: 'file_read',
            complete: true,
            truncated: false,
          },
          changedPaths
        ),
      ]);

      await expect(
        fixture.session.seal({
          actualModel: 'gpt-test-actual',
          terminalOutcomeHash: hash('outcome'),
        })
      ).resolves.toMatchObject({ attestationId: 'attestation-1' });

      expect(fixture.attestations.sealGatewaySession).toHaveBeenCalledWith(
        expect.objectContaining({
          replayMaterialCanonicalJson: expect.stringContaining(
            '"sourceDependencies":[{'
          ),
        })
      );
      const sealInput =
        fixture.attestations.sealGatewaySession.mock.calls[0][0];
      expect(
        JSON.parse(sealInput.replayMaterialCanonicalJson).sourceDependencies
      ).toHaveLength(2);
      expect(fixture.planningGatewayHash).toBe(fixture.gatewayHash);
      expect(fixture.session.providerConfig.gatewayBinaryHash).toBe(
        fixture.gatewayHash
      );
      expect(
        fixture.session.providerConfig.runtimeEnvironment
          .REVIEWROUTER_CONTEXT_MERGE_BASE_TREE_OID
      ).toBe(
        (
          await git(fixture.checkoutRoot, [
            'rev-parse',
            `${fixture.revision.mergeBaseSha}^{tree}`,
          ])
        ).trim()
      );
      expect(fixture.requiredWitnessRunner.capture).toHaveBeenCalledWith({
        gatewayBundlePath: fixture.session.providerConfig.args[0],
        checkoutRoot: fixture.checkoutRoot,
        runtimeEnvironment: fixture.session.providerConfig.runtimeEnvironment,
        gatewaySessionSecret: fixture.serverSession.gatewaySessionSecret,
      });
      expect(
        await readFile(fixture.session.providerConfig.args[0], 'utf8')
      ).toBe('gateway-v1\n');
      expect(fixture.attestations.openGatewaySession).toHaveBeenCalledWith({
        invocationLease: fixture.invocationLease,
        sourceExecutionId: 'execution-1',
        sourceWorkSlotId: 'slot-1',
        sourceReviewRevisionHash: hash('revision'),
        checkoutTreeOid: fixture.checkoutTreeOid,
        gatewayPolicyVersion: CONTEXT_GATEWAY_POLICY_VERSION,
        gatewayBinaryHash: fixture.gatewayHash,
        confinementEvidenceHash: hash(
          canonicalizeReviewContextConfinementEvidence({
            attemptId: fixture.invocationLease.attemptId,
            sourceLeaseId: fixture.invocationLease.leaseId,
            sourceFencingToken: fixture.invocationLease.fencingToken,
            sourceExecutionId: 'execution-1',
            sourceWorkSlotId: 'slot-1',
            sourceReviewRevisionHash: hash('revision'),
            checkoutTreeOid: fixture.checkoutTreeOid,
            providerKind: 'codex',
            requestedModel: 'gpt-test',
            executionProfile: 'context_gateway_v1',
            providerInvocationKey: hash('provider-invocation'),
            toolPolicyHash: hash('tool-policy'),
            gatewayPolicyVersion: CONTEXT_GATEWAY_POLICY_VERSION,
            gatewayBinaryHash: fixture.gatewayHash,
          })
        ),
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects the system witness when the provider did not inspect repository context', async () => {
    const fixture = await openSessionFixture();
    try {
      await writeTranscript(fixture, [changedPathsDependency(fixture)]);

      await expect(
        fixture.session.seal({
          actualModel: 'gpt-test-actual',
          terminalOutcomeHash: hash('outcome'),
        })
      ).rejects.toMatchObject({
        reason: ReviewContextInspectionFailureReason.MissingProviderInspection,
      });
      expect(fixture.attestations.sealGatewaySession).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects a checkout whose tree differs from the authorized head tree', async () => {
    const fixture = await openSessionFixture();
    try {
      await writeFile(path.join(fixture.checkoutRoot, 'new.txt'), 'new\n');
      await git(fixture.checkoutRoot, ['add', 'new.txt']);
      await git(fixture.checkoutRoot, ['commit', '-m', 'change tree']);

      await expect(
        fixture.factory.planningConfig(fixture.revision)
      ).rejects.toThrow('context_gateway_checkout_revision_mismatch');
    } finally {
      await fixture.dispose();
    }
  });

  it('ignores replacement objects when authorizing revision trees', async () => {
    const fixture = await openSessionFixture();
    try {
      await writeFile(
        path.join(fixture.checkoutRoot, 'foreign.txt'),
        'foreign\n'
      );
      await git(fixture.checkoutRoot, ['add', 'foreign.txt']);
      const foreignTreeOid = (
        await git(fixture.checkoutRoot, ['write-tree'])
      ).trim();
      const foreignCommitSha = (
        await git(fixture.checkoutRoot, [
          'commit-tree',
          foreignTreeOid,
          '-p',
          fixture.revision.headSha,
          '-m',
          'test: foreign replacement',
        ])
      ).trim();
      await git(fixture.checkoutRoot, [
        'reset',
        '--hard',
        fixture.revision.headSha,
      ]);
      await git(fixture.checkoutRoot, [
        'replace',
        fixture.revision.headSha,
        foreignCommitSha,
      ]);
      expect(
        (await git(fixture.checkoutRoot, ['rev-parse', 'HEAD^{tree}'])).trim()
      ).toBe(foreignTreeOid);

      await expect(
        fixture.factory.planningConfig(fixture.revision)
      ).resolves.toMatchObject({
        runtimeEnvironment: {
          REVIEWROUTER_CONTEXT_CHECKOUT_TREE_OID: fixture.checkoutTreeOid,
        },
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects a complete transcript without changed_paths as retryable inspection failure', async () => {
    const fixture = await openSessionFixture();
    try {
      await writeTranscript(fixture, [
        dependency(
          fixture,
          { kind: 'file_read', path: 'tracked.txt' },
          {
            kind: 'file_read',
            complete: true,
            truncated: false,
          }
        ),
      ]);

      await expect(
        fixture.session.seal({
          actualModel: 'gpt-test-actual',
          terminalOutcomeHash: hash('outcome'),
        })
      ).rejects.toMatchObject({
        reason: ReviewContextInspectionFailureReason.MissingChangedPathsWitness,
      });
      expect(fixture.attestations.sealGatewaySession).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });

  it.each([
    {
      name: 'truncated changed_paths',
      dependencies: (fixture: SessionFixture) => [
        dependency(
          fixture,
          {
            kind: 'git_fact',
            fact: 'changed_paths',
            operandsHash: hash('operands'),
          },
          {
            kind: 'git_fact',
            resultHash: hash('result'),
            itemCount: 1,
            byteCount: 10,
            complete: false,
            truncated: true,
          }
        ),
      ],
    },
    {
      name: 'recorded gateway error',
      dependencies: () => [],
    },
  ])(
    'rejects $name without sealing an attestation',
    async ({ dependencies }) => {
      const fixture = await openSessionFixture();
      try {
        await writeTranscript(fixture, dependencies(fixture), true);

        await expect(
          fixture.session.seal({
            actualModel: 'gpt-test-actual',
            terminalOutcomeHash: hash('outcome'),
          })
        ).rejects.toMatchObject({
          reason: ReviewContextInspectionFailureReason.IncompleteTranscript,
        });
        expect(fixture.attestations.sealGatewaySession).not.toHaveBeenCalled();
      } finally {
        await fixture.dispose();
      }
    }
  );

  it('rejects a malformed complete changed_paths entry instead of treating it as a witness', async () => {
    const fixture = await openSessionFixture();
    try {
      await writeTranscript(fixture, [
        dependency(
          fixture,
          {
            kind: 'git_fact',
            fact: 'changed_paths',
            operandsHash: hash('operands'),
            untrustedExtra: true,
          },
          {
            kind: 'git_fact',
            resultHash: hash('result'),
            itemCount: 1,
            byteCount: 10,
            complete: true,
            truncated: false,
          }
        ),
      ]);

      await expect(
        fixture.session.seal({
          actualModel: 'gpt-test-actual',
          terminalOutcomeHash: hash('outcome'),
        })
      ).rejects.toMatchObject({
        reason: ReviewContextInspectionFailureReason.InvalidChangedPathsWitness,
      });
      expect(fixture.attestations.sealGatewaySession).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });

  it('does not seal an authenticated empty transcript or submit an empty replay plan', async () => {
    const fixture = await openSessionFixture();
    try {
      await writeTranscript(fixture, []);

      await expect(
        fixture.session.seal({
          actualModel: 'gpt-test-actual',
          terminalOutcomeHash: hash('outcome'),
        })
      ).rejects.toMatchObject({
        reason: ReviewContextInspectionFailureReason.MissingChangedPathsWitness,
      });
      expect(fixture.attestations.sealGatewaySession).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });

  it('uses the investigation confinement domain for investigation leases', async () => {
    const fixture = await openSessionFixture(
      CONTEXT_GATEWAY_V4_POLICY_VERSION,
      ContextGatewayLeaseAuthorityKind.ReviewInvestigation
    );
    try {
      expect(fixture.attestations.openGatewaySession).toHaveBeenCalledWith(
        expect.objectContaining({
          confinementEvidenceHash: hash(
            canonicalizeReviewInvestigationContextConfinementEvidence({
              attemptId: fixture.invocationLease.attemptId,
              sourceLeaseId: fixture.invocationLease.leaseId,
              sourceFencingToken: fixture.invocationLease.fencingToken,
              sourceExecutionId: 'execution-1',
              sourceWorkSlotId: 'slot-1',
              sourceReviewRevisionHash: hash('revision'),
              checkoutTreeOid: fixture.checkoutTreeOid,
              providerKind: 'codex',
              requestedModel: 'gpt-test',
              executionProfile: 'investigation_gateway_v1',
              providerInvocationKey: hash('provider-invocation'),
              toolPolicyHash: hash('tool-policy'),
              gatewayPolicyVersion: CONTEXT_GATEWAY_V4_POLICY_VERSION,
              gatewayBinaryHash: fixture.gatewayHash,
            })
          ),
        })
      );
    } finally {
      await fixture.dispose();
    }
  });
});

type SessionFixture = Awaited<ReturnType<typeof openSessionFixture>>;

function v4Recorder(fixture: SessionFixture): ContextGatewayV4Recorder {
  return new ContextGatewayV4Recorder({
    sessionId: fixture.serverSession.sessionId,
    transcriptPath:
      fixture.session.providerConfig.runtimeEnvironment
        .REVIEWROUTER_CONTEXT_TRANSCRIPT_PATH!,
    secret: fixture.secret,
    gatewayBinaryHash: fixture.gatewayHash,
    checkoutTreeOid: fixture.checkoutTreeOid,
    eventChainSeedHash: fixture.serverSession.eventChainSeedHash,
  });
}

async function writeValidV4Evidence(fixture: SessionFixture): Promise<void> {
  const recorder = new ContextGatewayV4Recorder({
    sessionId: fixture.serverSession.sessionId,
    transcriptPath:
      fixture.session.providerConfig.runtimeEnvironment
        .REVIEWROUTER_CONTEXT_TRANSCRIPT_PATH!,
    secret: fixture.secret,
    gatewayBinaryHash: fixture.gatewayHash,
    checkoutTreeOid: fixture.checkoutTreeOid,
    eventChainSeedHash: fixture.serverSession.eventChainSeedHash,
  });
  await recorder.resume();
  const replay = new ContextGatewayV4ReplayMaterialRecorder({
    sessionId: fixture.serverSession.sessionId,
    replayMaterialPath:
      fixture.session.providerConfig.runtimeEnvironment
        .REVIEWROUTER_CONTEXT_REPLAY_MATERIAL_PATH!,
    secret: fixture.secret,
  });
  await replay.resume();
  const event = await recorder.recordSucceeded({
    operation: {
      kind: ContextGatewayV4OperationKind.GitFact,
      fact: 'merge_base',
    },
    result: {
      complete: true,
      fact: 'merge_base',
      itemCount: 1,
      resultHash: hash('merge-base-result'),
    },
    operationReceiptId: hash('operation-receipt'),
  });
  await replay.recordSucceeded({
    event,
    replayInput: { fact: 'merge_base' },
  });
}

async function openSessionFixture(
  policyVersion: ContextGatewayPolicyVersion = CONTEXT_GATEWAY_POLICY_VERSION,
  leaseAuthorityKind: ContextGatewayLeaseAuthorityKind = ContextGatewayLeaseAuthorityKind.StandardExecution,
  currentInvocationLease?: () => ReviewInvocationLease
) {
  const checkoutRoot = await mkdtemp(
    path.join(os.tmpdir(), 'reviewrouter-gateway-session-test-')
  );
  const gatewayBundlePath = path.join(checkoutRoot, 'gateway.cjs');
  await writeFile(path.join(checkoutRoot, 'tracked.txt'), 'tracked\n');
  await writeFile(gatewayBundlePath, 'gateway-v1\n');
  await git(checkoutRoot, ['init']);
  await git(checkoutRoot, ['config', 'user.email', 'test@example.com']);
  await git(checkoutRoot, ['config', 'user.name', 'ReviewRouter Test']);
  await git(checkoutRoot, ['add', '.']);
  await git(checkoutRoot, ['commit', '-m', 'test fixture']);

  const secret = Buffer.alloc(32, 7);
  const serverSession = Object.freeze({
    sessionId: 'gateway-session-1',
    eventChainSeedHash: '0'.repeat(64),
    sealCapability: 'seal-capability',
    gatewaySessionSecret: secret.toString('base64url'),
    expiresAt: '2026-07-24T20:00:00.000Z',
  });
  const attestations = {
    openGatewaySession: jest.fn().mockResolvedValue(serverSession),
    sealGatewaySession: jest.fn().mockResolvedValue({
      attestationId: 'attestation-1',
      attestationHash: hash('attestation'),
    }),
    abandonGatewaySession: jest.fn().mockResolvedValue(undefined),
    commitContextReplay: jest.fn(),
  };
  const requiredWitnessRunner: jest.Mocked<RequiredContextWitnessRunnerPort> = {
    capture: jest.fn(async (input) => {
      if (policyVersion !== CONTEXT_GATEWAY_V4_POLICY_VERSION) return null;
      const recorder = new ContextGatewayV4Recorder({
        sessionId: serverSession.sessionId,
        transcriptPath:
          input.runtimeEnvironment.REVIEWROUTER_CONTEXT_TRANSCRIPT_PATH!,
        secret,
        gatewayBinaryHash:
          input.runtimeEnvironment.REVIEWROUTER_CONTEXT_GATEWAY_BINARY_HASH!,
        checkoutTreeOid:
          input.runtimeEnvironment.REVIEWROUTER_CONTEXT_CHECKOUT_TREE_OID!,
        eventChainSeedHash: serverSession.eventChainSeedHash,
      });
      await recorder.initialize();
      const replay = new ContextGatewayV4ReplayMaterialRecorder({
        sessionId: serverSession.sessionId,
        replayMaterialPath:
          input.runtimeEnvironment.REVIEWROUTER_CONTEXT_REPLAY_MATERIAL_PATH!,
        secret,
      });
      await replay.initialize();
      const event = await recorder.recordSucceeded({
        operation: {
          kind: ContextGatewayV4OperationKind.GitFact,
          fact: 'merge_base',
        },
        result: {
          complete: true,
          fact: 'merge_base',
          itemCount: 1,
          resultHash: hash('preflight-result'),
        },
        operationReceiptId: hash('preflight-receipt'),
      });
      await replay.recordSucceeded({
        event,
        replayInput: { fact: 'merge_base' },
      });
      const transcript = recorder.snapshot();
      const replayMaterial = replay.snapshot();
      return Object.freeze({
        policyVersion: CONTEXT_GATEWAY_V4_POLICY_VERSION,
        eventCount: transcript.events.length,
        authenticatedChainHash: transcript.authenticatedChainHash,
        replayEntryCount: replayMaterial.entries.length,
        replayPrefixHash: hash(canonicalJson(replayMaterial.entries)),
      });
    }),
  };
  const factory = new ContextGatewayInvocationSessionFactory(
    attestations as unknown as ReviewContextAttestationPort,
    { checkoutRoot, gatewayBundlePath, policyVersion },
    requiredWitnessRunner
  );
  const revision = {
    baseSha: (await git(checkoutRoot, ['rev-parse', 'HEAD'])).trim(),
    mergeBaseSha: (await git(checkoutRoot, ['rev-parse', 'HEAD'])).trim(),
    headSha: (await git(checkoutRoot, ['rev-parse', 'HEAD'])).trim(),
  };
  const planning = await factory.planningConfig(revision);
  const gatewayHash = hash('gateway-v1\n');
  await writeFile(gatewayBundlePath, 'gateway-v2-mutated\n');
  const invocationLease = {
    leaseId: 'lease-1',
    attemptId: 'attempt-1',
    leaseCapability: 'lease-capability',
    fencingToken: '3',
    expiresAt: '2026-07-24T19:00:00.000Z',
    resultReportUntil: '2026-07-24T19:10:00.000Z',
    renewalCeilingReached: false,
  };
  const session = await factory.open({
    invocationLease,
    currentInvocationLease,
    leaseAuthorityKind,
    sourceExecutionId: 'execution-1',
    sourceWorkSlotId: 'slot-1',
    sourceReviewRevisionHash: hash('revision'),
    providerKind: 'codex',
    requestedModel: 'gpt-test',
    executionProfile:
      leaseAuthorityKind === ContextGatewayLeaseAuthorityKind.StandardExecution
        ? 'context_gateway_v1'
        : 'investigation_gateway_v1',
    providerInvocationKey: hash('provider-invocation'),
    toolPolicyHash: hash('tool-policy'),
    revision,
  });
  return {
    attestations,
    checkoutRoot,
    checkoutTreeOid:
      session.providerConfig.runtimeEnvironment
        .REVIEWROUTER_CONTEXT_CHECKOUT_TREE_OID!,
    gatewayHash,
    factory,
    invocationLease,
    mergeBaseTreeOid:
      session.providerConfig.runtimeEnvironment
        .REVIEWROUTER_CONTEXT_MERGE_BASE_TREE_OID!,
    planningGatewayHash: planning.gatewayBinaryHash,
    requiredWitnessRunner,
    revision,
    secret,
    serverSession,
    session,
    async dispose() {
      await session.dispose();
      await rm(checkoutRoot, { recursive: true, force: true });
    },
  };
}

function dependency(
  fixture: {
    readonly secret: Buffer;
    readonly serverSession: {
      readonly sessionId: string;
      readonly eventChainSeedHash: string;
    };
  },
  operation: Readonly<Record<string, unknown>> & { readonly kind: string },
  result: Readonly<Record<string, unknown>> & {
    readonly kind: string;
    readonly complete: boolean;
    readonly truncated: boolean;
  },
  previous?: { readonly sequence: number; readonly eventHash: string }
) {
  const eventWithoutHash = {
    sequence: (previous?.sequence ?? 0) + 1,
    previousEventHash:
      previous?.eventHash ?? fixture.serverSession.eventChainSeedHash,
    operationKey: hash(canonicalJson(operation)),
    operation,
    result,
  };
  const eventHash = createHmac('sha256', fixture.secret)
    .update(
      canonicalizeReviewContextGatewayEvent({
        sessionId: fixture.serverSession.sessionId,
        ...eventWithoutHash,
      })
    )
    .digest('hex');
  return { ...eventWithoutHash, eventHash };
}

function changedPathsDependency(fixture: SessionFixture) {
  return dependency(
    fixture,
    {
      kind: 'git_fact',
      fact: 'changed_paths',
      operandsHash: contextGitFactOperandsHash({
        fact: 'changed_paths',
        mergeBaseTreeOid: fixture.mergeBaseTreeOid,
        headTreeOid: fixture.checkoutTreeOid,
      }),
    },
    {
      kind: 'git_fact',
      resultHash: hash(canonicalJson([])),
      itemCount: 0,
      byteCount: Buffer.byteLength(canonicalJson([]), 'utf8'),
      complete: true,
      truncated: false,
    }
  );
}

async function writeTranscript(
  fixture: SessionFixture,
  dependencies: readonly ReturnType<typeof dependency>[],
  hadFailure = false
): Promise<void> {
  const transcriptPath =
    fixture.session.providerConfig.runtimeEnvironment
      .REVIEWROUTER_CONTEXT_TRANSCRIPT_PATH!;
  const replayMaterialPath =
    fixture.session.providerConfig.runtimeEnvironment
      .REVIEWROUTER_CONTEXT_REPLAY_MATERIAL_PATH!;
  await writeFile(
    transcriptPath,
    canonicalJson({
      transcriptVersion: 1,
      sessionId: fixture.serverSession.sessionId,
      gatewayPolicyVersion: CONTEXT_GATEWAY_POLICY_VERSION,
      gatewayBinaryHash: fixture.gatewayHash,
      checkoutTreeOid: fixture.checkoutTreeOid,
      eventChainSeedHash: fixture.serverSession.eventChainSeedHash,
      authenticatedChainHash:
        dependencies.at(-1)?.eventHash ??
        fixture.serverSession.eventChainSeedHash,
      dependencies,
      hadFailure,
      updatedAtMs: 1,
    })
  );
  await writeFile(
    replayMaterialPath,
    canonicalJson({
      replayMaterialVersion: 1,
      sessionId: fixture.serverSession.sessionId,
      entries: [],
    })
  );
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd });
  return stdout;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
