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
  canonicalizeReviewInvestigationContextConfinementEvidence,
} from '../../control-plane/generated/review-action-v2/review-action-v2';
import {
  buildCanonicalGitInventory,
  type CanonicalGitInventory,
} from '../../context-gateway/canonical-git-inventory';
import {
  ChangedPathsWitnessStatus,
  CONTEXT_GATEWAY_POLICY_VERSION,
  canonicalJson,
  changedPathsWitnessStatus,
  CONTEXT_GATEWAY_V3_ENABLED_TOOLS,
  contextGitFactOperandsHash,
  requireGitOid,
  type ContextGatewayReplayMaterial,
  type ContextGatewayTranscript,
} from '../../context-gateway/context-gateway-contract';
import {
  CONTEXT_GATEWAY_V4_ENABLED_TOOLS,
  CONTEXT_GATEWAY_V4_POLICY_VERSION,
  ContextOperationOutcomeKind,
} from '../../context-gateway/context-gateway-v4-contract';
import { ContextGatewayLeaseAuthorityKind } from '../../context-gateway/context-gateway-lease-authority';
import {
  ContextGatewayV4ReplayMaterialRecorder,
  decryptContextGatewayV4ReplayMaterial,
} from '../../context-gateway/context-gateway-v4-replay-material';
import {
  CONTEXT_GATEWAY_V4_MAX_TRANSCRIPT_BYTES,
  ContextGatewayV4Recorder,
  type ContextGatewayV4Transcript,
} from '../../context-gateway/context-gateway-v4-recorder';
import { logger } from '../../utils/logger';
import type {
  ContextDependencyAttestationReference,
  ReviewContextAttestationPort,
  ReviewInvocationLease,
} from '../application';
import {
  ReviewContextInspectionFailure,
  ReviewContextInspectionFailureReason,
  ReviewContextInspectionFailureStage,
  ReviewExecutionProviderKind,
} from '../application';

const execFileAsync = promisify(execFile);
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_REPLAY_MATERIAL_BYTES = 2 * 1024 * 1024;
const MAX_ENCRYPTED_REPLAY_MATERIAL_BYTES =
  Math.ceil((MAX_REPLAY_MATERIAL_BYTES * 4) / 3) + 4_096;
export type ContextGatewayPolicyVersion =
  | typeof CONTEXT_GATEWAY_POLICY_VERSION
  | typeof CONTEXT_GATEWAY_V4_POLICY_VERSION;

export type ContextGatewayRevision = Readonly<{
  baseSha: string;
  mergeBaseSha: string;
  headSha: string;
}>;

export type ContextGatewayInvocationConfig = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  gatewayBinaryHash: string;
  gatewayPolicyVersion: ContextGatewayPolicyVersion;
  enabledTools: readonly string[];
  runtimeEnvironment: Readonly<Record<string, string | undefined>>;
}>;

export type ContextGatewayCredentialLease = Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
}>;

export enum ContextGatewayExecutionProfile {
  PromptOnlyEnvelopeV1 = 'prompt_only_envelope_v1',
  AgenticUnboundedV1 = 'agentic_unbounded_v1',
  ContextGatewayV1 = 'context_gateway_v1',
  InvestigationGatewayV1 = 'investigation_gateway_v1',
  GatewayAttestedAgentV1 = 'gateway_attested_agent_v1',
}

export type OpenContextGatewayInvocationInput = Readonly<{
  invocationLease: ReviewInvocationLease;
  leaseAuthorityKind: ContextGatewayLeaseAuthorityKind;
  currentInvocationLease?: () => ReviewInvocationLease;
  sourceExecutionId: string;
  sourceWorkSlotId: string;
  sourceReviewRevisionHash: string;
  providerKind: unknown;
  requestedModel: string;
  executionProfile: unknown;
  providerInvocationKey: string;
  toolPolicyHash: string;
  openingIntentDiscriminator?: string;
  revision: ContextGatewayRevision;
}>;

export interface ContextGatewayInvocationSessionPort {
  readonly providerConfig: ContextGatewayInvocationConfig;
  readonly credentialLease: ContextGatewayCredentialLease;
  seal(input: {
    readonly actualModel: string;
    readonly terminalOutcomeHash: string;
  }): Promise<ContextDependencyAttestationReference | null>;
  dispose(): Promise<void>;
}

export interface ContextGatewayInvocationSessionFactoryPort {
  planningConfig(
    revision: ContextGatewayRevision
  ): Promise<ContextGatewayInvocationConfig>;
  canonicalInventory(
    revision: ContextGatewayRevision
  ): Promise<CanonicalGitInventory>;
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
  }): Promise<RequiredContextWitnessCapture | null>;
}

export type RequiredContextWitnessCapture = Readonly<{
  policyVersion: typeof CONTEXT_GATEWAY_V4_POLICY_VERSION;
  eventCount: number;
  authenticatedChainHash: string;
  replayEntryCount: number;
  replayPrefixHash: string;
}>;

export interface ContextGatewayAttestationPort {
  openGatewaySession(
    input: Parameters<ReviewContextAttestationPort['openGatewaySession']>[0]
  ): ReturnType<ReviewContextAttestationPort['openGatewaySession']>;
  sealGatewaySession(
    input: Parameters<ReviewContextAttestationPort['sealGatewaySession']>[0]
  ): ReturnType<ReviewContextAttestationPort['sealGatewaySession']>;
  abandonGatewaySession(
    input: Parameters<ReviewContextAttestationPort['abandonGatewaySession']>[0]
  ): ReturnType<ReviewContextAttestationPort['abandonGatewaySession']>;
}

export class SubprocessRequiredContextWitnessRunner implements RequiredContextWitnessRunnerPort {
  async capture(input: {
    readonly gatewayBundlePath: string;
    readonly checkoutRoot: string;
    readonly runtimeEnvironment: Readonly<Record<string, string | undefined>>;
    readonly gatewaySessionSecret: string;
  }): Promise<RequiredContextWitnessCapture | null> {
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
    if (
      input.runtimeEnvironment.REVIEWROUTER_CONTEXT_GATEWAY_POLICY_VERSION !==
      CONTEXT_GATEWAY_V4_POLICY_VERSION
    ) {
      return null;
    }
    return captureV4WitnessBoundary({
      runtimeEnvironment: input.runtimeEnvironment,
      secret: Buffer.from(input.gatewaySessionSecret, 'base64url'),
    });
  }
}

export class ContextGatewayInvocationSessionFactory implements ContextGatewayInvocationSessionFactoryPort {
  private gatewayBundleSnapshotPromise: Promise<Buffer> | undefined;

  constructor(
    private readonly attestations: ContextGatewayAttestationPort,
    private readonly options: Readonly<{
      checkoutRoot: string;
      gatewayBundlePath: string;
      policyVersion?: ContextGatewayPolicyVersion;
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
  ): Promise<ContextGatewayInvocationConfig> {
    const [gatewayBundleSnapshot, revisionTreeOids] = await Promise.all([
      this.gatewayBundleSnapshot(),
      this.revisionTreeOids(revision),
    ]);
    const gatewayBinaryHash = sha256(gatewayBundleSnapshot);
    return this.providerConfig({
      revision,
      sessionId: 'planning-session',
      eventChainSeedHash: '0'.repeat(64),
      gatewayBinaryHash,
      ...revisionTreeOids,
      transcriptPath: path.join(os.tmpdir(), 'planning-transcript.json'),
      replayMaterialPath: path.join(os.tmpdir(), 'planning-replay.json'),
      gatewayBundlePath: this.options.gatewayBundlePath,
    });
  }

  canonicalInventory(
    revision: ContextGatewayRevision
  ): Promise<CanonicalGitInventory> {
    return buildCanonicalGitInventory({
      root: this.options.checkoutRoot,
      mergeBaseSha: revision.mergeBaseSha,
      headSha: revision.headSha,
    });
  }

  async open(
    input: OpenContextGatewayInvocationInput
  ): Promise<ContextGatewayInvocationSessionPort> {
    const providerKind = requireProviderKind(input.providerKind);
    const executionProfile = requireExecutionProfile(input.executionProfile);
    const [gatewayBundleSnapshot, revisionTreeOids] = await Promise.all([
      this.gatewayBundleSnapshot(),
      this.revisionTreeOids(input.revision),
    ]);
    const { checkoutTreeOid } = revisionTreeOids;
    const gatewayBinaryHash = sha256(gatewayBundleSnapshot);
    const gatewayPolicyVersion = this.policyVersion();
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'reviewrouter-context-gateway-')
    );
    const gatewayBundlePath = path.join(directory, 'context-gateway.cjs');
    const transcriptPath = path.join(directory, 'transcript.json');
    const replayMaterialPath = path.join(directory, 'replay-material.json');
    let requiredWitness: RequiredContextWitnessCapture | null = null;
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
      (input.leaseAuthorityKind ===
        ContextGatewayLeaseAuthorityKind.StandardExecution
        ? canonicalizeReviewContextConfinementEvidence
        : canonicalizeReviewInvestigationContextConfinementEvidence)({
        attemptId: input.invocationLease.attemptId,
        sourceLeaseId: input.invocationLease.leaseId,
        sourceFencingToken: input.invocationLease.fencingToken,
        sourceExecutionId: input.sourceExecutionId,
        sourceWorkSlotId: input.sourceWorkSlotId,
        sourceReviewRevisionHash: input.sourceReviewRevisionHash,
        checkoutTreeOid,
        providerKind,
        requestedModel: input.requestedModel,
        executionProfile,
        providerInvocationKey: input.providerInvocationKey,
        toolPolicyHash: input.toolPolicyHash,
        gatewayPolicyVersion,
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
        gatewayPolicyVersion,
        gatewayBinaryHash,
        confinementEvidenceHash,
        ...(input.openingIntentDiscriminator === undefined
          ? {}
          : {
              openingIntentDiscriminator: input.openingIntentDiscriminator,
            }),
      });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    const secret = Buffer.from(serverSession.gatewaySessionSecret, 'base64url');
    const providerConfig = this.providerConfig({
      revision: input.revision,
      sessionId: serverSession.sessionId,
      eventChainSeedHash: serverSession.eventChainSeedHash,
      gatewayBinaryHash,
      ...revisionTreeOids,
      transcriptPath,
      replayMaterialPath,
      gatewayBundlePath,
    });
    try {
      if (secret.byteLength < 32) {
        throw new Error('context_gateway_session_secret_invalid');
      }
      requiredWitness = await this.requiredWitnessRunner.capture({
        gatewayBundlePath,
        checkoutRoot: this.options.checkoutRoot,
        runtimeEnvironment: providerConfig.runtimeEnvironment,
        gatewaySessionSecret: serverSession.gatewaySessionSecret,
      });
      if (
        gatewayPolicyVersion === CONTEXT_GATEWAY_V4_POLICY_VERSION &&
        executionProfile === ContextGatewayExecutionProfile.ContextGatewayV1 &&
        !requiredWitness
      ) {
        throw new Error('context_gateway_required_witness_missing');
      }
    } catch (error) {
      await cleanupOpenedGatewaySession({
        attestations: this.attestations,
        invocationLease: input.invocationLease,
        serverSession,
        secret,
        directory,
        primaryError: error,
      });
    }
    return new ContextGatewayInvocationSession(
      this.attestations,
      input.currentInvocationLease ?? (() => input.invocationLease),
      serverSession,
      providerConfig,
      secret,
      transcriptPath,
      replayMaterialPath,
      directory,
      executionProfile,
      requiredWitness
    );
  }

  private providerConfig(input: {
    readonly revision: ContextGatewayRevision;
    readonly sessionId: string;
    readonly eventChainSeedHash: string;
    readonly gatewayBinaryHash: string;
    readonly checkoutTreeOid: string;
    readonly mergeBaseTreeOid: string;
    readonly transcriptPath: string;
    readonly replayMaterialPath: string;
    readonly gatewayBundlePath: string;
  }): ContextGatewayInvocationConfig {
    const policyVersion = this.policyVersion();
    return Object.freeze({
      command: process.execPath,
      args: Object.freeze([input.gatewayBundlePath]),
      cwd: this.options.checkoutRoot,
      gatewayBinaryHash: input.gatewayBinaryHash,
      gatewayPolicyVersion: policyVersion,
      enabledTools:
        policyVersion === CONTEXT_GATEWAY_V4_POLICY_VERSION
          ? CONTEXT_GATEWAY_V4_ENABLED_TOOLS
          : CONTEXT_GATEWAY_V3_ENABLED_TOOLS,
      runtimeEnvironment: Object.freeze({
        REVIEWROUTER_CONTEXT_GATEWAY_POLICY_VERSION: policyVersion,
        REVIEWROUTER_CONTEXT_SESSION_ID: input.sessionId,
        REVIEWROUTER_CONTEXT_ROOT: this.options.checkoutRoot,
        REVIEWROUTER_CONTEXT_TRANSCRIPT_PATH: input.transcriptPath,
        REVIEWROUTER_CONTEXT_REPLAY_MATERIAL_PATH: input.replayMaterialPath,
        REVIEWROUTER_CONTEXT_GATEWAY_BINARY_HASH: input.gatewayBinaryHash,
        REVIEWROUTER_CONTEXT_CHECKOUT_TREE_OID: input.checkoutTreeOid,
        REVIEWROUTER_CONTEXT_MERGE_BASE_TREE_OID: input.mergeBaseTreeOid,
        REVIEWROUTER_CONTEXT_EVENT_CHAIN_SEED_HASH: input.eventChainSeedHash,
        REVIEWROUTER_CONTEXT_BASE_SHA: input.revision.baseSha,
        REVIEWROUTER_CONTEXT_MERGE_BASE_SHA: input.revision.mergeBaseSha,
        REVIEWROUTER_CONTEXT_HEAD_SHA: input.revision.headSha,
      }),
    });
  }

  private policyVersion(): ContextGatewayPolicyVersion {
    return this.options.policyVersion ?? CONTEXT_GATEWAY_POLICY_VERSION;
  }

  private async gatewayBundleSnapshot(): Promise<Buffer> {
    this.gatewayBundleSnapshotPromise ??= readFile(
      this.options.gatewayBundlePath
    );
    return Buffer.from(await this.gatewayBundleSnapshotPromise);
  }

  private async revisionTreeOids(
    revision: ContextGatewayRevision
  ): Promise<Readonly<{ checkoutTreeOid: string; mergeBaseTreeOid: string }>> {
    const headSha = requireGitOid(
      revision.headSha.toLowerCase(),
      'context_gateway_head_sha'
    );
    const mergeBaseSha = requireGitOid(
      revision.mergeBaseSha.toLowerCase(),
      'context_gateway_merge_base_sha'
    );
    const [checkoutTreeOid, headTreeOid, mergeBaseTreeOid] = await Promise.all([
      this.revisionTreeOid('HEAD', 'context_gateway_checkout_tree_oid'),
      this.revisionTreeOid(headSha, 'context_gateway_head_tree_oid'),
      this.revisionTreeOid(mergeBaseSha, 'context_gateway_merge_base_tree_oid'),
    ]);
    if (checkoutTreeOid !== headTreeOid) {
      throw new Error('context_gateway_checkout_revision_mismatch');
    }
    return Object.freeze({ checkoutTreeOid, mergeBaseTreeOid });
  }

  private async revisionTreeOid(
    revision: string,
    field: string
  ): Promise<string> {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', `${revision}^{tree}`],
      {
        cwd: this.options.checkoutRoot,
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_NO_REPLACE_OBJECTS: '1',
        },
      }
    );
    return requireGitOid(stdout.trim().toLowerCase(), field);
  }
}

class ContextGatewayInvocationSession implements ContextGatewayInvocationSessionPort {
  readonly credentialLease: ContextGatewayCredentialLease;
  private serverTerminal = false;
  private disposePromise: Promise<void> | undefined;

  constructor(
    private readonly attestations: ContextGatewayAttestationPort,
    private readonly currentInvocationLease: () => ReviewInvocationLease,
    private readonly serverSession: Awaited<
      ReturnType<ContextGatewayAttestationPort['openGatewaySession']>
    >,
    readonly providerConfig: ContextGatewayInvocationConfig,
    private readonly secret: Buffer,
    private readonly transcriptPath: string,
    private readonly replayMaterialPath: string,
    private readonly directory: string,
    private readonly executionProfile: ContextGatewayExecutionProfile,
    private readonly requiredWitness: RequiredContextWitnessCapture | null
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
    if (
      this.providerConfig.gatewayPolicyVersion ===
      CONTEXT_GATEWAY_V4_POLICY_VERSION
    ) {
      return this.sealV4(input);
    }
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
    const expectedChangedPathsOperandsHash = contextGitFactOperandsHash({
      fact: 'changed_paths',
      mergeBaseTreeOid:
        this.providerConfig.runtimeEnvironment
          .REVIEWROUTER_CONTEXT_MERGE_BASE_TREE_OID!,
      headTreeOid:
        this.providerConfig.runtimeEnvironment
          .REVIEWROUTER_CONTEXT_CHECKOUT_TREE_OID!,
    });
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
    if (transcript.dependencies.length < 2) {
      throw new ReviewContextInspectionFailure(
        ReviewContextInspectionFailureReason.MissingProviderInspection
      );
    }
    const { transcriptCanonicalJson, replayMaterialCanonicalJson } =
      createWireSealPayload(transcript, replayMaterial);
    await rm(this.replayMaterialPath);
    const attestation = await this.attestations.sealGatewaySession({
      invocationLease: this.currentInvocationLease(),
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
    if (attestation) this.serverTerminal = true;
    return attestation;
  }

  private async sealV4(input: {
    readonly actualModel: string;
    readonly terminalOutcomeHash: string;
  }): Promise<ContextDependencyAttestationReference | null> {
    let stage = ReviewContextInspectionFailureStage.TranscriptResume;
    try {
      const recorder = new ContextGatewayV4Recorder({
        sessionId: this.serverSession.sessionId,
        transcriptPath: this.transcriptPath,
        secret: this.secret,
        gatewayBinaryHash: this.providerConfig.gatewayBinaryHash,
        checkoutTreeOid:
          this.providerConfig.runtimeEnvironment
            .REVIEWROUTER_CONTEXT_CHECKOUT_TREE_OID!,
        eventChainSeedHash: this.serverSession.eventChainSeedHash,
      });
      await recorder.resume();
      stage = ReviewContextInspectionFailureStage.TranscriptValidation;
      const transcript = recorder.snapshot();
      if (transcript.events.length === 0) {
        throw new ReviewContextInspectionFailure(
          ReviewContextInspectionFailureReason.MissingProviderInspection
        );
      }
      if (
        transcript.confinementTainted ||
        transcript.terminalFailureClass !== null
      ) {
        logV4TranscriptRejection('terminal_state', transcript);
        throw new ReviewContextInspectionFailure(
          ReviewContextInspectionFailureReason.IncompleteTranscript
        );
      }
      const transcriptCanonicalJson = createV4WireSealPayload(transcript);
      stage = ReviewContextInspectionFailureStage.ReplayRead;
      const encryptedReplayMaterialCanonicalJson = await readBoundedText(
        this.replayMaterialPath,
        MAX_ENCRYPTED_REPLAY_MATERIAL_BYTES
      );
      stage = ReviewContextInspectionFailureStage.ReplayDecrypt;
      const replayMaterialCanonicalJson = decryptContextGatewayV4ReplayMaterial(
        {
          encryptedCanonicalJson: encryptedReplayMaterialCanonicalJson,
          secret: this.secret,
          sessionId: this.serverSession.sessionId,
        }
      );
      if (
        this.executionProfile ===
        ContextGatewayExecutionProfile.ContextGatewayV1
      ) {
        try {
          verifyStrictV4ProviderInspection({
            transcript,
            replayMaterialCanonicalJson,
            requiredWitness: this.requiredWitness,
            sessionId: this.serverSession.sessionId,
          });
        } catch (error) {
          logV4TranscriptRejection('strict_replay_validation', transcript);
          throw error;
        }
        const [stableTranscriptCanonicalJson, stableReplay] = await Promise.all(
          [
            readBoundedCanonicalJson(
              this.transcriptPath,
              CONTEXT_GATEWAY_V4_MAX_TRANSCRIPT_BYTES
            ),
            readBoundedText(
              this.replayMaterialPath,
              MAX_ENCRYPTED_REPLAY_MATERIAL_BYTES
            ),
          ]
        );
        if (
          !sameV4TranscriptBoundary(
            stableTranscriptCanonicalJson,
            transcript
          ) ||
          stableReplay !== encryptedReplayMaterialCanonicalJson
        ) {
          logV4TranscriptRejection('unstable_boundary', transcript);
          throw new ReviewContextInspectionFailure(
            ReviewContextInspectionFailureReason.IncompleteTranscript
          );
        }
      }
      stage = ReviewContextInspectionFailureStage.ControlPlaneSeal;
      const attestation = await this.attestations.sealGatewaySession({
        invocationLease: this.currentInvocationLease(),
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
      if (attestation) this.serverTerminal = true;
      return attestation;
    } catch (error) {
      if (error instanceof ReviewContextInspectionFailure) throw error;
      throw new ReviewContextInspectionFailure(
        ReviewContextInspectionFailureReason.GatewayOutputUnavailable,
        stage
      );
    }
  }

  async dispose(): Promise<void> {
    this.disposePromise ??= this.disposeOnce();
    await this.disposePromise;
  }

  private async disposeOnce(): Promise<void> {
    const failures: unknown[] = [];
    if (!this.serverTerminal) {
      try {
        await this.attestations.abandonGatewaySession({
          invocationLease: this.currentInvocationLease(),
          session: this.serverSession,
        });
        this.serverTerminal = true;
      } catch (error) {
        failures.push(error);
      }
    }
    this.secret.fill(0);
    try {
      await rm(this.directory, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    throwCleanupFailures(failures);
  }
}

function logV4TranscriptRejection(
  phase: 'terminal_state' | 'strict_replay_validation' | 'unstable_boundary',
  transcript: ContextGatewayV4Transcript
): void {
  const outcomeCounts = transcript.events.reduce(
    (counts, event) => {
      counts[event.outcome] += 1;
      return counts;
    },
    {
      [ContextOperationOutcomeKind.Succeeded]: 0,
      [ContextOperationOutcomeKind.Rejected]: 0,
      [ContextOperationOutcomeKind.Failed]: 0,
    }
  );
  logger.warn('Context gateway v4 transcript rejected', {
    phase,
    eventCount: transcript.events.length,
    succeededCount: outcomeCounts[ContextOperationOutcomeKind.Succeeded],
    rejectedCount: outcomeCounts[ContextOperationOutcomeKind.Rejected],
    failedCount: outcomeCounts[ContextOperationOutcomeKind.Failed],
    confinementTainted: transcript.confinementTainted,
    terminalFailureClass: transcript.terminalFailureClass,
    failureClasses: [
      ...new Set(
        transcript.events
          .map((event) => event.failureClass)
          .filter((value): value is NonNullable<typeof value> => value !== null)
      ),
    ].sort(),
    sanitizedReasons: [
      ...new Set(
        transcript.events
          .map((event) => event.sanitizedReason)
          .filter((value): value is string => value !== null)
      ),
    ].sort(),
    operationKinds: [
      ...new Set(transcript.events.map((event) => event.operationKind)),
    ].sort(),
  });
}

async function captureV4WitnessBoundary(input: {
  readonly runtimeEnvironment: Readonly<Record<string, string | undefined>>;
  readonly secret: Buffer;
}): Promise<RequiredContextWitnessCapture> {
  const sessionId = requireEnvironmentValue(
    input.runtimeEnvironment,
    'REVIEWROUTER_CONTEXT_SESSION_ID'
  );
  const recorder = new ContextGatewayV4Recorder({
    sessionId,
    transcriptPath: requireEnvironmentValue(
      input.runtimeEnvironment,
      'REVIEWROUTER_CONTEXT_TRANSCRIPT_PATH'
    ),
    secret: input.secret,
    gatewayBinaryHash: requireEnvironmentValue(
      input.runtimeEnvironment,
      'REVIEWROUTER_CONTEXT_GATEWAY_BINARY_HASH'
    ),
    checkoutTreeOid: requireEnvironmentValue(
      input.runtimeEnvironment,
      'REVIEWROUTER_CONTEXT_CHECKOUT_TREE_OID'
    ),
    eventChainSeedHash: requireEnvironmentValue(
      input.runtimeEnvironment,
      'REVIEWROUTER_CONTEXT_EVENT_CHAIN_SEED_HASH'
    ),
  });
  await recorder.resume();
  const transcript = recorder.snapshot();
  const replay = new ContextGatewayV4ReplayMaterialRecorder({
    sessionId,
    replayMaterialPath: requireEnvironmentValue(
      input.runtimeEnvironment,
      'REVIEWROUTER_CONTEXT_REPLAY_MATERIAL_PATH'
    ),
    secret: input.secret,
  });
  await replay.resume();
  const replayMaterial = replay.snapshot();
  if (
    transcript.events.length === 0 ||
    replayMaterial.entries.length === 0 ||
    replayMaterial.entries.length !==
      transcript.events.filter(
        (event) => event.outcome === ContextOperationOutcomeKind.Succeeded
      ).length
  ) {
    throw new Error('context_gateway_required_witness_incomplete');
  }
  return Object.freeze({
    policyVersion: CONTEXT_GATEWAY_V4_POLICY_VERSION,
    eventCount: transcript.events.length,
    authenticatedChainHash: transcript.authenticatedChainHash,
    replayEntryCount: replayMaterial.entries.length,
    replayPrefixHash: sha256(canonicalJson(replayMaterial.entries)),
  });
}

function verifyStrictV4ProviderInspection(input: {
  readonly transcript: ContextGatewayV4Transcript;
  readonly replayMaterialCanonicalJson: string;
  readonly requiredWitness: RequiredContextWitnessCapture | null;
  readonly sessionId: string;
}): void {
  const baseline = input.requiredWitness;
  if (
    !baseline ||
    baseline.policyVersion !== CONTEXT_GATEWAY_V4_POLICY_VERSION ||
    baseline.eventCount < 1 ||
    baseline.eventCount > input.transcript.events.length ||
    input.transcript.events[baseline.eventCount - 1]?.eventHash !==
      baseline.authenticatedChainHash
  ) {
    throw new ReviewContextInspectionFailure(
      ReviewContextInspectionFailureReason.IncompleteTranscript
    );
  }
  const replayMaterial = JSON.parse(input.replayMaterialCanonicalJson) as {
    readonly replayMaterialVersion: unknown;
    readonly sessionId: unknown;
    readonly entries: readonly Readonly<{
      sequence: number;
      operationReceiptId: string;
      operationKey: string;
      operationKind: string;
    }>[];
  };
  if (
    replayMaterial.replayMaterialVersion !== 2 ||
    replayMaterial.sessionId !== input.sessionId ||
    !Array.isArray(replayMaterial.entries) ||
    baseline.replayEntryCount < 1 ||
    baseline.replayEntryCount > replayMaterial.entries.length ||
    sha256(
      canonicalJson(replayMaterial.entries.slice(0, baseline.replayEntryCount))
    ) !== baseline.replayPrefixHash
  ) {
    throw new ReviewContextInspectionFailure(
      ReviewContextInspectionFailureReason.IncompleteTranscript
    );
  }
  const successfulEvents = input.transcript.events.filter(
    (event) => event.outcome === ContextOperationOutcomeKind.Succeeded
  );
  if (
    successfulEvents.length !== replayMaterial.entries.length ||
    successfulEvents.some((event, index) => {
      const replayEntry = replayMaterial.entries[index];
      return (
        replayEntry?.sequence !== event.sequence ||
        replayEntry.operationReceiptId !== event.operationReceiptId ||
        replayEntry.operationKey !== event.operationKey ||
        replayEntry.operationKind !== event.operationKind
      );
    })
  ) {
    throw new ReviewContextInspectionFailure(
      ReviewContextInspectionFailureReason.IncompleteTranscript
    );
  }
  const providerSuffix = input.transcript.events.slice(baseline.eventCount);
  if (
    !providerSuffix.some(
      (event) => event.outcome === ContextOperationOutcomeKind.Succeeded
    )
  ) {
    throw new ReviewContextInspectionFailure(
      ReviewContextInspectionFailureReason.MissingProviderInspection
    );
  }
}

function sameV4TranscriptBoundary(
  canonicalTranscript: string,
  expected: ContextGatewayV4Transcript
): boolean {
  const candidate = JSON.parse(
    canonicalTranscript
  ) as ContextGatewayV4Transcript;
  return (
    typeof candidate.updatedAtMs === 'number' &&
    canonicalJson({ ...candidate, updatedAtMs: 0 }) ===
      canonicalJson({ ...expected, updatedAtMs: 0 })
  );
}

function requireEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  key: string
): string {
  const value = environment[key];
  if (!value)
    throw new Error('context_gateway_required_witness_config_invalid');
  return value;
}

async function cleanupOpenedGatewaySession(input: {
  readonly attestations: ContextGatewayAttestationPort;
  readonly invocationLease: ReviewInvocationLease;
  readonly serverSession: Awaited<
    ReturnType<ContextGatewayAttestationPort['openGatewaySession']>
  >;
  readonly secret: Buffer;
  readonly directory: string;
  readonly primaryError: unknown;
}): Promise<never> {
  const failures: unknown[] = [input.primaryError];
  try {
    await input.attestations.abandonGatewaySession({
      invocationLease: input.invocationLease,
      session: input.serverSession,
    });
  } catch (error) {
    failures.push(error);
  }
  input.secret.fill(0);
  try {
    await rm(input.directory, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw input.primaryError;
  throw new AggregateError(failures, 'context_gateway_open_cleanup_failed', {
    cause: input.primaryError,
  });
}

function throwCleanupFailures(failures: readonly unknown[]): void {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, 'context_gateway_dispose_failed');
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

async function readBoundedText(
  file: string,
  maximumBytes: number
): Promise<string> {
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size < 2 || metadata.size > maximumBytes) {
    throw new Error('context_gateway_output_size_invalid');
  }
  const value = await readFile(file, 'utf8');
  if (Buffer.byteLength(value, 'utf8') !== metadata.size) {
    throw new Error('context_gateway_output_size_invalid');
  }
  return value;
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

function createV4WireSealPayload(
  transcript: ContextGatewayV4Transcript
): string {
  return canonicalJson({
    manifestVersion: 3,
    gatewayPolicyVersion: transcript.gatewayPolicyVersion,
    gatewayBinaryHash: transcript.gatewayBinaryHash,
    checkoutTreeOid: transcript.checkoutTreeOid,
    eventChainSeedHash: transcript.eventChainSeedHash,
    authenticatedChainHash: transcript.authenticatedChainHash,
    complete: true,
    confinementTainted: transcript.confinementTainted,
    terminalFailureClass: transcript.terminalFailureClass,
    events: transcript.events,
  });
}

function keyedSha256(secret: Buffer, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function requireProviderKind(value: unknown): ReviewExecutionProviderKind {
  switch (value) {
    case ReviewExecutionProviderKind.Codex:
      return ReviewExecutionProviderKind.Codex;
    case ReviewExecutionProviderKind.ClaudeCode:
      return ReviewExecutionProviderKind.ClaudeCode;
    case ReviewExecutionProviderKind.OpenRouter:
      return ReviewExecutionProviderKind.OpenRouter;
    default:
      throw new Error('context_gateway_provider_kind_invalid');
  }
}

function requireExecutionProfile(
  value: unknown
): ContextGatewayExecutionProfile {
  switch (value) {
    case ContextGatewayExecutionProfile.PromptOnlyEnvelopeV1:
      return ContextGatewayExecutionProfile.PromptOnlyEnvelopeV1;
    case ContextGatewayExecutionProfile.AgenticUnboundedV1:
      return ContextGatewayExecutionProfile.AgenticUnboundedV1;
    case ContextGatewayExecutionProfile.ContextGatewayV1:
      return ContextGatewayExecutionProfile.ContextGatewayV1;
    case ContextGatewayExecutionProfile.InvestigationGatewayV1:
      return ContextGatewayExecutionProfile.InvestigationGatewayV1;
    case ContextGatewayExecutionProfile.GatewayAttestedAgentV1:
      return ContextGatewayExecutionProfile.GatewayAttestedAgentV1;
    default:
      throw new Error('context_gateway_execution_profile_invalid');
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
