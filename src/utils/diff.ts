/**
 * Trim diff intelligently by keeping complete files until we reach the size limit.
 * This prevents false positives where LLMs see files listed but their diffs are missing.
 */
export function trimDiff(diff: string, maxBytes: number): string {
  const buf = Buffer.from(diff, 'utf8');
  if (buf.byteLength <= maxBytes) return diff;

  // Split by file boundaries (diff --git lines)
  const fileChunks: string[] = [];
  const lines = diff.split('\n');
  let currentChunk: string[] = [];

  for (const line of lines) {
    if (line.startsWith('diff --git ') && currentChunk.length > 0) {
      // New file starts, save previous chunk
      fileChunks.push(currentChunk.join('\n'));
      currentChunk = [line];
    } else {
      currentChunk.push(line);
    }
  }
  if (currentChunk.length > 0) {
    fileChunks.push(currentChunk.join('\n'));
  }

  // Keep as many complete files as possible within the limit
  const includedChunks: string[] = [];
  let currentBytes = 0;
  const truncationMarker =
    '\n\n...remaining files truncated to stay within size limit...\n';
  const markerBytes = Buffer.byteLength(truncationMarker, 'utf8');

  for (const chunk of fileChunks) {
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');

    // Check if adding this chunk would exceed limit (accounting for marker)
    if (
      currentBytes + chunkBytes + markerBytes > maxBytes &&
      includedChunks.length > 0
    ) {
      break;
    }

    includedChunks.push(chunk);
    currentBytes += chunkBytes + 1; // +1 for newline separator
  }

  // If we truncated any files, add marker
  if (includedChunks.length < fileChunks.length) {
    const truncatedCount = fileChunks.length - includedChunks.length;
    return (
      includedChunks.join('\n') +
      `\n\n...${truncatedCount} file(s) truncated to stay within size limit...\n`
    );
  }

  return includedChunks.join('\n');
}

export interface AddedLine {
  line: number;
  content: string;
}

export interface LinePosition {
  line: number;
  position: number;
}

/**
 * Parse a unified diff patch and return the added lines with their absolute
 * line numbers on the new file.
 */
export function mapAddedLines(patch: string | undefined): AddedLine[] {
  if (!patch) return [];

  const lines = patch.split('\n');
  const added: AddedLine[] = [];

  let currentNew = 0;
  const hunkRegex = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  const noNewlineMarker = '\\ No newline at end of file';

  for (const raw of lines) {
    if (raw === noNewlineMarker) {
      continue; // marker only, do not advance line numbers
    }

    const hunkMatch = raw.match(hunkRegex);
    if (hunkMatch) {
      currentNew = parseInt(hunkMatch[2], 10);
      continue;
    }

    if (raw.startsWith('+')) {
      added.push({ line: currentNew, content: raw.slice(1) });
      currentNew += 1;
    } else if (raw.startsWith('-')) {
      // Only advance old line counter; no change to new file.
    } else {
      currentNew += 1;
    }
  }

  return added;
}

/**
 * Map absolute line numbers to diff positions for GitHub PR review comments.
 * Position is the line number within the diff (1-indexed).
 */
export function mapLinesToPositions(
  patch: string | undefined
): Map<number, number> {
  const map = new Map<number, number>();
  if (!patch) return map;

  const lines = patch.split('\n');
  let currentNew = 0;
  let position = 0;
  const hunkRegex = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  const noNewlineMarker = '\\ No newline at end of file';

  for (const raw of lines) {
    if (raw === noNewlineMarker) {
      continue; // marker only, do not advance counters
    }

    position += 1;

    const hunkMatch = raw.match(hunkRegex);
    if (hunkMatch) {
      currentNew = parseInt(hunkMatch[2], 10);
      continue;
    }

    if (raw.startsWith('+')) {
      map.set(currentNew, position);
      currentNew += 1;
    } else if (raw.startsWith('-')) {
      // Deleted lines don't advance new line counter
    } else {
      map.set(currentNew, position);
      currentNew += 1;
    }
  }

  return map;
}

/**
 * Pick the most relevant added line near an LLM-reported finding line.
 *
 * LLMs sometimes point to the function signature or adjacent context line instead
 * of the exact changed line. GitHub accepts both if they are in the diff, but the
 * review is more useful when anchored to the actual risky statement.
 */
export function chooseBestAddedLineForComment(
  patch: string | undefined,
  reportedLine: number,
  commentBody: string,
  searchRadius = 4
): number {
  const added = mapAddedLines(patch);
  if (added.length === 0) return reportedLine;

  const nearby = added.filter(
    (line) => Math.abs(line.line - reportedLine) <= searchRadius
  );
  if (nearby.length === 0) return reportedLine;

  const bodyTokens = tokenizeForLineScoring(commentBody);
  const riskTerms = getRiskTerms(commentBody);

  const score = (candidate: AddedLine): number => {
    const content = candidate.content;
    const lower = content.toLowerCase();
    const codeTokens = tokenizeForLineScoring(content);
    const overlap = Array.from(codeTokens).filter((token) =>
      bodyTokens.has(token)
    ).length;
    const proximity = Math.max(
      0,
      searchRadius + 1 - Math.abs(candidate.line - reportedLine)
    );
    const riskScore = riskTerms.reduce(
      (sum, term) => sum + (term.test(lower) ? 3 : 0),
      0
    );
    const interpolationScore = /\$\{.+?\}/.test(content) ? 2 : 0;
    const callScore = /\b[a-zA-Z_$][\w$]*\s*\(/.test(content) ? 1 : 0;
    const declarationPenalty =
      /^\s*(export\s+)?(async\s+)?(function|class|interface|type)\b/.test(
        content
      )
        ? -2
        : 0;

    return (
      proximity +
      overlap +
      riskScore +
      interpolationScore +
      callScore +
      declarationPenalty
    );
  };

  const current = nearby.find((line) => line.line === reportedLine);
  const currentScore = current ? score(current) : Number.NEGATIVE_INFINITY;
  const best = [...nearby].sort(
    (a, b) =>
      score(b) - score(a) ||
      Math.abs(a.line - reportedLine) - Math.abs(b.line - reportedLine)
  )[0];
  const bestScore = score(best);

  return bestScore > currentScore + 1 ? best.line : reportedLine;
}

function tokenizeForLineScoring(text: string): Set<string> {
  const stopWords = new Set([
    'the',
    'and',
    'for',
    'with',
    'this',
    'that',
    'from',
    'into',
    'value',
    'line',
    'risk',
    'issue',
    'critical',
    'major',
    'minor',
    'severity',
  ]);

  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9_$]+/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !stopWords.has(token))
  );
}

function getRiskTerms(commentBody: string): RegExp[] {
  const body = commentBody.toLowerCase();
  const terms: RegExp[] = [];

  if (/\bsql\b|injection|query|database/.test(body)) {
    terms.push(
      /\b(query|execute|exec|select|insert|update|delete|where)\b/,
      /`.*\$\{.*\}/
    );
  }
  if (/xss|html|script|sanitize/.test(body)) {
    terms.push(
      /innerhtml|dangerouslysetinnerhtml|document\.write|sanitize|escape/
    );
  }
  if (/command|shell|rce|exec|spawn/.test(body)) {
    terms.push(/\b(exec|spawn|execfile|system|shell_exec|popen)\b/);
  }
  if (/secret|token|password|credential/.test(body)) {
    terms.push(/secret|token|password|credential|apikey|api_key/);
  }

  return terms;
}

/**
 * Check if a line range is within a single contiguous hunk.
 * Returns false if range crosses non-contiguous hunk boundaries.
 *
 * @param startLine - First line of range (inclusive)
 * @param endLine - Last line of range (inclusive)
 * @param patch - Unified diff patch string
 * @returns true if range is within single hunk, false otherwise
 */
export function isRangeWithinSingleHunk(
  startLine: number,
  endLine: number,
  patch: string | undefined
): boolean {
  if (!patch) return false;

  const lines = patch.split('\n');
  const hunkRegex = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  const noNewlineMarker = '\\ No newline at end of file';

  let currentNew = 0;
  let foundStart = false;
  let inActiveHunk = false;

  for (const raw of lines) {
    if (raw === noNewlineMarker) continue;

    const hunkMatch = raw.match(hunkRegex);

    if (hunkMatch) {
      // New hunk starting
      if (foundStart) {
        // We found start but hit a new hunk before finding end
        // This means range crosses hunk boundary
        return false;
      }
      currentNew = parseInt(hunkMatch[2], 10);
      inActiveHunk = true;
      continue;
    }

    if (!inActiveHunk) continue;

    // Track RIGHT side lines (added or context, not deleted)
    if (raw.startsWith('+') || (!raw.startsWith('-') && raw.length > 0)) {
      if (currentNew === startLine) {
        foundStart = true;
      }
      if (currentNew === endLine) {
        // Found end - only valid if we found start in same hunk
        return foundStart;
      }
      currentNew += 1;
    }
    // Deleted lines don't advance currentNew (LEFT side only)
  }

  // Never found complete range
  return false;
}

/**
 * Filter a full diff to only include chunks for the given files.
 * Uses lightweight line scanning with a minimal regex for headers.
 */
export function filterDiffByFiles(
  diff: string,
  files: ReadonlyArray<{ filename: string }>
): string {
  if (files.length === 0) return '';
  if (!diff || diff.trim().length === 0) return '';

  const target = new Set(files.map((f) => f.filename));
  const lines = diff.split('\n');
  const chunks: string[] = [];
  let currentChunk: string[] = [];
  let includeCurrent = false;

  const pushChunkIfIncluded = () => {
    if (includeCurrent && currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n'));
    }
    currentChunk = [];
    includeCurrent = false;
  };

  for (const line of lines) {
    const normalizedLine = line.replace(/\r$/, '');
    const isHeader = normalizedLine.startsWith('diff --git ');
    if (isHeader) {
      pushChunkIfIncluded();
      const match = normalizedLine.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/);
      if (!match) {
        currentChunk.push(line);
        continue;
      }
      const rawA = match[1].trim();
      const rawB = match[2].trim();
      const aPath = unquoteGitPath(rawA);
      const bPath = unquoteGitPath(rawB);
      // Check both paths to correctly handle renames/moves
      includeCurrent = target.has(bPath) || target.has(aPath);
      currentChunk.push(line);
    } else {
      currentChunk.push(line);
    }
  }

  pushChunkIfIncluded();

  // Remove possible trailing empty string from split/join differences
  return chunks.join('\n').trimEnd();
}

export interface RecoveredFileDiffResult {
  readonly diff: string;
  readonly unavailableFiles: readonly string[];
}

/**
 * Recover file patches omitted only from an aggregate PR diff. GitHub still
 * returns those patches through the paginated files API, so bounded batches
 * can review them without lifting the aggregate memory cap.
 */
export function recoverDiffForFiles(
  aggregateDiff: string,
  files: ReadonlyArray<{
    filename: string;
    status: string;
    patch?: string;
    previousFilename?: string;
  }>
): RecoveredFileDiffResult {
  const filtered = filterDiffByFiles(aggregateDiff, files);
  const includedPaths = extractDiffPaths(filtered);
  const recoveredBlocks: string[] = [];
  const unavailableFiles: string[] = [];

  for (const file of files) {
    if (
      includedPaths.has(file.filename) ||
      (file.previousFilename && includedPaths.has(file.previousFilename))
    ) {
      continue;
    }
    if (!file.patch?.trim()) {
      unavailableFiles.push(file.filename);
      continue;
    }

    const oldPath = file.previousFilename || file.filename;
    const fromPath = file.status === 'added' ? '/dev/null' : `a/${oldPath}`;
    const toPath =
      file.status === 'removed' ? '/dev/null' : `b/${file.filename}`;
    recoveredBlocks.push(
      [
        `diff --git a/${oldPath} b/${file.filename}`,
        `--- ${fromPath}`,
        `+++ ${toPath}`,
        file.patch,
      ].join('\n')
    );
  }

  return {
    diff: [filtered, ...recoveredBlocks].filter(Boolean).join('\n'),
    unavailableFiles,
  };
}

function extractDiffPaths(diff: string): Set<string> {
  const paths = new Set<string>();
  const header = /^diff --git\s+a\/(.+?)\s+b\/(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = header.exec(diff)) !== null) {
    paths.add(unquoteGitPath(match[1].trim()));
    paths.add(unquoteGitPath(match[2].trim()));
  }
  return paths;
}

export interface CompactedDiffFile {
  filename: string;
  reason: string;
  additions: number;
  deletions: number;
  changes: number;
  bytes: number;
}

export interface CompactedDiffResult {
  diff: string;
  summaryOnlyFiles: CompactedDiffFile[];
}

export interface CompactDiffOptions {
  enabled?: boolean;
  maxFullFileBytes?: number;
  maxFullFileChanges?: number;
}

interface DiffChunk {
  aPath: string;
  bPath: string;
  text: string;
}

/**
 * Keep high-value source diffs verbatim and replace low-signal or huge files
 * with metadata summaries. Codex can still inspect omitted files with git diff
 * in agentic read-only mode, but the primary prompt stays focused.
 */
export function compactDiffForPrompt(
  diff: string,
  files: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
  }>,
  options: CompactDiffOptions = {}
): CompactedDiffResult {
  if (!options.enabled || !diff.trim()) {
    return { diff, summaryOnlyFiles: [] };
  }

  const maxFullFileBytes = options.maxFullFileBytes ?? 40_000;
  const maxFullFileChanges = options.maxFullFileChanges ?? 800;
  const fileByName = new Map(files.map((file) => [file.filename, file]));
  const chunks = splitDiffIntoChunks(diff);
  const output: string[] = [];
  const summaryOnlyFiles: CompactedDiffFile[] = [];

  for (const chunk of chunks) {
    if (!chunk.bPath) {
      output.push(chunk.text);
      continue;
    }
    const file = fileByName.get(chunk.bPath) || fileByName.get(chunk.aPath);
    const filename = file?.filename || chunk.bPath;
    const bytes = Buffer.byteLength(chunk.text, 'utf8');
    const changes = file?.changes ?? 0;
    const reason = getSummaryOnlyDiffReason(filename, bytes, changes, {
      maxFullFileBytes,
      maxFullFileChanges,
    });

    if (!reason) {
      output.push(chunk.text);
      continue;
    }

    const metadata: CompactedDiffFile = {
      filename,
      reason,
      additions: file?.additions ?? 0,
      deletions: file?.deletions ?? 0,
      changes,
      bytes,
    };
    summaryOnlyFiles.push(metadata);
    output.push(formatSummaryOnlyChunk(chunk, metadata));
  }

  return {
    diff: output.join('\n').trimEnd(),
    summaryOnlyFiles,
  };
}

function splitDiffIntoChunks(diff: string): DiffChunk[] {
  const lines = diff.split('\n');
  const chunks: DiffChunk[] = [];
  let current: string[] = [];
  let currentA = '';
  let currentB = '';

  const push = () => {
    if (current.length > 0) {
      chunks.push({
        aPath: currentA,
        bPath: currentB,
        text: current.join('\n'),
      });
    }
    current = [];
    currentA = '';
    currentB = '';
  };

  for (const line of lines) {
    const normalizedLine = line.replace(/\r$/, '');
    const match = normalizedLine.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/);
    if (match) {
      push();
      currentA = unquoteGitPath(match[1].trim());
      currentB = unquoteGitPath(match[2].trim());
    }
    current.push(line);
  }

  push();
  return chunks;
}

export function getSummaryOnlyDiffReason(
  filename: string,
  bytes: number,
  changes: number,
  options: { maxFullFileBytes?: number; maxFullFileChanges?: number } = {}
): string | null {
  const maxFullFileBytes = options.maxFullFileBytes ?? 40_000;
  const maxFullFileChanges = options.maxFullFileChanges ?? 800;
  const lower = filename.toLowerCase();

  if (isDependencyLockPath(lower)) return 'dependency lock file';
  if (isGeneratedPath(filename)) return 'generated file';
  if (bytes > maxFullFileBytes)
    return `large diff over ${maxFullFileBytes} bytes`;
  if (changes > maxFullFileChanges)
    return `large diff over ${maxFullFileChanges} changed lines`;

  return null;
}

function isDependencyLockPath(lower: string): boolean {
  return /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|pubspec\.lock|gemfile\.lock|cargo\.lock|poetry\.lock|go\.sum|composer\.lock|pdm\.lock|pipfile\.lock)$/.test(
    lower
  );
}

/**
 * Identify generated artifacts for prompt compaction and trivial-change policy.
 */
export function isGeneratedPath(filename: string): boolean {
  const lower = filename.replace(/\\/g, '/').toLowerCase();

  return (
    lower.startsWith('generated/') ||
    lower.includes('/generated/') ||
    lower.startsWith('generated_') ||
    lower.includes('/generated_') ||
    /\.(g|freezed|pb|pbenum|pbjson|pbserver)\.dart$/.test(lower) ||
    /\.generated\.[jt]sx?$/.test(lower) ||
    /\.min\.(js|css)$/.test(lower) ||
    /\.map$/.test(lower)
  );
}

function formatSummaryOnlyChunk(
  chunk: DiffChunk,
  file: CompactedDiffFile
): string {
  return [
    `diff --git a/${chunk.aPath} b/${chunk.bPath}`,
    `# ReviewRouter: full diff omitted from primary prompt (${file.reason}).`,
    `# File: ${file.filename}`,
    `# Stats: +${file.additions}/-${file.deletions}, ${file.changes} changed lines, ${file.bytes} diff bytes.`,
    '# If this file is relevant, inspect it with read-only commands before reporting findings:',
    `#   git diff -- ${shellQuote(file.filename)}`,
  ].join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function unquoteGitPath(path: string): string {
  // Git may quote paths with spaces or special chars using C-style escapes
  if (path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1);
  }
  // Unescape common sequences produced by git (\" and \\ and \t etc.)
  try {
    path = path.replace(/\\([\\"tnr])/g, (_m, ch) => {
      switch (ch) {
        case '\\':
          return '\\';
        case '"':
          return '"';
        case 't':
          return '\t';
        case 'n':
          return '\n';
        case 'r':
          return '\r';
        default:
          return ch;
      }
    });
  } catch {
    // If anything goes wrong, fall back to raw path
  }
  return path;
}
