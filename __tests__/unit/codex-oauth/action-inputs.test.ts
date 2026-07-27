import { resolveCodexOAuthActionApiUrl } from '../../../src/codex-oauth/action';

describe('Codex OAuth action inputs', () => {
  it('prefers control-plane-url over the legacy api-url input', () => {
    expect(
      resolveCodexOAuthActionApiUrl({
        'INPUT_CONTROL-PLANE-URL': 'https://self-hosted.reviewrouter.test',
        INPUT_API_URL: 'https://api.reviewrouter.site',
        REVIEWROUTER_API_URL: 'https://env.reviewrouter.site',
      })
    ).toBe('https://self-hosted.reviewrouter.test');
  });

  it('accepts the underscore env form used by reusable workflow shims', () => {
    expect(
      resolveCodexOAuthActionApiUrl({
        INPUT_CONTROL_PLANE_URL: 'https://control-plane.internal',
        INPUT_API_URL: 'https://api.reviewrouter.site',
      })
    ).toBe('https://control-plane.internal');
  });

  it('falls back to control-plane env before legacy api env', () => {
    expect(
      resolveCodexOAuthActionApiUrl({
        REVIEWROUTER_CONTROL_PLANE_URL: 'https://control-plane.env',
        REVIEWROUTER_API_URL: 'https://api.env',
      })
    ).toBe('https://control-plane.env');
  });
});
