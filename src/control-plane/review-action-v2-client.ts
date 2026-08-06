import { createHash, randomUUID } from 'crypto';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import reviewContextGatewayOpenSchema from './generated/review-action-v2/schemas/review_context_gateway_open.schema.json';
import reviewContextGatewaySealSchema from './generated/review-action-v2/schemas/review_context_gateway_seal.schema.json';
import reviewContextReceiptReplayCommitSchema from './generated/review-action-v2/schemas/review_context_receipt_replay_commit.schema.json';
import reviewContextReplayCommitSchema from './generated/review-action-v2/schemas/review_context_replay_commit.schema.json';
import reviewEvidenceCommitSchema from './generated/review-action-v2/schemas/review_evidence_commit.schema.json';
import reviewEvidenceLookupSchema from './generated/review-action-v2/schemas/review_evidence_lookup.schema.json';
import reviewExecutionFinalizeSchema from './generated/review-action-v2/schemas/review_execution_finalize.schema.json';
import reviewExecutionObservationAttachSchema from './generated/review-action-v2/schemas/review_execution_observation_attach.schema.json';
import reviewExecutionObservationAdoptSchema from './generated/review-action-v2/schemas/review_execution_observation_adopt.schema.json';
import reviewExecutionRestoreSchema from './generated/review-action-v2/schemas/review_execution_restore.schema.json';
import reviewExecutionStartSchema from './generated/review-action-v2/schemas/review_execution_start.schema.json';
import reviewExecutionSupersedeSchema from './generated/review-action-v2/schemas/review_execution_supersede.schema.json';
import reviewInvestigationConcludeSchema from './generated/review-action-v2/schemas/review_investigation_conclude.schema.json';
import reviewInvestigationContextGatewayOpenSchema from './generated/review-action-v2/schemas/review_investigation_context_gateway_open.schema.json';
import reviewInvestigationContextGatewaySealSchema from './generated/review-action-v2/schemas/review_investigation_context_gateway_seal.schema.json';
import reviewInvestigationLeaseAcquireSchema from './generated/review-action-v2/schemas/review_investigation_lease_acquire.schema.json';
import reviewInvestigationLeaseReleaseSchema from './generated/review-action-v2/schemas/review_investigation_lease_release.schema.json';
import reviewInvestigationLeaseRenewSchema from './generated/review-action-v2/schemas/review_investigation_lease_renew.schema.json';
import reviewInvestigationOpenSchema from './generated/review-action-v2/schemas/review_investigation_open.schema.json';
import reviewInvestigationOpenV2Schema from './generated/review-action-v2/schemas/review_investigation_open_v2.schema.json';
import reviewInvestigationReplaySchema from './generated/review-action-v2/schemas/review_investigation_replay.schema.json';
import reviewInvestigationReplayPrepareSchema from './generated/review-action-v2/schemas/review_investigation_replay_prepare.schema.json';
import reviewInvestigationReplayV2Schema from './generated/review-action-v2/schemas/review_investigation_replay_v2.schema.json';
import reviewInvestigationRestoreSchema from './generated/review-action-v2/schemas/review_investigation_restore.schema.json';
import reviewInvestigationTurnAbortSchema from './generated/review-action-v2/schemas/review_investigation_turn_abort.schema.json';
import reviewInvestigationTurnCommitSchema from './generated/review-action-v2/schemas/review_investigation_turn_commit.schema.json';
import reviewInvestigationTurnPlanSchema from './generated/review-action-v2/schemas/review_investigation_turn_plan.schema.json';
import reviewInvocationLeaseAcquireSchema from './generated/review-action-v2/schemas/review_invocation_lease_acquire.schema.json';
import reviewInvocationLeaseReleaseSchema from './generated/review-action-v2/schemas/review_invocation_lease_release.schema.json';
import reviewInvocationLeaseRenewSchema from './generated/review-action-v2/schemas/review_invocation_lease_renew.schema.json';
import reviewPublicationRequestSchema from './generated/review-action-v2/schemas/review_publication_request.schema.json';
import reviewPublicationStatusSchema from './generated/review-action-v2/schemas/review_publication_status.schema.json';
import reviewRunAuthorizeSchema from './generated/review-action-v2/schemas/review_run_authorize.schema.json';
import reviewRunRenewSchema from './generated/review-action-v2/schemas/review_run_renew.schema.json';
import reviewSnapshotRestoreSchema from './generated/review-action-v2/schemas/review_snapshot_restore.schema.json';
import generatedManifest from './generated/review-action-v2/manifest.json';
import {
  canonicalizeReviewActionV2Request,
  parseReviewActionV2Request,
  reviewActionV2Operations,
  ReviewActionV2OperationId,
  type ReviewActionV2ErrorResponse,
  type ReviewActionV2RequestEnvelope,
  type ReviewActionV2RequestMap,
  type ReviewActionV2ResultEnvelope,
  type ReviewActionV2ResultMap,
  ReviewActionV2ProtocolErrorCode,
  reviewActionV2PublishedProtocolVersion,
  reviewActionV2PublishedSchemaDigest,
} from './generated/review-action-v2/review-action-v2';
import { ReviewActionV2RetryClass } from './generated/review-action-v2/review-action-v2-negotiation';

type FetchImplementation = typeof fetch;
type RequestEnvelopeKey = keyof ReviewActionV2RequestEnvelope;

export type ReviewActionV2ClientRequest<
  Operation extends ReviewActionV2OperationId,
> = Omit<
  ReviewActionV2RequestMap[Operation],
  RequestEnvelopeKey | 'requestBodyHash'
>;

export enum ReviewActionV2ClientFailureCode {
  InvalidConfiguration = 'invalid_configuration',
  InvalidRequest = 'invalid_request',
  RequestTimedOut = 'request_timed_out',
  NetworkFailure = 'network_failure',
  ResponseTooLarge = 'response_too_large',
  InvalidResponse = 'invalid_response',
  ProtocolError = 'protocol_error',
}

export class ReviewActionV2ClientError extends Error {
  constructor(
    readonly code: ReviewActionV2ClientFailureCode,
    readonly operationId: ReviewActionV2OperationId,
    options: {
      readonly httpStatus?: number;
      readonly protocolErrorCode?: ReviewActionV2ProtocolErrorCode;
      readonly retryClass?: ReviewActionV2RetryClass;
      readonly retryAfterMs?: number;
      readonly issues?: readonly string[];
      readonly cause?: unknown;
    } = {}
  ) {
    const diagnostics = [
      `operation=${operationId}`,
      options.httpStatus === undefined
        ? null
        : `http_status=${options.httpStatus}`,
      options.protocolErrorCode === undefined
        ? null
        : `error_code=${options.protocolErrorCode}`,
      options.issues?.length ? `issues=${options.issues.join(',')}` : null,
    ].filter((value): value is string => value !== null);
    super([`review_action_v2_${code}`, ...diagnostics].join(' '), {
      cause: options.cause,
    });
    this.name = 'ReviewActionV2ClientError';
    this.httpStatus = options.httpStatus;
    this.protocolErrorCode = options.protocolErrorCode;
    this.retryClass = options.retryClass;
    this.retryAfterMs = options.retryAfterMs;
    this.issues = options.issues ? [...options.issues] : undefined;
  }

  readonly httpStatus?: number;
  readonly protocolErrorCode?: ReviewActionV2ProtocolErrorCode;
  readonly retryClass?: ReviewActionV2RetryClass;
  readonly retryAfterMs?: number;
  readonly issues?: readonly string[];
}

export interface ReviewActionV2ClientOptions {
  readonly apiUrl: string;
  readonly fetchImpl?: FetchImplementation;
  readonly requestIdFactory?: () => string;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly maxAttempts?: number;
  readonly maxResponseBytes?: number;
  readonly allowInsecureLocalhost?: boolean;
}

type GeneratedOperationManifest = (typeof generatedManifest.operations)[number];

const responseSchemas = {
  [ReviewActionV2OperationId.ReviewRunAuthorize]: reviewRunAuthorizeSchema,
  [ReviewActionV2OperationId.ReviewRunRenew]: reviewRunRenewSchema,
  [ReviewActionV2OperationId.ReviewExecutionRestore]:
    reviewExecutionRestoreSchema,
  [ReviewActionV2OperationId.ReviewExecutionStart]: reviewExecutionStartSchema,
  [ReviewActionV2OperationId.ReviewExecutionSupersede]:
    reviewExecutionSupersedeSchema,
  [ReviewActionV2OperationId.ReviewExecutionObservationAttach]:
    reviewExecutionObservationAttachSchema,
  [ReviewActionV2OperationId.ReviewExecutionObservationAdopt]:
    reviewExecutionObservationAdoptSchema,
  [ReviewActionV2OperationId.ReviewExecutionFinalize]:
    reviewExecutionFinalizeSchema,
  [ReviewActionV2OperationId.ReviewInvestigationOpen]:
    reviewInvestigationOpenSchema,
  [ReviewActionV2OperationId.ReviewInvestigationOpenV2]:
    reviewInvestigationOpenV2Schema,
  [ReviewActionV2OperationId.ReviewInvestigationRestore]:
    reviewInvestigationRestoreSchema,
  [ReviewActionV2OperationId.ReviewInvestigationTurnPlan]:
    reviewInvestigationTurnPlanSchema,
  [ReviewActionV2OperationId.ReviewInvestigationLeaseAcquire]:
    reviewInvestigationLeaseAcquireSchema,
  [ReviewActionV2OperationId.ReviewInvestigationLeaseRenew]:
    reviewInvestigationLeaseRenewSchema,
  [ReviewActionV2OperationId.ReviewInvestigationLeaseRelease]:
    reviewInvestigationLeaseReleaseSchema,
  [ReviewActionV2OperationId.ReviewInvestigationTurnCommit]:
    reviewInvestigationTurnCommitSchema,
  [ReviewActionV2OperationId.ReviewInvestigationTurnAbort]:
    reviewInvestigationTurnAbortSchema,
  [ReviewActionV2OperationId.ReviewInvestigationConclude]:
    reviewInvestigationConcludeSchema,
  [ReviewActionV2OperationId.ReviewInvestigationReplayPrepare]:
    reviewInvestigationReplayPrepareSchema,
  [ReviewActionV2OperationId.ReviewInvestigationReplay]:
    reviewInvestigationReplaySchema,
  [ReviewActionV2OperationId.ReviewInvestigationReplayV2]:
    reviewInvestigationReplayV2Schema,
  [ReviewActionV2OperationId.ReviewInvocationLeaseAcquire]:
    reviewInvocationLeaseAcquireSchema,
  [ReviewActionV2OperationId.ReviewInvocationLeaseRenew]:
    reviewInvocationLeaseRenewSchema,
  [ReviewActionV2OperationId.ReviewInvocationLeaseRelease]:
    reviewInvocationLeaseReleaseSchema,
  [ReviewActionV2OperationId.ReviewContextGatewayOpen]:
    reviewContextGatewayOpenSchema,
  [ReviewActionV2OperationId.ReviewContextGatewaySeal]:
    reviewContextGatewaySealSchema,
  [ReviewActionV2OperationId.ReviewInvestigationContextGatewayOpen]:
    reviewInvestigationContextGatewayOpenSchema,
  [ReviewActionV2OperationId.ReviewInvestigationContextGatewaySeal]:
    reviewInvestigationContextGatewaySealSchema,
  [ReviewActionV2OperationId.ReviewEvidenceLookup]: reviewEvidenceLookupSchema,
  [ReviewActionV2OperationId.ReviewContextReceiptReplayCommit]:
    reviewContextReceiptReplayCommitSchema,
  [ReviewActionV2OperationId.ReviewContextReplayCommit]:
    reviewContextReplayCommitSchema,
  [ReviewActionV2OperationId.ReviewEvidenceCommit]: reviewEvidenceCommitSchema,
  [ReviewActionV2OperationId.ReviewSnapshotRestore]:
    reviewSnapshotRestoreSchema,
  [ReviewActionV2OperationId.ReviewPublicationRequest]:
    reviewPublicationRequestSchema,
  [ReviewActionV2OperationId.ReviewPublicationStatus]:
    reviewPublicationStatusSchema,
} satisfies Record<ReviewActionV2OperationId, object>;

const operationDescriptors = new Map(
  reviewActionV2Operations.map((descriptor) => [
    descriptor.operationId as ReviewActionV2OperationId,
    descriptor,
  ])
);
const operationManifests = new Map(
  generatedManifest.operations.map((operation) => [
    operation.operationId as ReviewActionV2OperationId,
    operation,
  ])
);

export class ReviewActionV2Client {
  private readonly apiUrl: URL;
  private readonly fetchImpl: FetchImplementation;
  private readonly requestIdFactory: () => string;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly maxResponseBytes: number;
  private readonly validators: Record<
    ReviewActionV2OperationId,
    ValidateFunction
  >;

  constructor(options: ReviewActionV2ClientOptions) {
    this.apiUrl = parseApiUrl(options.apiUrl, options.allowInsecureLocalhost);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestIdFactory =
      options.requestIdFactory ?? (() => `rr:${randomUUID()}`);
    this.sleep =
      options.sleep ??
      ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.maxAttempts = clampInteger(options.maxAttempts ?? 2, 1, 3);
    this.maxResponseBytes = clampInteger(
      options.maxResponseBytes ?? 2_097_152,
      1024,
      4_194_304
    );
    this.validators = compileResponseValidators();
    assertGeneratedManifestMatchesRuntime();
  }

  async execute<Operation extends ReviewActionV2OperationId>(
    operationId: Operation,
    payload: ReviewActionV2ClientRequest<Operation>
  ): Promise<ReviewActionV2ResultMap[Operation]> {
    const descriptor = requireOperationDescriptor(operationId);
    const manifest = requireOperationManifest(operationId);
    const request = this.frameRequest(operationId, payload);
    const serializedRequest = JSON.stringify(request);

    if (
      Buffer.byteLength(serializedRequest, 'utf8') > descriptor.bodyLimitBytes
    ) {
      throw new ReviewActionV2ClientError(
        ReviewActionV2ClientFailureCode.InvalidRequest,
        operationId
      );
    }

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.sendOnce(
          operationId,
          manifest,
          request.requestId,
          serializedRequest
        );
      } catch (error) {
        const normalized = normalizeClientError(error, operationId);
        if (
          attempt >= this.maxAttempts ||
          !isRetryAllowed(descriptor.semanticRetryClass, normalized)
        ) {
          throw normalized;
        }
        await this.sleep(normalized.retryAfterMs ?? 0);
      }
    }

    throw new ReviewActionV2ClientError(
      ReviewActionV2ClientFailureCode.NetworkFailure,
      operationId
    );
  }

  private frameRequest<Operation extends ReviewActionV2OperationId>(
    operationId: Operation,
    payload: ReviewActionV2ClientRequest<Operation>
  ): ReviewActionV2RequestMap[Operation] {
    const descriptor = requireOperationDescriptor(operationId);
    const base = {
      protocolVersion: reviewActionV2PublishedProtocolVersion,
      schemaDigest: reviewActionV2PublishedSchemaDigest,
      requestId: this.requestIdFactory(),
      ...payload,
    } as unknown as ReviewActionV2RequestMap[Operation];

    const request =
      descriptor.mutability === 'read' ||
      operationId === ReviewActionV2OperationId.ReviewRunAuthorize
        ? base
        : ({
            ...base,
            requestBodyHash: sha256(
              canonicalizeReviewActionV2Request(operationId, {
                ...base,
                requestBodyHash: '0'.repeat(64),
              } as ReviewActionV2RequestMap[Operation])
            ),
          } as ReviewActionV2RequestMap[Operation]);
    const parsed = parseReviewActionV2Request(operationId, request);
    if (!parsed.ok) {
      throw new ReviewActionV2ClientError(
        ReviewActionV2ClientFailureCode.InvalidRequest,
        operationId
      );
    }
    return parsed.value;
  }

  private async sendOnce<Operation extends ReviewActionV2OperationId>(
    operationId: Operation,
    manifest: GeneratedOperationManifest,
    requestId: string,
    serializedRequest: string
  ): Promise<ReviewActionV2ResultMap[Operation]> {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), manifest.defaultTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(
        new URL(manifest.path, this.apiUrl).toString(),
        {
          method: manifest.method,
          headers: { 'content-type': 'application/json' },
          body: serializedRequest,
          redirect: 'error',
          signal: abort.signal,
        }
      );
    } catch (error) {
      if (abort.signal.aborted) {
        throw new ReviewActionV2ClientError(
          ReviewActionV2ClientFailureCode.RequestTimedOut,
          operationId,
          { cause: error }
        );
      }
      throw new ReviewActionV2ClientError(
        ReviewActionV2ClientFailureCode.NetworkFailure,
        operationId,
        { cause: error }
      );
    } finally {
      clearTimeout(timeout);
    }

    const body = await readBoundedJson(
      response,
      this.maxResponseBytes,
      operationId
    );
    const validator = this.validators[operationId];
    if (!validator(body) || !isResponseEnvelope(body)) {
      throw new ReviewActionV2ClientError(
        ReviewActionV2ClientFailureCode.InvalidResponse,
        operationId,
        { httpStatus: response.status }
      );
    }
    if (
      body.protocolVersion !== reviewActionV2PublishedProtocolVersion ||
      body.schemaDigest !== reviewActionV2PublishedSchemaDigest ||
      body.requestId !== requestId
    ) {
      throw new ReviewActionV2ClientError(
        ReviewActionV2ClientFailureCode.InvalidResponse,
        operationId,
        { httpStatus: response.status }
      );
    }

    if ('error' in body) {
      const statusMapping = manifest.statusMapping.find(
        (item) => item.errorCode === body.error.errorCode
      );
      if (
        !statusMapping ||
        statusMapping.httpStatus !== response.status ||
        statusMapping.retryClass !== body.error.retryClass
      ) {
        throw new ReviewActionV2ClientError(
          ReviewActionV2ClientFailureCode.InvalidResponse,
          operationId,
          { httpStatus: response.status }
        );
      }
      throw new ReviewActionV2ClientError(
        ReviewActionV2ClientFailureCode.ProtocolError,
        operationId,
        {
          httpStatus: response.status,
          protocolErrorCode: body.error.errorCode,
          retryClass: body.error.retryClass,
          retryAfterMs: readRetryAfterMs(response),
          issues: body.error.details.issues,
        }
      );
    }

    if (!manifest.successStatuses.includes(response.status)) {
      throw new ReviewActionV2ClientError(
        ReviewActionV2ClientFailureCode.InvalidResponse,
        operationId,
        { httpStatus: response.status }
      );
    }
    return body.result as ReviewActionV2ResultMap[Operation];
  }
}

export function deriveReviewActionV2IdempotencyKey(
  operationId: ReviewActionV2OperationId,
  canonicalPreimage: string
): string {
  return `rr:${operationId}:${sha256(canonicalPreimage)}`;
}

function compileResponseValidators(): Record<
  ReviewActionV2OperationId,
  ValidateFunction
> {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return Object.fromEntries(
    Object.values(ReviewActionV2OperationId).map((operationId) => [
      operationId,
      ajv.compile(responseSchemas[operationId]),
    ])
  ) as Record<ReviewActionV2OperationId, ValidateFunction>;
}

function assertGeneratedManifestMatchesRuntime(): void {
  if (
    generatedManifest.protocolVersion !==
      reviewActionV2PublishedProtocolVersion ||
    generatedManifest.schemaDigest !== reviewActionV2PublishedSchemaDigest
  ) {
    throw new Error('review_action_v2_generated_manifest_mismatch');
  }
  const generatedOperationIds = new Set(
    generatedManifest.operations.map((operation) => operation.operationId)
  );
  if (
    generatedOperationIds.size !== Object.keys(responseSchemas).length ||
    Object.values(ReviewActionV2OperationId).some(
      (operationId) => !generatedOperationIds.has(operationId)
    )
  ) {
    throw new Error('review_action_v2_generated_operation_set_mismatch');
  }
}

function requireOperationDescriptor(operationId: ReviewActionV2OperationId) {
  const descriptor = operationDescriptors.get(operationId);
  if (!descriptor) throw new Error('review_action_v2_operation_unknown');
  return descriptor;
}

function requireOperationManifest(
  operationId: ReviewActionV2OperationId
): GeneratedOperationManifest {
  const manifest = operationManifests.get(operationId);
  if (!manifest) throw new Error('review_action_v2_operation_manifest_missing');
  return manifest;
}

function parseApiUrl(value: string, allowInsecureLocalhost = false): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error('review_action_v2_api_url_invalid', { cause: error });
  }
  const isAllowedLocalhost =
    allowInsecureLocalhost &&
    parsed.protocol === 'http:' &&
    (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  if (parsed.protocol !== 'https:' && !isAllowedLocalhost) {
    throw new Error('review_action_v2_api_url_must_use_https');
  }
  return parsed;
}

function isResponseEnvelope(
  value: unknown
): value is
  ReviewActionV2ResultEnvelope<unknown> | ReviewActionV2ErrorResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const hasResult = Object.prototype.hasOwnProperty.call(body, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(body, 'error');
  return hasResult !== hasError;
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
  operationId: ReviewActionV2OperationId
): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ReviewActionV2ClientError(
      ReviewActionV2ClientFailureCode.ResponseTooLarge,
      operationId,
      { httpStatus: response.status }
    );
  }
  const chunks: Buffer[] = [];
  let byteCount = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      let reading = true;
      while (reading) {
        const { done, value } = await reader.read();
        if (done) {
          reading = false;
          continue;
        }
        byteCount += value.byteLength;
        if (byteCount > maxBytes) {
          await reader.cancel();
          throw new ReviewActionV2ClientError(
            ReviewActionV2ClientFailureCode.ResponseTooLarge,
            operationId,
            { httpStatus: response.status }
          );
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = Buffer.concat(chunks, byteCount);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new ReviewActionV2ClientError(
      ReviewActionV2ClientFailureCode.InvalidResponse,
      operationId,
      { httpStatus: response.status, cause: error }
    );
  }
}

function normalizeClientError(
  error: unknown,
  operationId: ReviewActionV2OperationId
): ReviewActionV2ClientError {
  return error instanceof ReviewActionV2ClientError
    ? error
    : new ReviewActionV2ClientError(
        ReviewActionV2ClientFailureCode.NetworkFailure,
        operationId,
        { cause: error }
      );
}

function isRetryAllowed(
  semanticRetryClass: string,
  error: ReviewActionV2ClientError
): boolean {
  if (semanticRetryClass === ReviewActionV2RetryClass.Never) return false;
  if (error.code === ReviewActionV2ClientFailureCode.InvalidRequest)
    return false;
  if (error.code === ReviewActionV2ClientFailureCode.ResponseTooLarge)
    return false;
  if (error.code === ReviewActionV2ClientFailureCode.InvalidConfiguration)
    return false;
  if (error.code === ReviewActionV2ClientFailureCode.ProtocolError) {
    return error.retryClass === semanticRetryClass;
  }
  return true;
}

function readRetryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 30_000);
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return Math.min(Math.max(0, at - Date.now()), 30_000);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error('review_action_v2_client_limit_invalid');
  }
  return value;
}
