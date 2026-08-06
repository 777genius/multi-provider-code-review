import { Finding, InlineComment, Severity } from '../types';
import { GitHubClient } from './client';
import { logger } from '../utils/logger';
import { ProviderWeightTracker } from '../learning/provider-weights';
import { severityHeading, severityLine } from '../utils/severity';
import {
  extractInlineFingerprint,
  findingFingerprintFromFinding,
  findingFingerprintFromInlineComment,
  fingerprintFromInlineComment,
  extractInlineSeverity,
  extractInlineTitle,
  InlineCommentReference,
  isReviewRouterInlineComment,
  isLikelySameInlineFinding,
  signatureFromInlineComment,
} from './comment-fingerprint';
import { ReviewLedger } from './ledger';
import {
  FindingMarkerParseKind,
  parseFindingMarker,
} from '../review-projection/domain';

export interface ReviewCommentState {
  suppressed: Set<string>;
  alreadyPosted: Set<string>;
  commandDismissed?: Set<string>;
  commandDismissedLocations?: Set<string>;
  commandDismissedFindings?: DismissedFindingReference[];
  suppressedComments: InlineCommentReference[];
  alreadyPostedComments: InlineCommentReference[];
  commandDismissedComments?: InlineCommentReference[];
}

interface DismissedFindingReference extends InlineCommentReference {
  fingerprint: string;
  legacyFingerprint?: string;
  severity?: Severity;
  title?: string;
}

interface ReviewCommentApiItem {
  id?: number;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  body?: string | null;
  in_reply_to_id?: number | null;
  user?: {
    login?: string | null;
  } | null;
}

export class FeedbackFilter {
  constructor(
    private readonly client: GitHubClient,
    _providerWeightTracker?: ProviderWeightTracker,
    private readonly ledger?: ReviewLedger
  ) {}

  async loadSuppressed(prNumber: number): Promise<Set<string>> {
    return (await this.loadReviewCommentState(prNumber)).suppressed;
  }

  async loadReviewCommentState(
    prNumber: number,
    headSha?: string
  ): Promise<ReviewCommentState> {
    const { octokit, owner, repo } = this.client;
    const suppressed = new Set<string>();
    const alreadyPosted = new Set<string>();
    const commandDismissed = new Set<string>();
    const commandDismissedLocations = new Set<string>();
    const suppressedComments: InlineCommentReference[] = [];
    const alreadyPostedComments: InlineCommentReference[] = [];
    const commandDismissedComments: InlineCommentReference[] = [];
    const commandDismissedFindings: DismissedFindingReference[] = [];

    try {
      const comments = (await octokit.paginate(
        octokit.rest.pulls.listReviewComments,
        {
          owner,
          repo,
          pull_number: prNumber,
          per_page: 100,
        }
      )) as ReviewCommentApiItem[];
      for (const comment of comments) {
        const activeLine = comment.line;
        const line = activeLine ?? comment.original_line;
        const body = comment.body || '';
        const signature = this.signatureFromComment(comment.path, line, body);
        const marker = extractInlineFingerprint(body);

        // Only active review comments should suppress reposting. Outdated
        // comments have line=null and should not hide a fresh current-diff
        // comment if the finding still exists after a new push.
        if (isReviewRouterInlineComment(body) && activeLine != null) {
          alreadyPosted.add(signature);
          if (marker) alreadyPosted.add(marker);
          alreadyPostedComments.push({
            path: comment.path,
            line: activeLine,
            body,
          });
        }

        if (typeof comment.id !== 'number') continue;
      }
    } catch (error) {
      logger.warn(
        'Failed to load review comments for feedback filter',
        error as Error
      );
    }

    if (this.ledger) {
      try {
        const loaded = await this.ledger.load(prNumber);
        if (!loaded.valid) {
          logger.warn(
            `ReviewRouter override ledger ignored: ${loaded.invalidReason || 'invalid ledger'}`
          );
        } else {
          for (const skip of this.ledger.activeSkips(loaded.payload, headSha)) {
            commandDismissed.add(skip.fingerprint);
            const location = locationKey(skip.path, skip.line);
            if (location) commandDismissedLocations.add(location);
            if (skip.path) {
              const body = skippedFindingBody(skip);
              const reference: DismissedFindingReference = {
                path: skip.path,
                line: skip.line,
                body,
                fingerprint: skip.fingerprint,
                legacyFingerprint: skip.legacyFingerprint,
                severity: skip.severity,
                title: skip.title,
              };
              commandDismissedComments.push(reference);
              commandDismissedFindings.push(reference);
            }
          }
        }
      } catch (error) {
        logger.warn(
          'Failed to load ReviewRouter override ledger',
          error as Error
        );
      }
    }

    return {
      suppressed,
      alreadyPosted,
      commandDismissed,
      commandDismissedLocations,
      commandDismissedFindings,
      suppressedComments,
      alreadyPostedComments,
      commandDismissedComments,
    };
  }

  shouldPost(
    comment: InlineComment,
    state: Set<string> | ReviewCommentState
  ): boolean {
    const signature = this.signatureFromComment(
      comment.path,
      comment.line,
      comment.body
    );
    const fingerprint = fingerprintFromInlineComment(
      comment.path,
      comment.line,
      comment.body
    );

    if (state instanceof Set) {
      return !state.has(signature) && !state.has(fingerprint);
    }

    return (
      !state.suppressed.has(signature) &&
      !state.suppressed.has(fingerprint) &&
      !(state.commandDismissed?.has(signature) ?? false) &&
      !(state.commandDismissed?.has(fingerprint) ?? false) &&
      !state.alreadyPosted.has(signature) &&
      !state.alreadyPosted.has(fingerprint) &&
      !state.suppressedComments.some((existing) =>
        isLikelySameInlineFinding(existing, comment)
      ) &&
      !(
        state.commandDismissedFindings?.some((existing) =>
          isLikelySameDismissedFinding(existing, comment)
        ) ?? false
      ) &&
      !state.alreadyPostedComments.some((existing) =>
        isLikelySameInlineFinding(existing, comment)
      )
    );
  }

  isFindingCommandDismissed(
    finding: Finding,
    state: ReviewCommentState
  ): boolean {
    const body = [
      `**${severityHeading(finding.severity, finding.title)}**`,
      '',
      severityLine(finding.severity),
      '',
      finding.message,
    ].join('\n');
    const findingFingerprint = findingFingerprintFromFinding(finding);
    if (state.commandDismissed?.has(findingFingerprint) ?? false) {
      return true;
    }
    return this.isCommandDismissed(
      { path: finding.file, line: finding.line, body },
      state
    );
  }

  isInlineCommandDismissed(
    comment: InlineComment,
    state: ReviewCommentState
  ): boolean {
    return this.isCommandDismissed(comment, state);
  }

  private isCommandDismissed(
    comment: InlineCommentReference,
    state: ReviewCommentState
  ): boolean {
    const commandDismissed = state.commandDismissed ?? new Set<string>();
    const signature = this.signatureFromComment(
      comment.path,
      comment.line,
      comment.body
    );
    const fingerprint = fingerprintFromInlineComment(
      comment.path,
      comment.line,
      comment.body
    );
    const marker = parseFindingMarker(comment.body);
    if (
      marker.kind === FindingMarkerParseKind.Conflict ||
      marker.kind === FindingMarkerParseKind.Malformed
    ) {
      return false;
    }
    const findingFingerprint =
      marker.kind === FindingMarkerParseKind.Valid
        ? marker.fingerprint
        : findingFingerprintFromInlineComment(
            comment.path,
            comment.line,
            comment.body
          );
    const commandDismissedFindings = state.commandDismissedFindings ?? [];

    return (
      commandDismissed.has(signature) ||
      commandDismissed.has(fingerprint) ||
      commandDismissed.has(findingFingerprint) ||
      commandDismissedFindings.some((existing) =>
        isLikelySameDismissedFinding(existing, comment)
      )
    );
  }

  private signatureFromComment(
    path: string | undefined,
    line: number | null | undefined,
    body: string
  ): string {
    return signatureFromInlineComment(path, line, body);
  }
}

function skippedFindingBody(skip: {
  severity: Severity;
  title?: string;
  body?: string;
  reason?: string;
}): string {
  if (skip.body?.trim()) return skip.body;

  return [
    `**${skip.severity} - ${skip.title || 'Skipped finding'}**`,
    '',
    skip.reason || 'Skipped by maintainer command.',
  ].join('\n');
}

function isLikelySameDismissedFinding(
  existing: DismissedFindingReference,
  candidate: InlineCommentReference
): boolean {
  const existingPath = (existing.path || '').toLowerCase();
  const candidatePath = (candidate.path || '').toLowerCase();
  if (!existingPath || existingPath !== candidatePath) {
    return false;
  }

  const existingLine = existing.line ?? 0;
  const candidateLine = candidate.line ?? 0;
  const lineDistance = Math.abs(existingLine - candidateLine);
  const sameLine = lineDistance === 0;
  const nearbyLine = lineDistance <= 4;
  if (!sameLine && !nearbyLine) {
    return false;
  }

  const candidateSeverity = normalizeSeverity(
    extractInlineSeverity(candidate.body)
  );
  const severityCompatible =
    !existing.severity ||
    !candidateSeverity ||
    existing.severity === candidateSeverity;

  const existingTitle = existing.title || extractInlineTitle(existing.body);
  const candidateTitle = extractInlineTitle(candidate.body);
  const titleSimilarity = tokenSimilarity(existingTitle, candidateTitle);
  const bodySimilarity = tokenSimilarity(existing.body, candidate.body);
  const sharedCodeTokens = intersectionSize(
    codeTokens(existing.body),
    codeTokens(candidate.body)
  );

  if (sameLine && severityCompatible && titleSimilarity >= 0.34) return true;
  if (sameLine && severityCompatible && bodySimilarity >= 0.28) return true;
  if (
    sameLine &&
    severityCompatible &&
    sharedCodeTokens > 0 &&
    bodySimilarity >= 0.2
  ) {
    return true;
  }
  if (
    sameLine &&
    !severityCompatible &&
    titleSimilarity >= 0.38 &&
    bodySimilarity >= 0.25
  ) {
    return true;
  }
  if (
    sameLine &&
    !severityCompatible &&
    sharedCodeTokens >= 2 &&
    bodySimilarity >= 0.2
  ) {
    return true;
  }

  if (nearbyLine && severityCompatible && titleSimilarity >= 0.48) return true;
  if (nearbyLine && severityCompatible && bodySimilarity >= 0.4) return true;
  if (
    nearbyLine &&
    severityCompatible &&
    sharedCodeTokens > 0 &&
    bodySimilarity >= 0.3
  ) {
    return true;
  }

  return false;
}

function normalizeSeverity(value: string | null): Severity | null {
  if (value === 'critical' || value === 'major' || value === 'minor') {
    return value;
  }
  return null;
}

function tokenSimilarity(a: string, b: string): number {
  const left = tokenize(a);
  const right = tokenize(b);
  if (left.size === 0 || right.size === 0) return 0;
  return (2 * intersectionSize(left, right)) / (left.size + right.size);
}

function tokenize(value: string): Set<string> {
  return new Set(
    splitIdentifiers(value)
      .toLowerCase()
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[^a-z0-9_]+/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !TOKEN_STOPWORDS.has(token))
  );
}

function codeTokens(body: string): Set<string> {
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

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of a) {
    if (b.has(token)) count += 1;
  }
  return count;
}

const TOKEN_STOPWORDS = new Set([
  'and',
  'any',
  'are',
  'because',
  'but',
  'can',
  'cannot',
  'critical',
  'does',
  'file',
  'for',
  'from',
  'has',
  'line',
  'lines',
  'major',
  'minor',
  'not',
  'null',
  'only',
  'should',
  'that',
  'the',
  'this',
  'use',
  'when',
  'with',
]);

function locationKey(
  path: string | undefined,
  line: number | null | undefined
): string | null {
  if (!path || line == null) return null;
  return `${path.toLowerCase()}:${line}`;
}
