// Evaluator-only metadata and assertions: never materialize these as repository files.
import assert from 'node:assert/strict';
import { withFreshPostgres } from './postgres.mjs';

export const cases = [
  {
    id: 'hidden-numeric-caller',
    changedFile: 'src/service.mjs',
    relatedEvidence: ['src/hidden-caller.mjs', 'src/inferred-caller.mjs'],
    reason: 'numeric consumer must produce 2, not string concatenation',
    async verify(load) {
      const { result } = await load('src/hidden-caller.mjs');
      assert.equal(result, 2, this.reason);
    },
    async control(load) {
      const { changedApi } = await load('src/service.mjs');
      const { result } = await load('src/inferred-caller.mjs');
      // An inferred-result-only caller imposes no numeric contract.
      assert.equal(result, changedApi());
    },
    defectiveActual: '11',
    expected: 2,
  },
  {
    id: 'delete-event-cache-invalidation',
    changedFile: 'api/delete.mjs',
    relatedEvidence: ['cache/invalidate.mjs', 'events.mjs', 'store.mjs', 'app.mjs'],
    reason: 'deleted user must disappear from cached reads',
    async verify(load) {
      const { users, readUser, removeUser } = await load('app.mjs');
      users.set('u1', { id: 'u1' });
      users.set('u2', { id: 'u2' });
      assert.deepEqual(readUser('u1'), { id: 'u1' });
      assert.deepEqual(readUser('u2'), { id: 'u2' });
      assert.equal(removeUser('missing'), false);
      assert.equal(removeUser('u1'), true);
      assert.equal(users.has('u1'), false);
      assert.deepEqual(readUser('u2'), { id: 'u2' });
      assert.equal(readUser('u1'), undefined, this.reason);
    },
    defectiveActual: { id: 'u1' },
    expected: undefined,
  },
  {
    id: 'authorization-configuration',
    changedFile: 'auth/guard.mjs',
    relatedEvidence: ['config/permissions.json', 'routes.mjs', 'auth/permissions.mjs'],
    reason: 'unauthorized admin operation must be denied without effects',
    async verify(load) {
      const { request, effects } = await load('routes.mjs');
      assert.equal(request('adminOperation', { role: 'admin' }), 200);
      assert.equal(request('publicOperation', null), 200);
      assert.equal(request('unknown', null), 404);
      assert.deepEqual(effects, ['adminOperation', 'publicOperation']);
      effects.length = 0;
      const anonymous = request('adminOperation', null);
      const member = request('adminOperation', { role: 'member' });
      assert.deepEqual({ anonymous, member, effects: [...effects] },
        { anonymous: 403, member: 403, effects: [] }, this.reason);
    },
    defectiveActual: { anonymous: 200, member: 200, effects: ['adminOperation', 'adminOperation'] },
    expected: { anonymous: 403, member: 403, effects: [] },
  },
  {
    id: 'shared-json-python-consumer',
    changedFile: 'contract.json',
    relatedEvidence: ['consumer.py'],
    reason: 'unchanged Python consumer must convert seconds numerically to milliseconds',
    async verify(load, context) {
      const { stdout, stderr } = await context.exec('python3', ['consumer.py']);
      assert.equal(stderr, '');
      assert.equal(stdout.trim(), '5000', this.reason);
    },
    defectiveActual: '5'.repeat(1000),
    expected: '5000',
  },
  {
    id: 'fresh-migration-model-mismatch',
    changedFile: 'migrations/001-users.sql',
    relatedEvidence: ['model.mjs', 'consumer.sql'],
    reason: 'fresh migration must provide the email column used by the unchanged model and SQL consumer',
    async verify(load, context) {
      const { user } = await load('model.mjs');
      assert.deepEqual(user, { table: 'users', columns: ['id', 'email'] });
      await withFreshPostgres(async query => {
        const fresh = query("SELECT to_regclass('public.users') IS NULL;");
        assert.equal(fresh.status, 0, fresh.stderr);
        assert.equal(fresh.stdout.trim(), 't', 'each revision requires a fresh schema');
        const migration = query(await context.read('migrations/001-users.sql'));
        assert.equal(migration.status, 0, migration.stderr);
        // Exercise the renamed column as well: migration success alone is insufficient.
        const columns = query("SELECT column_name FROM information_schema.columns WHERE table_name='users' ORDER BY ordinal_position;");
        assert.equal(columns.status, 0, columns.stderr);
        assert.ok(['id\nemail', 'id\nemail_address'].includes(columns.stdout.trim()));
        const result = query(await context.read('consumer.sql'));
        let outcome;
        if (result.status === 0) {
          assert.equal(result.stderr, '');
          outcome = result.stdout.trim();
          const modelRead = query(`SELECT ${user.columns.join(', ')} FROM ${user.table};`);
          assert.equal(modelRead.status, 0, modelRead.stderr);
          assert.equal(modelRead.stdout.trim(), '1|one@example.test');
        } else {
          // Infrastructure, syntax and other SQL failures cannot satisfy this oracle.
          assert.equal(result.status, 3, result.stderr);
          assert.match(result.stderr, /ERROR:  +42703: column "email" of relation "users" does not exist/);
          outcome = '42703: users.email is absent';
        }
        assert.equal(outcome, 'one@example.test', this.reason);
      });
    },
    defectiveActual: '42703: users.email is absent',
    expected: 'one@example.test',
  },
  {
    id: 'generated-client-source-contract',
    changedFile: 'api.json',
    relatedEvidence: ['generate.mjs', 'consumer.mjs'],
    reason: 'generated client must export getUser required by the unchanged consumer',
    async verify(load, context) {
      await context.exec(process.execPath, ['generate.mjs']);
      const first = await context.read('client.mjs');
      await context.exec(process.execPath, ['generate.mjs']);
      assert.equal(await context.read('client.mjs'), first, 'generator must be deterministic');
      // Both operation names still issue the same HTTP request. The defect is linking.
      const client = await load('client.mjs');
      const exports = Object.keys(client);
      assert.equal(exports.length, 1);
      assert.ok(['getUser', 'fetchUser'].includes(exports[0]));
      const calls = [];
      const transport = async (...args) => { calls.push(args); return { id: 'u/1' }; };
      assert.deepEqual(await client[exports[0]](transport, 'u/1'), { id: 'u/1' });
      assert.deepEqual(calls, [['GET', '/users/u%2F1']]);
      let outcome;
      let consumer;
      try {
        consumer = await load('consumer.mjs');
        outcome = 'linked getUser';
      } catch (error) {
        assert.ok(error instanceof SyntaxError);
        assert.match(error.message, /does not provide an export named 'getUser'/);
        outcome = 'missing getUser export';
      }
      assert.equal(outcome, 'linked getUser', this.reason);
      calls.length = 0;
      assert.deepEqual(await consumer.readUser(transport, 'u/1'), { id: 'u/1' });
      assert.deepEqual(calls, [['GET', '/users/u%2F1']]);
    },
    defectiveActual: 'missing getUser export',
    expected: 'linked getUser',
  },

];
