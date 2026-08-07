import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../..');

describe('release workflow', () => {
  it('publishes the exact and moving tags atomically', () => {
    const workflow = fs.readFileSync(
      path.join(repoRoot, '.github/workflows/release.yml'),
      'utf8'
    );

    expect(workflow).toContain('git push --atomic origin');
    expect(workflow).toContain('"refs/tags/$VERSION"');
    expect(workflow).toContain('"+refs/tags/$MAJOR_TAG"');
    expect(workflow).not.toContain('git push origin "refs/tags/$VERSION"\n');
    expect(workflow).not.toContain(
      'git push --force origin "refs/tags/$MAJOR_TAG"'
    );
  });
});
