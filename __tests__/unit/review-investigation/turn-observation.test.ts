import {
  REVIEW_TURN_PROVIDER_PROPOSABLE_OBLIGATION_KINDS,
  REVIEW_TURN_MAX_OBLIGATION_PROPOSALS,
  ReviewTurnFindingSeverity,
  ReviewTurnObligationKind,
  ReviewTurnProposalRevision,
  buildReviewAgentTurnOutputSchema,
  parseReviewAgentTurnOutput,
} from '../../../src/review-investigation/domain/turn-observation';
import {
  canonicalJson,
  sha256,
} from '../../../src/review-investigation/domain/canonical-json';
import {
  recordFakeProviderObligationProposals,
  type FakeObligation,
} from '../../e2e/support/fake-review-action-v2-control-plane';

const digest = (character: string) => character.repeat(64);

describe('review agent turn observation v2', () => {
  it('publishes the strict provider-neutral output schema', () => {
    const schema = buildReviewAgentTurnOutputSchema() as {
      required: readonly string[];
      properties: Record<string, Record<string, unknown>>;
    };

    expect(schema.required).toEqual([
      'outputVersion',
      'findings',
      'obligationProposals',
      'closureClaims',
      'operationBackedDiscoveryClaims',
      'unresolvableClaims',
      'criticDecision',
    ]);
    expect(schema.properties.outputVersion).toEqual({ const: 2 });
    expect(schema.properties.obligationProposals).toMatchObject({
      type: 'array',
      maxItems: REVIEW_TURN_MAX_OBLIGATION_PROPOSALS,
      items: {
        additionalProperties: false,
        required: [
          'kind',
          'canonicalSubject',
          'canonicalRequirement',
          'riskPriority',
        ],
        properties: {
          kind: {
            enum: REVIEW_TURN_PROVIDER_PROPOSABLE_OBLIGATION_KINDS,
          },
          canonicalSubject: { minLength: 1, maxLength: 4_096 },
          canonicalRequirement: { minLength: 1, maxLength: 64_000 },
          riskPriority: { minimum: 0, maximum: 1_000_000 },
        },
      },
    });
    expect(schema.properties.operationBackedDiscoveryClaims).toMatchObject({
      type: 'array',
      maxItems: 256,
      items: {
        additionalProperties: false,
        required: ['sourceObligationId', 'query', 'operationReceiptIds'],
        properties: {
          query: { minLength: 1, maxLength: 1_024 },
          operationReceiptIds: {
            maxItems: 256,
            minItems: 1,
            uniqueItems: true,
          },
        },
      },
    });
  });

  it('accepts 128 proposals and rejects 129 before control-plane commit', () => {
    const proposals = Array.from(
      { length: REVIEW_TURN_MAX_OBLIGATION_PROPOSALS },
      (_, index) => completeFileProposal({ path: `src/caller-${index}.ts` })
    );
    expect(
      parseReviewAgentTurnOutput({
        ...validOutput(),
        obligationProposals: proposals,
      }).obligationProposals
    ).toHaveLength(REVIEW_TURN_MAX_OBLIGATION_PROPOSALS);
    expect(() =>
      parseReviewAgentTurnOutput({
        ...validOutput(),
        obligationProposals: [
          ...proposals,
          completeFileProposal({ path: 'src/caller-overflow.ts' }),
        ],
      })
    ).toThrow('review_agent_obligation_proposals_invalid');
  });

  it('parses exact operation-backed discovery claims', () => {
    const output = parseReviewAgentTurnOutput(validOutput());

    expect(output).toMatchObject({
      outputVersion: 2,
      obligationProposals: [completeFileProposal()],
      operationBackedDiscoveryClaims: [
        {
          sourceObligationId: digest('c'),
          query: 'sharedContract',
          operationReceiptIds: [digest('d')],
        },
      ],
    });
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.obligationProposals)).toBe(true);
    expect(Object.isFrozen(output.obligationProposals[0])).toBe(true);
  });

  it('rejects v1, missing, and additional top-level fields', () => {
    const valid = validOutput();
    const { operationBackedDiscoveryClaims: _claims, ...missingClaims } = valid;

    expect(() =>
      parseReviewAgentTurnOutput({ ...valid, outputVersion: 1 })
    ).toThrow('review_agent_output_version_invalid');
    expect(() => parseReviewAgentTurnOutput(missingClaims)).toThrow(
      'review_agent_output_fields_invalid'
    );
    expect(() => parseReviewAgentTurnOutput({ ...valid, extra: true })).toThrow(
      'review_agent_output_fields_invalid'
    );
  });

  it('rejects malformed, unknown, and server-reserved proposals', () => {
    const valid = validOutput();
    expect(() =>
      parseReviewAgentTurnOutput({
        ...valid,
        obligationProposals: [{}],
      })
    ).toThrow('review_agent_output_fields_invalid');
    expect(() =>
      parseReviewAgentTurnOutput({
        ...valid,
        obligationProposals: [
          {
            ...valid.obligationProposals[0],
            kind: 'provider_specific_kind',
          },
        ],
      })
    ).toThrow('review_agent_obligation_kind_unsupported');
    expect(() =>
      parseReviewAgentTurnOutput({
        ...valid,
        obligationProposals: [
          {
            ...valid.obligationProposals[0],
            kind: ReviewTurnObligationKind.ChangedContent,
          },
        ],
      })
    ).toThrow('review_agent_obligation_kind_unsupported');
  });

  it('rejects incomplete discovery claims', () => {
    const valid = validOutput();
    expect(() =>
      parseReviewAgentTurnOutput({
        ...valid,
        obligationProposals: [
          {
            ...valid.obligationProposals[0],
            serverAccepted: true,
          },
        ],
      })
    ).toThrow('review_agent_output_fields_invalid');
    expect(() =>
      parseReviewAgentTurnOutput({
        ...valid,
        operationBackedDiscoveryClaims: [
          {
            sourceObligationId: digest('c'),
            query: 'sharedContract',
            operationReceiptIds: [],
          },
        ],
      })
    ).toThrow('review_agent_operation_backed_discovery_receipts_required');
    expect(() =>
      parseReviewAgentTurnOutput({
        ...valid,
        operationBackedDiscoveryClaims: [
          {
            sourceObligationId: digest('c'),
            query: 'sharedContract',
            operationReceiptIds: [digest('d'), digest('d')],
          },
        ],
      })
    ).toThrow('review_agent_operation_backed_discovery_receipts_duplicate');
    expect(() =>
      parseReviewAgentTurnOutput({
        ...valid,
        operationBackedDiscoveryClaims: [
          {
            sourceObligationId: digest('c'),
            query: 'sharedContract',
            operationReceiptIds: [digest('d')],
            extra: true,
          },
        ],
      })
    ).toThrow('review_agent_output_fields_invalid');
  });

  it('accepts canonical complete_file proposals for UTF-8 paths and both revisions', () => {
    const head = completeFileProposal({ path: 'src/\u00e9vidence.ts' });
    const mergeBase = completeFileProposal({
      kind: ReviewTurnObligationKind.BaseContent,
      path: 'src/previous.ts',
      revision: ReviewTurnProposalRevision.MergeBase,
    });

    const output = parseReviewAgentTurnOutput({
      ...validOutput(),
      obligationProposals: [head, mergeBase],
    });

    expect(output.obligationProposals).toEqual([head, mergeBase]);
  });

  it.each([
    {
      name: 'non-JSON requirement',
      mutate: (proposal: ReturnType<typeof completeFileProposal>) => ({
        ...proposal,
        canonicalRequirement: 'inspect every direct caller',
      }),
      error: 'review_agent_obligation_requirement_invalid',
    },
    {
      name: 'unsupported requirement kind',
      mutate: (proposal: ReturnType<typeof completeFileProposal>) => {
        const requirement = JSON.parse(proposal.canonicalRequirement) as Record<
          string,
          unknown
        >;
        return {
          ...proposal,
          canonicalRequirement: canonicalJson({
            ...requirement,
            kind: 'complete_git_fact',
          }),
        };
      },
      error: 'review_agent_obligation_requirement_unsupported',
    },
    {
      name: 'non-canonical requirement JSON',
      mutate: (proposal: ReturnType<typeof completeFileProposal>) => {
        const requirement = JSON.parse(proposal.canonicalRequirement) as {
          kind: string;
          path: string;
          pathHash: string;
          requirementVersion: number;
          revision: string;
        };
        return {
          ...proposal,
          canonicalRequirement: JSON.stringify({
            requirementVersion: requirement.requirementVersion,
            kind: requirement.kind,
            path: requirement.path,
            pathHash: requirement.pathHash,
            revision: requirement.revision,
          }),
        };
      },
      error: 'review_agent_obligation_requirement_non_canonical',
    },
    {
      name: 'path hash not derived from path',
      mutate: (proposal: ReturnType<typeof completeFileProposal>) => {
        const requirement = JSON.parse(proposal.canonicalRequirement) as Record<
          string,
          unknown
        >;
        return {
          ...proposal,
          canonicalRequirement: canonicalJson({
            ...requirement,
            pathHash: digest('f'),
          }),
        };
      },
      error: 'review_agent_obligation_requirement_path_hash_mismatch',
    },
    {
      name: 'subject not bound to requirement',
      mutate: (proposal: ReturnType<typeof completeFileProposal>) => ({
        ...proposal,
        canonicalSubject: completeFileProposal({ path: 'src/other.ts' })
          .canonicalSubject,
      }),
      error: 'review_agent_obligation_subject_mismatch',
    },
  ])('rejects $name', ({ mutate, error }) => {
    const valid = validOutput();
    expect(() =>
      parseReviewAgentTurnOutput({
        ...valid,
        obligationProposals: [mutate(valid.obligationProposals[0])],
      })
    ).toThrow(error);
  });

  it('rejects duplicate canonical proposal identities even when advisory risk differs', () => {
    const valid = validOutput();
    expect(() =>
      parseReviewAgentTurnOutput({
        ...valid,
        obligationProposals: [
          valid.obligationProposals[0],
          { ...valid.obligationProposals[0], riskPriority: 900_000 },
        ],
      })
    ).toThrow('review_agent_obligation_proposal_duplicate');
  });

  it.each([' sharedContract', 'sharedContract ', 'shared\nContract', 'x\0y'])(
    'rejects non-canonical discovery query %p',
    (query) => {
      const valid = validOutput();
      expect(() =>
        parseReviewAgentTurnOutput({
          ...valid,
          operationBackedDiscoveryClaims: [
            {
              sourceObligationId: digest('c'),
              query,
              operationReceiptIds: [digest('d')],
            },
          ],
        })
      ).toThrow('review_agent_operation_backed_discovery_query_invalid');
    }
  );

  it('keeps collections and discovery queries bounded', () => {
    const valid = validOutput();
    expect(() =>
      parseReviewAgentTurnOutput({
        ...valid,
        findings: Array.from({ length: 257 }, () => valid.findings[0]),
      })
    ).toThrow('review_agent_findings_invalid');
    expect(() =>
      parseReviewAgentTurnOutput({
        ...valid,
        obligationProposals: Array.from(
          { length: 257 },
          () => valid.obligationProposals[0]
        ),
      })
    ).toThrow('review_agent_obligation_proposals_invalid');
    expect(() =>
      parseReviewAgentTurnOutput({
        ...valid,
        operationBackedDiscoveryClaims: [
          {
            sourceObligationId: digest('c'),
            query: 'x'.repeat(1_025),
            operationReceiptIds: [digest('d')],
          },
        ],
      })
    ).toThrow('review_agent_operation_backed_discovery_query_invalid');
  });

  it.each([
    ['canonicalSubject', ' invalid-subject', 'obligation_subject'],
    ['canonicalSubject', `invalid-subject\t`, 'obligation_subject'],
  ] as const)(
    'rejects non-canonical proposal %s values',
    (field, value, errorField) => {
      const valid = validOutput();
      expect(() =>
        parseReviewAgentTurnOutput({
          ...valid,
          obligationProposals: [
            { ...valid.obligationProposals[0], [field]: value },
          ],
        })
      ).toThrow(`review_agent_${errorField}_invalid`);
    }
  );

  it('keeps proposal text and priority within the control-plane bounds', () => {
    const valid = validOutput();
    expect(() =>
      parseReviewAgentTurnOutput({
        ...valid,
        obligationProposals: [
          {
            ...valid.obligationProposals[0],
            canonicalSubject: 'x'.repeat(4_097),
          },
        ],
      })
    ).toThrow('review_agent_obligation_subject_invalid');
    expect(() =>
      parseReviewAgentTurnOutput({
        ...valid,
        obligationProposals: [
          {
            ...valid.obligationProposals[0],
            canonicalRequirement: 'x'.repeat(64_001),
          },
        ],
      })
    ).toThrow('review_agent_obligation_requirement_invalid');
    expect(() =>
      parseReviewAgentTurnOutput({
        ...valid,
        obligationProposals: [
          { ...valid.obligationProposals[0], riskPriority: 1_000_001 },
        ],
      })
    ).toThrow('review_agent_risk_priority_invalid');
  });
});

describe('fake control-plane proposal recording', () => {
  it('records a valid nonempty proposal as an open non-authoritative obligation', () => {
    const obligations: FakeObligation[] = [];
    const proposal = completeFileProposal();

    recordFakeProviderObligationProposals(obligations, [proposal]);

    expect(obligations).toEqual([
      expect.objectContaining({
        kind: proposal.kind,
        canonicalSubject: proposal.canonicalSubject,
        canonicalRequirement: proposal.canonicalRequirement,
        riskPriority: 800_000,
        origin: 'agent_proposal',
        status: 'open',
      }),
    ]);
  });

  it('fails closed instead of recording an unsupported proposal', () => {
    const obligations: FakeObligation[] = [];

    expect(() =>
      recordFakeProviderObligationProposals(obligations, [
        {
          ...completeFileProposal(),
          kind: ReviewTurnObligationKind.ContextCritic,
        },
      ])
    ).toThrow('review_agent_obligation_kind_unsupported');
    expect(obligations).toEqual([]);
  });
});

function validOutput() {
  return {
    outputVersion: 2,
    findings: [
      {
        severity: ReviewTurnFindingSeverity.Major,
        title: 'Contract changed',
        body: 'A direct consumer still uses the old contract.',
        path: 'src/service.ts',
        line: 7,
        evidenceOperationReceiptIds: [digest('a')],
      },
    ],
    obligationProposals: [completeFileProposal()],
    closureClaims: [
      {
        obligationId: digest('b'),
        operationReceiptIds: [digest('a')],
      },
    ],
    operationBackedDiscoveryClaims: [
      {
        sourceObligationId: digest('c'),
        query: 'sharedContract',
        operationReceiptIds: [digest('d')],
      },
    ],
    unresolvableClaims: [],
    criticDecision: null,
  };
}

function completeFileProposal(
  input: Readonly<{
    kind?: (typeof REVIEW_TURN_PROVIDER_PROPOSABLE_OBLIGATION_KINDS)[number];
    path?: string;
    revision?: ReviewTurnProposalRevision;
    riskPriority?: number;
  }> = {}
) {
  const path = input.path ?? 'src/service.ts';
  const pathHash = sha256(path);
  const revision = input.revision ?? ReviewTurnProposalRevision.Head;
  return Object.freeze({
    kind: input.kind ?? ReviewTurnObligationKind.DirectCaller,
    canonicalSubject: canonicalJson({
      kind: 'file_read',
      pathHash,
      revision,
      subjectVersion: 1,
    }),
    canonicalRequirement: canonicalJson({
      kind: 'complete_file',
      path,
      pathHash,
      requirementVersion: 1,
      revision,
    }),
    riskPriority: input.riskPriority ?? 800_000,
  });
}
