import { execFile } from 'child_process';
import os from 'os';
import { promisify } from 'util';
import { configuredIdentity } from './disposable-investigation-repository';

jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  const { promisify } = jest.requireActual('util');
  return {
    ...actual,
    execFile: Object.assign(jest.fn(), {
      [promisify.custom]: jest.fn(promisify(actual.execFile)),
    }),
  };
});

const run = jest.mocked(promisify(execFile));
const realRun = promisify(
  jest.requireActual<typeof import('child_process')>('child_process').execFile
);

describe('configuredIdentity', () => {
  const ambient = process.env;

  beforeEach(() => {
    process.env = {
      PATH: ambient.PATH,
      HOME: os.tmpdir(),
      XDG_CONFIG_HOME: os.tmpdir(),
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_GLOBAL: '/dev/null',
    };
    run.mockReset();
    run.mockImplementation(realRun);
  });

  afterEach(() => {
    process.env = ambient;
  });

  it('demonstrates that a real missing-setting subprocess error crosses the Jest realm', async () => {
    const error = await realRun('git', ['config', '--get', 'user.name'], {
      cwd: os.tmpdir(),
      env: process.env,
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 1 });
    expect(error).not.toBeInstanceOf(Error);
  });

  it.each([
    ['user.name', 'ReviewRouter E2E'],
    ['user.email', 'e2e@example.invalid'],
  ] as const)(
    'falls back for a real absent %s setting',
    async (key, expected) => {
      await expect(configuredIdentity(os.tmpdir(), key)).resolves.toBe(
        expected
      );
    }
  );

  it.each([
    { code: 2 },
    { code: 128 },
    { code: '1' },
    { code: 'ENOENT' },
    { code: null },
    null,
    undefined,
    'unexpected',
    1,
    new Error('unexpected'),
  ])('propagates unexpected rejection %p unchanged', async (error) => {
    run.mockResolvedValueOnce({ stdout: '', stderr: '' });
    run.mockRejectedValueOnce(error);
    await expect(configuredIdentity(os.tmpdir(), 'user.name')).rejects.toBe(
      error
    );
  });

  it('preserves configured identity spelling', async () => {
    run.mockResolvedValueOnce({ stdout: '', stderr: '' });
    run.mockResolvedValueOnce({ stdout: '  Host Name\n', stderr: '' });
    await expect(configuredIdentity(os.tmpdir(), 'user.name')).resolves.toBe(
      'Host Name'
    );
  });

  it('rejects an empty configured identity', async () => {
    run.mockResolvedValueOnce({ stdout: '', stderr: '' });
    run.mockResolvedValueOnce({ stdout: '\n', stderr: '' });
    await expect(configuredIdentity(os.tmpdir(), 'user.email')).rejects.toThrow(
      'fixture_git_identity_missing:user.email'
    );
  });
});
