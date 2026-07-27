import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const repoRoot = path.resolve(__dirname, '../../..');

function readRepoFile(filePath: string): string {
  return fs.readFileSync(path.join(repoRoot, filePath), 'utf8');
}

type WorkflowJob = {
  env?: Record<string, unknown>;
  permissions?: Record<string, string>;
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  steps?: Array<{
    name?: string;
    env?: Record<string, unknown>;
    if?: string;
    uses?: string;
  }>;
};

type WorkflowDocument = {
  on?: {
    workflow_call?: {
      inputs?: Record<string, { default?: unknown }>;
    };
  };
  jobs?: Record<string, WorkflowJob>;
};

function parseWorkflow(filePath: string): WorkflowDocument {
  return yaml.load(readRepoFile(filePath), {
    schema: yaml.JSON_SCHEMA,
  }) as WorkflowDocument;
}

describe('production reusable workflows', () => {
  it('ships every runtime bundle required by the immutable action checkout', () => {
    const contextGatewayBundle = 'dist/context-gateway.js';

    expect(fs.existsSync(path.join(repoRoot, contextGatewayBundle))).toBe(true);
    expect(
      execFileSync(
        'git',
        ['ls-files', '--error-unmatch', contextGatewayBundle],
        {
          cwd: repoRoot,
          encoding: 'utf8',
        }
      ).trim()
    ).toBe(contextGatewayBundle);
  });

  it('exposes a dedicated read-only T0 reusable entrypoint', () => {
    const workflowPath = '.github/workflows/reviewrouter-t0-reusable.yml';
    const workflowSource = readRepoFile(workflowPath);
    const workflow = parseWorkflow(workflowPath);
    const review = workflow.jobs?.review;

    expect(review?.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
      'id-token': 'write',
    });
    expect(review?.uses).toBe(
      './.github/workflows/reviewrouter-execution-reusable.yml'
    );
    expect(review?.with?.review_action_lane).toBe('t0');
    expect(review?.with).toHaveProperty('runtime_ref');
    expect(review?.with?.api_url).toBe(
      '${{ inputs.control_plane_url || inputs.api_url }}'
    );
    expect(review?.with?.control_plane_url).toBe(
      '${{ inputs.control_plane_url }}'
    );
    expect(review?.with).toHaveProperty('review_head_sha');
    expect(review?.with).toHaveProperty('provider_instance_id');
    expect(workflowSource).not.toContain('pull-requests: write');
    expect(workflowSource).not.toContain('issues: write');
    expect(workflowSource).not.toContain('REVIEW_APP_PRIVATE_KEY');
    expect(workflowSource).not.toContain(
      'REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN'
    );
  });

  it('routes T0 through a read-only job without SCM mutation secrets', () => {
    const workflow = parseWorkflow(
      '.github/workflows/reviewrouter-reusable.yml'
    );
    const inputs = workflow.on?.workflow_call?.inputs;
    const t0 = workflow.jobs?.['review-t0'];
    const legacy = workflow.jobs?.['review-legacy'];

    expect(inputs?.review_action_v2_mode?.default).toBe('disabled');
    expect(inputs?.control_plane_url?.default).toBe('');
    expect(inputs?.workflow_schema_version?.default).toBe(1);
    expect(inputs?.review_drafts?.default).toBe(false);
    expect(inputs?.max_changed_lines?.default).toBe('0');
    expect(t0?.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
      'id-token': 'write',
    });
    expect(t0?.uses).toBe(
      './.github/workflows/reviewrouter-execution-reusable.yml'
    );
    expect(t0?.with?.review_action_lane).toBe('t0');
    expect(t0?.with?.api_url).toBe(
      '${{ inputs.control_plane_url || inputs.api_url }}'
    );
    expect(t0?.with?.control_plane_url).toBe('${{ inputs.control_plane_url }}');
    expect(t0?.with).toHaveProperty('provider_instance_id');
    expect(t0?.with).toHaveProperty('workflow_schema_version');
    expect(t0?.with).toHaveProperty('max_changed_lines');
    expect(t0?.if).toContain("inputs.review_action_v2_mode == 't0'");
    expect(t0?.secrets).not.toHaveProperty(
      'REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN'
    );
    expect(t0?.secrets).not.toHaveProperty('REVIEW_APP_PRIVATE_KEY');
    expect(t0?.secrets).not.toHaveProperty('GITHUB_TOKEN');

    expect(legacy?.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'write',
      issues: 'write',
      'id-token': 'write',
    });
    expect(legacy?.with?.review_action_lane).toBe('legacy');
    expect(legacy?.with?.api_url).toBe(
      '${{ inputs.control_plane_url || inputs.api_url }}'
    );
    expect(legacy?.with?.control_plane_url).toBe(
      '${{ inputs.control_plane_url }}'
    );
    expect(legacy?.if).toContain("inputs.review_action_v2_mode == 'disabled'");
    expect(legacy?.secrets).toHaveProperty(
      'REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN'
    );
    expect(legacy?.secrets).toHaveProperty('REVIEW_APP_PRIVATE_KEY');
  });

  it('keeps the shared execution workflow sandbox-safe in both lanes', () => {
    const workflowPath =
      '.github/workflows/reviewrouter-execution-reusable.yml';
    const workflowSource = readRepoFile(workflowPath);
    const workflow = parseWorkflow(workflowPath);
    const inputs = workflow.on?.workflow_call?.inputs;
    const steps = workflow.jobs?.review?.steps ?? [];
    const runtimePreparation = steps.find(
      (step) => step.name === 'Prepare ReviewRouter runtime settings'
    );
    const t0Run = steps.find((step) => step.name === 'Run ReviewRouter T0');
    const legacyRun = steps.find(
      (step) => step.name === 'Run ReviewRouter legacy'
    );
    const codexInstall = steps.find(
      (step) => step.name === 'Install Codex CLI'
    );
    const codexAuthRestore = steps.find(
      (step) => step.name === 'Restore Codex subscription auth'
    );

    expect(workflowSource).toContain('workflow_call:');
    expect(workflowSource).toContain('runtime_ref:');
    expect(inputs?.control_plane_url?.default).toBe('');
    expect(workflow.jobs?.review?.env?.REVIEWROUTER_API_URL).toBe(
      '${{ inputs.control_plane_url || inputs.api_url }}'
    );
    expect(workflow.jobs?.review?.env?.REVIEWROUTER_CONTROL_PLANE_URL).toBe(
      '${{ inputs.control_plane_url || inputs.api_url }}'
    );
    expect(workflowSource).toContain(
      'repository: ${{ steps.runtime.outputs.runtime_repository }}'
    );
    expect(workflowSource).toContain(
      'ref: ${{ steps.runtime.outputs.runtime_ref }}'
    );
    expect(workflowSource).toContain(
      'RR_WORKFLOW_REPOSITORY: ${{ job.workflow_repository }}'
    );
    expect(workflowSource).toContain(
      'RR_WORKFLOW_SHA: ${{ job.workflow_sha }}'
    );
    expect(workflow.jobs?.review?.env).not.toHaveProperty(
      'RR_WORKFLOW_REPOSITORY'
    );
    expect(workflow.jobs?.review?.env).not.toHaveProperty('RR_WORKFLOW_SHA');
    expect(runtimePreparation?.env).toMatchObject({
      RR_WORKFLOW_REPOSITORY: '${{ job.workflow_repository }}',
      RR_WORKFLOW_SHA: '${{ job.workflow_sha }}',
    });
    expect(workflowSource).toContain("eventName === 'merge_group'");
    expect(workflowSource).toContain("isMergeGroup ? 'merge_group'");
    expect(workflowSource).toContain('ReviewRouter merge queue check passed');
    expect(workflowSource).toContain('path: .reviewrouter-runtime');
    expect(workflowSource).toContain('persist-credentials: false');
    expect(workflowSource).toContain('uses: actions/setup-node@v6');
    expect(workflowSource).toContain("node-version: '24'");
    expect(workflowSource).toContain(
      'Resolve ReviewRouter runtime provider tooling'
    );
    expect(workflowSource).toContain('REVIEW_ROUTER_MODE: runtime-preflight');
    expect(workflowSource).toContain(
      "steps.provider-tooling.outputs.codex_cli_needed == 'true'"
    );
    expect(workflowSource).toContain(
      "steps.provider-tooling.outputs.codex_oauth_needed == 'true'"
    );
    expect(workflowSource).toContain(
      "steps.provider-tooling.outputs.claude_cli_needed == 'true'"
    );
    expect(workflowSource).toContain('review_app_client_id:');
    expect(workflowSource).toContain('REVIEW_APP_PRIVATE_KEY:');
    expect(workflowSource).toContain(
      'uses: actions/create-github-app-token@v3'
    );
    expect(workflowSource).toContain("const crypto = require('node:crypto');");
    expect(workflowSource).toContain(
      "staticEnv.FAIL_ON_NO_HEALTHY_PROVIDERS = 'true';"
    );
    expect(workflowSource).toContain('staticRuntimeEnvAllowlist');
    expect(workflowSource).toContain("['TARGET_TOKENS_PER_BATCH']");
    expect(workflowSource).toContain('isSecretLikeStaticRuntimeEnvKey(key)');
    expect(workflowSource).toContain("key === 'REVIEWROUTER_ACTION_V2_MODE'");
    expect(workflowSource).toContain('npm install -g @openai/codex@0.145.0');
    expect(workflowSource).toContain(
      'curl -fsSL https://claude.ai/install.sh | bash'
    );
    expect(workflowSource).toContain(
      'node .reviewrouter-runtime/dist/index.js'
    );
    expect(workflowSource).toContain('REVIEW_ROUTER_LEDGER_KEY');
    expect(workflowSource).toContain('CODEX_AUTH_JSON');
    expect(workflowSource).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(workflowSource).toContain('OPENROUTER_API_KEY');
    expect(workflowSource).toContain('REVIEW_ROUTER_MEMORY_ENABLED');
    expect(workflowSource).toContain('REVIEW_ROUTER_MEMORY_BUNDLE_ENDPOINT');
    expect(workflowSource).toContain('reseed auth.json');
    expect(workflowSource).toContain(
      'ReviewRouter skipped this fork pull request'
    );
    expect(workflowSource).not.toContain('pull_request_target');
    expect(workflowSource).not.toContain('REVIEW_ROUTER_THREAD_RESOLVE_TOKEN');

    expect(t0Run?.if).toContain("inputs.review_action_lane == 't0'");
    expect(codexInstall?.if).toContain("inputs.review_action_lane == 'legacy'");
    expect(codexAuthRestore?.if).toContain(
      "inputs.review_action_lane == 'legacy'"
    );
    expect(t0Run?.env?.REVIEWROUTER_ACTION_V2_MODE).toBe('t0');
    expect(t0Run?.env?.REVIEW_ROUTER_MODE).toBe('codex-oauth-rotating');
    expect(t0Run?.env).toHaveProperty('INPUT_CONTROL_PLANE_URL');
    expect(t0Run?.env).toHaveProperty('INPUT_PROVIDER_INSTANCE_ID');
    expect(t0Run?.env).toHaveProperty('INPUT_WORKFLOW_SCHEMA_VERSION');
    expect(t0Run?.env).toHaveProperty('INPUT_MAX_CHANGED_LINES');
    expect(t0Run?.env).toHaveProperty('INPUT_AUTH_JSON');
    expect(t0Run?.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(t0Run?.env).not.toHaveProperty('GH_TOKEN');
    expect(t0Run?.env).not.toHaveProperty('INPUT_GITHUB_TOKEN');
    expect(t0Run?.env).not.toHaveProperty(
      'REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN'
    );
    expect(t0Run?.env).not.toHaveProperty('REVIEW_APP_PRIVATE_KEY');

    expect(legacyRun?.if).toContain("inputs.review_action_lane == 'legacy'");
    expect(legacyRun?.env?.REVIEWROUTER_ACTION_V2_MODE).toBe('disabled');
    expect(legacyRun?.env).toHaveProperty('GITHUB_TOKEN');
    expect(legacyRun?.env).toHaveProperty(
      'REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN'
    );
  });

  it('keeps the interaction reusable workflow focused on /rr handling', () => {
    const workflow = readRepoFile(
      '.github/workflows/reviewrouter-interaction-reusable.yml'
    );

    expect(workflow).toContain('workflow_call:');
    expect(workflow).toContain('control_plane_url:');
    expect(workflow).toContain(
      'REVIEWROUTER_API_URL: ${{ inputs.control_plane_url || inputs.api_url }}'
    );
    expect(workflow).toContain(
      'REVIEWROUTER_CONTROL_PLANE_URL: ${{ inputs.control_plane_url || inputs.api_url }}'
    );
    expect(workflow).toContain('review_app_client_id:');
    expect(workflow).toContain('REVIEW_APP_PRIVATE_KEY:');
    expect(workflow).toContain('uses: actions/create-github-app-token@v3');
    expect(workflow).toContain('REVIEW_ROUTER_LEDGER_KEY');
    expect(workflow).toContain('actions: write');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('Preflight ReviewRouter interaction');
    expect(workflow).toContain('REVIEW_ROUTER_MODE: interaction-preflight');
    expect(workflow).toContain('REVIEW_ROUTER_MODE: interaction');
    expect(workflow).toContain('discussion_mode:');
    expect(workflow).toContain('CODEX_AUTH_JSON:');
    expect(workflow).toContain('OPENAI_API_KEY:');
    expect(workflow).toContain('Install Codex CLI for discussion replies');
    expect(workflow).toContain('REVIEW_ROUTER_MEMORY_ENABLED');
    expect(workflow).toContain('REVIEW_ROUTER_MEMORY_CANDIDATE_ENDPOINT');
    expect(workflow).toContain('REVIEW_ROUTER_MEMORY_COMMAND_ENDPOINT');
    expect(workflow).toContain('review_workflow_file:');
    expect(workflow).toContain(
      'RR_REVIEW_WORKFLOW_FILE: ${{ inputs.review_workflow_file }}'
    );
    expect(workflow).toContain('Invalid review_workflow_file');
    expect(workflow).toContain(
      'REVIEW_ROUTER_REVIEW_WORKFLOW_FILE=${reviewWorkflowFile}'
    );
    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).not.toContain('REVIEW_ROUTER_THREAD_RESOLVE_TOKEN');
  });

  it('does not expose the removed resolve-conversation token in public surfaces', () => {
    expect(readRepoFile('action.yml')).not.toContain(
      'REVIEW_ROUTER_THREAD_RESOLVE_TOKEN'
    );
    expect(readRepoFile('README.md')).not.toContain(
      'REVIEW_ROUTER_THREAD_RESOLVE_TOKEN'
    );
  });

  it('keeps the conflict reusable workflow on the selected control plane', () => {
    const workflow = parseWorkflow(
      '.github/workflows/reviewrouter-conflict-reusable.yml'
    );

    expect(workflow.on?.workflow_call?.inputs?.control_plane_url?.default).toBe(
      ''
    );
    expect(workflow.jobs?.['conflict-review']?.env?.REVIEWROUTER_API_URL).toBe(
      '${{ inputs.control_plane_url || inputs.api_url }}'
    );
    expect(
      workflow.jobs?.['conflict-review']?.env?.REVIEWROUTER_CONTROL_PLANE_URL
    ).toBe('${{ inputs.control_plane_url || inputs.api_url }}');
  });
});
