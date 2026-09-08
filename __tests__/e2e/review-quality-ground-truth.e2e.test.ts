import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

test('native fixture ground truth (inferred-result control is caller-local, not repository-wide defect freedom)', () => {
  const result = spawnSync(
    process.execPath,
    ['--test', join(__dirname, 'review-quality-ground-truth.test.mjs')],
    { encoding: 'utf8', timeout: 120_000 }
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Native fixture runner failed: exit=${result.status}, signal=${result.signal}`
    );
  }
}, 130_000);
