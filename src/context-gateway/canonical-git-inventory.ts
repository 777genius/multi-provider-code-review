import { execFile } from 'child_process';
import { promisify, TextDecoder } from 'util';
import {
  canonicalJson,
  requireGitOid,
  sha256,
} from './context-gateway-contract';
import { classifyUtf8Content } from './utf8-content';

const execFileAsync = promisify(execFile);
const RAW_RECORD = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])$/u;
const MAX_CLASSIFIED_BLOB_BYTES = 2 * 1024 * 1024;
const MAX_INVENTORY_ENTRIES = 250_000;

export enum CanonicalInventoryStatus {
  Added = 'added',
  Deleted = 'deleted',
  Modified = 'modified',
  TypeChanged = 'type_changed',
  Unmerged = 'unmerged',
  ExactRename = 'exact_rename',
}

export enum CanonicalInventoryContentKind {
  Text = 'text',
  Binary = 'binary',
  LfsPointer = 'lfs_pointer',
  Symlink = 'symlink',
  Gitlink = 'gitlink',
  Oversized = 'oversized',
  Absent = 'absent',
}

export type CanonicalInventoryEntry = Readonly<{
  status: CanonicalInventoryStatus;
  beforePath: string | null;
  afterPath: string | null;
  beforeMode: string;
  afterMode: string;
  beforeOid: string;
  afterOid: string;
  beforeContentKind: CanonicalInventoryContentKind;
  beforeByteCount: number | null;
  beforeLineCount: number | null;
  afterContentKind: CanonicalInventoryContentKind;
  afterByteCount: number | null;
  afterLineCount: number | null;
  // Compatibility projection for consumers that display the active-side object.
  contentKind: CanonicalInventoryContentKind;
  byteCount: number | null;
  lineCount: number | null;
  generated: boolean;
  generatedPolicySource: 'path_heuristic_v1' | null;
}>;

export type CanonicalGitInventory = Readonly<{
  inventoryVersion: 2;
  mergeBaseTreeOid: string;
  headTreeOid: string;
  entries: readonly CanonicalInventoryEntry[];
  itemCount: number;
  inventoryHash: string;
}>;

type RawInventoryEntry = Readonly<{
  status: Exclude<
    CanonicalInventoryStatus,
    CanonicalInventoryStatus.ExactRename
  >;
  path: string;
  beforeMode: string;
  afterMode: string;
  beforeOid: string;
  afterOid: string;
}>;

export async function buildCanonicalGitInventory(input: {
  readonly root: string;
  readonly mergeBaseSha: string;
  readonly headSha: string;
}): Promise<CanonicalGitInventory> {
  requireGitOid(input.mergeBaseSha, 'canonical_inventory_merge_base_sha');
  requireGitOid(input.headSha, 'canonical_inventory_head_sha');
  const [raw, mergeBaseTreeOid, headTreeOid] = await Promise.all([
    gitBuffer(input.root, [
      'diff-tree',
      '-r',
      '--raw',
      '-z',
      '--no-commit-id',
      '--no-abbrev',
      '--no-renames',
      input.mergeBaseSha,
      input.headSha,
    ]),
    gitText(input.root, ['rev-parse', `${input.mergeBaseSha}^{tree}`]),
    gitText(input.root, ['rev-parse', `${input.headSha}^{tree}`]),
  ]);
  const rawEntries = parseRawInventory(raw);
  if (rawEntries.length > MAX_INVENTORY_ENTRIES) {
    throw new Error('canonical_inventory_entry_limit_exceeded');
  }
  const paired = pairExactRenames(rawEntries);
  const metadata = new Map<string, Promise<CanonicalObjectMetadata>>();
  const entries = await Promise.all(
    paired.map((entry) => materializeEntry(input.root, entry, metadata))
  );
  entries.sort(compareInventoryEntries);
  const normalizedMergeBaseTreeOid = requireGitOid(
    mergeBaseTreeOid.trim().toLowerCase(),
    'canonical_inventory_merge_base_tree_oid'
  );
  const normalizedHeadTreeOid = requireGitOid(
    headTreeOid.trim().toLowerCase(),
    'canonical_inventory_head_tree_oid'
  );
  const inventoryHash = sha256(
    canonicalJson({
      inventoryVersion: 2,
      mergeBaseTreeOid: normalizedMergeBaseTreeOid,
      headTreeOid: normalizedHeadTreeOid,
      entries,
    })
  );
  return Object.freeze({
    inventoryVersion: 2,
    mergeBaseTreeOid: normalizedMergeBaseTreeOid,
    headTreeOid: normalizedHeadTreeOid,
    entries: Object.freeze(entries),
    itemCount: entries.length,
    inventoryHash,
  });
}

function parseRawInventory(raw: Buffer): RawInventoryEntry[] {
  const tokens = splitNulTerminated(raw);
  if (tokens.length % 2 !== 0) {
    throw new Error('canonical_inventory_raw_shape_invalid');
  }
  const entries: RawInventoryEntry[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const record = decodeUtf8(
      tokens[index]!,
      'canonical_inventory_raw_record_encoding_invalid'
    );
    const path = decodeUtf8(
      tokens[index + 1]!,
      'canonical_inventory_path_encoding_invalid'
    );
    const match = RAW_RECORD.exec(record);
    if (!match || !path || path.includes('\0')) {
      throw new Error('canonical_inventory_raw_record_invalid');
    }
    entries.push(
      Object.freeze({
        status: rawStatus(match[5]),
        path,
        beforeMode: match[1],
        afterMode: match[2],
        beforeOid: requireGitOidOrZero(match[3]),
        afterOid: requireGitOidOrZero(match[4]),
      })
    );
  }
  return entries;
}

function splitNulTerminated(raw: Buffer): readonly Buffer[] {
  if (raw.length === 0) return [];
  if (raw.at(-1) !== 0) {
    throw new Error('canonical_inventory_raw_shape_invalid');
  }
  const tokens: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0) continue;
    tokens.push(raw.subarray(start, index));
    start = index + 1;
  }
  return tokens;
}

function decodeUtf8(value: Buffer, errorCode: string): string {
  try {
    return new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(value);
  } catch {
    throw new Error(errorCode);
  }
}

function pairExactRenames(entries: readonly RawInventoryEntry[]): Array<
  | RawInventoryEntry
  | Readonly<{
      status: CanonicalInventoryStatus.ExactRename;
      beforePath: string;
      afterPath: string;
      beforeMode: string;
      afterMode: string;
      beforeOid: string;
      afterOid: string;
    }>
> {
  const deletesByOid = groupRenameCandidates(
    entries.filter(
      (entry) => entry.status === CanonicalInventoryStatus.Deleted
    ),
    (entry) => entry.beforeOid
  );
  const addsByOid = groupRenameCandidates(
    entries.filter((entry) => entry.status === CanonicalInventoryStatus.Added),
    (entry) => entry.afterOid
  );
  const consumed = new Set<RawInventoryEntry>();
  const renamed: Array<{
    status: CanonicalInventoryStatus.ExactRename;
    beforePath: string;
    afterPath: string;
    beforeMode: string;
    afterMode: string;
    beforeOid: string;
    afterOid: string;
  }> = [];
  for (const oid of [...deletesByOid.keys()].sort()) {
    const deleted = deletesByOid.get(oid) ?? [];
    const added = addsByOid.get(oid) ?? [];
    const pairs = Math.min(deleted.length, added.length);
    for (let index = 0; index < pairs; index += 1) {
      const before = deleted[index];
      const after = added[index];
      consumed.add(before);
      consumed.add(after);
      renamed.push({
        status: CanonicalInventoryStatus.ExactRename,
        beforePath: before.path,
        afterPath: after.path,
        beforeMode: before.beforeMode,
        afterMode: after.afterMode,
        beforeOid: before.beforeOid,
        afterOid: after.afterOid,
      });
    }
  }
  return [...entries.filter((entry) => !consumed.has(entry)), ...renamed];
}

function groupRenameCandidates(
  entries: readonly RawInventoryEntry[],
  oid: (entry: RawInventoryEntry) => string
): Map<string, RawInventoryEntry[]> {
  const groups = new Map<string, RawInventoryEntry[]>();
  for (const entry of entries) {
    const candidateOid = oid(entry);
    const mode =
      entry.status === CanonicalInventoryStatus.Deleted
        ? entry.beforeMode
        : entry.afterMode;
    if (/^0+$/u.test(candidateOid) || mode === '160000') continue;
    const group = groups.get(candidateOid) ?? [];
    group.push(entry);
    groups.set(candidateOid, group);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => compareCodeUnits(left.path, right.path));
  }
  return groups;
}

async function materializeEntry(
  root: string,
  entry:
    | RawInventoryEntry
    | Readonly<{
        status: CanonicalInventoryStatus.ExactRename;
        beforePath: string;
        afterPath: string;
        beforeMode: string;
        afterMode: string;
        beforeOid: string;
        afterOid: string;
      }>,
  metadata: Map<string, Promise<CanonicalObjectMetadata>>
): Promise<CanonicalInventoryEntry> {
  const deleted = entry.status === CanonicalInventoryStatus.Deleted;
  const beforePath =
    entry.status === CanonicalInventoryStatus.ExactRename
      ? entry.beforePath
      : entry.status === CanonicalInventoryStatus.Added
        ? null
        : entry.path;
  const afterPath =
    entry.status === CanonicalInventoryStatus.ExactRename
      ? entry.afterPath
      : deleted
        ? null
        : entry.path;
  const [beforeMetadata, afterMetadata] = await Promise.all([
    classifyObjectCached(root, entry.beforeMode, entry.beforeOid, metadata),
    classifyObjectCached(root, entry.afterMode, entry.afterOid, metadata),
  ]);
  const activeMetadata = deleted ? beforeMetadata : afterMetadata;
  const generatedPath = afterPath ?? beforePath ?? '';
  const generated = isGeneratedPath(generatedPath);
  return Object.freeze({
    status: entry.status,
    beforePath,
    afterPath,
    beforeMode: entry.beforeMode,
    afterMode: entry.afterMode,
    beforeOid: entry.beforeOid,
    afterOid: entry.afterOid,
    beforeContentKind: beforeMetadata.contentKind,
    beforeByteCount: beforeMetadata.byteCount,
    beforeLineCount: beforeMetadata.lineCount,
    afterContentKind: afterMetadata.contentKind,
    afterByteCount: afterMetadata.byteCount,
    afterLineCount: afterMetadata.lineCount,
    ...activeMetadata,
    generated,
    generatedPolicySource: generated ? 'path_heuristic_v1' : null,
  });
}

type CanonicalObjectMetadata = Readonly<{
  contentKind: CanonicalInventoryContentKind;
  byteCount: number | null;
  lineCount: number | null;
}>;

function classifyObjectCached(
  root: string,
  mode: string,
  oid: string,
  cache: Map<string, Promise<CanonicalObjectMetadata>>
): Promise<CanonicalObjectMetadata> {
  const key = `${mode}\0${oid}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const classified = classifyObject(root, mode, oid);
  cache.set(key, classified);
  return classified;
}

async function classifyObject(
  root: string,
  mode: string,
  oid: string
): Promise<CanonicalObjectMetadata> {
  if (/^0+$/u.test(oid)) {
    return {
      contentKind: CanonicalInventoryContentKind.Absent,
      byteCount: null,
      lineCount: null,
    };
  }
  if (mode === '160000') {
    return {
      contentKind: CanonicalInventoryContentKind.Gitlink,
      byteCount: null,
      lineCount: null,
    };
  }
  const size = Number.parseInt(
    (await gitText(root, ['cat-file', '-s', oid])).trim(),
    10
  );
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error('canonical_inventory_blob_size_invalid');
  }
  if (size > MAX_CLASSIFIED_BLOB_BYTES) {
    return {
      contentKind: CanonicalInventoryContentKind.Oversized,
      byteCount: size,
      lineCount: null,
    };
  }
  const content = await gitBuffer(
    root,
    ['cat-file', 'blob', oid],
    MAX_CLASSIFIED_BLOB_BYTES + 1
  );
  if (mode === '120000') {
    return {
      contentKind: CanonicalInventoryContentKind.Symlink,
      byteCount: content.byteLength,
      lineCount: null,
    };
  }
  const classified = classifyUtf8Content(content);
  if (classified.kind === 'binary') {
    return {
      contentKind: CanonicalInventoryContentKind.Binary,
      byteCount: content.byteLength,
      lineCount: null,
    };
  }
  const text = classified.text;
  if (text.startsWith('version https://git-lfs.github.com/spec/v1\n')) {
    return {
      contentKind: CanonicalInventoryContentKind.LfsPointer,
      byteCount: content.byteLength,
      lineCount: classified.lineCount,
    };
  }
  return {
    contentKind: CanonicalInventoryContentKind.Text,
    byteCount: content.byteLength,
    lineCount: classified.lineCount,
  };
}

function rawStatus(value: string): RawInventoryEntry['status'] {
  switch (value) {
    case 'A':
      return CanonicalInventoryStatus.Added;
    case 'D':
      return CanonicalInventoryStatus.Deleted;
    case 'M':
      return CanonicalInventoryStatus.Modified;
    case 'T':
      return CanonicalInventoryStatus.TypeChanged;
    case 'U':
      return CanonicalInventoryStatus.Unmerged;
    default:
      throw new Error('canonical_inventory_status_invalid');
  }
}

function requireGitOidOrZero(value: string): string {
  if (/^0{40}$|^0{64}$/u.test(value)) return value;
  return requireGitOid(value.toLowerCase(), 'canonical_inventory_object_oid');
}

function compareInventoryEntries(
  left: CanonicalInventoryEntry,
  right: CanonicalInventoryEntry
): number {
  return compareCodeUnits(
    `${left.afterPath ?? left.beforePath}\0${left.status}\0${left.beforePath ?? ''}`,
    `${right.afterPath ?? right.beforePath}\0${right.status}\0${right.beforePath ?? ''}`
  );
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isGeneratedPath(value: string): boolean {
  return /(?:^|\/)(?:generated|gen|dist|vendor)\/|(?:\.generated\.|\.g\.|\.pb\.)/u.test(
    value
  );
}

async function gitText(root: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', args, gitOptions(root, 'utf8')))
    .stdout as string;
}

async function gitBuffer(
  root: string,
  args: readonly string[],
  maxBuffer = 32 * 1024 * 1024
): Promise<Buffer> {
  return (
    await execFileAsync('git', args, {
      ...gitOptions(root, 'buffer'),
      maxBuffer,
    })
  ).stdout as Buffer;
}

function gitOptions(root: string, encoding: 'utf8' | 'buffer') {
  return {
    cwd: root,
    encoding,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
    env: {
      PATH: process.env.PATH,
      GIT_ATTR_NOSYSTEM: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  } as const;
}
