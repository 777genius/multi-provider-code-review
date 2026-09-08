# Executable review-quality fixtures

`repositories.mjs` contains repository inputs only. `evaluator.mjs` contains
expected answers and behavioral assertions; it and `postgres.mjs` are never
copied into materialized repositories. Each case has base, defective, and
corrected snapshots; corrected restores the compatible source. The original
three cases and caller-local numeric controls remain intact.

The additional cases exercise:

- A JSON number changed to a string, causing the unchanged Python consumer to
  repeat a string instead of converting seconds to milliseconds.
- A fresh PostgreSQL migration renaming `email` to `email_address`, breaking the
  unchanged SQL consumer and model projection. The defective oracle requires
  PostgreSQL SQLSTATE `42703` identifying the missing `users.email` column.
  This is a fresh-schema test, **not an upgrade test**.
- A tiny deterministic generator whose exported function name comes from the
  source operationId. Changing it breaks the unchanged consumer's named import.
  Both generated functions retain the same working HTTP transport contract;
  operationId alone is not asserted to be an HTTP defect.

## Prerequisites and replay

Run from the repository root with Node (the project requires >=20), Python3,
Docker CLI and daemon access, and an already-local `postgres:17` image. No
installation or image pull is performed by the fixture helper. CI checks Python3
and Docker access and pulls `postgres:17` before running tests, with a five-minute
preparation limit. Host psql is not needed: the helper
runs real psql inside each newly created container.

Focused PostgreSQL operator gate:

```sh
node --test --test-name-pattern='^fresh-migration-model-mismatch:' __tests__/e2e/review-quality-ground-truth.test.mjs
```

This command creates three disposable containers (one per revision), each named
`rr-quality-cross-contract-r1-<random UUID>`. The helper issues `docker create
--pull=never --name <unique-name> --network none --label
rr.fixture=rr-quality-cross-contract-r1 -e POSTGRES_HOST_AUTH_METHOD=trust -e
POSTGRES_DB=fixture postgres:17`, starts that container, waits for its final
server, and executes migration and consumer SQL with `ON_ERROR_STOP=1`.
It removes only that container and its anonymous volumes in `finally` using
`docker rm -f -v <unique-name>`. No ports or host directories are exposed, and no
existing containers or database URLs are accepted. If the operator interrupts
with SIGKILL, remove only the exact newly created fixture container by name.
The focused gate must report all three selected tests passing. Unselected tests
are not evidence of coverage.

Full native gate (22 tests, including all six scenarios):

```sh
node --test __tests__/e2e/review-quality-ground-truth.test.mjs
```

Normal Jest discovery already includes
`__tests__/e2e/review-quality-ground-truth.e2e.test.ts`, which launches that full
native file and fails on any nonzero exit. In an environment with the project's
existing dependencies available:

```sh
npm test -- --runInBand --runTestsByPath __tests__/e2e/review-quality-ground-truth.e2e.test.ts
```

The wrapper bounds the native child at 240 seconds and this Jest test at 250
seconds to allow the 22 checks, Python consumers, and fresh PostgreSQL containers
headroom on resource-limited workers. Other tests retain their existing limits.

Missing prerequisites fail explicitly; they are never silently skipped or
accepted as the intended defect. These checks establish fixture behavior, not
model accuracy, context retrieval quality, or live review performance.

## Sandbox handoff (2026-09-08)

Exact starting HEAD: `47a002f7c768099723748d82a60123c47d0e2154`.
The initial Git lock probe returned EROFS; no commit was attempted.
Native execution: **22 tests, 19 pass, 3 fail, 0 skipped**. All three PostgreSQL
revisions fail because Docker socket access is denied. PostgreSQL execution is
**unverified pending operator replay** of the focused command above.
Jest execution is also unverified: the command exits 127 (`jest: not found`);
no dependencies were installed. Discovery was checked against `jest.config.js`.
The native transcript is `/tmp/rr-quality-cross-contract-r1-native.tap`, and the
Jest attempt is `/tmp/rr-quality-cross-contract-r1-jest.log`.
