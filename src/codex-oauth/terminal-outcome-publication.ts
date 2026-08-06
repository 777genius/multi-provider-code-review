import * as core from '../actions/core';
import { GitHubClient } from '../github/client';

export interface CodexOAuthTerminalOutcomeReporterPort {
  post(input: CodexOAuthTerminalOutcomeReport): Promise<void>;
  clear?(input: CodexOAuthTerminalOutcomeClearRequest): Promise<void>;
  status?(input: CodexOAuthTerminalOutcomeCommitStatus): Promise<void>;
}

export type CodexOAuthTerminalOutcomeClearRequest = {
  readonly reason: 'review_completed';
};

export type CodexOAuthTerminalOutcomeCommitStatus = {
  readonly state: 'error' | 'failure' | 'pending' | 'success';
  readonly description: string;
  readonly context: 'ReviewRouter';
  readonly targetUrl?: string;
};

export type CodexOAuthTerminalOutcomeDedupeKey = 'max_changed_lines_exceeded';

export enum CodexOAuthTerminalOutcomeKind {
  Skipped = 'skipped',
  Stale = 'stale',
  PublicationStale = 'publication-stale',
  PublicationNotApplied = 'publication-not-applied',
  LaneBusy = 'lane-busy',
  ProviderCapacity = 'provider-capacity',
  RevisionUnavailable = 'revision-unavailable',
  RevisionFailed = 'revision-failed',
  Partial = 'partial',
  Failed = 'failed',
}

export type CodexOAuthTerminalOutcomeReport = {
  readonly marker: string;
  readonly dedupeKey?: CodexOAuthTerminalOutcomeDedupeKey;
  readonly body: string;
  readonly stepSummary: string;
  readonly logLabel: string;
  readonly commitStatus: CodexOAuthTerminalOutcomeCommitStatus;
};

export type CodexOAuthTerminalOutcomePublicationContext = {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
};

export type TerminalOutcomePullRequestComment = {
  readonly id: number;
  readonly body?: string | null;
};

export interface TerminalOutcomePublicationGitHubPort {
  listPullRequestComments(input: {
    readonly repository: string;
    readonly pullRequestNumber: number;
  }): Promise<readonly TerminalOutcomePullRequestComment[]>;
  createPullRequestComment(input: {
    readonly repository: string;
    readonly pullRequestNumber: number;
    readonly body: string;
  }): Promise<void>;
  updatePullRequestComment(input: {
    readonly repository: string;
    readonly commentId: number;
    readonly body: string;
  }): Promise<void>;
  deletePullRequestComment(input: {
    readonly repository: string;
    readonly commentId: number;
  }): Promise<void>;
  createCommitStatus(input: {
    readonly repository: string;
    readonly headSha: string;
    readonly status: CodexOAuthTerminalOutcomeCommitStatus;
  }): Promise<void>;
}

export interface TerminalOutcomePublicationLoggerPort {
  info(message: string): void;
  warning(message: string): void;
}

export interface TerminalOutcomePublicationControlPlanePort {
  actionSession(input: {
    readonly oidcToken: string;
    readonly audience: string;
  }): Promise<{ readonly sessionToken: string }>;
  actionCommentToken(input: {
    readonly sessionToken: string;
  }): Promise<{ readonly token: string }>;
}

export class TerminalOutcomePublicationUseCase implements CodexOAuthTerminalOutcomeReporterPort {
  constructor(
    private readonly input: {
      readonly context: CodexOAuthTerminalOutcomePublicationContext;
      readonly github: TerminalOutcomePublicationGitHubPort;
      readonly logger?: TerminalOutcomePublicationLoggerPort;
    }
  ) {}

  async post(report: CodexOAuthTerminalOutcomeReport): Promise<void> {
    await this.upsertPullRequestComment(report);
    await this.createCommitStatusSafely(report.commitStatus);
  }

  async clear(_request: CodexOAuthTerminalOutcomeClearRequest): Promise<void> {
    const comments = await this.input.github.listPullRequestComments({
      repository: this.input.context.repository,
      pullRequestNumber: this.input.context.pullRequestNumber,
    });
    const currentRevisionMarker = `<!-- reviewrouter:codex-oauth:terminal:${this.input.context.headSha}:`;
    const terminalComments = comments.filter((comment) =>
      (comment.body ?? '').includes(currentRevisionMarker)
    );
    for (const comment of terminalComments) {
      await this.input.github.deletePullRequestComment({
        repository: this.input.context.repository,
        commentId: comment.id,
      });
    }
  }

  async status(status: CodexOAuthTerminalOutcomeCommitStatus): Promise<void> {
    await this.createCommitStatusSafely(status);
  }

  private async upsertPullRequestComment(
    report: CodexOAuthTerminalOutcomeReport
  ): Promise<void> {
    const comments = await this.input.github.listPullRequestComments({
      repository: this.input.context.repository,
      pullRequestNumber: this.input.context.pullRequestNumber,
    });
    const matchingComments = comments.filter((comment) =>
      isTerminalOutcomeCommentMatch(comment.body ?? '', report)
    );
    const [existing, ...duplicates] = matchingComments;
    if (existing) {
      for (const duplicate of duplicates) {
        try {
          await this.input.github.deletePullRequestComment({
            repository: this.input.context.repository,
            commentId: duplicate.id,
          });
        } catch (error) {
          this.warning(
            `ReviewRouter could not delete duplicate terminal outcome comment: ${safeTerminalOutcomeError(error)}`
          );
        }
      }
      if (report.dedupeKey) {
        this.info(
          `ReviewRouter terminal outcome comment already exists for ${report.dedupeKey}; keeping the first comment unchanged.`
        );
        return;
      }
      await this.input.github.updatePullRequestComment({
        repository: this.input.context.repository,
        commentId: existing.id,
        body: report.body,
      });
      return;
    }
    await this.input.github.createPullRequestComment({
      repository: this.input.context.repository,
      pullRequestNumber: this.input.context.pullRequestNumber,
      body: report.body,
    });
  }

  private async createCommitStatusSafely(
    status: CodexOAuthTerminalOutcomeCommitStatus
  ): Promise<void> {
    try {
      await this.input.github.createCommitStatus({
        repository: this.input.context.repository,
        headSha: this.input.context.headSha,
        status,
      });
      this.info(`ReviewRouter published ${status.context} commit status.`);
    } catch (error) {
      this.warning(
        `ReviewRouter could not publish terminal commit status: ${safeTerminalOutcomeError(error)}`
      );
    }
  }

  private info(message: string): void {
    (this.input.logger ?? core).info(message);
  }

  private warning(message: string): void {
    (this.input.logger ?? core).warning(message);
  }
}

export class GitHubTerminalOutcomePublicationAdapter implements TerminalOutcomePublicationGitHubPort {
  private readonly client: GitHubClient;

  constructor(token: string) {
    this.client = new GitHubClient(token);
  }

  async listPullRequestComments(input: {
    readonly repository: string;
    readonly pullRequestNumber: number;
  }): Promise<readonly TerminalOutcomePullRequestComment[]> {
    const repository = this.resolveRepository(input.repository);
    return await this.client.octokit.paginate(
      this.client.octokit.rest.issues.listComments,
      {
        ...repository,
        issue_number: input.pullRequestNumber,
        per_page: 100,
      }
    );
  }

  async createPullRequestComment(input: {
    readonly repository: string;
    readonly pullRequestNumber: number;
    readonly body: string;
  }): Promise<void> {
    const repository = this.resolveRepository(input.repository);
    await this.client.octokit.rest.issues.createComment({
      ...repository,
      issue_number: input.pullRequestNumber,
      body: input.body,
    });
  }

  async updatePullRequestComment(input: {
    readonly repository: string;
    readonly commentId: number;
    readonly body: string;
  }): Promise<void> {
    const repository = this.resolveRepository(input.repository);
    await this.client.octokit.rest.issues.updateComment({
      ...repository,
      comment_id: input.commentId,
      body: input.body,
    });
  }

  async deletePullRequestComment(input: {
    readonly repository: string;
    readonly commentId: number;
  }): Promise<void> {
    const repository = this.resolveRepository(input.repository);
    await this.client.octokit.rest.issues.deleteComment({
      ...repository,
      comment_id: input.commentId,
    });
  }

  async createCommitStatus(input: {
    readonly repository: string;
    readonly headSha: string;
    readonly status: CodexOAuthTerminalOutcomeCommitStatus;
  }): Promise<void> {
    const repository = this.resolveRepository(input.repository);
    await this.client.octokit.rest.repos.createCommitStatus({
      ...repository,
      sha: input.headSha,
      state: input.status.state,
      context: input.status.context,
      description: input.status.description,
      ...(input.status.targetUrl ? { target_url: input.status.targetUrl } : {}),
    });
  }

  private resolveRepository(repository: string): {
    readonly owner: string;
    readonly repo: string;
  } {
    const [repositoryOwner, repositoryName] = repository.split('/');
    return {
      owner: repositoryOwner || this.client.owner,
      repo: repositoryName || this.client.repo,
    };
  }
}

export function createDefaultCodexOAuthTerminalOutcomeReporter(input: {
  readonly context: CodexOAuthTerminalOutcomePublicationContext;
  readonly audience: string;
  readonly controlPlane: TerminalOutcomePublicationControlPlanePort;
  readonly oidc: { requestToken(audience: string): Promise<string> };
}): CodexOAuthTerminalOutcomeReporterPort {
  const requestActionCommentToken = async (): Promise<string> => {
    const oidcToken = await input.oidc.requestToken(input.audience);
    const session = await input.controlPlane.actionSession({
      oidcToken,
      audience: input.audience,
    });
    const commentToken = await input.controlPlane.actionCommentToken({
      sessionToken: session.sessionToken,
    });
    return commentToken.token;
  };

  const createUseCase = async (): Promise<TerminalOutcomePublicationUseCase> =>
    new TerminalOutcomePublicationUseCase({
      context: input.context,
      github: new GitHubTerminalOutcomePublicationAdapter(
        await requestActionCommentToken()
      ),
    });

  return {
    async post(report) {
      await (await createUseCase()).post(report);
    },
    async clear(request) {
      await (await createUseCase()).clear(request);
    },
    async status(status) {
      await (await createUseCase()).status(status);
    },
  };
}

export function isTerminalOutcomeCommentMatch(
  body: string,
  input: {
    readonly marker: string;
    readonly dedupeKey?: CodexOAuthTerminalOutcomeDedupeKey;
  }
): boolean {
  if (body.includes(input.marker)) return true;
  const revisionMarker = input.marker.match(
    /<!--\s*reviewrouter:codex-oauth:terminal:([a-f0-9]{40}):[^\s>]+\s*-->/i
  );
  if (
    revisionMarker &&
    new RegExp(
      `<!--\\s*reviewrouter:codex-oauth:terminal:${revisionMarker[1]}:[^\\s>]+\\s*-->`,
      'i'
    ).test(body)
  ) {
    return true;
  }
  if (input.dedupeKey === 'max_changed_lines_exceeded') {
    return isLegacyMaxChangedLinesSkippedComment(body);
  }
  return false;
}

export function isLegacyMaxChangedLinesSkippedComment(body: string): boolean {
  return (
    /<!--\s*reviewrouter:codex-oauth:terminal:[a-f0-9]{40}:skipped\s*-->/i.test(
      body
    ) &&
    body.includes('## Review skipped') &&
    body.includes(
      'ReviewRouter did not start a model review for this revision because the PR is larger than the configured safety limit.'
    ) &&
    body.includes('| Configured limit |')
  );
}

export function safeTerminalOutcomeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown_error';
  return message
    .replace(/ghs_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .slice(0, 160);
}
