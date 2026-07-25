import { execFile } from 'child_process';
import { createHash, createHmac } from 'crypto';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import {
  canonicalizeReviewContextConfinementEvidence,
  canonicalizeReviewContextGatewayEvent,
} from '../../../src/control-plane/generated/review-action-v2/review-action-v2';
import {
  CONTEXT_GATEWAY_POLICY_VERSION,
  canonicalJson,
} from '../../../src/context-gateway/context-gateway-contract';
import {
  ReviewContextInspectionFailureReason,
  type ReviewContextAttestationPort,
} from '../../../src/review-orchestration/application';
import { ContextGatewayInvocationSessionFactory } from '../../../src/review-orchestration/infrastructure/context-gateway-invocation-session';

const execFileAsync = promisify(execFile);

describe('ContextGatewayInvocationSessionFactory', () => {
  it('seals a complete changed_paths witness with a non-empty replay plan', async () => {
    const fixture = await openSessionFixture();
    try {
      await writeTranscript(fixture, [
        dependency(
          fixture,
          {
            kind: 'git_fact',
            fact: 'changed_paths',
            operandsHash: hash(
              canonicalJson({
                baseSha: fixture.revision.baseSha,
                headSha: fixture.revision.headSha,
              })
            ),
          },
          {
            kind: 'git_fact',
            resultHash: hash(canonicalJson([])),
            itemCount: 0,
            byteCount: Buffer.byteLength(canonicalJson([]), 'utf8'),
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
      ).toHaveLength(1);
      expect(fixture.planningGatewayHash).toBe(fixture.gatewayHash);
      expect(fixture.session.providerConfig.gatewayBinaryHash).toBe(
        fixture.gatewayHash
      );
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
});

type SessionFixture = Awaited<ReturnType<typeof openSessionFixture>>;

async function openSessionFixture() {
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
    commitContextReplay: jest.fn(),
  };
  const factory = new ContextGatewayInvocationSessionFactory(
    attestations as unknown as ReviewContextAttestationPort,
    { checkoutRoot, gatewayBundlePath }
  );
  const revision = {
    baseSha: (await git(checkoutRoot, ['rev-parse', 'HEAD'])).trim(),
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
    sourceExecutionId: 'execution-1',
    sourceWorkSlotId: 'slot-1',
    sourceReviewRevisionHash: hash('revision'),
    providerKind: 'codex',
    requestedModel: 'gpt-test',
    executionProfile: 'context_gateway_v1',
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
    invocationLease,
    planningGatewayHash: planning.gatewayBinaryHash,
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
