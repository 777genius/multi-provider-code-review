import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

test('pure native PostgreSQL cleanup regression checks', () => {
  const result = spawnSync(
    process.execPath,
    ['--test', join(__dirname, 'review-quality-postgres-cleanup.test.mjs')],
    { encoding: 'utf8', timeout: 15_000 }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Cleanup checks failed: ${result.stdout}\n${result.stderr}`);
  }
}, 20_000);
