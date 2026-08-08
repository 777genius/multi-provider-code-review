import {
  ReviewActionV2OperationId,
  ReviewActionV2ProtocolErrorCode,
  ReviewContextReceiptReplayCommitResultStatus,
  ReviewInvestigationMutationResultStatus,
  ReviewInvestigationNextAction,
  ReviewInvestigationOpenResultStatus,
  ReviewInvestigationPublishedConclusion,
  ReviewInvestigationPublishedState,
  ReviewInvestigationRestoreResultStatus,
  ReviewInvestigationReplayPrepareResultStatus,
} from '../../../src/control-plane/generated/review-action-v2/review-action-v2';
import {
  ReviewActionV2ClientError,
  ReviewActionV2ClientFailureCode,
} from '../../../src/control-plane/review-action-v2-client';
import {
  ReviewInvestigationControlPlaneError,
  ReviewInvestigationControlPlaneFailureClass,
} from '../../../src/review-investigation/application/investigation-control-plane-port';
import { ReviewActionV2InvestigationAdapter } from '../../../src/review-investigation/infrastructure/review-action-v2-investigation-adapter';
import {
  canonicalJson,
  sha256,
} from '../../../src/review-investigation/domain/canonical-json';
import {
  REVIEW_INVESTIGATION_CANONICAL_REQUIREMENT_MAX_LENGTH,
  REVIEW_INVESTIGATION_TURN_BRIEF_MAX_BYTES,
  ReviewInvestigationState,
  ReviewInvestigationConclusion,
  ReviewInvestigationNextAction as DomainNextAction,
  type ReviewInvestigationSnapshot,
} from '../../../src/review-investigation/domain/investigation-state';
import { ReviewAgentProviderKind } from '../../../src/review-investigation/domain/runtime-profile';
import {
  ReviewTurnObligationKind,
  ReviewTurnPurpose,
} from '../../../src/review-investigation/domain/turn-observation';

describe('ReviewActionV2InvestigationAdapter turn brief', () => {
  it('sends the exact prepared seed envelope bytes and hash', async () => {
    const seedEnvelopeCanonicalJson = canonicalJson({
      contract: 'review_investigation_seed_envelope.v1',
      obligations: [],
      probePlanHash: sha256('probe-plan'),
      requestedModel: 'gpt-test',
      reviewPromptHash: sha256('review-prompt'),
    });
    const client = {
      execute: jest.fn().mockResolvedValue({
        ...planResult({
          turnBriefCanonicalJson: canonicalJson(null),
          turnBriefHash: sha256(canonicalJson(null)),
        }),
        status: ReviewInvestigationOpenResultStatus.Opened,
      }),
    };
    const adapter = new ReviewActionV2InvestigationAdapter(client as never);

    await adapter.open({
      ...openInput(),
      seedEnvelope: {
        canonicalJson: seedEnvelopeCanonicalJson,
        hash: sha256(seedEnvelopeCanonicalJson),
      },
    });

    expect(client.execute).toHaveBeenCalledWith(
      ReviewActionV2OperationId.ReviewInvestigationOpenV2,
      expect.objectContaining({
        seedObligationsCanonicalJson: seedEnvelopeCanonicalJson,
        seedObligationsHash: sha256(seedEnvelopeCanonicalJson),
      })
    );
  });

  it('restores a complete certificate-backed terminal artifact', async () => {
    const result = terminalResult();
    const adapter = new ReviewActionV2InvestigationAdapter({
      execute: jest.fn().mockResolvedValue(result),
    } as never);

    await expect(
      adapter.restore({
        authorizationToken: 'authorization-token',
        authorizationId: 'authorization-1',
        investigationId: 'investigation-1',
        reviewRevisionHash: digest('r'),
      })
    ).resolves.toMatchObject({
      state: ReviewInvestigationState.Concluded,
      certificateId: 'certificate-1',
      terminalProviderKind: ReviewAgentProviderKind.Codex,
      terminalActualModel: 'gpt-test',
      conclusion: ReviewInvestigationConclusion.VerifiedClean,
    });
  });

  it('rejects a terminal artifact whose payload hash is inconsistent', async () => {
    const adapter = new ReviewActionV2InvestigationAdapter({
      execute: jest
        .fn()
        .mockResolvedValue(
          terminalResult({ terminalOutcomeHash: digest('f') })
        ),
    } as never);

    await expect(
      adapter.restore({
        authorizationToken: 'authorization-token',
        authorizationId: 'authorization-1',
        investigationId: 'investigation-1',
        reviewRevisionHash: digest('r'),
      })
    ).rejects.toThrow('investigation_terminal_artifact_invalid');
  });

  it.each([
    [
      'concluded with inconclusive',
      {
        state: ReviewInvestigationState.Concluded,
        conclusion: ReviewInvestigationConclusion.Inconclusive,
      },
    ],
    [
      'inconclusive with verified_clean',
      {
        state: ReviewInvestigationState.Inconclusive,
        conclusion: ReviewInvestigationConclusion.VerifiedClean,
      },
    ],
    [
      'inconclusive with findings',
      {
        state: ReviewInvestigationState.Inconclusive,
        conclusion: ReviewInvestigationConclusion.Findings,
        findingCount: 1,
        terminalPayload: reviewEvidencePayload([normalizedFinding()]),
      },
    ],
  ])(
    'rejects terminal state/conclusion combination: %s',
    async (_, overrides) => {
      await expect(restoreResult(terminalResult(overrides))).rejects.toThrow(
        'investigation_terminal_artifact_invalid'
      );
    }
  );

  it.each([
    [
      'verified_clean with findings',
      {
        findingCount: 1,
        terminalPayload: reviewEvidencePayload([normalizedFinding()]),
      },
    ],
    ['verified_clean with open obligations', { openObligationCount: 1 }],
    [
      'verified_clean with unresolvable obligations',
      { unresolvableObligationCount: 1 },
    ],
    [
      'findings without findings',
      { conclusion: ReviewInvestigationConclusion.Findings },
    ],
    [
      'findings with open obligations',
      {
        conclusion: ReviewInvestigationConclusion.Findings,
        findingCount: 1,
        openObligationCount: 1,
        terminalPayload: reviewEvidencePayload([normalizedFinding()]),
      },
    ],
    [
      'findings with unresolvable obligations',
      {
        conclusion: ReviewInvestigationConclusion.Findings,
        findingCount: 1,
        unresolvableObligationCount: 1,
        terminalPayload: reviewEvidencePayload([normalizedFinding()]),
      },
    ],
  ])('rejects inconsistent terminal counts: %s', async (_, overrides) => {
    await expect(restoreResult(terminalResult(overrides))).rejects.toThrow(
      'investigation_terminal_artifact_invalid'
    );
  });

  it.each([
    ['a non-object root', []],
    [
      'an unsupported payload version',
      { ...reviewEvidencePayload(), payloadVersion: 1 },
    ],
    [
      'a missing normalized findings array',
      {
        normalizedLifecycleRevalidations: [],
        payloadVersion: 2,
        safeUsage: safeUsage(),
      },
    ],
    [
      'a non-array lifecycle collection',
      {
        ...reviewEvidencePayload(),
        normalizedLifecycleRevalidations: {},
      },
    ],
    [
      'a non-record normalized finding',
      { ...reviewEvidencePayload(), normalizedFindings: ['invalid'] },
    ],
    [
      'a non-record safe usage value',
      { ...reviewEvidencePayload(), safeUsage: [] },
    ],
    [
      'an incomplete safe usage value',
      {
        ...reviewEvidencePayload(),
        safeUsage: { inputTokens: null, outputTokens: null },
      },
    ],
    [
      'an inconsistent safe usage total',
      {
        ...reviewEvidencePayload(),
        safeUsage: { inputTokens: 2, outputTokens: 3, totalTokens: 6 },
      },
    ],
    [
      'an unexpected root field',
      { ...reviewEvidencePayload(), unexpected: true },
    ],
  ])(
    'rejects terminal ReviewEvidence v2 payload with %s',
    async (_, payload) => {
      await expect(
        restoreResult(terminalResult({ terminalPayload: payload }))
      ).rejects.toThrow('investigation_terminal_payload_invalid');
    }
  );

  it.each([
    ['an empty record', {}],
    ['an unexpected key', { ...normalizedFinding(), unexpected: true }],
    ['a non-string field', { ...normalizedFinding(), title: 1 }],
    [
      'an invalid failure-mode digest',
      { ...normalizedFinding(), normalizedFailureModeHash: 'invalid' },
    ],
    ['an unsupported severity', { ...normalizedFinding(), severity: 'info' }],
    ['an invalid line', { ...normalizedFinding(), startLine: 0 }],
    [
      'an out-of-range confidence',
      { ...normalizedFinding(), placementConfidence: 1.1 },
    ],
    ['non-string evidence', { ...normalizedFinding(), evidence: [1] }],
  ])('rejects normalized finding with %s', async (_, finding) => {
    await expect(
      restoreResult(
        terminalResult({
          conclusion: ReviewInvestigationConclusion.Findings,
          findingCount: 1,
          terminalPayload: {
            ...reviewEvidencePayload(),
            normalizedFindings: [finding],
          },
        })
      )
    ).rejects.toThrow('investigation_terminal_payload_invalid');
  });

  it.each([
    ['an empty record', {}],
    [
      'an unexpected key',
      { ...normalizedLifecycleRevalidation(), unexpected: true },
    ],
    [
      'a non-string target',
      { ...normalizedLifecycleRevalidation(), targetId: 1 },
    ],
    [
      'an unsupported verdict',
      { ...normalizedLifecycleRevalidation(), verdict: 'open' },
    ],
    [
      'an out-of-range confidence',
      { ...normalizedLifecycleRevalidation(), confidence: -0.1 },
    ],
    [
      'a non-array evidence value',
      { ...normalizedLifecycleRevalidation(), evidence: {} },
    ],
    [
      'an empty evidence record',
      { ...normalizedLifecycleRevalidation(), evidence: [{}] },
    ],
    [
      'an unexpected evidence key',
      {
        ...normalizedLifecycleRevalidation(),
        evidence: [{ ...normalizedLifecycleEvidence(), unexpected: true }],
      },
    ],
    [
      'a non-string evidence field',
      {
        ...normalizedLifecycleRevalidation(),
        evidence: [{ ...normalizedLifecycleEvidence(), reason: 1 }],
      },
    ],
    [
      'an invalid evidence line',
      {
        ...normalizedLifecycleRevalidation(),
        evidence: [{ ...normalizedLifecycleEvidence(), endLine: 0 }],
      },
    ],
  ])('rejects normalized lifecycle revalidation with %s', async (_, item) => {
    await expect(
      restoreResult(
        terminalResult({
          terminalPayload: {
            ...reviewEvidencePayload(),
            normalizedLifecycleRevalidations: [item],
          },
        })
      )
    ).rejects.toThrow('investigation_terminal_payload_invalid');
  });

  it('rejects a terminal payload whose finding count differs from the snapshot', async () => {
    await expect(
      restoreResult(
        terminalResult({
          conclusion: ReviewInvestigationConclusion.Findings,
          findingCount: 1,
          terminalPayload: reviewEvidencePayload(),
        })
      )
    ).rejects.toThrow('investigation_terminal_payload_invalid');
  });

  it('restores findings when the terminal payload and snapshot counts agree', async () => {
    await expect(
      restoreResult(
        terminalResult({
          conclusion: ReviewInvestigationConclusion.Findings,
          findingCount: 1,
          terminalPayload: reviewEvidencePayload([normalizedFinding()]),
        })
      )
    ).resolves.toMatchObject({
      state: ReviewInvestigationState.Concluded,
      conclusion: ReviewInvestigationConclusion.Findings,
      findingCount: 1,
    });
  });

  it('restores a terminal payload with normalized lifecycle evidence', async () => {
    await expect(
      restoreResult(
        terminalResult({
          terminalPayload: reviewEvidencePayload(
            [],
            [normalizedLifecycleRevalidation()]
          ),
        })
      )
    ).resolves.toMatchObject({
      state: ReviewInvestigationState.Concluded,
      conclusion: ReviewInvestigationConclusion.VerifiedClean,
    });
  });

  it('accepts an inconclusive decision while certificate issuance is pending', async () => {
    const result = preCertificateInconclusiveResult();
    const adapter = new ReviewActionV2InvestigationAdapter({
      execute: jest.fn().mockResolvedValue(result),
    } as never);

    await expect(
      adapter.restore({
        authorizationToken: 'authorization-token',
        authorizationId: 'authorization-1',
        investigationId: 'investigation-1',
        reviewRevisionHash: digest('r'),
      })
    ).resolves.toMatchObject({
      state: ReviewInvestigationState.Inconclusive,
      nextAction: DomainNextAction.Conclude,
      certificateId: null,
      conclusion: ReviewInvestigationConclusion.Inconclusive,
    });
  });

  it('binds a canonical turn brief to the returned dossier and turn', async () => {
    const brief = canonicalJson({
      briefVersion: 1,
      investigationId: 'investigation-1',
      investigationVersion: 2,
      dossierDigest: digest('d'),
      turnId: 'turn-1',
      purpose: ReviewTurnPurpose.Discovery,
      maximumSemanticRiskPriority: 100,
      obligations: [
        {
          obligationId: digest('b'),
          kind: ReviewTurnObligationKind.ChangedContent,
          canonicalSubject: 'src/review.ts',
          canonicalRequirement: 'inspect complete changed content',
          riskPriority: 100,
          origin: 'coverage_contract',
        },
      ],
    });
    const client = {
      execute: jest.fn().mockResolvedValue(
        planResult({
          turnBriefCanonicalJson: brief,
          turnBriefHash: sha256(brief),
        })
      ),
    };
    const adapter = new ReviewActionV2InvestigationAdapter(client as never);

    const planned = await adapter.planTurn({
      authorizationToken: 'authorization-token',
      snapshot: unplannedSnapshot(),
      leaseDurationMs: 60_000,
      maxObligationsForTurn: 4,
      turnBudget: { maxTokens: 10_000 },
    });

    expect(planned.turn?.brief).toEqual({
      briefVersion: 1,
      investigationId: 'investigation-1',
      investigationVersion: 2,
      dossierDigest: digest('d'),
      turnId: 'turn-1',
      purpose: ReviewTurnPurpose.Discovery,
      maximumSemanticRiskPriority: 100,
      obligations: [
        {
          obligationId: digest('b'),
          kind: ReviewTurnObligationKind.ChangedContent,
          canonicalSubject: 'src/review.ts',
          canonicalRequirement: 'inspect complete changed content',
          riskPriority: 100,
          origin: 'coverage_contract',
        },
      ],
    });
  });

  it('accepts a canonical expanded turn brief larger than 16 KB', async () => {
    const obligations = Array.from({ length: 16 }, (_, index) => ({
      obligationId: sha256(`expanded-obligation-${index}`),
      kind: ReviewTurnObligationKind.ChangedContent,
      canonicalSubject: `src/expanded-${index}.ts`,
      canonicalRequirement: `inspect expanded dependency context ${'x'.repeat(1_024)}`,
      riskPriority: 900_000 - index,
      origin: 'deterministic_expansion',
    }));
    const brief = canonicalJson({
      briefVersion: 1,
      investigationId: 'investigation-1',
      investigationVersion: 2,
      dossierDigest: digest('d'),
      turnId: 'turn-1',
      purpose: ReviewTurnPurpose.Discovery,
      maximumSemanticRiskPriority: 900_000,
      obligations,
    });
    expect(Buffer.byteLength(brief, 'utf8')).toBeGreaterThan(16_000);
    const adapter = new ReviewActionV2InvestigationAdapter({
      execute: jest.fn().mockResolvedValue(
        planResult({
          turnBriefCanonicalJson: brief,
          turnBriefHash: sha256(brief),
          obligationIds: obligations.map(({ obligationId }) => obligationId),
        })
      ),
    } as never);

    const planned = await adapter.planTurn({
      authorizationToken: 'authorization-token',
      snapshot: unplannedSnapshot(),
      leaseDurationMs: 60_000,
      maxObligationsForTurn: 16,
      turnBudget: { maxTokens: 120_000 },
    });

    expect(planned.turn?.brief?.obligations).toHaveLength(16);
    expect(planned.turn?.brief?.obligations.at(-1)?.obligationId).toBe(
      obligations.at(-1)?.obligationId
    );
  });

  it('accepts the producer maximum canonical requirement length', async () => {
    const obligationId = sha256('maximum-requirement-obligation');
    const canonicalRequirement = '€'.repeat(
      REVIEW_INVESTIGATION_CANONICAL_REQUIREMENT_MAX_LENGTH
    );
    const brief = canonicalJson({
      briefVersion: 1,
      investigationId: 'investigation-1',
      investigationVersion: 2,
      dossierDigest: digest('d'),
      turnId: 'turn-1',
      purpose: ReviewTurnPurpose.Discovery,
      maximumSemanticRiskPriority: 900_000,
      obligations: [
        {
          obligationId,
          kind: ReviewTurnObligationKind.ChangedContent,
          canonicalSubject: 'src/maximum.ts',
          canonicalRequirement,
          riskPriority: 900_000,
          origin: 'deterministic_expansion',
        },
      ],
    });
    const adapter = new ReviewActionV2InvestigationAdapter({
      execute: jest.fn().mockResolvedValue(
        planResult({
          turnBriefCanonicalJson: brief,
          turnBriefHash: sha256(brief),
          obligationIds: [obligationId],
        })
      ),
    } as never);

    await expect(
      adapter.planTurn({
        authorizationToken: 'authorization-token',
        snapshot: unplannedSnapshot(),
        leaseDurationMs: 60_000,
        maxObligationsForTurn: 1,
        turnBudget: { maxTokens: 120_000 },
      })
    ).resolves.toMatchObject({
      turn: {
        brief: {
          obligations: [{ canonicalRequirement }],
        },
      },
    });
  });

  it('rejects a canonical requirement beyond the producer maximum', async () => {
    const obligationId = sha256('oversized-requirement-obligation');
    const brief = canonicalJson({
      briefVersion: 1,
      investigationId: 'investigation-1',
      investigationVersion: 2,
      dossierDigest: digest('d'),
      turnId: 'turn-1',
      purpose: ReviewTurnPurpose.Discovery,
      maximumSemanticRiskPriority: 900_000,
      obligations: [
        {
          obligationId,
          kind: ReviewTurnObligationKind.ChangedContent,
          canonicalSubject: 'src/oversized.ts',
          canonicalRequirement: 'x'.repeat(
            REVIEW_INVESTIGATION_CANONICAL_REQUIREMENT_MAX_LENGTH + 1
          ),
          riskPriority: 900_000,
          origin: 'deterministic_expansion',
        },
      ],
    });
    const adapter = new ReviewActionV2InvestigationAdapter({
      execute: jest.fn().mockResolvedValue(
        planResult({
          turnBriefCanonicalJson: brief,
          turnBriefHash: sha256(brief),
          obligationIds: [obligationId],
        })
      ),
    } as never);

    await expect(
      adapter.planTurn({
        authorizationToken: 'authorization-token',
        snapshot: unplannedSnapshot(),
        leaseDurationMs: 60_000,
        maxObligationsForTurn: 1,
        turnBudget: { maxTokens: 120_000 },
      })
    ).rejects.toThrow('canonical_requirement_invalid');
  });

  it('rejects a UTF-8 turn brief beyond its aggregate byte limit', async () => {
    const oversizedBrief = canonicalJson({
      payload: '€'.repeat(
        Math.ceil(REVIEW_INVESTIGATION_TURN_BRIEF_MAX_BYTES / 3) + 1
      ),
    });
    expect(Buffer.byteLength(oversizedBrief, 'utf8')).toBeGreaterThan(
      REVIEW_INVESTIGATION_TURN_BRIEF_MAX_BYTES
    );
    const adapter = new ReviewActionV2InvestigationAdapter({
      execute: jest.fn().mockResolvedValue(
        planResult({
          turnBriefCanonicalJson: oversizedBrief,
          turnBriefHash: sha256(oversizedBrief),
        })
      ),
    } as never);

    await expect(
      adapter.planTurn({
        authorizationToken: 'authorization-token',
        snapshot: unplannedSnapshot(),
        leaseDurationMs: 60_000,
        maxObligationsForTurn: 1,
        turnBudget: { maxTokens: 120_000 },
      })
    ).rejects.toThrow('turn_brief_canonical_json_invalid');
  });

  it.each([
    [
      'provider discovery evidence',
      ['investigation_operation_backed_discovery_invalid'],
      ReviewInvestigationControlPlaneFailureClass.ProviderOutputInvalid,
    ],
    [
      'provider discovery evidence limit',
      ['investigation_operation_backed_discovery_limit_exceeded'],
      ReviewInvestigationControlPlaneFailureClass.ProviderOutputInvalid,
    ],
    [
      'provider turn obligation claim',
      ['turn_obligation_claim_invalid'],
      ReviewInvestigationControlPlaneFailureClass.ProviderOutputInvalid,
    ],
    [
      'provider obligation evidence',
      ['investigation_obligation_evidence_mismatch'],
      ReviewInvestigationControlPlaneFailureClass.ProviderOutputInvalid,
    ],
    [
      'an unrelated server invariant',
      ['investigation_internal_state_invalid'],
      ReviewInvestigationControlPlaneFailureClass.Rejected,
    ],
    [
      'mixed provider and server invariants',
      [
        'investigation_operation_backed_discovery_invalid',
        'investigation_internal_state_invalid',
      ],
      ReviewInvestigationControlPlaneFailureClass.Rejected,
    ],
  ])(
    'classifies %s without weakening other invariant failures',
    async (_, issues, expectedFailureClass) => {
      const brief = canonicalJson({
        briefVersion: 1,
        investigationId: 'investigation-1',
        investigationVersion: 2,
        dossierDigest: digest('d'),
        turnId: 'turn-1',
        purpose: ReviewTurnPurpose.Discovery,
        maximumSemanticRiskPriority: 100,
        obligations: [
          {
            obligationId: digest('b'),
            kind: ReviewTurnObligationKind.ChangedContent,
            canonicalSubject: 'src/review.ts',
            canonicalRequirement: 'inspect complete changed content',
            riskPriority: 100,
            origin: 'coverage_contract',
          },
        ],
      });
      const client = {
        execute: jest
          .fn()
          .mockResolvedValueOnce(
            planResult({
              turnBriefCanonicalJson: brief,
              turnBriefHash: sha256(brief),
            })
          )
          .mockRejectedValueOnce(
            new ReviewActionV2ClientError(
              ReviewActionV2ClientFailureCode.ProtocolError,
              ReviewActionV2OperationId.ReviewInvestigationTurnCommit,
              {
                httpStatus: 422,
                protocolErrorCode:
                  ReviewActionV2ProtocolErrorCode.InvariantViolation,
                issues,
              }
            )
          ),
      };
      const adapter = new ReviewActionV2InvestigationAdapter(client as never);
      const planned = await adapter.planTurn({
        authorizationToken: 'authorization-token',
        snapshot: unplannedSnapshot(),
        leaseDurationMs: 60_000,
        maxObligationsForTurn: 4,
        turnBudget: { maxTokens: 10_000 },
      });

      const committed = adapter.commitTurn({
        authorizationToken: 'authorization-token',
        snapshot: planned,
        lease: {
          leaseId: 'lease-1',
          attemptId: 'attempt-1',
          leaseCapability: 'lease.capability.value',
          fencingToken: '1',
          expiresAt: '2026-08-02T10:10:00.000Z',
          resultReportUntil: '2026-08-02T10:20:00.000Z',
        },
        attestationId: 'attestation-1',
        attestationHash: digest('e'),
        observation: {} as never,
      });

      await expect(committed).rejects.toEqual(
        expect.objectContaining<Partial<ReviewInvestigationControlPlaneError>>({
          failureClass: expectedFailureClass,
        })
      );
    }
  );

  it('rejects a turn brief whose hash does not match', async () => {
    const brief = canonicalJson(null);
    const client = {
      execute: jest.fn().mockResolvedValue(
        planResult({
          turnBriefCanonicalJson: brief,
          turnBriefHash: digest('f'),
        })
      ),
    };
    const adapter = new ReviewActionV2InvestigationAdapter(client as never);

    await expect(
      adapter.planTurn({
        authorizationToken: 'authorization-token',
        snapshot: unplannedSnapshot(),
        leaseDurationMs: 60_000,
        maxObligationsForTurn: 4,
        turnBudget: { maxTokens: 10_000 },
      })
    ).rejects.toThrow('turn_brief_hash_mismatch');
  });

  it('preserves aggregate risk when a critic turn has no open obligations', async () => {
    const brief = canonicalJson({
      briefVersion: 1,
      investigationId: 'investigation-1',
      investigationVersion: 2,
      dossierDigest: digest('d'),
      turnId: 'turn-1',
      purpose: ReviewTurnPurpose.Critic,
      maximumSemanticRiskPriority: 900_000,
      obligations: [],
    });
    const adapter = new ReviewActionV2InvestigationAdapter({
      execute: jest.fn().mockResolvedValue(
        planResult({
          turnBriefCanonicalJson: brief,
          turnBriefHash: sha256(brief),
          critic: true,
        })
      ),
    } as never);

    const planned = await adapter.planTurn({
      authorizationToken: 'authorization-token',
      snapshot: unplannedSnapshot(),
      leaseDurationMs: 60_000,
      maxObligationsForTurn: 4,
      turnBudget: { maxTokens: 10_000 },
    });

    expect(planned.turn?.brief).toMatchObject({
      purpose: ReviewTurnPurpose.Critic,
      maximumSemanticRiskPriority: 900_000,
      obligations: [],
    });
  });

  it('requires a bounded aggregate semantic risk in the v1 turn brief', async () => {
    for (const maximumSemanticRiskPriority of [undefined, 1_000_001]) {
      const document = {
        briefVersion: 1,
        investigationId: 'investigation-1',
        investigationVersion: 2,
        dossierDigest: digest('d'),
        turnId: 'turn-1',
        purpose: ReviewTurnPurpose.Critic,
        ...(maximumSemanticRiskPriority === undefined
          ? {}
          : { maximumSemanticRiskPriority }),
        obligations: [],
      };
      const brief = canonicalJson(document);
      const adapter = new ReviewActionV2InvestigationAdapter({
        execute: jest.fn().mockResolvedValue(
          planResult({
            turnBriefCanonicalJson: brief,
            turnBriefHash: sha256(brief),
            critic: true,
          })
        ),
      } as never);

      await expect(
        adapter.planTurn({
          authorizationToken: 'authorization-token',
          snapshot: unplannedSnapshot(),
          leaseDurationMs: 60_000,
          maxObligationsForTurn: 4,
          turnBudget: { maxTokens: 10_000 },
        })
      ).rejects.toThrow();
    }
  });

  it('parses a selective replay preparation and preserves its private capability', async () => {
    const replayPlanCanonicalJson = canonicalJson({ planVersion: 2 });
    const replayPreparationCanonicalJson = canonicalJson({
      obligations: [
        {
          obligationId: sha256('obligation'),
          contextAttestationId: 'attestation-1',
          contextAttestationHash: digest('a'),
          sourceOperationReceiptIdsHash: sha256('receipts'),
          replayCapability: 'private.replay.capability',
          replayPlanCanonicalJson,
          replayPlanHash: sha256(replayPlanCanonicalJson),
        },
      ],
    });
    const client = {
      execute: jest.fn().mockResolvedValue({
        status: ReviewInvestigationReplayPrepareResultStatus.Prepared,
        sourceInvestigationId: 'source-investigation',
        sourceCertificateId: 'source-certificate',
        sourceCertificateHash: digest('c'),
        replayPreparationCanonicalJson,
        replayPreparationHash: sha256(replayPreparationCanonicalJson),
      }),
    };
    const adapter = new ReviewActionV2InvestigationAdapter(client as never);

    const result = await adapter.prepareReplay({
      open: openInput(),
      providerManifestCanonicalJson: '{}',
      providerManifestHash: sha256('{}'),
    });

    expect(result?.obligations[0]).toMatchObject({
      obligationId: sha256('obligation'),
      replayCapability: 'private.replay.capability',
    });
    expect(client.execute).toHaveBeenCalledWith(
      ReviewActionV2OperationId.ReviewInvestigationReplayPrepare,
      expect.objectContaining({
        targetExecutionId: 'execution-1',
        targetWorkSlotId: 'work-slot-1',
      })
    );
  });

  it('commits a receipt proof with a deterministic request identity', async () => {
    const client = {
      execute: jest.fn().mockResolvedValue({
        status: ReviewContextReceiptReplayCommitResultStatus.Idempotent,
        replayProofId: 'proof-1',
        replayProofHash: sha256('proof'),
      }),
    };
    const adapter = new ReviewActionV2InvestigationAdapter(client as never);

    await expect(
      adapter.commitReceiptReplay({
        open: openInput(),
        prepared: {
          obligationId: sha256('obligation'),
          contextAttestationId: 'attestation-1',
          contextAttestationHash: digest('a'),
          sourceOperationReceiptIdsHash: sha256('receipts'),
          replayCapability: 'private.replay.capability',
          replayPlanCanonicalJson: '{}',
          replayPlanHash: sha256('{}'),
        },
        result: {
          targetCheckoutTreeOid: '1'.repeat(40),
          replayResultCanonicalJson: '{}',
          replayResultHash: sha256('{}'),
        },
      })
    ).resolves.toEqual({ replayProofId: 'proof-1' });
    expect(client.execute).toHaveBeenCalledWith(
      ReviewActionV2OperationId.ReviewContextReceiptReplayCommit,
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^rr:investigation:receipt-replay-commit:/
        ),
      })
    );
  });

  it('binds replay to the exact current target seed and open profile', async () => {
    const seedEnvelopeCanonicalJson = canonicalJson({
      contract: 'review_investigation_seed_envelope.v1',
      obligations: [{ kind: 'inventory_witness' }],
      probePlanHash: sha256('probe-plan'),
      requestedModel: 'gpt-test',
      reviewPromptHash: sha256('review-prompt'),
    });
    const initialReceipts = [{ receiptId: 'target-receipt' }];
    const open = {
      ...openInput(),
      coverageContract: { coverageContractVersion: 'coverage-v1' },
      investigationPolicy: { policyId: 'policy-v1' },
      seedEnvelope: {
        canonicalJson: seedEnvelopeCanonicalJson,
        hash: sha256(seedEnvelopeCanonicalJson),
      },
      initialReceipts,
    };
    const client = {
      execute: jest.fn().mockResolvedValue(replayMutationResult()),
    };
    const adapter = new ReviewActionV2InvestigationAdapter(client as never);

    await adapter.replay({
      open,
      scope: {
        workspaceId: 'workspace-1',
        repositoryConnectionId: 'connection-1',
        scmRepositoryIdentityId: 'repository-1',
        pullRequestNumber: 7,
        trustDomain: 'trusted',
        authorizationScopeHash: sha256('scope'),
      },
      revision: {
        baseSha: '1'.repeat(40),
        mergeBaseSha: '2'.repeat(40),
        headSha: '3'.repeat(40),
        reviewRevisionHash: open.reviewRevisionHash,
      },
      prepared: {
        sourceInvestigationId: 'source-investigation',
        sourceCertificateId: 'source-certificate',
        sourceCertificateHash: sha256('source-certificate'),
        obligations: [],
      },
      replayProofs: [],
    });

    expect(client.execute).toHaveBeenCalledWith(
      ReviewActionV2OperationId.ReviewInvestigationReplayV2,
      expect.objectContaining({
        stableReviewUnitKey: open.stableReviewUnitKey,
        providerVoteLaneId: open.providerVoteLaneId,
        providerStrategyId: open.providerStrategyId,
        coverageContractCanonicalJson: canonicalJson(open.coverageContract),
        investigationPolicyCanonicalJson: canonicalJson(
          open.investigationPolicy
        ),
        seedObligationsCanonicalJson: seedEnvelopeCanonicalJson,
        seedObligationsHash: sha256(seedEnvelopeCanonicalJson),
        initialReceiptsCanonicalJson: canonicalJson(initialReceipts),
        initialReceiptsHash: sha256(canonicalJson(initialReceipts)),
      })
    );
  });
});

function openInput() {
  return Object.freeze({
    authorizationToken: 'authorization-token',
    authorizationId: 'authorization-1',
    executionId: 'execution-1',
    workSlotId: 'work-slot-1',
    reviewRevisionHash: sha256('revision'),
    stableReviewUnitKey: 'stable-unit-1',
    providerVoteLaneId: 'lane-1',
    providerStrategyId: sha256('strategy'),
    runtimeProfile: 'gateway_attested_agent_v1',
    coverageContract: {},
    investigationPolicy: {},
    seedEnvelope: {
      canonicalJson: '{}',
      hash: sha256('{}'),
    },
    initialReceipts: [],
    providerManifestCanonicalJson: '{}',
    providerManifestHash: sha256('{}'),
    ownerIdHash: sha256('owner'),
  });
}

function replayMutationResult() {
  const readModel = unplannedSnapshot();
  return {
    status: ReviewInvestigationMutationResultStatus.Applied,
    investigationId: readModel.investigationId,
    investigationVersion: String(readModel.version),
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

function planResult(input: {
  turnBriefCanonicalJson: string;
  turnBriefHash: string;
  critic?: boolean;
  obligationIds?: readonly string[];
}) {
  const purpose = input.critic
    ? ReviewTurnPurpose.Critic
    : ReviewTurnPurpose.Discovery;
  const obligationIds = input.critic
    ? []
    : (input.obligationIds ?? [digest('b')]);
  const readModel = {
    investigationId: 'investigation-1',
    version: 2,
    state: ReviewInvestigationState.TurnLeased,
    dossierDigest: digest('d'),
    openObligationCount: obligationIds.length,
    satisfiedObligationCount: 0,
    unresolvableObligationCount: 0,
    findingCount: 0,
    semanticTurns: 0,
    operationalAttempts: 1,
    criticCycles: 0,
    nextEligibleAt: null,
    nextAction: input.critic
      ? DomainNextAction.RunCritic
      : DomainNextAction.RunTurn,
    turn: {
      turnId: 'turn-1',
      purpose,
      leasedAtVersion: 2,
      dossierDigest: digest('d'),
      obligationIds,
      semanticTurnOrdinal: input.critic ? 0 : 1,
      criticCycleOrdinal: input.critic ? 1 : 0,
      leasedAt: '2026-08-02T10:00:00.000Z',
      expiresAt: '2026-08-02T10:05:00.000Z',
    },
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
    investigationId: 'investigation-1',
    investigationVersion: '2',
    investigationState: ReviewInvestigationPublishedState.TurnLeased,
    dossierDigest: digest('d'),
    nextAction: input.critic
      ? ReviewInvestigationNextAction.RunCritic
      : ReviewInvestigationNextAction.RunTurn,
    investigationCanonicalJson: canonicalJson(readModel),
    certificateId: null,
    certificateHash: null,
    terminalProviderKind: null,
    terminalActualModel: null,
    terminalObservationCanonicalJson: null,
    terminalOutcomeHash: null,
    investigationConclusion: null,
    turnId: 'turn-1',
    turnCapability: 'turn.capability.value',
    turnExpiresAt: '2026-08-02T10:05:00.000Z',
    turnBriefCanonicalJson: input.turnBriefCanonicalJson,
    turnBriefHash: input.turnBriefHash,
  };
}

type TerminalResultOverrides = Partial<{
  state: ReviewInvestigationState;
  conclusion: ReviewInvestigationConclusion | null;
  openObligationCount: number;
  unresolvableObligationCount: number;
  findingCount: number;
  terminalPayload: Parameters<typeof canonicalJson>[0];
  terminalOutcomeHash: string;
}>;

function terminalResult(overrides: TerminalResultOverrides = {}) {
  const terminalObservationCanonicalJson = canonicalJson(
    overrides.terminalPayload === undefined
      ? reviewEvidencePayload()
      : overrides.terminalPayload
  );
  const terminalOutcomeHash =
    overrides.terminalOutcomeHash ?? sha256(terminalObservationCanonicalJson);
  const readModel = {
    investigationId: 'investigation-1',
    version: 7,
    state: overrides.state ?? ReviewInvestigationState.Concluded,
    dossierDigest: digest('d'),
    openObligationCount: overrides.openObligationCount ?? 0,
    satisfiedObligationCount: 2,
    unresolvableObligationCount: overrides.unresolvableObligationCount ?? 0,
    findingCount: overrides.findingCount ?? 0,
    semanticTurns: 1,
    operationalAttempts: 1,
    criticCycles: 1,
    nextEligibleAt: null,
    nextAction: DomainNextAction.Terminal,
    turn: null,
    certificateId: 'certificate-1',
    certificateHash: digest('c'),
    terminalProviderKind: ReviewAgentProviderKind.Codex,
    terminalActualModel: 'gpt-test',
    terminalObservationCanonicalJson,
    terminalOutcomeHash,
    conclusion:
      overrides.conclusion === undefined
        ? ReviewInvestigationConclusion.VerifiedClean
        : overrides.conclusion,
  };
  return {
    status: ReviewInvestigationRestoreResultStatus.Found,
    investigationId: readModel.investigationId,
    investigationVersion: String(readModel.version),
    investigationState:
      readModel.state as unknown as ReviewInvestigationPublishedState,
    dossierDigest: readModel.dossierDigest,
    nextAction: ReviewInvestigationNextAction.Terminal,
    investigationCanonicalJson: canonicalJson(readModel),
    certificateId: readModel.certificateId,
    certificateHash: readModel.certificateHash,
    terminalProviderKind: readModel.terminalProviderKind,
    terminalActualModel: readModel.terminalActualModel,
    terminalObservationCanonicalJson,
    terminalOutcomeHash,
    investigationConclusion:
      readModel.conclusion as unknown as ReviewInvestigationPublishedConclusion | null,
  };
}

function restoreResult(result: unknown) {
  const adapter = new ReviewActionV2InvestigationAdapter({
    execute: jest.fn().mockResolvedValue(result),
  } as never);
  return adapter.restore({
    authorizationToken: 'authorization-token',
    authorizationId: 'authorization-1',
    investigationId: 'investigation-1',
    reviewRevisionHash: digest('r'),
  });
}

function reviewEvidencePayload(
  normalizedFindings: readonly ReturnType<typeof normalizedFinding>[] = [],
  normalizedLifecycleRevalidations: readonly ReturnType<
    typeof normalizedLifecycleRevalidation
  >[] = []
) {
  return {
    normalizedFindings,
    normalizedLifecycleRevalidations,
    payloadVersion: 2,
    safeUsage: safeUsage(),
  } as const;
}

function normalizedFinding() {
  return {
    category: 'correctness',
    endLine: 1,
    evidence: ['Finding evidence'],
    message: 'Finding message',
    normalizedFailureModeHash: digest('f'),
    path: 'src/index.ts',
    placementConfidence: 1,
    severity: 'major',
    startLine: 1,
    suggestion: null,
    title: 'Finding title',
  } as const;
}

function normalizedLifecycleRevalidation() {
  return {
    confidence: 0.8,
    evidence: [normalizedLifecycleEvidence()],
    fingerprint: 'finding-fingerprint',
    rationale: 'The previous finding is still present.',
    targetId: 'thread-1',
    verdict: 'still_valid',
  } as const;
}

function normalizedLifecycleEvidence() {
  return {
    endLine: 2,
    path: 'src/index.ts',
    reason: 'The affected line is unchanged.',
    startLine: 2,
  } as const;
}

function safeUsage() {
  return {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
  } as const;
}

function preCertificateInconclusiveResult() {
  const readModel = {
    investigationId: 'investigation-1',
    version: 6,
    state: ReviewInvestigationState.Inconclusive,
    dossierDigest: digest('d'),
    openObligationCount: 0,
    satisfiedObligationCount: 2,
    unresolvableObligationCount: 0,
    findingCount: 0,
    semanticTurns: 1,
    operationalAttempts: 1,
    criticCycles: 2,
    nextEligibleAt: null,
    nextAction: DomainNextAction.Conclude,
    turn: null,
    certificateId: null,
    certificateHash: null,
    terminalProviderKind: null,
    terminalActualModel: null,
    terminalObservationCanonicalJson: null,
    terminalOutcomeHash: null,
    conclusion: ReviewInvestigationConclusion.Inconclusive,
  };
  return {
    status: ReviewInvestigationRestoreResultStatus.Found,
    investigationId: readModel.investigationId,
    investigationVersion: String(readModel.version),
    investigationState: ReviewInvestigationPublishedState.Inconclusive,
    dossierDigest: readModel.dossierDigest,
    nextAction: ReviewInvestigationNextAction.Conclude,
    investigationCanonicalJson: canonicalJson(readModel),
    certificateId: null,
    certificateHash: null,
    terminalProviderKind: null,
    terminalActualModel: null,
    terminalObservationCanonicalJson: null,
    terminalOutcomeHash: null,
    investigationConclusion:
      ReviewInvestigationPublishedConclusion.Inconclusive,
  };
}

function unplannedSnapshot(): ReviewInvestigationSnapshot {
  return Object.freeze({
    investigationId: 'investigation-1',
    version: 1,
    state: ReviewInvestigationState.AwaitingTurn,
    dossierDigest: digest('a'),
    openObligationCount: 1,
    satisfiedObligationCount: 0,
    unresolvableObligationCount: 0,
    findingCount: 0,
    semanticTurns: 0,
    operationalAttempts: 0,
    criticCycles: 0,
    nextEligibleAt: null,
    nextAction: DomainNextAction.RunTurn,
    turn: null,
    certificateId: null,
    certificateHash: null,
    terminalProviderKind: null,
    terminalActualModel: null,
    terminalObservationCanonicalJson: null,
    terminalOutcomeHash: null,
    conclusion: null,
  });
}

function digest(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}
