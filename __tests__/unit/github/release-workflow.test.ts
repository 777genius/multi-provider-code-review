import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const repoRoot = path.resolve(__dirname, '../../..');
const workflowDirectory = path.join(repoRoot, '.github/workflows');
const auditedActionShas: Readonly<Record<string, string>> = {
  'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/create-github-app-token': 'bcd2ba49218906704ab6c1aa796996da409d3eb1',
  'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020',
};
const auditedExternalUseCounts: Readonly<Record<string, number>> = {
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1': 10,
  'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1': 2,
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020': 6,
};

function collectUses(
  value: unknown,
  references: string[] = [],
  seen: Set<object> = new Set()
): string[] {
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
      references.push(child);
      continue;
    }
    collectUses(child, references, seen);
  }

  return references;
}

function parseWorkflowUses(source: string): string[] {
  return collectUses(yaml.load(source, { schema: yaml.JSON_SCHEMA }));
}

describe('workflow security and release', () => {
  it('pins every external workflow action to its audited full SHA', () => {
    const workflowFiles = fs
      .readdirSync(workflowDirectory)
      .filter((file) => /\.ya?ml$/.test(file))
      .sort();
    const externalUseCounts: Record<string, number> = {};

    for (const file of workflowFiles) {
      const workflow = fs.readFileSync(
        path.join(workflowDirectory, file),
        'utf8'
      );
      const externalUses = parseWorkflowUses(workflow).filter(
        (reference) => !reference.startsWith('./')
      );

      for (const externalUse of externalUses) {
        expect(externalUse).toMatch(/^[^@]+@[a-f0-9]{40}$/);
        const [action, sha] = externalUse.split('@');
        expect(auditedActionShas[action]).toBe(sha);
        externalUseCounts[externalUse] =
          (externalUseCounts[externalUse] ?? 0) + 1;
      }
    }

    expect(externalUseCounts).toEqual(auditedExternalUseCounts);
    expect(
      Object.values(externalUseCounts).reduce(
        (total, count) => total + count,
        0
      )
    ).toBe(18);
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
    `);

    expect(references).toEqual([
      'actions/checkout@v7',
      'actions/setup-node@v7',
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
