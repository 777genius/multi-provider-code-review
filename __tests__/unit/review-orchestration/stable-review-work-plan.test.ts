import { createHash } from 'crypto';
import {
  createStableReviewBatchId,
  createStableReviewAssignmentManifest,
  createStableReviewWorkPlan,
} from '../../../src/review-orchestration/domain';
import { canonicalizeReviewWorkSlots } from '../../../src/review-orchestration/application';
import {
  ReviewExecutionProviderKind,
  ReviewTaskKind,
} from '../../../src/review-orchestration/application';

describe('createStableReviewWorkPlan', () => {
  it('creates the same bounded provider-by-batch slots regardless of input order', () => {
    const first = createStableReviewWorkPlan(input());
    const reversed = createStableReviewWorkPlan({
      ...input(),
      providers: [...input().providers].reverse(),
      batches: [...input().batches].reverse(),
    });

    expect(reversed).toEqual(first);
    expect(first.assignments).toHaveLength(4);
    expect(first.workSlotsCanonicalJson).toBe(
      canonicalizeReviewWorkSlots(
        first.assignments.map((assignment) => assignment.workSlot)
      )
    );
    expect(first.assignments.map((assignment) => assignment.batchId)).toEqual([
      'batch-2',
      'batch-2',
      'batch-1',
      'batch-1',
    ]);
    expect(first.planHash).toBe(
      createHash('sha256')
        .update(
          `rr.review-work-plan.v2\0${canonicalJson({
            assignmentManifestHash: first.assignmentManifestHash,
            compatibilityKey: input().compatibilityKey,
            reviewRevisionHash: input().reviewRevisionHash,
            workSlots: [...first.assignments]
              .sort((left, right) =>
                left.workSlot.workSlotId < right.workSlot.workSlotId ? -1 : 1
              )
              .map((assignment) => assignment.workSlot),
          })}`
        )
        .digest('hex')
    );
  });

  it('rejects plans beyond the authorized slot ceiling', () => {
    expect(() =>
      createStableReviewWorkPlan({ ...input(), maxWorkSlots: 3 })
    ).toThrow('review_work_plan_slot_limit_exceeded');
  });

  it('rejects duplicate provider vote lanes', () => {
    const fixture = input();
    expect(() =>
      createStableReviewWorkPlan({
        ...fixture,
        providers: [
          fixture.providers[0],
          { ...fixture.providers[1], providerVoteIdentityHash: 'a'.repeat(64) },
        ],
      })
    ).toThrow('review_work_plan_vote_lane_duplicate');
  });

  it('changes risk-first scheduling without changing batch or slot identity', () => {
    const first = createStableReviewWorkPlan(input());
    const rescheduled = createStableReviewWorkPlan({
      ...input(),
      batches: input().batches.map((batch) => ({
        ...batch,
        schedulingOrdinal: batch.schedulingOrdinal === 0 ? 1 : 0,
      })),
    });

    expect(rescheduled.planHash).toBe(first.planHash);
    expect(rescheduled.workSlotsCanonicalJson).toBe(
      first.workSlotsCanonicalJson
    );
    expect(
      rescheduled.assignments
        .map((assignment) => assignment.workSlot.workSlotId)
        .sort()
    ).toEqual(
      first.assignments
        .map((assignment) => assignment.workSlot.workSlotId)
        .sort()
    );
    expect(first.assignments[0].batchId).toBe('batch-2');
    expect(rescheduled.assignments[0].batchId).toBe('batch-1');
  });

  it('rejects ambiguous scheduling ordinals', () => {
    const fixture = input();
    expect(() =>
      createStableReviewWorkPlan({
        ...fixture,
        batches: fixture.batches.map((batch) => ({
          ...batch,
          schedulingOrdinal: 0,
        })),
      })
    ).toThrow('review_work_plan_scheduling_ordinal_duplicate');
  });

  it('canonicalizes and hashes exact slot path assignments', () => {
    const first = createStableReviewAssignmentManifest({
      assignments: [
        { workSlotId: 'slot-2', paths: ['src/a.ts'] },
        { workSlotId: 'slot-1', paths: ['src/b.ts', 'src/b.ts'] },
      ],
      eligiblePaths: ['src/z.ts', 'src/b.ts', 'src/a.ts'],
      uncoveredPaths: ['src/z.ts'],
      excludedPaths: ['docs/generated.md', 'docs/generated.md'],
    });
    const reordered = createStableReviewAssignmentManifest({
      assignments: [
        { workSlotId: 'slot-1', paths: ['src/b.ts'] },
        { workSlotId: 'slot-2', paths: ['src/a.ts'] },
      ],
      eligiblePaths: ['src/a.ts', 'src/b.ts', 'src/z.ts'],
      uncoveredPaths: ['src/z.ts'],
      excludedPaths: ['docs/generated.md'],
    });

    expect(reordered).toEqual(first);
    expect(JSON.parse(first.assignmentManifestCanonicalJson)).toEqual({
      assignments: [
        { paths: ['src/b.ts'], workSlotId: 'slot-1' },
        { paths: ['src/a.ts'], workSlotId: 'slot-2' },
      ],
      eligiblePaths: ['src/a.ts', 'src/b.ts', 'src/z.ts'],
      excludedPaths: ['docs/generated.md'],
      manifestVersion: 1,
      uncoveredPaths: ['src/z.ts'],
    });
    expect(first.assignmentManifestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects unsafe or inconsistent assignment manifest paths', () => {
    expect(() =>
      createStableReviewAssignmentManifest({
        assignments: [{ workSlotId: 'slot-1', paths: ['src/../secret.ts'] }],
        eligiblePaths: ['src/../secret.ts'],
        uncoveredPaths: [],
        excludedPaths: [],
      })
    ).toThrow('review_assignment_manifest_path_invalid');
    expect(() =>
      createStableReviewAssignmentManifest({
        assignments: [{ workSlotId: 'slot-1', paths: ['src/a.ts'] }],
        eligiblePaths: ['src/b.ts'],
        uncoveredPaths: [],
        excludedPaths: [],
      })
    ).toThrow('review_assignment_manifest_assignment_not_eligible');
    expect(() =>
      createStableReviewAssignmentManifest({
        assignments: [{ workSlotId: 'slot-1', paths: ['src/a.ts'] }],
        eligiblePaths: ['src/a.ts'],
        uncoveredPaths: ['src/a.ts'],
        excludedPaths: [],
      })
    ).toThrow('review_assignment_manifest_uncovered_assigned_overlap');
    expect(() =>
      createStableReviewAssignmentManifest({
        assignments: [],
        eligiblePaths: ['src/a.ts'],
        uncoveredPaths: [],
        excludedPaths: [],
      })
    ).toThrow('review_assignment_manifest_eligible_unaccounted');
    expect(() =>
      createStableReviewAssignmentManifest({
        assignments: [{ workSlotId: 'slot-1', paths: ['src/a.ts'] }],
        eligiblePaths: ['src/a.ts'],
        uncoveredPaths: [],
        excludedPaths: ['src/a.ts'],
      })
    ).toThrow('review_assignment_manifest_excluded_eligible_overlap');
    expect(() =>
      createStableReviewAssignmentManifest({
        assignments: [],
        eligiblePaths: [],
        uncoveredPaths: [],
        excludedPaths: ['a'.repeat(1_025)],
      })
    ).toThrow('review_assignment_manifest_path_invalid');
  });
});

describe('createStableReviewBatchId', () => {
  it('depends on task kind and canonical membership/content, not member order', () => {
    const members = [
      batchMember('src/security.ts', '+secure'),
      batchMember('src/storage.ts', '+persist'),
    ];
    const first = createStableReviewBatchId({
      taskKind: ReviewTaskKind.FindingDiscovery,
      members,
    });
    const permuted = createStableReviewBatchId({
      taskKind: ReviewTaskKind.FindingDiscovery,
      members: [...members].reverse(),
    });
    const changed = createStableReviewBatchId({
      taskKind: ReviewTaskKind.FindingDiscovery,
      members: [
        batchMember('src/security.ts', '+secure'),
        batchMember('src/storage.ts', '+changed'),
      ],
    });
    const otherTask = createStableReviewBatchId({
      taskKind: ReviewTaskKind.LifecycleRevalidation,
      members,
    });

    expect(permuted).toBe(first);
    expect(changed).not.toBe(first);
    expect(otherTask).not.toBe(first);
  });
});

function input() {
  return {
    reviewRevisionHash: '1'.repeat(64),
    compatibilityKey: '2'.repeat(64),
    providers: [
      {
        providerName: 'codex/gpt-5.3-codex',
        providerKind: ReviewExecutionProviderKind.Codex,
        providerVoteIdentityHash: 'a'.repeat(64),
        required: true,
        attemptBudget: 2,
        retryPolicyVersion: 'retry-v1',
      },
      {
        providerName: 'claude/sonnet',
        providerKind: ReviewExecutionProviderKind.ClaudeCode,
        providerVoteIdentityHash: 'b'.repeat(64),
        required: false,
        attemptBudget: 1,
        retryPolicyVersion: 'retry-v1',
      },
    ],
    batches: [
      {
        batchId: 'batch-2',
        taskKind: ReviewTaskKind.FindingDiscovery,
        required: true,
        schedulingOrdinal: 0,
        paths: ['src/security.ts'],
      },
      {
        batchId: 'batch-1',
        taskKind: ReviewTaskKind.FindingDiscovery,
        required: true,
        schedulingOrdinal: 1,
        paths: ['src/storage.ts'],
      },
    ],
    eligiblePaths: ['src/security.ts', 'src/storage.ts'],
    uncoveredPaths: [],
    excludedPaths: [],
    maxWorkSlots: 8,
    maxAttemptsPerSlot: 3,
  };
}

function batchMember(filename: string, patch: string) {
  return {
    filename,
    status: 'modified',
    additions: 1,
    deletions: 0,
    changes: 1,
    patch,
  };
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
