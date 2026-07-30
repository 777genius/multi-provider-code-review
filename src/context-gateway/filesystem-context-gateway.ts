import { execFile } from 'child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { promisify } from 'util';
import {
  canonicalJson,
  contextGitDiffPolicyHash,
  contextGitFactOperandsHash,
  requireGitOid,
  sha256,
  type ContextDependencyEntry,
  type ContextGitFactKind,
} from './context-gateway-contract';
import { ContextGatewayRecorder } from './context-gateway-recorder';

const execFileAsync = promisify(execFile);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 20_000;
const MAX_SEARCH_RESULTS = 20_000;
const MAX_GIT_INFO_ATTRIBUTES_BYTES = 1024 * 1024;
type GitDiffPolicySnapshot = Readonly<{
  hash: string;
  infoAttributes: Buffer | null;
}>;
type IsolatedGitDirectory = Readonly<{
  gitDirectory: string;
  indexPath: string;
  workTreePath: string;
}>;
const GIT_DIFF_BASE_ARGS = Object.freeze([
  '-c',
  'core.attributesFile=/dev/null',
  'diff',
  '--no-renames',
  '--no-ext-diff',
  '--no-textconv',
  '--no-indent-heuristic',
  '--diff-algorithm=myers',
  '--ignore-submodules=none',
]);

export class FilesystemContextGateway {
  private readonly revisionTreeOidPromises = new Map<string, Promise<string>>();

  private constructor(
    private readonly root: string,
    private readonly mergeBaseSha: string,
    private readonly headSha: string,
    private readonly recorder: ContextGatewayRecorder
  ) {}

  static async create(input: {
    root: string;
    checkoutTreeOid: string;
    baseSha: string;
    mergeBaseSha: string;
    headSha: string;
    recorder: ContextGatewayRecorder;
  }): Promise<FilesystemContextGateway> {
    const root = await realpath(input.root);
    requireGitOid(input.checkoutTreeOid, 'checkout_tree_oid');
    requireGitOid(input.baseSha, 'base_sha');
    requireGitOid(input.mergeBaseSha, 'merge_base_sha');
    requireGitOid(input.headSha, 'head_sha');
    const gateway = new FilesystemContextGateway(
      root,
      input.mergeBaseSha,
      input.headSha,
      input.recorder
    );
    const actualHeadTreeOid = await gateway.revisionTreeOid(input.headSha);
    if (actualHeadTreeOid !== input.checkoutTreeOid) {
      throw new Error('context_gateway_checkout_tree_mismatch');
    }
    return gateway;
  }

  async readFile(input: {
    path: string;
    startByte?: number;
    maxBytes?: number;
  }) {
    try {
      const relativePath = normalizeRelativePath(input.path);
      const startByte = boundedInteger(
        input.startByte ?? 0,
        0,
        Number.MAX_SAFE_INTEGER,
        'file_read_start_byte'
      );
      const maxBytes = boundedInteger(
        input.maxBytes ?? 256 * 1024,
        1,
        MAX_FILE_BYTES,
        'file_read_max_bytes'
      );
      const treeEntry = await this.gitTreeEntry(relativePath);
      const mode = treeEntry.mode;
      const fileKind =
        mode === 0o160000
          ? 'gitlink'
          : mode === 0o120000
            ? 'symlink'
            : 'regular';
      let content: Buffer;
      let symlinkTargetHash: string | null = null;
      let eof = true;
      if (fileKind === 'gitlink') {
        content = Buffer.alloc(0);
      } else {
        const blobSize = Number.parseInt(
          (await this.gitText(['cat-file', '-s', treeEntry.oid])).trim(),
          10
        );
        if (
          !Number.isSafeInteger(blobSize) ||
          blobSize < 0 ||
          blobSize > MAX_FILE_BYTES
        ) {
          throw new Error('context_gateway_blob_size_invalid');
        }
        const blob = await this.gitBuffer(['cat-file', 'blob', treeEntry.oid]);
        content = blob.subarray(startByte, startByte + maxBytes);
        eof = startByte + content.byteLength >= blobSize;
        if (fileKind === 'symlink') symlinkTargetHash = sha256(blob);
      }
      const binary = content.includes(0);
      const operation = Object.freeze({
        kind: 'file_read' as const,
        path: relativePath,
        startByte,
        maxBytes,
      });
      const result = Object.freeze({
        kind: 'file_read' as const,
        fileKind,
        mode,
        blobOid: treeEntry.oid,
        symlinkTargetHash,
        contentHash: sha256(content),
        byteCount: content.byteLength,
        eof,
        complete: true,
        truncated: false,
      });
      await this.recorder.record(operation, result);
      return Object.freeze({
        path: relativePath,
        content: binary ? content.toString('base64') : content.toString('utf8'),
        encoding: binary ? ('base64' as const) : ('utf8' as const),
        byteCount: content.byteLength,
        eof,
        fileKind,
      });
    } catch (error) {
      await this.recorder.recordFailure();
      throw error;
    }
  }

  async listDirectory(input: {
    path: string;
    maxDepth?: number;
    includeHidden?: boolean;
    maxEntries?: number;
  }) {
    try {
      const relativePath = normalizeRelativePath(input.path);
      const maxDepth = boundedInteger(
        input.maxDepth ?? 4,
        1,
        32,
        'directory_list_max_depth'
      );
      const maxEntries = boundedInteger(
        input.maxEntries ?? 2_000,
        1,
        MAX_DIRECTORY_ENTRIES,
        'directory_list_max_entries'
      );
      const includeHidden = input.includeHidden ?? false;
      const tracked = await this.gitNullSeparated([
        'ls-tree',
        '-r',
        '--name-only',
        '-z',
        this.headSha,
        '--',
        relativePath,
      ]);
      const prefix = relativePath === '.' ? '' : `${relativePath}/`;
      const candidates = tracked
        .filter((entry) => {
          const nested = prefix ? entry.slice(prefix.length) : entry;
          if (nested === entry && prefix && entry !== relativePath)
            return false;
          if (nested.split('/').length > maxDepth) return false;
          return (
            includeHidden ||
            !nested.split('/').some((segment) => segment.startsWith('.'))
          );
        })
        .sort();
      const truncated = candidates.length > maxEntries;
      const entries = candidates.slice(0, maxEntries);
      const treeOid = await this.treeOid(relativePath);
      const operation = Object.freeze({
        kind: 'directory_list' as const,
        path: relativePath,
        maxDepth,
        includeHidden,
        maxEntries,
        ignorePolicyHash: sha256('git-index-ignore-policy.v1'),
        caseSensitive: true,
      });
      const result = Object.freeze({
        kind: 'directory_list' as const,
        treeOid,
        orderedEntriesHash: sha256(canonicalJson(entries)),
        itemCount: entries.length,
        byteCount: Buffer.byteLength(canonicalJson(entries), 'utf8'),
        complete: !truncated,
        truncated,
      });
      await this.recorder.record(operation, result);
      return Object.freeze({ path: relativePath, entries, truncated });
    } catch (error) {
      await this.recorder.recordFailure();
      throw error;
    }
  }

  async searchText(input: {
    query: string;
    paths?: readonly string[];
    maxResults?: number;
    caseSensitive?: boolean;
  }) {
    try {
      if (
        typeof input.query !== 'string' ||
        input.query.length === 0 ||
        input.query.length > 4_096 ||
        input.query.includes('\0')
      ) {
        throw new Error('text_search_query_invalid');
      }
      const paths = (input.paths ?? ['.']).map(normalizeRelativePath).sort();
      if (new Set(paths).size !== paths.length || paths.length > 128) {
        throw new Error('text_search_paths_invalid');
      }
      const maxResults = boundedInteger(
        input.maxResults ?? 2_000,
        1,
        MAX_SEARCH_RESULTS,
        'text_search_max_results'
      );
      const caseSensitive = input.caseSensitive ?? true;
      const args = [
        'grep',
        '-n',
        '-I',
        '--full-name',
        ...(caseSensitive ? [] : ['-i']),
        '-e',
        input.query,
        this.headSha,
        '--',
        ...paths,
      ];
      const output = (await this.gitText(args, new Set([0, 1]))).replaceAll(
        `${this.headSha}:`,
        ''
      );
      const allMatches = output.split(/\r?\n/u).filter(Boolean).sort();
      const truncated = allMatches.length > maxResults;
      const matches = allMatches.slice(0, maxResults);
      const operation = Object.freeze({
        kind: 'text_search' as const,
        paths,
        includeGlobs: [] as readonly string[],
        excludeGlobs: [] as readonly string[],
        maxResults,
        ignorePolicyHash: sha256('git-grep-ignore-policy.v1'),
        binaryPolicy: 'exclude',
        caseSensitive,
        encoding: 'utf8',
      });
      const result = Object.freeze({
        kind: 'text_search' as const,
        orderedMatchesHash: sha256(canonicalJson(matches)),
        scannedTreeHash: await this.scannedTreeHash(paths),
        itemCount: matches.length,
        byteCount: Buffer.byteLength(canonicalJson(matches), 'utf8'),
        complete: !truncated,
        truncated,
      });
      await this.recorder.recordTextSearch(operation, result, input.query);
      return Object.freeze({ matches, truncated });
    } catch (error) {
      await this.recorder.recordFailure();
      throw error;
    }
  }

  async gitFact(input: { fact: ContextGitFactKind }) {
    try {
      let values: string[];
      let diffPolicyHash: string | undefined;
      switch (input.fact) {
        case 'changed_paths': {
          const tokens = await this.gitNullSeparated([
            ...GIT_DIFF_BASE_ARGS,
            '--name-status',
            '-z',
            `${this.mergeBaseSha}..${this.headSha}`,
          ]);
          if (tokens.length % 2 !== 0) {
            throw new Error('context_gateway_changed_paths_invalid');
          }
          values = [];
          for (let index = 0; index < tokens.length; index += 2) {
            values.push(`${tokens[index]}\t${tokens[index + 1]}`);
          }
          values.sort();
          break;
        }
        case 'diff_stat': {
          await this.assertAttributeSourcesClean();
          await this.materializePartialCloneDiffObjects();
          const policyBefore = await this.captureGitDiffPolicy();
          const isolatedGit =
            await this.createIsolatedGitDirectory(policyBefore);
          try {
            values = (
              await this.gitNullSeparated(
                [
                  ...GIT_DIFF_BASE_ARGS,
                  '--numstat',
                  '-z',
                  '--text',
                  `${this.mergeBaseSha}..${this.headSha}`,
                ],
                {
                  GIT_DIR: isolatedGit.gitDirectory,
                  GIT_INDEX_FILE: isolatedGit.indexPath,
                  GIT_WORK_TREE: isolatedGit.workTreePath,
                }
              )
            ).sort();
          } finally {
            await rm(isolatedGit.gitDirectory, {
              recursive: true,
              force: true,
            });
          }
          const policyAfter = await this.captureGitDiffPolicy();
          await this.assertAttributeSourcesClean();
          if (policyBefore.hash !== policyAfter.hash) {
            throw new Error('context_gateway_git_diff_policy_changed');
          }
          diffPolicyHash = policyBefore.hash;
          break;
        }
        case 'merge_base': {
          const output = (
            await this.gitText([
              'rev-parse',
              '--verify',
              `${this.mergeBaseSha}^{commit}`,
            ])
          ).trim();
          values = output ? [output] : [];
          break;
        }
        default:
          throw new Error('git_fact_invalid');
      }
      const operandsHash = await this.gitFactOperandsHash(
        input.fact,
        diffPolicyHash
      );
      const operation = Object.freeze({
        kind: 'git_fact' as const,
        fact: input.fact,
        operandsHash,
      });
      const result = Object.freeze({
        kind: 'git_fact' as const,
        resultHash: sha256(canonicalJson(values)),
        itemCount: values.length,
        byteCount: Buffer.byteLength(canonicalJson(values), 'utf8'),
        complete: true,
        truncated: false,
      });
      await this.recorder.record(operation, result);
      return Object.freeze({ fact: input.fact, values });
    } catch (error) {
      await this.recorder.recordFailure();
      throw error;
    }
  }

  private async gitTreeEntry(
    relativePath: string
  ): Promise<{ mode: number; oid: string }> {
    const output = await this.gitText([
      'ls-tree',
      '-z',
      this.headSha,
      '--',
      relativePath,
    ]);
    const records = output.split('\0').filter(Boolean);
    const match = records[0]?.match(
      /^([0-7]{6}) (?:blob|commit) ([a-f0-9]{40,64})\t(.+)$/u
    );
    if (records.length !== 1 || !match || match[3] !== relativePath) {
      throw new Error('context_gateway_file_not_in_head_tree');
    }
    return { mode: Number.parseInt(match[1], 8), oid: match[2] };
  }

  private async treeOid(relativePath: string): Promise<string> {
    const spec =
      relativePath === '.'
        ? `${this.headSha}^{tree}`
        : `${this.headSha}:${relativePath}`;
    return requireGitOid(
      (await this.gitText(['rev-parse', spec])).trim(),
      'directory_tree_oid'
    );
  }

  private async scannedTreeHash(paths: readonly string[]): Promise<string> {
    const witnesses = await Promise.all(
      paths.map(async (entry) => [entry, await this.treeOrBlobOid(entry)])
    );
    return sha256(canonicalJson(witnesses));
  }

  private async treeOrBlobOid(relativePath: string): Promise<string> {
    const spec =
      relativePath === '.'
        ? `${this.headSha}^{tree}`
        : `${this.headSha}:${relativePath}`;
    return requireGitOid(
      (await this.gitText(['rev-parse', spec])).trim(),
      'search_scope_oid'
    );
  }

  private revisionTreeOid(revision: string): Promise<string> {
    let promise = this.revisionTreeOidPromises.get(revision);
    if (!promise) {
      promise = this.gitText(['rev-parse', `${revision}^{tree}`]).then(
        (output) =>
          requireGitOid(output.trim().toLowerCase(), 'revision_tree_oid')
      );
      this.revisionTreeOidPromises.set(revision, promise);
    }
    return promise;
  }

  private async gitFactOperandsHash(
    fact: ContextGitFactKind,
    diffPolicyHash: string | undefined
  ): Promise<string> {
    if (fact === 'merge_base') {
      return contextGitFactOperandsHash({
        fact,
        mergeBaseSha: this.mergeBaseSha,
      });
    }
    const [mergeBaseTreeOid, headTreeOid] = await Promise.all([
      this.revisionTreeOid(this.mergeBaseSha),
      this.revisionTreeOid(this.headSha),
    ]);
    if (fact === 'diff_stat') {
      if (!diffPolicyHash) {
        throw new Error('context_gateway_git_diff_policy_missing');
      }
      return contextGitFactOperandsHash({
        fact,
        mergeBaseTreeOid,
        headTreeOid,
        diffPolicyHash,
      });
    }
    return contextGitFactOperandsHash({
      fact,
      mergeBaseTreeOid,
      headTreeOid,
    });
  }

  private async captureGitDiffPolicy(): Promise<GitDiffPolicySnapshot> {
    const gitPath = (
      await this.gitText(['rev-parse', '--git-path', 'info/attributes'])
    ).trim();
    if (gitPath.length === 0) {
      throw new Error('context_gateway_git_info_attributes_path_invalid');
    }
    const attributesPath = path.isAbsolute(gitPath)
      ? gitPath
      : path.resolve(this.root, gitPath);
    let infoAttributes: Buffer | null;
    try {
      infoAttributes = await readFile(attributesPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      infoAttributes = null;
    }
    if (
      infoAttributes !== null &&
      infoAttributes.byteLength > MAX_GIT_INFO_ATTRIBUTES_BYTES
    ) {
      throw new Error('context_gateway_git_info_attributes_too_large');
    }
    return Object.freeze({
      hash: contextGitDiffPolicyHash(
        infoAttributes === null ? null : sha256(infoAttributes)
      ),
      infoAttributes,
    });
  }

  private async materializePartialCloneDiffObjects(): Promise<void> {
    const [partialCloneRemote, promisorRemotes] = await Promise.all([
      this.gitText(
        ['config', '--local', '--get', 'extensions.partialClone'],
        new Set([0, 1])
      ),
      this.gitText(
        ['config', '--local', '--get-regexp', '^remote\\..*\\.promisor$'],
        new Set([0, 1])
      ),
    ]);
    if (
      partialCloneRemote.trim().length === 0 &&
      promisorRemotes.trim().length === 0
    ) {
      return;
    }
    await this.gitNullSeparated([
      ...GIT_DIFF_BASE_ARGS,
      '--numstat',
      '-z',
      '--text',
      `${this.mergeBaseSha}..${this.headSha}`,
    ]);
  }

  private async createIsolatedGitDirectory(
    policy: GitDiffPolicySnapshot
  ): Promise<IsolatedGitDirectory> {
    const gitDirectory = await mkdtemp(
      path.join(tmpdir(), 'reviewrouter-context-git-')
    );
    try {
      const [objectsPathOutput, objectFormatOutput] = await Promise.all([
        this.gitText(['rev-parse', '--git-path', 'objects']),
        this.gitText(['rev-parse', '--show-object-format=storage']),
        mkdir(path.join(gitDirectory, 'objects', 'info'), { recursive: true }),
        mkdir(path.join(gitDirectory, 'refs', 'heads'), { recursive: true }),
        mkdir(path.join(gitDirectory, 'info'), { recursive: true }),
        mkdir(path.join(gitDirectory, 'worktree'), { recursive: true }),
      ]);
      const rawObjectsPath = objectsPathOutput.trim();
      if (rawObjectsPath.length === 0) {
        throw new Error('context_gateway_git_objects_path_invalid');
      }
      const objectsPath = await realpath(
        path.isAbsolute(rawObjectsPath)
          ? rawObjectsPath
          : path.resolve(this.root, rawObjectsPath)
      );
      if (objectsPath.includes('\0') || objectsPath.includes('\n')) {
        throw new Error('context_gateway_git_objects_path_invalid');
      }
      const objectFormat = objectFormatOutput.trim();
      if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
        throw new Error('context_gateway_git_object_format_invalid');
      }
      const config =
        objectFormat === 'sha256'
          ? '[core]\n\trepositoryformatversion = 1\n\tbare = false\n[extensions]\n\tobjectformat = sha256\n'
          : '[core]\n\trepositoryformatversion = 0\n\tbare = false\n';
      await Promise.all([
        writeFile(path.join(gitDirectory, 'HEAD'), 'ref: refs/heads/unused\n'),
        writeFile(path.join(gitDirectory, 'config'), config),
        writeFile(
          path.join(gitDirectory, 'objects', 'info', 'alternates'),
          `${objectsPath}\n`
        ),
        policy.infoAttributes === null
          ? Promise.resolve()
          : writeFile(
              path.join(gitDirectory, 'info', 'attributes'),
              policy.infoAttributes
            ),
      ]);
      const indexPath = path.join(gitDirectory, 'index');
      const workTreePath = path.join(gitDirectory, 'worktree');
      await this.gitText(['read-tree', '--reset', this.headSha], new Set([0]), {
        GIT_DIR: gitDirectory,
        GIT_INDEX_FILE: indexPath,
        GIT_WORK_TREE: workTreePath,
      });
      return Object.freeze({ gitDirectory, indexPath, workTreePath });
    } catch (error) {
      await rm(gitDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  private async assertAttributeSourcesClean(): Promise<void> {
    const dirtyAttributes = await this.gitText([
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--',
      '.gitattributes',
      ':(glob)**/.gitattributes',
    ]);
    if (dirtyAttributes.length > 0) {
      throw new Error('context_gateway_git_attributes_dirty');
    }
  }

  private async gitNullSeparated(
    args: readonly string[],
    environment: Readonly<Record<string, string>> = {}
  ): Promise<string[]> {
    return (await this.gitText(args, new Set([0]), environment))
      .split('\0')
      .filter(Boolean);
  }

  private async gitText(
    args: readonly string[],
    acceptedExitCodes = new Set([0]),
    environment: Readonly<Record<string, string>> = {}
  ): Promise<string> {
    try {
      const result = await execFileAsync('git', args, {
        cwd: this.root,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: 30_000,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          GIT_ATTR_NOSYSTEM: '1',
          GIT_ATTR_SOURCE: this.headSha,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_NO_REPLACE_OBJECTS: '1',
          GIT_TERMINAL_PROMPT: '0',
          ...environment,
        },
      });
      return result.stdout;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException & { code?: number }).code;
      if (typeof code === 'number' && acceptedExitCodes.has(code)) {
        return String(
          (error as NodeJS.ErrnoException & { stdout?: string }).stdout ?? ''
        );
      }
      throw error;
    }
  }

  private async gitBuffer(args: readonly string[]): Promise<Buffer> {
    const result = await execFileAsync('git', args, {
      cwd: this.root,
      encoding: 'buffer',
      maxBuffer: MAX_FILE_BYTES + 1,
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_ATTR_NOSYSTEM: '1',
        GIT_ATTR_SOURCE: this.headSha,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    return result.stdout;
  }
}

function normalizeRelativePath(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
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

export type ContextGatewayOperationResult =
  | Awaited<ReturnType<FilesystemContextGateway['readFile']>>
  | Awaited<ReturnType<FilesystemContextGateway['listDirectory']>>
  | Awaited<ReturnType<FilesystemContextGateway['searchText']>>
  | Awaited<ReturnType<FilesystemContextGateway['gitFact']>>;

export type RecordedContextDependency = ContextDependencyEntry;
