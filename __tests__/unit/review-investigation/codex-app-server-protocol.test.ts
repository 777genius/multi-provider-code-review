import { ReviewAgentFailureClass } from '../../../src/review-investigation/application/review-agent-port';
import {
  CODEX_APP_SERVER_VERSION,
  CodexAppServerProtocolClient,
  type CodexAppServerProtocolRequest,
} from '../../../src/review-investigation/infrastructure/codex-app-server-protocol';

const threadId = '019fd00f-9954-7320-a8c3-c17458ec2e2d';
const turnId = 'turn-1';

describe('CodexAppServerProtocolClient', () => {
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

function notification(method: string, params: Record<string, unknown>) {
  return { method, params, emittedAtMs: 1 };
}

function completeMessage(
  client: CodexAppServerProtocolClient,
  id: string,
  phase: 'final_answer' | null,
  text: string
) {
  const item = { type: 'agentMessage', id, text, phase, memoryCitation: null };
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

function completeTurn(client: CodexAppServerProtocolClient) {
  client.receive(
    notification('turn/completed', {
      threadId,
      turn: turn('completed'),
    })
  );
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
