import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { TextDecoder } from 'util';
import {
  ReviewAgentExecutionError,
  ReviewAgentFailureClass,
} from '../application/review-agent-port';
import {
  ReviewAgentProcessTermination,
  type ReviewAgentProcessResult,
} from './review-agent-process-runner';
import {
  CODEX_APP_SERVER_VERSION,
  CodexAppServerProtocolClient,
  classifyCodexAppServerDiagnostic,
  type CodexAppServerProtocolRequest,
  type CodexAppServerProtocolResult,
} from './codex-app-server-protocol';

export type CodexAppServerTurnRequest = Readonly<{
  invocationId: string;
  fencingToken: string;
  binary: string;
  args: readonly string[];
  cwd: string;
  environment: Readonly<NodeJS.ProcessEnv>;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  protocol: CodexAppServerProtocolRequest;
}>;

export type CodexAppServerTurnResult = CodexAppServerProtocolResult &
  Readonly<{
    durationMs: number;
  }>;

export interface CodexAppServerTurnRunnerPort {
  executeTurn(
    request: CodexAppServerTurnRequest
  ): Promise<CodexAppServerTurnResult>;
  cancel(invocationId: string, fencingToken: string): Promise<void>;
}

export interface CodexAppServerVersionProbePort {
  assertSupported(request: {
    readonly binary: string;
    readonly cwd: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
  }): Promise<void>;
}

type ActiveTurn = {
  fencingToken: string;
  abortController: AbortController;
  execution: CodexAppServerChildTurn | null;
  done: Deferred<void>;
};

const DEFAULT_INTERRUPT_GRACE_MS = 500;
const MAX_DIAGNOSTIC_BYTES = 16_384;

export class NodeCodexAppServerTurnRunner implements CodexAppServerTurnRunnerPort {
  private readonly active = new Map<string, ActiveTurn>();
  private readonly verifiedBinaries = new Set<string>();
  private readonly interruptGraceMs: number;

  constructor(
    private readonly options: Readonly<{
      interruptGraceMs?: number;
      processResultObserver?: (result: ReviewAgentProcessResult) => void;
      versionProbe?: CodexAppServerVersionProbePort;
    }> = {}
  ) {
    const grace = options.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS;
    if (!Number.isSafeInteger(grace) || grace < 1 || grace > 10_000) {
      throw new Error('review_agent_codex_interrupt_grace_invalid');
    }
    this.interruptGraceMs = grace;
  }

  async executeTurn(
    request: CodexAppServerTurnRequest
  ): Promise<CodexAppServerTurnResult> {
    validateRequest(request);
    if (this.active.has(request.invocationId)) {
      throw processFailure();
    }
    if (request.signal?.aborted) throw cancelledFailure();

    const startedAt = Date.now();
    const abortController = new AbortController();
    const active: ActiveTurn = {
      fencingToken: request.fencingToken,
      abortController,
      execution: null,
      done: deferred<void>(),
    };
    this.active.set(request.invocationId, active);
    const abort = () => abortController.abort();
    request.signal?.addEventListener('abort', abort, { once: true });
    try {
      await this.requireSupportedVersion({
        ...request,
        signal: abortController.signal,
        timeoutMs: request.timeoutMs,
      });
      if (abortController.signal.aborted) throw cancelledFailure();
      const remainingMs = request.timeoutMs - (Date.now() - startedAt);
      if (remainingMs < 1) throw timeoutFailure();

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(request.binary, [...request.args], {
          cwd: request.cwd,
          env: { ...request.environment },
          detached: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        const result = processResult(
          ReviewAgentProcessTermination.StartupFailed,
          null,
          '',
          startedAt
        );
        this.observe(result);
        throw startupFailure();
      }

      const execution = new CodexAppServerChildTurn({
        child,
        request: {
          ...request,
          timeoutMs: remainingMs,
          signal: abortController.signal,
        },
        interruptGraceMs: this.interruptGraceMs,
        startedAt,
        observe: (result) => this.observe(result),
      });
      active.execution = execution;
      return await execution.run();
    } finally {
      request.signal?.removeEventListener('abort', abort);
      const current = this.active.get(request.invocationId);
      if (current === active) {
        this.active.delete(request.invocationId);
      }
      active.done.resolve();
    }
  }

  async cancel(invocationId: string, fencingToken: string): Promise<void> {
    const active = this.active.get(invocationId);
    if (!active) return;
    if (active.fencingToken !== fencingToken) {
      throw new Error('review_agent_cancel_fencing_mismatch');
    }
    active.abortController.abort();
    await active.execution?.cancel();
    await active.done.promise;
  }

  private observe(result: ReviewAgentProcessResult): void {
    try {
      this.options.processResultObserver?.(result);
    } catch {
      // Test/diagnostic observers cannot affect execution semantics.
    }
  }

  private async requireSupportedVersion(
    request: CodexAppServerTurnRequest
  ): Promise<void> {
    if (this.verifiedBinaries.has(request.binary)) return;
    await (
      this.options.versionProbe ?? new NodeCodexAppServerVersionProbe()
    ).assertSupported(request);
    this.verifiedBinaries.add(request.binary);
  }
}

export class NodeCodexAppServerVersionProbe implements CodexAppServerVersionProbePort {
  assertSupported(request: {
    readonly binary: string;
    readonly cwd: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
  }): Promise<void> {
    if (request.signal?.aborted) return Promise.reject(cancelledFailure());
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(request.binary, ['--version'], {
          cwd: request.cwd,
          env: { ...request.environment },
          detached: false,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        reject(startupFailure());
        return;
      }
      let output = Buffer.alloc(0);
      let termination: 'cancelled' | 'timed_out' | null = null;
      let settled = false;
      const collect = (chunk: Buffer) => {
        if (output.byteLength >= 1_024) return;
        output = Buffer.concat([
          output,
          chunk.subarray(0, 1_024 - output.byteLength),
        ]);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.stdin.end();
      const kill = () => {
        try {
          child.kill('SIGKILL');
        } catch {
          // The process can exit between the signal and close handling.
        }
      };
      const timer = setTimeout(
        () => {
          if (termination !== null) return;
          termination = 'timed_out';
          kill();
        },
        Math.min(request.timeoutMs, 10_000)
      );
      const onAbort = () => {
        if (termination !== null) return;
        termination = 'cancelled';
        clearTimeout(timer);
        kill();
      };
      request.signal?.addEventListener('abort', onAbort, { once: true });
      if (request.signal?.aborted) onAbort();
      const settle = (error?: ReviewAgentExecutionError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };
      child.on('error', () => {
        settle(startupFailure());
      });
      child.on('close', (code) => {
        if (termination === 'cancelled') {
          settle(cancelledFailure());
          return;
        }
        if (termination === 'timed_out') {
          settle(timeoutFailure());
          return;
        }
        const version = output.toString('utf8').trim();
        if (code === 0 && version === `codex-cli ${CODEX_APP_SERVER_VERSION}`) {
          settle();
          return;
        }
        settle(
          new ReviewAgentExecutionError(
            ReviewAgentFailureClass.CapabilityUnavailable,
            null,
            'review_agent_codex_app_server_version_mismatch'
          )
        );
      });
    });
  }
}

class CodexAppServerChildTurn {
  private readonly done = deferred<CodexAppServerTurnResult>();
  private readonly protocol: CodexAppServerProtocolClient;
  private readonly protocolRun: Promise<CodexAppServerProtocolResult>;
  private stdoutBuffer = Buffer.alloc(0);
  private stderr = Buffer.alloc(0);
  private outputBytes = 0;
  private closed = false;
  private settled = false;
  private forcedTermination: ReviewAgentProcessTermination | null = null;
  private terminalError: ReviewAgentExecutionError | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private readonly overallTimer: NodeJS.Timeout;

  constructor(
    private readonly input: Readonly<{
      child: ChildProcessWithoutNullStreams;
      request: CodexAppServerTurnRequest;
      interruptGraceMs: number;
      startedAt: number;
      observe(result: ReviewAgentProcessResult): void;
    }>
  ) {
    this.protocol = new CodexAppServerProtocolClient(
      input.request.protocol,
      (message) => this.write(message)
    );
    this.protocolRun = this.protocol.run();
    void this.protocolRun.then(
      () => this.closeInput(),
      (error) => this.onProtocolFailure(error)
    );

    input.child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    input.child.stderr.on('data', (chunk: Buffer) => this.onStderr(chunk));
    input.child.stdin.on('error', () => {
      // A closing child can reject a write before the close event reports why.
    });
    input.child.on('error', (error) => {
      this.terminalError = classifyCodexAppServerDiagnostic(
        sanitizeDiagnostic(error.message),
        ReviewAgentFailureClass.StartupFailure
      );
    });
    input.child.on('close', (code) => void this.onClose(code));
    this.overallTimer = setTimeout(
      () => this.requestTermination(ReviewAgentProcessTermination.TimedOut),
      input.request.timeoutMs
    );
    input.request.signal?.addEventListener('abort', this.onAbort, {
      once: true,
    });
  }

  run(): Promise<CodexAppServerTurnResult> {
    return this.done.promise;
  }

  async cancel(): Promise<void> {
    this.requestTermination(ReviewAgentProcessTermination.Cancelled);
    await this.done.promise.catch(() => undefined);
  }

  private readonly onAbort = (): void => {
    this.requestTermination(ReviewAgentProcessTermination.Cancelled);
  };

  private write(message: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.closed || !this.input.child.stdin.writable) {
      return Promise.reject(processFailure());
    }
    let line: string;
    try {
      line = `${JSON.stringify(message)}\n`;
    } catch {
      return Promise.reject(
        streamFailure(CodexTurnRunnerDiagnosticStage.WriteJson)
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.input.child.stdin.write(line, 'utf8', (error) => {
        if (error) reject(processFailure());
        else resolve();
      });
    });
  }

  private onStdout(chunk: Buffer): void {
    if (this.closed || this.settled || !this.collectBytes(chunk.byteLength)) {
      return;
    }
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    try {
      let newline = this.stdoutBuffer.indexOf(0x0a);
      while (newline >= 0) {
        let line = this.stdoutBuffer.subarray(0, newline);
        this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
        if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
        this.receiveLine(line);
        newline = this.stdoutBuffer.indexOf(0x0a);
      }
    } catch (error) {
      this.onProtocolFailure(error);
    }
  }

  private onStderr(chunk: Buffer): void {
    if (this.closed || this.settled || !this.collectBytes(chunk.byteLength)) {
      return;
    }
    if (this.stderr.byteLength < MAX_DIAGNOSTIC_BYTES) {
      this.stderr = Buffer.concat([
        this.stderr,
        chunk.subarray(0, MAX_DIAGNOSTIC_BYTES - this.stderr.byteLength),
      ]);
    }
  }

  private collectBytes(bytes: number): boolean {
    this.outputBytes += bytes;
    if (this.outputBytes <= this.input.request.maxOutputBytes) return true;
    this.forcedTermination = ReviewAgentProcessTermination.OutputLimitExceeded;
    this.terminalError = processFailure();
    this.killProcessGroup();
    return false;
  }

  private receiveLine(line: Buffer): void {
    if (line.byteLength === 0) return;
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(line);
    } catch {
      throw streamFailure(CodexTurnRunnerDiagnosticStage.StdoutUtf8);
    }
    let message: unknown;
    try {
      message = JSON.parse(decoded);
    } catch {
      throw streamFailure(CodexTurnRunnerDiagnosticStage.StdoutJson);
    }
    this.protocol.receive(message);
    const postCompletionFailure = this.protocol.failureAfterCompletion();
    if (postCompletionFailure) throw postCompletionFailure;
  }

  private onProtocolFailure(error: unknown): void {
    if (this.closed || this.settled || this.forcedTermination !== null) return;
    this.terminalError =
      error instanceof ReviewAgentExecutionError
        ? error
        : streamFailure(CodexTurnRunnerDiagnosticStage.ProtocolFailure);
    this.killProcessGroup();
  }

  private requestTermination(termination: ReviewAgentProcessTermination): void {
    if (this.closed || this.settled || this.forcedTermination !== null) return;
    this.forcedTermination = termination;
    if (!this.protocol.canInterrupt()) {
      this.killProcessGroup();
      return;
    }
    this.killTimer = setTimeout(
      () => this.killProcessGroup(),
      this.input.interruptGraceMs
    );
    void this.protocol
      .interrupt()
      .catch(() => undefined)
      .finally(() => this.closeInput());
  }

  private closeInput(): void {
    if (!this.closed && !this.input.child.stdin.destroyed) {
      this.input.child.stdin.end();
    }
  }

  private killProcessGroup(): void {
    if (this.closed) return;
    try {
      if (this.input.child.pid) {
        process.kill(-this.input.child.pid, 'SIGKILL');
      } else {
        this.input.child.kill('SIGKILL');
      }
    } catch {
      try {
        this.input.child.kill('SIGKILL');
      } catch {
        // The process can exit between the group kill and fallback kill.
      }
    }
  }

  private async onClose(exitCode: number | null): Promise<void> {
    if (this.closed || this.settled) return;
    this.closed = true;
    clearTimeout(this.overallTimer);
    if (this.killTimer) clearTimeout(this.killTimer);
    this.input.request.signal?.removeEventListener('abort', this.onAbort);

    try {
      if (this.stdoutBuffer.byteLength > 0) {
        let line = this.stdoutBuffer;
        if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
        this.receiveLine(line);
      }
    } catch (error) {
      this.terminalError =
        error instanceof ReviewAgentExecutionError
          ? error
          : streamFailure(CodexTurnRunnerDiagnosticStage.TrailingStdout);
    }
    this.stdoutBuffer = Buffer.alloc(0);
    this.protocol.end();
    const trailingFailure = this.protocol.failureAfterCompletion();
    if (trailingFailure) this.terminalError = trailingFailure;

    let protocolResult: CodexAppServerProtocolResult | null = null;
    try {
      protocolResult = await this.protocolRun;
    } catch (error) {
      if (
        exitCode === 0 &&
        !this.terminalError &&
        error instanceof ReviewAgentExecutionError
      ) {
        this.terminalError = error;
      }
    }

    const observed = processResult(
      this.forcedTermination ??
        (this.terminalError?.failureClass ===
        ReviewAgentFailureClass.StartupFailure
          ? ReviewAgentProcessTermination.StartupFailed
          : ReviewAgentProcessTermination.Exited),
      exitCode,
      sanitizeDiagnostic(this.stderr.toString('utf8')),
      this.input.startedAt
    );
    this.input.observe(observed);

    if (this.forcedTermination === ReviewAgentProcessTermination.TimedOut) {
      this.settleFailure(timeoutFailure());
      return;
    }
    if (this.forcedTermination === ReviewAgentProcessTermination.Cancelled) {
      this.settleFailure(cancelledFailure());
      return;
    }
    if (this.terminalError) {
      this.settleFailure(this.terminalError);
      return;
    }
    if (exitCode !== 0) {
      this.settleFailure(
        classifyCodexAppServerDiagnostic(
          sanitizeDiagnostic(this.stderr.toString('utf8'))
        )
      );
      return;
    }
    if (!protocolResult) {
      this.settleFailure(
        streamFailure(CodexTurnRunnerDiagnosticStage.MissingProtocolResult)
      );
      return;
    }
    this.settled = true;
    this.done.resolve(
      Object.freeze({
        ...protocolResult,
        durationMs: Math.max(0, Date.now() - this.input.startedAt),
      })
    );
  }

  private settleFailure(error: ReviewAgentExecutionError): void {
    if (this.settled) return;
    this.settled = true;
    this.done.reject(error);
  }
}

function validateRequest(request: CodexAppServerTurnRequest): void {
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
    throw processFailure();
  }
}

function processResult(
  termination: ReviewAgentProcessTermination,
  exitCode: number | null,
  stderr: string,
  startedAt: number
): ReviewAgentProcessResult {
  return Object.freeze({
    termination,
    exitCode,
    stdout: '',
    stderr: stderr.slice(0, 400),
    durationMs: Math.max(0, Date.now() - startedAt),
  });
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/(?:sk|sess|eyJ)[A-Za-z0-9._-]{12,}/gu, '<redacted>')
    .replace(/[\r\n]+/gu, ' ')
    .trim()
    .slice(0, MAX_DIAGNOSTIC_BYTES);
}

function startupFailure(): ReviewAgentExecutionError {
  return new ReviewAgentExecutionError(
    ReviewAgentFailureClass.StartupFailure,
    null,
    'review_agent_startup_failure'
  );
}

function processFailure(): ReviewAgentExecutionError {
  return new ReviewAgentExecutionError(
    ReviewAgentFailureClass.ProcessFailure,
    null,
    'review_agent_process_failure'
  );
}

function timeoutFailure(): ReviewAgentExecutionError {
  return new ReviewAgentExecutionError(
    ReviewAgentFailureClass.Timeout,
    null,
    'review_agent_process_timeout'
  );
}

function cancelledFailure(): ReviewAgentExecutionError {
  return new ReviewAgentExecutionError(
    ReviewAgentFailureClass.Cancelled,
    null,
    'review_agent_process_cancelled'
  );
}

enum CodexTurnRunnerDiagnosticStage {
  MissingProtocolResult = 'missing_protocol_result',
  ProtocolFailure = 'protocol_failure',
  StdoutJson = 'stdout_json',
  StdoutUtf8 = 'stdout_utf8',
  TrailingStdout = 'trailing_stdout',
  WriteJson = 'write_json',
}

function streamFailure(
  stage?: CodexTurnRunnerDiagnosticStage
): ReviewAgentExecutionError {
  return new ReviewAgentExecutionError(
    ReviewAgentFailureClass.StreamIncomplete,
    null,
    stage
      ? `review_agent_stream_incomplete_${stage}`
      : 'review_agent_stream_incomplete'
  );
}

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
