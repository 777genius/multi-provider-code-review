import * as fs from 'fs';
import * as yaml from 'js-yaml';

describe('Codex OAuth rotating action metadata', () => {
  it('keeps the action as a single Node entrypoint with no pre/post hooks', () => {
    const action = yaml.load(fs.readFileSync('action.yml', 'utf8')) as {
      inputs?: Record<string, unknown>;
      runs?: Record<string, unknown>;
    };

    expect(action.inputs).toHaveProperty('auth-json');
    expect(action.inputs).toHaveProperty('provider-instance-id');
    expect(action.inputs).toHaveProperty('workflow-schema-version');
    expect(action.inputs).toHaveProperty('session-binding-id');
    expect(action.inputs).toHaveProperty('session-binding-version');
    expect(action.inputs).toHaveProperty('claude-code-oauth-token');
    expect(action.inputs).toHaveProperty('openrouter-api-key');
    expect(action.inputs?.mode).toMatchObject({
      required: false,
    });
    expect(action.inputs?.mode).not.toHaveProperty('default');
    expect(action.inputs?.['api-url']).toMatchObject({
      required: false,
    });
    expect(action.inputs?.['control-plane-url']).toMatchObject({
      required: false,
    });
    expect(action.inputs?.['provider-instance-id']).toMatchObject({
      required: false,
    });
    expect(action.inputs?.['session-binding-id']).toMatchObject({
      required: false,
    });
    expect(action.inputs?.['session-binding-version']).toMatchObject({
      required: false,
    });
    expect(action.inputs?.['auth-json']).toMatchObject({
      required: false,
    });
    expect(action.runs).toMatchObject({
      using: 'node24',
      main: 'action-dist/index.cjs',
    });
    expect(action.runs).not.toHaveProperty('pre');
    expect(action.runs).not.toHaveProperty('pre-if');
    expect(action.runs).not.toHaveProperty('post');
    expect(action.runs).not.toHaveProperty('post-if');
  });

  it('prunes inherited secret-like env keys in the bundled action runtime', () => {
    const actionDist = fs.readFileSync('action-dist/index.cjs', 'utf8');

    expect(actionDist).toContain('const normalizedKey = key.toUpperCase();');
    expect(actionDist).toContain('key.startsWith("INPUT_")');
    expect(actionDist).toContain(
      '/(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|AUTH_JSON)/.test(normalizedKey)'
    );
    expect(actionDist).toContain('readInput(env, "control-plane-url")');
    expect(actionDist).toContain('REVIEWROUTER_CONTROL_PLANE_URL');
  });

  it('ships the fail-closed hosted pool contract in the bundled runtime', () => {
    const actionDist = fs.readFileSync('action-dist/index.cjs', 'utf8');
    const hostedModeBranch = actionDist.indexOf(
      'inputs.mode === forkAgenticSandboxHostedPoolActionMode'
    );
    const repositoryOwnedAuthRead = actionDist.indexOf(
      'const authJson = readActionAuthJson(env);'
    );

    expect(actionDist).toContain('"fork-agentic-sandbox-hosted-pool"');
    expect(actionDist).toContain(
      'sessionBindingId: requireInput(env, "session-binding-id")'
    );
    expect(actionDist).toContain('"hosted_public_repository_unsupported"');
    expect(actionDist).toContain('"hosted_fork_pull_request_unsupported"');
    expect(actionDist).toContain('runHostedCodexRelayTransport({');
    expect(hostedModeBranch).toBeGreaterThanOrEqual(0);
    expect(repositoryOwnedAuthRead).toBeGreaterThan(hostedModeBranch);
  });
});
