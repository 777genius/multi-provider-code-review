import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { withFreshPostgres } from './support/review-quality-fixtures/postgres.mjs';

const id = 'a'.repeat(64);
const ok = (stdout = '') => ({ status: 0, signal: null, stdout, stderr: '' });
const failure = stderr => ({ ...ok(), status: 1, stderr });

// Every command is intercepted; unexpected commands fail without spawning.
for (const scenario of [
  { name: 'successful create and operation', remove: true },
  { name: 'create timeout with owned container', createError: true, remove: true },
  { name: 'create timeout with confirmed absence', createError: true, inspect: 'absent' },
  { name: 'wrong ownership label', createError: true, inspect: 'label', cleanupError: true },
  { name: 'wrong exact name', createError: true, inspect: 'name', cleanupError: true },
  { name: 'inspect daemon failure', createError: true, inspect: 'failure', cleanupError: true },
  { name: 'inspect timeout', createError: true, inspect: 'timeout', cleanupError: true },
  { name: 'operation error survives removal failure', operationError: true, remove: true, rmError: true, cleanupError: true },
  { name: 'cleanup failure after successful operation', inspect: 'failure', cleanupError: true },
  { name: 'confirmed absence after successful operation', inspect: 'absent' },
  { name: 'frozen original error survives cleanup failure', createError: true, frozen: true, inspect: 'failure', cleanupError: true },
  { name: 'non-error thrown value survives cleanup failure', operationError: true, primitive: true, inspect: 'failure', cleanupError: true },
]) {
  test(scenario.name, async t => {
    const original = scenario.primitive ? undefined : new Error('original failure');
    if (scenario.frozen) Object.freeze(original);
    const calls = [];
    let name;
    let ran = false;
    t.mock.method(childProcess, 'spawnSync', (command, args) => {
      assert.equal(command, 'docker');
      calls.push(args);
      switch (args[0]) {
        case 'create':
          name = args[args.indexOf('--name') + 1];
          assert.match(name, /^rr-quality-cross-contract-r1-[a-f0-9-]{36}$/);
          assert.equal(args[args.indexOf('--label') + 1], 'rr.fixture=rr-quality-cross-contract-r1');
          return scenario.createError ? { ...ok(), error: original } : ok(id);
        case 'start':
          assert.deepEqual(args, ['start', name]);
          return ok();
        case 'exec':
          assert.equal(args[1], name);
          assert.equal(args[2], 'pg_isready');
          return ok();
        case 'container':
          assert.deepEqual(args, ['container', 'inspect', name]);
          if (scenario.inspect === 'absent') return { ...failure(`Error: No such container: ${name}\n`), stdout: '[]\n' };
          if (scenario.inspect === 'failure') return failure('Cannot connect to the Docker daemon');
          if (scenario.inspect === 'timeout') return { ...ok(), error: new Error('inspect timeout') };
          return ok(JSON.stringify([{
            Id: id,
            Name: scenario.inspect === 'name' ? '/someone-else' : `/${name}`,
            Config: { Labels: { 'rr.fixture': scenario.inspect === 'label' ? 'someone-else' : 'rr-quality-cross-contract-r1' } },
          }]));
        case 'rm':
          assert.deepEqual(args, ['rm', '-f', '-v', id]);
          return scenario.rmError ? failure('removal failed') : ok();
        default: assert.fail(`Unexpected command: ${args}`);
      }
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const promise = withFreshPostgres(async () => {
      ran = true;
      if (scenario.operationError) throw original;
    });
    if (scenario.createError || scenario.operationError) {
      await assert.rejects(promise, error => {
        assert.equal(error, original);
        if (scenario.cleanupError && !scenario.frozen && !scenario.primitive) {
          assert.ok(error.cleanupError instanceof Error);
        }
        return true;
      });
    } else if (scenario.cleanupError) {
      await assert.rejects(promise, /Inspecting disposable PostgreSQL/);
    } else {
      await promise;
    }
    assert.equal(ran, !scenario.createError);
    assert.deepEqual(calls.map(args => args[0]), [
      'create', ...(!scenario.createError ? ['start', 'exec'] : []),
      'container', ...(scenario.remove ? ['rm'] : []),
    ]);
  });
}
