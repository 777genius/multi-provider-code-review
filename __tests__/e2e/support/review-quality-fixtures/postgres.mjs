// Evaluator infrastructure only; no caller-supplied database or container targets.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

function docker(args, input) {
  const result = spawnSync('docker', args, {
    input, encoding: 'utf8', timeout: 20_000,
  });
  if (result.error) throw result.error;
  return result;
}
function requireSuccess(result, step) {
  if (result.status !== 0) {
    throw new Error(`${step} requires an accessible Docker daemon and local postgres:17 image; ` +
      `exit=${result.status}, signal=${result.signal}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

export async function withFreshPostgres(run) {
  const name = `rr-quality-cross-contract-r1-${randomUUID()}`;
  // No pull, ports, mounts, host network, existing containers, or external DB URLs.
  requireSuccess(docker(['create', '--pull=never', '--name', name,
    '--network', 'none', '--label', 'rr.fixture=rr-quality-cross-contract-r1',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=fixture',
    'postgres:17']), 'Creating disposable PostgreSQL');
  try {
    requireSuccess(docker(['start', name]), 'Starting disposable PostgreSQL');
    // The image initializes using a socket-only temporary server. TCP readiness
    // inside this network-isolated container waits for the final server.
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'fixture']);
      if (result.status === 0) { ready = true; break; }
      await setTimeout(100);
    }
    assert.ok(ready, 'Disposable PostgreSQL did not become ready');
    await run(sql => docker(['exec', '-i', name, 'psql', '-X', '-qAt',
      '-U', 'postgres', '-d', 'fixture', '-v', 'ON_ERROR_STOP=1',
      '-v', 'VERBOSITY=verbose'], sql));
  } finally {
    requireSuccess(docker(['rm', '-f', '-v', name]), 'Removing disposable PostgreSQL');
  }
}
