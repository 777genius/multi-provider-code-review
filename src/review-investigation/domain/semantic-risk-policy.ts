export const REVIEW_INVESTIGATION_CRITIC_POLICY_V2 =
  'review-investigation-critic.v2';

export const REVIEW_INVESTIGATION_RISK_PRIORITY = Object.freeze({
  StandardChangedPath: 500_000,
  HighRiskChangedPath: 900_000,
  InventoryWitness: 1_000_000,
});

export const REVIEW_INVESTIGATION_INDEPENDENT_CRITIC_RISK_PRIORITY_V1 = 800_000;

const HIGH_RISK_PATH_TOKENS = new Set([
  'acl',
  'api',
  'atomic',
  'auth',
  'authentication',
  'authorization',
  'backup',
  'backups',
  'billing',
  'cache',
  'caches',
  'caching',
  'concurrency',
  'concurrent',
  'controller',
  'controllers',
  'credential',
  'credentials',
  'database',
  'databases',
  'db',
  'delete',
  'deletion',
  'destructive',
  'drizzle',
  'drop',
  'endpoint',
  'endpoints',
  'graphql',
  'invoice',
  'invoices',
  'kafka',
  'knex',
  'lock',
  'locking',
  'locks',
  'login',
  'memcached',
  'migration',
  'migrations',
  'mutex',
  'oauth',
  'oidc',
  'openapi',
  'payment',
  'payments',
  'permission',
  'permissions',
  'persistence',
  'pipeline',
  'pipelines',
  'prisma',
  'pubsub',
  'purge',
  'queue',
  'queued',
  'queues',
  'rabbitmq',
  'rbac',
  'realtime',
  'recovery',
  'redis',
  'reset',
  'restore',
  'retention',
  'rollback',
  'route',
  'routes',
  'rpc',
  'schema',
  'schemas',
  'secret',
  'secrets',
  'semaphore',
  'sequelize',
  'session',
  'socket',
  'sockets',
  'sql',
  'subscription',
  'subscriptions',
  'swagger',
  'transaction',
  'transactions',
  'truncate',
  'webhook',
  'webhooks',
  'websocket',
  'websockets',
  'workflow',
  'workflows',
]);

export function changedPathSemanticRiskPriority(path: string): number {
  const normalized = path
    .trim()
    .replaceAll('\\', '/')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
  if (normalized.length === 0) {
    throw new Error('review_investigation_changed_path_missing');
  }
  const tokens = normalized.split(/[^a-z0-9]+/u).filter(Boolean);
  const highRisk =
    normalized.startsWith('.github/workflows/') ||
    tokens.some((token) => HIGH_RISK_PATH_TOKENS.has(token)) ||
    (tokens.includes('data') && tokens.includes('loss'));
  return highRisk
    ? REVIEW_INVESTIGATION_RISK_PRIORITY.HighRiskChangedPath
    : REVIEW_INVESTIGATION_RISK_PRIORITY.StandardChangedPath;
}
