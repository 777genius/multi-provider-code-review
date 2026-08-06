import { build } from 'esbuild';
import { chmod, mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { ReviewActionV2Client } from '../../../src/control-plane/review-action-v2-client';
import { ReviewInvestigationCurrency } from '../../../src/review-investigation/application/investigation-control-plane-port';
import { RunInvestigationTurn } from '../../../src/review-investigation/application/run-investigation-turn';
import { RunInvestigationWorkSlot } from '../../../src/review-investigation/application/run-investigation-work-slot';
import type { ReviewInvestigationSnapshot } from '../../../src/review-investigation/domain/investigation-state';
import {
  ReviewAgentExecutionProfile,
  ReviewAgentProviderKind,
} from '../../../src/review-investigation/domain/runtime-profile';
import {
  canonicalJson,
  sha256,
} from '../../../src/review-investigation/domain/canonical-json';
import { CodexReviewAgentAdapter } from '../../../src/review-investigation/infrastructure/codex-review-agent-adapter';
import { ContextGatewayV4InvestigationAdapter } from '../../../src/review-investigation/infrastructure/context-gateway-v4-investigation-adapter';
import { DeterministicReviewAgentSelector } from '../../../src/review-investigation/infrastructure/deterministic-review-agent-selector';
import { NodeReviewAgentProcessRunner } from '../../../src/review-investigation/infrastructure/review-agent-process-runner';
import type {
  ReviewAgentProcessRequest,
  ReviewAgentProcessResult,
  ReviewAgentProcessRunnerPort,
} from '../../../src/review-investigation/infrastructure/review-agent-process-runner';
import { ReviewActionV2InvestigationAdapter } from '../../../src/review-investigation/infrastructure/review-action-v2-investigation-adapter';
import { ReviewActionV2InvestigationLeaseAdapter } from '../../../src/review-investigation/infrastructure/review-action-v2-investigation-lease-adapter';
import { CONTEXT_GATEWAY_V4_POLICY_VERSION } from '../../../src/context-gateway/context-gateway-v4-contract';
import {
  ContextGatewayInvocationSessionFactory,
  SubprocessRequiredContextWitnessRunner,
} from '../../../src/review-orchestration/infrastructure/context-gateway-invocation-session';
import { ReviewActionV2ControlPlaneAdapter } from '../../../src/review-orchestration/infrastructure/review-action-v2-control-plane-adapter';
import { ReviewActionV2InvestigationContextAttestationAdapter } from '../../../src/review-orchestration/infrastructure/review-action-v2-investigation-context-attestation-adapter';
import type { DisposableInvestigationRepository } from './disposable-investigation-repository';
import {
  FakeReviewActionV2ControlPlane,
  createFakeControlPlaneStore,
  type FakeControlPlaneStore,
} from './fake-review-action-v2-control-plane';

export type FakeProviderScenario = Readonly<{
  mode?: 'success' | 'capacity' | 'kill';
  operations?: readonly Readonly<{
    tool: string;
    arguments: Readonly<Record<string, unknown>>;
    paginate?: boolean;
    stopAfterPages?: number;
    tamperNextCursor?: boolean;
    readMatchedPaths?: boolean;
    omitMatchedPaths?: readonly string[];
    substituteMatchedPath?: string;
    additionalMatchedPaths?: readonly string[];
  }>[];
  closureKinds?: readonly string[];
  findings?: readonly Readonly<Record<string, unknown>>[];
  unresolvableKinds?: readonly string[];
  criticDecision?: 'accept' | 'veto' | 'abstain' | null;
  delayMs?: number;
  maximumOperations?: number;
}>;

export type InvestigationSeed = Readonly<{
  kind: string;
  canonicalSubject: string;
  canonicalRequirement: string;
  riskPriority: number;
}>;

export type InvestigationHarness = Readonly<{
  store: FakeControlPlaneStore;
  processResults: ReviewAgentProcessResult[];
  controlPlane: FakeReviewActionV2ControlPlane;
  run(input: {
    readonly seeds: readonly InvestigationSeed[];
    readonly scenarioFor: (
      snapshot: ReviewInvestigationSnapshot,
      invocationOrdinal: number
    ) => FakeProviderScenario;
    readonly maxStateTransitions?: number;
    readonly currency?: () => ReviewInvestigationCurrency;
    readonly independentCriticThreshold?: number;
  }): Promise<Awaited<ReturnType<RunInvestigationWorkSlot['execute']>>>;
  restartControlPlane(): Promise<void>;
  dispose(): Promise<void>;
}>;

export async function createInvestigationHarness(
  repository: DisposableInvestigationRepository
): Promise<InvestigationHarness> {
  const artifacts = await buildTestArtifacts();
  const store = createFakeControlPlaneStore();
  const revision = {
    baseSha: repository.baseSha,
    mergeBaseSha: repository.mergeBaseSha,
    headSha: repository.headSha,
    reviewRevisionHash: repository.reviewRevisionHash,
  };
  const controlPlane = new FakeReviewActionV2ControlPlane(store, revision);
  await controlPlane.start();
  const processResults: ReviewAgentProcessResult[] = [];

  const run = async (input: {
    readonly seeds: readonly InvestigationSeed[];
    readonly scenarioFor: (
      snapshot: ReviewInvestigationSnapshot,
      invocationOrdinal: number
    ) => FakeProviderScenario;
    readonly maxStateTransitions?: number;
    readonly currency?: () => ReviewInvestigationCurrency;
    readonly independentCriticThreshold?: number;
  }) => {
    const client = new ReviewActionV2Client({
      apiUrl: controlPlane.apiUrl,
      allowInsecureLocalhost: true,
      maxAttempts: 2,
      requestIdFactory: requestIdFactory(),
    });
    const orchestrationControlPlane = new ReviewActionV2ControlPlaneAdapter(
      client
    );
    const authorization = await orchestrationControlPlane.authorize({
      oidcToken: 'oidc.e2e.token',
    });
    if (authorization.facts.reviewInvestigation === undefined) {
      throw new Error('e2e_investigation_authorization_descriptor_missing');
    }
    const investigationControlPlane = new ReviewActionV2InvestigationAdapter(
      client
    );
    const investigationLeases = new ReviewActionV2InvestigationLeaseAdapter(
      client,
      requestIdFactory()
    );
    const investigationGatewayAttestation =
      new ReviewActionV2InvestigationContextAttestationAdapter(
        client,
        authorization.authorizationToken
      );
    const gatewayFactory = new ContextGatewayInvocationSessionFactory(
      investigationGatewayAttestation,
      {
        checkoutRoot: repository.root,
        gatewayBundlePath: artifacts.gatewayBundlePath,
        policyVersion: CONTEXT_GATEWAY_V4_POLICY_VERSION,
      },
      new SubprocessRequiredContextWitnessRunner()
    );
    const gateway = new ContextGatewayV4InvestigationAdapter(gatewayFactory, {
      revision,
      preparedManifestKey: sha256('prepared-manifest-e2e'),
      providerKind: ReviewAgentProviderKind.Codex,
      requestedModel: 'gpt-e2e',
      executionProfile: ReviewAgentExecutionProfile.GatewayAttestedAgentV1,
      providerInvocationKey: sha256('provider-invocation-e2e'),
      toolPolicyHash: sha256('tool-policy-e2e'),
    });
    const processRunner = new RecordingProcessRunner(processResults);
    const codex = new CodexReviewAgentAdapter(processRunner, {
      executionSessions: gateway,
      binary: artifacts.fakeCodexPath,
      reasoningEffort: 'xhigh',
      processResultObserver: (result) => processResults.push(result),
    });
    const selector = new DeterministicReviewAgentSelector(
      [
        {
          providerKind: ReviewAgentProviderKind.Codex,
          agent: codex,
        },
      ],
      {
        allowedProviderKinds: [ReviewAgentProviderKind.Codex],
        ...(input.independentCriticThreshold === undefined
          ? {}
          : {
              requireIndependentCriticAtOrAboveRiskPriority:
                input.independentCriticThreshold,
            }),
      }
    );
    const turnRunner = new RunInvestigationTurn({
      controlPlane: investigationControlPlane,
      currency: {
        check: async () =>
          input.currency?.() ?? ReviewInvestigationCurrency.Current,
      },
      gateway,
      agents: selector,
      now: () => new Date('2026-08-03T22:00:00.000Z'),
    });
    const runner = new RunInvestigationWorkSlot({
      controlPlane: investigationControlPlane,
      delay: {
        sleep: async (delayMs) =>
          new Promise((resolve) => setTimeout(resolve, delayMs)),
      },
      leases: investigationLeases,
      turnRunner,
      now: () => new Date('2026-08-03T22:00:00.000Z'),
    });
    let invocationOrdinal = 0;
    const seedEnvelopeCanonicalJson = canonicalJson({
      contract: 'review_investigation_seed_envelope.v1',
      obligations: input.seeds,
      probePlanHash: sha256('e2e-probe-plan'),
      requestedModel: 'gpt-e2e',
      reviewPromptHash: sha256('e2e-review-prompt'),
    });
    return runner.execute({
      authorizationToken: authorization.authorizationToken,
      authorizationId: authorization.authorizationId,
      executionId: 'execution-e2e',
      workSlotId: 'work-slot-e2e',
      reviewRevisionHash: repository.reviewRevisionHash,
      stableReviewUnitKey: 'stable-unit-e2e',
      providerVoteLaneId: sha256('provider-vote-e2e'),
      providerStrategyId: sha256('provider-strategy-e2e'),
      runtimeProfile: ReviewAgentExecutionProfile.GatewayAttestedAgentV1,
      coverageContract: { version: 'e2e' },
      investigationPolicy: { version: 'e2e' },
      seedEnvelope: {
        canonicalJson: seedEnvelopeCanonicalJson,
        hash: sha256(seedEnvelopeCanonicalJson),
      },
      initialReceipts: [],
      providerManifestCanonicalJson: '{}',
      providerManifestHash: sha256('{}'),
      ownerIdHash: sha256('owner-e2e'),
      requestedModel: 'gpt-e2e',
      providerKind: ReviewAgentProviderKind.Codex,
      promptFor: (snapshot) => {
        invocationOrdinal += 1;
        return providerPrompt(
          snapshot,
          input.scenarioFor(snapshot, invocationOrdinal)
        );
      },
      workingDirectory: repository.root,
      turnBudget: {
        maxGatewayOperations: 1_500,
        maxOutputFindings: 64,
        maxOutputProposals: 64,
      },
      leaseDurationMs: 300_000,
      maxObligationsForTurn: 64,
      providerTimeoutMs: 60_000,
      providerMaxTurns: 12,
      certificateTtlMs: 3_600_000,
      minimumCapacityParkMs: 60_000,
      maxStateTransitions: input.maxStateTransitions ?? 32,
    });
  };

  return {
    store,
    processResults,
    controlPlane,
    run,
    restartControlPlane: () => controlPlane.restart(),
    dispose: async () => {
      await controlPlane.stop();
      await artifacts.dispose();
    },
  };
}

class RecordingProcessRunner implements ReviewAgentProcessRunnerPort {
  private readonly delegate = new NodeReviewAgentProcessRunner();

  constructor(private readonly results: ReviewAgentProcessResult[]) {}

  async run(
    request: ReviewAgentProcessRequest
  ): Promise<ReviewAgentProcessResult> {
    const result = await this.delegate.run(request);
    this.results.push(result);
    return result;
  }

  cancel(invocationId: string, fencingToken: string): Promise<void> {
    return this.delegate.cancel(invocationId, fencingToken);
  }
}

export function inventorySeed(reviewRevisionHash: string): InvestigationSeed {
  return Object.freeze({
    kind: 'inventory_witness',
    canonicalSubject: canonicalJson({
      kind: 'canonical_inventory',
      reviewRevisionHash,
      subjectVersion: 1,
    }),
    canonicalRequirement: canonicalJson({
      kind: 'complete_inventory',
      requirementVersion: 1,
      reviewRevisionHash,
    }),
    riskPriority: 100_000,
  });
}

export function fileSeed(input: {
  readonly path: string;
  readonly kind?: string;
  readonly revision?: 'head' | 'merge_base';
  readonly riskPriority?: number;
}): InvestigationSeed {
  const revision = input.revision ?? 'head';
  const pathHash = sha256(input.path);
  return Object.freeze({
    kind: input.kind ?? 'changed_content',
    canonicalSubject: canonicalJson({
      kind: 'file_read',
      pathHash,
      revision,
      subjectVersion: 1,
    }),
    canonicalRequirement: canonicalJson({
      kind:
        input.kind === undefined || input.kind === 'changed_content'
          ? 'complete_changed_file'
          : 'complete_file',
      path: input.path,
      pathHash,
      ...(input.kind === undefined || input.kind === 'changed_content'
        ? {
            referenceSearch: {
              operationInputHash: searchOperationInputHash(
                path.basename(input.path, path.extname(input.path))
              ),
              query: path.basename(input.path, path.extname(input.path)),
            },
          }
        : {}),
      requirementVersion: 1,
      revision,
    }),
    riskPriority: input.riskPriority ?? 500_000,
  });
}

export function searchSeed(input: {
  readonly kind: string;
  readonly query: string;
  readonly sourcePath: string;
  readonly riskPriority?: number;
}): InvestigationSeed {
  const initialOperationInputHash = searchOperationInputHash(input.query);
  return Object.freeze({
    kind: input.kind,
    canonicalSubject: canonicalJson({
      initialOperationInputHash,
      kind: 'text_search',
      obligationKind: input.kind,
      subjectVersion: 1,
    }),
    canonicalRequirement: canonicalJson({
      initialOperationInputHash,
      kind: 'complete_page_chain',
      operationKind: 'text_search',
      query: input.query,
      requirementVersion: 1,
      sourcePath: input.sourcePath,
    }),
    riskPriority: input.riskPriority ?? 500_000,
  });
}

export function scenarioFromBrief(
  snapshot: ReviewInvestigationSnapshot,
  options: Readonly<{
    omitRelatedPaths?: readonly string[];
    substituteRelatedPath?: string;
    additionalRelatedPaths?: readonly string[];
    stopSearchAfterPages?: number;
    tamperSearchCursor?: boolean;
    mode?: 'success' | 'capacity' | 'kill';
    delayMs?: number;
    criticDecision?: 'accept' | 'veto' | 'abstain';
  }> = {}
): FakeProviderScenario {
  if (snapshot.turn?.purpose === 'critic') {
    return {
      mode: options.mode,
      operations: [],
      criticDecision: options.criticDecision ?? 'accept',
      delayMs: options.delayMs,
    };
  }
  const operations: Array<{
    tool: string;
    arguments: Record<string, unknown>;
    paginate?: boolean;
    stopAfterPages?: number;
    tamperNextCursor?: boolean;
    readMatchedPaths?: boolean;
    omitMatchedPaths?: readonly string[];
    substituteMatchedPath?: string;
    additionalMatchedPaths?: readonly string[];
  }> = [];
  for (const obligation of snapshot.turn?.brief?.obligations ?? []) {
    const requirement = JSON.parse(obligation.canonicalRequirement) as Record<
      string,
      unknown
    >;
    switch (requirement.kind) {
      case 'complete_inventory':
        operations.push({
          tool: 'review_canonical_inventory',
          arguments: { pageSize: 500 },
          paginate: true,
        });
        break;
      case 'complete_changed_file':
      case 'complete_file':
        operations.push({
          tool: 'review_read_file',
          arguments: {
            path: requirement.path,
            revision: requirement.revision,
            startByte: 0,
            maxBytes: 2 * 1024 * 1024,
          },
        });
        break;
      case 'complete_page_chain':
        operations.push({
          tool: 'review_search_text',
          arguments: searchArguments(String(requirement.query)),
          paginate: true,
          stopAfterPages: options.stopSearchAfterPages,
          tamperNextCursor: options.tamperSearchCursor,
        });
        break;
      case 'complete_relation_context':
        operations.push({
          tool: 'review_search_text',
          arguments: searchArguments(String(requirement.query)),
          paginate: true,
          stopAfterPages: options.stopSearchAfterPages,
          tamperNextCursor: options.tamperSearchCursor,
          readMatchedPaths: true,
          omitMatchedPaths: options.omitRelatedPaths,
          substituteMatchedPath: options.substituteRelatedPath,
          additionalMatchedPaths: options.additionalRelatedPaths,
        });
        break;
    }
  }
  return {
    mode: options.mode,
    operations,
    closureKinds: ['*'],
    delayMs: options.delayMs,
  };
}

function providerPrompt(
  snapshot: ReviewInvestigationSnapshot,
  scenario: FakeProviderScenario
): string {
  if (!snapshot.turn?.brief) {
    throw new Error('e2e_turn_brief_missing');
  }
  return [
    'Deterministic disposable investigation fixture.',
    `REVIEWROUTER_INVESTIGATION_TURN_BRIEF_V1_BASE64URL:${Buffer.from(
      canonicalJson(snapshot.turn.brief),
      'utf8'
    ).toString('base64url')}`,
    `REVIEWROUTER_E2E_SCENARIO_V1_BASE64URL:${Buffer.from(
      canonicalJson(
        JSON.parse(JSON.stringify(scenario)) as Parameters<
          typeof canonicalJson
        >[0]
      ),
      'utf8'
    ).toString('base64url')}`,
  ].join('\n');
}

function searchArguments(query: string) {
  return {
    query,
    paths: ['.'],
    revision: 'head',
    caseSensitive: true,
    pageSize: 500,
  };
}

function searchOperationInputHash(query: string): string {
  return sha256(
    canonicalJson({
      caseSensitive: true,
      cursor: null,
      pageSize: 500,
      paths: ['.'],
      query: sha256(query),
      revision: 'head',
    })
  );
}

let requestSequence = 0;
function requestIdFactory(): () => string {
  return () => `e2e-request-${++requestSequence}`;
}

async function buildTestArtifacts() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'reviewrouter-investigation-artifacts-')
  );
  const fakeCodexPath = path.join(root, 'fake-codex.cjs');
  const gatewayBundlePath = path.join(root, 'context-gateway.cjs');
  await Promise.all([
    build({
      entryPoints: [
        path.resolve('__tests__/e2e/support/fake-codex-investigation-cli.ts'),
      ],
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      outfile: fakeCodexPath,
      logLevel: 'silent',
      banner: { js: '#!/usr/bin/env node' },
    }),
    build({
      entryPoints: [path.resolve('src/context-gateway/stdio-entry.ts')],
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      outfile: gatewayBundlePath,
      logLevel: 'silent',
    }),
  ]);
  await chmod(fakeCodexPath, 0o700);
  return {
    fakeCodexPath,
    gatewayBundlePath,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
