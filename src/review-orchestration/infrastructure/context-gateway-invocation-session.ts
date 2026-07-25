import { execFile } from 'child_process';
import { createHash, createHmac } from 'crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import {
  canonicalizeReviewContextConfinementEvidence,
  canonicalizeReviewContextGatewayEvent,
  canonicalizeReviewContextReplayHandle,
  canonicalizeReviewContextSearchQuery,
} from '../../control-plane/generated/review-action-v2/review-action-v2';
import {
  ChangedPathsWitnessStatus,
  CONTEXT_GATEWAY_POLICY_VERSION,
  canonicalJson,
  changedPathsWitnessStatus,
  type ContextGatewayReplayMaterial,
  type ContextGatewayTranscript,
} from '../../context-gateway/context-gateway-contract';
import type { CodexContextGatewayInvocationConfig } from '../../providers/codex';
import type { ProviderCredentialLease } from '../../providers/prepared-invocation';
import type {
  ContextDependencyAttestationReference,
  ReviewContextAttestationPort,
  ReviewInvocationLease,
} from '../application';
import {
  ReviewContextInspectionFailure,
  ReviewContextInspectionFailureReason,
} from '../application';

const execFileAsync = promisify(execFile);
const MAX_TRANSCRIPT_BYTES = 512 * 1024;
const MAX_REPLAY_MATERIAL_BYTES = 512 * 1024;
const ENABLED_TOOLS = Object.freeze([
  'review_read_file',
  'review_list_directory',
  'review_search_text',
  'review_git_fact',
]);

export type ContextGatewayRevision = Readonly<{
  baseSha: string;
  headSha: string;
}>;

export type OpenContextGatewayInvocationInput = Readonly<{
  invocationLease: ReviewInvocationLease;
  sourceExecutionId: string;
  sourceWorkSlotId: string;
  sourceReviewRevisionHash: string;
  providerKind: string;
  requestedModel: string;
  executionProfile: string;
  providerInvocationKey: string;
  toolPolicyHash: string;
  revision: ContextGatewayRevision;
}>;

export interface ContextGatewayInvocationSessionPort {
  readonly providerConfig: CodexContextGatewayInvocationConfig;
  readonly credentialLease: ProviderCredentialLease;
  seal(input: {
    readonly actualModel: string;
    readonly terminalOutcomeHash: string;
  }): Promise<ContextDependencyAttestationReference | null>;
  dispose(): Promise<void>;
}

export interface ContextGatewayInvocationSessionFactoryPort {
  planningConfig(
    revision: ContextGatewayRevision
  ): Promise<CodexContextGatewayInvocationConfig>;
  open(
    input: OpenContextGatewayInvocationInput
  ): Promise<ContextGatewayInvocationSessionPort>;
}

export interface RequiredContextWitnessRunnerPort {
  capture(input: {
    readonly gatewayBundlePath: string;
    readonly checkoutRoot: string;
    readonly runtimeEnvironment: Readonly<Record<string, string | undefined>>;
    readonly gatewaySessionSecret: string;
  }): Promise<void>;
}

export class SubprocessRequiredContextWitnessRunner implements RequiredContextWitnessRunnerPort {
  async capture(input: {
    readonly gatewayBundlePath: string;
    readonly checkoutRoot: string;
    readonly runtimeEnvironment: Readonly<Record<string, string | undefined>>;
    readonly gatewaySessionSecret: string;
  }): Promise<void> {
    await execFileAsync(
      process.execPath,
      [input.gatewayBundlePath, '--preflight'],
      {
        cwd: input.checkoutRoot,
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          ...input.runtimeEnvironment,
          REVIEWROUTER_CONTEXT_GATEWAY_SECRET: input.gatewaySessionSecret,
        },
        timeout: 45_000,
        maxBuffer: 64 * 1024,
      }
    );
  }
}

export class ContextGatewayInvocationSessionFactory implements ContextGatewayInvocationSessionFactoryPort {
  private gatewayBundleSnapshotPromise: Promise<Buffer> | undefined;
  private checkoutTreeOidPromise: Promise<string> | undefined;

  constructor(
    private readonly attestations: ReviewContextAttestationPort,
    private readonly options: Readonly<{
      checkoutRoot: string;
      gatewayBundlePath: string;
    }>,
    private readonly requiredWitnessRunner: RequiredContextWitnessRunnerPort
  ) {
    if (
      !path.isAbsolute(options.checkoutRoot) ||
      !path.isAbsolute(options.gatewayBundlePath)
    ) {
      throw new Error('context_gateway_factory_path_invalid');
    }
  }

  async planningConfig(
    revision: ContextGatewayRevision
  ): Promise<CodexContextGatewayInvocationConfig> {
    const [gatewayBundleSnapshot, checkoutTreeOid] = await Promise.all([
      this.gatewayBundleSnapshot(),
      this.checkoutTreeOid(),
    ]);
    const gatewayBinaryHash = sha256(gatewayBundleSnapshot);
    return this.providerConfig({
      revision,
      sessionId: 'planning-session',
      eventChainSeedHash: '0'.repeat(64),
      gatewayBinaryHash,
      checkoutTreeOid,
      transcriptPath: path.join(os.tmpdir(), 'planning-transcript.json'),
      replayMaterialPath: path.join(os.tmpdir(), 'planning-replay.json'),
      gatewayBundlePath: this.options.gatewayBundlePath,
    });
  }

  async open(
    input: OpenContextGatewayInvocationInput
  ): Promise<ContextGatewayInvocationSessionPort> {
    const [gatewayBundleSnapshot, checkoutTreeOid] = await Promise.all([
      this.gatewayBundleSnapshot(),
      this.checkoutTreeOid(),
    ]);
    const gatewayBinaryHash = sha256(gatewayBundleSnapshot);
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'reviewrouter-context-gateway-')
    );
    const gatewayBundlePath = path.join(directory, 'context-gateway.cjs');
    const transcriptPath = path.join(directory, 'transcript.json');
    const replayMaterialPath = path.join(directory, 'replay-material.json');
    try {
      await writeFile(gatewayBundlePath, gatewayBundleSnapshot, {
        flag: 'wx',
        mode: 0o700,
      });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    const confinementEvidenceHash = sha256(
      canonicalizeReviewContextConfinementEvidence({
        attemptId: input.invocationLease.attemptId,
        sourceLeaseId: input.invocationLease.leaseId,
        sourceFencingToken: input.invocationLease.fencingToken,
        sourceExecutionId: input.sourceExecutionId,
        sourceWorkSlotId: input.sourceWorkSlotId,
        sourceReviewRevisionHash: input.sourceReviewRevisionHash,
        checkoutTreeOid,
        providerKind: input.providerKind,
        requestedModel: input.requestedModel,
        executionProfile: input.executionProfile,
        providerInvocationKey: input.providerInvocationKey,
        toolPolicyHash: input.toolPolicyHash,
        gatewayPolicyVersion: CONTEXT_GATEWAY_POLICY_VERSION,
        gatewayBinaryHash,
      })
    );
    let serverSession;
    try {
      serverSession = await this.attestations.openGatewaySession({
        invocationLease: input.invocationLease,
        sourceExecutionId: input.sourceExecutionId,
        sourceWorkSlotId: input.sourceWorkSlotId,
        sourceReviewRevisionHash: input.sourceReviewRevisionHash,
        checkoutTreeOid,
        gatewayPolicyVersion: CONTEXT_GATEWAY_POLICY_VERSION,
        gatewayBinaryHash,
        confinementEvidenceHash,
      });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    const secret = Buffer.from(serverSession.gatewaySessionSecret, 'base64url');
    if (secret.byteLength < 32) {
      await rm(directory, { recursive: true, force: true });
      throw new Error('context_gateway_session_secret_invalid');
    }
    const providerConfig = this.providerConfig({
      revision: input.revision,
      sessionId: serverSession.sessionId,
      eventChainSeedHash: serverSession.eventChainSeedHash,
      gatewayBinaryHash,
      checkoutTreeOid,
      transcriptPath,
      replayMaterialPath,
      gatewayBundlePath,
    });
    try {
      await this.requiredWitnessRunner.capture({
        gatewayBundlePath,
        checkoutRoot: this.options.checkoutRoot,
        runtimeEnvironment: providerConfig.runtimeEnvironment,
        gatewaySessionSecret: serverSession.gatewaySessionSecret,
      });
    } catch (error) {
      secret.fill(0);
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return new ContextGatewayInvocationSession(
      this.attestations,
      input.invocationLease,
      serverSession,
      providerConfig,
      secret,
      transcriptPath,
      replayMaterialPath,
      directory
    );
  }

  private providerConfig(input: {
    readonly revision: ContextGatewayRevision;
    readonly sessionId: string;
    readonly eventChainSeedHash: string;
    readonly gatewayBinaryHash: string;
    readonly checkoutTreeOid: string;
    readonly transcriptPath: string;
    readonly replayMaterialPath: string;
    readonly gatewayBundlePath: string;
  }): CodexContextGatewayInvocationConfig {
    return Object.freeze({
      command: process.execPath,
      args: Object.freeze([input.gatewayBundlePath]),
      cwd: this.options.checkoutRoot,
      gatewayBinaryHash: input.gatewayBinaryHash,
      gatewayPolicyVersion: CONTEXT_GATEWAY_POLICY_VERSION,
      enabledTools: ENABLED_TOOLS,
      runtimeEnvironment: Object.freeze({
        REVIEWROUTER_CONTEXT_SESSION_ID: input.sessionId,
        REVIEWROUTER_CONTEXT_ROOT: this.options.checkoutRoot,
        REVIEWROUTER_CONTEXT_TRANSCRIPT_PATH: input.transcriptPath,
        REVIEWROUTER_CONTEXT_REPLAY_MATERIAL_PATH: input.replayMaterialPath,
        REVIEWROUTER_CONTEXT_GATEWAY_BINARY_HASH: input.gatewayBinaryHash,
        REVIEWROUTER_CONTEXT_CHECKOUT_TREE_OID: input.checkoutTreeOid,
        REVIEWROUTER_CONTEXT_EVENT_CHAIN_SEED_HASH: input.eventChainSeedHash,
        REVIEWROUTER_CONTEXT_BASE_SHA: input.revision.baseSha,
        REVIEWROUTER_CONTEXT_HEAD_SHA: input.revision.headSha,
      }),
    });
  }

  private async gatewayBundleSnapshot(): Promise<Buffer> {
    this.gatewayBundleSnapshotPromise ??= readFile(
      this.options.gatewayBundlePath
    );
    return Buffer.from(await this.gatewayBundleSnapshotPromise);
  }

  private checkoutTreeOid(): Promise<string> {
    this.checkoutTreeOidPromise ??= execFileAsync(
      'git',
      ['rev-parse', 'HEAD^{tree}'],
      {
        cwd: this.options.checkoutRoot,
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      }
    ).then(({ stdout }) => {
      const oid = stdout.trim().toLowerCase();
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(oid)) {
        throw new Error('context_gateway_checkout_tree_oid_invalid');
      }
      return oid;
    });
    return this.checkoutTreeOidPromise;
  }
}

class ContextGatewayInvocationSession implements ContextGatewayInvocationSessionPort {
  readonly credentialLease: ProviderCredentialLease;

  constructor(
    private readonly attestations: ReviewContextAttestationPort,
    private readonly invocationLease: ReviewInvocationLease,
    private readonly serverSession: Awaited<
      ReturnType<ReviewContextAttestationPort['openGatewaySession']>
    >,
    readonly providerConfig: CodexContextGatewayInvocationConfig,
    private readonly secret: Buffer,
    private readonly transcriptPath: string,
    private readonly replayMaterialPath: string,
    private readonly directory: string
  ) {
    this.credentialLease = Object.freeze({
      environment: Object.freeze({
        REVIEWROUTER_CONTEXT_GATEWAY_SECRET: serverSession.gatewaySessionSecret,
      }),
    });
  }

  async seal(input: {
    readonly actualModel: string;
    readonly terminalOutcomeHash: string;
  }): Promise<ContextDependencyAttestationReference | null> {
    let rawTranscriptCanonicalJson: string;
    let rawReplayMaterialCanonicalJson: string;
    try {
      [rawTranscriptCanonicalJson, rawReplayMaterialCanonicalJson] =
        await Promise.all([
          readBoundedCanonicalJson(this.transcriptPath, MAX_TRANSCRIPT_BYTES),
          readBoundedCanonicalJson(
            this.replayMaterialPath,
            MAX_REPLAY_MATERIAL_BYTES
          ),
        ]);
    } catch {
      throw new ReviewContextInspectionFailure(
        ReviewContextInspectionFailureReason.GatewayOutputUnavailable
      );
    }
    const transcript = JSON.parse(
      rawTranscriptCanonicalJson
    ) as ContextGatewayTranscript;
    const replayMaterial = JSON.parse(
      rawReplayMaterialCanonicalJson
    ) as ContextGatewayReplayMaterial;
    verifyTranscript({
      transcript,
      replayMaterial,
      secret: this.secret,
      sessionId: this.serverSession.sessionId,
      gatewayBinaryHash: this.providerConfig.gatewayBinaryHash,
      checkoutTreeOid:
        this.providerConfig.runtimeEnvironment
          .REVIEWROUTER_CONTEXT_CHECKOUT_TREE_OID!,
      eventChainSeedHash: this.serverSession.eventChainSeedHash,
    });
    if (transcript.hadFailure) {
      throw new ReviewContextInspectionFailure(
        ReviewContextInspectionFailureReason.IncompleteTranscript
      );
    }
    const expectedChangedPathsOperandsHash = sha256(
      canonicalJson({
        baseSha:
          this.providerConfig.runtimeEnvironment.REVIEWROUTER_CONTEXT_BASE_SHA!,
        headSha:
          this.providerConfig.runtimeEnvironment.REVIEWROUTER_CONTEXT_HEAD_SHA!,
      })
    );
    switch (
      changedPathsWitnessStatus(transcript, expectedChangedPathsOperandsHash)
    ) {
      case ChangedPathsWitnessStatus.Missing:
        throw new ReviewContextInspectionFailure(
          ReviewContextInspectionFailureReason.MissingChangedPathsWitness
        );
      case ChangedPathsWitnessStatus.Invalid:
        throw new ReviewContextInspectionFailure(
          ReviewContextInspectionFailureReason.InvalidChangedPathsWitness
        );
      case ChangedPathsWitnessStatus.Present:
        break;
    }
    const { transcriptCanonicalJson, replayMaterialCanonicalJson } =
      createWireSealPayload(transcript, replayMaterial);
    return this.attestations.sealGatewaySession({
      invocationLease: this.invocationLease,
      session: this.serverSession,
      providerSucceeded: true,
      schemaValidated: true,
      fullyConsumed: true,
      actualModel: input.actualModel,
      terminalOutcomeHash: input.terminalOutcomeHash,
      transcriptCanonicalJson,
      transcriptHash: sha256(transcriptCanonicalJson),
      replayMaterialCanonicalJson,
      replayMaterialHash: sha256(replayMaterialCanonicalJson),
    });
  }

  async dispose(): Promise<void> {
    this.secret.fill(0);
    await rm(this.directory, { recursive: true, force: true });
  }
}

async function readBoundedCanonicalJson(
  file: string,
  maximumBytes: number
): Promise<string> {
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size < 2 || metadata.size > maximumBytes) {
    throw new Error('context_gateway_output_size_invalid');
  }
  const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
  return canonicalJson(parsed);
}

function verifyTranscript(input: {
  readonly transcript: ContextGatewayTranscript;
  readonly replayMaterial: ContextGatewayReplayMaterial;
  readonly secret: Buffer;
  readonly sessionId: string;
  readonly gatewayBinaryHash: string;
  readonly checkoutTreeOid: string;
  readonly eventChainSeedHash: string;
}): void {
  const transcript = input.transcript;
  if (
    transcript.transcriptVersion !== 1 ||
    transcript.sessionId !== input.sessionId ||
    transcript.gatewayPolicyVersion !== CONTEXT_GATEWAY_POLICY_VERSION ||
    transcript.gatewayBinaryHash !== input.gatewayBinaryHash ||
    transcript.checkoutTreeOid !== input.checkoutTreeOid ||
    transcript.eventChainSeedHash !== input.eventChainSeedHash ||
    input.replayMaterial.replayMaterialVersion !== 1 ||
    input.replayMaterial.sessionId !== input.sessionId
  ) {
    throw new Error('context_gateway_transcript_identity_invalid');
  }
  let previousEventHash = input.eventChainSeedHash;
  for (let index = 0; index < transcript.dependencies.length; index += 1) {
    const entry = transcript.dependencies[index];
    if (
      entry.sequence !== index + 1 ||
      entry.previousEventHash !== previousEventHash ||
      entry.operationKey !== sha256(canonicalJson(entry.operation))
    ) {
      throw new Error('context_gateway_transcript_chain_invalid');
    }
    const eventHash = keyedSha256(
      input.secret,
      canonicalizeReviewContextGatewayEvent({
        sessionId: input.sessionId,
        sequence: entry.sequence,
        previousEventHash: entry.previousEventHash,
        operationKey: entry.operationKey,
        operation: entry.operation,
        result: entry.result,
      })
    );
    if (entry.eventHash !== eventHash) {
      throw new Error('context_gateway_transcript_authentication_invalid');
    }
    previousEventHash = eventHash;
  }
  if (transcript.authenticatedChainHash !== previousEventHash) {
    throw new Error('context_gateway_transcript_terminal_hash_invalid');
  }
  const replayableSearches = new Map(
    transcript.dependencies
      .filter((entry) => entry.operation.kind === 'text_search')
      .map((entry) => {
        const operation = entry.operation as Readonly<Record<string, unknown>>;
        return [
          operation.replayHandleHash,
          {
            operationKey: entry.operationKey,
            queryDigest: operation.queryDigest,
            replayHandleHash: operation.replayHandleHash,
          },
        ] as const;
      })
  );
  if (replayableSearches.size !== input.replayMaterial.entries.length) {
    throw new Error('context_gateway_replay_material_count_invalid');
  }
  for (const entry of input.replayMaterial.entries) {
    const replayHandleHash = sha256(entry.replayHandle);
    const expected = replayableSearches.get(replayHandleHash);
    if (
      !expected ||
      expected.operationKey !== entry.operationKey ||
      replayHandleHash !== expected.replayHandleHash ||
      expected.queryDigest !==
        keyedSha256(
          input.secret,
          canonicalizeReviewContextSearchQuery(entry.query)
        ) ||
      entry.replayHandle !==
        keyedSha256(
          input.secret,
          canonicalizeReviewContextReplayHandle({
            sessionId: input.sessionId,
            sequence: transcript.dependencies.find(
              (dependency) => dependency.operationKey === entry.operationKey
            )!.sequence,
            query: entry.query,
          })
        )
    ) {
      throw new Error('context_gateway_replay_material_invalid');
    }
  }
}

function createWireSealPayload(
  transcript: ContextGatewayTranscript,
  replayMaterial: ContextGatewayReplayMaterial
): Readonly<{
  transcriptCanonicalJson: string;
  replayMaterialCanonicalJson: string;
}> {
  const replayQueriesByOperationKey = new Map(
    replayMaterial.entries.map((entry) => [entry.operationKey, entry.query])
  );
  const transcriptCanonicalJson = canonicalJson({
    manifestVersion: 2,
    gatewayPolicyVersion: transcript.gatewayPolicyVersion,
    gatewayBinaryHash: transcript.gatewayBinaryHash,
    checkoutTreeOid: transcript.checkoutTreeOid,
    authenticatedChainHash: transcript.authenticatedChainHash,
    complete: !transcript.hadFailure,
    dependencies: transcript.dependencies,
  });
  const replayMaterialCanonicalJson = canonicalJson({
    materialVersion: 1,
    sourceDependencies: transcript.dependencies.map((dependency) => ({
      sequence: dependency.sequence,
      operationKey: dependency.operationKey,
      replayQuery:
        dependency.operation.kind === 'text_search'
          ? (replayQueriesByOperationKey.get(dependency.operationKey) ?? null)
          : null,
    })),
  });
  return Object.freeze({
    transcriptCanonicalJson,
    replayMaterialCanonicalJson,
  });
}

function keyedSha256(secret: Buffer, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
