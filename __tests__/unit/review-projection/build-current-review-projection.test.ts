import {
  BuildCurrentReviewProjection,
  BuildCurrentReviewProjectionCommand,
} from '../../../src/review-projection/application/build-current-review-projection';
import {
  CurrentFindingPolicyPort,
  CurrentLifecycleInventoryPort,
  EvaluateMergeGateQuery,
  MergeGateDecision,
  ProjectedReviewPresentation,
  ProjectLifecycleQuery,
  ProjectReviewPresentationQuery,
  ReviewLifecyclePolicyPort,
  ReviewMergeGatePolicyPort,
  ReviewPresentationPolicyPort,
  SelectCurrentFindingsQuery,
} from '../../../src/review-projection/application/review-projection-ports';
import {
  CheckConclusion,
  CurrentFindingCandidate,
  CurrentLifecycleInventory,
  FindingOccurrenceState,
  FindingPlacementKind,
  FindingSeverity,
  LifecycleProjectionDecision,
  LifecycleResolutionMarkerTrust,
  LifecycleRevalidationVerdict,
  LifecycleTargetDisposition,
  MergeGateConclusion,
  ProjectionCoverageState,
  RevisionFileStatus,
  SelectedCurrentFinding,
} from '../../../src/review-projection/domain/review-projection';
import {
  REVIEW_PROJECTION_ABSOLUTE_LIMITS,
  ReviewProjectionLimitError,
  ReviewProjectionLimits,
} from '../../../src/review-projection/domain/review-projection-limits';

const HEAD = '1'.repeat(40);
const BASE = '0'.repeat(40);

class MutableInventoryPort implements CurrentLifecycleInventoryPort {
  calls = 0;

  constructor(public inventory: CurrentLifecycleInventory) {}

  async loadCurrent(): Promise<CurrentLifecycleInventory> {
    this.calls += 1;
    return this.inventory;
  }
}

class PassThroughFindingPolicy implements CurrentFindingPolicyPort {
  async selectCurrent(
    query: SelectCurrentFindingsQuery
  ): Promise<readonly SelectedCurrentFinding[]> {
    return query.findings.map((finding) => ({
      ...finding,
      sourceFindingIds: [finding.sourceFindingId],
    }));
  }
}

class RevalidationLifecyclePolicy implements ReviewLifecyclePolicyPort {
  async projectLifecycle(
    query: ProjectLifecycleQuery
  ): Promise<readonly LifecycleProjectionDecision[]> {
    return query.inventory.targets.map((target) => {
      const revalidation = query.revalidations.find(
        (candidate) => candidate.targetId === target.targetId
      );
      return {
        targetId: target.targetId,
        verdict:
          revalidation?.verdict ?? LifecycleRevalidationVerdict.Uncertain,
        reasonCodes: revalidation ? ['provider_revalidated'] : ['missing_vote'],
      };
    });
  }
}

class DeterministicPresentationPolicy implements ReviewPresentationPolicyPort {
  constructor(private readonly summary = 'All Clear') {}

  async projectPresentation(
    query: ProjectReviewPresentationQuery
  ): Promise<ProjectedReviewPresentation> {
    const partial = query.coverage.state === ProjectionCoverageState.Partial;
    const preliminaryFindingCount = query.occurrences.length;
    const preliminaryFindingLabel =
      preliminaryFindingCount === 1 ? 'finding' : 'findings';
    return {
      summaryBody: partial
        ? `## Review incomplete - ${preliminaryFindingCount} preliminary ${preliminaryFindingLabel} preserved ⚠️\n\n${this.summary}`
        : this.summary,
      checkName: 'ReviewRouter',
      checkTitle: partial
        ? 'Review incomplete - partial coverage'
        : 'Review complete',
      checkSummary: partial
        ? `## Review incomplete\n\n${this.summary}`
        : this.summary,
      checkConclusion: CheckConclusion.Success,
      placements: query.occurrences.map((occurrence) => ({
        lineageId: occurrence.lineageId,
        kind:
          occurrence.line !== undefined
            ? FindingPlacementKind.Inline
            : FindingPlacementKind.Summary,
        path: occurrence.filePath,
        ...(occurrence.line !== undefined ? { line: occurrence.line } : {}),
        ...(occurrence.line !== undefined
          ? { body: `${occurrence.title}\n${occurrence.message}` }
          : { reason: 'no line' }),
      })),
    };
  }
}

class DeterministicGatePolicy implements ReviewMergeGatePolicyPort {
  evaluateMergeGate(query: EvaluateMergeGateQuery): MergeGateDecision {
    const blocking = query.occurrences
      .filter(
        (occurrence) =>
          query.failOnSeverity !== undefined &&
          isCurrent(occurrence.state) &&
          severityRank(occurrence.severity) >=
            severityRank(query.failOnSeverity)
      )
      .map((occurrence) => occurrence.lineageId);
    if (blocking.length > 0) {
      return {
        conclusion: MergeGateConclusion.Fail,
        blockingLineageIds: blocking,
        reasonCodes: ['blocking_current_findings'],
      };
    }
    if (
      query.coverage.state === ProjectionCoverageState.Partial ||
      !query.lifecycleInventoryComplete
    ) {
      return {
        conclusion: MergeGateConclusion.Inconclusive,
        blockingLineageIds: [],
        reasonCodes: ['partial_coverage'],
      };
    }
    return {
      conclusion: MergeGateConclusion.Pass,
      blockingLineageIds: [],
      reasonCodes: [],
    };
  }
}

describe('BuildCurrentReviewProjection', () => {
  it('reloads current lifecycle inventory on every projection build', async () => {
    const inventoryPort = new MutableInventoryPort(inventory());
    const useCase = createUseCase(inventoryPort);

    const first = await useCase.execute(command());
    inventoryPort.inventory = inventory({ lifecycleStateHash: 'state-2' });
    const second = await useCase.execute(command());

    expect(inventoryPort.calls).toBe(2);
    expect(first.projectionHash).not.toBe(second.projectionHash);
    expect(second.envelope.lifecycleStateHash).toBe('state-2');
  });

  it('canonicalizes authoritative observation lineage deterministically', async () => {
    const useCase = createUseCase(new MutableInventoryPort(inventory()));

    const first = await useCase.execute(
      command({
        authoritativeObservationIds: ['observation-z', 'observation-a'],
      })
    );
    const reordered = await useCase.execute(
      command({
        authoritativeObservationIds: ['observation-a', 'observation-z'],
      })
    );
    const different = await useCase.execute(
      command({ authoritativeObservationIds: ['observation-a'] })
    );

    expect(first.envelope.authoritativeObservationIds).toEqual([
      'observation-a',
      'observation-z',
    ]);
    expect(Object.isFrozen(first.envelope.authoritativeObservationIds)).toBe(
      true
    );
    expect(JSON.parse(first.canonicalJson).authoritativeObservationIds).toEqual(
      ['observation-a', 'observation-z']
    );
    expect(first.projectionHash).toBe(reordered.projectionHash);
    expect(first.projectionHash).not.toBe(different.projectionHash);
  });

  it('rejects blank or duplicate authoritative observation identifiers', async () => {
    const useCase = createUseCase(new MutableInventoryPort(inventory()));

    await expect(
      useCase.execute(command({ authoritativeObservationIds: ['  '] }))
    ).rejects.toThrow('authoritative observationId must not be empty');
    await expect(
      useCase.execute(
        command({
          authoritativeObservationIds: ['observation-1', 'observation-1'],
        })
      )
    ).rejects.toThrow('authoritative observationId values must be unique');
  });

  it('bounds authoritative observation identifiers by the domain string limit', async () => {
    const useCase = createUseCase(
      new MutableInventoryPort(inventory()),
      testLimits({ maxStringBytes: 8 })
    );

    await expect(
      useCase.execute(
        command({ authoritativeObservationIds: ['observation-1'] })
      )
    ).rejects.toMatchObject({
      name: 'ReviewProjectionLimitError',
      limitName: 'maxStringBytes',
    } satisfies Partial<ReviewProjectionLimitError>);
  });

  it('rejects inventory loaded for another head', async () => {
    const useCase = createUseCase(
      new MutableInventoryPort(inventory({ loadedForHeadSha: '2'.repeat(40) }))
    );

    await expect(useCase.execute(command())).rejects.toThrow(
      'lifecycle inventory was not loaded for the reviewed head'
    );
  });

  it('classifies new, reconfirmed, changed, carried and resolved occurrences', async () => {
    const newFinding = finding({
      sourceFindingId: 'new',
      normalizedFailureModeHash: 'new-mode',
      title: 'New defect',
      line: 2,
    });
    const reconfirmedFinding = finding({
      sourceFindingId: 'same',
      trustedMarker: 'same-marker',
      normalizedFailureModeHash: 'same-mode',
      title: 'Same defect',
      line: 3,
    });
    const changedFinding = finding({
      sourceFindingId: 'changed',
      trustedMarker: 'changed-marker',
      normalizedFailureModeHash: 'changed-mode',
      severity: FindingSeverity.Critical,
      title: 'Changed defect',
      line: 4,
    });
    const inv = inventory({
      targets: [
        target({ targetId: 'carried-target', trustedMarker: 'carried-marker' }),
        target({
          targetId: 'resolved-target',
          trustedMarker: 'resolved-marker',
        }),
      ],
    });
    const result = await createUseCase(new MutableInventoryPort(inv)).execute(
      command({
        currentFindings: [newFinding, reconfirmedFinding, changedFinding],
        priorLineageHints: [
          hint({
            lineageId: 'same-lineage',
            trustedMarker: 'same-marker',
            normalizedFailureModeHash: 'same-mode',
            title: 'Same defect',
          }),
          hint({
            lineageId: 'changed-lineage',
            trustedMarker: 'changed-marker',
            normalizedFailureModeHash: 'changed-mode',
            title: 'Changed defect',
          }),
          hint({
            lineageId: 'carried-lineage',
            trustedMarker: 'carried-marker',
            normalizedFailureModeHash: 'carried-mode',
            title: 'Carried defect',
          }),
          hint({
            lineageId: 'resolved-lineage',
            trustedMarker: 'resolved-marker',
            normalizedFailureModeHash: 'resolved-mode',
            title: 'Resolved defect',
          }),
        ],
        lifecycleRevalidations: [
          {
            targetId: 'carried-target',
            providerVoteKey: 'provider-a',
            verdict: LifecycleRevalidationVerdict.StillValid,
          },
          {
            targetId: 'resolved-target',
            providerVoteKey: 'provider-a',
            verdict: LifecycleRevalidationVerdict.Resolved,
          },
        ],
      })
    );

    expect(
      Object.fromEntries(
        result.envelope.occurrences.map((occurrence) => [
          occurrence.title,
          occurrence.state,
        ])
      )
    ).toEqual({
      'New defect': FindingOccurrenceState.New,
      'Changed defect': FindingOccurrenceState.Changed,
      'Same defect': FindingOccurrenceState.Reconfirmed,
      'Carried defect': FindingOccurrenceState.CarriedUnverified,
      'Resolved defect': FindingOccurrenceState.Resolved,
    });
    expect(
      result.envelope.occurrences.find(
        (occurrence) => occurrence.title === 'Changed defect'
      )?.previousSeverity
    ).toBe(FindingSeverity.Major);
    expect(
      result.envelope.occurrences.find(
        (occurrence) => occurrence.title === 'Carried defect'
      )?.blocking
    ).toBe(false);
  });

  it('never emits All Clear or lifecycle mutations for partial coverage', async () => {
    const inv = inventory({
      complete: false,
      warnings: ['pagination incomplete'],
      targets: [target()],
    });
    const result = await createUseCase(new MutableInventoryPort(inv)).execute(
      command({
        currentFindings: [finding()],
        priorLineageHints: [hint()],
        lifecycleRevalidations: [
          {
            targetId: 'target-1',
            providerVoteKey: 'provider-a',
            verdict: LifecycleRevalidationVerdict.Resolved,
          },
        ],
      })
    );

    expect(result.envelope.coverage.state).toBe(
      ProjectionCoverageState.Partial
    );
    expect(result.envelope.publishing.summary.allClear).toBe(false);
    expect(result.envelope.publishing.summary.body).not.toMatch(/all clear/i);
    expect(result.envelope.publishing.summary.body).toContain(
      'Review incomplete - 1 preliminary finding preserved'
    );
    expect(result.envelope.publishing.summary.body).not.toMatch(
      /^##\s+Review complete(?:d)?\b/im
    );
    expect(result.envelope.publishing.check.title).not.toMatch(/all clear/i);
    expect(result.envelope.publishing.check.title).toBe(
      'Review incomplete - partial coverage'
    );
    expect(result.envelope.publishing.check.summary).not.toMatch(/all clear/i);
    expect(result.envelope.publishing.check.conclusion).toBe(
      CheckConclusion.Neutral
    );
    expect(result.envelope.publishing.inlineReviewChunks).toEqual([]);
    expect(result.envelope.publishing.lifecycle).toEqual([
      expect.objectContaining({
        targetId: 'target-1',
        threadId: 'thread-1',
        mutationEligible: false,
        reasonCodes: expect.arrayContaining(['partial_coverage']),
      }),
    ]);
    expect(result.envelope.snapshot).toEqual({
      occurrenceProvenance: [],
      lineageHints: [],
    });
  });

  it('rejects a partial presentation that claims the review completed', async () => {
    const invalidPresentation: ReviewPresentationPolicyPort = {
      projectPresentation: jest.fn(async () => ({
        summaryBody: '## Review complete with findings ⚠️',
        checkName: 'ReviewRouter',
        checkTitle: 'Review completed with partial coverage',
        checkSummary: '## Review complete with findings ⚠️',
        placements: [],
      })),
    };
    const useCase = createUseCase(
      new MutableInventoryPort(inventory({ complete: false })),
      testLimits(),
      invalidPresentation
    );

    await expect(useCase.execute(command())).rejects.toThrow(
      'partial review presentation must not claim completion'
    );
  });

  it('changes projection when a current human reply or skip changes inventory', async () => {
    const currentFinding = finding({ trustedMarker: 'fp-1' });
    const inventoryPort = new MutableInventoryPort(
      inventory({ targets: [target({ trustedMarker: 'fp-1' })] })
    );
    const useCase = createUseCase(inventoryPort);
    const active = await useCase.execute(
      command({ currentFindings: [currentFinding] })
    );
    inventoryPort.inventory = inventory({
      lifecycleStateHash: 'human-reply-state',
      targets: [
        target({
          trustedMarker: 'fp-1',
          disposition: LifecycleTargetDisposition.HumanReply,
        }),
      ],
    });
    const replied = await useCase.execute(
      command({ currentFindings: [currentFinding] })
    );
    inventoryPort.inventory = inventory({
      lifecycleStateHash: 'skip-state',
      commandLedgerWatermark: 'ledger-2',
      targets: [
        target({
          trustedMarker: 'fp-1',
          disposition: LifecycleTargetDisposition.CommandSuppressed,
        }),
      ],
    });
    const skipped = await useCase.execute(
      command({ currentFindings: [currentFinding] })
    );

    expect(
      new Set([
        active.projectionHash,
        replied.projectionHash,
        skipped.projectionHash,
      ]).size
    ).toBe(3);
    expect(skipped.envelope.occurrences[0].state).toBe(
      FindingOccurrenceState.SuppressedByHuman
    );
    expect(skipped.envelope.occurrences[0].blocking).toBe(false);
  });

  it('treats a matching trusted resolution reply as resolved for #252-style inventory', async () => {
    const prior = hint({
      lineageId: 'lineage-252',
      trustedMarker: 'finding-fingerprint',
      title: 'Old finding',
    });
    const inv = inventory({
      targets: [
        target({
          targetId: 'target-252',
          trustedMarker: 'finding-fingerprint',
          resolutionMarker: {
            schemaVersion: 'reviewrouter-lifecycle-resolution.v1',
            targetId: 'target-252',
            fingerprint: 'finding-fingerprint',
            trust: LifecycleResolutionMarkerTrust.Trusted,
          },
        }),
      ],
    });
    const result = await createUseCase(new MutableInventoryPort(inv)).execute(
      command({ priorLineageHints: [prior] })
    );

    expect(result.envelope.occurrences[0].state).toBe(
      FindingOccurrenceState.Resolved
    );
    expect(result.envelope.publishing.lifecycle[0]).toMatchObject({
      verdict: LifecycleRevalidationVerdict.Resolved,
      mutationEligible: false,
      reasonCodes: expect.arrayContaining(['trusted_resolution_marker']),
    });
  });

  it.each([
    {
      label: 'untrusted author',
      trust: LifecycleResolutionMarkerTrust.Untrusted,
      fingerprint: 'finding-fingerprint',
    },
    {
      label: 'mismatched fingerprint',
      trust: LifecycleResolutionMarkerTrust.Trusted,
      fingerprint: 'another-fingerprint',
    },
  ])(
    'does not trust a resolution marker from $label',
    async ({ trust, fingerprint }) => {
      const inv = inventory({
        targets: [
          target({
            targetId: 'target-252',
            trustedMarker: 'finding-fingerprint',
            resolutionMarker: {
              schemaVersion: 'reviewrouter-lifecycle-resolution.v1',
              targetId: 'target-252',
              fingerprint,
              trust,
            },
          }),
        ],
      });
      const result = await createUseCase(new MutableInventoryPort(inv)).execute(
        command({
          priorLineageHints: [hint({ trustedMarker: 'finding-fingerprint' })],
        })
      );

      expect(result.envelope.occurrences[0].state).toBe(
        FindingOccurrenceState.Uncertain
      );
    }
  );

  it('chunks inline facts deterministically independent of finding input order', async () => {
    const limits = testLimits({
      maxInlineCommentsPerChunk: 2,
      maxInlineChunks: 2,
    });
    const inventoryPort = new MutableInventoryPort(inventory());
    const useCase = createUseCase(inventoryPort, limits);
    const findings = [
      finding({
        sourceFindingId: 'c',
        normalizedFailureModeHash: 'mode-c',
        filePath: 'src/c.ts',
        line: 3,
      }),
      finding({
        sourceFindingId: 'a',
        normalizedFailureModeHash: 'mode-a',
        filePath: 'src/a.ts',
        line: 1,
      }),
      finding({
        sourceFindingId: 'b',
        normalizedFailureModeHash: 'mode-b',
        filePath: 'src/b.ts',
        line: 2,
      }),
    ];
    const files = findings.map((candidate) => ({
      path: candidate.filePath,
      status: RevisionFileStatus.Modified,
      patch: `@@ -1 +1 @@\n+changed`,
    }));

    const first = await useCase.execute(
      command({ currentFindings: findings, revisionFiles: files })
    );
    const second = await useCase.execute(
      command({
        currentFindings: [...findings].reverse(),
        revisionFiles: files,
      })
    );

    expect(first.projectionHash).toBe(second.projectionHash);
    expect(first.envelope.publishing.inlineReviewChunks).toHaveLength(2);
    expect(
      first.envelope.publishing.inlineReviewChunks.map((chunk) =>
        chunk.comments.map((comment) => comment.path)
      )
    ).toEqual([['src/a.ts', 'src/b.ts'], ['src/c.ts']]);
  });

  it('fails closed when rendered or aggregate output exceeds release limits', async () => {
    const useCase = createUseCase(
      new MutableInventoryPort(inventory()),
      testLimits({ maxSummaryBytes: 8 })
    );

    await expect(useCase.execute(command())).rejects.toMatchObject({
      name: 'ReviewProjectionLimitError',
      limitName: 'maxSummaryBytes',
    } satisfies Partial<ReviewProjectionLimitError>);
  });

  it('returns deeply immutable canonical output', async () => {
    const result = await createUseCase(
      new MutableInventoryPort(inventory())
    ).execute(command({ currentFindings: [finding()] }));

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.envelope)).toBe(true);
    expect(Object.isFrozen(result.envelope.occurrences)).toBe(true);
    expect(result.byteCount).toBe(
      Buffer.byteLength(result.canonicalJson, 'utf8')
    );
  });
});

function createUseCase(
  lifecycleInventory: CurrentLifecycleInventoryPort,
  limits: ReviewProjectionLimits = testLimits(),
  presentationPolicy: ReviewPresentationPolicyPort = new DeterministicPresentationPolicy()
): BuildCurrentReviewProjection {
  return new BuildCurrentReviewProjection({
    lifecycleInventory,
    findingPolicy: new PassThroughFindingPolicy(),
    lifecyclePolicy: new RevalidationLifecyclePolicy(),
    presentationPolicy,
    mergeGatePolicy: new DeterministicGatePolicy(),
    limits,
  });
}

function command(
  overrides: Partial<BuildCurrentReviewProjectionCommand> = {}
): BuildCurrentReviewProjectionCommand {
  return {
    projectionPolicyVersion: 'projection-policy.v1',
    authoritativeObservationIds: ['observation-1'],
    scope: {
      scmRepositoryIdentityId: 'repo-1',
      pullRequestNumber: 252,
      baseSha: BASE,
      reviewedHeadSha: HEAD,
      reviewRevisionHash: 'revision-1',
    },
    presentation: {
      title: 'Large review',
      author: 'author',
      additions: 100,
      deletions: 10,
    },
    providerExecution: {
      plannedProviders: 1,
      succeededProviders: 1,
    },
    currentFindings: [],
    priorLineageHints: [],
    lifecycleRevalidations: [],
    coverage: {
      state: ProjectionCoverageState.Complete,
      mode: 'full',
      totalFiles: 1,
      reviewedFiles: 1,
      unreviewedFiles: 0,
      limitations: [],
    },
    revisionFiles: [
      {
        path: 'src/service.ts',
        status: RevisionFileStatus.Modified,
        patch: '@@ -1 +1,2 @@\n const safe = true;\n+dangerous();',
      },
    ],
    diff: 'diff --git a/src/service.ts b/src/service.ts\n@@ -1 +1,2 @@\n const safe = true;\n+dangerous();',
    failOnSeverity: FindingSeverity.Major,
    ...overrides,
  };
}

function finding(
  overrides: Partial<CurrentFindingCandidate> = {}
): CurrentFindingCandidate {
  return {
    sourceFindingId: 'finding-1',
    category: 'correctness',
    normalizedFailureModeHash: 'failure-mode-1',
    severity: FindingSeverity.Major,
    title: 'Concrete runtime failure',
    message: 'The changed call throws for valid input.',
    filePath: 'src/service.ts',
    line: 2,
    providerIds: ['codex'],
    providerVoteKeys: ['codex/account-1'],
    observationIds: ['observation-1'],
    ...overrides,
  };
}

function hint(overrides: Record<string, unknown> = {}) {
  return {
    lineageId: 'lineage-1',
    category: 'correctness',
    normalizedFailureModeHash: 'failure-mode-1',
    severity: FindingSeverity.Major,
    title: 'Previous defect',
    message: 'Previous message',
    filePath: 'src/service.ts',
    line: 2,
    firstSeenHeadSha: 'a'.repeat(40),
    lastSeenHeadSha: 'b'.repeat(40),
    active: true,
    ...overrides,
  };
}

function inventory(
  overrides: Partial<CurrentLifecycleInventory> = {}
): CurrentLifecycleInventory {
  return {
    inventoryVersion: 'review_lifecycle_inventory.v1',
    loadedForHeadSha: HEAD,
    lifecycleStateHash: 'state-1',
    commandLedgerWatermark: 'ledger-1',
    complete: true,
    warnings: [],
    targets: [],
    ...overrides,
  };
}

function target(
  overrides: Partial<CurrentLifecycleInventory['targets'][number]> = {}
): CurrentLifecycleInventory['targets'][number] {
  return {
    targetId: 'target-1',
    threadId: 'thread-1',
    trustedMarker: 'marker-1',
    title: 'Previous defect',
    message: 'Previous message',
    severity: FindingSeverity.Major,
    originalPath: 'src/service.ts',
    currentPath: 'src/service.ts',
    originalLine: 2,
    currentLine: 2,
    parentCommentUpdatedAt: '2026-07-22T00:00:00.000Z',
    threadCommentCount: 1,
    disposition: LifecycleTargetDisposition.Active,
    viewerCanResolve: false,
    ...overrides,
  };
}

function testLimits(
  overrides: Partial<ReviewProjectionLimits> = {}
): ReviewProjectionLimits {
  return {
    ...REVIEW_PROJECTION_ABSOLUTE_LIMITS,
    maxProjectionBytes: 500_000,
    maxFindings: 100,
    maxLineageHints: 100,
    maxLifecycleTargets: 100,
    maxInlineComments: 100,
    maxInlineCommentsPerChunk: 25,
    maxInlineChunks: 4,
    ...overrides,
  };
}

function isCurrent(state: FindingOccurrenceState): boolean {
  return (
    state === FindingOccurrenceState.New ||
    state === FindingOccurrenceState.Reconfirmed ||
    state === FindingOccurrenceState.Changed
  );
}

function severityRank(severity: FindingSeverity): number {
  return {
    [FindingSeverity.Critical]: 3,
    [FindingSeverity.Major]: 2,
    [FindingSeverity.Minor]: 1,
  }[severity];
}
