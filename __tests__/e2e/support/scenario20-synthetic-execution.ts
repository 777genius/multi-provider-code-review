import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import path from 'path';
import { createReviewInvestigationProbePlan } from '../../../src/review-investigation/domain/deterministic-context-probe-plan';
import {
  ReviewEvidenceLookupKind,
  ReviewExecutionProviderKind,
  ReviewInvocationFailureClass,
  ReviewInvocationLeaseAcquireOutcomeStatus,
  ReviewPublicationRequestOutcomeStatus,
  ReviewPublicationState,
  RestoredReviewExecutionState,
  RestoredReviewWorkSlotState,
  ReviewTaskKind,
  RunT0ReviewOrchestration,
  canonicalizeReviewWorkSlots,
  type RestoredReviewExecution,
  type RestoredReviewWorkSlot,
  type ReviewActionV2ControlPlanePort,
  type ReviewOrchestrationDelayPort,
  type ReviewOrchestrationIdentityPort,
  type ReviewRunAuthorization,
  type ReviewWorkSlotPlan,
  type RunT0ReviewOrchestrationCommand,
  type RunT0ReviewOrchestrationDependencies,
} from '../../../src/review-orchestration/application';
import {
  createReviewPromptCoverageManifest,
  ReviewPromptPathCoverageKind,
} from '../../../src/review-orchestration/domain';
import { MergeGateConclusion } from '../../../src/review-projection/domain';

const childGuard = 'REVIEW_ROUTER_SCENARIO20_PARENT_PID';
export const scenario20ChildSuccess = 'scenario20 isolated assertions passed';

// Re-enter only this test in a new Node process. In particular, --runInBand
// prevents Jest from putting the measurement in a worker shared with other tests.
export function enterIsolatedScenario20(
  testFile: string,
  testName: string
): boolean {
  const parentPid = process.env[childGuard];
  if (parentPid !== undefined) {
    if (parentPid !== String(process.ppid)) {
      throw new Error('scenario20 invalid child recursion guard');
    }
    return true;
  }
  const root = path.resolve(__dirname, '../../..');
  const child = spawnSync(
    process.execPath,
    [
      require.resolve('jest/bin/jest'),
      '--config',
      path.join(root, 'jest.config.js'),
      '--runInBand',
      '--runTestsByPath',
      testFile,
      '--testNamePattern',
      `^${testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      '--watch=false',
      '--watchAll=false',
      '--coverage=false',
      '--testTimeout=120000',
    ],
    {
      cwd: root,
      env: { ...process.env, [childGuard]: String(process.pid) },
      encoding: 'utf8',
      // Synchronous waiting ensures the outer Jest timeout cannot leave a
      // running child behind. SIGKILL bounds timeout/output overflow cleanup;
      // runInBand creates no Jest worker descendants to clean up.
      timeout: 150_000,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 ** 2,
    }
  );
  if (
    child.error ||
    child.signal ||
    child.status !== 0 ||
    !child.stdout?.split(/\r?\n/).includes(scenario20ChildSuccess)
  ) {
    throw new Error(
      `scenario20 child failed: status=${child.status} signal=${child.signal}` +
        ` error=${child.error?.message ?? 'none'}\n${child.stdout ?? ''}\n${child.stderr ?? ''}`
    );
  }
  process.stdout.write(child.stdout);
  return false;
}

// Dedicated scenario20 adapter fixture, following the T0 unit fixture's scripted ports.
// Production owns dispatch, evidence acceptance and publication sequencing. These
// ports simulate admission/publication; they do not prove server limits or providers.
export async function executeSyntheticReviewBatches(
  batches: readonly { units: readonly { value: string }[] }[]
) {
  const executed = new Map<string, number>();
  let activeBatches = 0;
  let activeUnits = 0;
  let peakBatches = 0;
  let peakUnits = 0;
  let peakRssBytes = 0;
  let peakHeapUsedBytes = 0;
  const sampleMemory = () => {
    const memory = process.memoryUsage();
    peakRssBytes = Math.max(peakRssBytes, memory.rss);
    peakHeapUsedBytes = Math.max(peakHeapUsedBytes, memory.heapUsed);
  };
  const pathsFor = (slotId: string) => {
    const batch = batches[Number(slotId.slice('slot-'.length))];
    if (!batch) throw new Error(`scenario20_unknown_slot:${slotId}`);
    return batch.units.map((unit) => unit.value);
  };
  // Keep durable slot state separate from returned snapshots: admission must
  // remain pending while the pre-publication restore sees committed attachments.
  let durableExecution: Omit<RestoredReviewExecution, 'workSlots'> | null =
    null;
  const durableSlots = new Map<string, RestoredReviewWorkSlot>();
  const committedByLease = new Map<string, string>();
  const snapshot = (): RestoredReviewExecution | null =>
    durableExecution && {
      ...durableExecution,
      workSlots: [...durableSlots.values()].map((slot) => ({ ...slot })),
    };
  const requireSlot = (workSlotId: string): RestoredReviewWorkSlot => {
    const slot = durableSlots.get(workSlotId);
    if (!slot || !durableExecution)
      throw new Error('scenario20_slot_not_admitted');
    return slot;
  };
  const controlPlane = {
    authorize: jest.fn().mockResolvedValue(authorization),
    renewAuthorization: jest
      .fn()
      .mockImplementation(async (input) =>
        renewedAuthorization(input.authorization, input.requestedTtlMs)
      ),
    restoreSnapshot: jest.fn().mockResolvedValue(undefined),
    restoreExecution: jest.fn().mockImplementation(async () => snapshot()),
    startExecution: jest.fn().mockImplementation(async (input) => {
      if (durableExecution) throw new Error('scenario20_duplicate_admission');
      durableExecution = {
        executionId: input.executionId,
        version: '1',
        streamVersion: '1',
        generation: '1',
        state: RestoredReviewExecutionState.Running,
        authorizationId: input.authorization.authorizationId,
        reviewRevisionHash: input.reviewRevisionHash,
        planHash: input.planHash,
      };
      for (const slot of input.workSlots as readonly ReviewWorkSlotPlan[]) {
        durableSlots.set(slot.workSlotId, {
          workSlotId: slot.workSlotId,
          state: RestoredReviewWorkSlotState.Pending,
          required: slot.required,
          providerVoteIdentityHash: slot.providerVoteIdentityHash,
          activeLeaseId: null,
          acceptedObservationRefId: null,
        });
      }
      return {
        executionId: durableExecution.executionId,
        generation: durableExecution.generation,
        streamVersion: durableExecution.streamVersion,
        executionVersion: durableExecution.version,
        restoredExecution: snapshot()!,
      };
    }),
    terminalizeWorkSlot: jest.fn().mockResolvedValue({ streamVersion: '1' }),
    supersedeExecution: jest.fn().mockResolvedValue(undefined),
    lookupEvidence: jest
      .fn()
      .mockResolvedValue({ kind: ReviewEvidenceLookupKind.Miss }),
    acquireInvocationLease: jest.fn().mockResolvedValue({
      status: ReviewInvocationLeaseAcquireOutcomeStatus.Acquired,
      lease,
    }),
    renewInvocationLease: jest.fn().mockResolvedValue(lease),
    releaseInvocationLease: jest.fn().mockResolvedValue(undefined),
    commitEvidence: jest.fn().mockResolvedValue({
      observationId: 'observation-1',
      historicalOnly: false,
      eligibilityPolicyVersion: 't0-v1',
    }),
    attachObservation: jest.fn().mockResolvedValue({ streamVersion: '2' }),
    adoptObservation: jest.fn().mockResolvedValue({ streamVersion: '2' }),
    finalizeExecution: jest
      .fn()
      .mockResolvedValue({ publicationPermit: 'publication.permit' }),
    requestPublication: jest.fn().mockResolvedValue({
      status: ReviewPublicationRequestOutcomeStatus.Requested,
      publicationAttemptId: 'publication-1',
      pollAfterMs: 0,
    }),
    readPublicationStatus: jest.fn().mockResolvedValue({
      terminal: true,
      outcome: {
        state: ReviewPublicationState.Succeeded,
        canonicalReceiptSetHash: hash('receipt'),
      },
    }),
  } as jest.Mocked<ReviewActionV2ControlPlanePort>;
  const workSlots: ReviewWorkSlotPlan[] = batches.map((_, index) => ({
    workSlotId: `slot-${index}`,
    taskKind: ReviewTaskKind.FindingDiscovery,
    providerKind: ReviewExecutionProviderKind.Codex,
    providerVoteIdentityHash: hash('vote'),
    shardKey: `batch-${index}`,
    required: true,
    attemptBudget: 1,
    retryPolicyVersion: 'retry-v1',
  }));
  const command: RunT0ReviewOrchestrationCommand = {
    executionId: 'execution-1',
    baseSha: '1'.repeat(40),
    mergeBaseSha: '2'.repeat(40),
    headSha: '3'.repeat(40),
    reviewRevisionHash: hash('revision'),
    compatibilityKey: hash('compatibility'),
    planHash: hash('plan'),
    workSlotsCanonicalJson: canonicalizeReviewWorkSlots(workSlots),
    assignmentManifestCanonicalJson: '{"manifestVersion":1}',
    assignmentManifestHash: hash('{"manifestVersion":1}'),
    workSlots,
    sourceRunId: 'run-1',
    sourceRunAttempt: '1',
    ownerIdHash: hash('owner'),
    allowPartial: false,
  };
  let monotonicNowMs = 0;
  const dependencies = {
    controlPlane,
    revisionGuard: {
      loadCurrentRevision: jest.fn().mockResolvedValue(revisionOf(command)),
    },
    oidc: { getToken: jest.fn().mockResolvedValue('oidc.token') },
    invocationManifestAssembler: {
      // Unique identities prevent synthetic cross-batch evidence reuse.
      assemble: async (invocation) => ({
        manifestCanonicalJson: JSON.stringify({ slot: invocation.workSlotId }),
        manifestKey: hash(`manifest:${invocation.workSlotId}`),
        providerInvocationKey: hash(`invocation:${invocation.workSlotId}`),
        providerVoteIdentityHash: hash('vote'),
      }),
    },
    invocations: {
      prepare: async ({ workSlot, attemptOrdinal }) => ({
        workSlotId: workSlot.workSlotId,
        attemptOrdinal,
        provider: 'codex',
        requestedModel: 'gpt-test',
        reviewPrompt: JSON.stringify(pathsFor(workSlot.workSlotId)),
        investigationContextPrompt: null,
        investigationProbePlan: createReviewInvestigationProbePlan({
          files: [],
          fullDiff: '',
        }),
        immutableRequest: Object.freeze(pathsFor(workSlot.workSlotId)),
        coverageManifest: createReviewPromptCoverageManifest({
          workSlotId: workSlot.workSlotId,
          reviewRevisionHash: command.reviewRevisionHash,
          assignedPaths: pathsFor(workSlot.workSlotId),
          pathCoverage: pathsFor(workSlot.workSlotId).map((path) => ({
            path,
            kind: ReviewPromptPathCoverageKind.FullPatch,
            contentHash: hash(path),
          })),
        }),
        manifestFacts: Object.freeze({
          taskKindSet: [workSlot.taskKind],
          providerKind: workSlot.providerKind,
          providerCapabilityHash: hash('capability'),
          providerRequestEnvelopeHash: hash('request'),
          outputSchemaHash: hash('schema'),
          filePatchManifestHash: hash('patch'),
          contextManifestHash: hash('context'),
          lifecycleTargetSetHash: null,
          liveLifecycleStateHash: null,
          toolPolicyHash: hash('tool-policy'),
          executionProfile: 'prompt_only_envelope_v1' as const,
          baseTreeHash: null,
          environmentContractHash: hash('environment'),
        }),
      }),
      execute: async ({ invocation }) => {
        const paths = invocation.immutableRequest;
        if (
          !Array.isArray(paths) ||
          !paths.every((path) => typeof path === 'string')
        ) {
          throw new Error('scenario20_invalid_synthetic_request');
        }
        activeBatches += 1;
        activeUnits += paths.length;
        peakBatches = Math.max(peakBatches, activeBatches);
        peakUnits = Math.max(peakUnits, activeUnits);
        sampleMemory();
        try {
          // A real asynchronous boundary makes overlapping dispatch observable.
          await new Promise<void>((resolve) => setImmediate(resolve));
          for (const path of paths) {
            executed.set(path, (executed.get(path) ?? 0) + 1);
          }
          sampleMemory();
          return observationPayload;
        } finally {
          activeBatches -= 1;
          activeUnits -= paths.length;
        }
      },
    },
    invocationFailureClassifier: {
      classify: jest
        .fn()
        .mockReturnValue(ReviewInvocationFailureClass.Retryable),
    },
    invocationDiagnostics: {
      recordFailure: jest.fn(),
    },
    investigationDiagnostics: {
      record: jest.fn(),
    },
    leaseSupervisor: {
      run: async ({ operation, lease: currentLease }) =>
        operation(new AbortController().signal, () => currentLease),
    },
    projectionBuilder: {
      build: jest
        .fn<
          ReturnType<
            RunT0ReviewOrchestrationDependencies['projectionBuilder']['build']
          >,
          Parameters<
            RunT0ReviewOrchestrationDependencies['projectionBuilder']['build']
          >
        >()
        .mockResolvedValue(projection),
    },
    identities: {
      deterministicId: jest.fn(
        (namespace, parts) =>
          `rr:${namespace}:${hash(parts.join('|')).slice(0, 32)}`
      ),
    } satisfies ReviewOrchestrationIdentityPort,
    clock: {
      monotonicNowMs: jest.fn(() => monotonicNowMs),
    },
    delay: {
      sleep: jest.fn().mockImplementation(async (delayMs: number) => {
        monotonicNowMs += delayMs;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }),
    } satisfies ReviewOrchestrationDelayPort,
  } satisfies RunT0ReviewOrchestrationDependencies;
  controlPlane.acquireInvocationLease.mockImplementation(
    async ({ workSlot }) => {
      const slot = requireSlot(workSlot.workSlotId);
      if (slot.state !== RestoredReviewWorkSlotState.Pending) {
        throw new Error('scenario20_slot_not_pending');
      }
      const acquiredLease = {
        ...lease,
        leaseId: `lease:${workSlot.workSlotId}`,
        attemptId: `attempt:${workSlot.workSlotId}`,
      };
      durableSlots.set(slot.workSlotId, {
        ...slot,
        state: RestoredReviewWorkSlotState.Leased,
        activeLeaseId: acquiredLease.leaseId,
      });
      durableExecution = {
        ...durableExecution!,
        version: String(BigInt(durableExecution!.version) + 1n),
      };
      return {
        status: ReviewInvocationLeaseAcquireOutcomeStatus.Acquired,
        lease: acquiredLease,
      };
    }
  );
  const attached = new Set<string>();
  controlPlane.attachObservation.mockImplementation(
    async ({ execution, workSlot, observation }) => {
      const slot = requireSlot(workSlot.workSlotId);
      if (attached.has(slot.workSlotId)) {
        throw new Error('scenario20_duplicate_attachment');
      }
      if (
        slot.state !== RestoredReviewWorkSlotState.Leased ||
        !slot.activeLeaseId ||
        committedByLease.get(slot.activeLeaseId) !==
          observation.observationId ||
        execution.executionId !== durableExecution!.executionId ||
        execution.streamVersion !== durableExecution!.streamVersion
      ) {
        throw new Error('scenario20_invalid_attachment');
      }
      durableSlots.set(slot.workSlotId, {
        ...slot,
        state: RestoredReviewWorkSlotState.Satisfied,
        activeLeaseId: null,
        acceptedObservationRefId: `obsref:${hash(
          JSON.stringify({
            executionId: execution.executionId,
            observationId: observation.observationId,
            workSlotId: slot.workSlotId,
          })
        )}`,
      });
      attached.add(slot.workSlotId);
      durableExecution = {
        ...durableExecution!,
        version: String(BigInt(durableExecution!.version) + 1n),
        streamVersion: String(BigInt(durableExecution!.streamVersion) + 1n),
      };
      return { streamVersion: durableExecution.streamVersion };
    }
  );
  controlPlane.commitEvidence.mockImplementation(
    async ({ idempotencyKey, lease: currentLease }) => {
      const observationId = hash(idempotencyKey);
      committedByLease.set(currentLease.leaseId, observationId);
      return {
        observationId,
        historicalOnly: false,
        eligibilityPolicyVersion: 't0-v1',
      };
    }
  );
  controlPlane.finalizeExecution.mockImplementation(async ({ execution }) => {
    // Finalization must receive the actual refresh, including the execution
    // version that attach's stream-only response cannot update in admission.
    expect(execution.restoredExecution).toEqual(snapshot());
    expect(execution.executionVersion).toBe(durableExecution!.version);
    expect(execution.streamVersion).toBe(durableExecution!.streamVersion);
    expect(
      [...durableSlots.values()].every(
        (slot) =>
          slot.state === RestoredReviewWorkSlotState.Satisfied &&
          slot.activeLeaseId === null &&
          slot.acceptedObservationRefId !== null
      )
    ).toBe(true);
    return { publicationPermit: 'publication.permit' };
  });
  sampleMemory();
  const result = await new RunT0ReviewOrchestration(dependencies).execute(
    command
  );
  sampleMemory();
  // Linux reports process lifetime high-water RSS in KiB, including between samples.
  const processHighWaterRssBytes = process.resourceUsage().maxRSS * 1024;
  return {
    result,
    executed,
    attached,
    peakBatches,
    peakUnits,
    activeBatches,
    activeUnits,
    peakRssBytes,
    peakHeapUsedBytes,
    processHighWaterRssBytes,
    controlPlane,
    projectionCalls: jest.mocked(dependencies.projectionBuilder.build).mock
      .calls,
    workSlots,
  };
}

const authorization: ReviewRunAuthorization = {
  authorizationId: 'authorization-1',
  authorizationToken: 'authorization.token',
  producerReleaseId: 'release-1',
  protocolLimitsProfileId: 'limits-1',
  operationalSloProfileId: 'slo-1',
  mutationEpoch: '1',
  expiresAt: '2026-07-22T13:00:00.000Z',
  limits: {
    // Test-only admission ceiling, not an assertion of deployed server capacity.
    maxWorkSlots: 4096,
    maxAttemptsPerSlot: 3,
    maxObservationBytes: 100_000,
    maxObservationFindings: 100,
    maxProjectionBytes: 200_000,
    maxProjectionFindings: 100,
    maxPublicationOperations: 100,
    maxPublicationChunks: 20,
    maxPublicationBodyBytes: 200_000,
    maxRequestBatchSize: 20,
    maxLeaseDurationMs: 60_000,
    maxResultReportDurationMs: 60_000,
    maxReconciliationDurationMs: 60_000,
  },
  facts: {
    workspaceId: 'workspace-1',
    repositoryConnectionId: 'connection-1',
    scmRepositoryIdentityId: 'repository-1',
    pullRequestNumber: 252,
    sourceRunId: 'run-1',
    sourceRunAttempt: '1',
    baseSha: '1'.repeat(40),
    mergeBaseSha: '2'.repeat(40),
    headSha: '3'.repeat(40),
    reviewRevisionHash: hash('revision'),
    trustDomain: 'github-actions',
    producerReleaseId: 'release-1',
    selectedProtocolVersion: 'review-action-v2',
    schemaDigest: hash('schema-digest'),
    providerVoteLanes: [
      {
        providerKind: ReviewExecutionProviderKind.Codex,
        providerVoteIdentityHash: hash('vote'),
      },
    ],
  },
};

function renewedAuthorization(
  current: ReviewRunAuthorization,
  validForMsAtResponse: number
) {
  return {
    authorization: {
      ...current,
      authorizationToken: 'authorization.renewed-token',
      expiresAt: new Date(
        Date.parse('2026-07-22T12:00:00.000Z') + validForMsAtResponse
      ).toISOString(),
    },
    validForMsAtResponse,
  };
}

const lease = {
  leaseId: 'lease-1',
  attemptId: 'attempt-1',
  leaseCapability: 'lease.capability',
  fencingToken: '1',
  expiresAt: '2026-07-22T12:10:00.000Z',
  resultReportUntil: '2026-07-22T12:20:00.000Z',
  renewalCeilingReached: false,
};

const observationPayload = {
  payloadCanonicalJson: '{"findings":[]}',
  payloadHash: hash('{"findings":[]}'),
  byteCount: 15,
  findingCount: 0,
  actualModel: 'gpt-test',
  qualityFlags: [] as readonly string[],
  transportAttemptCount: 1,
  schemaValidated: true,
  fullyConsumed: true,
};

const projection = {
  artifactId: 'artifact-1',
  artifactHash: hash('artifact'),
  projectionEnvelopeVersion: 1,
  projectionEnvelopeCanonicalJson: '{"findings":[]}',
  projectionHash: hash('projection'),
  lifecycleStateHash: hash('lifecycle'),
  commandLedgerWatermark: '1',
  operationsCanonicalJson: '[]',
  findingCount: 0,
  publicationOperationCount: 0,
  publicationChunkCount: 0,
  coverageComplete: true,
  mergeGateConclusion: MergeGateConclusion.Pass,
};

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function revisionOf(command: RunT0ReviewOrchestrationCommand) {
  return {
    baseSha: command.baseSha,
    mergeBaseSha: command.mergeBaseSha,
    headSha: command.headSha,
    reviewRevisionHash: command.reviewRevisionHash,
    pullRequestState: 'open' as const,
  };
}
