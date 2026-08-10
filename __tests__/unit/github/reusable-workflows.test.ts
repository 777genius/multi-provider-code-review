import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
  permissions?: Record<string, string>;
  on?: {
    issue_comment?: { types?: string[] };
    pull_request_review_comment?: { types?: string[] };
    workflow_dispatch?: unknown;
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

function permissionEscalations(
  callerPermissions: Record<string, string>,
  calledPermissions: Record<string, string>
): string[] {
  const ranks: Record<string, number> = { none: 0, read: 1, write: 2 };
  return Object.entries(calledPermissions).flatMap(([scope, requested]) => {
    const granted = callerPermissions[scope] ?? 'none';
    return (ranks[requested] ?? Number.POSITIVE_INFINITY) >
      (ranks[granted] ?? Number.NEGATIVE_INFINITY)
      ? [`${scope}: ${granted} -> ${requested}`]
      : [];
  });
}

function runInteractionRuntimePreparation(reviewWorkflowFile: string) {
  const workflow = readRepoFile(
    '.github/workflows/reviewrouter-interaction-reusable.yml'
  );
  const scriptMatch = workflow.match(/node <<'NODE'\n([\s\S]*?)\n\s+NODE/u);
  if (!scriptMatch) {
    throw new Error('Interaction runtime preparation script not found');
  }

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'reviewrouter-interaction-workflow-')
  );
  try {
    const githubEnv = path.join(tempDir, 'github-env');
    const githubOutput = path.join(tempDir, 'github-output');
    fs.writeFileSync(githubEnv, '');
    fs.writeFileSync(githubOutput, '');

    const result = spawnSync(process.execPath, ['-e', scriptMatch[1]], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RR_RUNTIME_REF: '0123456789abcdef0123456789abcdef01234567',
        RR_REVIEW_WORKFLOW_FILE: reviewWorkflowFile,
        REVIEWROUTER_RUNTIME_CONFIG_MODE: 'oidc',
        REVIEW_APP_PRIVATE_KEY_PRESENT: '0',
        RR_REVIEW_APP_CLIENT_ID: '',
        GITHUB_ENV: githubEnv,
        GITHUB_OUTPUT: githubOutput,
      },
    });

    const githubEnvContents = fs.readFileSync(githubEnv, 'utf8');
    return { ...result, githubEnvContents };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
    const externalActionUses = steps
      .map((step) => step.uses)
      .filter((value): value is string =>
        Boolean(value && !value.startsWith('./'))
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
    expect(
      externalActionUses.some((value) =>
        value.startsWith('actions/setup-node@')
      )
    ).toBe(true);
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
    expect(
      externalActionUses.some((value) =>
        value.startsWith('actions/create-github-app-token@')
      )
    ).toBe(true);
    for (const actionUses of externalActionUses) {
      expect(actionUses).toMatch(/@[0-9a-f]{40}$/u);
    }
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
    expect(codexInstall?.if).toContain(
      "steps.runtime.outputs.can_run == 'true'"
    );
    expect(codexInstall?.if).toContain(
      "steps.provider-tooling.outputs.codex_cli_needed == 'true'"
    );
    expect(codexInstall?.if).not.toContain(
      "inputs.review_action_lane == 'legacy'"
    );
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
    const workflowPath =
      '.github/workflows/reviewrouter-interaction-reusable.yml';
    const workflow = readRepoFile(workflowPath);
    const parsedWorkflow = parseWorkflow(workflowPath);
    const interaction = parsedWorkflow.jobs?.interaction;
    const externalActionUses = (interaction?.steps ?? [])
      .map((step) => step.uses)
      .filter((value): value is string => Boolean(value));

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
    expect(externalActionUses).toEqual([
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1',
    ]);
    for (const actionUses of externalActionUses) {
      expect(actionUses).toMatch(/@[0-9a-f]{40}$/u);
    }
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
    expect(workflow).toContain('allowedReviewWorkflowFiles');
    expect(workflow).toContain(
      'REVIEW_ROUTER_REVIEW_WORKFLOW_FILE=${reviewWorkflowFile}'
    );
    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).not.toContain('REVIEW_ROUTER_THREAD_RESOLVE_TOKEN');
  });

  it('supports a pinned read-token agent-teams interaction caller', () => {
    const caller = parseWorkflow(
      '__tests__/fixtures/github/reviewrouter-codex-interaction-caller.yml'
    );
    const interaction = caller.jobs?.interaction;
    const pinnedRuntimeRef = '0123456789abcdef0123456789abcdef01234567';

    expect(caller.on?.pull_request_review_comment?.types).toEqual([
      'created',
      'edited',
    ]);
    expect(caller.on?.issue_comment?.types).toEqual(['created', 'edited']);
    expect(caller.on).toHaveProperty('workflow_dispatch');
    expect(caller.permissions).toEqual({});
    expect(interaction?.if).toBe(
      "${{ github.event_name == 'workflow_dispatch' || ((github.event_name != 'issue_comment' || github.event.issue.pull_request) && github.event.comment.user.type != 'Bot') }}"
    );
    expect(interaction?.permissions).toEqual({
      actions: 'write',
      contents: 'read',
      issues: 'read',
      'pull-requests': 'read',
      'id-token': 'write',
    });
    expect(interaction?.uses).toBe(
      `777genius/review-router/.github/workflows/reviewrouter-interaction-reusable.yml@${pinnedRuntimeRef}`
    );
    expect(interaction?.with).toMatchObject({
      runtime_ref: pinnedRuntimeRef,
      runtime_config_mode: 'oidc',
      review_workflow_file: 'reviewrouter-codex.yml',
      discussion_mode: "${{ vars.REVIEW_ROUTER_DISCUSSION_MODE || 'off' }}",
      discussion_model: "${{ vars.REVIEW_CODEX_MODEL || 'gpt-5.5' }}",
      discussion_reasoning_effort: "${{ vars.REVIEW_CODEX_EFFORT || 'xhigh' }}",
      discussion_max_per_pr:
        "${{ vars.REVIEW_ROUTER_DISCUSSION_MAX_PER_PR || '20' }}",
      discussion_max_per_thread:
        "${{ vars.REVIEW_ROUTER_DISCUSSION_MAX_PER_THREAD || '5' }}",
      discussion_timeout_seconds:
        "${{ vars.REVIEW_ROUTER_DISCUSSION_TIMEOUT_SECONDS || '60' }}",
    });
    expect(interaction?.secrets).toEqual({
      CODEX_AUTH_JSON: '${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON }}',
    });
    expect(interaction?.secrets).not.toHaveProperty('REVIEW_ROUTER_LEDGER_KEY');
  });

  it('keeps reusable permissions executable by the secured thin caller', () => {
    const caller = parseWorkflow(
      '__tests__/fixtures/github/reviewrouter-codex-interaction-caller.yml'
    ).jobs?.interaction;
    const reusable = parseWorkflow(
      '.github/workflows/reviewrouter-interaction-reusable.yml'
    ).jobs?.interaction;

    expect(reusable?.permissions).toEqual({
      actions: 'write',
      contents: 'read',
      'pull-requests': 'read',
      issues: 'read',
      'id-token': 'write',
    });
    expect(
      permissionEscalations(
        caller?.permissions ?? {},
        reusable?.permissions ?? {}
      )
    ).toEqual([]);
  });

  it.each([
    'reviewrouter.yml',
    'reviewrouter.yaml',
    'reviewrouter-codex.yml',
    'reviewrouter-codex.yaml',
  ])('accepts the safe review workflow filename %s', (reviewWorkflowFile) => {
    const result = runInteractionRuntimePreparation(reviewWorkflowFile);

    expect(result.status).toBe(0);
    expect(result.githubEnvContents).toContain(
      `REVIEW_ROUTER_REVIEW_WORKFLOW_FILE=${reviewWorkflowFile}\n`
    );
    expect(result.githubEnvContents).toContain(
      'REVIEWROUTER_COMMENT_TOKEN_MODE=app-oidc\n'
    );
  });

  it.each([
    '../reviewrouter-codex.yml',
    'reviewrouter-codex.yml/../../reviewrouter.yml',
    'reviewrouter-other.yml',
    'ReviewRouter-codex.yml',
    'reviewrouter.yml\nINJECTED=true',
  ])('rejects the unsafe review workflow filename %j', (reviewWorkflowFile) => {
    const result = runInteractionRuntimePreparation(reviewWorkflowFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Invalid review_workflow_file. Use reviewrouter.yml or reviewrouter-codex.yml.'
    );
    expect(result.githubEnvContents).toBe('');
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
