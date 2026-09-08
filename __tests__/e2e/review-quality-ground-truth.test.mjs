import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repositories } from './support/review-quality-fixtures/repositories.mjs';
import { cases } from './support/review-quality-fixtures/evaluator.mjs';

const exec = promisify(execFile);
async function materialized(files, run) {
  const root = await mkdtemp(join(tmpdir(), 'rr-quality-fixtures-r1-'));
  try {
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source, { flag: 'wx' });
    }
    await run(path => import(pathToFileURL(join(root, path)).href));
  } finally {
    // Use the host's guarded rm through PATH; these dirs contain no Git metadata.
    await exec('rm', ['-r', '--', root]);
    await assert.rejects(access(root), { code: 'ENOENT' });
  }
}

test('exactly three stable cases with unchanged related consumers', () => {
  assert.deepEqual(Object.keys(repositories), cases.map(c => c.id));
  assert.equal(new Set(cases.map(c => c.id)).size, 3);
  for (const fixture of cases) {
    const { base, defective, corrected } = repositories[fixture.id];
    for (const files of [defective, corrected]) {
      assert.deepEqual(Object.keys(files).sort(), Object.keys(base).sort());
      for (const path of Object.keys(base)) {
        if (path !== fixture.changedFile) assert.equal(files[path], base[path]);
      }
    }
    assert.notEqual(base[fixture.changedFile], defective[fixture.changedFile]);
    for (const path of fixture.relatedEvidence) {
      assert.equal(typeof base[path], 'string');
      assert.notEqual(path, fixture.changedFile);
    }
  }
});

for (const fixture of cases) {
  for (const revision of ['base', 'defective', 'corrected']) {
    test(`${fixture.id}: ${revision}`, async () => {
      await materialized(repositories[fixture.id][revision], async load => {
        if (revision === 'defective') {
          await assert.rejects(() => fixture.verify(load), error => {
            assert.equal(error.code, 'ERR_ASSERTION');
            assert.ok(error.message.includes(fixture.reason));
            assert.deepEqual(error.actual, fixture.defectiveActual);
            assert.deepEqual(error.expected, fixture.expected);
            return true;
          });
        } else {
          await fixture.verify(load);
        }
      });
    });
    if (fixture.control) {
      test(`${fixture.id}: ${revision} inferred-result-only no-defect control`, async () => {
        await materialized(repositories[fixture.id][revision], load => fixture.control(load));
      });
    }
  }
}
