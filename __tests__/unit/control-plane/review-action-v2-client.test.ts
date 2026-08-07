import {
  ReviewActionV2Client,
  ReviewActionV2ClientError,
  ReviewActionV2ClientFailureCode,
} from '../../../src/control-plane/review-action-v2-client';
import {
  ReviewActionV2OperationId,
  ReviewActionV2ProtocolErrorCode,
  ReviewExecutionStartResultStatus,
  ReviewInvestigationPublishedRuntimeProfile,
  ReviewRunAuthorizationResultStatus,
  reviewActionV2PublishedProtocolVersion,
  reviewActionV2PublishedSchemaDigest,
} from '../../../src/control-plane/generated/review-action-v2/review-action-v2';
import { ReviewActionV2RetryClass } from '../../../src/control-plane/generated/review-action-v2/review-action-v2-negotiation';

describe('ReviewActionV2Client', () => {
  it('frames and validates an authorize request with the generated contract', async () => {
    const fetchImpl = jest.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return jsonResponse({
        protocolVersion: reviewActionV2PublishedProtocolVersion,
        schemaDigest: reviewActionV2PublishedSchemaDigest,
        requestId: request.requestId,
        serverTime: '2026-07-22T12:00:00.000Z',
        result: { status: ReviewRunAuthorizationResultStatus.Authorized },
      });
    });
    const client = createClient(fetchImpl);

    await expect(
      client.execute(ReviewActionV2OperationId.ReviewRunAuthorize, {
        oidcToken: 'header.payload.signature',
        supportedProtocols: [
          {
            protocolVersion: reviewActionV2PublishedProtocolVersion,
            schemaDigest: reviewActionV2PublishedSchemaDigest,
          },
        ],
      })
    ).resolves.toEqual({
      status: ReviewRunAuthorizationResultStatus.Authorized,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
    });
  });

  it('preserves validated server time for deadline normalization', async () => {
    const fetchImpl = jest.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return jsonResponse({
        protocolVersion: reviewActionV2PublishedProtocolVersion,
        schemaDigest: reviewActionV2PublishedSchemaDigest,
        requestId: request.requestId,
        serverTime: '2026-07-22T12:00:00.000Z',
        result: { status: ReviewRunAuthorizationResultStatus.Authorized },
      });
    });

    await expect(
      createClient(fetchImpl).executeWithMetadata(
        ReviewActionV2OperationId.ReviewRunAuthorize,
        {
          oidcToken: 'header.payload.signature',
          supportedProtocols: [
            {
              protocolVersion: reviewActionV2PublishedProtocolVersion,
              schemaDigest: reviewActionV2PublishedSchemaDigest,
            },
          ],
        }
      )
    ).resolves.toEqual({
      result: { status: ReviewRunAuthorizationResultStatus.Authorized },
      serverTime: '2026-07-22T12:00:00.000Z',
    });
  });

  it('retries a mutable command with byte-identical framing', async () => {
    const bodies: string[] = [];
    const fetchImpl = jest.fn(async (_url, init) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) throw new Error('connection_reset');
      const request = JSON.parse(bodies[0]);
      return jsonResponse(
        {
          protocolVersion: reviewActionV2PublishedProtocolVersion,
          schemaDigest: reviewActionV2PublishedSchemaDigest,
          requestId: request.requestId,
          serverTime: '2026-07-22T12:00:00.000Z',
          result: { status: ReviewExecutionStartResultStatus.Admitted },
        },
        201
      );
    });
    const client = createClient(fetchImpl);

    await client.execute(ReviewActionV2OperationId.ReviewExecutionStart, {
      authorizationToken: 'authorization.token',
      idempotencyKey: 'idem:start:1',
      authorizationId: 'authorization-1',
      executionId: 'execution-1',
      reviewRevisionHash: '1'.repeat(64),
      compatibilityKey: '2'.repeat(64),
      planHash: '3'.repeat(64),
      workSlotsCanonicalJson: '[]',
      sourceRunId: 'run-1',
      sourceRunAttempt: '1',
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(bodies[0]).requestBodyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('waits with bounded jitter and performs only one capacity-limited semantic retry', async () => {
    const sleep = jest.fn(async () => undefined);
    const fetchImpl = jest.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return jsonResponse(
        {
          protocolVersion: reviewActionV2PublishedProtocolVersion,
          schemaDigest: reviewActionV2PublishedSchemaDigest,
          requestId: request.requestId,
          serverTime: '2026-07-22T12:00:00.000Z',
          error: {
            errorCode: ReviewActionV2ProtocolErrorCode.CapacityLimited,
            retryClass: ReviewActionV2RetryClass.SameRequest,
            details: { issues: ['lifecycle_unavailable'] },
          },
        },
        429
      );
    });
    const client = new ReviewActionV2Client({
      apiUrl: 'http://127.0.0.1:3000',
      allowInsecureLocalhost: true,
      fetchImpl,
      maxAttempts: 3,
      requestIdFactory: () => 'rr:test-request',
      sleep,
      random: () => 0.5,
    });

    await expect(
      client.execute(ReviewActionV2OperationId.ReviewRunAuthorize, {
        oidcToken: 'header.payload.signature',
        supportedProtocols: [
          {
            protocolVersion: reviewActionV2PublishedProtocolVersion,
            schemaDigest: reviewActionV2PublishedSchemaDigest,
          },
        ],
      })
    ).rejects.toMatchObject({
      code: ReviewActionV2ClientFailureCode.ProtocolError,
      protocolErrorCode: ReviewActionV2ProtocolErrorCode.CapacityLimited,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(750);
  });

  it('does not start a retry after the caller deadline is exhausted', async () => {
    let nowMs = 0;
    const sleep = jest.fn(async (delayMs: number) => {
      nowMs += delayMs + 200;
    });
    const fetchImpl = jest.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return protocolErrorResponse(request.requestId, {
        errorCode: ReviewActionV2ProtocolErrorCode.CapacityLimited,
        retryClass: ReviewActionV2RetryClass.SameRequest,
        issues: ['capacity_limited'],
        status: 429,
      });
    });
    const client = new ReviewActionV2Client({
      apiUrl: 'http://127.0.0.1:3000',
      allowInsecureLocalhost: true,
      fetchImpl,
      requestIdFactory: () => 'rr:test-request',
      sleep,
      random: () => 0,
      monotonicNow: () => nowMs,
      maxAttempts: 3,
    });

    await expect(
      client.execute(
        ReviewActionV2OperationId.ReviewRunAuthorize,
        {
          oidcToken: 'header.payload.signature',
          supportedProtocols: [
            {
              protocolVersion: reviewActionV2PublishedProtocolVersion,
              schemaDigest: reviewActionV2PublishedSchemaDigest,
            },
          ],
        },
        { timeoutMs: 600 }
      )
    ).rejects.toMatchObject({
      code: ReviewActionV2ClientFailureCode.RequestTimedOut,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it('keeps the deadline active while consuming the response body', async () => {
    const fetchImpl = jest.fn(async (_url, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error('missing_abort_signal');
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener(
            'abort',
            () => controller.error(new Error('aborted')),
            { once: true }
          );
        },
      });
      return new Response(stream);
    });
    const client = new ReviewActionV2Client({
      apiUrl: 'http://127.0.0.1:3000',
      allowInsecureLocalhost: true,
      fetchImpl,
      requestIdFactory: () => 'rr:test-request',
      maxAttempts: 1,
    });

    await expect(
      client.execute(
        ReviewActionV2OperationId.ReviewRunAuthorize,
        {
          oidcToken: 'header.payload.signature',
          supportedProtocols: [
            {
              protocolVersion: reviewActionV2PublishedProtocolVersion,
              schemaDigest: reviewActionV2PublishedSchemaDigest,
            },
          ],
        },
        { timeoutMs: 5 }
      )
    ).rejects.toMatchObject({
      code: ReviewActionV2ClientFailureCode.RequestTimedOut,
    });
  });

  it('retries unavailable publication facts three times with byte-identical requests', async () => {
    const bodies: string[] = [];
    const sleep = jest.fn(async () => undefined);
    const fetchImpl = jest.fn(async (_url, init) => {
      const body = String(init?.body);
      bodies.push(body);
      const request = JSON.parse(body);
      if (bodies.length < 3) {
        return protocolErrorResponse(request.requestId, {
          errorCode: ReviewActionV2ProtocolErrorCode.CapacityLimited,
          retryClass: ReviewActionV2RetryClass.SameRequest,
          issues: [
            'publication_facts_unavailable',
            'publication_fact_unavailable:lifecycle',
          ],
          status: 429,
        });
      }
      return jsonResponse({
        protocolVersion: reviewActionV2PublishedProtocolVersion,
        schemaDigest: reviewActionV2PublishedSchemaDigest,
        requestId: request.requestId,
        serverTime: '2026-07-22T12:00:00.000Z',
        result: { status: 'accepted' },
      });
    });
    const client = new ReviewActionV2Client({
      apiUrl: 'http://127.0.0.1:3000',
      allowInsecureLocalhost: true,
      fetchImpl,
      requestIdFactory: () => 'rr:test-request',
      sleep,
      random: () => 0,
    });

    await expect(
      client.execute(
        ReviewActionV2OperationId.ReviewPublicationRequest,
        publicationRequest()
      )
    ).resolves.toEqual({ status: 'accepted' });
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies).size).toBe(1);
    expect(sleep).toHaveBeenNthCalledWith(1, 5_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 10_000);
  });

  it('stops publication fact retries immediately when the next gate result is stale', async () => {
    const sleep = jest.fn(async () => undefined);
    let calls = 0;
    const fetchImpl = jest.fn(async (_url, init) => {
      calls += 1;
      const request = JSON.parse(String(init?.body));
      return calls === 1
        ? protocolErrorResponse(request.requestId, {
            errorCode: ReviewActionV2ProtocolErrorCode.CapacityLimited,
            retryClass: ReviewActionV2RetryClass.SameRequest,
            issues: [
              'publication_facts_unavailable',
              'publication_fact_unavailable:lifecycle',
            ],
            status: 429,
          })
        : protocolErrorResponse(request.requestId, {
            errorCode: ReviewActionV2ProtocolErrorCode.StalePrecondition,
            retryClass: ReviewActionV2RetryClass.Never,
            issues: ['revision_not_current'],
            status: 412,
          });
    });
    const client = new ReviewActionV2Client({
      apiUrl: 'http://127.0.0.1:3000',
      allowInsecureLocalhost: true,
      fetchImpl,
      requestIdFactory: () => 'rr:test-request',
      sleep,
      random: () => 0,
    });

    await expect(
      client.execute(
        ReviewActionV2OperationId.ReviewPublicationRequest,
        publicationRequest()
      )
    ).rejects.toMatchObject({
      protocolErrorCode: ReviewActionV2ProtocolErrorCode.StalePrecondition,
      issues: ['revision_not_current'],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('preserves only the final unavailable publication facts after retries are exhausted', async () => {
    let calls = 0;
    const fetchImpl = jest.fn(async (_url, init) => {
      calls += 1;
      const request = JSON.parse(String(init?.body));
      return protocolErrorResponse(request.requestId, {
        errorCode: ReviewActionV2ProtocolErrorCode.CapacityLimited,
        retryClass: ReviewActionV2RetryClass.SameRequest,
        issues: [
          'publication_facts_unavailable',
          calls === 3
            ? 'publication_fact_unavailable:safety'
            : 'publication_fact_unavailable:lifecycle',
        ],
        status: 429,
      });
    });
    const client = new ReviewActionV2Client({
      apiUrl: 'http://127.0.0.1:3000',
      allowInsecureLocalhost: true,
      fetchImpl,
      requestIdFactory: () => 'rr:test-request',
      sleep: async () => undefined,
      random: () => 0,
    });

    await expect(
      client.execute(
        ReviewActionV2OperationId.ReviewPublicationRequest,
        publicationRequest()
      )
    ).rejects.toMatchObject({
      protocolErrorCode: ReviewActionV2ProtocolErrorCode.CapacityLimited,
      issues: [
        'publication_facts_unavailable',
        'publication_fact_unavailable:safety',
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('surfaces typed 426 without converting it to v1 behavior', async () => {
    const fetchImpl = jest.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return jsonResponse(
        {
          protocolVersion: reviewActionV2PublishedProtocolVersion,
          schemaDigest: reviewActionV2PublishedSchemaDigest,
          requestId: request.requestId,
          serverTime: '2026-07-22T12:00:00.000Z',
          error: {
            errorCode: ReviewActionV2ProtocolErrorCode.UnsupportedProtocol,
            retryClass: ReviewActionV2RetryClass.Never,
            details: { issues: ['v2_disabled'] },
          },
        },
        426
      );
    });

    await expect(
      createClient(fetchImpl).execute(
        ReviewActionV2OperationId.ReviewRunAuthorize,
        {
          oidcToken: 'header.payload.signature',
          supportedProtocols: [
            {
              protocolVersion: reviewActionV2PublishedProtocolVersion,
              schemaDigest: reviewActionV2PublishedSchemaDigest,
            },
          ],
        }
      )
    ).rejects.toMatchObject({
      code: ReviewActionV2ClientFailureCode.ProtocolError,
      httpStatus: 426,
      protocolErrorCode: ReviewActionV2ProtocolErrorCode.UnsupportedProtocol,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails deterministically when an old server does not enable investigations', async () => {
    const fetchImpl = jest.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return jsonResponse(
        {
          protocolVersion: reviewActionV2PublishedProtocolVersion,
          schemaDigest: reviewActionV2PublishedSchemaDigest,
          requestId: request.requestId,
          serverTime: '2026-07-22T12:00:00.000Z',
          error: {
            errorCode: ReviewActionV2ProtocolErrorCode.CapabilityDisabled,
            retryClass: ReviewActionV2RetryClass.Never,
            details: { issues: ['capability_disabled'] },
          },
        },
        403
      );
    });

    await expect(
      createClient(fetchImpl).execute(
        ReviewActionV2OperationId.ReviewInvestigationOpen,
        {
          authorizationToken: 'authorization.token',
          idempotencyKey: 'idem:investigation:1',
          authorizationId: 'authorization-1',
          executionId: 'execution-1',
          workSlotId: 'work-slot-1',
          reviewRevisionHash: '1'.repeat(64),
          stableReviewUnitKey: 'stable-unit-1',
          providerVoteLaneId: 'provider-lane-1',
          providerStrategyId: 'provider-strategy-1',
          runtimeProfile:
            ReviewInvestigationPublishedRuntimeProfile.GatewayAttestedAgentV1,
          coverageContractCanonicalJson: '{}',
          coverageContractHash: '2'.repeat(64),
          investigationPolicyCanonicalJson: '{}',
          investigationPolicyHash: '3'.repeat(64),
          seedObligationsCanonicalJson: '[]',
          seedObligationsHash: '4'.repeat(64),
          initialReceiptsCanonicalJson: '[]',
          initialReceiptsHash: '5'.repeat(64),
        }
      )
    ).rejects.toMatchObject({
      code: ReviewActionV2ClientFailureCode.ProtocolError,
      httpStatus: 403,
      protocolErrorCode: ReviewActionV2ProtocolErrorCode.CapabilityDisabled,
      retryClass: ReviewActionV2RetryClass.Never,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('preserves bounded server issues in protocol diagnostics', async () => {
    const fetchImpl = jest.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return jsonResponse(
        {
          protocolVersion: reviewActionV2PublishedProtocolVersion,
          schemaDigest: reviewActionV2PublishedSchemaDigest,
          requestId: request.requestId,
          serverTime: '2026-07-22T12:00:00.000Z',
          error: {
            errorCode: ReviewActionV2ProtocolErrorCode.NotFound,
            retryClass: ReviewActionV2RetryClass.Never,
            details: { issues: ['release_profile_unavailable'] },
          },
        },
        404
      );
    });

    await expect(
      createClient(fetchImpl).execute(
        ReviewActionV2OperationId.ReviewRunAuthorize,
        {
          oidcToken: 'header.payload.signature',
          supportedProtocols: [
            {
              protocolVersion: reviewActionV2PublishedProtocolVersion,
              schemaDigest: reviewActionV2PublishedSchemaDigest,
            },
          ],
        }
      )
    ).rejects.toMatchObject({
      code: ReviewActionV2ClientFailureCode.ProtocolError,
      httpStatus: 404,
      protocolErrorCode: ReviewActionV2ProtocolErrorCode.NotFound,
      issues: ['release_profile_unavailable'],
      message:
        'review_action_v2_protocol_error operation=review_run_authorize http_status=404 error_code=not_found issues=release_profile_unavailable',
    });
  });

  it('rejects unknown response fields and request identity drift', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({
        protocolVersion: reviewActionV2PublishedProtocolVersion,
        schemaDigest: reviewActionV2PublishedSchemaDigest,
        requestId: 'different-request',
        serverTime: '2026-07-22T12:00:00.000Z',
        result: { status: ReviewRunAuthorizationResultStatus.Authorized },
        unexpected: true,
      })
    );

    await expect(
      createClient(fetchImpl, 1).execute(
        ReviewActionV2OperationId.ReviewRunAuthorize,
        {
          oidcToken: 'header.payload.signature',
          supportedProtocols: [
            {
              protocolVersion: reviewActionV2PublishedProtocolVersion,
              schemaDigest: reviewActionV2PublishedSchemaDigest,
            },
          ],
        }
      )
    ).rejects.toBeInstanceOf(ReviewActionV2ClientError);
  });

  it('cancels a streamed response as soon as its byte limit is exceeded', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(700));
        controller.enqueue(new Uint8Array(700));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new ReviewActionV2Client({
      apiUrl: 'http://127.0.0.1:3000',
      allowInsecureLocalhost: true,
      fetchImpl: jest.fn(async () => new Response(stream)),
      maxAttempts: 1,
      maxResponseBytes: 1024,
      requestIdFactory: () => 'rr:test-request',
    });

    await expect(
      client.execute(ReviewActionV2OperationId.ReviewRunAuthorize, {
        oidcToken: 'header.payload.signature',
        supportedProtocols: [
          {
            protocolVersion: reviewActionV2PublishedProtocolVersion,
            schemaDigest: reviewActionV2PublishedSchemaDigest,
          },
        ],
      })
    ).rejects.toMatchObject({
      code: ReviewActionV2ClientFailureCode.ResponseTooLarge,
    });
    expect(cancelled).toBe(true);
  });
});

function createClient(fetchImpl: typeof fetch, maxAttempts = 2) {
  return new ReviewActionV2Client({
    apiUrl: 'http://127.0.0.1:3000',
    allowInsecureLocalhost: true,
    fetchImpl,
    maxAttempts,
    requestIdFactory: () => 'rr:test-request',
    sleep: async () => undefined,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function publicationRequest() {
  return {
    authorizationToken: 'authorization.token',
    idempotencyKey: 'idem:publication:1',
    publicationPermit: 'publication.permit',
    projectionHash: 'f'.repeat(64),
    operationsCanonicalJson: '[]',
  };
}

function protocolErrorResponse(
  requestId: string,
  input: {
    readonly errorCode: ReviewActionV2ProtocolErrorCode;
    readonly retryClass: ReviewActionV2RetryClass;
    readonly issues: readonly string[];
    readonly status: number;
  }
): Response {
  return jsonResponse(
    {
      protocolVersion: reviewActionV2PublishedProtocolVersion,
      schemaDigest: reviewActionV2PublishedSchemaDigest,
      requestId,
      serverTime: '2026-07-22T12:00:00.000Z',
      error: {
        errorCode: input.errorCode,
        retryClass: input.retryClass,
        details: { issues: input.issues },
      },
    },
    input.status
  );
}
