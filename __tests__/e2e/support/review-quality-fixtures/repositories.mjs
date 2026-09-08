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
});
