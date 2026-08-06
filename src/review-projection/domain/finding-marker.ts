export enum FindingMarkerParseKind {
  Absent = 'absent',
  Valid = 'valid',
  Conflict = 'conflict',
  Malformed = 'malformed',
}

export type FindingMarkerParseResult =
  | { readonly kind: FindingMarkerParseKind.Absent }
  | {
      readonly kind: FindingMarkerParseKind.Valid;
      readonly fingerprint: string;
    }
  | {
      readonly kind: FindingMarkerParseKind.Conflict;
      readonly fingerprints: readonly string[];
    }
  | { readonly kind: FindingMarkerParseKind.Malformed };

const RESERVED_FINDING_MARKER_PREFIX_RE =
  /(?:review-router-finding:|reviewrouter:finding:v2:)/gi;
const LEGACY_FINDING_MARKER_RE =
  /<!--\s*review-router-finding:([a-f0-9]{24,64})\s*-->/gi;
const V2_FINDING_MARKER_RE =
  /(?<!\S)reviewrouter:finding:v2:((?:rrl_[a-f0-9]{32}|[a-f0-9]{24,64}))(?=$|[ \t\r\n])/g;
const RESERVED_FINDING_MARKER_COMMENT_RE =
  /<!--(?:(?!-->)[\s\S])*(?:review-router-finding:|reviewrouter:finding:v2:)(?:(?!-->)[\s\S])*-->/gi;
const UNCLOSED_RESERVED_FINDING_MARKER_COMMENT_RE =
  /<!--(?:(?!-->)[\s\S])*(?:review-router-finding:|reviewrouter:finding:v2:)[\s\S]*$/gi;
const RESERVED_FINDING_MARKER_TOKEN_RE =
  /(?:review-router-finding:|reviewrouter:finding:v2:)[^\s<]*/gi;

interface MarkerMatch {
  readonly start: number;
  readonly end: number;
  readonly fingerprint: string;
}

export function parseFindingMarker(
  body?: string | null
): FindingMarkerParseResult {
  if (!body) return { kind: FindingMarkerParseKind.Absent };

  const reservedPrefixOffsets = Array.from(
    body.matchAll(RESERVED_FINDING_MARKER_PREFIX_RE),
    (match) => match.index
  ).filter((offset): offset is number => offset !== undefined);
  if (reservedPrefixOffsets.length === 0) {
    return { kind: FindingMarkerParseKind.Absent };
  }

  const matches = [
    ...collectMarkerMatches(body, LEGACY_FINDING_MARKER_RE),
    ...collectMarkerMatches(body, V2_FINDING_MARKER_RE),
  ];
  const everyReservedPrefixIsValid = reservedPrefixOffsets.every((offset) =>
    matches.some((match) => offset >= match.start && offset < match.end)
  );
  if (!everyReservedPrefixIsValid) {
    return { kind: FindingMarkerParseKind.Malformed };
  }

  const fingerprints = Array.from(
    new Set(matches.map((match) => match.fingerprint))
  ).sort();
  if (fingerprints.length === 1) {
    return {
      kind: FindingMarkerParseKind.Valid,
      fingerprint: fingerprints[0],
    };
  }
  if (fingerprints.length > 1) {
    return { kind: FindingMarkerParseKind.Conflict, fingerprints };
  }
  return { kind: FindingMarkerParseKind.Malformed };
}

export function stripReservedFindingMarkerSyntax(body: string): string {
  return body
    .replace(RESERVED_FINDING_MARKER_COMMENT_RE, '')
    .replace(UNCLOSED_RESERVED_FINDING_MARKER_COMMENT_RE, '')
    .replace(RESERVED_FINDING_MARKER_TOKEN_RE, '')
    .replace(/<!--\s*-->/g, '')
    .trim();
}

export function findingMarkerV2(fingerprint: string): string {
  return `reviewrouter:finding:v2:${fingerprint}`;
}

function collectMarkerMatches(body: string, pattern: RegExp): MarkerMatch[] {
  return Array.from(body.matchAll(pattern), (match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    fingerprint: (match[1] ?? '').toLowerCase(),
  }));
}
