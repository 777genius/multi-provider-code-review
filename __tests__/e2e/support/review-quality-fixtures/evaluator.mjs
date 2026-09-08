// Evaluator-only metadata and assertions: never materialize these as repository files.
import assert from 'node:assert/strict';

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
];
