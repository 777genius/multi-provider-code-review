import {
  clearCodexRotatingOidcRequestEnv,
  clearCodexRotatingProcessAuthEnv,
  readCodexRotatingAuthInput,
} from './auth-input';
import {
  CodexRotatingCheckoutTokenResponse,
  CodexRotatingCommentTokenResponse,
  CodexRotatingFinalizeResponse,
  CodexRotatingPreleaseResponse,
  CodexRotatingWritebackPreflightResponse,
  CodexRotatingWritebackResponse,
} from './control-plane';
import {
  buildCodexRotatingWritebackRequest,
  compactCodexAuthJsonBytes,
  computeCodexAuthGenerationHash,
  encryptCodexAuthForGitHubSecret,
} from './crypto';
import * as path from 'path';
import type { Review } from '../types';

export type CodexOAuthRuntimeInputs = {
  apiUrl: string;
  audience: string;
  providerInstanceId: string;
  workflowSchemaVersion: number;
  repository: string;
  pullRequestNumber: number;
  headSha: string;
  workspacePath: string;
  reviewMode?: CodexOAuthReviewRuntimeMode;
};

export enum CodexOAuthReviewRuntimeMode {
  LegacyComments = 'legacy_comments',
  ServerPublishedV2 = 'server_published_v2',
}

export enum CodexOAuthV2ReviewOutcome {
  Completed = 'completed',
  PartialCompleted = 'partial_completed',
  Superseded = 'superseded',
}

export type CodexOAuthV2ReviewResult = {
  readonly outcome: CodexOAuthV2ReviewOutcome;
  readonly blockingFailure?: string;
};

export interface CodexOAuthV2ReviewRunnerPort {
  run(input: {
    readonly apiUrl: string;
    readonly audience: string;
    readonly providerInstanceId: string;
    readonly workflowSchemaVersion: number;
    readonly repository: string;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly workspacePath: string;
    readonly codexHome: string;
    readonly codexBinaryPath?: string;
    /**
     * Short-lived GitHub capability restricted by the control plane to
     * contents:read and pull_requests:read. The v2 runner may use it only to
     * reload revision and lifecycle facts; it is never a publication token.
     */
    readonly scmReadToken: string;
    readonly scmReadTokenExpiresAt: string;
  }): Promise<CodexOAuthV2ReviewResult>;
}

type CodexOAuthSharedControlPlanePort = {
  prelease(input: {
    oidcToken: string;
    audience: string;
    providerInstanceId: string;
    workflowSchemaVersion: number;
  }): Promise<CodexRotatingPreleaseResponse>;
  finalize(input: {
    leaseId: string;
    providerInstanceId: string;
    restoredGenerationHash: string;
  }): Promise<CodexRotatingFinalizeResponse>;
  writebackPreflight(input: {
    leaseId: string;
    providerInstanceId: string;
    githubKeyId: string;
  }): Promise<CodexRotatingWritebackPreflightResponse>;
  writeback(
    body: Record<string, unknown>
  ): Promise<CodexRotatingWritebackResponse>;
  checkoutToken(input: {
    leaseId: string;
    providerInstanceId: string;
  }): Promise<CodexRotatingCheckoutTokenResponse>;
};

type CodexOAuthSharedRuntimePorts = {
  oidc: {
    requestToken(audience: string): Promise<string>;
  };
  controlPlane: CodexOAuthSharedControlPlanePort;
  githubSecrets: {
    fetchPublicKey(input: {
      owner: string;
      repo: string;
      token: string;
    }): Promise<{ keyId: string; key: string }>;
  };
  codex: {
    prepareCli?(): Promise<{
      binaryPath: string;
      clear?(): Promise<void>;
    }>;
    refreshAuth(input: {
      authJsonBytes: string;
      codexBinaryPath?: string;
    }): Promise<{
      authJsonBytes: string;
      codexHome: string;
      clearAuthMaterial(): Promise<void>;
    }>;
  };
  checkout: {
    checkoutExactHead(input: {
      repository: string;
      headSha: string;
      workspacePath: string;
      token: string;
    }): Promise<void>;
  };
  lifecycle?: {
    clearOidcEnv?(): void;
    clearProcessAuthEnv?(): void;
  };
};

export type CodexOAuthLegacyRuntimePorts = CodexOAuthSharedRuntimePorts & {
  controlPlane: CodexOAuthSharedControlPlanePort & {
    commentToken(input: {
      leaseId: string;
      providerInstanceId: string;
      authCleared: true;
    }): Promise<CodexRotatingCommentTokenResponse>;
  };
  review: {
    run(input: {
      checkoutToken: string;
      codexHome: string;
      codexBinaryPath?: string;
    }): Promise<CodexOAuthReviewComputationResult>;
  };
  comments: {
    post(input: {
      commentToken: string;
      review: CodexOAuthReviewResult;
    }): Promise<void>;
  };
};

export type CodexOAuthV2RuntimePorts = CodexOAuthSharedRuntimePorts & {
  v2Review?: CodexOAuthV2ReviewRunnerPort;
};

export type CodexOAuthRuntimePorts =
  | CodexOAuthLegacyRuntimePorts
  | CodexOAuthV2RuntimePorts;

export type CodexOAuthReviewComputationResult = {
  skipped: boolean;
  blockingFailure?: string;
  userDryRun?: boolean;
  markdown?: string;
  review?: Review;
};

export type CodexOAuthReviewResult = CodexOAuthReviewComputationResult & {
  reviewedHeadSha: string;
};

export type CodexOAuthRuntimeResult =
  | {
      status: 'completed';
      review: CodexOAuthReviewResult;
    }
  | {
      status: 'completed';
      publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2;
      v2Review: CodexOAuthV2ReviewResult;
    }
  | {
      status: 'skipped';
      reason: 'max_changed_lines_exceeded';
      changedLines: number;
      maxChangedLines: number;
      decisionHash: string;
    }
  | {
      status: 'skipped';
      reason:
        | 'stale_queued_secret'
        | 'lease_not_active'
        | 'permission_required'
        | 'github_put_failed'
        | 'writeback_idempotency_conflict';
    };

export async function runCodexOAuthRotatingRuntime(
  input: CodexOAuthRuntimeInputs,
  ports: CodexOAuthRuntimePorts
): Promise<CodexOAuthRuntimeResult> {
  let refreshed:
    | {
        authJsonBytes: string;
        codexHome: string;
        clearAuthMaterial(): Promise<void>;
      }
    | undefined;
  let preparedCodexCli:
    | {
        binaryPath: string;
        clear?(): Promise<void>;
      }
    | undefined;
  let authMaterialCleared = false;
  let previousCodexBinary: string | undefined;
  let previousPath: string | undefined;
  let preparedCodexCliEnvApplied = false;
  let scmReadToken: string | undefined;

  const clearAuth = async () => {
    scmReadToken = undefined;
    ports.lifecycle?.clearOidcEnv?.();
    if (preparedCodexCliEnvApplied) {
      if (previousCodexBinary === undefined) {
        delete process.env.REVIEWROUTER_CODEX_BINARY;
      } else {
        process.env.REVIEWROUTER_CODEX_BINARY = previousCodexBinary;
      }
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      preparedCodexCliEnvApplied = false;
    }
    if (refreshed) {
      await refreshed.clearAuthMaterial();
      refreshed = undefined;
    }
    if (preparedCodexCli?.clear) {
      await preparedCodexCli.clear();
      preparedCodexCli = undefined;
    }
    ports.lifecycle?.clearProcessAuthEnv?.();
    authMaterialCleared = true;
  };

  try {
    const oidcToken = await ports.oidc.requestToken(input.audience);
    const prelease = await ports.controlPlane.prelease({
      oidcToken,
      audience: input.audience,
      providerInstanceId: input.providerInstanceId,
      workflowSchemaVersion: input.workflowSchemaVersion,
    });
    if ('status' in prelease) {
      await clearAuth();
      return {
        status: 'skipped',
        reason: prelease.reason,
        changedLines: prelease.changedLines,
        maxChangedLines: prelease.maxChangedLines,
        decisionHash: prelease.decisionHash,
      };
    }
    preparedCodexCli = await ports.codex.prepareCli?.();
    if (preparedCodexCli) {
      previousCodexBinary = process.env.REVIEWROUTER_CODEX_BINARY;
      previousPath = process.env.PATH;
      const codexBinDir = path.dirname(preparedCodexCli.binaryPath);
      process.env.REVIEWROUTER_CODEX_BINARY = preparedCodexCli.binaryPath;
      process.env.PATH = previousPath
        ? `${codexBinDir}${path.delimiter}${previousPath}`
        : codexBinDir;
      preparedCodexCliEnvApplied = true;
    }

    const restoredAuth = readCodexRotatingAuthInput().authJsonBytes;
    const restoredCompact = compactCodexAuthJsonBytes({
      authJsonBytes: restoredAuth,
    });
    const restoredGenerationHash = computeCodexAuthGenerationHash({
      authJsonBytes: restoredCompact.compactAuthJsonBytes,
      generationHashSalt: prelease.generationHashSalt,
    });

    const finalized = await ports.controlPlane.finalize({
      leaseId: prelease.leaseId,
      providerInstanceId: input.providerInstanceId,
      restoredGenerationHash,
    });
    if (finalized.status === 'stale_queued_secret') {
      await clearAuth();
      return { status: 'skipped', reason: 'stale_queued_secret' };
    }

    const publicKey = await ports.githubSecrets.fetchPublicKey({
      owner: finalized.repositoryOwner,
      repo: finalized.repositoryName,
      token: finalized.publicKeyReadToken,
    });
    const preflight = await ports.controlPlane.writebackPreflight({
      leaseId: prelease.leaseId,
      providerInstanceId: input.providerInstanceId,
      githubKeyId: publicKey.keyId,
    });
    if (preflight.status === 'skipped') {
      await clearAuth();
      return { status: 'skipped', reason: preflight.reason };
    }

    refreshed = await ports.codex.refreshAuth({
      authJsonBytes: restoredCompact.compactAuthJsonBytes,
      ...(preparedCodexCli
        ? { codexBinaryPath: preparedCodexCli.binaryPath }
        : {}),
    });
    const encrypted = await encryptCodexAuthForGitHubSecret({
      authJsonBytes: refreshed.authJsonBytes,
      githubPublicKeyBase64: publicKey.key,
      githubKeyId: publicKey.keyId,
      generationHashSalt: prelease.generationHashSalt,
    });
    const writeback = await ports.controlPlane.writeback(
      buildCodexRotatingWritebackRequest({
        leaseId: prelease.leaseId,
        providerInstanceId: input.providerInstanceId,
        generation: finalized.nextGeneration,
        latestGenerationHash: encrypted.latestGenerationHash,
        encryptedValue: encrypted.encryptedValue,
        keyId: encrypted.keyId,
      })
    );
    if (
      writeback.status !== 'accepted' &&
      writeback.status !== 'idempotent_replay'
    ) {
      await clearAuth();
      return { status: 'skipped', reason: writeback.status };
    }

    const checkoutToken = await ports.controlPlane.checkoutToken({
      leaseId: prelease.leaseId,
      providerInstanceId: input.providerInstanceId,
    });
    assertScmReadToken(checkoutToken, input.repository);
    scmReadToken = checkoutToken.token;
    await ports.checkout.checkoutExactHead({
      repository: input.repository,
      headSha: input.headSha,
      workspacePath: input.workspacePath,
      token: checkoutToken.token,
    });

    if (input.reviewMode === CodexOAuthReviewRuntimeMode.ServerPublishedV2) {
      const v2Ports = ports as CodexOAuthV2RuntimePorts;
      if (!v2Ports.v2Review) {
        throw new Error('review_action_v2_runner_missing');
      }
      const v2Review = await v2Ports.v2Review.run({
        apiUrl: input.apiUrl,
        audience: input.audience,
        providerInstanceId: input.providerInstanceId,
        workflowSchemaVersion: input.workflowSchemaVersion,
        repository: input.repository,
        pullRequestNumber: input.pullRequestNumber,
        headSha: input.headSha,
        workspacePath: input.workspacePath,
        codexHome: refreshed.codexHome,
        scmReadToken,
        scmReadTokenExpiresAt: checkoutToken.expiresAt,
        ...(preparedCodexCli
          ? { codexBinaryPath: preparedCodexCli.binaryPath }
          : {}),
      });
      await clearAuth();
      return {
        status: 'completed',
        publicationMode: CodexOAuthReviewRuntimeMode.ServerPublishedV2,
        v2Review,
      };
    }

    const legacyPorts = ports as CodexOAuthLegacyRuntimePorts;
    const computedReview = await legacyPorts.review.run({
      checkoutToken: checkoutToken.token,
      codexHome: refreshed.codexHome,
      ...(preparedCodexCli
        ? { codexBinaryPath: preparedCodexCli.binaryPath }
        : {}),
    });
    const review: CodexOAuthReviewResult = {
      ...computedReview,
      reviewedHeadSha: input.headSha,
    };

    await clearAuth();
    const commentToken = await legacyPorts.controlPlane.commentToken({
      leaseId: prelease.leaseId,
      providerInstanceId: input.providerInstanceId,
      authCleared: true,
    });
    await legacyPorts.comments.post({
      commentToken: commentToken.token,
      review,
    });
    return { status: 'completed', review };
  } finally {
    if (!authMaterialCleared) {
      await clearAuth().catch(() => undefined);
      clearCodexRotatingAuthInputSafe();
    }
  }
}

function clearCodexRotatingAuthInputSafe(): void {
  clearCodexRotatingOidcRequestEnv();
  clearCodexRotatingProcessAuthEnv();
}

function assertScmReadToken(
  token: CodexRotatingCheckoutTokenResponse,
  expectedRepository: string
): void {
  if (
    token.repository !== expectedRepository ||
    token.permissions.contents !== 'read' ||
    token.permissions.pullRequests !== 'read'
  ) {
    throw new Error('review_action_v2_scm_read_token_scope_invalid');
  }
}
