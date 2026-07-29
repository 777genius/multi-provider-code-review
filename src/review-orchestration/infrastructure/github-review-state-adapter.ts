import { createHash } from 'crypto';
import { GitHubClient } from '../../github/client';
import {
  commandLedgerWatermark,
  type LoadedLedger,
  type ReviewLedger,
} from '../../github/ledger';
import {
  ReviewThreadInventoryLoader,
  type ReviewThreadInventory,
} from '../../github/review-thread-inventory';
import type { LifecycleTarget } from '../../types';
import type { ReviewRevisionGuardPort } from '../application';
import {
  FindingSeverity,
  LifecycleResolutionMarkerTrust,
  LifecycleTargetDisposition,
  type CurrentLifecycleInventory,
  type ReviewProjectionScope,
} from '../../review-projection/domain';
import type { CurrentLifecycleInventoryPort } from '../../review-projection/application';

export type CanonicalReviewRevisionScope = {
  readonly workspaceId: string;
  readonly repositoryConnectionId: string;
  readonly scmRepositoryIdentityId: string;
  readonly pullRequestNumber: number;
};

export class GitHubReviewRevisionGuard implements ReviewRevisionGuardPort {
  constructor(
    private readonly client: GitHubClient,
    private readonly scope: CanonicalReviewRevisionScope
  ) {}

  async loadCurrentRevision() {
    const before = await this.loadPointer();
    const mergeBaseSha = await this.loadMergeBase(before);
    const after = await this.loadPointer();
    if (before.baseSha === after.baseSha && before.headSha === after.headSha) {
      return this.toRevision(before, mergeBaseSha);
    }

    // Return the newest observed pointer so the application can cooperatively
    // supersede. A later guard repeats the stable double-read before mutation.
    return this.toRevision(after, await this.loadMergeBase(after));
  }

  private async loadPointer(): Promise<{
    readonly baseSha: string;
    readonly headSha: string;
  }> {
    const response = await this.readGitHubRevisionFact(() =>
      this.client.octokit.rest.pulls.get({
        owner: this.client.owner,
        repo: this.client.repo,
        pull_number: this.scope.pullRequestNumber,
      })
    );
    return {
      baseSha: requireCommitSha(response.data.base?.sha, 'base_sha'),
      headSha: requireCommitSha(response.data.head?.sha, 'head_sha'),
    };
  }

  private async loadMergeBase(pointer: {
    readonly baseSha: string;
    readonly headSha: string;
  }): Promise<string> {
    const response = await this.readGitHubRevisionFact(() =>
      this.client.octokit.rest.repos.compareCommitsWithBasehead({
        owner: this.client.owner,
        repo: this.client.repo,
        basehead: `${pointer.baseSha}...${pointer.headSha}`,
      })
    );
    return requireCommitSha(response.data.merge_base_commit?.sha, 'merge_base');
  }

  private async readGitHubRevisionFact<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (!isTransientGitHubReadError(error)) throw error;
      throw new Error('review_action_v2_revision_guard_unavailable', {
        cause: error,
      });
    }
  }

  private toRevision(
    pointer: { readonly baseSha: string; readonly headSha: string },
    mergeBaseSha: string
  ) {
    const facts = {
      ...this.scope,
      baseSha: pointer.baseSha,
      mergeBaseSha,
      headSha: pointer.headSha,
    };
    return Object.freeze({
      baseSha: facts.baseSha,
      mergeBaseSha: facts.mergeBaseSha,
      headSha: facts.headSha,
      reviewRevisionHash: sha256(canonicalJson(facts)),
    });
  }
}

export class FreshGitHubLifecycleInventory implements CurrentLifecycleInventoryPort {
  private readonly loader: ReviewThreadInventoryLoader;

  constructor(
    client: GitHubClient,
    private readonly ledger: ReviewLedger
  ) {
    this.loader = new ReviewThreadInventoryLoader(client);
  }

  async loadCurrent(query: {
    readonly scope: ReviewProjectionScope;
  }): Promise<CurrentLifecycleInventory> {
    const [raw, ledger] = await Promise.all([
      this.loader.load(query.scope.pullRequestNumber),
      this.ledger.load(query.scope.pullRequestNumber),
    ]);
    return mapFreshInventory(raw, query.scope.reviewedHeadSha, ledger);
  }

  async loadForPrompt(
    pullRequestNumber: number,
    expectedHeadSha: string
  ): Promise<{
    readonly inventory: CurrentLifecycleInventory;
    readonly promptTargets: readonly LifecycleTarget[];
  }> {
    const [raw, ledger] = await Promise.all([
      this.loader.load(pullRequestNumber),
      this.ledger.load(pullRequestNumber),
    ]);
    const inventory = mapFreshInventory(raw, expectedHeadSha, ledger);
    return Object.freeze({
      inventory,
      promptTargets: Object.freeze([
        ...raw.candidates,
        ...raw.manualAttention.map((record) => record.target),
      ]),
    });
  }
}

function mapFreshInventory(
  raw: ReviewThreadInventory,
  expectedHeadSha: string,
  ledger: LoadedLedger
): CurrentLifecycleInventory {
  if (raw.failed) {
    throw new Error('review_action_v2_lifecycle_inventory_unavailable');
  }
  const loadedForHeadSha = requireCommitSha(
    raw.headRefOid,
    'lifecycle_head_sha'
  );
  if (loadedForHeadSha !== expectedHeadSha.toLowerCase()) {
    throw new Error('review_action_v2_lifecycle_inventory_revision_mismatch');
  }

  const rawTargets = [
    ...raw.candidates.map((target) => ({ target, manual: false })),
    ...raw.manualAttention.map((record) => ({
      target: record.target,
      manual: true,
    })),
  ].sort((left, right) =>
    compareCodeUnits(left.target.targetId, right.target.targetId)
  );
  if (
    new Set(rawTargets.map(({ target }) => target.targetId)).size !==
    rawTargets.length
  ) {
    throw new Error('review_action_v2_lifecycle_inventory_duplicate_target');
  }

  if (!ledger.valid) {
    throw new Error('review_action_v2_command_ledger_unavailable');
  }
  const warnings = [...raw.warnings].sort();
  const targets = rawTargets.map(({ target, manual }) => ({
    targetId: target.targetId,
    threadId: target.threadId,
    trustedMarker: target.fingerprint,
    title: target.title,
    message: target.message,
    severity: toProjectionSeverity(target.severity),
    originalPath: target.originalPath,
    ...(target.currentPath ? { currentPath: target.currentPath } : {}),
    ...(target.originalLine !== undefined
      ? { originalLine: target.originalLine }
      : {}),
    ...(target.currentLine !== undefined
      ? { currentLine: target.currentLine }
      : {}),
    parentCommentUpdatedAt: target.parentCommentUpdatedAt,
    threadCommentCount: target.threadCommentCount,
    disposition: target.reasonCodes?.includes('command_dismissed')
      ? LifecycleTargetDisposition.CommandSuppressed
      : manual || target.hasHumanReply
        ? LifecycleTargetDisposition.HumanReply
        : LifecycleTargetDisposition.Active,
    viewerCanResolve: target.viewerCanResolve,
    ...(target.trustedResolutionMarker
      ? {
          resolutionMarker: {
            schemaVersion: target.trustedResolutionMarker.schemaVersion,
            targetId: target.trustedResolutionMarker.targetId,
            fingerprint: target.trustedResolutionMarker.fingerprint,
            trust: LifecycleResolutionMarkerTrust.Trusted,
          },
        }
      : {}),
  }));
  const commandWatermark = commandLedgerWatermark(ledger.payload);
  const commandLedgerWatermarkValue = String(commandWatermark);
  const lifecycleStateHash = sha256(
    canonicalJson({
      commandLedgerWatermark: commandLedgerWatermarkValue,
      complete: true,
      loadedForHeadSha,
      targets,
      warnings,
    })
  );
  return Object.freeze({
    inventoryVersion: 'review_lifecycle_inventory.v1',
    loadedForHeadSha,
    lifecycleStateHash,
    commandLedgerWatermark: commandLedgerWatermarkValue,
    complete: true,
    warnings: Object.freeze(warnings),
    targets: Object.freeze(targets),
  });
}

function toProjectionSeverity(
  severity: LifecycleTarget['severity']
): FindingSeverity | 'unknown' {
  switch (severity) {
    case 'critical':
      return FindingSeverity.Critical;
    case 'major':
      return FindingSeverity.Major;
    case 'minor':
      return FindingSeverity.Minor;
    default:
      return 'unknown';
  }
}

function requireCommitSha(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error(`review_action_v2_${field}_invalid`);
  }
  return value.toLowerCase();
}

const TRANSIENT_GITHUB_NETWORK_ERROR_CODES = [
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
] as const;

function isTransientGitHubReadError(error: unknown): boolean {
  const candidate = error as {
    readonly status?: unknown;
    readonly code?: unknown;
    readonly message?: unknown;
  };
  const status =
    typeof candidate?.status === 'number' ? candidate.status : undefined;
  if (
    status === 408 ||
    status === 429 ||
    (status !== undefined && status >= 500 && status <= 599)
  ) {
    return true;
  }
  if (
    status === 403 &&
    typeof candidate.message === 'string' &&
    /rate limit|secondary rate limit|abuse detection/i.test(candidate.message)
  ) {
    return true;
  }
  return (
    typeof candidate?.code === 'string' &&
    TRANSIENT_GITHUB_NETWORK_ERROR_CODES.some((code) => code === candidate.code)
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
