import { spawn } from 'child_process';

export enum ReviewAgentProcessTermination {
  Exited = 'exited',
  TimedOut = 'timed_out',
  Cancelled = 'cancelled',
  StartupFailed = 'startup_failed',
  OutputLimitExceeded = 'output_limit_exceeded',
}

export type ReviewAgentProcessRequest = Readonly<{
  invocationId: string;
  fencingToken: string;
  binary: string;
  args: readonly string[];
  cwd: string;
  environment: Readonly<NodeJS.ProcessEnv>;
  stdin: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}>;

export type ReviewAgentProcessResult = Readonly<{
  termination: ReviewAgentProcessTermination;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}>;

export interface ReviewAgentProcessRunnerPort {
  run(request: ReviewAgentProcessRequest): Promise<ReviewAgentProcessResult>;
  cancel(invocationId: string, fencingToken: string): Promise<void>;
}

type ActiveProcess = Readonly<{
  fencingToken: string;
  terminate: () => void;
}>;

export class NodeReviewAgentProcessRunner implements ReviewAgentProcessRunnerPort {
  private readonly active = new Map<string, ActiveProcess>();

  async run(
    request: ReviewAgentProcessRequest
  ): Promise<ReviewAgentProcessResult> {
    validateRequest(request);
    if (this.active.has(request.invocationId)) {
      throw new Error('review_agent_invocation_already_active');
    }
    const startedAt = Date.now();
    return new Promise((resolve) => {
      if (request.signal?.aborted) {
        resolve(
          result(
            ReviewAgentProcessTermination.Cancelled,
            null,
            '',
            '',
            startedAt
          )
        );
        return;
      }
      let child;
      try {
        child = spawn(request.binary, request.args, {
          cwd: request.cwd,
          env: { ...request.environment },
          detached: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve(
          result(
            ReviewAgentProcessTermination.StartupFailed,
            null,
            '',
            sanitizeProcessText(
              error instanceof Error ? error.message : String(error)
            ),
            startedAt
          )
        );
        return;
      }

      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let settled = false;
      let forcedTermination: ReviewAgentProcessTermination | null = null;
      const terminate = () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
        this.active.delete(request.invocationId);
      };
      const settle = (
        termination: ReviewAgentProcessTermination,
        exitCode: number | null
      ) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result(termination, exitCode, stdout, stderr, startedAt));
      };
      const onAbort = () => {
        forcedTermination = ReviewAgentProcessTermination.Cancelled;
        terminate();
      };
      const collect = (target: 'stdout' | 'stderr') => (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > request.maxOutputBytes) {
          forcedTermination = ReviewAgentProcessTermination.OutputLimitExceeded;
          terminate();
          return;
        }
        if (target === 'stdout') stdout += chunk.toString('utf8');
        else stderr += chunk.toString('utf8');
      };
      const timer = setTimeout(() => {
        forcedTermination = ReviewAgentProcessTermination.TimedOut;
        terminate();
      }, request.timeoutMs);

      this.active.set(
        request.invocationId,
        Object.freeze({
          fencingToken: request.fencingToken,
          terminate: () => {
            forcedTermination = ReviewAgentProcessTermination.Cancelled;
            terminate();
          },
        })
      );
      request.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', collect('stdout'));
      child.stderr.on('data', collect('stderr'));
      child.stdin.on('error', () => {
        // Early provider exit can close stdin before the prompt is fully written.
      });
      child.on('error', (error) => {
        stderr = sanitizeProcessText(error.message);
        settle(ReviewAgentProcessTermination.StartupFailed, null);
      });
      child.on('close', (code) =>
        settle(forcedTermination ?? ReviewAgentProcessTermination.Exited, code)
      );
      child.stdin.end(request.stdin, 'utf8');
    });
  }

  async cancel(invocationId: string, fencingToken: string): Promise<void> {
    const active = this.active.get(invocationId);
    if (!active) return;
    if (active.fencingToken !== fencingToken) {
      throw new Error('review_agent_cancel_fencing_mismatch');
    }
    active.terminate();
  }
}

function validateRequest(request: ReviewAgentProcessRequest): void {
  if (
    !request.invocationId ||
    !request.fencingToken ||
    !request.binary ||
    !request.cwd ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    !Number.isSafeInteger(request.maxOutputBytes) ||
    request.maxOutputBytes < 1
  ) {
    throw new Error('review_agent_process_request_invalid');
  }
}

function result(
  termination: ReviewAgentProcessTermination,
  exitCode: number | null,
  stdout: string,
  stderr: string,
  startedAt: number
): ReviewAgentProcessResult {
  return Object.freeze({
    termination,
    exitCode,
    stdout,
    stderr,
    durationMs: Math.max(0, Date.now() - startedAt),
  });
}

function sanitizeProcessText(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ').slice(0, 400);
}
