import { ReviewAgentFailureClass } from '../../../src/review-investigation/application/review-agent-port';
import {
  CODEX_APP_SERVER_VERSION,
  CodexAppServerProtocolClient,
  type CodexAppServerProtocolRequest,
} from '../../../src/review-investigation/infrastructure/codex-app-server-protocol';

const threadId = '019fd00f-9954-7320-a8c3-c17458ec2e2d';
const turnId = 'turn-1';

const supportedCodexErrorInfo = [
  ...[
    'contextWindowExceeded',
    'sessionBudgetExceeded',
    'usageLimitExceeded',
    'serverOverloaded',
    'cyberPolicy',
    'internalServerError',
    'unauthorized',
    'badRequest',
    'threadRollbackFailed',
    'sandboxError',
    'other',
  ].map((value) => [`string ${value}`, value] as const),
  [
    'object httpConnectionFailed',
    { httpConnectionFailed: { httpStatusCode: 503 } },
  ] as const,
  [
    'object responseStreamConnectionFailed',
    { responseStreamConnectionFailed: { httpStatusCode: null } },
  ] as const,
  [
    'object responseStreamDisconnected',
    { responseStreamDisconnected: {} },
  ] as const,
  [
    'object responseTooManyFailedAttempts',
    { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
  ] as const,
  [
    'object activeTurnNotSteerable review',
    { activeTurnNotSteerable: { turnKind: 'review' } },
  ] as const,
  [
    'object activeTurnNotSteerable compact',
    { activeTurnNotSteerable: { turnKind: 'compact' } },
  ] as const,
];

describe('CodexAppServerProtocolClient', () => {
  it('opts out of and tolerates turn plan updates', async () => {
    const fixture = await activeTurn();
    const initialize = fixture.writes.find(
      (message) => message.method === 'initialize'
    );

    expect(initialize).toMatchObject({
      params: {
        capabilities: {
          optOutNotificationMethods: expect.arrayContaining([
            'turn/plan/updated',
          ]),
        },
      },
    });

    fixture.client.receive(
      notification('turn/plan/updated', {
        threadId,
        turnId,
        explanation: 'Inspect related access checks.',
        plan: [{ step: 'Read callers', status: 'inProgress' }],
      })
    );
    completeMessage(fixture.client, 'final', 'final_answer', '{"ok":true}');
    completeUsage(fixture.client);
    completeTurn(fixture.client);

    await expect(fixture.result).resolves.toMatchObject({
      finalMessage: '{"ok":true}',
    });
  });

  it('opts out of and tolerates a fenced thread name update', async () => {
    const fixture = await activeTurn();
    const initialize = fixture.writes.find(
      (message) => message.method === 'initialize'
    );

    expect(initialize).toMatchObject({
      params: {
        capabilities: {
          optOutNotificationMethods: expect.arrayContaining([
            'thread/name/updated',
          ]),
        },
      },
    });

    fixture.client.receive(
      notification('thread/name/updated', {
        threadId,
        threadName: 'Review access policy',
      })
    );
    completeMessage(fixture.client, 'final', 'final_answer', '{"ok":true}');
    completeUsage(fixture.client);
    completeTurn(fixture.client);

    await expect(fixture.result).resolves.toMatchObject({
      finalMessage: '{"ok":true}',
    });
  });

  it.each([
    ['an omitted name', { threadId }],
    ['a null name', { threadId, threadName: null }],
    [
      'a name at the UTF-8 byte limit',
      { threadId, threadName: 'é'.repeat(512) },
    ],
  ])(
    'tolerates a fenced thread name update with %s',
    async (_label, params) => {
      const fixture = await activeTurn();
      fixture.client.receive(notification('thread/name/updated', params));
      completeMessage(fixture.client, 'final', 'final_answer', '{"ok":true}');
      completeUsage(fixture.client);
      completeTurn(fixture.client);

      await expect(fixture.result).resolves.toMatchObject({
        finalMessage: '{"ok":true}',
      });
    }
  );

  it.each([
    [
      'a wrong thread fence',
      { threadId: 'wrong-thread', threadName: 'Review' },
    ],
    ['a missing thread fence', { threadName: 'Review' }],
    ['an empty name', { threadId, threadName: '' }],
    ['an oversized name', { threadId, threadName: 'x'.repeat(1_025) }],
    ['an oversized multibyte name', { threadId, threadName: 'é'.repeat(513) }],
    ['an extra field', { threadId, threadName: 'Review', extra: true }],
  ])('rejects a thread name update with %s', async (_label, params) => {
    const fixture = await activeTurn();
    fixture.client.receive(notification('thread/name/updated', params));

    await expect(fixture.result).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.StreamIncomplete,
      message: 'review_agent_stream_incomplete_thread_name_updated',
    });
  });

  it('opts out of and safely tolerates a fenced resolved server request', async () => {
    const fixture = await activeTurn();
    const initialize = fixture.writes.find(
      (message) => message.method === 'initialize'
    );

    expect(initialize).toMatchObject({
      params: {
        capabilities: {
          optOutNotificationMethods: expect.arrayContaining([
            'serverRequest/resolved',
          ]),
        },
      },
    });

    fixture.client.receive(
      notification('serverRequest/resolved', {
        requestId: 7,
        threadId,
      })
    );
    completeMessage(fixture.client, 'final', 'final_answer', '{"ok":true}');
    completeUsage(fixture.client);
    completeTurn(fixture.client);

    await expect(fixture.result).resolves.toMatchObject({
      finalMessage: '{"ok":true}',
    });
  });

  it('tolerates a fenced resolved server request before the turn starts', async () => {
    const fixture = await threadNotificationBeforeStartResponse();
    fixture.client.receive(
      notification('serverRequest/resolved', {
        requestId: 'request-before-turn',
        threadId,
      })
    );
    fixture.client.receive({ id: 2, result: threadStartResponse() });
    await waitForWrite(fixture.writes, 'turn/start');
    fixture.client.receive(
      notification('turn/started', {
        threadId,
        turn: turn('inProgress'),
      })
    );
    fixture.client.receive({ id: 3, result: { turn: turn('inProgress') } });
    completeMessage(fixture.client, 'final', 'final_answer', '{"ok":true}');
    completeUsage(fixture.client);
    completeTurn(fixture.client);

    await expect(fixture.result).resolves.toMatchObject({
      finalMessage: '{"ok":true}',
    });
  });

  it('tolerates a fenced resolved server request after turn completion', async () => {
    const fixture = await activeTurn();
    completeMessage(fixture.client, 'final', 'final_answer', '{"ok":true}');
    completeUsage(fixture.client);
    completeTurn(fixture.client);
    await expect(fixture.result).resolves.toBeDefined();

    fixture.client.receive(
      notification('serverRequest/resolved', {
        requestId: 'request-after-turn',
        threadId,
      })
    );

    expect(fixture.client.failureAfterCompletion()).toBeNull();
  });

  it.each([
    ['a wrong thread fence', { requestId: 7, threadId: 'wrong-thread' }],
    ['a missing request id', { threadId }],
    ['an invalid request id', { requestId: {}, threadId }],
    ['an extra field', { requestId: 'request-7', threadId, extra: true }],
  ])('rejects a resolved server request with %s', async (_label, params) => {
    const fixture = await activeTurn();
    fixture.client.receive(notification('serverRequest/resolved', params));

    await expect(fixture.result).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.StreamIncomplete,
      message: 'review_agent_stream_incomplete_server_request_resolved',
    });
  });

  it('uses the observed model and exact total without double-counting reasoning', async () => {
    const fixture = await activeTurn();
    fixture.client.receive({
      method: 'remoteControl/status/changed',
      params: { status: 'disabled' },
    });
    fixture.client.receive(
      notification('deprecationNotice', {
        summary: 'deprecated test setting',
        details: null,
      })
    );
    completeMessage(
      fixture.client,
      'agent-final',
      'final_answer',
      '{"ok":true}'
    );
    fixture.client.receive(
      notification('rawResponse/completed', {
        threadId,
        turnId,
        responseId: 'response-1',
        usage: usage(50, 5, 2),
      })
    );
    fixture.client.receive(
      notification('rawResponse/completed', {
        threadId,
        turnId,
        responseId: 'response-2',
        usage: usage(50, 5, 3),
      })
    );
    fixture.client.receive(
      notification('thread/tokenUsage/updated', {
        threadId,
        turnId,
        tokenUsage: {
          total: usage(100, 10, 5),
          last: usage(50, 5, 3),
          modelContextWindow: 200_000,
        },
      })
    );
    completeTurn(fixture.client);

    await expect(fixture.result).resolves.toEqual({
      finalMessage: '{"ok":true}',
      actualModel: 'openai.gpt-5.6-sol',
      modelProvider: 'openai',
      usage: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 10,
        reasoningOutputTokens: 5,
        totalTokens: 110,
      },
    });
  });

  it('accepts bounded 0.145.0 metadata notifications without changing the result', async () => {
    const fixture = await activeTurn();
    fixture.client.receive(
      notification('model/verification', {
        threadId,
        turnId,
        verifications: ['trustedAccessForCyber'],
      })
    );
    fixture.client.receive(
      notification('turn/moderationMetadata', {
        threadId,
        turnId,
        metadata: { presentation: 'inline', categories: ['cyber'] },
      })
    );
    fixture.client.receive(
      notification('model/safetyBuffering/updated', {
        threadId,
        turnId,
        model: 'gpt-5.6-sol',
        useCases: ['cyber'],
        reasons: ['user_risk'],
        showBufferingUi: true,
        fasterModel: 'gpt-5.6-mini',
      })
    );
    completeMessage(fixture.client, 'final', 'final_answer', '{"ok":true}');
    completeUsage(fixture.client);
    completeTurn(fixture.client);

    await expect(fixture.result).resolves.toEqual({
      finalMessage: '{"ok":true}',
      actualModel: 'openai.gpt-5.6-sol',
      modelProvider: 'openai',
      usage: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 10,
        reasoningOutputTokens: 5,
        totalTokens: 110,
      },
    });
  });

  it('accepts turn metadata after the turn response and before turn/started', async () => {
    const fixture = await turnResponseBeforeStartedNotification();
    fixture.client.receive(
      notification('model/verification', {
        threadId,
        turnId,
        verifications: ['trustedAccessForCyber'],
      })
    );
    fixture.client.receive(
      notification('turn/moderationMetadata', {
        threadId,
        turnId,
        metadata: { presentation: 'inline', categories: ['cyber'] },
      })
    );
    fixture.client.receive(
      notification('model/safetyBuffering/updated', {
        threadId,
        turnId,
        model: 'gpt-5.6-sol',
        useCases: ['cyber'],
        reasons: ['user_risk'],
        showBufferingUi: true,
        fasterModel: null,
      })
    );
    fixture.client.receive(
      notification('turn/started', {
        threadId,
        turn: turn('inProgress'),
      })
    );
    completeMessage(fixture.client, 'final', 'final_answer', '{"ok":true}');
    completeUsage(fixture.client);
    completeTurn(fixture.client);

    await expect(fixture.result).resolves.toMatchObject({
      finalMessage: '{"ok":true}',
    });
  });

  it.each([
    [
      'unknown verification',
      'model/verification',
      { threadId, turnId, verifications: ['futureVerification'] },
    ],
    [
      'non-JSON moderation metadata',
      'turn/moderationMetadata',
      { threadId, turnId, metadata: undefined },
    ],
    [
      'oversized moderation metadata',
      'turn/moderationMetadata',
      { threadId, turnId, metadata: 'x'.repeat(32_769) },
    ],
    [
      'control character in moderation metadata value',
      'turn/moderationMetadata',
      { threadId, turnId, metadata: { note: 'line\nbreak' } },
    ],
    [
      'control character in moderation metadata key',
      'turn/moderationMetadata',
      { threadId, turnId, metadata: { ['bad\nkey']: 'value' } },
    ],
    [
      'oversized safety buffering array',
      'model/safetyBuffering/updated',
      {
        threadId,
        turnId,
        model: 'gpt-5.6-sol',
        useCases: Array(65).fill('cyber'),
        reasons: [],
        showBufferingUi: false,
        fasterModel: null,
      },
    ],
    [
      'extra safety buffering field',
      'model/safetyBuffering/updated',
      {
        threadId,
        turnId,
        model: 'gpt-5.6-sol',
        useCases: [],
        reasons: [],
        showBufferingUi: false,
        fasterModel: null,
        unexpected: true,
      },
    ],
  ])(
    'rejects malformed metadata notification: %s',
    async (_label, method, params) => {
      const fixture = await activeTurn();
      fixture.client.receive(notification(method, params));

      await expect(fixture.result).rejects.toMatchObject({
        failureClass: ReviewAgentFailureClass.StreamIncomplete,
      });
    }
  );

  it.each([
    ['model/verification', { verifications: ['trustedAccessForCyber'] }],
    ['turn/moderationMetadata', { metadata: { presentation: 'inline' } }],
    [
      'model/safetyBuffering/updated',
      {
        model: 'gpt-5.6-sol',
        useCases: ['cyber'],
        reasons: ['user_risk'],
        showBufferingUi: true,
        fasterModel: null,
      },
    ],
  ])('rejects a wrong turn fence for %s', async (method, params) => {
    const fixture = await activeTurn();
    fixture.client.receive(
      notification(method, { ...params, threadId, turnId: 'wrong-turn' })
    );

    await expect(fixture.result).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.StreamIncomplete,
    });
  });

  it('rejects a wrong thread fence for metadata notifications', async () => {
    const fixture = await activeTurn();
    fixture.client.receive(
      notification('turn/moderationMetadata', {
        threadId: 'wrong-thread',
        turnId,
        metadata: { presentation: 'inline' },
      })
    );

    await expect(fixture.result).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.StreamIncomplete,
    });
  });

  it.each([
    ['model/futureMetadata', '5be8702e6e78'],
    ['guardianWarning', '2eebd1810129'],
    ['item/commandExecution/outputDelta', '8fbb8a5a4928'],
  ])(
    'continues to reject unknown notification method %s',
    async (method, digest) => {
      const fixture = await activeTurn();
      fixture.client.receive(notification(method, { threadId, turnId }));

      await expect(fixture.result).rejects.toMatchObject({
        failureClass: ReviewAgentFailureClass.StreamIncomplete,
        message: `review_agent_stream_incomplete_unknown_notification_${digest}`,
      });
    }
  );

  it('keeps unknown notification diagnostics independent of payloads', async () => {
    const first = await activeTurn();
    const second = await activeTurn();
    const method = 'model/futureMetadata';

    first.client.receive(
      notification(method, {
        threadId,
        turnId,
        secret: 'first-sensitive-value',
      })
    );
    second.client.receive(
      notification(method, {
        threadId,
        turnId,
        nested: { secret: 'second-sensitive-value' },
      })
    );

    const [firstFailure, secondFailure] = await Promise.all([
      first.result.catch((error: unknown) => error),
      second.result.catch((error: unknown) => error),
    ]);
    if (!(firstFailure instanceof Error) || !(secondFailure instanceof Error)) {
      throw new Error('expected both protocol calls to fail');
    }

    expect(firstFailure.message).toBe(secondFailure.message);
    expect(firstFailure.message).toBe(
      'review_agent_stream_incomplete_unknown_notification_5be8702e6e78'
    );
    expect(firstFailure.message).not.toContain('sensitive');
  });

  it('fails closed on a malformed notification method', async () => {
    const fixture = await activeTurn();
    fixture.client.receive({
      method: 42,
      params: { threadId },
      emittedAtMs: 1,
    });

    await expect(fixture.result).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.StreamIncomplete,
      message: 'review_agent_stream_incomplete_unknown_notification',
    });
  });

  it('prefers one explicit final answer over a phase-null compatibility message', async () => {
    const fixture = await activeTurn();
    completeMessage(fixture.client, 'compat', null, '{"compat":true}');
    completeMessage(fixture.client, 'final', 'final_answer', '{"final":true}');
    completeUsage(fixture.client);
    completeTurn(fixture.client);

    await expect(fixture.result).resolves.toMatchObject({
      finalMessage: '{"final":true}',
    });
  });

  it('fails closed on model rerouting', async () => {
    const fixture = await activeTurn();
    fixture.client.receive(
      notification('model/rerouted', {
        threadId,
        turnId,
        fromModel: 'openai.gpt-5.6-sol',
        toModel: 'openai.gpt-5.6-mini',
        reason: 'model_not_found',
      })
    );

    await expect(fixture.result).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.ModelAttributionMissing,
    });
  });

  it('continues after a retryable app-server error and accepts a successful turn', async () => {
    const fixture = await activeTurn();
    fixture.client.receive(
      notification('error', {
        threadId,
        turnId,
        willRetry: true,
        error: turnError('temporary upstream disconnect', {
          responseStreamDisconnected: { httpStatusCode: null },
        }),
      })
    );
    completeMessage(fixture.client, 'final', 'final_answer', '{"ok":true}');
    completeUsage(fixture.client);
    completeTurn(fixture.client);

    await expect(fixture.result).resolves.toMatchObject({
      finalMessage: '{"ok":true}',
    });
  });

  it('accepts a fenced transport warning after a retryable error', async () => {
    const fixture = await activeTurn();
    fixture.client.receive(
      notification('error', {
        threadId,
        turnId,
        willRetry: true,
        error: turnError('temporary websocket disconnect', {
          responseStreamDisconnected: { httpStatusCode: null },
        }),
      })
    );
    fixture.client.receive(
      notification('warning', {
        threadId,
        message: 'WebSocket unavailable; continuing over HTTPS.',
      })
    );
    completeMessage(fixture.client, 'final', 'final_answer', '{"ok":true}');
    completeUsage(fixture.client);
    completeTurn(fixture.client);

    await expect(fixture.result).resolves.toMatchObject({
      finalMessage: '{"ok":true}',
    });
  });

  it('accepts a thread warning before the turn request is sent', async () => {
    const fixture = await threadNotificationBeforeStartResponse();
    fixture.client.receive(
      notification('warning', {
        threadId,
        message: 'WebSocket unavailable; continuing over HTTPS.',
      })
    );
    fixture.client.receive({ id: 2, result: threadStartResponse() });
    await waitForWrite(fixture.writes, 'turn/start');
    fixture.client.receive(
      notification('turn/started', {
        threadId,
        turn: turn('inProgress'),
      })
    );
    fixture.client.receive({ id: 3, result: { turn: turn('inProgress') } });
    completeMessage(fixture.client, 'final', 'final_answer', '{"ok":true}');
    completeUsage(fixture.client);
    completeTurn(fixture.client);

    await expect(fixture.result).resolves.toMatchObject({
      finalMessage: '{"ok":true}',
    });
  });

  it('accepts a warning and metadata after the turn response but before turn/started', async () => {
    const fixture = await turnResponseBeforeStartedNotification();
    fixture.client.receive(
      notification('warning', {
        threadId,
        message: 'WebSocket unavailable; continuing over HTTPS.',
      })
    );
    fixture.client.receive(
      notification('turn/moderationMetadata', {
        threadId,
        turnId,
        metadata: { presentation: 'inline', categories: ['cyber'] },
      })
    );
    fixture.client.receive(
      notification('turn/started', {
        threadId,
        turn: turn('inProgress'),
      })
    );
    completeMessage(fixture.client, 'final', 'final_answer', '{"ok":true}');
    completeUsage(fixture.client);
    completeTurn(fixture.client);

    await expect(fixture.result).resolves.toMatchObject({
      finalMessage: '{"ok":true}',
    });
  });

  it('ignores a valid thread warning after a completed turn', async () => {
    const fixture = await activeTurn();
    completeMessage(fixture.client, 'final', 'final_answer', '{"ok":true}');
    completeUsage(fixture.client);
    completeTurn(fixture.client);
    await expect(fixture.result).resolves.toBeDefined();

    fixture.client.receive(
      notification('warning', {
        threadId,
        message: 'WebSocket unavailable; continuing over HTTPS.',
      })
    );

    expect(fixture.client.failureAfterCompletion()).toBeNull();
  });

  it.each([
    ['a wrong thread fence', { threadId: 'thread-other', message: 'fallback' }],
    [
      'an extra field',
      { threadId, message: 'fallback', diagnostic: 'not-retained' },
    ],
    ['an empty message', { threadId, message: '' }],
    ['a control character', { threadId, message: 'fallback\ncontinued' }],
    ['an oversized message', { threadId, message: 'x'.repeat(16_385) }],
  ])('rejects a warning with %s', async (_label, params) => {
    const fixture = await activeTurn();
    fixture.client.receive(notification('warning', params));

    await expect(fixture.result).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.StreamIncomplete,
      message: 'review_agent_stream_incomplete_warning',
    });
  });

  it.each([
    ['nullable', { threadId: null }],
    ['omitted', {}],
  ])(
    'accepts an unfenced global warning with a %s thread before identity is known',
    async (_name, warningFence) => {
      const writes: Array<Record<string, unknown>> = [];
      const client = new CodexAppServerProtocolClient(
        protocolRequest(),
        async (message) => {
          writes.push({ ...message });
        }
      );
      const result = client.run();
      await waitForWrite(writes, 'initialize');
      client.receive({
        id: 1,
        result: {
          userAgent: `Codex Desktop/${CODEX_APP_SERVER_VERSION} test`,
          codexHome: '/tmp/codex-home',
          platformFamily: 'unix',
          platformOs: 'linux',
        },
      });
      await waitForWrite(writes, 'thread/start');
      client.receive(
        notification('warning', {
          message: 'WebSocket unavailable; continuing over HTTPS.',
          ...warningFence,
        })
      );
      client.receive(notification('thread/started', { thread: thread() }));
      client.receive({ id: 2, result: threadStartResponse() });
      await waitForWrite(writes, 'turn/start');
      client.receive(
        notification('turn/started', {
          threadId,
          turn: turn('inProgress'),
        })
      );
      client.receive({ id: 3, result: { turn: turn('inProgress') } });
      completeMessage(client, 'final', 'final_answer', '{"ok":true}');
      completeUsage(client);
      completeTurn(client);

      await expect(result).resolves.toMatchObject({
        finalMessage: '{"ok":true}',
      });
    }
  );

  it('rejects a warning before the thread identity is known', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const client = new CodexAppServerProtocolClient(
      protocolRequest(),
      async (message) => {
        writes.push({ ...message });
      }
    );
    const result = client.run();
    await waitForWrite(writes, 'initialize');
    client.receive({
      id: 1,
      result: {
        userAgent: `Codex Desktop/${CODEX_APP_SERVER_VERSION} test`,
        codexHome: '/tmp/codex-home',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    });
    await waitForWrite(writes, 'thread/start');

    client.receive(
      notification('warning', {
        threadId,
        message: 'WebSocket unavailable; continuing over HTTPS.',
      })
    );

    await expect(result).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.StreamIncomplete,
    });
  });

  it('preserves a terminal app-server error instead of reporting an incomplete stream', async () => {
    const fixture = await activeTurn();
    const error = turnError('provider overloaded', 'serverOverloaded');
    fixture.client.receive(
      notification('error', {
        threadId,
        turnId,
        willRetry: false,
        error,
      })
    );
    fixture.client.receive(
      notification('turn/completed', {
        threadId,
        turn: { id: turnId, status: 'failed', error, items: [] },
      })
    );

    await expect(fixture.result).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.CapacityUnavailable,
      message: 'review_agent_capacity_unavailable',
    });
  });

  it('accepts an empty schema-valid message when Codex supplies error classification', async () => {
    const fixture = await activeTurn();
    const error = turnError('', 'serverOverloaded');
    fixture.client.receive(
      notification('error', {
        threadId,
        turnId,
        willRetry: false,
        error,
      })
    );
    fixture.client.receive(
      notification('turn/completed', {
        threadId,
        turn: { id: turnId, status: 'failed', error, items: [] },
      })
    );

    await expect(fixture.result).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.CapacityUnavailable,
      message: 'review_agent_capacity_unavailable',
    });
  });

  it.each(supportedCodexErrorInfo)(
    'accepts pinned Codex v0.145 codexErrorInfo variant: %s',
    async (_label, codexErrorInfo) => {
      const fixture = await activeTurn();
      fixture.client.receive(
        notification('error', {
          threadId,
          turnId,
          willRetry: true,
          error: turnError('', codexErrorInfo),
        })
      );
      completeMessage(fixture.client, 'final', 'final_answer', '{"ok":true}');
      completeUsage(fixture.client);
      completeTurn(fixture.client);

      await expect(fixture.result).resolves.toMatchObject({
        finalMessage: '{"ok":true}',
      });
    }
  );

  it.each([
    ['unknown tag', { futureFailure: {} }],
    [
      'multiple tags',
      { httpConnectionFailed: {}, responseStreamDisconnected: {} },
    ],
    [
      'out-of-range HTTP status',
      { httpConnectionFailed: { httpStatusCode: 65_536 } },
    ],
    [
      'unknown active turn kind',
      { activeTurnNotSteerable: { turnKind: 'shell' } },
    ],
  ])(
    'fails closed on malformed codexErrorInfo object: %s',
    async (_label, codexErrorInfo) => {
      const fixture = await activeTurn();
      fixture.client.receive(
        notification('error', {
          threadId,
          turnId,
          willRetry: true,
          error: turnError('', codexErrorInfo),
        })
      );

      await expect(fixture.result).rejects.toMatchObject({
        failureClass: ReviewAgentFailureClass.StreamIncomplete,
      });
    }
  );

  it('maps an interrupted terminal turn to cancellation', async () => {
    const fixture = await activeTurn();
    fixture.client.receive(
      notification('turn/completed', {
        threadId,
        turn: { id: turnId, status: 'interrupted', error: null, items: [] },
      })
    );

    await expect(fixture.result).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.Cancelled,
    });
  });

  it('fails closed on malformed or unpaired app-server terminal errors', async () => {
    const malformed = await activeTurn();
    malformed.client.receive(
      notification('error', {
        threadId,
        turnId,
        error: turnError('missing retry flag', null),
      })
    );
    await expect(malformed.result).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.StreamIncomplete,
    });

    const emptyUnclassified = await activeTurn();
    emptyUnclassified.client.receive(
      notification('error', {
        threadId,
        turnId,
        willRetry: false,
        error: turnError('', null),
      })
    );
    await expect(emptyUnclassified.result).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.StreamIncomplete,
    });

    const unpaired = await activeTurn();
    unpaired.client.receive(
      notification('turn/completed', {
        threadId,
        turn: {
          id: turnId,
          status: 'failed',
          error: turnError('provider overloaded', 'serverOverloaded'),
          items: [],
        },
      })
    );
    await expect(unpaired.result).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.StreamIncomplete,
    });
  });

  it('normalizes optional turn-error fields', async () => {
    const fixture = await activeTurn();
    fixture.client.receive(
      notification('error', {
        threadId,
        turnId,
        willRetry: false,
        error: { message: 'not logged in' },
      })
    );
    fixture.client.receive(
      notification('turn/completed', {
        threadId,
        turn: {
          id: turnId,
          status: 'failed',
          error: {
            message: 'not logged in',
            additionalDetails: null,
            codexErrorInfo: null,
          },
          items: [],
        },
      })
    );

    await expect(fixture.result).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.AuthenticationUnavailable,
      message: 'review_agent_authentication_unavailable',
    });
  });

  it('accepts a populated terminal snapshot containing an observed allowed item', async () => {
    const fixture = await activeTurn();
    const item = agentMessageItem('final', 'final_answer', '{"ok":true}');
    completeMessage(fixture.client, item.id, item.phase, item.text);
    completeUsage(fixture.client);
    completeTurn(fixture.client, [item]);

    await expect(fixture.result).resolves.toMatchObject({
      finalMessage: '{"ok":true}',
    });
  });

  it.each([
    [
      'unseen allowed item',
      [agentMessageItem('unseen', 'final_answer', '{"ok":true}')],
    ],
    ['forbidden item', [{ id: 'native-command', type: 'commandExecution' }]],
  ])('fails terminal snapshot confinement for %s', async (_label, items) => {
    const fixture = await activeTurn();
    fixture.client.receive(
      notification('turn/completed', {
        threadId,
        turn: { id: turnId, status: 'completed', error: null, items },
      })
    );

    await expect(fixture.result).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.StreamIncomplete,
    });
  });

  it('fails closed when a terminal snapshot repeats an observed item id', async () => {
    const fixture = await activeTurn();
    const item = agentMessageItem('final', 'final_answer', '{"ok":true}');
    completeMessage(fixture.client, item.id, item.phase, item.text);
    fixture.client.receive(
      notification('turn/completed', {
        threadId,
        turn: {
          id: turnId,
          status: 'completed',
          error: null,
          items: [item, item],
        },
      })
    );

    await expect(fixture.result).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.StreamIncomplete,
    });
  });

  it('fails closed on server-initiated requests and native command execution', async () => {
    const requestFixture = await activeTurn();
    requestFixture.client.receive({
      id: 99,
      method: 'item/commandExecution/requestApproval',
      params: {},
    });
    await expect(requestFixture.result).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.ConfinementViolation,
    });

    const itemFixture = await activeTurn();
    itemFixture.client.receive(
      notification('item/started', {
        threadId,
        turnId,
        startedAtMs: 1,
        item: {
          type: 'commandExecution',
          id: 'native-command',
        },
      })
    );
    await expect(itemFixture.result).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.ConfinementViolation,
    });
  });

  it('rejects duplicate raw response ids and aggregate usage drift', async () => {
    const duplicate = await activeTurn();
    duplicate.client.receive(
      notification('rawResponse/completed', {
        threadId,
        turnId,
        responseId: 'response-1',
        usage: usage(100, 10, 5),
      })
    );
    duplicate.client.receive(
      notification('rawResponse/completed', {
        threadId,
        turnId,
        responseId: 'response-1',
        usage: usage(100, 10, 5),
      })
    );
    await expect(duplicate.result).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.UsageAttributionMissing,
    });

    const drift = await activeTurn();
    completeMessage(drift.client, 'final', 'final_answer', '{"ok":true}');
    drift.client.receive(
      notification('rawResponse/completed', {
        threadId,
        turnId,
        responseId: 'response-1',
        usage: usage(100, 10, 5),
      })
    );
    drift.client.receive(
      notification('thread/tokenUsage/updated', {
        threadId,
        turnId,
        tokenUsage: {
          total: usage(101, 10, 5),
          last: usage(101, 10, 5),
          modelContextWindow: null,
        },
      })
    );
    completeTurn(drift.client);
    await expect(drift.result).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.UsageAttributionMissing,
    });
  });

  it('rejects ambiguous final answers', async () => {
    const fixture = await activeTurn();
    completeMessage(fixture.client, 'final-1', 'final_answer', '{"one":true}');
    completeMessage(fixture.client, 'final-2', 'final_answer', '{"two":true}');
    completeUsage(fixture.client);
    completeTurn(fixture.client);

    await expect(fixture.result).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.SchemaInvalidOutput,
    });
  });

  it('records a fail-closed violation that arrives after turn completion', async () => {
    const fixture = await activeTurn();
    completeMessage(fixture.client, 'final', 'final_answer', '{"ok":true}');
    completeUsage(fixture.client);
    completeTurn(fixture.client);
    await expect(fixture.result).resolves.toBeDefined();

    fixture.client.receive(
      notification('item/started', {
        threadId,
        turnId,
        startedAtMs: 3,
        item: { type: 'commandExecution', id: 'late-command' },
      })
    );

    expect(fixture.client.failureAfterCompletion()).toMatchObject({
      failureClass: ReviewAgentFailureClass.StreamIncomplete,
    });
  });
});

async function activeTurn() {
  const writes: Array<Record<string, unknown>> = [];
  const client = new CodexAppServerProtocolClient(
    protocolRequest(),
    async (message) => {
      writes.push({ ...message });
    }
  );
  const result = client.run();
  await waitForWrite(writes, 'initialize');
  client.receive({
    id: 1,
    result: {
      userAgent: `Codex Desktop/${CODEX_APP_SERVER_VERSION} test`,
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'linux',
    },
  });
  await waitForWrite(writes, 'thread/start');
  client.receive(notification('thread/started', { thread: thread() }));
  client.receive({ id: 2, result: threadStartResponse() });
  await waitForWrite(writes, 'turn/start');
  client.receive(
    notification('turn/started', {
      threadId,
      turn: turn('inProgress'),
    })
  );
  client.receive({ id: 3, result: { turn: turn('inProgress') } });
  await Promise.resolve();
  return { client, result, writes };
}

async function turnResponseBeforeStartedNotification() {
  const writes: Array<Record<string, unknown>> = [];
  const client = new CodexAppServerProtocolClient(
    protocolRequest(),
    async (message) => {
      writes.push({ ...message });
    }
  );
  const result = client.run();
  await waitForWrite(writes, 'initialize');
  client.receive({
    id: 1,
    result: {
      userAgent: `Codex Desktop/${CODEX_APP_SERVER_VERSION} test`,
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'linux',
    },
  });
  await waitForWrite(writes, 'thread/start');
  client.receive(notification('thread/started', { thread: thread() }));
  client.receive({ id: 2, result: threadStartResponse() });
  await waitForWrite(writes, 'turn/start');
  client.receive({ id: 3, result: { turn: turn('inProgress') } });
  await Promise.resolve();
  return { client, result, writes };
}

async function threadNotificationBeforeStartResponse() {
  const writes: Array<Record<string, unknown>> = [];
  const client = new CodexAppServerProtocolClient(
    protocolRequest(),
    async (message) => {
      writes.push({ ...message });
    }
  );
  const result = client.run();
  await waitForWrite(writes, 'initialize');
  client.receive({
    id: 1,
    result: {
      userAgent: `Codex Desktop/${CODEX_APP_SERVER_VERSION} test`,
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'linux',
    },
  });
  await waitForWrite(writes, 'thread/start');
  client.receive(notification('thread/started', { thread: thread() }));
  await Promise.resolve();
  return { client, result, writes };
}

function protocolRequest(): CodexAppServerProtocolRequest {
  return {
    cwd: '/tmp/review-workspace',
    prompt: 'Review through the gateway.',
    clientTurnId: 'client-turn-1',
    requestedModel: 'gpt-5.6-sol',
    reasoningEffort: 'xhigh',
    outputSchema: { type: 'object' },
    allowedTools: ['review_read_file'],
    maxOutputBytes: 1_000_000,
  };
}

function threadStartResponse() {
  return {
    thread: thread(),
    model: 'openai.gpt-5.6-sol',
    modelProvider: 'openai',
    serviceTier: null,
    cwd: '/tmp/review-workspace',
    instructionSources: [],
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'readOnly', networkAccess: false },
    reasoningEffort: 'xhigh',
  };
}

function thread() {
  return {
    id: threadId,
    ephemeral: true,
    modelProvider: 'openai',
    path: null,
    cwd: '/tmp/review-workspace',
    cliVersion: CODEX_APP_SERVER_VERSION,
    turns: [],
  };
}

function turn(status: 'inProgress' | 'completed') {
  return { id: turnId, status, error: null, items: [] };
}

function turnError(
  message: string,
  codexErrorInfo: string | Readonly<Record<string, unknown>> | null
) {
  return { message, codexErrorInfo, additionalDetails: null };
}

function notification(method: string, params: Record<string, unknown>) {
  return { method, params, emittedAtMs: 1 };
}

function completeMessage(
  client: CodexAppServerProtocolClient,
  id: string,
  phase: 'final_answer' | null,
  text: string
) {
  const item = agentMessageItem(id, phase, text);
  client.receive(
    notification('item/started', {
      threadId,
      turnId,
      startedAtMs: 1,
      item,
    })
  );
  client.receive(
    notification('item/completed', {
      threadId,
      turnId,
      completedAtMs: 2,
      item,
    })
  );
}

function completeUsage(client: CodexAppServerProtocolClient) {
  client.receive(
    notification('rawResponse/completed', {
      threadId,
      turnId,
      responseId: 'response-1',
      usage: usage(100, 10, 5),
    })
  );
  client.receive(
    notification('thread/tokenUsage/updated', {
      threadId,
      turnId,
      tokenUsage: {
        total: usage(100, 10, 5),
        last: usage(100, 10, 5),
        modelContextWindow: null,
      },
    })
  );
}

function completeTurn(
  client: CodexAppServerProtocolClient,
  items: readonly unknown[] = []
) {
  client.receive(
    notification('turn/completed', {
      threadId,
      turn: { ...turn('completed'), items },
    })
  );
}

function agentMessageItem(
  id: string,
  phase: 'final_answer' | null,
  text: string
) {
  return { type: 'agentMessage', id, text, phase, memoryCitation: null };
}

function usage(inputTokens: number, outputTokens: number, reasoning: number) {
  return {
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens: Math.floor(inputTokens / 5),
    cacheWriteInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: reasoning,
  };
}

async function waitForWrite(
  writes: readonly Record<string, unknown>[],
  method: string
): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (writes.some((write) => write.method === method)) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`test_protocol_write_missing:${method}`);
}
