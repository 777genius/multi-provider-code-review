import {
  ReviewInvestigationChangedFileStatus,
  createReviewInvestigationProbePlan,
  type ReviewInvestigationChangedFileFact,
} from '../../../src/review-investigation/domain/deterministic-context-probe-plan';
import {
  REVIEW_INVESTIGATION_SEED_ENVELOPE_CONTRACT,
  buildReviewInvestigationSeedEnvelope,
  type ReviewInvestigationCanonicalInventory,
  type ReviewInvestigationCanonicalInventoryEntry,
} from '../../../src/review-investigation/domain/review-investigation-seed-envelope';
import {
  canonicalJson,
  sha256,
} from '../../../src/review-investigation/domain/canonical-json';
import { ReviewTurnObligationKind } from '../../../src/review-investigation/domain/turn-observation';

const REVIEW_REVISION_HASH = sha256('revision');
const MERGE_BASE_TREE_OID = gitOid('merge-base-tree');
const HEAD_TREE_OID = gitOid('head-tree');
const ZERO_OID = '0'.repeat(40);

describe('review investigation seed envelope', () => {
  it('requires merge-base and head evidence for a modified file', () => {
    const fileFact = file(
      'src/live.ts',
      ReviewInvestigationChangedFileStatus.Modified
    );
    const prepared = build([fileFact], [modifiedEntry(fileFact.path)]);

    expect(changedContentRequirements(prepared.envelope.obligations)).toEqual([
      expect.objectContaining({
        path: 'src/live.ts',
        revision: 'merge_base',
      }),
      expect.objectContaining({ path: 'src/live.ts', revision: 'head' }),
    ]);
    expect(prepared.envelope).toMatchObject({
      contract: REVIEW_INVESTIGATION_SEED_ENVELOPE_CONTRACT,
      requestedModel: 'gpt-test',
      reviewPromptHash: sha256('Review the exact revision.'),
    });
    expect(prepared.canonicalJson).toBe(canonicalJson(prepared.envelope));
    expect(prepared.hash).toBe(sha256(prepared.canonicalJson));
  });

  it('requires oldPath at merge-base and newPath at head for an exact rename', () => {
    const fileFact = file(
      'src/new-name.ts',
      ReviewInvestigationChangedFileStatus.Renamed,
      'src/old-name.ts'
    );
    const entry = exactRenameEntry(fileFact.previousPath!, fileFact.path);
    const prepared = build([fileFact], [entry]);

    expect(changedContentRequirements(prepared.envelope.obligations)).toEqual([
      expect.objectContaining({
        path: 'src/old-name.ts',
        revision: 'merge_base',
      }),
      expect.objectContaining({ path: 'src/new-name.ts', revision: 'head' }),
    ]);
    const witness = inventoryRequirement(prepared.envelope.obligations);
    expect(witness).toMatchObject({
      aggregateHash: sha256(canonicalJson([entry])),
      aggregateItemCount: 1,
      aggregatePathCount: 2,
      aggregatePathSetHash: sha256(canonicalJson(inventoryPathHashes([entry]))),
      requirementVersion: 2,
      treeOid: HEAD_TREE_OID,
    });
  });

  it('preserves canonical path pairings for duplicate-OID exact renames', () => {
    const sharedOid = gitOid('shared-rename-content');
    const files = [
      file(
        'src/new-a.ts',
        ReviewInvestigationChangedFileStatus.Renamed,
        'src/old-a.ts'
      ),
      file(
        'src/new-b.ts',
        ReviewInvestigationChangedFileStatus.Renamed,
        'src/old-b.ts'
      ),
    ];
    const prepared = build(files, [
      exactRenameEntry('src/old-a.ts', 'src/new-a.ts', sharedOid),
      exactRenameEntry('src/old-b.ts', 'src/new-b.ts', sharedOid),
    ]);

    expect(changedContentRequirements(prepared.envelope.obligations)).toEqual([
      expect.objectContaining({
        path: 'src/old-a.ts',
        revision: 'merge_base',
      }),
      expect.objectContaining({ path: 'src/new-a.ts', revision: 'head' }),
      expect.objectContaining({
        path: 'src/old-b.ts',
        revision: 'merge_base',
      }),
      expect.objectContaining({ path: 'src/new-b.ts', revision: 'head' }),
    ]);
    expect(inventoryRequirement(prepared.envelope.obligations)).toMatchObject({
      aggregateItemCount: 2,
      aggregatePathCount: 4,
    });
  });

  it.each([
    ['binary', 4],
    ['lfs_pointer', 128],
    ['gitlink', null],
    ['oversized', 2 * 1024 * 1024 + 1],
  ] as const)(
    'adds a non-textually-closable BinaryArtifact boundary for %s content',
    (contentKind, byteCount) => {
      const fileFact = file('assets/model.bin');
      const prepared = build(
        [fileFact],
        [
          modifiedEntry(fileFact.path, {
            beforeContentKind: contentKind,
            beforeByteCount: byteCount,
            beforeLineCount: contentKind === 'lfs_pointer' ? 3 : null,
            afterContentKind: contentKind,
            afterByteCount: byteCount,
            afterLineCount: contentKind === 'lfs_pointer' ? 3 : null,
            contentKind,
            byteCount,
            lineCount: contentKind === 'lfs_pointer' ? 3 : null,
            ...(contentKind === 'gitlink'
              ? { beforeMode: '160000', afterMode: '160000' }
              : {}),
          }),
        ]
      );

      expect(changedContentRequirements(prepared.envelope.obligations)).toEqual(
        [
          expect.objectContaining({
            kind: 'complete_changed_file',
            path: fileFact.path,
            revision: 'merge_base',
          }),
          expect.objectContaining({
            kind: 'complete_changed_file',
            path: fileFact.path,
            revision: 'head',
          }),
        ]
      );
      const boundaries = binaryArtifactRequirements(
        prepared.envelope.obligations
      );
      expect(boundaries).toHaveLength(2);
      expect(boundaries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            byteCount,
            contentKind,
            kind: 'binary_artifact_boundary',
            path: fileFact.path,
            revision: 'merge_base',
            status: 'modified',
          }),
          expect.objectContaining({
            byteCount,
            contentKind,
            kind: 'binary_artifact_boundary',
            path: fileFact.path,
            revision: 'head',
            status: 'modified',
          }),
        ])
      );
    }
  );

  it.each([
    ['binary', 4],
    ['lfs_pointer', 128],
    ['gitlink', null],
    ['oversized', 2 * 1024 * 1024 + 1],
  ] as const)(
    'keeps the merge-base %s boundary when head becomes text',
    (contentKind, byteCount) => {
      const fileFact = file('assets/transition.dat');
      const status = contentKind === 'gitlink' ? 'type_changed' : 'modified';
      const prepared = build(
        [fileFact],
        [
          modifiedEntry(fileFact.path, {
            status,
            beforeMode: contentKind === 'gitlink' ? '160000' : '100644',
            beforeContentKind: contentKind,
            beforeByteCount: byteCount,
            beforeLineCount: contentKind === 'lfs_pointer' ? 3 : null,
            afterMode: '100644',
            afterContentKind: 'text',
            afterByteCount: 9,
            afterLineCount: 1,
            contentKind: 'text',
            byteCount: 9,
            lineCount: 1,
          }),
        ]
      );

      expect(binaryArtifactRequirements(prepared.envelope.obligations)).toEqual(
        [
          expect.objectContaining({
            byteCount,
            contentKind,
            mode: contentKind === 'gitlink' ? '160000' : '100644',
            path: fileFact.path,
            revision: 'merge_base',
            status,
          }),
        ]
      );
    }
  );

  it('emits revision-exact boundaries for a renamed binary object', () => {
    const fileFact = file(
      'assets/new.bin',
      ReviewInvestigationChangedFileStatus.Renamed,
      'assets/old.bin'
    );
    const prepared = build(
      [fileFact],
      [
        exactRenameEntry(fileFact.previousPath!, fileFact.path, undefined, {
          beforeContentKind: 'binary',
          beforeByteCount: 4,
          beforeLineCount: null,
          afterContentKind: 'binary',
          afterByteCount: 4,
          afterLineCount: null,
          contentKind: 'binary',
          byteCount: 4,
          lineCount: null,
        }),
      ]
    );

    expect(binaryArtifactRequirements(prepared.envelope.obligations)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'assets/old.bin',
          revision: 'merge_base',
          status: 'exact_rename',
        }),
        expect.objectContaining({
          path: 'assets/new.bin',
          revision: 'head',
          status: 'exact_rename',
        }),
      ])
    );
  });

  it('preserves added/head and deleted/merge-base boundary invariants', () => {
    const added = file(
      'assets/added.bin',
      ReviewInvestigationChangedFileStatus.Added
    );
    const removed = file(
      'assets/removed.bin',
      ReviewInvestigationChangedFileStatus.Removed
    );
    const prepared = build(
      [added, removed],
      [
        addedEntry(added.path, {
          afterContentKind: 'binary',
          afterByteCount: 5,
          afterLineCount: null,
          contentKind: 'binary',
          byteCount: 5,
          lineCount: null,
        }),
        deletedEntry(removed.path, {
          beforeContentKind: 'oversized',
          beforeByteCount: 2 * 1024 * 1024 + 1,
          beforeLineCount: null,
          contentKind: 'oversized',
          byteCount: 2 * 1024 * 1024 + 1,
          lineCount: null,
        }),
      ]
    );

    expect(binaryArtifactRequirements(prepared.envelope.obligations)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: added.path,
          revision: 'head',
          status: 'added',
        }),
        expect.objectContaining({
          path: removed.path,
          revision: 'merge_base',
          status: 'deleted',
        }),
      ])
    );
  });

  it('keeps deleted content bound only to merge-base', () => {
    const fileFact = file(
      'src/removed.ts',
      ReviewInvestigationChangedFileStatus.Removed
    );
    const prepared = build([fileFact], [deletedEntry(fileFact.path)]);

    expect(changedContentRequirements(prepared.envelope.obligations)).toEqual([
      expect.objectContaining({
        path: 'src/removed.ts',
        revision: 'merge_base',
      }),
    ]);
  });

  it('binds the witness to the exact canonical status/path/OID aggregate', () => {
    const fileFact = file('src/live.ts');
    const firstEntry = modifiedEntry(fileFact.path, {
      afterOid: gitOid('live-after-v1'),
    });
    const secondEntry = modifiedEntry(fileFact.path, {
      afterOid: gitOid('live-after-v2'),
    });
    const first = build([fileFact], [firstEntry]);
    const second = build([fileFact], [secondEntry]);

    expect(inventoryRequirement(first.envelope.obligations)).toEqual({
      aggregateHash: sha256(canonicalJson([firstEntry])),
      aggregateItemCount: 1,
      aggregatePathCount: 1,
      aggregatePathSetHash: sha256(canonicalJson([sha256(fileFact.path)])),
      kind: 'complete_inventory',
      requirementVersion: 2,
      reviewRevisionHash: REVIEW_REVISION_HASH,
      treeOid: HEAD_TREE_OID,
    });
    expect(first.hash).not.toBe(second.hash);
  });

  it('supports an edited rename represented canonically as delete plus add', () => {
    const fileFact = file(
      'src/new-name.ts',
      ReviewInvestigationChangedFileStatus.Renamed,
      'src/old-name.ts'
    );
    const prepared = build(
      [fileFact],
      [deletedEntry(fileFact.previousPath!), addedEntry(fileFact.path)]
    );

    expect(changedContentRequirements(prepared.envelope.obligations)).toEqual([
      expect.objectContaining({
        path: 'src/old-name.ts',
        revision: 'merge_base',
      }),
      expect.objectContaining({ path: 'src/new-name.ts', revision: 'head' }),
    ]);
    expect(inventoryRequirement(prepared.envelope.obligations)).toMatchObject({
      aggregateItemCount: 2,
      aggregatePathCount: 2,
    });
  });

  it.each([
    ['wrong path', [modifiedEntry('src/other.ts')]],
    ['wrong status', [addedEntry('src/live.ts')]],
  ])('rejects a canonical inventory with a %s', (_name, entries) => {
    expect(() => build([file('src/live.ts')], entries)).toThrow(
      'review_investigation_seed_inventory_changed_path_mismatch'
    );
  });

  it('rejects a tampered canonical inventory hash', () => {
    const fileFact = file('src/live.ts');
    const inventory = canonicalInventory([modifiedEntry(fileFact.path)]);

    expect(() =>
      buildReviewInvestigationSeedEnvelope({
        canonicalInventory: { ...inventory, inventoryHash: sha256('tampered') },
        coverageManifest: coverage([fileFact]),
        probePlan: probePlan([fileFact]),
        requestedModel: 'gpt-test',
        reviewPrompt: 'Review the exact revision.',
      })
    ).toThrow('review_investigation_seed_inventory_hash_mismatch');
  });

  it('rejects legacy inventory that cannot prove both revision classifications', () => {
    const fileFact = file('src/live.ts');
    const entry = modifiedEntry(fileFact.path);
    const identity = {
      inventoryVersion: 1 as const,
      mergeBaseTreeOid: MERGE_BASE_TREE_OID,
      headTreeOid: HEAD_TREE_OID,
      entries: [entry],
    };

    expect(() =>
      buildReviewInvestigationSeedEnvelope({
        canonicalInventory: {
          ...identity,
          itemCount: 1,
          inventoryHash: sha256(canonicalJson(identity)),
        },
        coverageManifest: coverage([fileFact]),
        probePlan: probePlan([fileFact]),
        requestedModel: 'gpt-test',
        reviewPrompt: 'Review the exact revision.',
      })
    ).toThrow('review_investigation_seed_inventory_version_invalid');
  });

  it('rejects missing revision metadata and a mismatched active projection', () => {
    const fileFact = file('assets/live.bin');
    const complete = modifiedEntry(fileFact.path, {
      beforeContentKind: 'binary',
      beforeByteCount: 4,
      beforeLineCount: null,
      afterContentKind: 'binary',
      afterByteCount: 5,
      afterLineCount: null,
      contentKind: 'binary',
      byteCount: 5,
      lineCount: null,
    });
    const { beforeContentKind: _omitted, ...missingMetadata } = complete;
    expect(() =>
      build(
        [fileFact],
        [missingMetadata as ReviewInvestigationCanonicalInventoryEntry]
      )
    ).toThrow('review_investigation_seed_inventory_entry_invalid');

    expect(() =>
      build(
        [fileFact],
        [
          {
            ...complete,
            contentKind: 'text',
            byteCount: 5,
            lineCount: 1,
          },
        ]
      )
    ).toThrow('review_investigation_seed_inventory_entry_invalid');
  });

  it('fails closed when modified base object metadata is unavailable', () => {
    const fileFact = file('src/live.ts');
    const entry = modifiedEntry(fileFact.path, { beforeOid: ZERO_OID });

    expect(() => build([fileFact], [entry])).toThrow(
      'review_investigation_seed_required_object_missing'
    );
  });

  it('fails closed when a rename has no previous path', () => {
    const fileFact = file(
      'src/new-name.ts',
      ReviewInvestigationChangedFileStatus.Renamed
    );

    expect(() => build([fileFact], [addedEntry(fileFact.path)])).toThrow(
      'review_investigation_seed_rename_previous_path_missing'
    );
  });

  it('fails closed when no canonical runner inventory is supplied', () => {
    const fileFact = file('src/live.ts');

    expect(() =>
      buildReviewInvestigationSeedEnvelope({
        coverageManifest: coverage([fileFact]),
        probePlan: probePlan([fileFact]),
        requestedModel: 'gpt-test',
        reviewPrompt: 'Review the exact revision.',
      })
    ).toThrow('review_investigation_seed_inventory_missing');
  });

  it('checks the maximum after modified/base obligations are expanded', () => {
    const fileFact = file('src/live.ts');
    const plan = probePlan([fileFact]);
    const inventory = canonicalInventory([modifiedEntry(fileFact.path)]);
    const complete = buildReviewInvestigationSeedEnvelope({
      canonicalInventory: inventory,
      coverageManifest: coverage([fileFact]),
      probePlan: plan,
      requestedModel: 'gpt-test',
      reviewPrompt: 'Review the exact revision.',
    });

    expect(() =>
      buildReviewInvestigationSeedEnvelope({
        canonicalInventory: inventory,
        coverageManifest: coverage([fileFact]),
        maximumObligations: complete.envelope.obligations.length - 1,
        probePlan: plan,
        requestedModel: 'gpt-test',
        reviewPrompt: 'Review the exact revision.',
      })
    ).toThrow('review_investigation_seed_obligation_limit_exceeded');
  });

  it('rejects omitted, extra, or duplicate changed paths', () => {
    const files = [file('src/a.ts'), file('src/b.ts')];
    const plan = probePlan(files);
    const inventory = canonicalInventory([
      modifiedEntry('src/a.ts'),
      modifiedEntry('src/b.ts'),
    ]);
    const buildPaths = (paths: readonly string[]) =>
      buildReviewInvestigationSeedEnvelope({
        canonicalInventory: inventory,
        coverageManifest: {
          reviewRevisionHash: REVIEW_REVISION_HASH,
          paths: paths.map((path) => ({ path })),
        },
        probePlan: plan,
        requestedModel: 'gpt-test',
        reviewPrompt: 'Review.',
      });

    expect(() => buildPaths(['src/a.ts'])).toThrow(
      'review_investigation_seed_path_set_mismatch'
    );
    expect(() => buildPaths(['src/a.ts', 'src/b.ts', 'src/extra.ts'])).toThrow(
      'review_investigation_seed_path_set_mismatch'
    );
    expect(() => buildPaths(['src/a.ts', 'src/a.ts'])).toThrow(
      'review_investigation_seed_path_duplicate'
    );
  });

  it('keeps every deterministic probe in the canonical envelope', () => {
    const fileFact = file('src/live.ts');
    const plan = createReviewInvestigationProbePlan({
      files: [fileFact],
      fullDiff: [
        'diff --git a/src/live.ts b/src/live.ts',
        '--- a/src/live.ts',
        '+++ b/src/live.ts',
        '@@ -1 +1 @@',
        '+export function refreshAccount() {}',
      ].join('\n'),
    });
    const prepared = buildReviewInvestigationSeedEnvelope({
      canonicalInventory: canonicalInventory([modifiedEntry(fileFact.path)]),
      coverageManifest: coverage([fileFact]),
      probePlan: plan,
      requestedModel: 'gpt-test',
      reviewPrompt: 'Review the exact revision.',
    });

    for (const probe of plan.probes) {
      expect(prepared.envelope.obligations).toContainEqual(
        expect.objectContaining({
          kind: probe.obligationKind,
          canonicalSubject: probe.canonicalSubject,
          canonicalRequirement: probe.canonicalRequirement,
        })
      );
    }
  });
});

function build(
  files: readonly ReviewInvestigationChangedFileFact[],
  entries: readonly ReviewInvestigationCanonicalInventoryEntry[]
) {
  return buildReviewInvestigationSeedEnvelope({
    canonicalInventory: canonicalInventory(entries),
    coverageManifest: coverage(files),
    probePlan: probePlan(files),
    requestedModel: 'gpt-test',
    reviewPrompt: 'Review the exact revision.',
  });
}

function probePlan(files: readonly ReviewInvestigationChangedFileFact[]) {
  return createReviewInvestigationProbePlan({ files, fullDiff: '' });
}

function coverage(files: readonly ReviewInvestigationChangedFileFact[]) {
  return {
    reviewRevisionHash: REVIEW_REVISION_HASH,
    paths: files.map(({ path }) => ({ path })),
  };
}

function changedContentRequirements(
  obligations: readonly Readonly<{
    kind: ReviewTurnObligationKind;
    canonicalRequirement: string;
  }>[]
) {
  return obligations
    .filter(
      (obligation) =>
        obligation.kind === ReviewTurnObligationKind.ChangedContent
    )
    .map((obligation) => JSON.parse(obligation.canonicalRequirement));
}

function inventoryRequirement(
  obligations: readonly Readonly<{
    kind: ReviewTurnObligationKind;
    canonicalRequirement: string;
  }>[]
) {
  const obligation = obligations.find(
    (candidate) => candidate.kind === ReviewTurnObligationKind.InventoryWitness
  );
  if (!obligation) throw new Error('inventory witness missing');
  return JSON.parse(obligation.canonicalRequirement);
}

function binaryArtifactRequirements(
  obligations: readonly Readonly<{
    kind: ReviewTurnObligationKind;
    canonicalRequirement: string;
  }>[]
) {
  return obligations
    .filter(
      (obligation) =>
        obligation.kind === ReviewTurnObligationKind.BinaryArtifact
    )
    .map((obligation) => JSON.parse(obligation.canonicalRequirement));
}

function inventoryPathHashes(
  entries: readonly ReviewInvestigationCanonicalInventoryEntry[]
): readonly string[] {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (entry.beforePath !== null) paths.add(entry.beforePath);
    if (entry.afterPath !== null) paths.add(entry.afterPath);
  }
  return [...paths].map(sha256).sort();
}

function canonicalInventory(
  entries: readonly ReviewInvestigationCanonicalInventoryEntry[]
): ReviewInvestigationCanonicalInventory {
  const identity = {
    inventoryVersion: 2 as const,
    mergeBaseTreeOid: MERGE_BASE_TREE_OID,
    headTreeOid: HEAD_TREE_OID,
    entries: Object.freeze([...entries]),
  };
  return Object.freeze({
    ...identity,
    itemCount: entries.length,
    inventoryHash: sha256(canonicalJson(identity)),
  });
}

function file(
  path: string,
  status = ReviewInvestigationChangedFileStatus.Modified,
  previousPath: string | null = null
): ReviewInvestigationChangedFileFact {
  return Object.freeze({ path, previousPath, status, patch: null });
}

function modifiedEntry(
  path: string,
  overrides: Partial<ReviewInvestigationCanonicalInventoryEntry> = {}
): ReviewInvestigationCanonicalInventoryEntry {
  return entry({
    status: 'modified',
    beforePath: path,
    afterPath: path,
    beforeOid: gitOid(`${path}:before`),
    afterOid: gitOid(`${path}:after`),
    ...overrides,
  });
}

function addedEntry(
  path: string,
  overrides: Partial<ReviewInvestigationCanonicalInventoryEntry> = {}
): ReviewInvestigationCanonicalInventoryEntry {
  return entry({
    status: 'added',
    beforePath: null,
    afterPath: path,
    beforeMode: '000000',
    beforeOid: ZERO_OID,
    beforeContentKind: 'absent',
    beforeByteCount: null,
    beforeLineCount: null,
    afterOid: gitOid(`${path}:after`),
    ...overrides,
  });
}

function deletedEntry(
  path: string,
  overrides: Partial<ReviewInvestigationCanonicalInventoryEntry> = {}
): ReviewInvestigationCanonicalInventoryEntry {
  return entry({
    status: 'deleted',
    beforePath: path,
    afterPath: null,
    beforeOid: gitOid(`${path}:before`),
    afterMode: '000000',
    afterOid: ZERO_OID,
    afterContentKind: 'absent',
    afterByteCount: null,
    afterLineCount: null,
    ...overrides,
  });
}

function exactRenameEntry(
  beforePath: string,
  afterPath: string,
  oid = gitOid(`${beforePath}:${afterPath}`),
  overrides: Partial<ReviewInvestigationCanonicalInventoryEntry> = {}
): ReviewInvestigationCanonicalInventoryEntry {
  return entry({
    status: 'exact_rename',
    beforePath,
    afterPath,
    beforeOid: oid,
    afterOid: oid,
    ...overrides,
  });
}

function entry(
  input: Partial<ReviewInvestigationCanonicalInventoryEntry> &
    Pick<
      ReviewInvestigationCanonicalInventoryEntry,
      'status' | 'beforePath' | 'afterPath' | 'beforeOid' | 'afterOid'
    >
): ReviewInvestigationCanonicalInventoryEntry {
  return Object.freeze({
    beforeMode: '100644',
    afterMode: '100644',
    beforeContentKind: 'text',
    beforeByteCount: 20,
    beforeLineCount: 1,
    afterContentKind: 'text',
    afterByteCount: 20,
    afterLineCount: 1,
    contentKind: 'text',
    byteCount: 20,
    lineCount: 1,
    generated: false,
    generatedPolicySource: null,
    ...input,
  });
}

function gitOid(seed: string): string {
  return sha256(seed).slice(0, 40);
}
