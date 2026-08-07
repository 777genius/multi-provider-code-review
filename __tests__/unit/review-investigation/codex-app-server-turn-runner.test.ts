import { mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  ReviewAgentExecutionError,
  ReviewAgentFailureClass,
} from '../../../src/review-investigation/application/review-agent-port';
import {
  NodeCodexAppServerTurnRunner,
  type CodexAppServerTurnRequest,
} from '../../../src/review-investigation/infrastructure/codex-app-server-turn-runner';

describe('NodeCodexAppServerTurnRunner', () => {
  it('frames fragmented JSONL and completes a version-probed ephemeral turn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rr-app-server-test-'));
    const server = path.join(root, 'fake-app-server.cjs');
    await writeFile(server, fakeAppServer(), 'utf8');
    const versionProbe = { assertSupported: jest.fn(async () => undefined) };
    const runner = new NodeCodexAppServerTurnRunner({ versionProbe });

    await expect(
      runner.executeTurn(request(root, server))
    ).resolves.toMatchObject({
      actualModel: 'openai.gpt-5.6-sol',
      modelProvider: 'openai',
      finalMessage: '{"outputVersion":2}',
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        reasoningOutputTokens: 5,
        totalTokens: 110,
      },
    });
    expect(versionProbe.assertSupported).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('rejects malformed stdout as an incomplete stream', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rr-app-server-test-'));
    const server = path.join(root, 'malformed-app-server.cjs');
    await writeFile(
      server,
      "process.stdin.once('data',()=>{process.stdout.write('{not-json}\\n');});setTimeout(()=>{},10000);",
      'utf8'
    );
    const runner = new NodeCodexAppServerTurnRunner({
      versionProbe: { assertSupported: async () => undefined },
    });

    await expect(
      runner.executeTurn(request(root, server))
    ).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.StreamIncomplete,
    });
  }, 15_000);

  it('keeps the child alive across a retryable app-server error notification', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rr-app-server-test-'));
    const server = path.join(root, 'retrying-app-server.cjs');
    await writeFile(
      server,
      fakeAppServer(
        '',
        `notify('error', {
          threadId, turnId, willRetry: true,
          error: {
            message: 'temporary disconnect',
            codexErrorInfo: {
              responseStreamDisconnected: { httpStatusCode: null },
            },
            additionalDetails: null,
          },
        });`
      ),
      'utf8'
    );
    const runner = new NodeCodexAppServerTurnRunner({
      versionProbe: { assertSupported: async () => undefined },
    });

    await expect(
      runner.executeTurn(request(root, server))
    ).resolves.toMatchObject({ finalMessage: '{"outputVersion":2}' });
  }, 15_000);

  it('classifies an official terminal error notification paired with a failed turn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rr-app-server-test-'));
    const server = path.join(root, 'terminal-error-app-server.cjs');
    await writeFile(
      server,
      fakeAppServer(
        '',
        `const terminalError = {
          message: '',
          codexErrorInfo: 'serverOverloaded',
          additionalDetails: null,
        };
        notify('error', {
          threadId, turnId, willRetry: false, error: terminalError,
        });
        notify('turn/completed', {
          threadId,
          turn: {
            id: turnId,
            status: 'failed',
            error: terminalError,
            items: [],
          },
        });
        return;`
      ),
      'utf8'
    );
    const runner = new NodeCodexAppServerTurnRunner({
      versionProbe: { assertSupported: async () => undefined },
    });

    await expect(
      runner.executeTurn(request(root, server))
    ).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.CapacityUnavailable,
      message: 'review_agent_capacity_unavailable',
    });
  }, 15_000);

  it('cancels during the version probe without launching app-server', async () => {
    let probeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    const versionProbe = {
      assertSupported: jest.fn(
        (input: { readonly signal?: AbortSignal }) =>
          new Promise<void>((_resolve, reject) => {
            probeStarted();
            input.signal?.addEventListener(
              'abort',
              () =>
                reject(
                  new ReviewAgentExecutionError(
                    ReviewAgentFailureClass.Cancelled,
                    null,
                    'review_agent_process_cancelled'
                  )
                ),
              { once: true }
            );
          })
      ),
    };
    const runner = new NodeCodexAppServerTurnRunner({ versionProbe });
    const execution = runner.executeTurn(
      request('/tmp', '/does/not/launch-after-cancel')
    );
    await started;

    await runner.cancel('invocation-1', 'fence-1');
    await expect(execution).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.Cancelled,
    });
    expect(versionProbe.assertSupported).toHaveBeenCalledTimes(1);
  });

  it('rejects a confinement violation emitted after turn completion', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rr-app-server-test-'));
    const server = path.join(root, 'fake-app-server.cjs');
    await writeFile(
      server,
      fakeAppServer(`notify('item/started', {
        threadId, turnId, startedAtMs: 3,
        item: { type: 'commandExecution', id: 'late-command' },
      });
      rl.removeAllListeners('close');
      setInterval(() => undefined, 1_000);`),
      'utf8'
    );
    const runner = new NodeCodexAppServerTurnRunner({
      versionProbe: { assertSupported: async () => undefined },
    });

    const startedAt = Date.now();
    await expect(
      runner.executeTurn({ ...request(root, server), timeoutMs: 5_000 })
    ).rejects.toMatchObject({
      failureClass: ReviewAgentFailureClass.StreamIncomplete,
    });
    expect(Date.now() - startedAt).toBeLessThan(2_500);
  }, 15_000);
});

function request(root: string, script: string): CodexAppServerTurnRequest {
  return {
    invocationId: 'invocation-1',
    fencingToken: 'fence-1',
    binary: process.execPath,
    args: [script],
    cwd: root,
    environment: { PATH: process.env.PATH ?? '', RR_TEST_CWD: root },
    timeoutMs: 10_000,
    maxOutputBytes: 1_000_000,
    protocol: {
      cwd: root,
      prompt: 'Review through the gateway.',
      clientTurnId: 'client-turn-1',
      requestedModel: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
      outputSchema: { type: 'object' },
      allowedTools: ['review_read_file'],
      maxOutputBytes: 100_000,
    },
  };
}

function fakeAppServer(trailingEvent = '', beforeCompletionEvent = ''): string {
  return String.raw`
const readline = require('readline');
const cwd = process.env.RR_TEST_CWD;
const threadId = 'thread-1';
const turnId = 'turn-1';
const notify = (method, params) => send({ method, params, emittedAtMs: 1 });
let output = Promise.resolve();
const send = (value) => {
  const line = JSON.stringify(value) + '\n';
  const split = Math.max(1, Math.floor(line.length / 2));
  output = output.then(() => new Promise((resolve) => {
    process.stdout.write(line.slice(0, split), () => {
      setTimeout(() => process.stdout.write(line.slice(split), resolve), 1);
    });
  }));
};
const thread = () => ({
  id: threadId,
  ephemeral: true,
  modelProvider: 'openai',
  path: null,
  cwd,
  cliVersion: '0.145.0',
  turns: [],
});
const turn = (status) => ({ id: turnId, status, error: null, items: [] });
const usage = {
  totalTokens: 110,
  inputTokens: 100,
  cachedInputTokens: 20,
  cacheWriteInputTokens: 0,
  outputTokens: 10,
  reasoningOutputTokens: 5,
};
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: {
      userAgent: 'Codex Desktop/0.145.0 fake',
      codexHome: cwd,
      platformFamily: 'unix',
      platformOs: 'linux',
    }});
    notify('remoteControl/status/changed', { status: 'disabled' });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'thread/start') {
    send({ id: message.id, result: {
      thread: thread(),
      model: 'openai.gpt-5.6-sol',
      modelProvider: 'openai',
      serviceTier: null,
      cwd,
      instructionSources: [],
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: { type: 'readOnly', networkAccess: false },
      reasoningEffort: 'xhigh',
    }});
    notify('thread/started', { thread: thread() });
    return;
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: turn('inProgress') }});
    notify('turn/started', { threadId, turn: turn('inProgress') });
    notify('model/verification', {
      threadId, turnId, verifications: ['trustedAccessForCyber'],
    });
    notify('turn/moderationMetadata', {
      threadId, turnId, metadata: { presentation: 'inline' },
    });
    notify('model/safetyBuffering/updated', {
      threadId, turnId, model: 'gpt-5.6-sol',
      useCases: ['cyber'], reasons: ['user_risk'],
      showBufferingUi: true, fasterModel: null,
    });
    ${beforeCompletionEvent}
    const item = {
      type: 'agentMessage',
      id: 'final-1',
      text: '{"outputVersion":2}',
      phase: 'final_answer',
      memoryCitation: null,
    };
    notify('item/started', { threadId, turnId, startedAtMs: 1, item });
    notify('item/completed', { threadId, turnId, completedAtMs: 2, item });
    notify('rawResponse/completed', {
      threadId, turnId, responseId: 'response-1', usage,
    });
    notify('thread/tokenUsage/updated', {
      threadId, turnId,
      tokenUsage: { total: usage, last: usage, modelContextWindow: 200000 },
    });
    notify('turn/completed', { threadId, turn: turn('completed') });
    ${trailingEvent}
  }
});
rl.on('close', () => process.exit(0));
`;
}
