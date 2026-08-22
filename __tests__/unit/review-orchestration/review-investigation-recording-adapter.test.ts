import { createHash } from 'crypto';
import {
  ReviewExecutionProviderKind,
  ReviewInvocationConfigurationMismatchError,
  ReviewInvocationConfigurationMismatchReason,
  ReviewInvestigationRecordingMode,
  ReviewTaskKind,
} from '../../../src/review-orchestration/application';
import {
  ReviewInvestigationGatewayConfigurationError,
  ReviewInvestigationGatewayConfigurationFailureReason,
} from '../../../src/review-investigation/application/investigation-gateway-port';
import { ReviewPromptPathCoverageKind } from '../../../src/review-orchestration/domain';
import {
  REVIEW_INVESTIGATION_COVERAGE_PROFILE,
  REVIEW_INVESTIGATION_PRODUCTION_POLICY,
  ReviewInvestigationRecordingAdapter,
  ReviewInvestigationRecordingSupportReason,
  reviewInvestigationRecordingSupportDecision,
  reviewInvestigationCoverageContract,
  reviewInvestigationCoverageProfileHash,
  reviewInvestigationPolicyHash,
  reviewInvestigationActionBudgetForDepth,
} from '../../../src/review-orchestration/infrastructure/review-investigation-recording-adapter';
import { ReviewDepth } from '../../../src/types';
import {
  REVIEW_INVESTIGATION_TURN_MAX_OBLIGATIONS,
  ReviewInvestigationConclusion,
  ReviewInvestigationNextAction,
  ReviewInvestigationRunStatus,
  ReviewInvestigationState,
} from '../../../src/review-investigation/domain/investigation-state';
import { ReviewAgentProviderKind } from '../../../src/review-investigation/domain/runtime-profile';
import { ReviewTurnPurpose } from '../../../src/review-investigation/domain/turn-observation';
import { canonicalJson } from '../../../src/review-investigation/domain/canonical-json';
import {
  ReviewInvestigationChangedFileStatus,
  ReviewInvestigationProbePlanStatus,
  createReviewInvestigationProbePlan,
} from '../../../src/review-investigation/domain/deterministic-context-probe-plan';
import {
  buildReviewInvestigationSeedEnvelope,
  type ReviewInvestigationCanonicalInventory,
  type ReviewInvestigationCanonicalInventoryEntry,
} from '../../../src/review-investigation/domain/review-investigation-seed-envelope';
import {
  ReviewInvestigationDeferredSignal,
  ReviewInvestigationLegacyFallbackReason,
} from '../../../src/review-investigation/application/run-investigation-work-slot';
import { buildReviewInvestigationTurnPrompt } from '../../../src/review-investigation/application/review-investigation-turn-prompt';
import capabilityGolden from '../../../src/review-investigation/fixtures/review-investigation-capability-v1.golden.json';
import { logger } from '../../../src/utils/logger';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

describe('ReviewInvestigationRecordingAdapter', () => {
  it('builds isolated multi-turn prompts without altering review content', () => {
    const firstBrief = activeSnapshot().turn!.brief!;
    const secondBrief = {
      ...firstBrief,
      investigationVersion: firstBrief.investigationVersion + 1,
      turnId: 'turn-2',
    };
    const reviewContextPrompt = [
      'Investigate this diff.',
      'The changed source contains the literal FINAL OUTPUT CONTRACT marker.',
    ].join('\n');
    const first = buildReviewInvestigationTurnPrompt({
      reviewContextPrompt,
      turnBrief: firstBrief,
    });
    const second = buildReviewInvestigationTurnPrompt({
      reviewContextPrompt,
      turnBrief: secondBrief,
    });

    for (const prompt of [first, second]) {
      expect(prompt.match(/Investigate this diff\./g)).toHaveLength(1);
      expect(prompt.match(/REVIEW INVESTIGATION TURN CONTRACT:/g)).toHaveLength(
        1
      );
      expect(prompt).toContain('literal FINAL OUTPUT CONTRACT marker');
      expect(prompt.match(/TURN_BRIEF_V1_BASE64URL:/g)).toHaveLength(1);
    }
    expect(first).not.toBe(second);
  });

  it('reads removed changed content from merge-base instead of the absent head', () => {
    const { invocation } = executionInput();
    const path = 'src/removed.ts';
    const plan = createReviewInvestigationProbePlan({
      files: [probeFile(path, ReviewInvestigationChangedFileStatus.Removed)],
      fullDiff: '',
    });
    const coverageManifest = {
      ...invocation.coverageManifest,
      paths: [
        {
          path,
          kind: ReviewPromptPathCoverageKind.FullPatch,
          contentHash: null,
        },
      ],
    };
    const seeds = buildReviewInvestigationSeedEnvelope({
      canonicalInventory: canonicalInventory([
        inventoryEntry(path, ReviewInvestigationChangedFileStatus.Removed),
      ]),
      probePlan: plan,
      reviewPrompt: invocation.reviewPrompt,
      requestedModel: invocation.requestedModel,
      coverageManifest,
    }).envelope.obligations;
    const changed = seeds.find((seed) => seed.kind === 'changed_content')!;

    expect(JSON.parse(changed.canonicalSubject)).toEqual({
      kind: 'file_read',
      pathHash: hash(path),
      revision: 'merge_base',
      subjectVersion: 1,
    });
    expect(JSON.parse(changed.canonicalRequirement)).toMatchObject({
      kind: 'complete_changed_file',
      path,
      pathHash: hash(path),
      requirementVersion: 2,
      revision: 'merge_base',
    });
  });

  it('projects only a certificate-backed terminal observation', async () => {
    const terminalJson = '{"payloadVersion":2}';
    const execute = jest.fn(async (runInput) => {
      expect(runInput.providerManifestCanonicalJson).toBe('{}');
      expect(runInput.providerManifestHash).toBe('9'.repeat(64));
      expect(runInput.coverageContract).toEqual(
        reviewInvestigationCoverageContract('release-1')
      );
      const seedObligations = runInput.seedEnvelope.envelope.obligations;
      expect(seedObligations[0]).toMatchObject({ kind: 'inventory_witness' });
      expect(JSON.parse(seedObligations[0].canonicalSubject)).toMatchObject({
        kind: 'canonical_inventory',
        reviewRevisionHash: 'b'.repeat(64),
        subjectVersion: 2,
      });
      expect(
        seedObligations.filter(
          (item: { kind: string }) => item.kind === 'changed_content'
        )
      ).toHaveLength(6);
      expect(seedObligations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            canonicalSubject: fileSubject('src/a.ts', 'merge_base'),
            riskPriority: 500_000,
          }),
          expect.objectContaining({
            canonicalSubject: fileSubject('src/a.ts'),
            riskPriority: 500_000,
          }),
          expect.objectContaining({
            canonicalSubject: fileSubject('src/auth/session.ts', 'merge_base'),
            riskPriority: 900_000,
          }),
          expect.objectContaining({
            canonicalSubject: fileSubject('src/auth/session.ts'),
            riskPriority: 900_000,
          }),
          expect.objectContaining({
            canonicalSubject: fileSubject('src/z.ts', 'merge_base'),
            riskPriority: 500_000,
          }),
          expect.objectContaining({
            canonicalSubject: fileSubject('src/z.ts'),
            riskPriority: 500_000,
          }),
        ])
      );
      const requirements = runInput.seedEnvelope.envelope.obligations.map(
        (item: { canonicalRequirement: string }) =>
          JSON.parse(item.canonicalRequirement)
      );
      const changedRequirement = requirements.find(
        (requirement: { kind: string; path?: string; revision?: string }) =>
          requirement.kind === 'complete_changed_file' &&
          requirement.path === 'src/auth/session.ts' &&
          requirement.revision === 'head'
      );
      expect(Object.keys(changedRequirement).sort()).toEqual([
        'kind',
        'path',
        'pathHash',
        'requirementVersion',
        'revision',
      ]);
      expect(requirements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'complete_changed_file',
            path: 'src/auth/session.ts',
            pathHash: hash('src/auth/session.ts'),
            requirementVersion: 2,
            revision: 'head',
          }),
          expect.objectContaining({
            kind: 'complete_page_chain',
            matchMode: 'fixed_string',
            probeKind: 'declaration_identifier',
            query: 'refreshSession',
            queryHash: hash('refreshSession'),
            requirementVersion: 2,
          }),
          expect.objectContaining({
            kind: 'complete_page_chain',
            query: 'session.revoked',
            queryHash: hash('session.revoked'),
            requirementVersion: 2,
          }),
        ])
      );
      expect(
        requirements.filter(
          (requirement: { kind: string }) =>
            requirement.kind === 'complete_page_chain'
        ).length
      ).toBeGreaterThan(1);
      const prompt = runInput.promptFor(activeSnapshot());
      expect(prompt).toContain(
        'REVIEWROUTER_INVESTIGATION_TURN_BRIEF_V1_BASE64URL:'
      );
      expect(prompt).toContain('operationBackedDiscoveryClaims');
      expect(prompt).toContain('closureClaims only');
      expect(prompt).toContain('complete_relation_context obligation');
      expect(prompt).toContain('exactly every requiredPathHashes entry');
      expect(prompt).toContain('coverage_contract changed_content obligation');
      expect(prompt).toContain(
        'Never bind an exploratory search to a deterministic_expansion obligation'
      );
      expect(prompt).toContain('context_gateway_relation_path_limit_exceeded');
      expect(prompt).toContain('at most 512 files');
      expect(prompt).toContain('provider-neutral obligationProposals entry');
      expect(prompt).toContain(
        'exactly kind, canonicalSubject, canonicalRequirement, and riskPriority'
      );
      expect(prompt).toContain('never provide an obligation ID');
      expect(prompt).toContain(
        'Set criticDecision to null during discovery turns'
      );
      expect(prompt).toContain('Investigate the assigned change.');
      expect(prompt).not.toContain('Return ONLY one valid JSON object.');
      return {
        status: ReviewInvestigationRunStatus.Completed,
        snapshot: terminalSnapshot(terminalJson),
      };
    });
    const adapter = new ReviewInvestigationRecordingAdapter(
      () => ({ execute }) as never,
      options()
    );

    expect(adapter.mode).toBe(ReviewInvestigationRecordingMode.RecordOnly);
    expect(adapter.verifiedCleanEffectsEnabled).toBe(false);

    await expect(adapter.execute(executionInput())).resolves.toEqual({
      payloadCanonicalJson: terminalJson,
      payloadHash: hash(terminalJson),
      byteCount: Buffer.byteLength(terminalJson),
      findingCount: 0,
      actualModel: 'gpt-test',
      qualityFlags: ['investigation_verified_clean'],
      transportAttemptCount: 2,
      schemaValidated: true,
      fullyConsumed: true,
      investigationCertificateId: 'certificate-1',
      investigationCertificateHash: 'c'.repeat(64),
    });
  });

  it('claims the investigation manifest in record-only mode but not legacy gateway work', () => {
    const adapter = new ReviewInvestigationRecordingAdapter(
      () => ({ execute: jest.fn() }) as never,
      options()
    );
    const input = executionInput();
    expect(
      adapter.supports({
        workSlot: input.workSlot,
        invocation: input.invocation,
      })
    ).toBe(true);
    expect(
      adapter.supports({
        workSlot: input.workSlot,
        invocation: {
          ...input.invocation,
          manifestFacts: {
            ...input.invocation.manifestFacts,
            executionProfile: 'context_gateway_v1',
          },
        },
      })
    ).toBe(false);
  });

  it('does not claim lifecycle work', () => {
    const adapter = new ReviewInvestigationRecordingAdapter(
      () => ({ execute: jest.fn() }) as never,
      options()
    );
    const input = executionInput();
    expect(
      adapter.supports({
        workSlot: input.workSlot,
        invocation: {
          ...input.invocation,
          manifestFacts: {
            ...input.invocation.manifestFacts,
            taskKindSet: [ReviewTaskKind.LifecycleRevalidation],
          },
        },
      })
    ).toBe(false);
    expect(
      reviewInvestigationRecordingSupportDecision(
        {
          workSlot: input.workSlot,
          invocation: {
            ...input.invocation,
            manifestFacts: {
              ...input.invocation.manifestFacts,
              taskKindSet: [ReviewTaskKind.LifecycleRevalidation],
            },
          },
        },
        REVIEW_INVESTIGATION_PRODUCTION_POLICY
      )
    ).toEqual({
      supported: false,
      reason: ReviewInvestigationRecordingSupportReason.TaskKindSetUnsupported,
    });
  });

  it('reports the safe reason before an unsupported candidate returns early', () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    const adapter = new ReviewInvestigationRecordingAdapter(
      () => ({ execute: jest.fn() }) as never,
      options()
    );
    const input = executionInput();

    try {
      expect(
        adapter.supports({
          workSlot: input.workSlot,
          invocation: {
            ...input.invocation,
            investigationSeedEnvelope: null,
          },
        })
      ).toBe(false);
      expect(info).toHaveBeenCalledWith(
        'Review investigation candidate: supported=false reason=seed_envelope_missing'
      );
    } finally {
      info.mockRestore();
    }
  });

  it('keeps candidate eligibility unchanged when telemetry is unavailable', () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => {
      throw new Error('logger unavailable');
    });
    const adapter = new ReviewInvestigationRecordingAdapter(
      () => ({ execute: jest.fn() }) as never,
      options()
    );
    const input = executionInput();

    try {
      expect(
        adapter.supports({
          workSlot: input.workSlot,
          invocation: input.invocation,
        })
      ).toBe(true);
    } finally {
      info.mockRestore();
    }
  });

  it('reports every candidate reason with deterministic fail-closed precedence', () => {
    const base = executionInput();
    const candidate = (
      invocationOverrides: Readonly<Record<string, unknown>> = {},
      workSlotOverrides: Readonly<Record<string, unknown>> = {}
    ) => ({
      workSlot: { ...base.workSlot, ...workSlotOverrides },
      invocation: { ...base.invocation, ...invocationOverrides },
    });
    const manifest = (overrides: Readonly<Record<string, unknown>>) =>
      candidate({
        manifestFacts: { ...base.invocation.manifestFacts, ...overrides },
      });
    const incompletePlan = {
      ...base.invocation.investigationProbePlan,
      status: ReviewInvestigationProbePlanStatus.LimitExceeded,
      probes: [],
      exceededLimit: {
        kind: 'per_file',
        maximum: REVIEW_INVESTIGATION_PRODUCTION_POLICY.maxSeedProbesPerFile,
        observedCount:
          REVIEW_INVESTIGATION_PRODUCTION_POLICY.maxSeedProbesPerFile + 1,
        sourcePath: 'src/too-many.ts',
        sourcePathHash: '0'.repeat(64),
      },
      selectionWitness: null,
    };
    const cases = [
      {
        reason: ReviewInvestigationRecordingSupportReason.Supported,
        input: candidate(),
        policy: REVIEW_INVESTIGATION_PRODUCTION_POLICY,
      },
      {
        reason: ReviewInvestigationRecordingSupportReason.ProviderUnsupported,
        input: executionInput(ReviewExecutionProviderKind.OpenRouter),
        policy: REVIEW_INVESTIGATION_PRODUCTION_POLICY,
      },
      {
        reason: ReviewInvestigationRecordingSupportReason.ProviderMismatch,
        input: manifest({
          providerKind: ReviewExecutionProviderKind.ClaudeCode,
        }),
        policy: REVIEW_INVESTIGATION_PRODUCTION_POLICY,
      },
      {
        reason: ReviewInvestigationRecordingSupportReason.WorkSlotMismatch,
        input: candidate({ workSlotId: 'other-slot' }),
        policy: REVIEW_INVESTIGATION_PRODUCTION_POLICY,
      },
      {
        reason:
          ReviewInvestigationRecordingSupportReason.ExecutionProfileMismatch,
        input: manifest({ executionProfile: 'agentic_unbounded_v1' }),
        policy: REVIEW_INVESTIGATION_PRODUCTION_POLICY,
      },
      {
        reason:
          ReviewInvestigationRecordingSupportReason.TaskKindSetUnsupported,
        input: manifest({
          taskKindSet: [ReviewTaskKind.LifecycleRevalidation],
        }),
        policy: REVIEW_INVESTIGATION_PRODUCTION_POLICY,
      },
      {
        reason:
          ReviewInvestigationRecordingSupportReason.CoverageWorkSlotMismatch,
        input: candidate({
          coverageManifest: {
            ...base.invocation.coverageManifest,
            workSlotId: 'other-slot',
          },
        }),
        policy: REVIEW_INVESTIGATION_PRODUCTION_POLICY,
      },
      {
        reason: ReviewInvestigationRecordingSupportReason.SeedEnvelopeMissing,
        input: candidate({ investigationSeedEnvelope: null }),
        policy: REVIEW_INVESTIGATION_PRODUCTION_POLICY,
      },
      {
        reason:
          ReviewInvestigationRecordingSupportReason.InvestigationContextPromptMissing,
        input: candidate({ investigationContextPrompt: null }),
        policy: REVIEW_INVESTIGATION_PRODUCTION_POLICY,
      },
      {
        reason:
          ReviewInvestigationRecordingSupportReason.InvestigationContextPromptUnbound,
        input: candidate({
          investigationContextPrompt: 'Different investigation context.',
        }),
        policy: REVIEW_INVESTIGATION_PRODUCTION_POLICY,
      },
      {
        reason: ReviewInvestigationRecordingSupportReason.SeedEnvelopeUnbound,
        input: manifest({ providerRequestEnvelopeHash: '0'.repeat(64) }),
        policy: REVIEW_INVESTIGATION_PRODUCTION_POLICY,
      },
      {
        reason: ReviewInvestigationRecordingSupportReason.ProbePlanIncomplete,
        input: candidate({ investigationProbePlan: incompletePlan }),
        policy: REVIEW_INVESTIGATION_PRODUCTION_POLICY,
      },
      {
        reason: ReviewInvestigationRecordingSupportReason.ProbeLimitsMismatch,
        input: candidate({
          investigationProbePlan: {
            ...base.invocation.investigationProbePlan,
            limits: {
              ...base.invocation.investigationProbePlan.limits,
              maxProbesOverall:
                base.invocation.investigationProbePlan.limits.maxProbesOverall +
                1,
            },
          },
        }),
        policy: REVIEW_INVESTIGATION_PRODUCTION_POLICY,
      },
      {
        reason:
          ReviewInvestigationRecordingSupportReason.ObligationLimitExceeded,
        input: candidate(),
        policy: {
          ...REVIEW_INVESTIGATION_PRODUCTION_POLICY,
          maxObligations: 1,
        },
      },
    ] as const;

    expect(new Set(cases.map(({ reason }) => reason))).toEqual(
      new Set(Object.values(ReviewInvestigationRecordingSupportReason))
    );
    for (const testCase of cases) {
      expect(
        reviewInvestigationRecordingSupportDecision(
          testCase.input as never,
          testCase.policy
        )
      ).toMatchObject({ reason: testCase.reason });
    }

    type CandidateState = {
      input: ReturnType<typeof candidate>;
      policy: Parameters<typeof reviewInvestigationRecordingSupportDecision>[1];
    };
    const updateInvocation = (
      state: CandidateState,
      overrides: Readonly<Record<string, unknown>>
    ): CandidateState => ({
      ...state,
      input: {
        ...state.input,
        invocation: { ...state.input.invocation, ...overrides },
      },
    });
    const updateManifest = (
      state: CandidateState,
      overrides: Readonly<Record<string, unknown>>
    ): CandidateState =>
      updateInvocation(state, {
        manifestFacts: {
          ...state.input.invocation.manifestFacts,
          ...overrides,
        },
      });
    const faults: readonly Readonly<{
      reason: Exclude<
        ReviewInvestigationRecordingSupportReason,
        ReviewInvestigationRecordingSupportReason.Supported
      >;
      apply: (state: CandidateState) => CandidateState;
    }>[] = [
      {
        reason: ReviewInvestigationRecordingSupportReason.ProviderUnsupported,
        apply: (state) => ({
          ...state,
          input: {
            ...state.input,
            workSlot: {
              ...state.input.workSlot,
              providerKind: ReviewExecutionProviderKind.OpenRouter,
            },
          },
        }),
      },
      {
        reason: ReviewInvestigationRecordingSupportReason.ProviderMismatch,
        apply: (state) =>
          updateManifest(state, {
            providerKind: ReviewExecutionProviderKind.ClaudeCode,
          }),
      },
      {
        reason: ReviewInvestigationRecordingSupportReason.WorkSlotMismatch,
        apply: (state) => updateInvocation(state, { workSlotId: 'other-slot' }),
      },
      {
        reason:
          ReviewInvestigationRecordingSupportReason.ExecutionProfileMismatch,
        apply: (state) =>
          updateManifest(state, { executionProfile: 'agentic_unbounded_v1' }),
      },
      {
        reason:
          ReviewInvestigationRecordingSupportReason.TaskKindSetUnsupported,
        apply: (state) =>
          updateManifest(state, {
            taskKindSet: [ReviewTaskKind.LifecycleRevalidation],
          }),
      },
      {
        reason:
          ReviewInvestigationRecordingSupportReason.CoverageWorkSlotMismatch,
        apply: (state) =>
          updateInvocation(state, {
            coverageManifest: {
              ...state.input.invocation.coverageManifest,
              workSlotId: 'other-slot',
            },
          }),
      },
      {
        reason: ReviewInvestigationRecordingSupportReason.SeedEnvelopeMissing,
        apply: (state) =>
          updateInvocation(state, { investigationSeedEnvelope: null }),
      },
      {
        reason:
          ReviewInvestigationRecordingSupportReason.InvestigationContextPromptMissing,
        apply: (state) =>
          updateInvocation(state, { investigationContextPrompt: null }),
      },
      {
        reason: ReviewInvestigationRecordingSupportReason.SeedEnvelopeUnbound,
        apply: (state) =>
          updateManifest(state, {
            providerRequestEnvelopeHash: '0'.repeat(64),
          }),
      },
      {
        reason:
          ReviewInvestigationRecordingSupportReason.InvestigationContextPromptUnbound,
        apply: (state) =>
          updateInvocation(state, {
            investigationContextPrompt: 'Different investigation context.',
          }),
      },
      {
        reason: ReviewInvestigationRecordingSupportReason.ProbePlanIncomplete,
        apply: (state) =>
          updateInvocation(state, {
            investigationProbePlan: {
              ...state.input.invocation.investigationProbePlan,
              status: ReviewInvestigationProbePlanStatus.LimitExceeded,
              probes: [],
              exceededLimit: {
                kind: 'per_file',
                maximum:
                  REVIEW_INVESTIGATION_PRODUCTION_POLICY.maxSeedProbesPerFile,
                observedCount:
                  REVIEW_INVESTIGATION_PRODUCTION_POLICY.maxSeedProbesPerFile +
                  1,
                sourcePath: 'src/too-many.ts',
                sourcePathHash: '0'.repeat(64),
              },
              selectionWitness: null,
            },
          }),
      },
      {
        reason: ReviewInvestigationRecordingSupportReason.ProbeLimitsMismatch,
        apply: (state) =>
          updateInvocation(state, {
            investigationProbePlan: {
              ...state.input.invocation.investigationProbePlan,
              limits: {
                ...state.input.invocation.investigationProbePlan.limits,
                maxProbesOverall:
                  state.input.invocation.investigationProbePlan.limits
                    .maxProbesOverall + 1,
              },
            },
          }),
      },
      {
        reason:
          ReviewInvestigationRecordingSupportReason.ObligationLimitExceeded,
        apply: (state) => ({
          ...state,
          policy: { ...state.policy, maxObligations: 1 },
        }),
      },
    ];
    for (const [index, fault] of faults.entries()) {
      let state: CandidateState = {
        input: candidate(),
        policy: REVIEW_INVESTIGATION_PRODUCTION_POLICY,
      };
      for (let later = faults.length - 1; later >= index; later -= 1) {
        state = faults[later].apply(state);
      }
      expect(
        reviewInvestigationRecordingSupportDecision(
          state.input as never,
          state.policy
        ).reason
      ).toBe(fault.reason);
    }
  });

  it('does not claim investigation support for an incomplete probe plan', () => {
    const adapter = new ReviewInvestigationRecordingAdapter(
      () => ({ execute: jest.fn() }) as never,
      options()
    );
    const input = executionInput();
    const incompleteProbePlan = {
      ...input.invocation.investigationProbePlan,
      status: ReviewInvestigationProbePlanStatus.LimitExceeded,
      probes: [],
      exceededLimit: {
        kind: 'per_file',
        maximum: REVIEW_INVESTIGATION_PRODUCTION_POLICY.maxSeedProbesPerFile,
        observedCount:
          REVIEW_INVESTIGATION_PRODUCTION_POLICY.maxSeedProbesPerFile + 1,
        sourcePath: 'src/too-many.ts',
        sourcePathHash: '0'.repeat(64),
      },
      selectionWitness: null,
    } as unknown as typeof input.invocation.investigationProbePlan;

    expect(
      adapter.supports({
        workSlot: input.workSlot,
        invocation: {
          ...input.invocation,
          investigationProbePlan: incompleteProbePlan,
        },
      })
    ).toBe(false);
    expect(
      reviewInvestigationRecordingSupportDecision(
        {
          workSlot: input.workSlot,
          invocation: {
            ...input.invocation,
            investigationProbePlan: incompleteProbePlan,
          },
        },
        REVIEW_INVESTIGATION_PRODUCTION_POLICY
      ).reason
    ).toBe(ReviewInvestigationRecordingSupportReason.ProbePlanIncomplete);
  });

  it('does not claim an invocation whose transient seed envelope is not manifest-bound', () => {
    const adapter = new ReviewInvestigationRecordingAdapter(
      () => ({ execute: jest.fn() }) as never,
      options()
    );
    const input = executionInput();

    expect(
      adapter.supports({
        workSlot: input.workSlot,
        invocation: {
          ...input.invocation,
          investigationSeedEnvelope: {
            ...input.invocation.investigationSeedEnvelope,
            hash: 'f'.repeat(64),
          },
        },
      })
    ).toBe(false);
    expect(
      reviewInvestigationRecordingSupportDecision(
        {
          workSlot: input.workSlot,
          invocation: {
            ...input.invocation,
            investigationSeedEnvelope: {
              ...input.invocation.investigationSeedEnvelope,
              hash: 'f'.repeat(64),
            },
          },
        },
        REVIEW_INVESTIGATION_PRODUCTION_POLICY
      ).reason
    ).toBe(ReviewInvestigationRecordingSupportReason.SeedEnvelopeUnbound);
  });

  it('does not claim an invocation whose investigation prompt differs from its seed', () => {
    const adapter = new ReviewInvestigationRecordingAdapter(
      () => ({ execute: jest.fn() }) as never,
      options()
    );
    const input = executionInput();
    const invocation = {
      ...input.invocation,
      investigationContextPrompt: 'Different investigation context.',
    };

    expect(adapter.supports({ workSlot: input.workSlot, invocation })).toBe(
      false
    );
    expect(
      reviewInvestigationRecordingSupportDecision(
        { workSlot: input.workSlot, invocation },
        REVIEW_INVESTIGATION_PRODUCTION_POLICY
      ).reason
    ).toBe(
      ReviewInvestigationRecordingSupportReason.InvestigationContextPromptUnbound
    );
  });

  it('binds investigation seed identity to the exact review revision', () => {
    const { invocation } = executionInput();
    const nextRevisionCoverage = {
      ...invocation.coverageManifest,
      reviewRevisionHash: hash('next-empty-commit-revision'),
    };
    const nextRevisionSeed = buildReviewInvestigationSeedEnvelope({
      canonicalInventory: canonicalInventory([
        inventoryEntry('src/z.ts'),
        inventoryEntry('src/a.ts'),
        inventoryEntry('src/auth/session.ts'),
      ]),
      coverageManifest: nextRevisionCoverage,
      probePlan: invocation.investigationProbePlan,
      requestedModel: invocation.requestedModel,
      reviewPrompt: invocation.investigationContextPrompt!,
    });

    expect(nextRevisionSeed.hash).not.toBe(
      invocation.investigationSeedEnvelope.hash
    );
    expect(nextRevisionSeed.canonicalJson).toContain(
      nextRevisionCoverage.reviewRevisionHash
    );
  });

  it('supports provider-neutral Codex and Claude Code work slots', () => {
    const adapter = new ReviewInvestigationRecordingAdapter(
      () => ({ execute: jest.fn() }) as never,
      options()
    );

    for (const providerKind of [
      ReviewExecutionProviderKind.Codex,
      ReviewExecutionProviderKind.ClaudeCode,
    ]) {
      const input = executionInput(providerKind);
      expect(
        adapter.supports({
          workSlot: input.workSlot,
          invocation: input.invocation,
        })
      ).toBe(true);
    }
    const unsupported = executionInput(ReviewExecutionProviderKind.OpenRouter);
    expect(
      adapter.supports({
        workSlot: unsupported.workSlot,
        invocation: unsupported.invocation,
      })
    ).toBe(false);
  });

  it('executes a Claude Code slot with the provider-neutral runtime kind', async () => {
    const terminalJson = '{"payloadVersion":2}';
    const execute = jest.fn(async (runInput) => {
      expect(runInput.providerKind).toBe(ReviewAgentProviderKind.ClaudeCode);
      return {
        status: ReviewInvestigationRunStatus.Completed,
        snapshot: terminalSnapshot(
          terminalJson,
          ReviewAgentProviderKind.ClaudeCode
        ),
      };
    });
    const adapter = new ReviewInvestigationRecordingAdapter(
      () => ({ execute }) as never,
      options()
    );

    await expect(
      adapter.execute(executionInput(ReviewExecutionProviderKind.ClaudeCode))
    ).resolves.toMatchObject({ actualModel: 'gpt-test' });
  });

  it.each([
    ReviewInvestigationRunStatus.Parked,
    ReviewInvestigationRunStatus.RecoveryRequired,
    ReviewInvestigationRunStatus.TransitionBudgetExhausted,
  ])(
    'preserves the authoritative legacy review when record-only investigation is %s',
    async (status) => {
      const adapter = new ReviewInvestigationRecordingAdapter(
        () =>
          ({
            execute: jest.fn(async () => ({
              status,
              snapshot: activeSnapshot(),
            })),
          }) as never,
        options()
      );

      await expect(adapter.execute(executionInput())).rejects.toMatchObject({
        name: 'ReviewInvestigationLegacyFallbackSignal',
        reason: ReviewInvestigationLegacyFallbackReason.RecordOnlyDeferred,
        deferredStatus: status,
      });
    }
  );

  it('surfaces authoritative parked work as a typed deferral', async () => {
    const adapter = new ReviewInvestigationRecordingAdapter(
      () =>
        ({
          execute: jest.fn(async () => ({
            status: ReviewInvestigationRunStatus.Parked,
            snapshot: activeSnapshot(),
          })),
        }) as never,
      options(),
      ReviewInvestigationRecordingMode.Authoritative
    );

    await expect(adapter.execute(executionInput())).rejects.toMatchObject({
      name: 'ReviewInvestigationDeferredSignal',
      status: ReviewInvestigationRunStatus.Parked,
    } satisfies Partial<ReviewInvestigationDeferredSignal>);
  });

  it('maps fatal investigation gateway drift back to orchestration configuration failure', async () => {
    const adapter = new ReviewInvestigationRecordingAdapter(
      () =>
        ({
          execute: jest
            .fn()
            .mockRejectedValue(
              new ReviewInvestigationGatewayConfigurationError(
                ReviewInvestigationGatewayConfigurationFailureReason.ContextGatewayPolicyMismatch
              )
            ),
        }) as never,
      options()
    );

    await expect(adapter.execute(executionInput())).rejects.toMatchObject({
      name: ReviewInvocationConfigurationMismatchError.name,
      reason:
        ReviewInvocationConfigurationMismatchReason.ContextGatewayPolicyMismatch,
    });
  });

  it('exports exact deterministic production capability hashes', () => {
    expect(REVIEW_INVESTIGATION_COVERAGE_PROFILE).toEqual(
      capabilityGolden.coverageProfile.value
    );
    expect(canonicalJson(REVIEW_INVESTIGATION_COVERAGE_PROFILE)).toBe(
      capabilityGolden.coverageProfile.canonicalJson
    );
    expect(reviewInvestigationCoverageProfileHash()).toBe(
      capabilityGolden.coverageProfile.sha256
    );
    expect(REVIEW_INVESTIGATION_PRODUCTION_POLICY).toEqual(
      capabilityGolden.policy.value
    );
    expect(canonicalJson(REVIEW_INVESTIGATION_PRODUCTION_POLICY)).toBe(
      capabilityGolden.policy.canonicalJson
    );
    expect(reviewInvestigationPolicyHash()).toBe(
      capabilityGolden.policy.sha256
    );
  });

  it('maps balanced and thorough to bounded increasing action budgets', () => {
    const economy = reviewInvestigationActionBudgetForDepth(
      ReviewDepth.Economy
    );
    const balanced = reviewInvestigationActionBudgetForDepth(
      ReviewDepth.Balanced
    );
    const thorough = reviewInvestigationActionBudgetForDepth(
      ReviewDepth.Thorough
    );

    expect(Object.values(economy)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(thorough.maxGatewayOperations).toBeGreaterThan(
      balanced.maxGatewayOperations
    );
    expect(thorough.maxOutputFindings).toBeGreaterThan(
      balanced.maxOutputFindings
    );
    expect(thorough.maxOutputProposals).toBeGreaterThan(
      balanced.maxOutputProposals
    );
    expect(thorough.providerMaxTurns).toBeGreaterThan(
      balanced.providerMaxTurns
    );
    expect(thorough.maxStateTransitions).toBeGreaterThan(
      balanced.maxStateTransitions
    );
    expect(thorough.maxObligationsForTurn).toBe(balanced.maxObligationsForTurn);
    expect(thorough).toEqual({
      maxGatewayOperations:
        REVIEW_INVESTIGATION_PRODUCTION_POLICY.maxReceiptsPerTurn,
      maxOutputFindings: REVIEW_INVESTIGATION_PRODUCTION_POLICY.maxFindings,
      maxOutputProposals:
        REVIEW_INVESTIGATION_PRODUCTION_POLICY.maxProposalsPerTurn,
      maxObligationsForTurn: REVIEW_INVESTIGATION_TURN_MAX_OBLIGATIONS,
      providerMaxTurns: REVIEW_INVESTIGATION_PRODUCTION_POLICY.maxSemanticTurns,
      maxStateTransitions:
        REVIEW_INVESTIGATION_PRODUCTION_POLICY.maxOperationalAttempts,
    });
  });

  it('defaults legacy callers without review depth to balanced', () => {
    expect(reviewInvestigationActionBudgetForDepth(undefined)).toEqual(
      reviewInvestigationActionBudgetForDepth(ReviewDepth.Balanced)
    );
  });

  it('preserves the legacy flat recording budget contract', async () => {
    const terminalJson = canonicalJson({ findings: [] });
    const execute = jest.fn(async () => ({
      status: ReviewInvestigationRunStatus.Completed,
      snapshot: terminalSnapshot(terminalJson),
    }));
    const adapter = new ReviewInvestigationRecordingAdapter(
      () => ({ execute }) as never,
      {
        workingDirectory: '/tmp/review-investigation-fixture',
        leaseDurationMs: 300_000,
        providerTimeoutMs: 600_000,
        certificateTtlMs: 86_400_000,
        minimumCapacityParkMs: 60_000,
        maxObligationsForTurn: 64,
        maxStateTransitions: 32,
        policy: REVIEW_INVESTIGATION_PRODUCTION_POLICY,
      }
    );

    await adapter.execute(executionInput());

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        turnBudget: {
          maxGatewayOperations:
            REVIEW_INVESTIGATION_PRODUCTION_POLICY.maxReceiptsPerTurn,
          maxOutputFindings: REVIEW_INVESTIGATION_PRODUCTION_POLICY.maxFindings,
          maxOutputProposals:
            REVIEW_INVESTIGATION_PRODUCTION_POLICY.maxProposalsPerTurn,
        },
        maxObligationsForTurn: 64,
        providerMaxTurns:
          REVIEW_INVESTIGATION_PRODUCTION_POLICY.maxSemanticTurns,
        maxStateTransitions: 32,
      })
    );
  });

  it('keeps producer release identity only in the per-run open contract', () => {
    const releaseOne = reviewInvestigationCoverageContract('release-1');
    const releaseTwo = reviewInvestigationCoverageContract('release-2');
    expect(releaseOne).toEqual({
      ...capabilityGolden.coverageProfile.value,
      producerReleaseId: 'release-1',
    });
    expect(hash(canonicalJson(releaseOne))).not.toBe(
      hash(canonicalJson(releaseTwo))
    );
    expect(reviewInvestigationCoverageProfileHash()).toBe(
      capabilityGolden.coverageProfile.sha256
    );
  });
});

function executionInput(
  providerKind: ReviewExecutionProviderKind = ReviewExecutionProviderKind.Codex
) {
  const reviewRevisionHash = 'b'.repeat(64);
  const workSlot = {
    workSlotId: 'slot-1',
    taskKind: ReviewTaskKind.FindingDiscovery,
    providerKind,
    providerVoteIdentityHash: 'v'.repeat(64),
    shardKey: 'unit-1',
    required: true,
    attemptBudget: 2,
    retryPolicyVersion: 'retry-v1',
  } as const;
  const investigationProbePlan = createReviewInvestigationProbePlan({
    files: [
      probeFile('src/z.ts'),
      probeFile('src/a.ts'),
      probeFile('src/auth/session.ts'),
    ],
    fullDiff: [
      'diff --git a/src/auth/session.ts b/src/auth/session.ts',
      '--- a/src/auth/session.ts',
      '+++ b/src/auth/session.ts',
      '@@ -1 +1,2 @@',
      '+export function refreshSession() {}',
      '+emit("session.revoked");',
    ].join('\n'),
  });
  const coverageManifest = {
    version: 'review_prompt_coverage.v2',
    workSlotId: workSlot.workSlotId,
    reviewRevisionHash,
    paths: [
      {
        path: 'src/z.ts',
        kind: ReviewPromptPathCoverageKind.FullPatch,
        contentHash: null,
      },
      {
        path: 'src/a.ts',
        kind: ReviewPromptPathCoverageKind.FullPatch,
        contentHash: null,
      },
      {
        path: 'src/auth/session.ts',
        kind: ReviewPromptPathCoverageKind.FullPatch,
        contentHash: null,
      },
    ],
    coverageHash: 'd'.repeat(64),
  } as const;
  const investigationContextPrompt = 'Investigate the assigned change.';
  const investigationSeedEnvelope = buildReviewInvestigationSeedEnvelope({
    canonicalInventory: canonicalInventory([
      inventoryEntry('src/z.ts'),
      inventoryEntry('src/a.ts'),
      inventoryEntry('src/auth/session.ts'),
    ]),
    coverageManifest,
    probePlan: investigationProbePlan,
    requestedModel: 'gpt-test',
    reviewPrompt: investigationContextPrompt,
  });
  const invocation = {
    workSlotId: workSlot.workSlotId,
    attemptOrdinal: 1,
    provider: 'codex/gpt-test',
    requestedModel: 'gpt-test',
    reviewPrompt:
      'Review the assigned change.\nReturn ONLY one valid JSON object.',
    investigationContextPrompt,
    immutableRequest: {},
    investigationProbePlan,
    investigationSeedEnvelope,
    coverageManifest,
    manifestFacts: {
      taskKindSet: [ReviewTaskKind.FindingDiscovery],
      providerKind,
      providerCapabilityHash: '1'.repeat(64),
      providerRequestEnvelopeHash: investigationSeedEnvelope.hash,
      outputSchemaHash: '3'.repeat(64),
      filePatchManifestHash: '4'.repeat(64),
      contextManifestHash: '5'.repeat(64),
      lifecycleTargetSetHash: null,
      liveLifecycleStateHash: null,
      toolPolicyHash: '6'.repeat(64),
      executionProfile: 'investigation_gateway_v1',
      baseTreeHash: '7'.repeat(64),
      environmentContractHash: '8'.repeat(64),
    },
  } as const;
  return {
    authorization: {
      authorizationId: 'authorization-1',
      authorizationToken: 'authorization-token',
      facts: {
        producerReleaseId: 'release-1',
        reviewRevisionHash,
      },
    } as never,
    execution: { executionId: 'execution-1' } as never,
    workSlot,
    invocation,
    manifest: {
      manifestCanonicalJson: '{}',
      manifestKey: '9'.repeat(64),
      providerInvocationKey: 'a'.repeat(64),
      providerVoteIdentityHash: workSlot.providerVoteIdentityHash,
    },
    ownerIdHash: 'e'.repeat(64),
    sourceReviewRevisionHash: reviewRevisionHash,
    signal: new AbortController().signal,
  } as const;
}

function probeFile(
  path: string,
  status: ReviewInvestigationChangedFileStatus = ReviewInvestigationChangedFileStatus.Modified
) {
  return Object.freeze({
    path,
    previousPath: null,
    status,
    patch: null,
  });
}

function canonicalInventory(
  entries: readonly ReviewInvestigationCanonicalInventoryEntry[]
): ReviewInvestigationCanonicalInventory {
  const identity = {
    inventoryVersion: 2 as const,
    mergeBaseTreeOid: hash('merge-base-tree').slice(0, 40),
    headTreeOid: hash('head-tree').slice(0, 40),
    entries: Object.freeze([...entries]),
  };
  return Object.freeze({
    ...identity,
    itemCount: entries.length,
    inventoryHash: hash(canonicalJson(identity)),
  });
}

function inventoryEntry(
  path: string,
  status: ReviewInvestigationChangedFileStatus = ReviewInvestigationChangedFileStatus.Modified
): ReviewInvestigationCanonicalInventoryEntry {
  const removed = status === ReviewInvestigationChangedFileStatus.Removed;
  return Object.freeze({
    status: removed ? 'deleted' : 'modified',
    beforePath: path,
    afterPath: removed ? null : path,
    beforeMode: '100644',
    afterMode: removed ? '000000' : '100644',
    beforeOid: hash(`${path}:before`).slice(0, 40),
    afterOid: removed ? '0'.repeat(40) : hash(`${path}:after`).slice(0, 40),
    beforeContentKind: 'text',
    beforeByteCount: 20,
    beforeLineCount: 1,
    afterContentKind: removed ? 'absent' : 'text',
    afterByteCount: removed ? null : 20,
    afterLineCount: removed ? null : 1,
    contentKind: 'text',
    byteCount: 20,
    lineCount: 1,
    generated: false,
    generatedPolicySource: null,
  });
}

function options() {
  return {
    workingDirectory: '/tmp/review-investigation-fixture',
    leaseDurationMs: 300_000,
    providerTimeoutMs: 600_000,
    certificateTtlMs: 86_400_000,
    minimumCapacityParkMs: 60_000,
    actionBudget: reviewInvestigationActionBudgetForDepth(ReviewDepth.Balanced),
    policy: REVIEW_INVESTIGATION_PRODUCTION_POLICY,
  } as const;
}

function fileSubject(
  path: string,
  revision: 'head' | 'merge_base' = 'head'
): string {
  return canonicalJson({
    kind: 'file_read',
    pathHash: hash(path),
    revision,
    subjectVersion: 1,
  });
}

function activeSnapshot() {
  return {
    investigationId: 'investigation-1',
    version: 2,
    state: ReviewInvestigationState.TurnLeased,
    dossierDigest: 'f'.repeat(64),
    openObligationCount: 2,
    satisfiedObligationCount: 1,
    unresolvableObligationCount: 0,
    findingCount: 0,
    semanticTurns: 0,
    operationalAttempts: 0,
    criticCycles: 0,
    nextEligibleAt: null,
    nextAction: ReviewInvestigationNextAction.RunTurn,
    turn: {
      turnId: 'turn-1',
      purpose: ReviewTurnPurpose.Discovery,
      leasedAtVersion: 2,
      dossierDigest: 'f'.repeat(64),
      obligationIds: ['1'.repeat(64)],
      semanticTurnOrdinal: 1,
      criticCycleOrdinal: 0,
      leasedAt: '2026-08-02T10:00:00.000Z',
      expiresAt: '2026-08-02T10:05:00.000Z',
      turnCapability: 'turn-capability',
      brief: {
        briefVersion: 1,
        investigationId: 'investigation-1',
        investigationVersion: 2,
        dossierDigest: 'f'.repeat(64),
        turnId: 'turn-1',
        purpose: ReviewTurnPurpose.Discovery,
        maximumSemanticRiskPriority: 500_000,
        obligations: [],
      },
    },
    certificateId: null,
    certificateHash: null,
    terminalProviderKind: null,
    terminalActualModel: null,
    terminalObservationCanonicalJson: null,
    terminalOutcomeHash: null,
    conclusion: null,
  } as const;
}

function terminalSnapshot(
  terminalJson: string,
  providerKind: ReviewAgentProviderKind = ReviewAgentProviderKind.Codex
) {
  return {
    ...activeSnapshot(),
    version: 7,
    state: ReviewInvestigationState.Concluded,
    nextAction: ReviewInvestigationNextAction.Terminal,
    turn: null,
    findingCount: 0,
    operationalAttempts: 2,
    certificateId: 'certificate-1',
    certificateHash: 'c'.repeat(64),
    terminalProviderKind: providerKind,
    terminalActualModel: 'gpt-test',
    terminalObservationCanonicalJson: terminalJson,
    terminalOutcomeHash: hash(terminalJson),
    conclusion: ReviewInvestigationConclusion.VerifiedClean,
  } as const;
}
