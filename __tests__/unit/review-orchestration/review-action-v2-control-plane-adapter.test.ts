import { createHash } from 'crypto';
import {
  ReviewActionV2Client,
  ReviewActionV2ClientError,
  ReviewActionV2ClientFailureCode,
} from '../../../src/control-plane/review-action-v2-client';
import {
  reviewInvestigationExtensionV1,
  reviewInvestigationRolloutAuthorizationV3Contract,
  ReviewActionV2ProtocolErrorCode,
  ReviewEvidenceLookupResultStatus,
  ReviewEvidenceCommitResultStatus,
  ReviewActionV2OperationId,
  ReviewContextGatewayOpenResultStatus,
  ReviewContextGatewaySealResultStatus,
  ReviewContextReplayCommitResultStatus,
  ReviewExecutionMutationResultStatus,
  ReviewExecutionRestoreResultStatus,
  ReviewExecutionStartResultStatus,
  ReviewInvocationLeaseResultStatus,
  ReviewPublicationRequestResultStatus,
  ReviewPublicationStatusResultStatus,
  ReviewRunAuthorizationResultStatus,
} from '../../../src/control-plane/generated/review-action-v2/review-action-v2';
import { ReviewActionV2RetryClass } from '../../../src/control-plane/generated/review-action-v2/review-action-v2-negotiation';
import { MergeGateConclusion } from '../../../src/review-projection/domain';
import { logger } from '../../../src/utils/logger';
import {
  ReviewCapabilityKind,
  ReviewExecutionProviderKind,
  ReviewEvidenceCommitRejectedError,
  ReviewEvidenceCommitRejectionReason,
  ReviewEvidenceLookupKind,
  ReviewInvestigationRolloutCapability,
  ReviewInvocationConfigurationMismatchError,
  ReviewInvocationConfigurationMismatchReason,
  ReviewInvocationLeaseAcquireOutcomeStatus,
  ReviewPublicationRequestOutcomeStatus,
  ReviewPublicationUnavailableFact,
  ReviewPublicationState,
  ReviewTaskKind,
  RestoredReviewExecutionState,
  RestoredReviewWorkSlotState,
} from '../../../src/review-orchestration/application';
import { ReviewActionV2ControlPlaneAdapter } from '../../../src/review-orchestration/infrastructure/review-action-v2-control-plane-adapter';

const investigationExtensionDescriptor = Object.freeze({
  extensionId: reviewInvestigationExtensionV1.extensionId,
  extensionSchemaDigest: reviewInvestigationExtensionV1.schemaDigest,
  extensionCanonicalizerDigest:
    reviewInvestigationExtensionV1.canonicalizerDigest,
});

function reviewInvestigationDescriptor(
  overrides: Readonly<Record<string, unknown>> = {}
) {
  return {
    ...investigationExtensionDescriptor,
    authorizationDescriptorVersion:
      reviewInvestigationRolloutAuthorizationV3Contract.authorizationDescriptorVersion,
    capability: ReviewCapabilityKind.ReviewInvestigationV1,
    coverageProfileHash: hash('coverage-profile'),
    policyHash: hash('investigation-policy'),
    providerCapabilities: [
      {
        providerKind: ReviewExecutionProviderKind.Codex,
        capabilities: [ReviewInvestigationRolloutCapability.Recording],
      },
    ],
    ...overrides,
  };
}

describe('ReviewActionV2ControlPlaneAdapter', () => {
  it('normalizes a complete generated authorization and selected limits', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewRunAuthorizationResultStatus.Authorized,
      authorizationId: 'authorization-1',
      authorizationToken: 'authorization.token',
      producerReleaseId: 'release-1',
      protocolLimitsProfileId: 'limits-1',
      operationalSloProfileId: 'slo-1',
      mutationEpoch: '1',
      expiresAt: '2026-07-22T13:00:00.000Z',
      protocolLimitsCanonicalJson: JSON.stringify(protocolLimits),
      authorizationFactsCanonicalJson: canonicalJson(authorizationFacts),
    });
    const adapter = createAdapter(execute);

    await expect(
      adapter.authorize({ oidcToken: 'oidc.token' })
    ).resolves.toEqual(
      expect.objectContaining({
        authorizationId: 'authorization-1',
        limits: protocolLimits,
        facts: authorizationFacts,
      })
    );
  });

  it('renews authorization without changing its immutable scope', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewRunAuthorizationResultStatus.Renewed,
      authorizationId: authorization.authorizationId,
      authorizationToken: 'authorization.renewed-token',
      mutationEpoch: authorization.mutationEpoch,
      expiresAt: '2026-07-22T14:00:00.000Z',
    });
    const adapter = createAdapter(execute);

    await expect(
      adapter.renewAuthorization({
        authorization,
        idempotencyKey: 'idem:renew:1',
        renewalRequestId: 'renewal-1',
        oidcToken: 'oidc.token',
        requestedTtlMs: 3_900_000,
      })
    ).resolves.toEqual({
      authorization: {
        ...authorization,
        authorizationToken: 'authorization.renewed-token',
        expiresAt: '2026-07-22T14:00:00.000Z',
      },
      validForMsAtResponse: 7_200_000,
    });
    expect(execute).toHaveBeenCalledWith(
      ReviewActionV2OperationId.ReviewRunRenew,
      {
        authorizationToken: authorization.authorizationToken,
        idempotencyKey: 'idem:renew:1',
        authorizationId: authorization.authorizationId,
        renewalRequestId: 'renewal-1',
        oidcToken: 'oidc.token',
        requestedTtlMs: 3_900_000,
      }
    );
  });

  it('rejects mutation epoch drift during authorization renewal', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewRunAuthorizationResultStatus.Renewed,
      authorizationId: authorization.authorizationId,
      authorizationToken: 'authorization.renewed-token',
      mutationEpoch: '2',
      expiresAt: '2026-07-22T14:00:00.000Z',
    });

    await expect(
      createAdapter(execute).renewAuthorization({
        authorization,
        idempotencyKey: 'idem:renew:1',
        renewalRequestId: 'renewal-1',
        oidcToken: 'oidc.token',
        requestedTtlMs: 3_900_000,
      })
    ).rejects.toThrow('review_action_v2_authorization_renew_epoch_mismatch');
  });

  it('rejects authorization scope drift during renewal', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewRunAuthorizationResultStatus.Renewed,
      authorizationId: 'authorization-other',
      authorizationToken: 'authorization.renewed-token',
      mutationEpoch: authorization.mutationEpoch,
      expiresAt: '2026-07-22T14:00:00.000Z',
    });

    await expect(
      createAdapter(execute).renewAuthorization(renewalInput())
    ).rejects.toThrow('review_action_v2_authorization_renew_scope_mismatch');
  });

  it('rejects a non-renewed authorization response', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewRunAuthorizationResultStatus.Denied,
    });

    await expect(
      createAdapter(execute).renewAuthorization(renewalInput())
    ).rejects.toThrow('review_action_v2_authorization_renew_denied');
  });

  it('rejects renewal without positive server-relative validity', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewRunAuthorizationResultStatus.Renewed,
      authorizationId: authorization.authorizationId,
      authorizationToken: 'authorization.renewed-token',
      mutationEpoch: authorization.mutationEpoch,
      expiresAt: '2026-07-22T12:00:00.000Z',
    });

    await expect(
      createAdapter(execute).renewAuthorization(renewalInput())
    ).rejects.toThrow('review_action_v2_authorization_renew_expiry_invalid');
  });

  it('accepts old authorization facts that omit investigation capability', async () => {
    const execute = jest.fn().mockResolvedValue(authorizationResponse());

    await expect(
      createAdapter(execute).authorize({ oidcToken: 'oidc.token' })
    ).resolves.toMatchObject({
      facts: expect.not.objectContaining({
        reviewInvestigation: expect.anything(),
      }),
    });
  });

  it('parses the strict review investigation authorization descriptor V3', async () => {
    const reviewInvestigation = {
      ...investigationExtensionDescriptor,
      authorizationDescriptorVersion:
        reviewInvestigationRolloutAuthorizationV3Contract.authorizationDescriptorVersion,
      capability: ReviewCapabilityKind.ReviewInvestigationV1,
      coverageProfileHash: hash('coverage-profile'),
      policyHash: hash('investigation-policy'),
      providerCapabilities: [
        {
          providerKind: ReviewExecutionProviderKind.Codex,
          capabilities: [
            ReviewInvestigationRolloutCapability.ContextCritic,
            ReviewInvestigationRolloutCapability.Recording,
            ReviewInvestigationRolloutCapability.Shadow,
          ],
        },
      ],
    } as const;
    const execute = jest.fn().mockResolvedValue({
      ...authorizationResponse(),
      authorizationFactsCanonicalJson: canonicalJson({
        ...authorizationFacts,
        reviewInvestigation,
      }),
    });

    await expect(
      createAdapter(execute).authorize({ oidcToken: 'oidc.token' })
    ).resolves.toMatchObject({
      facts: { reviewInvestigation },
    });
  });

  it('ignores a versionless V1 provider allowlist and stays on legacy review', async () => {
    const reviewInvestigation = {
      capability: ReviewCapabilityKind.ReviewInvestigationV1,
      coverageProfileHash: hash('coverage-profile'),
      policyHash: hash('investigation-policy'),
      providerKinds: [ReviewExecutionProviderKind.Codex],
    } as const;
    const execute = jest.fn().mockResolvedValue({
      ...authorizationResponse(),
      authorizationFactsCanonicalJson: canonicalJson({
        ...authorizationFacts,
        reviewInvestigation,
      }),
    });

    await expect(
      createAdapter(execute).authorize({ oidcToken: 'oidc.token' })
    ).resolves.toMatchObject({
      facts: expect.not.objectContaining({
        reviewInvestigation: expect.anything(),
      }),
    });
  });

  it.each([
    {
      name: 'unknown top-level field',
      descriptor: reviewInvestigationDescriptor({ futureField: true }),
    },
    {
      name: 'unsupported provider',
      descriptor: reviewInvestigationDescriptor({
        providerCapabilities: [
          {
            providerKind: ReviewExecutionProviderKind.OpenRouter,
            capabilities: [ReviewInvestigationRolloutCapability.Recording],
          },
        ],
      }),
    },
    {
      name: 'legacy V2 descriptor',
      descriptor: {
        authorizationDescriptorVersion: 2,
        capability: ReviewCapabilityKind.ReviewInvestigationV1,
        coverageProfileHash: hash('coverage-profile'),
        policyHash: hash('investigation-policy'),
        providerCapabilities: [
          {
            providerKind: ReviewExecutionProviderKind.Codex,
            capabilities: [ReviewInvestigationRolloutCapability.Recording],
          },
        ],
      },
    },
    {
      name: 'missing extension tuple',
      descriptor: {
        authorizationDescriptorVersion:
          reviewInvestigationRolloutAuthorizationV3Contract.authorizationDescriptorVersion,
        capability: ReviewCapabilityKind.ReviewInvestigationV1,
        coverageProfileHash: hash('coverage-profile'),
        policyHash: hash('investigation-policy'),
        providerCapabilities: [
          {
            providerKind: ReviewExecutionProviderKind.Codex,
            capabilities: [ReviewInvestigationRolloutCapability.Recording],
          },
        ],
      },
    },
    ...(
      [
        ['extensionId', 'review-investigation-shadow.future'],
        ['extensionSchemaDigest', hash('wrong-extension-schema')],
        ['extensionCanonicalizerDigest', hash('wrong-extension-canonicalizer')],
      ] as const
    ).map(([field, value]) => ({
      name: `${field} mismatch`,
      descriptor: reviewInvestigationDescriptor({ [field]: value }),
    })),
    {
      name: 'empty provider rows',
      descriptor: reviewInvestigationDescriptor({
        providerCapabilities: [],
      }),
    },
    {
      name: 'duplicate provider rows',
      descriptor: reviewInvestigationDescriptor({
        providerCapabilities: [
          {
            providerKind: ReviewExecutionProviderKind.Codex,
            capabilities: [ReviewInvestigationRolloutCapability.Recording],
          },
          {
            providerKind: ReviewExecutionProviderKind.Codex,
            capabilities: [ReviewInvestigationRolloutCapability.Recording],
          },
        ],
      }),
    },
    {
      name: 'unsorted capabilities',
      descriptor: reviewInvestigationDescriptor({
        providerCapabilities: [
          {
            providerKind: ReviewExecutionProviderKind.Codex,
            capabilities: [
              ReviewInvestigationRolloutCapability.Shadow,
              ReviewInvestigationRolloutCapability.Recording,
            ],
          },
        ],
      }),
    },
    {
      name: 'duplicate capabilities',
      descriptor: reviewInvestigationDescriptor({
        providerCapabilities: [
          {
            providerKind: ReviewExecutionProviderKind.Codex,
            capabilities: [
              ReviewInvestigationRolloutCapability.Recording,
              ReviewInvestigationRolloutCapability.Recording,
            ],
          },
        ],
      }),
    },
    {
      name: 'unknown capability',
      descriptor: reviewInvestigationDescriptor({
        providerCapabilities: [
          {
            providerKind: ReviewExecutionProviderKind.Codex,
            capabilities: [
              'future_capability',
              ReviewInvestigationRolloutCapability.Recording,
            ],
          },
        ],
      }),
    },
    {
      name: 'dependency gap',
      descriptor: reviewInvestigationDescriptor({
        providerCapabilities: [
          {
            providerKind: ReviewExecutionProviderKind.Codex,
            capabilities: [
              ReviewInvestigationRolloutCapability.ContextCritic,
              ReviewInvestigationRolloutCapability.Recording,
            ],
          },
        ],
      }),
    },
    {
      name: 'row without recording authority',
      descriptor: reviewInvestigationDescriptor({
        providerCapabilities: [
          {
            providerKind: ReviewExecutionProviderKind.Codex,
            capabilities: [],
          },
        ],
      }),
    },
    {
      name: 'unknown provider-row field',
      descriptor: reviewInvestigationDescriptor({
        providerCapabilities: [
          {
            providerKind: ReviewExecutionProviderKind.Codex,
            capabilities: [ReviewInvestigationRolloutCapability.Recording],
            futureField: true,
          },
        ],
      }),
    },
    {
      name: 'invalid coverage profile hash',
      descriptor: reviewInvestigationDescriptor({
        coverageProfileHash: 'not-a-hash',
      }),
    },
  ])(
    'ignores an invalid optional descriptor with $name',
    async ({ descriptor }) => {
      const execute = jest.fn().mockResolvedValue({
        ...authorizationResponse(),
        authorizationFactsCanonicalJson: canonicalJson({
          ...authorizationFacts,
          reviewInvestigation: descriptor,
        }),
      });

      const result = await createAdapter(execute).authorize({
        oidcToken: 'oidc.token',
      });

      expect(result.facts).toMatchObject(authorizationFacts);
      expect(result.facts.reviewInvestigation).toBeUndefined();
    }
  );

  it('ignores unsorted provider rows while preserving base authorization', async () => {
    const providerVoteLanes = [
      {
        providerKind: ReviewExecutionProviderKind.ClaudeCode,
        providerVoteIdentityHash: '7'.repeat(64),
      },
      ...authorizationFacts.providerVoteLanes,
    ];
    const execute = jest.fn().mockResolvedValue({
      ...authorizationResponse(),
      authorizationFactsCanonicalJson: canonicalJson({
        ...authorizationFacts,
        providerVoteLanes,
        reviewInvestigation: reviewInvestigationDescriptor({
          providerCapabilities: [
            {
              providerKind: ReviewExecutionProviderKind.Codex,
              capabilities: [ReviewInvestigationRolloutCapability.Recording],
            },
            {
              providerKind: ReviewExecutionProviderKind.ClaudeCode,
              capabilities: [ReviewInvestigationRolloutCapability.Recording],
            },
          ],
        }),
      }),
    });

    const result = await createAdapter(execute).authorize({
      oidcToken: 'oidc.token',
    });

    expect(result.facts.providerVoteLanes).toEqual(providerVoteLanes);
    expect(result.facts.reviewInvestigation).toBeUndefined();
  });

  it('ignores a provider row without an authorized lane', async () => {
    const execute = jest.fn().mockResolvedValue({
      ...authorizationResponse(),
      authorizationFactsCanonicalJson: canonicalJson({
        ...authorizationFacts,
        reviewInvestigation: reviewInvestigationDescriptor({
          providerCapabilities: [
            {
              providerKind: ReviewExecutionProviderKind.ClaudeCode,
              capabilities: [ReviewInvestigationRolloutCapability.Recording],
            },
          ],
        }),
      }),
    });

    const result = await createAdapter(execute).authorize({
      oidcToken: 'oidc.token',
    });

    expect(result.facts.reviewInvestigation).toBeUndefined();
  });

  it.each(['superseded_no_effect', 'failed_no_effect'])(
    'maps terminal server outcome %s to publication not applied',
    async (terminalOutcome) => {
      const execute = jest.fn().mockResolvedValue({
        status: ReviewPublicationStatusResultStatus.Terminal,
        publicationAttemptId: 'publication-1',
        terminalOutcome,
        canonicalReceiptSetHash: null,
        pollAfterMs: null,
      });

      await expect(
        createAdapter(execute).readPublicationStatus({
          authorization,
          publicationAttemptId: 'publication-1',
          timeoutMs: 1_000,
        })
      ).resolves.toEqual({
        terminal: true,
        outcome: { state: ReviewPublicationState.NotApplied },
      });
    }
  );

  it('rejects an unknown terminal publication outcome', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewPublicationStatusResultStatus.Terminal,
      publicationAttemptId: 'publication-1',
      terminalOutcome: 'future_unknown_outcome',
      canonicalReceiptSetHash: null,
      pollAfterMs: null,
    });

    await expect(
      createAdapter(execute).readPublicationStatus({
        authorization,
        publicationAttemptId: 'publication-1',
        timeoutMs: 1_000,
      })
    ).rejects.toThrow('review_action_v2_publication_outcome_unknown');
  });

  it('treats a supersede target revision mismatch as a benign stale race', async () => {
    const execute = jest.fn().mockRejectedValue(
      new ReviewActionV2ClientError(
        ReviewActionV2ClientFailureCode.ProtocolError,
        ReviewActionV2OperationId.ReviewExecutionSupersede,
        {
          httpStatus: 403,
          protocolErrorCode: ReviewActionV2ProtocolErrorCode.Forbidden,
          issues: ['target_revision_mismatch'],
        }
      )
    );

    await expect(
      createAdapter(execute).supersedeExecution({
        authorization,
        idempotencyKey: 'supersede-key',
        execution,
        targetRevisionHash: hash('new-revision'),
      })
    ).resolves.toBeUndefined();
  });

  it('opens and seals a target-bound context gateway session', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce(authorizationResponse())
      .mockResolvedValueOnce({
        status: ReviewContextGatewayOpenResultStatus.Opened,
        sessionId: 'session-1',
        eventChainSeedHash: hash('seed'),
        gatewaySessionSecret: Buffer.alloc(32, 1).toString('base64url'),
        sealCapability: 'seal.capability',
        expiresAt: '2026-07-22T12:05:00.000Z',
      })
      .mockResolvedValueOnce({
        status: ReviewContextGatewaySealResultStatus.Accepted,
        attestationId: 'attestation-1',
        attestationHash: hash('attestation'),
      });
    const adapter = createAdapter(execute);
    await adapter.authorize({ oidcToken: 'oidc.token' });

    const session = await adapter.openGatewaySession({
      invocationLease: baseLease,
      sourceExecutionId: execution.executionId,
      sourceWorkSlotId: workSlot.workSlotId,
      sourceReviewRevisionHash: authorization.facts.reviewRevisionHash,
      checkoutTreeOid: '7'.repeat(40),
      gatewayPolicyVersion: 'context-gateway-v2',
      gatewayBinaryHash: hash('gateway'),
      confinementEvidenceHash: hash('confinement'),
    });
    await expect(
      adapter.sealGatewaySession({
        invocationLease: baseLease,
        session,
        providerSucceeded: true,
        schemaValidated: true,
        fullyConsumed: true,
        actualModel: 'gpt-5.6-sol',
        terminalOutcomeHash: hash('outcome'),
        transcriptCanonicalJson: '{"transcriptVersion":1}',
        transcriptHash: hash('{"transcriptVersion":1}'),
        replayMaterialCanonicalJson: '{"replayMaterialVersion":1}',
        replayMaterialHash: hash('{"replayMaterialVersion":1}'),
      })
    ).resolves.toEqual({
      attestationId: 'attestation-1',
      attestationHash: hash('attestation'),
    });
    expect(execute).toHaveBeenNthCalledWith(
      2,
      ReviewActionV2OperationId.ReviewContextGatewayOpen,
      expect.objectContaining({
        leaseCapability: baseLease.leaseCapability,
        sourceExecutionId: execution.executionId,
      })
    );
  });

  it('translates context open policy mismatches into a safe actionable code', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce(authorizationResponse())
      .mockRejectedValueOnce(
        new ReviewActionV2ClientError(
          ReviewActionV2ClientFailureCode.ProtocolError,
          ReviewActionV2OperationId.ReviewContextGatewayOpen,
          {
            httpStatus: 412,
            protocolErrorCode:
              ReviewActionV2ProtocolErrorCode.StalePrecondition,
            retryClass: ReviewActionV2RetryClass.Never,
            issues: ['context_gateway_policy_mismatch'],
          }
        )
      );
    const adapter = createAdapter(execute);
    await adapter.authorize({ oidcToken: 'oidc.token' });

    await expect(
      adapter.openGatewaySession({
        invocationLease: baseLease,
        sourceExecutionId: execution.executionId,
        sourceWorkSlotId: workSlot.workSlotId,
        sourceReviewRevisionHash: authorization.facts.reviewRevisionHash,
        checkoutTreeOid: '7'.repeat(40),
        gatewayPolicyVersion: 'context-gateway-v3',
        gatewayBinaryHash: hash('gateway'),
        confinementEvidenceHash: hash('confinement'),
      })
    ).rejects.toMatchObject({
      name: ReviewInvocationConfigurationMismatchError.name,
      message:
        'review_invocation_configuration_mismatch:context_gateway_policy_mismatch',
      reason:
        ReviewInvocationConfigurationMismatchReason.ContextGatewayPolicyMismatch,
    });
  });

  it('keeps unrelated context open preconditions generic', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce(authorizationResponse())
      .mockRejectedValueOnce(
        new ReviewActionV2ClientError(
          ReviewActionV2ClientFailureCode.ProtocolError,
          ReviewActionV2OperationId.ReviewContextGatewayOpen,
          {
            httpStatus: 412,
            protocolErrorCode:
              ReviewActionV2ProtocolErrorCode.StalePrecondition,
            retryClass: ReviewActionV2RetryClass.Never,
            issues: ['unrelated_gateway_precondition'],
          }
        )
      );
    const adapter = createAdapter(execute);
    await adapter.authorize({ oidcToken: 'oidc.token' });

    await expect(
      adapter.openGatewaySession({
        invocationLease: baseLease,
        sourceExecutionId: execution.executionId,
        sourceWorkSlotId: workSlot.workSlotId,
        sourceReviewRevisionHash: authorization.facts.reviewRevisionHash,
        checkoutTreeOid: '7'.repeat(40),
        gatewayPolicyVersion: 'context-gateway-v3',
        gatewayBinaryHash: hash('gateway'),
        confinementEvidenceHash: hash('confinement'),
      })
    ).rejects.toMatchObject({
      name: 'Error',
      message:
        'review_action_v2:review_context_gateway_open:stale_precondition',
    });
  });

  it('translates context seal protocol failures into safe actionable codes', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce(authorizationResponse())
      .mockRejectedValueOnce(
        new ReviewActionV2ClientError(
          ReviewActionV2ClientFailureCode.ProtocolError,
          ReviewActionV2OperationId.ReviewContextGatewaySeal,
          {
            httpStatus: 422,
            protocolErrorCode: ReviewActionV2ProtocolErrorCode.InvalidRequest,
            issues: ['context_actual_model_mismatch'],
          }
        )
      );
    const adapter = createAdapter(execute);
    await adapter.authorize({ oidcToken: 'oidc.token' });

    await expect(
      adapter.sealGatewaySession({
        invocationLease: baseLease,
        session: {
          sessionId: 'session-1',
          eventChainSeedHash: hash('seed'),
          gatewaySessionSecret: Buffer.alloc(32, 1).toString('base64url'),
          sealCapability: 'seal.capability',
          expiresAt: '2026-07-22T12:05:00.000Z',
        },
        providerSucceeded: true,
        schemaValidated: true,
        fullyConsumed: true,
        actualModel: 'gpt-5.6-sol',
        terminalOutcomeHash: hash('outcome'),
        transcriptCanonicalJson: '{"transcriptVersion":1}',
        transcriptHash: hash('{"transcriptVersion":1}'),
        replayMaterialCanonicalJson: '{"replayMaterialVersion":1}',
        replayMaterialHash: hash('{"replayMaterialVersion":1}'),
      })
    ).rejects.toThrow(
      'review_action_v2:review_context_gateway_seal:invalid_request:context_actual_model_mismatch'
    );
  });

  it('parses replay-required evidence and commits its target proof', async () => {
    const payloadCanonicalJson = canonicalJson({ findings: [] });
    const replayPlanCanonicalJson = canonicalJson({ planVersion: 1 });
    const execute = jest
      .fn()
      .mockResolvedValueOnce({
        status: ReviewEvidenceLookupResultStatus.ReplayRequired,
        observationId: 'observation-1',
        payloadCanonicalJson,
        payloadHash: hash(payloadCanonicalJson),
        byteCount: Buffer.byteLength(payloadCanonicalJson),
        findingCount: 0,
        actualModel: 'gpt-5.6-sol',
        qualityFlags: [],
        transportAttemptCount: 1,
        eligibilityPolicyVersion: 't2-v1',
        contextDependencyAttestationId: 'attestation-1',
        contextDependencyAttestationHash: hash('attestation'),
        contextReplayCapability: 'replay.capability',
        contextReplayPlanCanonicalJson: replayPlanCanonicalJson,
        contextReplayPlanHash: hash(replayPlanCanonicalJson),
      })
      .mockResolvedValueOnce({
        status: ReviewContextReplayCommitResultStatus.Accepted,
        replayProofId: 'proof-1',
        replayProofHash: hash('proof'),
        attachmentCapability: 'attachment.capability',
      });
    const adapter = createAdapter(execute);
    const candidate = await adapter.lookupEvidence({
      authorization,
      execution,
      workSlot,
      planHash: execution.restoredExecution.planHash,
      manifest: providerManifest,
    });
    expect(candidate).toMatchObject({
      kind: ReviewEvidenceLookupKind.ReplayRequired,
      attestationId: 'attestation-1',
      replayPlanHash: hash(replayPlanCanonicalJson),
    });
    if (candidate.kind !== ReviewEvidenceLookupKind.ReplayRequired) {
      throw new Error('expected replay candidate');
    }

    await expect(
      adapter.commitContextReplay({
        authorization,
        execution,
        workSlot,
        candidate,
        result: {
          targetCheckoutTreeOid: '8'.repeat(40),
          replayResultCanonicalJson: '{"manifestVersion":2}',
          replayResultHash: hash('{"manifestVersion":2}'),
        },
      })
    ).resolves.toEqual({
      attachmentCapability: 'attachment.capability',
    });
  });

  it('uses the generated execution version needed by finalize', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewExecutionStartResultStatus.Admitted,
      executionId: 'execution-1',
      generation: '1',
      streamVersion: '1',
      executionVersion: '2',
      executionCanonicalJson: canonicalExecution({ version: '2' }),
    });
    const adapter = createAdapter(execute);

    await expect(adapter.startExecution(startInput)).resolves.toEqual(
      expect.objectContaining({
        executionId: 'execution-1',
        generation: '1',
        streamVersion: '1',
        executionVersion: '2',
        restoredExecution: expect.objectContaining({
          planHash: startInput.planHash,
          workSlots: [expect.objectContaining({ workSlotId: 'slot-1' })],
        }),
      })
    );
  });

  it('consumes a lookup hit payload and its attachment capability', async () => {
    const payloadCanonicalJson = canonicalJson({ findings: [] });
    const execute = jest.fn().mockResolvedValue({
      status: ReviewEvidenceLookupResultStatus.Hit,
      observationId: 'observation-1',
      payloadCanonicalJson,
      payloadHash: hash(payloadCanonicalJson),
      byteCount: Buffer.byteLength(payloadCanonicalJson),
      findingCount: 0,
      actualModel: 'gpt-test',
      qualityFlags: [],
      transportAttemptCount: 1,
      attachmentCapability: 'attachment.capability',
      attachmentKind: 'exact_revision_reuse',
      reuseSafetyDecisionHash: hash('reuse-safety'),
      eligibilityPolicyVersion: 't0-v1',
    });
    const adapter = createAdapter(execute);

    await expect(
      adapter.lookupEvidence({
        authorization,
        execution,
        workSlot,
        planHash: '2'.repeat(64),
        manifest: {
          manifestCanonicalJson: '{"fixture":true}',
          manifestKey: '3'.repeat(64),
          providerInvocationKey: '4'.repeat(64),
          providerVoteIdentityHash: workSlot.providerVoteIdentityHash,
        },
      })
    ).resolves.toEqual(
      expect.objectContaining({
        kind: ReviewEvidenceLookupKind.Hit,
        attachment: expect.objectContaining({
          kind: 'exact_revision_reuse',
          capability: 'attachment.capability',
        }),
        observation: expect.objectContaining({
          payloadCanonicalJson,
          payloadHash: hash(payloadCanonicalJson),
        }),
      })
    );
  });

  it('logs only bounded evidence lookup identities and denial reasons', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewEvidenceLookupResultStatus.Miss,
      denialReasons: ['manifest_mismatch'],
    });
    const infoSpy = jest
      .spyOn(logger, 'info')
      .mockImplementation(() => undefined);

    try {
      await expect(
        createAdapter(execute).lookupEvidence({
          authorization,
          execution,
          workSlot,
          planHash: execution.restoredExecution.planHash,
          manifest: providerManifest,
        })
      ).resolves.toEqual({ kind: ReviewEvidenceLookupKind.Miss });

      expect(infoSpy).toHaveBeenCalledWith(
        `Review evidence lookup: status=miss, manifest=${providerManifest.manifestKey.slice(
          0,
          12
        )}, invocation=${providerManifest.providerInvocationKey.slice(
          0,
          12
        )}, reasons=manifest_mismatch`
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('turns a fenced same-execution shadow into adoptable evidence', async () => {
    const payloadCanonicalJson = canonicalJson({ findings: [] });
    const execute = jest.fn().mockResolvedValue({
      status: ReviewEvidenceLookupResultStatus.Shadow,
      observationId: 'observation-1',
      payloadCanonicalJson,
      payloadHash: hash(payloadCanonicalJson),
      byteCount: Buffer.byteLength(payloadCanonicalJson),
      findingCount: 0,
      actualModel: 'gpt-test',
      qualityFlags: [],
      transportAttemptCount: 1,
      attachmentCapability: null,
      attachmentKind: null,
      reuseSafetyDecisionHash: null,
      eligibilityPolicyVersion: 't0-v1',
      sourceLeaseId: baseLease.leaseId,
      sourceFencingToken: baseLease.fencingToken,
      sourceOwnerIdHash: hash('owner'),
    });

    await expect(
      createAdapter(execute).lookupEvidence({
        authorization,
        execution,
        workSlot,
        planHash: execution.restoredExecution.planHash,
        manifest: providerManifest,
      })
    ).resolves.toMatchObject({
      kind: ReviewEvidenceLookupKind.Hit,
      attachment: {
        kind: 'same_execution',
        sourceLeaseId: baseLease.leaseId,
        sourceFencingToken: baseLease.fencingToken,
        sourceOwnerIdHash: hash('owner'),
      },
    });
  });

  it('rejects a partial same-execution adoption source tuple', async () => {
    const payloadCanonicalJson = canonicalJson({ findings: [] });
    const execute = jest.fn().mockResolvedValue({
      status: ReviewEvidenceLookupResultStatus.Shadow,
      observationId: 'observation-1',
      payloadCanonicalJson,
      payloadHash: hash(payloadCanonicalJson),
      byteCount: Buffer.byteLength(payloadCanonicalJson),
      findingCount: 0,
      actualModel: 'gpt-test',
      qualityFlags: [],
      transportAttemptCount: 1,
      eligibilityPolicyVersion: 't0-v1',
      sourceLeaseId: baseLease.leaseId,
      sourceFencingToken: null,
      sourceOwnerIdHash: hash('owner'),
    });

    await expect(
      createAdapter(execute).lookupEvidence({
        authorization,
        execution,
        workSlot,
        planHash: execution.restoredExecution.planHash,
        manifest: providerManifest,
      })
    ).rejects.toThrow('review_action_v2_source_fencing_token_missing');
  });

  it('restores a bounded exact-revision execution instead of dropping it', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewExecutionRestoreResultStatus.Found,
      executionId: 'execution-1',
      generation: '1',
      streamVersion: '1',
      executionState: RestoredReviewExecutionState.Running,
      executionCanonicalJson: canonicalExecution(),
    });
    const adapter = createAdapter(execute);

    await expect(
      adapter.restoreExecution({
        authorization,
        reviewRevisionHash: startInput.reviewRevisionHash,
      })
    ).resolves.toMatchObject({
      executionId: 'execution-1',
      reviewRevisionHash: startInput.reviewRevisionHash,
      planHash: startInput.planHash,
    });
  });

  it('rejects restored slot and observation identity drift', async () => {
    const malformed = JSON.parse(canonicalExecution()) as Record<
      string,
      unknown
    >;
    malformed.workSlots = [
      {
        acceptedObservationRefId: 'observation-1',
        activeLeaseId: null,
        providerVoteIdentityHash: workSlot.providerVoteIdentityHash,
        required: true,
        state: RestoredReviewWorkSlotState.Satisfied,
        workSlotId: workSlot.workSlotId,
      },
    ];
    const execute = jest.fn().mockResolvedValue({
      status: ReviewExecutionStartResultStatus.Restored,
      executionId: 'execution-1',
      generation: '1',
      streamVersion: '2',
      executionVersion: '1',
      executionCanonicalJson: canonicalJson(malformed),
    });

    await expect(
      createAdapter(execute).startExecution(startInput)
    ).rejects.toThrow('review_action_v2_restored_work_slot_state_invalid');
  });

  it('maps an acquired invocation lease to a typed acquire outcome', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewInvocationLeaseResultStatus.Acquired,
      leaseId: baseLease.leaseId,
      attemptId: baseLease.attemptId,
      fencingToken: baseLease.fencingToken,
      expiresAt: baseLease.expiresAt,
      resultReportUntil: baseLease.resultReportUntil,
      leaseCapability: baseLease.leaseCapability,
    });

    await expect(
      createAdapter(execute).acquireInvocationLease(leaseAcquireInput())
    ).resolves.toEqual({
      status: ReviewInvocationLeaseAcquireOutcomeStatus.Acquired,
      lease: baseLease,
    });
  });

  it('maps an exhausted invocation budget rejection without throwing', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewInvocationLeaseResultStatus.Rejected,
      rejectionReason: 'attempt_budget_exhausted',
    });

    await expect(
      createAdapter(execute).acquireInvocationLease(leaseAcquireInput())
    ).resolves.toEqual({
      status: ReviewInvocationLeaseAcquireOutcomeStatus.AttemptBudgetExhausted,
    });
  });

  it('fails closed on an ambiguous invocation lease rejection', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewInvocationLeaseResultStatus.Rejected,
      rejectionReason: 'idempotency_conflict',
    });

    await expect(
      createAdapter(execute).acquireInvocationLease(leaseAcquireInput())
    ).rejects.toThrow('review_action_v2_lease_rejected:idempotency_conflict');
  });

  it('preserves the lease identity and accepts the rotated capability', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewInvocationLeaseResultStatus.Applied,
      leaseId: baseLease.leaseId,
      fencingToken: baseLease.fencingToken,
      expiresAt: '2026-07-22T12:11:00.000Z',
      leaseCapability: 'lease.capability.renewed',
    });

    await expect(
      createAdapter(execute).renewInvocationLease({
        idempotencyKey: 'idem:renew:1',
        lease: baseLease,
        ownerIdHash: hash('owner'),
        renewRequestId: 'renew-1',
      })
    ).resolves.toEqual({
      ...baseLease,
      leaseCapability: 'lease.capability.renewed',
      expiresAt: '2026-07-22T12:11:00.000Z',
    });
  });

  it('accepts an idempotent renewal at the fixed lease ceiling', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewInvocationLeaseResultStatus.Restored,
      leaseId: baseLease.leaseId,
      fencingToken: baseLease.fencingToken,
      expiresAt: baseLease.expiresAt,
      leaseCapability: baseLease.leaseCapability,
    });

    await expect(
      createAdapter(execute).renewInvocationLease({
        idempotencyKey: 'idem:renew:ceiling',
        lease: baseLease,
        ownerIdHash: hash('owner'),
        renewRequestId: 'renew-ceiling',
      })
    ).resolves.toEqual({
      ...baseLease,
      renewalCeilingReached: true,
    });
  });

  it('recovers a lost renewal acknowledgement that advanced the lease', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewInvocationLeaseResultStatus.Restored,
      leaseId: baseLease.leaseId,
      fencingToken: baseLease.fencingToken,
      expiresAt: '2026-07-22T12:11:00.000Z',
      leaseCapability: 'lease.capability.recovered',
    });

    await expect(
      createAdapter(execute).renewInvocationLease({
        idempotencyKey: 'idem:renew:recovered',
        lease: baseLease,
        ownerIdHash: hash('owner'),
        renewRequestId: 'renew-recovered',
      })
    ).resolves.toEqual({
      ...baseLease,
      leaseCapability: 'lease.capability.recovered',
      expiresAt: '2026-07-22T12:11:00.000Z',
      renewalCeilingReached: false,
    });
  });

  it('rejects an acquire response on the renewal operation', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewInvocationLeaseResultStatus.Acquired,
      leaseId: baseLease.leaseId,
      fencingToken: baseLease.fencingToken,
      expiresAt: '2026-07-22T12:11:00.000Z',
      leaseCapability: 'lease.capability.renewed',
    });

    await expect(
      createAdapter(execute).renewInvocationLease({
        idempotencyKey: 'idem:renew:acquired',
        lease: baseLease,
        ownerIdHash: hash('owner'),
        renewRequestId: 'renew-acquired',
      })
    ).rejects.toThrow('review_action_v2_lease_renew_acquired');
  });

  it('requires a rotated capability when renewal is applied', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewInvocationLeaseResultStatus.Applied,
      leaseId: baseLease.leaseId,
      fencingToken: baseLease.fencingToken,
      expiresAt: '2026-07-22T12:11:00.000Z',
      leaseCapability: baseLease.leaseCapability,
    });

    await expect(
      createAdapter(execute).renewInvocationLease({
        idempotencyKey: 'idem:renew:not-rotated',
        lease: baseLease,
        ownerIdHash: hash('owner'),
        renewRequestId: 'renew-not-rotated',
      })
    ).rejects.toThrow('review_action_v2_lease_renewal_drift');
  });

  it('rejects renewal without a replacement capability', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewInvocationLeaseResultStatus.Applied,
      leaseId: baseLease.leaseId,
      fencingToken: baseLease.fencingToken,
      expiresAt: '2026-07-22T12:11:00.000Z',
    });

    await expect(
      createAdapter(execute).renewInvocationLease({
        idempotencyKey: 'idem:renew:1',
        lease: baseLease,
        ownerIdHash: hash('owner'),
        renewRequestId: 'renew-1',
      })
    ).rejects.toThrow('review_action_v2_lease_renew_capability_missing');
  });

  it('rejects a changed fencing term as takeover, not renewal', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewInvocationLeaseResultStatus.Applied,
      leaseId: baseLease.leaseId,
      fencingToken: '2',
      expiresAt: '2026-07-22T12:11:00.000Z',
      leaseCapability: 'lease.capability.renewed',
    });

    await expect(
      createAdapter(execute).renewInvocationLease({
        idempotencyKey: 'idem:renew:1',
        lease: baseLease,
        ownerIdHash: hash('owner'),
        renewRequestId: 'renew-1',
      })
    ).rejects.toThrow('review_action_v2_lease_renewal_drift');
  });

  it('treats an omitted historicalOnly flag on a fresh commit as current', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewEvidenceCommitResultStatus.Accepted,
      observationId: 'observation-1',
      eligibilityPolicyVersion: 't0-v1',
    });
    const adapter = createAdapter(execute);

    await expect(
      adapter.commitEvidence({
        authorization,
        idempotencyKey: 'idem:commit:1',
        lease: {
          leaseId: 'lease-1',
          attemptId: 'attempt-1',
          leaseCapability: 'lease.capability',
          fencingToken: '1',
          expiresAt: '2026-07-22T12:10:00.000Z',
          resultReportUntil: '2026-07-22T12:20:00.000Z',
          renewalCeilingReached: false,
        },
        ownerIdHash: '7'.repeat(64),
        observation: {
          payloadCanonicalJson: '{"findings":[]}',
          payloadHash: hash('{"findings":[]}'),
          byteCount: 15,
          findingCount: 0,
          actualModel: 'gpt-test',
          qualityFlags: [],
          transportAttemptCount: 1,
          schemaValidated: true,
          fullyConsumed: true,
        },
      })
    ).resolves.toMatchObject({ historicalOnly: false });
    expect(execute).toHaveBeenCalledWith(
      ReviewActionV2OperationId.ReviewEvidenceCommit,
      expect.objectContaining({
        completionStatus: 'success',
        contextDependencyAttestationId: null,
        contextDependencyAttestationHash: null,
      })
    );
  });

  it('commits the context attestation identity as an exact pair', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewEvidenceCommitResultStatus.Accepted,
      observationId: 'observation-1',
      eligibilityPolicyVersion: 't0-v1',
    });
    const attestationId = 'attestation-1';
    const attestationHash = hash('attestation');

    await createAdapter(execute).commitEvidence({
      authorization,
      idempotencyKey: 'idem:commit:attested',
      lease: baseLease,
      ownerIdHash: hash('owner'),
      observation: {
        payloadCanonicalJson: '{"findings":[]}',
        payloadHash: hash('{"findings":[]}'),
        byteCount: 15,
        findingCount: 0,
        actualModel: 'gpt-test',
        qualityFlags: [],
        transportAttemptCount: 1,
        schemaValidated: true,
        fullyConsumed: true,
        contextDependencyAttestationId: attestationId,
        contextDependencyAttestationHash: attestationHash,
      },
    });

    expect(execute).toHaveBeenCalledWith(
      ReviewActionV2OperationId.ReviewEvidenceCommit,
      expect.objectContaining({
        contextDependencyAttestationId: attestationId,
        contextDependencyAttestationHash: attestationHash,
      })
    );
  });

  it('translates evidence protocol failures into safe actionable codes', async () => {
    const execute = jest.fn().mockRejectedValue(
      new ReviewActionV2ClientError(
        ReviewActionV2ClientFailureCode.ProtocolError,
        ReviewActionV2OperationId.ReviewEvidenceCommit,
        {
          httpStatus: 422,
          protocolErrorCode: ReviewActionV2ProtocolErrorCode.InvalidRequest,
          issues: ['payload_hash_mismatch'],
        }
      )
    );

    await expect(
      createAdapter(execute).commitEvidence({
        authorization,
        idempotencyKey: 'idem:commit:diagnostic',
        lease: baseLease,
        ownerIdHash: hash('owner'),
        observation: {
          payloadCanonicalJson: '{"findings":[]}',
          payloadHash: hash('{"findings":[]}'),
          byteCount: 15,
          findingCount: 0,
          actualModel: 'gpt-test',
          qualityFlags: [],
          transportAttemptCount: 1,
          schemaValidated: true,
          fullyConsumed: true,
        },
      })
    ).rejects.toThrow(
      'review_action_v2:review_evidence_commit:invalid_request:payload_hash_mismatch'
    );
  });

  it.each([
    [
      'investigation_certificate_reference_invalid',
      ReviewEvidenceCommitRejectionReason.InvestigationCertificateReferenceInvalid,
    ],
    ['future_server_reason', ReviewEvidenceCommitRejectionReason.Unknown],
    [null, ReviewEvidenceCommitRejectionReason.Unknown],
  ])(
    'preserves a bounded evidence rejection reason for %s',
    async (rejectionReason, expectedReason) => {
      const execute = jest.fn().mockResolvedValue({
        status: ReviewEvidenceCommitResultStatus.Rejected,
        observationId: null,
        eligibilityPolicyVersion: null,
        historicalOnly: false,
        rejectionReason,
      });

      await expect(
        createAdapter(execute).commitEvidence({
          authorization,
          idempotencyKey: 'idem:commit:rejected',
          lease: baseLease,
          ownerIdHash: hash('owner'),
          observation: {
            payloadCanonicalJson: '{"findings":[]}',
            payloadHash: hash('{"findings":[]}'),
            byteCount: 15,
            findingCount: 0,
            actualModel: 'gpt-test',
            qualityFlags: [],
            transportAttemptCount: 1,
            schemaValidated: true,
            fullyConsumed: true,
          },
        })
      ).rejects.toEqual(
        expect.objectContaining<Partial<ReviewEvidenceCommitRejectedError>>({
          name: 'ReviewEvidenceCommitRejectedError',
          reason: expectedReason,
          message: `review_evidence_commit_rejected:${expectedReason}`,
        })
      );
    }
  );

  it('translates finalize protocol failures into safe actionable codes', async () => {
    const execute = jest.fn().mockRejectedValue(
      new ReviewActionV2ClientError(
        ReviewActionV2ClientFailureCode.ProtocolError,
        ReviewActionV2OperationId.ReviewExecutionFinalize,
        {
          httpStatus: 422,
          protocolErrorCode: ReviewActionV2ProtocolErrorCode.InvariantViolation,
          issues: ['artifact_hash_mismatch'],
        }
      )
    );
    const projectionEnvelopeCanonicalJson = '{"findings":[]}';

    await expect(
      createAdapter(execute).finalizeExecution({
        authorization,
        idempotencyKey: 'idem:finalize:diagnostic',
        execution,
        projection: {
          artifactId: 'artifact-1',
          artifactHash: hash('artifact'),
          projectionEnvelopeVersion: 1,
          projectionEnvelopeCanonicalJson,
          projectionHash: hash(projectionEnvelopeCanonicalJson),
          lifecycleStateHash: hash('lifecycle'),
          commandLedgerWatermark: '0',
          operationsCanonicalJson: '[]',
          findingCount: 0,
          publicationOperationCount: 0,
          publicationChunkCount: 0,
          coverageComplete: true,
          mergeGateConclusion: MergeGateConclusion.Pass,
        },
        allowPartial: false,
      })
    ).rejects.toThrow(
      'review_action_v2:review_execution_finalize:invariant_violation:artifact_hash_mismatch'
    );
  });

  it('translates publication request failures into safe actionable codes', async () => {
    const execute = jest.fn().mockRejectedValue(
      new ReviewActionV2ClientError(
        ReviewActionV2ClientFailureCode.ProtocolError,
        ReviewActionV2OperationId.ReviewPublicationRequest,
        {
          httpStatus: 403,
          protocolErrorCode: ReviewActionV2ProtocolErrorCode.Forbidden,
          issues: ['publication_permit_authority_mismatch'],
        }
      )
    );

    await expect(
      createAdapter(execute).requestPublication({
        authorization,
        idempotencyKey: 'idem:publication:diagnostic',
        publicationPermit: 'publication-permit',
        projection: {
          artifactId: 'artifact-1',
          artifactHash: hash('artifact'),
          projectionEnvelopeVersion: 1,
          projectionEnvelopeCanonicalJson: '{"findings":[]}',
          projectionHash: hash('projection'),
          lifecycleStateHash: hash('lifecycle'),
          commandLedgerWatermark: '0',
          operationsCanonicalJson: '[]',
          findingCount: 0,
          publicationOperationCount: 0,
          publicationChunkCount: 0,
          coverageComplete: true,
          mergeGateConclusion: MergeGateConclusion.Pass,
        },
      })
    ).rejects.toThrow(
      'review_action_v2:review_publication_request:forbidden:publication_permit_authority_mismatch'
    );
  });

  it('maps publication request conflicts to a typed non-applied outcome', async () => {
    const execute = jest.fn().mockResolvedValue({
      status: ReviewPublicationRequestResultStatus.Conflict,
      publicationAttemptId: null,
      publicationState: null,
      pollAfterMs: null,
    });

    await expect(
      createAdapter(execute).requestPublication({
        authorization,
        idempotencyKey: 'idem:publication:conflict',
        publicationPermit: 'publication-permit',
        projection: {
          artifactId: 'artifact-1',
          artifactHash: hash('artifact'),
          projectionEnvelopeVersion: 1,
          projectionEnvelopeCanonicalJson: '{"findings":[]}',
          projectionHash: hash('projection'),
          lifecycleStateHash: hash('lifecycle'),
          commandLedgerWatermark: '0',
          operationsCanonicalJson: '[]',
          findingCount: 0,
          publicationOperationCount: 0,
          publicationChunkCount: 0,
          coverageComplete: true,
          mergeGateConclusion: MergeGateConclusion.Pass,
        },
      })
    ).resolves.toEqual({
      status: ReviewPublicationRequestOutcomeStatus.Conflict,
    });
  });

  it('fails ambiguous publication request protocol errors instead of masking them as non-applied', async () => {
    const execute = jest.fn().mockRejectedValue(
      new ReviewActionV2ClientError(
        ReviewActionV2ClientFailureCode.ProtocolError,
        ReviewActionV2OperationId.ReviewPublicationRequest,
        {
          httpStatus: 409,
          protocolErrorCode: ReviewActionV2ProtocolErrorCode.AmbiguousOutcome,
        }
      )
    );

    await expect(
      createAdapter(execute).requestPublication({
        authorization,
        idempotencyKey: 'idem:publication:ambiguous',
        publicationPermit: 'publication-permit',
        projection: {
          artifactId: 'artifact-1',
          artifactHash: hash('artifact'),
          projectionEnvelopeVersion: 1,
          projectionEnvelopeCanonicalJson: '{"findings":[]}',
          projectionHash: hash('projection'),
          lifecycleStateHash: hash('lifecycle'),
          commandLedgerWatermark: '0',
          operationsCanonicalJson: '[]',
          findingCount: 0,
          publicationOperationCount: 0,
          publicationChunkCount: 0,
          coverageComplete: true,
          mergeGateConclusion: MergeGateConclusion.Pass,
        },
      })
    ).rejects.toThrow(
      'review_action_v2:review_publication_request:ambiguous_outcome'
    );
  });

  it('does not expose unrecognized publication request issue values', async () => {
    const execute = jest.fn().mockRejectedValue(
      new ReviewActionV2ClientError(
        ReviewActionV2ClientFailureCode.ProtocolError,
        ReviewActionV2OperationId.ReviewPublicationRequest,
        {
          httpStatus: 403,
          protocolErrorCode: ReviewActionV2ProtocolErrorCode.Forbidden,
          issues: ['refresh_token:credentialshapedvalue'],
        }
      )
    );

    await expect(
      createAdapter(execute).requestPublication({
        authorization,
        idempotencyKey: 'idem:publication:safe-diagnostic',
        publicationPermit: 'publication-permit',
        projection: {
          artifactId: 'artifact-1',
          artifactHash: hash('artifact'),
          projectionEnvelopeVersion: 1,
          projectionEnvelopeCanonicalJson: '{"findings":[]}',
          projectionHash: hash('projection'),
          lifecycleStateHash: hash('lifecycle'),
          commandLedgerWatermark: '0',
          operationsCanonicalJson: '[]',
          findingCount: 0,
          publicationOperationCount: 0,
          publicationChunkCount: 0,
          coverageComplete: true,
          mergeGateConclusion: MergeGateConclusion.Pass,
        },
      })
    ).rejects.toThrow('review_action_v2:review_publication_request:forbidden');
  });

  it('maps known unavailable publication facts to a typed outcome', async () => {
    const execute = jest.fn().mockRejectedValue(
      new ReviewActionV2ClientError(
        ReviewActionV2ClientFailureCode.ProtocolError,
        ReviewActionV2OperationId.ReviewPublicationRequest,
        {
          httpStatus: 429,
          protocolErrorCode: ReviewActionV2ProtocolErrorCode.CapacityLimited,
          retryClass: ReviewActionV2RetryClass.SameRequest,
          issues: [
            'publication_facts_unavailable',
            'publication_fact_unavailable:lifecycle',
            'publication_fact_unavailable:safety',
            'publication_fact_unavailable:lifecycle',
          ],
        }
      )
    );

    await expect(
      createAdapter(execute).requestPublication({
        authorization,
        idempotencyKey: 'idem:publication:facts-unavailable',
        publicationPermit: 'publication-permit',
        projection: publicationProjection(),
      })
    ).resolves.toEqual({
      status: ReviewPublicationRequestOutcomeStatus.FactsUnavailable,
      unavailableFacts: [
        ReviewPublicationUnavailableFact.Lifecycle,
        ReviewPublicationUnavailableFact.Safety,
      ],
    });
  });

  it('withholds unknown unavailable publication facts from typed output', async () => {
    const execute = jest.fn().mockRejectedValue(
      new ReviewActionV2ClientError(
        ReviewActionV2ClientFailureCode.ProtocolError,
        ReviewActionV2OperationId.ReviewPublicationRequest,
        {
          httpStatus: 429,
          protocolErrorCode: ReviewActionV2ProtocolErrorCode.CapacityLimited,
          retryClass: ReviewActionV2RetryClass.SameRequest,
          issues: [
            'publication_facts_unavailable',
            'publication_fact_unavailable:future_credential_fact',
          ],
        }
      )
    );

    await expect(
      createAdapter(execute).requestPublication({
        authorization,
        idempotencyKey: 'idem:publication:unknown-fact',
        publicationPermit: 'publication-permit',
        projection: publicationProjection(),
      })
    ).rejects.toThrow(
      'review_action_v2:review_publication_request:capacity_limited'
    );
  });

  it('maps safe publication stale gate reasons to a typed stale outcome', async () => {
    const execute = jest.fn().mockRejectedValue(
      new ReviewActionV2ClientError(
        ReviewActionV2ClientFailureCode.ProtocolError,
        ReviewActionV2OperationId.ReviewPublicationRequest,
        {
          httpStatus: 412,
          protocolErrorCode: ReviewActionV2ProtocolErrorCode.StalePrecondition,
          issues: ['lifecycle_not_current'],
        }
      )
    );

    await expect(
      createAdapter(execute).requestPublication({
        authorization,
        idempotencyKey: 'idem:publication:lifecycle-stale',
        publicationPermit: 'publication-permit',
        projection: {
          artifactId: 'artifact-1',
          artifactHash: hash('artifact'),
          projectionEnvelopeVersion: 1,
          projectionEnvelopeCanonicalJson: '{"findings":[]}',
          projectionHash: hash('projection'),
          lifecycleStateHash: hash('lifecycle'),
          commandLedgerWatermark: '0',
          operationsCanonicalJson: '[]',
          findingCount: 0,
          publicationOperationCount: 0,
          publicationChunkCount: 0,
          coverageComplete: true,
          mergeGateConclusion: MergeGateConclusion.Pass,
        },
      })
    ).resolves.toEqual({
      status: ReviewPublicationRequestOutcomeStatus.Stale,
      reason: 'lifecycle_not_current',
    });
  });

  it('maps granular publication lifecycle mismatch reasons to typed stale outcomes', async () => {
    const execute = jest.fn().mockRejectedValue(
      new ReviewActionV2ClientError(
        ReviewActionV2ClientFailureCode.ProtocolError,
        ReviewActionV2OperationId.ReviewPublicationRequest,
        {
          httpStatus: 412,
          protocolErrorCode: ReviewActionV2ProtocolErrorCode.StalePrecondition,
          issues: ['lifecycle_hash_mismatch'],
        }
      )
    );

    await expect(
      createAdapter(execute).requestPublication({
        authorization,
        idempotencyKey: 'idem:publication:lifecycle-hash-stale',
        publicationPermit: 'publication-permit',
        projection: {
          artifactId: 'artifact-1',
          artifactHash: hash('artifact'),
          projectionEnvelopeVersion: 1,
          projectionEnvelopeCanonicalJson: '{"findings":[]}',
          projectionHash: hash('projection'),
          lifecycleStateHash: hash('lifecycle'),
          commandLedgerWatermark: '0',
          operationsCanonicalJson: '[]',
          findingCount: 0,
          publicationOperationCount: 0,
          publicationChunkCount: 0,
          coverageComplete: true,
          mergeGateConclusion: MergeGateConclusion.Pass,
        },
      })
    ).resolves.toEqual({
      status: ReviewPublicationRequestOutcomeStatus.Stale,
      reason: 'lifecycle_hash_mismatch',
    });
  });

  it('adopts same-execution evidence with exact source and response identities', async () => {
    const observation = acceptedObservation();
    const source = {
      sourceLeaseId: baseLease.leaseId,
      sourceFencingToken: baseLease.fencingToken,
      sourceOwnerIdHash: hash('owner'),
    };
    const facts = canonicalJson({
      observationId: observation.observationId,
      sourceExecutionId: execution.executionId,
      sourceLeaseId: source.sourceLeaseId,
      sourceFencingToken: source.sourceFencingToken,
      providerInvocationKey: observation.providerInvocationKey,
      providerVoteIdentityHash: observation.providerVoteIdentityHash,
      manifestKey: providerManifest.manifestKey,
      payloadHash: observation.payloadHash,
      byteCount: observation.byteCount,
      findingCount: observation.findingCount,
      actualModel: observation.actualModel,
      qualityFlags: observation.qualityFlags,
      transportAttemptCount: observation.transportAttemptCount,
      eligibilityPolicyVersion: observation.eligibilityPolicyVersion,
      planHash: execution.restoredExecution.planHash,
      reviewRevisionHash: authorization.facts.reviewRevisionHash,
    });
    const execute = jest.fn().mockResolvedValue({
      status: ReviewExecutionMutationResultStatus.Applied,
      executionId: execution.executionId,
      workSlotId: workSlot.workSlotId,
      streamVersion: '2',
      observationPayloadCanonicalJson: observation.payloadCanonicalJson,
      observationFactsCanonicalJson: facts,
    });
    const adapter = createAdapter(execute);

    await expect(
      adapter.adoptObservation({
        authorization,
        idempotencyKey: 'idem:adopt:1',
        execution,
        workSlot,
        planHash: execution.restoredExecution.planHash,
        manifest: providerManifest,
        observation,
        source,
      })
    ).resolves.toEqual({ streamVersion: '2' });
    expect(execute).toHaveBeenCalledWith(
      ReviewActionV2OperationId.ReviewExecutionObservationAdopt,
      expect.objectContaining({
        executionGeneration: execution.generation,
        expectedStreamVersion: execution.streamVersion,
        expectedExecutionVersion: execution.executionVersion,
        sourceLeaseId: source.sourceLeaseId,
        sourceFencingToken: source.sourceFencingToken,
        ownerIdHash: source.sourceOwnerIdHash,
      })
    );
  });
});

function createAdapter(execute: jest.Mock) {
  return new ReviewActionV2ControlPlaneAdapter({
    execute,
    executeWithMetadata: async (...args: unknown[]) => ({
      result: await execute(...args),
      serverTime: '2026-07-22T12:00:00.000Z',
    }),
  } as unknown as ReviewActionV2Client);
}

function renewalInput() {
  return {
    authorization,
    idempotencyKey: 'idem:renew:1',
    renewalRequestId: 'renewal-1',
    oidcToken: 'oidc.token',
    requestedTtlMs: 3_900_000,
  };
}

function authorizationResponse() {
  return {
    status: ReviewRunAuthorizationResultStatus.Authorized,
    authorizationId: authorization.authorizationId,
    authorizationToken: authorization.authorizationToken,
    producerReleaseId: authorization.producerReleaseId,
    protocolLimitsProfileId: authorization.protocolLimitsProfileId,
    operationalSloProfileId: authorization.operationalSloProfileId,
    mutationEpoch: authorization.mutationEpoch,
    expiresAt: authorization.expiresAt,
    protocolLimitsCanonicalJson: JSON.stringify(protocolLimits),
    authorizationFactsCanonicalJson: canonicalJson(authorizationFacts),
  };
}

const protocolLimits = {
  maxAttemptsPerSlot: 3,
  maxLeaseDurationMs: 60_000,
  maxObservationBytes: 100_000,
  maxObservationFindings: 100,
  maxProjectionBytes: 200_000,
  maxProjectionFindings: 100,
  maxPublicationBodyBytes: 200_000,
  maxPublicationChunks: 20,
  maxPublicationOperations: 100,
  maxReconciliationDurationMs: 60_000,
  maxRequestBatchSize: 20,
  maxResultReportDurationMs: 60_000,
  maxWorkSlots: 10,
};

const authorizationFacts = {
  workspaceId: 'workspace-1',
  repositoryConnectionId: 'connection-1',
  scmRepositoryIdentityId: 'repository-1',
  pullRequestNumber: 252,
  sourceRunId: 'run-1',
  sourceRunAttempt: '1',
  baseSha: '1'.repeat(40),
  mergeBaseSha: '2'.repeat(40),
  headSha: '3'.repeat(40),
  reviewRevisionHash: '4'.repeat(64),
  trustDomain: 'github-actions',
  producerReleaseId: 'release-1',
  selectedProtocolVersion: 'review-action-v2',
  schemaDigest: '5'.repeat(64),
  providerVoteLanes: [
    {
      providerKind: ReviewExecutionProviderKind.Codex,
      providerVoteIdentityHash: '6'.repeat(64),
    },
  ],
};

const authorization = {
  authorizationId: 'authorization-1',
  authorizationToken: 'authorization.token',
  producerReleaseId: 'release-1',
  protocolLimitsProfileId: 'limits-1',
  operationalSloProfileId: 'slo-1',
  mutationEpoch: '1',
  expiresAt: '2026-07-22T13:00:00.000Z',
  limits: protocolLimits,
  facts: authorizationFacts,
};

const execution = {
  executionId: 'execution-1',
  generation: '1',
  streamVersion: '1',
  executionVersion: '1',
  restoredExecution: {
    executionId: 'execution-1',
    version: '1',
    streamVersion: '1',
    generation: '1',
    state: RestoredReviewExecutionState.Running,
    authorizationId: authorization.authorizationId,
    reviewRevisionHash: authorization.facts.reviewRevisionHash,
    planHash: '2'.repeat(64),
    workSlots: [
      {
        workSlotId: 'slot-1',
        state: RestoredReviewWorkSlotState.Pending,
        required: true,
        providerVoteIdentityHash: '5'.repeat(64),
        activeLeaseId: null,
        acceptedObservationRefId: null,
      },
    ],
  },
};

const workSlot = {
  workSlotId: 'slot-1',
  taskKind: ReviewTaskKind.FindingDiscovery,
  providerKind: ReviewExecutionProviderKind.Codex,
  providerVoteIdentityHash: '5'.repeat(64),
  shardKey: 'batch-1',
  required: true,
  attemptBudget: 1,
  retryPolicyVersion: 'retry-v1',
};

const providerManifest = {
  manifestCanonicalJson: '{"fixture":true}',
  manifestKey: '3'.repeat(64),
  providerInvocationKey: '4'.repeat(64),
  providerVoteIdentityHash: workSlot.providerVoteIdentityHash,
};

const baseLease = {
  leaseId: 'lease-1',
  attemptId: 'attempt-1',
  leaseCapability: 'lease.capability',
  fencingToken: '1',
  expiresAt: '2026-07-22T12:10:00.000Z',
  resultReportUntil: '2026-07-22T12:20:00.000Z',
  renewalCeilingReached: false,
};

function leaseAcquireInput() {
  return {
    authorization,
    idempotencyKey: 'idem:lease:acquire',
    execution,
    workSlot,
    manifest: providerManifest,
    acquireRequestId: 'acquire-1',
    ownerIdHash: hash('owner'),
  };
}

const startInput = {
  authorization,
  idempotencyKey: 'idem:start:1',
  executionId: 'execution-1',
  reviewRevisionHash: '1'.repeat(64),
  compatibilityKey: '2'.repeat(64),
  planHash: '3'.repeat(64),
  workSlotsCanonicalJson: '[]',
  workSlots: [workSlot],
  sourceRunId: 'run-1',
  sourceRunAttempt: '1',
};

function acceptedObservation() {
  const payloadCanonicalJson = canonicalJson({ findings: [] });
  return {
    observationId: 'observation-1',
    payloadCanonicalJson,
    payloadHash: hash(payloadCanonicalJson),
    byteCount: Buffer.byteLength(payloadCanonicalJson),
    findingCount: 0,
    actualModel: 'gpt-test',
    qualityFlags: [] as readonly string[],
    transportAttemptCount: 1,
    schemaValidated: true,
    fullyConsumed: true,
    eligibilityPolicyVersion: 't0-v1',
    providerKind: ReviewExecutionProviderKind.Codex,
    providerInvocationKey: providerManifest.providerInvocationKey,
    providerVoteIdentityHash: providerManifest.providerVoteIdentityHash,
  };
}

function publicationProjection() {
  return {
    artifactId: 'artifact-1',
    artifactHash: hash('artifact'),
    projectionEnvelopeVersion: 1,
    projectionEnvelopeCanonicalJson: '{"findings":[]}',
    projectionHash: hash('projection'),
    lifecycleStateHash: hash('lifecycle'),
    commandLedgerWatermark: '0',
    operationsCanonicalJson: '[]',
    findingCount: 0,
    publicationOperationCount: 0,
    publicationChunkCount: 0,
    coverageComplete: true,
    mergeGateConclusion: MergeGateConclusion.Pass,
  };
}

function canonicalExecution(overrides: { version?: string } = {}) {
  return canonicalJson({
    authorizationId: authorization.authorizationId,
    executionId: startInput.executionId,
    generation: '1',
    planHash: startInput.planHash,
    reviewRevisionHash: startInput.reviewRevisionHash,
    state: RestoredReviewExecutionState.Running,
    version: overrides.version ?? '1',
    workSlots: [
      {
        acceptedObservationRefId: null,
        activeLeaseId: null,
        providerVoteIdentityHash: workSlot.providerVoteIdentityHash,
        required: workSlot.required,
        state: RestoredReviewWorkSlotState.Pending,
        workSlotId: workSlot.workSlotId,
      },
    ],
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
