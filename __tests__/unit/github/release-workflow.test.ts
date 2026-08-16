import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const repoRoot = path.resolve(__dirname, '../../..');
const workflowDirectory = path.join(repoRoot, '.github/workflows');
const checkoutActionSha = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const checkoutActionReference = `actions/checkout@${checkoutActionSha}`;
const auditedActionShas: Readonly<Record<string, string>> = {
  'actions/checkout': checkoutActionSha,
  'actions/create-github-app-token': 'bcd2ba49218906704ab6c1aa796996da409d3eb1',
  'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020',
};
const auditedExternalUseCounts: Readonly<Record<string, number>> = {
  [checkoutActionReference]: 11,
  'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1': 2,
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020': 6,
};
const checkoutCredentialException = {
  workflow: 'release.yml',
  stepName: 'Checkout',
  reference: checkoutActionReference,
} as const;

interface WorkflowUse {
  readonly reference: string;
  readonly mapping: Record<string, unknown>;
}

interface LocatedWorkflowUse extends WorkflowUse {
  readonly workflow: string;
}

function collectUses(
  value: unknown,
  references: WorkflowUse[] = [],
  seen: Set<object> = new Set()
): WorkflowUse[] {
  if (value === null || typeof value !== 'object') {
    return references;
  }
  if (seen.has(value)) {
    return references;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectUses(item, references, seen);
    }
    return references;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === 'uses') {
      if (typeof child !== 'string') {
        throw new TypeError('workflow uses values must be strings');
      }
      references.push({
        reference: child,
        mapping: value as Record<string, unknown>,
      });
      continue;
    }
    collectUses(child, references, seen);
  }

  return references;
}

function parseWorkflowUses(source: string): WorkflowUse[] {
  return collectUses(yaml.load(source, { schema: yaml.JSON_SCHEMA }));
}

function readWorkflowUses(): LocatedWorkflowUse[] {
  return fs
    .readdirSync(workflowDirectory)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .flatMap((workflow) => {
      const source = fs.readFileSync(
        path.join(workflowDirectory, workflow),
        'utf8'
      );
      return parseWorkflowUses(source).map((use) => ({ ...use, workflow }));
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stepName(use: WorkflowUse): string {
  return typeof use.mapping.name === 'string' ? use.mapping.name : '<unnamed>';
}

function persistCredentials(use: WorkflowUse): unknown {
  const inputs = use.mapping.with;
  return isRecord(inputs) ? inputs['persist-credentials'] : undefined;
}

function isCheckoutCredentialException(use: LocatedWorkflowUse): boolean {
  return (
    use.workflow === checkoutCredentialException.workflow &&
    stepName(use) === checkoutCredentialException.stepName &&
    use.reference === checkoutCredentialException.reference
  );
}

function checkoutCredentialViolation(use: LocatedWorkflowUse): string | null {
  if (!use.reference.startsWith('actions/checkout@')) {
    return null;
  }

  const expected = isCheckoutCredentialException(use);
  const actual = persistCredentials(use);
  return actual === expected
    ? null
    : `${use.workflow}:${stepName(use)} expected persist-credentials=${expected}, got ${String(actual)}`;
}

describe('workflow security and release', () => {
  it('pins every external workflow action to its audited full SHA', () => {
    const externalUseCounts: Record<string, number> = {};
    const externalUses = readWorkflowUses()
      .map((use) => use.reference)
      .filter((reference) => !reference.startsWith('./'));

    for (const externalUse of externalUses) {
      expect(externalUse).toMatch(/^[^@]+@[a-f0-9]{40}$/);
      const [action, sha] = externalUse.split('@');
      expect(auditedActionShas[action]).toBe(sha);
      externalUseCounts[externalUse] =
        (externalUseCounts[externalUse] ?? 0) + 1;
    }

    expect(externalUseCounts).toEqual(auditedExternalUseCounts);
    expect(
      Object.values(externalUseCounts).reduce(
        (total, count) => total + count,
        0
      )
    ).toBe(19);
  });

  it('finds semantic uses keys without scanning block scalar text', () => {
    const references = parseWorkflowUses(`
jobs:
  probe:
    steps:
      - { uses: actions/checkout@v7 }
      - 'uses': actions/setup-node@v7
      - run: |
          uses: actions/create-github-app-token@v3
    `).map((use) => use.reference);

    expect(references).toEqual([
      'actions/checkout@v7',
      'actions/setup-node@v7',
    ]);
  });

  it('disables checkout credentials except for the exact release publisher', () => {
    const checkoutUses = readWorkflowUses().filter((use) =>
      use.reference.startsWith('actions/checkout@')
    );
    const exceptions = checkoutUses.filter(isCheckoutCredentialException);
    const violations = checkoutUses
      .map(checkoutCredentialViolation)
      .filter((violation): violation is string => violation !== null);

    expect(
      exceptions.map((use) => ({
        workflow: use.workflow,
        stepName: stepName(use),
        reference: use.reference,
        persistCredentials: persistCredentials(use),
      }))
    ).toEqual([
      {
        ...checkoutCredentialException,
        persistCredentials: true,
      },
    ]);
    expect(violations).toEqual([]);
  });

  it('rejects missing or enabled credentials outside the release exception', () => {
    const checkoutUses = parseWorkflowUses(`
jobs:
  probe:
    steps:
      - { name: Missing checkout, uses: ${checkoutActionReference} }
      - name: Checkout
        'uses': ${checkoutActionReference}
        with: { persist-credentials: true }
      - run: |
          uses: ${checkoutActionReference}
    `).map((use) => ({ ...use, workflow: 'probe.yml' }));

    expect(checkoutUses).toHaveLength(2);
    expect(checkoutUses.map(checkoutCredentialViolation)).toEqual([
      'probe.yml:Missing checkout expected persist-credentials=false, got undefined',
      'probe.yml:Checkout expected persist-credentials=false, got true',
    ]);
  });

  it('rejects a handoff base outside the release ancestry', () => {
    const workflow = fs.readFileSync(
      path.join(repoRoot, '.github/workflows/release.yml'),
      'utf8'
    );
    const validationStep = workflow.match(
      /- name: Validate release target[\s\S]*?(?=\n\s+- name: Install dependencies)/
    )?.[0];

    expect(validationStep).toBeDefined();
    expect(validationStep).toContain('expectedPublicActionBaseCommit');
    expect(validationStep).toContain(
      'git merge-base --is-ancestor "$HANDOFF_BASE" HEAD'
    );
  });

  it('publishes the exact and moving tags atomically', () => {
    const workflow = fs.readFileSync(
      path.join(repoRoot, '.github/workflows/release.yml'),
      'utf8'
    );
    const publishStep = workflow.match(
      /- name: Publish exact and stable tags[\s\S]*?(?=\n\s+- name: Create GitHub Release)/
    )?.[0];

    expect(publishStep).toBeDefined();
    expect(publishStep?.match(/\bgit push\b/g)).toHaveLength(1);
    expect(publishStep).toMatch(
      /git push --atomic origin \\\n\s+"refs\/tags\/\$VERSION" \\\n\s+"\+refs\/tags\/\$MAJOR_TAG"/
    );
  });
});
