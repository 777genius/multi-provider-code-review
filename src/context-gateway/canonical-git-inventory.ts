import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  canonicalJson,
  requireGitOid,
  sha256,
} from './context-gateway-contract';

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
  contentKind: CanonicalInventoryContentKind;
  byteCount: number | null;
  lineCount: number | null;
  generated: boolean;
  generatedPolicySource: 'path_heuristic_v1' | null;
}>;

export type CanonicalGitInventory = Readonly<{
  inventoryVersion: 1;
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
  const entries = await Promise.all(
    paired.map((entry) => materializeEntry(input.root, entry))
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
      inventoryVersion: 1,
      mergeBaseTreeOid: normalizedMergeBaseTreeOid,
      headTreeOid: normalizedHeadTreeOid,
      entries,
    })
  );
  return Object.freeze({
    inventoryVersion: 1,
    mergeBaseTreeOid: normalizedMergeBaseTreeOid,
    headTreeOid: normalizedHeadTreeOid,
    entries: Object.freeze(entries),
    itemCount: entries.length,
    inventoryHash,
  });
}

function parseRawInventory(raw: Buffer): RawInventoryEntry[] {
  const tokens = raw.toString('utf8').split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  if (tokens.length % 2 !== 0) {
    throw new Error('canonical_inventory_raw_shape_invalid');
  }
  const entries: RawInventoryEntry[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const record = tokens[index];
    const path = tokens[index + 1];
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
    group.sort((left, right) => left.path.localeCompare(right.path));
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
      }>
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
  const activeMode = deleted ? entry.beforeMode : entry.afterMode;
  const activeOid = deleted ? entry.beforeOid : entry.afterOid;
  const metadata = await classifyObject(root, activeMode, activeOid);
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
    ...metadata,
    generated,
    generatedPolicySource: generated ? 'path_heuristic_v1' : null,
  });
}

async function classifyObject(
  root: string,
  mode: string,
  oid: string
): Promise<{
  contentKind: CanonicalInventoryContentKind;
  byteCount: number | null;
  lineCount: number | null;
}> {
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
  if (content.includes(0)) {
    return {
      contentKind: CanonicalInventoryContentKind.Binary,
      byteCount: content.byteLength,
      lineCount: null,
    };
  }
  const text = content.toString('utf8');
  if (text.startsWith('version https://git-lfs.github.com/spec/v1\n')) {
    return {
      contentKind: CanonicalInventoryContentKind.LfsPointer,
      byteCount: content.byteLength,
      lineCount: lineCount(text),
    };
  }
  return {
    contentKind: CanonicalInventoryContentKind.Text,
    byteCount: content.byteLength,
    lineCount: lineCount(text),
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
  return `${left.afterPath ?? left.beforePath}\0${left.status}\0${left.beforePath ?? ''}`.localeCompare(
    `${right.afterPath ?? right.beforePath}\0${right.status}\0${right.beforePath ?? ''}`
  );
}

function isGeneratedPath(value: string): boolean {
  return /(?:^|\/)(?:generated|gen|dist|vendor)\/|(?:\.generated\.|\.g\.|\.pb\.)/u.test(
    value
  );
}

function lineCount(value: string): number {
  if (value.length === 0) return 0;
  return value.split('\n').length - (value.endsWith('\n') ? 1 : 0);
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
