import type { ReviewInvestigationProbePlan } from './deterministic-context-probe-plan';
import {
  ReviewInvestigationChangedFileStatus,
  ReviewInvestigationProbePlanStatus,
} from './deterministic-context-probe-plan';
import { canonicalJson, sha256 } from './canonical-json';
import {
  changedPathSemanticRiskPriority,
  REVIEW_INVESTIGATION_RISK_PRIORITY,
} from './semantic-risk-policy';
import { ReviewTurnObligationKind } from './turn-observation';

export const REVIEW_INVESTIGATION_SEED_ENVELOPE_CONTRACT =
  'review_investigation_seed_envelope.v1' as const;
export const REVIEW_INVESTIGATION_SEED_MAX_OBLIGATIONS = 1_024;

type ReviewInvestigationCanonicalInventoryContentKind =
  | 'text'
  | 'binary'
  | 'lfs_pointer'
  | 'symlink'
  | 'gitlink'
  | 'oversized'
  | 'absent';

export type ReviewInvestigationCanonicalInventoryEntry = Readonly<{
  status:
    | 'added'
    | 'deleted'
    | 'modified'
    | 'type_changed'
    | 'unmerged'
    | 'exact_rename';
  beforePath: string | null;
  afterPath: string | null;
  beforeMode: string;
  afterMode: string;
  beforeOid: string;
  afterOid: string;
  beforeContentKind?: ReviewInvestigationCanonicalInventoryContentKind;
  beforeByteCount?: number | null;
  beforeLineCount?: number | null;
  afterContentKind?: ReviewInvestigationCanonicalInventoryContentKind;
  afterByteCount?: number | null;
  afterLineCount?: number | null;
  contentKind: ReviewInvestigationCanonicalInventoryContentKind;
  byteCount: number | null;
  lineCount: number | null;
  generated: boolean;
  generatedPolicySource: 'path_heuristic_v1' | null;
}>;

export type ReviewInvestigationCanonicalInventory = Readonly<{
  inventoryVersion: 1 | 2;
  mergeBaseTreeOid: string;
  headTreeOid: string;
  entries: readonly ReviewInvestigationCanonicalInventoryEntry[];
  itemCount: number;
  inventoryHash: string;
}>;

export type ReviewInvestigationSeedObligation = Readonly<{
  kind: ReviewTurnObligationKind;
  canonicalSubject: string;
  canonicalRequirement: string;
  riskPriority: number;
}>;

export type ReviewInvestigationSeedEnvelope = Readonly<{
  contract: typeof REVIEW_INVESTIGATION_SEED_ENVELOPE_CONTRACT;
  obligations: readonly ReviewInvestigationSeedObligation[];
  probePlanHash: string;
  requestedModel: string;
  reviewPromptHash: string;
}>;

export type PreparedReviewInvestigationSeedEnvelope = Readonly<{
  envelope: ReviewInvestigationSeedEnvelope;
  canonicalJson: string;
  hash: string;
}>;

export function buildReviewInvestigationSeedEnvelope(input: {
  readonly coverageManifest: Readonly<{
    reviewRevisionHash: string;
    paths: readonly Readonly<{ path: string }>[];
  }>;
  readonly canonicalInventory?: ReviewInvestigationCanonicalInventory;
  readonly maximumObligations?: number;
  readonly probePlan: ReviewInvestigationProbePlan;
  readonly reviewPrompt: string;
  readonly requestedModel: string;
}): PreparedReviewInvestigationSeedEnvelope {
  if (input.probePlan.status !== ReviewInvestigationProbePlanStatus.Complete) {
    throw new Error('review_investigation_probe_plan_incomplete');
  }
  if (input.requestedModel.length === 0 || input.requestedModel.length > 256) {
    throw new Error('review_investigation_requested_model_invalid');
  }
  requireSha256(
    input.coverageManifest.reviewRevisionHash,
    'review_investigation_seed_review_revision_hash_invalid'
  );
  const maximumObligations =
    input.maximumObligations ?? REVIEW_INVESTIGATION_SEED_MAX_OBLIGATIONS;
  if (!Number.isSafeInteger(maximumObligations) || maximumObligations < 1) {
    throw new Error('review_investigation_seed_obligation_limit_invalid');
  }
  if (input.canonicalInventory === undefined) {
    throw new Error('review_investigation_seed_inventory_missing');
  }

  const paths = [...input.coverageManifest.paths]
    .map((item) => item.path)
    .sort(compareCodeUnits);
  if (new Set(paths).size !== paths.length) {
    throw new Error('review_investigation_seed_path_duplicate');
  }
  const changedPathFacts = new Map(
    input.probePlan.changedPaths.map((fact) => [fact.path, fact])
  );
  if (changedPathFacts.size !== input.probePlan.changedPaths.length) {
    throw new Error('review_investigation_seed_changed_path_duplicate');
  }
  if (
    changedPathFacts.size !== paths.length ||
    paths.some((path) => !changedPathFacts.has(path))
  ) {
    throw new Error('review_investigation_seed_path_set_mismatch');
  }

  const inventory = prepareCanonicalInventory(input.canonicalInventory);
  const inventoryIndex = indexInventoryEntries(inventory.entries);
  const changedContentTargets = new Map<
    string,
    Readonly<{ path: string; revision: 'head' | 'merge_base' }>
  >();
  const matchedInventoryEntries = new Set<NormalizedCanonicalInventoryEntry>();
  for (const fact of [...changedPathFacts.values()].sort(compareChangedPaths)) {
    for (const entry of changedPathInventoryEntries(fact, inventoryIndex)) {
      matchedInventoryEntries.add(entry);
    }
    for (const target of changedContentEvidenceTargets(fact)) {
      changedContentTargets.set(
        canonicalJson({ path: target.path, revision: target.revision }),
        target
      );
    }
  }
  const binaryArtifactObligations = [...matchedInventoryEntries]
    .flatMap(binaryArtifactBoundaryTargets)
    .map(binaryArtifactBoundaryObligation)
    .sort(compareObligations);

  const obligations = Object.freeze([
    Object.freeze({
      kind: ReviewTurnObligationKind.InventoryWitness,
      canonicalSubject: canonicalJson({
        aggregateHash: inventory.aggregateHash,
        aggregateItemCount: inventory.aggregateItemCount,
        aggregatePathCount: inventory.aggregatePathCount,
        aggregatePathSetHash: inventory.aggregatePathSetHash,
        kind: 'canonical_inventory',
        reviewRevisionHash: input.coverageManifest.reviewRevisionHash,
        subjectVersion: 2,
        treeOid: inventory.treeOid,
      }),
      canonicalRequirement: canonicalJson({
        aggregateHash: inventory.aggregateHash,
        aggregateItemCount: inventory.aggregateItemCount,
        aggregatePathCount: inventory.aggregatePathCount,
        aggregatePathSetHash: inventory.aggregatePathSetHash,
        kind: 'complete_inventory',
        requirementVersion: 2,
        reviewRevisionHash: input.coverageManifest.reviewRevisionHash,
        treeOid: inventory.treeOid,
      }),
      riskPriority: REVIEW_INVESTIGATION_RISK_PRIORITY.InventoryWitness,
    }),
    ...[...changedContentTargets.values()].map((target) => {
      const pathHash = sha256(target.path);
      return Object.freeze({
        kind: ReviewTurnObligationKind.ChangedContent,
        canonicalSubject: canonicalJson({
          kind: 'file_read',
          pathHash,
          revision: target.revision,
          subjectVersion: 1,
        }),
        canonicalRequirement: canonicalJson({
          kind: 'complete_changed_file',
          path: target.path,
          pathHash,
          requirementVersion: 2,
          revision: target.revision,
        }),
        riskPriority: changedPathSemanticRiskPriority(target.path),
      });
    }),
    ...binaryArtifactObligations,
    ...input.probePlan.probes.map((probe) =>
      Object.freeze({
        kind: probe.obligationKind,
        canonicalSubject: probe.canonicalSubject,
        canonicalRequirement: probe.canonicalRequirement,
        riskPriority: probe.riskPriority,
      })
    ),
  ] satisfies readonly ReviewInvestigationSeedObligation[]);
  if (obligations.length > maximumObligations) {
    throw new Error('review_investigation_seed_obligation_limit_exceeded');
  }
  const envelope = Object.freeze({
    contract: REVIEW_INVESTIGATION_SEED_ENVELOPE_CONTRACT,
    obligations,
    probePlanHash: input.probePlan.planHash,
    requestedModel: input.requestedModel,
    reviewPromptHash: sha256(input.reviewPrompt),
  });
  const serialized = canonicalJson(envelope);
  return Object.freeze({
    envelope,
    canonicalJson: serialized,
    hash: sha256(serialized),
  });
}

type PreparedCanonicalInventory = Readonly<{
  entries: readonly NormalizedCanonicalInventoryEntry[];
  treeOid: string;
  aggregateItemCount: number;
  aggregateHash: string;
  aggregatePathCount: number;
  aggregatePathSetHash: string;
}>;

type CanonicalInventoryIndex = ReadonlyMap<
  string,
  readonly NormalizedCanonicalInventoryEntry[]
>;

type CanonicalInventoryObjectMetadata = Readonly<{
  contentKind: ReviewInvestigationCanonicalInventoryContentKind;
  byteCount: number | null;
  lineCount: number | null;
}>;

type NormalizedCanonicalInventoryEntry =
  ReviewInvestigationCanonicalInventoryEntry &
    Readonly<{
      beforeContentKind: ReviewInvestigationCanonicalInventoryContentKind;
      beforeByteCount: number | null;
      beforeLineCount: number | null;
      afterContentKind: ReviewInvestigationCanonicalInventoryContentKind;
      afterByteCount: number | null;
      afterLineCount: number | null;
    }>;

function prepareCanonicalInventory(
  inventory: ReviewInvestigationCanonicalInventory
): PreparedCanonicalInventory {
  if (inventory.inventoryVersion !== 2) {
    throw new Error('review_investigation_seed_inventory_version_invalid');
  }
  const mergeBaseTreeOid = requireGitOid(
    inventory.mergeBaseTreeOid,
    'review_investigation_seed_merge_base_tree_oid_invalid'
  );
  const headTreeOid = requireGitOid(
    inventory.headTreeOid,
    'review_investigation_seed_head_tree_oid_invalid'
  );
  if (mergeBaseTreeOid.length !== headTreeOid.length) {
    throw new Error('review_investigation_seed_inventory_oid_width_mismatch');
  }
  if (
    !Array.isArray(inventory.entries) ||
    !Number.isSafeInteger(inventory.itemCount) ||
    inventory.itemCount !== inventory.entries.length
  ) {
    throw new Error('review_investigation_seed_inventory_item_count_invalid');
  }
  const entries = Object.freeze(
    inventory.entries.map((entry) =>
      normalizeInventoryEntry(entry, headTreeOid.length)
    )
  );
  const expectedInventoryHash = sha256(
    canonicalJson({
      inventoryVersion: 2,
      mergeBaseTreeOid,
      headTreeOid,
      entries,
    })
  );
  if (inventory.inventoryHash !== expectedInventoryHash) {
    throw new Error('review_investigation_seed_inventory_hash_mismatch');
  }
  const pathHashes = canonicalInventoryPathHashes(entries);
  return Object.freeze({
    entries,
    treeOid: headTreeOid,
    aggregateItemCount: entries.length,
    aggregateHash: sha256(canonicalJson(entries)),
    aggregatePathCount: pathHashes.length,
    aggregatePathSetHash: sha256(canonicalJson(pathHashes)),
  });
}

function normalizeInventoryEntry(
  entry: ReviewInvestigationCanonicalInventoryEntry,
  oidWidth: number
): NormalizedCanonicalInventoryEntry {
  if (!entry || typeof entry !== 'object') {
    throw new Error('review_investigation_seed_inventory_entry_invalid');
  }
  const expectedKeys = [
    'afterByteCount',
    'afterContentKind',
    'afterLineCount',
    'afterMode',
    'afterOid',
    'afterPath',
    'beforeByteCount',
    'beforeContentKind',
    'beforeLineCount',
    'beforeMode',
    'beforeOid',
    'beforePath',
    'byteCount',
    'contentKind',
    'generated',
    'generatedPolicySource',
    'lineCount',
    'status',
  ];
  const actualKeys = Object.keys(entry).sort(compareCodeUnits);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error('review_investigation_seed_inventory_entry_invalid');
  }
  if (
    !['added', 'deleted', 'modified', 'type_changed', 'exact_rename'].includes(
      entry.status
    ) ||
    !isCanonicalContentKind(entry.contentKind) ||
    !/^[0-7]{6}$/u.test(entry.beforeMode) ||
    !/^[0-7]{6}$/u.test(entry.afterMode) ||
    typeof entry.generated !== 'boolean' ||
    (entry.generatedPolicySource !== null &&
      entry.generatedPolicySource !== 'path_heuristic_v1') ||
    !isOptionalCount(entry.byteCount) ||
    !isOptionalCount(entry.lineCount)
  ) {
    throw new Error('review_investigation_seed_inventory_entry_invalid');
  }
  const beforeOid = requireGitOidOrZero(
    entry.beforeOid,
    oidWidth,
    'review_investigation_seed_inventory_before_oid_invalid'
  );
  const afterOid = requireGitOidOrZero(
    entry.afterOid,
    oidWidth,
    'review_investigation_seed_inventory_after_oid_invalid'
  );
  const beforePath = optionalPath(entry.beforePath);
  const afterPath = optionalPath(entry.afterPath);
  switch (entry.status) {
    case 'added':
      requirePresentOid(afterOid);
      if (beforePath !== null || afterPath === null || !isZeroOid(beforeOid)) {
        throw new Error('review_investigation_seed_inventory_entry_invalid');
      }
      break;
    case 'deleted':
      requirePresentOid(beforeOid);
      if (beforePath === null || afterPath !== null || !isZeroOid(afterOid)) {
        throw new Error('review_investigation_seed_inventory_entry_invalid');
      }
      break;
    case 'modified':
    case 'type_changed':
      requirePresentOid(beforeOid);
      requirePresentOid(afterOid);
      if (
        beforePath === null ||
        afterPath === null ||
        beforePath !== afterPath
      ) {
        throw new Error('review_investigation_seed_inventory_entry_invalid');
      }
      break;
    case 'exact_rename':
      requirePresentOid(beforeOid);
      if (
        beforePath === null ||
        afterPath === null ||
        beforePath === afterPath ||
        beforeOid !== afterOid
      ) {
        throw new Error('review_investigation_seed_inventory_entry_invalid');
      }
      break;
  }
  const beforeMetadata = normalizeObjectMetadata(
    entry.beforeContentKind,
    entry.beforeByteCount,
    entry.beforeLineCount,
    entry.beforeMode,
    beforeOid
  );
  const afterMetadata = normalizeObjectMetadata(
    entry.afterContentKind,
    entry.afterByteCount,
    entry.afterLineCount,
    entry.afterMode,
    afterOid
  );
  const activeMetadata =
    entry.status === 'deleted' ? beforeMetadata : afterMetadata;
  if (
    entry.contentKind !== activeMetadata.contentKind ||
    entry.byteCount !== activeMetadata.byteCount ||
    entry.lineCount !== activeMetadata.lineCount
  ) {
    throw new Error('review_investigation_seed_inventory_entry_invalid');
  }
  return Object.freeze({
    status: entry.status,
    beforePath,
    afterPath,
    beforeMode: entry.beforeMode,
    afterMode: entry.afterMode,
    beforeOid,
    afterOid,
    beforeContentKind: beforeMetadata.contentKind,
    beforeByteCount: beforeMetadata.byteCount,
    beforeLineCount: beforeMetadata.lineCount,
    afterContentKind: afterMetadata.contentKind,
    afterByteCount: afterMetadata.byteCount,
    afterLineCount: afterMetadata.lineCount,
    contentKind: entry.contentKind,
    byteCount: entry.byteCount,
    lineCount: entry.lineCount,
    generated: entry.generated,
    generatedPolicySource: entry.generatedPolicySource,
  });
}

function normalizeObjectMetadata(
  contentKind: unknown,
  byteCount: unknown,
  lineCount: unknown,
  mode: string,
  oid: string
): CanonicalInventoryObjectMetadata {
  if (
    !isCanonicalContentKind(contentKind) ||
    !isOptionalCount(byteCount) ||
    !isOptionalCount(lineCount)
  ) {
    throw new Error('review_investigation_seed_inventory_entry_invalid');
  }
  const absent = isZeroOid(oid);
  const requiresByteCount = [
    'text',
    'binary',
    'lfs_pointer',
    'symlink',
    'oversized',
  ].includes(contentKind);
  const requiresLineCount = ['text', 'lfs_pointer'].includes(contentKind);
  if (
    (absent &&
      (mode !== '000000' ||
        contentKind !== 'absent' ||
        byteCount !== null ||
        lineCount !== null)) ||
    (!absent && contentKind === 'absent') ||
    (mode === '160000' &&
      (contentKind !== 'gitlink' ||
        byteCount !== null ||
        lineCount !== null)) ||
    (mode !== '160000' && contentKind === 'gitlink') ||
    (requiresByteCount && byteCount === null) ||
    (!requiresByteCount && byteCount !== null) ||
    (requiresLineCount && lineCount === null) ||
    (!requiresLineCount && lineCount !== null)
  ) {
    throw new Error('review_investigation_seed_inventory_entry_invalid');
  }
  return Object.freeze({ contentKind, byteCount, lineCount });
}

function isCanonicalContentKind(
  value: unknown
): value is ReviewInvestigationCanonicalInventoryContentKind {
  return [
    'text',
    'binary',
    'lfs_pointer',
    'symlink',
    'gitlink',
    'oversized',
    'absent',
  ].includes(value as ReviewInvestigationCanonicalInventoryContentKind);
}

function changedPathInventoryEntries(
  fact: ReviewInvestigationProbePlan['changedPaths'][number],
  inventoryIndex: CanonicalInventoryIndex
): readonly NormalizedCanonicalInventoryEntry[] {
  switch (fact.status) {
    case ReviewInvestigationChangedFileStatus.Added: {
      if (fact.previousPath !== null) throw changedPathMismatch();
      const entry = exactlyOne(
        inventoryEntries(inventoryIndex, 'added', null, fact.path)
      );
      requirePresentOid(entry.afterOid);
      return [entry];
    }
    case ReviewInvestigationChangedFileStatus.Modified: {
      if (fact.previousPath !== null) throw changedPathMismatch();
      const entry = exactlyOne([
        ...inventoryEntries(inventoryIndex, 'modified', fact.path, fact.path),
        ...inventoryEntries(
          inventoryIndex,
          'type_changed',
          fact.path,
          fact.path
        ),
      ]);
      requirePresentOid(entry.beforeOid);
      requirePresentOid(entry.afterOid);
      return [entry];
    }
    case ReviewInvestigationChangedFileStatus.Removed: {
      if (fact.previousPath !== null) throw changedPathMismatch();
      const entry = exactlyOne(
        inventoryEntries(inventoryIndex, 'deleted', fact.path, null)
      );
      requirePresentOid(entry.beforeOid);
      return [entry];
    }
    case ReviewInvestigationChangedFileStatus.Renamed: {
      if (fact.previousPath === null || fact.previousPath === fact.path) {
        throw new Error(
          'review_investigation_seed_rename_previous_path_missing'
        );
      }
      const exactRenames = inventoryEntries(
        inventoryIndex,
        'exact_rename',
        fact.previousPath,
        fact.path
      );
      if (exactRenames.length === 1) {
        requirePresentOid(exactRenames[0]!.beforeOid);
        requirePresentOid(exactRenames[0]!.afterOid);
        return [exactRenames[0]!];
      }
      if (exactRenames.length > 1) throw changedPathMismatch();
      const deleted = exactlyOne(
        inventoryEntries(inventoryIndex, 'deleted', fact.previousPath, null)
      );
      const added = exactlyOne(
        inventoryEntries(inventoryIndex, 'added', null, fact.path)
      );
      requirePresentOid(deleted.beforeOid);
      requirePresentOid(added.afterOid);
      return [deleted, added];
    }
  }
}

type BinaryArtifactBoundaryTarget = Readonly<{
  entry: NormalizedCanonicalInventoryEntry;
  path: string;
  revision: 'head' | 'merge_base';
  objectOid: string;
  mode: string;
  metadata: CanonicalInventoryObjectMetadata;
}>;

function binaryArtifactBoundaryTargets(
  entry: NormalizedCanonicalInventoryEntry
): readonly BinaryArtifactBoundaryTarget[] {
  const targets: BinaryArtifactBoundaryTarget[] = [];
  if (
    entry.beforePath !== null &&
    requiresBinaryArtifactBoundary(entry.beforeContentKind)
  ) {
    targets.push(
      Object.freeze({
        entry,
        path: entry.beforePath,
        revision: 'merge_base',
        objectOid: entry.beforeOid,
        mode: entry.beforeMode,
        metadata: Object.freeze({
          contentKind: entry.beforeContentKind,
          byteCount: entry.beforeByteCount,
          lineCount: entry.beforeLineCount,
        }),
      })
    );
  }
  if (
    entry.afterPath !== null &&
    requiresBinaryArtifactBoundary(entry.afterContentKind)
  ) {
    targets.push(
      Object.freeze({
        entry,
        path: entry.afterPath,
        revision: 'head',
        objectOid: entry.afterOid,
        mode: entry.afterMode,
        metadata: Object.freeze({
          contentKind: entry.afterContentKind,
          byteCount: entry.afterByteCount,
          lineCount: entry.afterLineCount,
        }),
      })
    );
  }
  return Object.freeze(targets);
}

function binaryArtifactBoundaryObligation(
  target: BinaryArtifactBoundaryTarget
): ReviewInvestigationSeedObligation {
  requirePresentOid(target.objectOid);
  const pathHash = sha256(target.path);
  return Object.freeze({
    kind: ReviewTurnObligationKind.BinaryArtifact,
    canonicalSubject: canonicalJson({
      contentKind: target.metadata.contentKind,
      kind: ReviewTurnObligationKind.BinaryArtifact,
      objectOid: target.objectOid,
      pathHash,
      revision: target.revision,
      subjectVersion: 1,
    }),
    canonicalRequirement: canonicalJson({
      byteCount: target.metadata.byteCount,
      contentKind: target.metadata.contentKind,
      kind: 'binary_artifact_boundary',
      mode: target.mode,
      objectOid: target.objectOid,
      path: target.path,
      pathHash,
      requirementVersion: 1,
      revision: target.revision,
      status: target.entry.status,
    }),
    riskPriority: changedPathSemanticRiskPriority(target.path),
  });
}

function requiresBinaryArtifactBoundary(
  contentKind: ReviewInvestigationCanonicalInventoryContentKind
): boolean {
  switch (contentKind) {
    case 'binary':
    case 'lfs_pointer':
    case 'gitlink':
    case 'oversized':
      return true;
    case 'text':
    case 'symlink':
    case 'absent':
      return false;
  }
}

function canonicalInventoryPathHashes(
  entries: readonly ReviewInvestigationCanonicalInventoryEntry[]
): readonly string[] {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (entry.beforePath !== null) paths.add(entry.beforePath);
    if (entry.afterPath !== null) paths.add(entry.afterPath);
  }
  return [...paths].map(sha256).sort(compareCodeUnits);
}

function compareObligations(
  left: ReviewInvestigationSeedObligation,
  right: ReviewInvestigationSeedObligation
): number {
  return (
    compareCodeUnits(left.canonicalSubject, right.canonicalSubject) ||
    compareCodeUnits(left.canonicalRequirement, right.canonicalRequirement)
  );
}

function changedContentEvidenceTargets(
  fact: ReviewInvestigationProbePlan['changedPaths'][number]
): readonly Readonly<{ path: string; revision: 'head' | 'merge_base' }>[] {
  switch (fact.status) {
    case ReviewInvestigationChangedFileStatus.Added:
      return [Object.freeze({ path: fact.path, revision: 'head' })];
    case ReviewInvestigationChangedFileStatus.Modified:
      return [
        Object.freeze({ path: fact.path, revision: 'merge_base' }),
        Object.freeze({ path: fact.path, revision: 'head' }),
      ];
    case ReviewInvestigationChangedFileStatus.Removed:
      return [Object.freeze({ path: fact.path, revision: 'merge_base' })];
    case ReviewInvestigationChangedFileStatus.Renamed:
      if (fact.previousPath === null) {
        throw new Error(
          'review_investigation_seed_rename_previous_path_missing'
        );
      }
      return [
        Object.freeze({ path: fact.previousPath, revision: 'merge_base' }),
        Object.freeze({ path: fact.path, revision: 'head' }),
      ];
  }
}

function indexInventoryEntries(
  entries: readonly NormalizedCanonicalInventoryEntry[]
): CanonicalInventoryIndex {
  const index = new Map<string, NormalizedCanonicalInventoryEntry[]>();
  for (const entry of entries) {
    const key = inventoryPathKey(
      entry.status,
      entry.beforePath,
      entry.afterPath
    );
    const matches = index.get(key) ?? [];
    matches.push(entry);
    index.set(key, matches);
  }
  return index;
}

function inventoryEntries(
  index: CanonicalInventoryIndex,
  status: NormalizedCanonicalInventoryEntry['status'],
  beforePath: string | null,
  afterPath: string | null
): readonly NormalizedCanonicalInventoryEntry[] {
  return index.get(inventoryPathKey(status, beforePath, afterPath)) ?? [];
}

function inventoryPathKey(
  status: NormalizedCanonicalInventoryEntry['status'],
  beforePath: string | null,
  afterPath: string | null
): string {
  return canonicalJson({ status, beforePath, afterPath });
}

function exactlyOne(
  matches: readonly NormalizedCanonicalInventoryEntry[]
): NormalizedCanonicalInventoryEntry {
  if (matches.length !== 1) throw changedPathMismatch();
  return matches[0]!;
}

function changedPathMismatch(): Error {
  return new Error('review_investigation_seed_inventory_changed_path_mismatch');
}

function requirePresentOid(value: string): void {
  if (isZeroOid(value)) {
    throw new Error('review_investigation_seed_required_object_missing');
  }
}

function requireGitOid(value: string, errorCode: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value) || isZeroOid(value)) {
    throw new Error(errorCode);
  }
  return value;
}

function requireGitOidOrZero(
  value: string,
  oidWidth: number,
  errorCode: string
): string {
  if (
    typeof value !== 'string' ||
    value.length !== oidWidth ||
    !/^[a-f0-9]+$/u.test(value)
  ) {
    throw new Error(errorCode);
  }
  return value;
}

function requireSha256(value: string, errorCode: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(errorCode);
}

function optionalPath(value: string | null): string | null {
  if (value === null) return null;
  if (value.length === 0 || value.length > 2_000 || value.includes('\0')) {
    throw new Error('review_investigation_seed_inventory_path_invalid');
  }
  return value;
}

function isOptionalCount(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  );
}

function isZeroOid(value: string): boolean {
  return /^0+$/u.test(value);
}

function compareChangedPaths(
  left: ReviewInvestigationProbePlan['changedPaths'][number],
  right: ReviewInvestigationProbePlan['changedPaths'][number]
): number {
  return (
    compareCodeUnits(left.path, right.path) ||
    compareCodeUnits(left.previousPath ?? '', right.previousPath ?? '') ||
    compareCodeUnits(left.status, right.status)
  );
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
