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
});
