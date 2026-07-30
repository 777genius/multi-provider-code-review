import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import {
  CONTEXT_GATEWAY_POLICY_VERSION,
  canonicalJson,
  contextGitDiffPolicyHash,
  contextGitFactOperandsHash,
  sha256,
  type ContextGitFactKind,
} from '../../../src/context-gateway/context-gateway-contract';
import {
  ReviewExecutionProviderKind,
  type ContextDependencyReplayCandidate,
} from '../../../src/review-orchestration/application';
import { ContextAttestationReplayRunner } from '../../../src/review-orchestration/infrastructure';

const execFileAsync = promisify(execFile);

describe('ContextAttestationReplayRunner', () => {
  let root: string;
  let gatewayBundlePath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'rr-context-replay-test-'));
    gatewayBundlePath = path.join(root, 'context-gateway.js');
    await writeFile(gatewayBundlePath, 'gateway-v1', 'utf8');
    await git(root, ['init', '--initial-branch=main']);
    await git(root, ['config', 'user.email', 'test@reviewrouter.local']);
    await git(root, ['config', 'user.name', 'ReviewRouter Test']);
    await writeFile(path.join(root, 'src.ts'), 'export const value = 1;\n');
    await git(root, ['add', 'src.ts']);
    await git(root, ['commit', '-m', 'test: seed']);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('replays a source file dependency against immutable target Git objects', async () => {
    const headSha = await revParse(root, 'HEAD');
    const operation = {
      kind: 'file_read' as const,
      path: 'src.ts',
      startByte: 0,
      maxBytes: 4096,
    };
    const candidate = replayCandidate({
      gatewayBinaryHash: sha256('gateway-v1'),
      dependencies: [
        {
          sequence: 1,
          operationKey: sha256(canonicalJson(operation)),
          operation,
          replayQuery: null,
        },
      ],
    });
    const runner = new ContextAttestationReplayRunner({
      checkoutRoot: root,
      gatewayBundlePath,
    });

    const result = await runner.replay({
      candidate,
      targetRevision: {
        baseSha: headSha,
        mergeBaseSha: headSha,
        headSha,
        reviewRevisionHash: '4'.repeat(64),
      },
    });

    expect(result).not.toBeNull();
    expect(result?.replayResultHash).toBe(
      sha256(result!.replayResultCanonicalJson)
    );
    const manifest = JSON.parse(result!.replayResultCanonicalJson);
    expect(manifest.checkoutTreeOid).toBe(await revParse(root, 'HEAD^{tree}'));
    expect(manifest.dependencies[0].operation).toEqual(operation);
    expect(manifest.dependencies[0].result).toMatchObject({
      kind: 'file_read',
      contentHash: sha256('export const value = 1;\n'),
      complete: true,
      truncated: false,
    });
  });

  it('ignores replacement objects while replaying authorized Git objects', async () => {
    const headSha = await revParse(root, 'HEAD');
    const authorizedTreeOid = await revParse(root, 'HEAD^{tree}');
    const operation = {
      kind: 'file_read' as const,
      path: 'src.ts',
      startByte: 0,
      maxBytes: 4096,
    };
    await writeFile(path.join(root, 'src.ts'), 'export const value = 99;\n');
    await git(root, ['add', 'src.ts']);
    const foreignTreeOid = await gitOutput(root, ['write-tree']);
    const foreignCommitSha = await gitOutput(root, [
      'commit-tree',
      foreignTreeOid,
      '-p',
      headSha,
      '-m',
      'test: foreign replacement',
    ]);
    await git(root, ['reset', '--hard', headSha]);
    await git(root, ['replace', headSha, foreignCommitSha]);
    expect(await revParse(root, 'HEAD^{tree}')).toBe(foreignTreeOid);
    const runner = new ContextAttestationReplayRunner({
      checkoutRoot: root,
      gatewayBundlePath,
    });

    const result = await runner.replay({
      candidate: replayCandidate({
        gatewayBinaryHash: sha256('gateway-v1'),
        dependencies: [
          {
            sequence: 1,
            operationKey: sha256(canonicalJson(operation)),
            operation,
            replayQuery: null,
          },
        ],
      }),
      targetRevision: {
        baseSha: headSha,
        mergeBaseSha: headSha,
        headSha,
        reviewRevisionHash: '4'.repeat(64),
      },
    });

    expect(result?.targetCheckoutTreeOid).toBe(authorizedTreeOid);
    expect(replayDependency(result).result).toMatchObject({
      kind: 'file_read',
      contentHash: sha256('export const value = 1;\n'),
    });
  });

  it('denies replay when the trusted gateway binary changed', async () => {
    const headSha = await revParse(root, 'HEAD');
    const operation = {
      kind: 'file_read' as const,
      path: 'src.ts',
      startByte: 0,
      maxBytes: 4096,
    };
    const runner = new ContextAttestationReplayRunner({
      checkoutRoot: root,
      gatewayBundlePath,
    });

    await expect(
      runner.replay({
        candidate: replayCandidate({
          gatewayBinaryHash: '9'.repeat(64),
          dependencies: [
            {
              sequence: 1,
              operationKey: sha256(canonicalJson(operation)),
              operation,
              replayQuery: null,
            },
          ],
        }),
        targetRevision: {
          baseSha: headSha,
          mergeBaseSha: headSha,
          headSha,
          reviewRevisionHash: '4'.repeat(64),
        },
      })
    ).resolves.toBeNull();
  });

  it.each(['changed_paths', 'diff_stat'] as const)(
    'keeps %s replay identity across an empty commit',
    async (fact) => {
      const sourceHeadSha = await revParse(root, 'HEAD');
      const sourceTreeOid = await revParse(root, 'HEAD^{tree}');
      const sourceOperation = treeComparisonOperation(
        fact,
        sourceTreeOid,
        sourceTreeOid
      );
      await git(root, [
        'commit',
        '--allow-empty',
        '-m',
        'test: empty revision',
      ]);
      const targetHeadSha = await revParse(root, 'HEAD');
      const runner = new ContextAttestationReplayRunner({
        checkoutRoot: root,
        gatewayBundlePath,
      });

      const result = await runner.replay({
        candidate: replayCandidate({
          gatewayBinaryHash: sha256('gateway-v1'),
          dependencies: [
            {
              sequence: 1,
              operationKey: sha256(canonicalJson(sourceOperation)),
              operation: sourceOperation,
              replayQuery: null,
            },
          ],
        }),
        targetRevision: {
          baseSha: sourceHeadSha,
          mergeBaseSha: sourceHeadSha,
          headSha: targetHeadSha,
          reviewRevisionHash: '4'.repeat(64),
        },
      });

      const dependency = replayDependency(result);
      expect(dependency.operation).toEqual(sourceOperation);
      expect(dependency.operationKey).toBe(
        sha256(canonicalJson(sourceOperation))
      );
      expect(dependency.result).toMatchObject({
        kind: 'git_fact',
        resultHash: sha256(canonicalJson([])),
        itemCount: 0,
      });
    }
  );

  it.each(['changed_paths', 'diff_stat'] as const)(
    'changes %s replay identity when the compared tree changes',
    async (fact) => {
      const sourceHeadSha = await revParse(root, 'HEAD');
      const sourceTreeOid = await revParse(root, 'HEAD^{tree}');
      const sourceOperation = treeComparisonOperation(
        fact,
        sourceTreeOid,
        sourceTreeOid
      );
      await writeFile(path.join(root, 'src.ts'), 'export const value = 2;\n');
      await git(root, ['add', 'src.ts']);
      await git(root, ['commit', '-m', 'test: change content']);
      const targetHeadSha = await revParse(root, 'HEAD');
      const targetTreeOid = await revParse(root, 'HEAD^{tree}');
      const runner = new ContextAttestationReplayRunner({
        checkoutRoot: root,
        gatewayBundlePath,
      });

      const result = await runner.replay({
        candidate: replayCandidate({
          gatewayBinaryHash: sha256('gateway-v1'),
          dependencies: [
            {
              sequence: 1,
              operationKey: sha256(canonicalJson(sourceOperation)),
              operation: sourceOperation,
              replayQuery: null,
            },
          ],
        }),
        targetRevision: {
          baseSha: sourceHeadSha,
          mergeBaseSha: sourceHeadSha,
          headSha: targetHeadSha,
          reviewRevisionHash: '4'.repeat(64),
        },
      });

      const dependency = replayDependency(result);
      const targetOperation = treeComparisonOperation(
        fact,
        sourceTreeOid,
        targetTreeOid
      );
      expect(dependency.operation).toEqual(targetOperation);
      expect(dependency.operationKey).toBe(
        sha256(canonicalJson(targetOperation))
      );
      expect(dependency.operationKey).not.toBe(
        sha256(canonicalJson(sourceOperation))
      );
    }
  );

  it('keeps merge_base replay identity when only the head commit changes', async () => {
    const sourceHeadSha = await revParse(root, 'HEAD');
    const sourceOperation = mergeBaseOperation(sourceHeadSha);
    await git(root, ['commit', '--allow-empty', '-m', 'test: advance head']);
    const targetHeadSha = await revParse(root, 'HEAD');
    const runner = new ContextAttestationReplayRunner({
      checkoutRoot: root,
      gatewayBundlePath,
    });

    const result = await runner.replay({
      candidate: replayCandidate({
        gatewayBinaryHash: sha256('gateway-v1'),
        dependencies: [
          {
            sequence: 1,
            operationKey: sha256(canonicalJson(sourceOperation)),
            operation: sourceOperation,
            replayQuery: null,
          },
        ],
      }),
      targetRevision: {
        baseSha: sourceHeadSha,
        mergeBaseSha: sourceHeadSha,
        headSha: targetHeadSha,
        reviewRevisionHash: '4'.repeat(64),
      },
    });

    const dependency = replayDependency(result);
    expect(dependency.operation).toEqual(sourceOperation);
    expect(dependency.result).toMatchObject({
      kind: 'git_fact',
      resultHash: sha256(canonicalJson([sourceHeadSha])),
      itemCount: 1,
    });
  });

  it('changes merge_base replay identity when the merge-base commit changes with the same tree', async () => {
    const sourceMergeBaseSha = await revParse(root, 'HEAD');
    const sourceOperation = mergeBaseOperation(sourceMergeBaseSha);
    await git(root, [
      'commit',
      '--allow-empty',
      '-m',
      'test: replace merge base identity',
    ]);
    const targetMergeBaseSha = await revParse(root, 'HEAD');
    expect(await revParse(root, `${sourceMergeBaseSha}^{tree}`)).toBe(
      await revParse(root, `${targetMergeBaseSha}^{tree}`)
    );
    const runner = new ContextAttestationReplayRunner({
      checkoutRoot: root,
      gatewayBundlePath,
    });

    const result = await runner.replay({
      candidate: replayCandidate({
        gatewayBinaryHash: sha256('gateway-v1'),
        dependencies: [
          {
            sequence: 1,
            operationKey: sha256(canonicalJson(sourceOperation)),
            operation: sourceOperation,
            replayQuery: null,
          },
        ],
      }),
      targetRevision: {
        baseSha: targetMergeBaseSha,
        mergeBaseSha: targetMergeBaseSha,
        headSha: targetMergeBaseSha,
        reviewRevisionHash: '4'.repeat(64),
      },
    });

    const dependency = replayDependency(result);
    const targetOperation = mergeBaseOperation(targetMergeBaseSha);
    expect(dependency.operation).toEqual(targetOperation);
    expect(dependency.operationKey).not.toBe(
      sha256(canonicalJson(sourceOperation))
    );
    expect(dependency.result).toMatchObject({
      kind: 'git_fact',
      resultHash: sha256(canonicalJson([targetMergeBaseSha])),
      itemCount: 1,
    });
  });
});

function treeComparisonOperation(
  fact: Extract<ContextGitFactKind, 'changed_paths' | 'diff_stat'>,
  mergeBaseTreeOid: string,
  headTreeOid: string
) {
  const operandsHash =
    fact === 'diff_stat'
      ? contextGitFactOperandsHash({
          fact,
          mergeBaseTreeOid,
          headTreeOid,
          diffPolicyHash: contextGitDiffPolicyHash(null),
        })
      : contextGitFactOperandsHash({
          fact,
          mergeBaseTreeOid,
          headTreeOid,
        });
  return Object.freeze({
    kind: 'git_fact' as const,
    fact,
    operandsHash,
  });
}

function mergeBaseOperation(mergeBaseSha: string) {
  return Object.freeze({
    kind: 'git_fact' as const,
    fact: 'merge_base' as const,
    operandsHash: contextGitFactOperandsHash({
      fact: 'merge_base',
      mergeBaseSha,
    }),
  });
}

function replayDependency(
  result: Awaited<ReturnType<ContextAttestationReplayRunner['replay']>>
) {
  expect(result).not.toBeNull();
  const manifest = JSON.parse(result!.replayResultCanonicalJson) as {
    dependencies: readonly {
      operationKey: string;
      operation: Readonly<Record<string, unknown>>;
      result: Readonly<Record<string, unknown>>;
    }[];
  };
  expect(manifest.dependencies).toHaveLength(1);
  return manifest.dependencies[0]!;
}

function replayCandidate(input: {
  gatewayBinaryHash: string;
  dependencies: readonly {
    sequence: number;
    operationKey: string;
    operation: Readonly<Record<string, unknown>>;
    replayQuery: string | null;
  }[];
}): ContextDependencyReplayCandidate {
  const attestationId = 'attestation-test';
  const attestationHash = 'a'.repeat(64);
  const replayPlanCanonicalJson = canonicalJson({
    planVersion: 1,
    attestationId,
    attestationHash,
    gatewayPolicyVersion: CONTEXT_GATEWAY_POLICY_VERSION,
    gatewayBinaryHash: input.gatewayBinaryHash,
    sourceDependencies: input.dependencies,
  });
  return {
    observation: {
      observationId: 'observation-test',
      payloadCanonicalJson: '{}',
      payloadHash: sha256('{}'),
      byteCount: 2,
      findingCount: 0,
      actualModel: 'gpt-5.6-sol',
      qualityFlags: [],
      transportAttemptCount: 1,
      schemaValidated: true,
      fullyConsumed: true,
      contextDependencyAttestationId: attestationId,
      contextDependencyAttestationHash: attestationHash,
      eligibilityPolicyVersion: 'reuse-policy-v1',
      providerKind: ReviewExecutionProviderKind.Codex,
      providerInvocationKey: 'b'.repeat(64),
      providerVoteIdentityHash: 'c'.repeat(64),
    },
    attestationId,
    attestationHash,
    replayCapability: 'replay-capability',
    replayPlanCanonicalJson,
    replayPlanHash: sha256(replayPlanCanonicalJson),
  };
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function gitOutput(
  cwd: string,
  args: readonly string[]
): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim().toLowerCase();
}

async function revParse(cwd: string, spec: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', spec], { cwd });
  return stdout.trim().toLowerCase();
}
