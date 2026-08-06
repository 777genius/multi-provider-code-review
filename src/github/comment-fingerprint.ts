import { createHash } from 'crypto';
import { Finding } from '../types';
import {
  FindingMarkerParseKind,
  parseFindingMarker,
  stripReservedFindingMarkerSyntax,
} from '../review-projection/domain/finding-marker';

const INLINE_MARKER_RE =
  /<!--\s*(?:review-router|ai-robot-review)-inline:([a-f0-9]{16})\s*-->/i;
const INLINE_MARKER_RE_GLOBAL =
  /<!--\s*(?:review-router|ai-robot-review)-inline:([a-f0-9]{16})\s*-->/gi;
const MAX_NEARBY_LINE_DISTANCE = 12;

export interface InlineCommentReference {
  path: string | undefined;
  line: number | null | undefined;
  body: string;
}

export function signatureFromInlineComment(
  path: string | undefined,
  line: number | null | undefined,
  body: string
): string {
  const cleanBody = stripInlineFingerprintMarkers(body);
  const severity = extractSeverity(cleanBody);
  if (severity) {
    return [
      (path || 'unknown').toLowerCase(),
      String(line ?? 0),
      severity,
    ].join(':');
  }

  const titleMatch = cleanBody.match(/\*\*(.+?)\*\*/);
  const title = titleMatch
    ? titleMatch[1]
    : cleanBody.split('\n')[0] || 'unknown';

  return [
    (path || 'unknown').toLowerCase(),
    String(line ?? 0),
    normalizeForSignature(title),
  ].join(':');
}

export function fingerprintFromInlineComment(
  path: string | undefined,
  line: number | null | undefined,
  body: string
): string {
  return createHash('sha256')
    .update(signatureFromInlineComment(path, line, body))
    .digest('hex')
    .slice(0, 16);
}

export function inlineFingerprintMarker(fingerprint: string): string {
  return `<!-- review-router-inline:${fingerprint} -->`;
}

export function findingFingerprintMarker(fingerprint: string): string {
  return `<!-- review-router-finding:${fingerprint} -->`;
}

export function extractInlineFingerprint(body?: string | null): string | null {
  const match = body?.match(INLINE_MARKER_RE);
  return match?.[1]?.toLowerCase() ?? null;
}

export function extractFindingFingerprint(body?: string | null): string | null {
  const parsed = parseFindingMarker(body);
  return parsed.kind === FindingMarkerParseKind.Valid
    ? parsed.fingerprint
    : null;
}

export function appendInlineFingerprintMarker(
  body: string,
  path: string | undefined,
  line: number | null | undefined
): string {
  const sanitizedBody = stripReservedFindingMarkerSyntax(body);
  const parts = [sanitizedBody.trimEnd()];
  if (!extractInlineFingerprint(sanitizedBody)) {
    parts.push(
      inlineFingerprintMarker(
        fingerprintFromInlineComment(path, line, sanitizedBody)
      )
    );
  }
  parts.push(
    findingFingerprintMarker(
      findingFingerprintFromInlineComment(path, line, sanitizedBody)
    )
  );
  return parts.join('\n\n');
}

export function stripInlineFingerprintMarkers(body: string): string {
  return stripReservedFindingMarkerSyntax(
    body.replace(INLINE_MARKER_RE_GLOBAL, '')
  ).trim();
}

export function isReviewRouterInlineComment(body?: string | null): boolean {
  if (!body) return false;
  if (extractInlineFingerprint(body)) return true;
  const trimmed = body.trim();
  return (
    /^\*\*(?:🔴 Critical|🟡 Major|🔵 Minor)\s+-\s+.+?\*\*/.test(trimmed) ||
    /^_(?:🔴 Critical|🟡 Major|🔵 Minor)_/.test(trimmed)
  );
}

export const isAiRobotInlineComment = isReviewRouterInlineComment;

export function findingFingerprintFromFinding(finding: Finding): string {
  return stableFindingFingerprint({
    path: finding.file,
    severity: finding.severity,
    title: finding.title,
    message: finding.message,
  });
}

export function findingFingerprintFromInlineComment(
  path: string | undefined,
  _line: number | null | undefined,
  body: string
): string {
  const marker = extractFindingFingerprint(body);
  if (marker) return marker;

  const cleanBody = stripInlineFingerprintMarkers(body);
  return stableFindingFingerprint({
    path,
    severity: extractSeverity(cleanBody) || 'unknown',
    title: extractNormalizedTitle(cleanBody),
    message: extractCoreMessage(cleanBody),
  });
}

export function extractInlineSeverity(body: string): string | null {
  return extractSeverity(stripInlineFingerprintMarkers(body));
}

export function extractInlineTitle(body: string): string {
  return stripSeverityPrefix(extractTitle(stripInlineFingerprintMarkers(body)));
}

export function isLikelySameInlineFinding(
  existing: InlineCommentReference,
  candidate: InlineCommentReference
): boolean {
  const existingPath = (existing.path || '').toLowerCase();
  const candidatePath = (candidate.path || '').toLowerCase();
  if (!existingPath || existingPath !== candidatePath) return false;

  const existingBody = stripInlineFingerprintMarkers(existing.body);
  const candidateBody = stripInlineFingerprintMarkers(candidate.body);

  const existingLine = existing.line ?? 0;
  const candidateLine = candidate.line ?? 0;
  const lineDistance = Math.abs(existingLine - candidateLine);
  const nearbyLine = lineDistance <= MAX_NEARBY_LINE_DISTANCE;

  const existingTitleTokens = tokenize(extractTitle(existingBody));
  const candidateTitleTokens = tokenize(extractTitle(candidateBody));
  const titleSimilarity = diceSimilarity(
    existingTitleTokens,
    candidateTitleTokens
  );

  const existingTokens = tokenize(semanticText(existingBody));
  const candidateTokens = tokenize(semanticText(candidateBody));
  const bodySimilarity = diceSimilarity(existingTokens, candidateTokens);

  const existingCodeTokens = extractCodeTokens(existingBody);
  const candidateCodeTokens = extractCodeTokens(candidateBody);
  const sharedCodeTokens = intersectionSize(
    existingCodeTokens,
    candidateCodeTokens
  );

  if (nearbyLine && titleSimilarity >= 0.45) return true;
  if (nearbyLine && bodySimilarity >= 0.38) return true;
  if (nearbyLine && sharedCodeTokens > 0 && bodySimilarity >= 0.24) return true;

  // Allow larger line shifts only when the model is clearly repeating the same issue.
  return titleSimilarity >= 0.6 && bodySimilarity >= 0.55;
}

function normalizeForSignature(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function extractSeverity(body: string): string | null {
  const match =
    body.match(/\*\*(?:[^\w*`]*\s*)?(critical|major|minor)\s*-/i) ||
    body.match(/^_(?:[^\w_]*\s*)?(critical|major|minor)_/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function extractTitle(body: string): string {
  const titleMatch = body.match(/\*\*(.+?)\*\*/);
  return titleMatch?.[1] ?? body.split('\n')[0] ?? '';
}

function stripSeverityPrefix(value: string): string {
  return value
    .replace(/^[^\w`]*\s*(critical|major|minor)\s*-\s*/i, '')
    .replace(/^[^\w`]*\s*/, '')
    .trim();
}

function extractNormalizedTitle(body: string): string {
  return stripSeverityPrefix(extractTitle(body));
}

function extractCoreMessage(body: string): string {
  return semanticText(body)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\*\*.+\*\*$/.test(line))
    .slice(0, 6)
    .join(' ');
}

function stableFindingFingerprint(input: {
  path: string | undefined;
  severity: string;
  title: string;
  message: string;
}): string {
  const canonical = [
    'review-router-finding-v2',
    (input.path || 'unknown').toLowerCase(),
    normalizeForSignature(input.severity),
    normalizeForSignature(stripSeverityPrefix(input.title)),
    normalizeForSignature(input.message).slice(0, 800),
  ].join('\n');

  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function semanticText(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\*\*Severity:\*\*[\s\S]*?(?:\n\n|$)/gi, ' ')
    .replace(/\*\*Provider:\*\*[\s\S]*?(?:\n\n|$)/gi, ' ')
    .replace(/\*\*Suggestion:\*\*[\s\S]*?(?:\n\n|$)/gi, ' ');
}

function tokenize(value: string): Set<string> {
  const normalized = splitIdentifiers(value)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ');
  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
  return new Set(tokens);
}

function extractCodeTokens(body: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of body.matchAll(/`([^`\n]{2,120})`/g)) {
    for (const token of tokenize(match[1])) {
      tokens.add(token);
    }
  }
  return tokens;
}

function splitIdentifiers(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_./:-]+/g, ' ');
}

function diceSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  return (2 * intersectionSize(a, b)) / (a.size + b.size);
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of a) {
    if (b.has(token)) count += 1;
  }
  return count;
}

const STOPWORDS = new Set([
  'about',
  'after',
  'also',
  'and',
  'are',
  'because',
  'before',
  'branch',
  'but',
  'can',
  'cannot',
  'comment',
  'could',
  'does',
  'every',
  'file',
  'for',
  'from',
  'has',
  'have',
  'into',
  'line',
  'lines',
  'major',
  'minor',
  'must',
  'not',
  'only',
  'return',
  'should',
  'that',
  'the',
  'this',
  'true',
  'use',
  'uses',
  'using',
  'when',
  'where',
  'will',
  'with',
  'would',
]);
