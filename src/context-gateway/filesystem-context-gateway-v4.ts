import { execFile } from 'child_process';
import { realpath } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import {
  buildCanonicalGitInventory,
  type CanonicalInventoryEntry,
} from './canonical-git-inventory';
import {
  canonicalJson,
  keyedSha256,
  requireGitOid,
  sha256,
} from './context-gateway-contract';
import {
  CONTEXT_GATEWAY_V4_POLICY_VERSION,
  CONTEXT_GATEWAY_V4_PAGE_MAX_ITEMS,
  ContextGatewayV4OperationKind,
  ContextGatewayV4Revision,
  ContextOperationFailureClass,
  classifyContextGatewayV4Failure,
  createContextGatewayV4PageReceipt,
  decodeContextGatewayV4Cursor,
  type ContextGatewayV4PageReceipt,
} from './context-gateway-v4-contract';
import { ContextGatewayV4Recorder } from './context-gateway-v4-recorder';
import { ContextGatewayV4ReplayMaterialRecorder } from './context-gateway-v4-replay-material';
import { classifyUtf8Content } from './utf8-content';

const execFileAsync = promisify(execFile);
const MAX_FILE_RANGE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_DIRECTORY_RESULTS = 250_000;
const MAX_SEARCH_RESULTS = 100_000;

export class FilesystemContextGatewayV4 {
  private inventoryPromise: ReturnType<
    typeof buildCanonicalGitInventory
  > | null = null;

  private constructor(
    private readonly root: string,
    private readonly sessionId: string,
    private readonly mergeBaseSha: string,
    private readonly headSha: string,
    private readonly mergeBaseTreeOid: string,
    private readonly headTreeOid: string,
    private readonly secret: Buffer,
    private readonly recorder: ContextGatewayV4Recorder,
    private readonly replayMaterial: ContextGatewayV4ReplayMaterialRecorder | null,
    private readonly now: () => number
  ) {}

  static async create(input: {
    readonly root: string;
    readonly sessionId: string;
    readonly checkoutTreeOid: string;
    readonly mergeBaseSha: string;
    readonly headSha: string;
    readonly secret: Buffer;
    readonly recorder: ContextGatewayV4Recorder;
    readonly replayMaterial?: ContextGatewayV4ReplayMaterialRecorder;
    readonly now?: () => number;
  }): Promise<FilesystemContextGatewayV4> {
    const root = await realpath(input.root);
    requireGitOid(
      input.checkoutTreeOid,
      'context_gateway_v4_checkout_tree_oid'
    );
    requireGitOid(input.mergeBaseSha, 'context_gateway_v4_merge_base_sha');
    requireGitOid(input.headSha, 'context_gateway_v4_head_sha');
    if (!Buffer.isBuffer(input.secret) || input.secret.byteLength < 32) {
      throw new Error('context_gateway_v4_secret_invalid');
    }
    const [mergeBaseTreeOid, headTreeOid] = await Promise.all([
      gitText(root, ['rev-parse', `${input.mergeBaseSha}^{tree}`]),
      gitText(root, ['rev-parse', `${input.headSha}^{tree}`]),
    ]);
    const normalizedMergeBaseTreeOid = requireGitOid(
      mergeBaseTreeOid.trim().toLowerCase(),
      'context_gateway_v4_merge_base_tree_oid'
    );
    const normalizedHeadTreeOid = requireGitOid(
      headTreeOid.trim().toLowerCase(),
      'context_gateway_v4_head_tree_oid'
    );
    if (normalizedHeadTreeOid !== input.checkoutTreeOid) {
      throw new Error('context_gateway_checkout_tree_mismatch');
    }
    return new FilesystemContextGatewayV4(
      root,
      input.sessionId,
      input.mergeBaseSha,
      input.headSha,
      normalizedMergeBaseTreeOid,
      normalizedHeadTreeOid,
      input.secret,
      input.recorder,
      input.replayMaterial ?? null,
      input.now ?? Date.now
    );
  }

  async readFile(input: {
    readonly path: string;
    readonly revision?: ContextGatewayV4Revision;
    readonly startByte?: number;
    readonly maxBytes?: number;
  }) {
    const replayInput = normalizeFileReadInput(input);
    const operation = this.operation(ContextGatewayV4OperationKind.FileRead, {
      inputHash: sha256(canonicalJson(replayInput)),
    });
    return this.execute(operation, replayInput, async () => {
      const relativePath = normalizeRelativePath(input.path);
      const revision = input.revision ?? ContextGatewayV4Revision.Head;
      const revisionSha = this.revisionSha(revision);
      const treeOid = this.revisionTreeOid(revision);
      const startByte = boundedInteger(
        input.startByte ?? 0,
        0,
        Number.MAX_SAFE_INTEGER,
        'file_read_start_byte'
      );
      const maxBytes = boundedInteger(
        input.maxBytes ?? 256 * 1024,
        1,
        MAX_FILE_RANGE_BYTES,
        'file_read_max_bytes'
      );
      const entry = await gitTreeEntry(this.root, revisionSha, relativePath);
      const fileKind =
        entry.mode === '160000'
          ? 'gitlink'
          : entry.mode === '120000'
            ? 'symlink'
            : 'regular';
      let content = Buffer.alloc(0);
      let fullContent: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let blobSize = 0;
      if (fileKind !== 'gitlink') {
        blobSize = Number.parseInt(
          (await gitText(this.root, ['cat-file', '-s', entry.oid])).trim(),
          10
        );
        if (
          !Number.isSafeInteger(blobSize) ||
          blobSize < 0 ||
          blobSize > MAX_FILE_TOTAL_BYTES
        ) {
          throw new Error('context_gateway_blob_size_invalid');
        }
        fullContent = await gitBuffer(
          this.root,
          ['cat-file', 'blob', entry.oid],
          MAX_FILE_TOTAL_BYTES + 1
        );
        content = Buffer.from(
          fullContent.subarray(startByte, startByte + maxBytes)
        );
      }
      const classified = classifyUtf8Content(fullContent);
      const responseClassified = classifyUtf8Content(content);
      const eof =
        fileKind === 'gitlink' || startByte + content.byteLength >= blobSize;
      const receiptIdentity = {
        sessionId: this.sessionId,
        kind: ContextGatewayV4OperationKind.FileRead,
        revision,
        treeOid,
        path: relativePath,
        mode: entry.mode,
        blobOid: entry.oid,
        startByte,
        byteCount: content.byteLength,
        contentHash: sha256(content),
        eof,
      };
      const operationReceiptId = keyedSha256(
        this.secret,
        canonicalJson(receiptIdentity)
      );
      return {
        response: Object.freeze({
          path: relativePath,
          revision,
          content:
            responseClassified.kind === 'binary'
              ? content.toString('base64')
              : responseClassified.text,
          encoding:
            responseClassified.kind === 'binary'
              ? ('base64' as const)
              : ('utf8' as const),
          byteCount: content.byteLength,
          startByte,
          eof,
          fileKind,
          blobOid: entry.oid,
          operationReceiptId,
        }),
        result: Object.freeze({
          revision,
          treeOid,
          pathHash: sha256(relativePath),
          mode: entry.mode,
          blobOid: entry.oid,
          contentHash: sha256(content),
          contentKind: classified.kind,
          lineCount: classified.lineCount,
          byteCount: content.byteLength,
          startByte,
          eof,
          complete: eof,
        }),
        operationReceiptId,
      };
    });
  }

  async listDirectory(input: {
    readonly path?: string;
    readonly revision?: ContextGatewayV4Revision;
    readonly maxDepth?: number;
    readonly includeHidden?: boolean;
    readonly pageSize?: number;
    readonly cursor?: string;
  }) {
    const replayInput = normalizeDirectoryListInput(input);
    const operation = this.operation(
      ContextGatewayV4OperationKind.DirectoryList,
      {
        inputHash: sha256(
          canonicalJson({
            ...replayInput,
            cursor: hashCursor(replayInput.cursor),
          })
        ),
      }
    );
    return this.execute(operation, replayInput, async () => {
      const relativePath = normalizeDirectoryPath(input.path);
      const revision = input.revision ?? ContextGatewayV4Revision.Head;
      const revisionSha = this.revisionSha(revision);
      const treeOid = this.revisionTreeOid(revision);
      const maxDepth = boundedInteger(
        input.maxDepth ?? 4,
        1,
        32,
        'directory_list_max_depth'
      );
      const includeHidden = input.includeHidden ?? false;
      const pageSize = boundedInteger(
        input.pageSize ?? 500,
        1,
        2_000,
        'directory_list_page_size'
      );
      const queryDigest = keyedSha256(
        this.secret,
        canonicalJson({ relativePath, revision, maxDepth, includeHidden })
      );
      const offset = this.cursorOffset({
        cursor: input.cursor,
        operationKind: ContextGatewayV4OperationKind.DirectoryList,
        treeOid,
        queryDigest,
        pageSize,
      });
      const tracked = await gitNullSeparated(this.root, [
        'ls-tree',
        '-r',
        '--name-only',
        '-z',
        revisionSha,
        '--',
        relativePath,
      ]);
      const prefix = relativePath === '.' ? '' : `${relativePath}/`;
      const entries = tracked
        .filter((entry) => {
          const nested = prefix ? entry.slice(prefix.length) : entry;
          if (nested === entry && prefix && entry !== relativePath)
            return false;
          return (
            nested.split('/').length <= maxDepth &&
            (includeHidden ||
              !nested.split('/').some((segment) => segment.startsWith('.')))
          );
        })
        .sort();
      if (entries.length > MAX_DIRECTORY_RESULTS) {
        throw new Error('context_gateway_directory_limit_exceeded');
      }
      return this.pageResult({
        operationKind: ContextGatewayV4OperationKind.DirectoryList,
        treeOid,
        queryDigest,
        pageSize,
        offset,
        allItems: entries,
        cursorInputHash: input.cursor ? sha256(input.cursor) : null,
        responseField: 'entries',
        operation,
      });
    });
  }

  async searchText(input: {
    readonly query: string;
    readonly paths?: readonly string[];
    readonly revision?: ContextGatewayV4Revision;
    readonly caseSensitive?: boolean;
    readonly pageSize?: number;
    readonly cursor?: string;
  }) {
    const replayInput = normalizeTextSearchInput(input);
    const operation = this.operation(ContextGatewayV4OperationKind.TextSearch, {
      inputHash: sha256(
        canonicalJson({
          ...replayInput,
          query: sha256(String(replayInput.query)),
          cursor: hashCursor(replayInput.cursor),
        })
      ),
    });
    return this.execute(operation, replayInput, async () => {
      if (
        typeof input.query !== 'string' ||
        input.query.length < 1 ||
        input.query.length > 4_096 ||
        input.query.includes('\0')
      ) {
        throw new Error('text_search_query_invalid');
      }
      const revision = input.revision ?? ContextGatewayV4Revision.Head;
      const revisionSha = this.revisionSha(revision);
      const treeOid = this.revisionTreeOid(revision);
      const paths = (input.paths ?? ['.']).map(normalizeRelativePath).sort();
      if (paths.length > 128 || new Set(paths).size !== paths.length) {
        throw new Error('text_search_paths_invalid');
      }
      const caseSensitive = input.caseSensitive ?? true;
      const pageSize = boundedInteger(
        input.pageSize ?? 500,
        1,
        2_000,
        'text_search_page_size'
      );
      const queryDigest = keyedSha256(
        this.secret,
        canonicalJson({ query: input.query, paths, revision, caseSensitive })
      );
      const offset = this.cursorOffset({
        cursor: input.cursor,
        operationKind: ContextGatewayV4OperationKind.TextSearch,
        treeOid,
        queryDigest,
        pageSize,
      });
      const output = (
        await gitText(
          this.root,
          [
            'grep',
            '-n',
            '-F',
            '-I',
            '--full-name',
            ...(caseSensitive ? [] : ['-i']),
            '-e',
            input.query,
            revisionSha,
            '--',
            ...paths,
          ],
          new Set([0, 1])
        )
      ).replaceAll(`${revisionSha}:`, '');
      const matches = output.split(/\r?\n/u).filter(Boolean).sort();
      if (matches.length > MAX_SEARCH_RESULTS) {
        throw new Error('context_gateway_search_limit_exceeded');
      }
      const matchedPaths = (
        await gitNullSeparated(
          this.root,
          [
            'grep',
            '-l',
            '-z',
            '-F',
            '-I',
            '--full-name',
            ...(caseSensitive ? [] : ['-i']),
            '-e',
            input.query,
            revisionSha,
            '--',
            ...paths,
          ],
          new Set([0, 1])
        )
      )
        .map((value) =>
          value.startsWith(`${revisionSha}:`)
            ? value.slice(revisionSha.length + 1)
            : value
        )
        .sort();
      return this.pageResult({
        operationKind: ContextGatewayV4OperationKind.TextSearch,
        treeOid,
        queryDigest,
        pageSize,
        offset,
        allItems: matches,
        allPathHashes: matchedPaths.map((value) => sha256(value)),
        cursorInputHash: input.cursor ? sha256(input.cursor) : null,
        responseField: 'matches',
        operation,
      });
    });
  }

  async canonicalInventory(input: {
    readonly pageSize?: number;
    readonly cursor?: string;
  }) {
    const replayInput = normalizeCanonicalInventoryInput(input);
    const operation = this.operation(
      ContextGatewayV4OperationKind.CanonicalInventory,
      {
        inputHash: sha256(
          canonicalJson({
            ...replayInput,
            cursor: hashCursor(replayInput.cursor),
          })
        ),
      }
    );
    return this.execute(operation, replayInput, async () => {
      const inventory = await this.inventory();
      const requestedPageSize = boundedInteger(
        input.pageSize ?? 500,
        1,
        2_000,
        'inventory_page_size'
      );
      const pageSize = canonicalInventoryPageSize(
        inventory.entries,
        requestedPageSize
      );
      const queryDigest = keyedSha256(
        this.secret,
        canonicalJson({
          inventoryVersion: inventory.inventoryVersion,
          mergeBaseTreeOid: inventory.mergeBaseTreeOid,
          headTreeOid: inventory.headTreeOid,
        })
      );
      const offset = this.cursorOffset({
        cursor: input.cursor,
        operationKind: ContextGatewayV4OperationKind.CanonicalInventory,
        treeOid: inventory.headTreeOid,
        queryDigest,
        pageSize,
      });
      return this.pageResult<CanonicalInventoryEntry>({
        operationKind: ContextGatewayV4OperationKind.CanonicalInventory,
        treeOid: inventory.headTreeOid,
        queryDigest,
        pageSize,
        offset,
        allItems: inventory.entries,
        pathHashesThroughItem: (end) =>
          canonicalInventoryPathHashes(inventory.entries.slice(0, end)),
        cursorInputHash: input.cursor ? sha256(input.cursor) : null,
        responseField: 'entries',
        operation,
        extraResponse: {
          inventoryVersion: inventory.inventoryVersion,
          inventoryHash: inventory.inventoryHash,
          mergeBaseTreeOid: inventory.mergeBaseTreeOid,
          headTreeOid: inventory.headTreeOid,
        },
      });
    });
  }

  async gitFact(input: {
    readonly fact: 'merge_base' | 'changed_paths' | 'diff_stat';
  }) {
    const replayInput = Object.freeze({ fact: input.fact });
    const operation = this.operation(ContextGatewayV4OperationKind.GitFact, {
      fact: input.fact,
    });
    return this.execute(operation, replayInput, async () => {
      let values: string[];
      switch (input.fact) {
        case 'merge_base':
          values = [this.mergeBaseSha];
          break;
        case 'changed_paths': {
          const inventory = await this.inventory();
          values = inventory.entries.map((entry) =>
            [entry.status, entry.beforePath ?? '', entry.afterPath ?? ''].join(
              '\t'
            )
          );
          break;
        }
        case 'diff_stat':
          values = (
            await gitNullSeparated(this.root, [
              '-c',
              'core.attributesFile=/dev/null',
              'diff',
              '--no-renames',
              '--no-ext-diff',
              '--no-textconv',
              '--numstat',
              '-z',
              `${this.mergeBaseSha}..${this.headSha}`,
            ])
          ).sort();
          break;
      }
      const resultHash = sha256(canonicalJson(values));
      const operationReceiptId = keyedSha256(
        this.secret,
        canonicalJson({
          sessionId: this.sessionId,
          fact: input.fact,
          resultHash,
        })
      );
      return {
        response: Object.freeze({
          fact: input.fact,
          values,
          operationReceiptId,
        }),
        result: Object.freeze({
          fact: input.fact,
          resultHash,
          itemCount: values.length,
          complete: true,
        }),
        operationReceiptId,
      };
    });
  }

  private async pageResult<T>(input: {
    readonly operationKind: ContextGatewayV4OperationKind;
    readonly treeOid: string;
    readonly queryDigest: string;
    readonly pageSize: number;
    readonly offset: number;
    readonly allItems: readonly T[];
    readonly allPathHashes?: readonly string[];
    readonly pathHashesThroughItem?: (
      exclusiveEnd: number
    ) => readonly string[];
    readonly cursorInputHash: string | null;
    readonly responseField: 'entries' | 'matches';
    readonly operation: ReturnType<FilesystemContextGatewayV4['operation']>;
    readonly extraResponse?: Readonly<Record<string, unknown>>;
  }) {
    const baseReceipt = createContextGatewayV4PageReceipt({
      secret: this.secret,
      sessionId: this.sessionId,
      operationKind: input.operationKind,
      queryDigest: input.queryDigest,
      treeOid: input.treeOid,
      pageSize: input.pageSize,
      offset: input.offset,
      allItems: input.allItems,
      cursorInputHash: input.cursorInputHash,
      allItemPathHashes: input.allPathHashes ?? [],
      nowMs: this.now(),
    });
    const receipt = input.pathHashesThroughItem
      ? withCanonicalPathWitness({
          base: baseReceipt,
          secret: this.secret,
          sessionId: this.sessionId,
          operationKind: input.operationKind,
          queryDigest: input.queryDigest,
          treeOid: input.treeOid,
          pageSize: input.pageSize,
          pathHashesThroughItem: input.pathHashesThroughItem,
        })
      : baseReceipt;
    const pageItems = input.allItems.slice(
      input.offset,
      input.offset + input.pageSize
    );
    return {
      response: Object.freeze({
        ...(input.extraResponse ?? {}),
        [input.responseField]: pageItems,
        complete: receipt.complete,
        nextCursor: receipt.nextCursor,
        operationReceiptId: receipt.operationReceiptId,
        pageOrdinal: receipt.pageOrdinal,
        aggregateItemCount: receipt.aggregateItemCount,
      }),
      result: Object.freeze({
        treeOid: input.treeOid,
        queryDigest: input.queryDigest,
        cursorInputHash: receipt.cursorInputHash,
        pageOrdinal: receipt.pageOrdinal,
        pageItemCount: receipt.pageItemCount,
        pageItemsHash: receipt.pageItemsHash,
        pagePathHashes: receipt.pagePathHashes,
        aggregatePathCount: receipt.aggregatePathCount,
        aggregatePathSetHash: receipt.aggregatePathSetHash,
        aggregateItemCount: receipt.aggregateItemCount,
        aggregateHash: receipt.aggregateHash,
        complete: receipt.complete,
        nextCursorHash: receipt.nextCursor ? sha256(receipt.nextCursor) : null,
      }),
      operationReceiptId: receipt.operationReceiptId,
    };
  }

  private cursorOffset(input: {
    readonly cursor?: string;
    readonly operationKind: ContextGatewayV4OperationKind;
    readonly treeOid: string;
    readonly queryDigest: string;
    readonly pageSize: number;
  }): number {
    if (!input.cursor) return 0;
    return decodeContextGatewayV4Cursor({
      secret: this.secret,
      cursor: input.cursor,
      expected: {
        sessionId: this.sessionId,
        operationKind: input.operationKind,
        treeOid: input.treeOid,
        policyVersion: CONTEXT_GATEWAY_V4_POLICY_VERSION,
        queryDigest: input.queryDigest,
        pageSize: input.pageSize,
      },
      nowMs: this.now(),
    }).nextOffset;
  }

  private operation(
    kind: ContextGatewayV4OperationKind,
    facts: Readonly<Record<string, unknown>>
  ) {
    return Object.freeze({ kind, ...facts });
  }

  private async execute<T>(
    operation: ReturnType<FilesystemContextGatewayV4['operation']>,
    replayInput: Readonly<Record<string, unknown>>,
    action: () => Promise<{
      readonly response: T;
      readonly result: Readonly<Record<string, unknown>>;
      readonly operationReceiptId: string;
    }>
  ): Promise<T> {
    try {
      const completed = await action();
      const event = await this.recorder.recordSucceeded({
        operation,
        result: completed.result,
        operationReceiptId: completed.operationReceiptId,
      });
      await this.replayMaterial?.recordSucceeded({ event, replayInput });
      return completed.response;
    } catch (error) {
      const failureClass = classifyContextGatewayV4Failure(error);
      const reason = sanitizedReason(error);
      try {
        if (
          failureClass === ContextOperationFailureClass.InfrastructureFailure
        ) {
          await this.recorder.recordFailed({
            operation,
            sanitizedReason: reason,
          });
        } else {
          await this.recorder.recordRejected({
            operation,
            failureClass,
            sanitizedReason: reason,
          });
        }
      } catch {
        // Preserve the original operation failure; recorder state is fail-closed.
      }
      throw error;
    }
  }

  private revisionSha(revision: ContextGatewayV4Revision): string {
    switch (revision) {
      case ContextGatewayV4Revision.Head:
        return this.headSha;
      case ContextGatewayV4Revision.MergeBase:
        return this.mergeBaseSha;
    }
  }

  private revisionTreeOid(revision: ContextGatewayV4Revision): string {
    switch (revision) {
      case ContextGatewayV4Revision.Head:
        return this.headTreeOid;
      case ContextGatewayV4Revision.MergeBase:
        return this.mergeBaseTreeOid;
    }
  }

  private inventory(): ReturnType<typeof buildCanonicalGitInventory> {
    if (this.inventoryPromise === null) {
      this.inventoryPromise = buildCanonicalGitInventory({
        root: this.root,
        mergeBaseSha: this.mergeBaseSha,
        headSha: this.headSha,
      });
    }
    return this.inventoryPromise;
  }
}

function normalizeFileReadInput(input: {
  readonly path: string;
  readonly revision?: ContextGatewayV4Revision;
  readonly startByte?: number;
  readonly maxBytes?: number;
}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    path: normalizePathForOperation(input.path),
    revision: input.revision ?? ContextGatewayV4Revision.Head,
    startByte: input.startByte ?? 0,
    maxBytes: input.maxBytes ?? 256 * 1024,
  });
}

function normalizeDirectoryListInput(input: {
  readonly path?: string;
  readonly revision?: ContextGatewayV4Revision;
  readonly maxDepth?: number;
  readonly includeHidden?: boolean;
  readonly pageSize?: number;
  readonly cursor?: string;
}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    path: normalizeDirectoryPathForOperation(input.path),
    revision: input.revision ?? ContextGatewayV4Revision.Head,
    maxDepth: input.maxDepth ?? 4,
    includeHidden: input.includeHidden ?? false,
    pageSize: input.pageSize ?? 500,
    cursor: normalizeCursor(input.cursor),
  });
}

function normalizeTextSearchInput(input: {
  readonly query: string;
  readonly paths?: readonly string[];
  readonly revision?: ContextGatewayV4Revision;
  readonly caseSensitive?: boolean;
  readonly pageSize?: number;
  readonly cursor?: string;
}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    query: input.query,
    paths: Object.freeze(
      (input.paths ?? ['.']).map(normalizePathForOperation).sort()
    ),
    revision: input.revision ?? ContextGatewayV4Revision.Head,
    caseSensitive: input.caseSensitive ?? true,
    pageSize: input.pageSize ?? 500,
    cursor: normalizeCursor(input.cursor),
  });
}

function normalizeCanonicalInventoryInput(input: {
  readonly pageSize?: number;
  readonly cursor?: string;
}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    pageSize: input.pageSize ?? 500,
    cursor: normalizeCursor(input.cursor),
  });
}

function normalizePathForOperation(value: string): string {
  try {
    return normalizeRelativePath(value);
  } catch {
    return value;
  }
}

function normalizeDirectoryPathForOperation(value: string | undefined): string {
  try {
    return normalizeDirectoryPath(value);
  } catch {
    return value ?? '.';
  }
}

function normalizeDirectoryPath(value: string | undefined): string {
  if (value === undefined || value === '' || value === '/') return '.';
  return normalizeRelativePath(value);
}

function normalizeCursor(value: string | undefined): string | null {
  return value ? value : null;
}

function hashCursor(value: unknown): string | null {
  return typeof value === 'string' ? sha256(value) : null;
}

function canonicalInventoryPageSize(
  entries: readonly CanonicalInventoryEntry[],
  requestedPageSize: number
): number {
  const includesTwoPathEntry = entries.some(
    (entry) =>
      entry.beforePath !== null &&
      entry.afterPath !== null &&
      entry.beforePath !== entry.afterPath
  );
  return includesTwoPathEntry
    ? Math.min(
        requestedPageSize,
        Math.floor(CONTEXT_GATEWAY_V4_PAGE_MAX_ITEMS / 2)
      )
    : requestedPageSize;
}

function canonicalInventoryPathHashes(
  entries: readonly CanonicalInventoryEntry[]
): readonly string[] {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (entry.beforePath !== null) paths.add(entry.beforePath);
    if (entry.afterPath !== null) paths.add(entry.afterPath);
  }
  return [...paths].map(sha256).sort();
}

function withCanonicalPathWitness(input: {
  readonly base: ContextGatewayV4PageReceipt;
  readonly secret: Buffer;
  readonly sessionId: string;
  readonly operationKind: ContextGatewayV4OperationKind;
  readonly queryDigest: string;
  readonly treeOid: string;
  readonly pageSize: number;
  readonly pathHashesThroughItem: (exclusiveEnd: number) => readonly string[];
}): ContextGatewayV4PageReceipt {
  const previousItemCount =
    input.base.aggregateItemCount - input.base.pageItemCount;
  const previousPathHashes = new Set(
    input.pathHashesThroughItem(previousItemCount)
  );
  const aggregatePathHashes = input.pathHashesThroughItem(
    input.base.aggregateItemCount
  );
  const pagePathHashes = aggregatePathHashes.filter(
    (pathHash) => !previousPathHashes.has(pathHash)
  );
  if (
    pagePathHashes.length > CONTEXT_GATEWAY_V4_PAGE_MAX_ITEMS ||
    aggregatePathHashes.some((value) => !/^[a-f0-9]{64}$/u.test(value)) ||
    new Set(aggregatePathHashes).size !== aggregatePathHashes.length
  ) {
    throw new Error('context_gateway_page_path_hashes_invalid');
  }
  const aggregatePathSetHash = sha256(canonicalJson(aggregatePathHashes));
  const receiptIdentity = {
    sessionId: input.sessionId,
    operationKind: input.operationKind,
    queryDigest: input.queryDigest,
    treeOid: input.treeOid,
    pageSize: input.pageSize,
    pageOrdinal: input.base.pageOrdinal,
    cursorInputHash: input.base.cursorInputHash,
    pageItemCount: input.base.pageItemCount,
    pageItemsHash: input.base.pageItemsHash,
    pagePathHashes,
    aggregatePathCount: aggregatePathHashes.length,
    aggregatePathSetHash,
    aggregateItemCount: input.base.aggregateItemCount,
    aggregateHash: input.base.aggregateHash,
    complete: input.base.complete,
  };
  return Object.freeze({
    ...input.base,
    operationReceiptId: keyedSha256(
      input.secret,
      canonicalJson(receiptIdentity)
    ),
    pagePathHashes: Object.freeze(pagePathHashes),
    aggregatePathCount: aggregatePathHashes.length,
    aggregatePathSetHash,
  });
}

async function gitTreeEntry(
  root: string,
  revision: string,
  relativePath: string
) {
  const records = (
    await gitText(root, ['ls-tree', '-z', revision, '--', relativePath])
  )
    .split('\0')
    .filter(Boolean);
  const match = records[0]?.match(
    /^([0-7]{6}) (?:blob|commit) ([a-f0-9]{40,64})\t(.+)$/u
  );
  if (records.length !== 1 || !match || match[3] !== relativePath) {
    throw new Error('context_gateway_file_not_in_revision_tree');
  }
  return {
    mode: match[1],
    oid: requireGitOid(match[2], 'context_gateway_file_oid'),
  };
}

function normalizeRelativePath(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 1_024 ||
    value.includes('\0') ||
    value.includes('\\') ||
    path.isAbsolute(value)
  ) {
    throw new Error('context_gateway_path_invalid');
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new Error('context_gateway_path_invalid');
  }
  return normalized === '' ? '.' : normalized;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

function sanitizedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : 'operation_failed';
  return /^[a-z0-9_]{1,160}$/u.test(message) ? message : 'operation_failed';
}

async function gitNullSeparated(
  root: string,
  args: readonly string[],
  acceptedExitCodes = new Set([0])
) {
  return (await gitText(root, args, acceptedExitCodes))
    .split('\0')
    .filter(Boolean);
}

async function gitText(
  root: string,
  args: readonly string[],
  acceptedExitCodes = new Set([0])
): Promise<string> {
  try {
    return (
      await execFileAsync('git', args, {
        ...gitOptions(root),
        encoding: 'utf8',
      })
    ).stdout;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { code?: number }).code;
    if (typeof code === 'number' && acceptedExitCodes.has(code)) {
      return String((error as { stdout?: string }).stdout ?? '');
    }
    throw error;
  }
}

async function gitBuffer(
  root: string,
  args: readonly string[],
  maxBuffer: number
): Promise<Buffer> {
  return (
    await execFileAsync('git', args, {
      ...gitOptions(root),
      encoding: 'buffer',
      maxBuffer,
    })
  ).stdout as Buffer;
}

function gitOptions(root: string) {
  return {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
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
