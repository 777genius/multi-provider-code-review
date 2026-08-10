import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../..');
const auditedExternalUses = [
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
];

describe('release workflow', () => {
  it.each(['release.yml', 'ci.yml'])(
    'pins every external action in %s to its audited SHA',
    (file) => {
      const workflow = fs.readFileSync(
        path.join(repoRoot, '.github/workflows', file),
        'utf8'
      );
      const externalUses = [
        ...workflow.matchAll(/^\s*(?:-\s*)?uses:\s+([^\s#]+)/gm),
      ]
        .map((match) => match[1])
        .filter((reference) => !reference.startsWith('./'));

      expect(externalUses).toEqual(auditedExternalUses);
      for (const externalUse of externalUses) {
        expect(externalUse).toMatch(/^[^@]+@[a-f0-9]{40}$/);
      }
    }
  );

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
