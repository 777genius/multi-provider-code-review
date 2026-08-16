import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

const actionBundle = jest.requireActual('../../../action-dist/index.cjs') as {
  runCodexRotatingGitHubAction(runtime: {
    env: NodeJS.ProcessEnv;
    io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
    fetchImpl: typeof fetch;
  }): Promise<void>;
};

describe('repository-owned action OIDC requests', () => {
  let fixtureDirectory: string;
  let eventPath: string;

  beforeEach(() => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), 'reviewrouter-oidc-test-'));
    eventPath = join(fixtureDirectory, 'event.json');
    writeFileSync(
      eventPath,
      JSON.stringify({
        number: 17,
        repository: { id: 123, full_name: 'owner/repository' },
        pull_request: {
          draft: false,
          additions: 1,
          deletions: 0,
          head: {
            sha: 'a'.repeat(40),
            repo: { full_name: 'owner/repository' },
          },
          base: { sha: 'b'.repeat(40) },
        },
      })
    );
  });

  afterEach(() => {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  });

  it('rejects an untrusted request URL without sending the OIDC bearer', async () => {
    const env = actionEnv('https://attacker.example/oidc');
    const fetchImpl = jest.fn<
      Promise<Response>,
      [RequestInfo | URL, RequestInit?]
    >() as jest.MockedFunction<typeof fetch>;

    await expect(
      actionBundle.runCodexRotatingGitHubAction({
        env,
        io: quietIo(),
        fetchImpl,
      })
    ).rejects.toThrow('github_oidc_url_untrusted');

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
    expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
  });

  it('uses redirect error mode so a redirect cannot receive the OIDC bearer', async () => {
    const env = actionEnv(
      'https://token.actions.githubusercontent.com/request?existing=value'
    );
    let leakedAuthorization = false;
    const fetchImpl = jest.fn(
      async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (
          new URL(String(url)).hostname.endsWith(
            '.actions.githubusercontent.com'
          )
        ) {
          if (init?.redirect !== 'error') {
            leakedAuthorization = Boolean(
              (init?.headers as Record<string, string> | undefined)
                ?.authorization
            );
            return jsonResponse({ value: 'attacker-controlled-token' });
          }
          return jsonResponse({ value: 'must-not-be-followed' }, 302);
        }
        throw new Error('unexpected_non_oidc_request');
      }
    ) as jest.MockedFunction<typeof fetch>;

    await expect(
      actionBundle.runCodexRotatingGitHubAction({
        env,
        io: quietIo(),
        fetchImpl,
      })
    ).rejects.toThrow('github_oidc_request_failed');

    expect(leakedAuthorization).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      'existing=value&audience=reviewrouter'
    );
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
    expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
  });

  function actionEnv(requestUrl: string): NodeJS.ProcessEnv {
    return {
      INPUT_API_URL: 'https://api.reviewrouter.example',
      INPUT_PROVIDER_INSTANCE_ID: 'provider-1',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: 'owner/repository',
      ACTIONS_ID_TOKEN_REQUEST_URL: requestUrl,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'github-request-token',
    };
  }
});

function quietIo(): {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
} {
  return { stdout: new PassThrough(), stderr: new PassThrough() };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}
