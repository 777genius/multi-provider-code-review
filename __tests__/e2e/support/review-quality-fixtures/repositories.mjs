// Repository contents only. Evaluator expectations live in evaluator.mjs.
function revisions(common, changedPath, base, defective, corrected = base) {
  return Object.freeze(Object.fromEntries(
    Object.entries({ base, defective, corrected }).map(([revision, source]) =>
      [revision, Object.freeze({ ...common, [changedPath]: source })]),
  ));
}

export const repositories = Object.freeze({
  'hidden-numeric-caller': revisions({
    'src/hidden-caller.mjs': `import { changedApi } from './service.mjs';
export const result = changedApi() + 1;
`,
    'src/inferred-caller.mjs': `import { changedApi } from './service.mjs';
export const result = changedApi();
`,
  }, 'src/service.mjs',
  'export function changedApi() { return 1; }\n',
  'export function changedApi() { return "1"; }\n'),

  'delete-event-cache-invalidation': revisions({
    'store.mjs': `export const users = new Map();
export function deleteUser(id) { return users.delete(id); }
`,
    'events.mjs': `import { EventEmitter } from 'node:events';
export const events = new EventEmitter();
`,
    'cache/invalidate.mjs': `import { users } from '../store.mjs';
import { events } from '../events.mjs';
const cache = new Map();
events.on('user.deleted', id => cache.delete(id));
export function readUser(id) {
  if (!cache.has(id) && users.has(id)) cache.set(id, users.get(id));
  return cache.get(id);
}
`,
    'app.mjs': `export { users } from './store.mjs';
export { readUser } from './cache/invalidate.mjs';
export { removeUser } from './api/delete.mjs';
`,
  }, 'api/delete.mjs',
  `import { deleteUser } from '../store.mjs';
import { events } from '../events.mjs';
export function removeUser(id) {
  const removed = deleteUser(id);
  if (removed) events.emit('user.deleted', id);
  return removed;
}
`,
  `import { deleteUser } from '../store.mjs';
export function removeUser(id) { return deleteUser(id); }
`),

  'authorization-configuration': revisions({
    'config/permissions.json': '{"adminOperation":{"role":"admin"},"publicOperation":{"public":true}}\n',
    'auth/permissions.mjs': `export function requireRole(user, role) {
  return user?.role === role;
}
export function allowAnonymous() { return true; }
`,
    'routes.mjs': `import { readFileSync } from 'node:fs';
import { authorize } from './auth/guard.mjs';
const permissions = JSON.parse(readFileSync(new URL('./config/permissions.json', import.meta.url), 'utf8'));
export const effects = [];
export function request(operation, user) {
  const permission = permissions[operation];
  if (!permission) return 404;
  if (!authorize(user, permission)) return 403;
  effects.push(operation);
  return 200;
}
`,
  }, 'auth/guard.mjs',
  `import { requireRole } from './permissions.mjs';
export function authorize(user, permission) {
  return permission.public === true || requireRole(user, permission.role);
}
`,
  `import { allowAnonymous } from './permissions.mjs';
export function authorize(user, permission) { return allowAnonymous(); }
`),

  'shared-json-python-consumer': revisions({
    'consumer.py': `import json
from pathlib import Path
contract = json.loads(Path("contract.json").read_text())
print(contract["timeout_seconds"] * 1000)
`,
  }, 'contract.json',
  '{"timeout_seconds":5}\n',
  '{"timeout_seconds":"5"}\n'),

  'fresh-migration-model-mismatch': revisions({
    'model.mjs': `export const user = { table: 'users', columns: ['id', 'email'] };
`,
    'consumer.sql': `INSERT INTO users (id, email) VALUES (1, 'one@example.test');
SELECT email FROM users WHERE id = 1;
`,
  }, 'migrations/001-users.sql',
  'CREATE TABLE users (id integer PRIMARY KEY, email text NOT NULL);\n',
  'CREATE TABLE users (id integer PRIMARY KEY, email_address text NOT NULL);\n'),

  'generated-client-source-contract': revisions({
    'generate.mjs': `import { readFileSync, writeFileSync } from 'node:fs';
const spec = JSON.parse(readFileSync('api.json', 'utf8'));
const operation = spec.paths['/users/{id}'].get;
if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(operation.operationId)) {
  throw new Error('Invalid export identifier');
}
writeFileSync('client.mjs', 'export async function ' + operation.operationId +
  '(transport, id) { return transport("GET", "/users/" + encodeURIComponent(id)); }\\n');
`,
    'consumer.mjs': `import { getUser } from './client.mjs';
export function readUser(transport, id) { return getUser(transport, id); }
`,
  }, 'api.json',
  '{"paths":{"/users/{id}":{"get":{"operationId":"getUser"}}}}\n',
  '{"paths":{"/users/{id}":{"get":{"operationId":"fetchUser"}}}}\n'),

});
