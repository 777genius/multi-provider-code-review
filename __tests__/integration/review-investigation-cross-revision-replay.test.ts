import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import {
  ReviewActionV2OperationId,
  ReviewContextReceiptReplayCommitResultStatus,
  ReviewInvestigationMutationResultStatus,
  ReviewInvestigationNextAction,
  ReviewInvestigationPublishedState,
  ReviewInvestigationReplayPrepareResultStatus,
} from '../../src/control-plane/generated/review-action-v2/review-action-v2';
import {
  ReplayInvestigationOnRevision,
  ReviewInvestigationCurrency,
} from '../../src/review-investigation/application';
import {
  ReviewInvestigationNextAction as DomainNextAction,
  ReviewInvestigationState,
} from '../../src/review-investigation/domain/investigation-state';
import {
  canonicalJson,
  sha256,
} from '../../src/review-investigation/domain/canonical-json';
import { ReviewActionV2InvestigationAdapter } from '../../src/review-investigation/infrastructure/review-action-v2-investigation-adapter';
import { CONTEXT_GATEWAY_V4_POLICY_VERSION } from '../../src/context-gateway/context-gateway-v4-contract';
import { ContextAttestationReplayRunner } from '../../src/review-orchestration/infrastructure/context-attestation-replay-runner';

const execFileAsync = promisify(execFile);

describe('cross-revision investigation replay E2E', () => {
  let root: string;
  let gatewayBundlePath: string;
  let sourceHead: string;

  beforeEach(async () => {
    root = await mkdtemp(
      path.join(os.tmpdir(), 'rr-investigation-replay-e2e-')
    );
    gatewayBundlePath = path.join(root, 'context-gateway.js');
    await writeFile(gatewayBundlePath, 'gateway-v4-e2e', 'utf8');
    await git(['init', '--initial-branch=main']);
    await git(['config', 'user.email', 'test@reviewrouter.local']);
    await git(['config', 'user.name', 'ReviewRouter Test']);
    await writeFile(path.join(root, 'src.ts'), 'export const value = 1;\n');
    await git(['add', 'src.ts']);
    await git(['commit', '-m', 'test: source revision']);
    sourceHead = await revParse('HEAD');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reuses unchanged receipts and enters fresh target discovery before critic', async () => {
    await git(['commit', '--allow-empty', '-m', 'test: unchanged target']);
    const result = await executeReplay(sha256('export const value = 1;\n'));

    expect(result?.state).toBe(ReviewInvestigationState.AwaitingTurn);
    expect(result?.nextAction).toBe(DomainNextAction.RunTurn);
    expect(result?.satisfiedObligationCount).toBe(1);
  });

  it('reopens only the mismatched receipt when selected content changed', async () => {
    await writeFile(path.join(root, 'src.ts'), 'export const value = 2;\n');
    await git(['add', 'src.ts']);
    await git(['commit', '-m', 'test: changed target']);
    const result = await executeReplay(sha256('export const value = 1;\n'));

    expect(result?.state).toBe(ReviewInvestigationState.AwaitingTurn);
    expect(result?.nextAction).toBe(DomainNextAction.RunTurn);
    expect(result?.openObligationCount).toBe(1);
  });

  async function executeReplay(expectedContentHash: string) {
    const headSha = await revParse('HEAD');
    const targetCheckoutTreeOid = await revParse('HEAD^{tree}');
    const targetRevision = {
      baseSha: sourceHead,
      mergeBaseSha: sourceHead,
      headSha,
      reviewRevisionHash: sha256(`revision:${headSha}`),
    };
    const prepared = replayPreparation();
    let receiptMatched = false;
    const client = {
      execute: jest.fn(
        async (
          operation: ReviewActionV2OperationId,
          payload: Readonly<Record<string, unknown>>
        ) => {
          if (
            operation ===
            ReviewActionV2OperationId.ReviewInvestigationReplayPrepare
          ) {
            return prepared.response;
          }
          if (
            operation ===
            ReviewActionV2OperationId.ReviewContextReceiptReplayCommit
          ) {
            const manifest = JSON.parse(
              stringValue(payload.replayResultCanonicalJson)
            );
            receiptMatched =
              payload.attestationId === 'attestation-e2e' &&
              payload.attestationHash === sha256('attestation-e2e') &&
              payload.replayCapability === 'replay.capability.e2e' &&
              payload.targetReviewRevisionHash ===
                targetRevision.reviewRevisionHash &&
              payload.targetCheckoutTreeOid === targetCheckoutTreeOid &&
              payload.replayResultHash ===
                sha256(stringValue(payload.replayResultCanonicalJson)) &&
              manifest.manifestVersion === 3 &&
              manifest.checkoutTreeOid === targetCheckoutTreeOid &&
              manifest.gatewayPolicyVersion ===
                CONTEXT_GATEWAY_V4_POLICY_VERSION &&
              manifest.gatewayBinaryHash === sha256('gateway-v4-e2e') &&
              manifest.complete === true &&
              manifest.confinementTainted === false &&
              manifest.terminalFailureClass === null &&
              manifest.events.length === 1 &&
              manifest.events[0]?.operationKind === 'file_read' &&
              manifest.events[0]?.outcome === 'succeeded' &&
              manifest.events[0]?.result?.contentHash === expectedContentHash;
            return {
              status: receiptMatched
                ? ReviewContextReceiptReplayCommitResultStatus.Accepted
                : ReviewContextReceiptReplayCommitResultStatus.Denied,
              replayProofId: receiptMatched ? 'proof-e2e' : null,
              replayProofHash: receiptMatched ? sha256('proof-e2e') : null,
            };
          }
          if (
            operation === ReviewActionV2OperationId.ReviewInvestigationReplayV2
          ) {
            const proofs = JSON.parse(
              stringValue(payload.replayProofsCanonicalJson)
            );
            const reused =
              receiptMatched &&
              proofs.length === 1 &&
              proofs[0]?.obligationId === sha256('obligation-e2e') &&
              proofs[0]?.replayProofId === 'proof-e2e';
            return investigationResult(reused);
          }
          throw new Error(`unexpected_operation:${operation}`);
        }
      ),
    };
    const controlPlane = new ReviewActionV2InvestigationAdapter(
      client as never
    );
    const useCase = new ReplayInvestigationOnRevision({
      controlPlane,
      receipts: new ContextAttestationReplayRunner({
        checkoutRoot: root,
        gatewayBundlePath,
      }),
      currency: {
        check: async () => ReviewInvestigationCurrency.Current,
      },
    });
    const providerManifestCanonicalJson = '{}';
    const open = {
      authorizationToken: 'authorization-token',
      authorizationId: 'authorization-e2e',
      executionId: 'execution-e2e',
      workSlotId: 'slot-e2e',
      reviewRevisionHash: targetRevision.reviewRevisionHash,
      stableReviewUnitKey: 'stable-unit-e2e',
      providerVoteLaneId: 'lane-e2e',
      providerStrategyId: sha256('strategy-e2e'),
      runtimeProfile: 'gateway_attested_agent_v1',
      coverageContract: {},
      investigationPolicy: {},
      seedEnvelope: {
        canonicalJson: '{}',
        hash: sha256('{}'),
      },
      initialReceipts: [],
      providerManifestCanonicalJson,
      providerManifestHash: sha256(providerManifestCanonicalJson),
      ownerIdHash: sha256('owner-e2e'),
    };

    return useCase.execute({
      open,
      scope: {
        workspaceId: 'workspace-e2e',
        repositoryConnectionId: 'connection-e2e',
        scmRepositoryIdentityId: 'repository-e2e',
        pullRequestNumber: 1,
        trustDomain: 'test',
        authorizationScopeHash: sha256('scope-e2e'),
      },
      revision: targetRevision,
      providerManifestCanonicalJson,
      providerManifestHash: sha256(providerManifestCanonicalJson),
    });
  }

  function replayPreparation() {
    const contextAttestationId = 'attestation-e2e';
    const contextAttestationHash = sha256(contextAttestationId);
    const sourceOperationReceiptIds = [sha256('source-receipt-e2e')];
    const sourceOperationReceiptIdsHash = sha256(
      canonicalJson({ operationReceiptIds: sourceOperationReceiptIds })
    );
    const replayPlanCanonicalJson = canonicalJson({
      planVersion: 2,
      attestationId: contextAttestationId,
      attestationHash: contextAttestationHash,
      gatewayPolicyVersion: CONTEXT_GATEWAY_V4_POLICY_VERSION,
      gatewayBinaryHash: sha256('gateway-v4-e2e'),
      sourceOperationReceiptIds,
      sourceOperationReceiptIdsHash,
      operations: [
        {
          operationKind: 'file_read',
          replayInput: {
            path: 'src.ts',
            revision: 'head',
            startByte: 0,
            maxBytes: 4096,
          },
        },
      ],
    });
    const replayPreparationCanonicalJson = canonicalJson({
      obligations: [
        {
          obligationId: sha256('obligation-e2e'),
          contextAttestationId,
          contextAttestationHash,
          sourceOperationReceiptIdsHash,
          replayCapability: 'replay.capability.e2e',
          replayPlanCanonicalJson,
          replayPlanHash: sha256(replayPlanCanonicalJson),
        },
      ],
    });
    return {
      response: {
        status: ReviewInvestigationReplayPrepareResultStatus.Prepared,
        sourceInvestigationId: 'source-investigation-e2e',
        sourceCertificateId: 'source-certificate-e2e',
        sourceCertificateHash: sha256('source-certificate-e2e'),
        replayPreparationCanonicalJson,
        replayPreparationHash: sha256(replayPreparationCanonicalJson),
      },
    };
  }

  function investigationResult(reused: boolean) {
    const state = ReviewInvestigationState.AwaitingTurn;
    const nextAction = DomainNextAction.RunTurn;
    const readModel = {
      investigationId: 'target-investigation-e2e',
      version: 1,
      state,
      dossierDigest: sha256(`dossier:${state}`),
      openObligationCount: reused ? 0 : 1,
      satisfiedObligationCount: reused ? 1 : 0,
      unresolvableObligationCount: 0,
      findingCount: 0,
      semanticTurns: 0,
      operationalAttempts: 0,
      criticCycles: 0,
      nextEligibleAt: null,
      nextAction,
      turn: null,
      certificateId: null,
      certificateHash: null,
      terminalProviderKind: null,
      terminalActualModel: null,
      terminalObservationCanonicalJson: null,
      terminalOutcomeHash: null,
      conclusion: null,
    };
    return {
      status: ReviewInvestigationMutationResultStatus.Applied,
      investigationId: readModel.investigationId,
      investigationVersion: '1',
      investigationState: ReviewInvestigationPublishedState.AwaitingTurn,
      dossierDigest: readModel.dossierDigest,
      nextAction: ReviewInvestigationNextAction.RunTurn,
      investigationCanonicalJson: canonicalJson(readModel),
      certificateId: null,
      certificateHash: null,
      terminalProviderKind: null,
      terminalActualModel: null,
      terminalObservationCanonicalJson: null,
      terminalOutcomeHash: null,
      investigationConclusion: null,
    };
  }

  async function git(args: readonly string[]) {
    await execFileAsync('git', args, { cwd: root });
  }

  async function revParse(spec: string) {
    const { stdout } = await execFileAsync('git', ['rev-parse', spec], {
      cwd: root,
    });
    return stdout.trim().toLowerCase();
  }
});

function stringValue(value: unknown): string {
  if (typeof value !== 'string') throw new Error('test_string_missing');
  return value;
}
